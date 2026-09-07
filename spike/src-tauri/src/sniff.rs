//! Throwaway container header sniffer for the Phase 0 decode bench (SPEC §14).
//!
//! This exists only so the decode results table can label its own rows -- "did
//! 24-bit WAV decode?" is a useless finding if nobody recorded which file was
//! 24-bit. It reads chunk headers and seeks past payloads; it never decodes
//! audio and it is NOT the Phase 1 analysis path (that is symphonia, SPEC §3).

use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};

use serde::Serialize;

#[derive(Serialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FormatSniff {
    /// "RIFF/WAVE", "AIFF", "AIFC", or "" when we did not recognise the container.
    pub container: String,
    /// "PCM", "IEEE float", "A-law", "WAVE_FORMAT_EXTENSIBLE (PCM)", ...
    pub codec: String,
    pub channels: Option<u16>,
    pub sample_rate: Option<u32>,
    pub bit_depth: Option<u16>,
    pub duration_ms: Option<u64>,
    /// Populated when the container was recognised but the headers did not parse.
    pub note: Option<String>,
}

impl FormatSniff {
    fn note(msg: impl Into<String>) -> Self {
        Self { note: Some(msg.into()), ..Default::default() }
    }
}

fn wave_codec_name(tag: u16) -> &'static str {
    match tag {
        0x0001 => "PCM",
        0x0003 => "IEEE float",
        0x0006 => "A-law",
        0x0007 => "mu-law",
        0x0011 => "IMA ADPCM",
        0xFFFE => "WAVE_FORMAT_EXTENSIBLE",
        _ => "unknown tag",
    }
}

/// Sniffs `path`. Never errors out of the command: an unreadable or unrecognised
/// file yields a `FormatSniff` carrying a note, because a broken file in the
/// library is a finding, not a reason to fail the run (SPEC §15).
pub fn sniff(path: &Path) -> FormatSniff {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    let mut file = match File::open(path) {
        Ok(f) => f,
        Err(e) => return FormatSniff::note(format!("open failed: {e}")),
    };

    let mut magic = [0u8; 12];
    if let Err(e) = file.read_exact(&mut magic) {
        return FormatSniff::note(format!("short read: {e}"));
    }

    match (&magic[0..4], &magic[8..12]) {
        (b"RIFF", b"WAVE") => sniff_wave(&mut file).unwrap_or_else(|e| FormatSniff {
            container: "RIFF/WAVE".into(),
            note: Some(e),
            ..Default::default()
        }),
        (b"FORM", b"AIFF") | (b"FORM", b"AIFC") => {
            let container = if &magic[8..12] == b"AIFC" { "AIFC" } else { "AIFF" };
            sniff_aiff(&mut file, container).unwrap_or_else(|e| FormatSniff {
                container: container.into(),
                note: Some(e),
                ..Default::default()
            })
        }
        // Compressed containers: header parsing them is not what this bench is for.
        // decodeAudioData either takes them or it does not.
        _ => FormatSniff {
            container: if ext.is_empty() { "unrecognised".into() } else { ext.to_uppercase() },
            codec: "not parsed (compressed or unknown container)".into(),
            ..Default::default()
        },
    }
}

fn read_chunk_header(file: &mut File, big_endian: bool) -> Option<([u8; 4], u64)> {
    let mut head = [0u8; 8];
    file.read_exact(&mut head).ok()?;
    let id = [head[0], head[1], head[2], head[3]];
    let raw = [head[4], head[5], head[6], head[7]];
    let size = if big_endian {
        u32::from_be_bytes(raw)
    } else {
        u32::from_le_bytes(raw)
    };
    Some((id, size as u64))
}

fn sniff_wave(file: &mut File) -> Result<FormatSniff, String> {
    let mut out = FormatSniff { container: "RIFF/WAVE".into(), ..Default::default() };
    let mut block_align: u32 = 0;
    let mut data_bytes: Option<u64> = None;

    // Chunks live after the 12-byte RIFF header.
    let mut pos: u64 = 12;
    // Bounded so a malformed file cannot spin here.
    for _ in 0..64 {
        if file.seek(SeekFrom::Start(pos)).is_err() {
            break;
        }
        let Some((id, size)) = read_chunk_header(file, false) else { break };
        let body = pos + 8;

        if &id == b"fmt " {
            let mut fmt = vec![0u8; size.min(40) as usize];
            file.read_exact(&mut fmt)
                .map_err(|e| format!("truncated fmt chunk: {e}"))?;
            if fmt.len() < 16 {
                return Err("fmt chunk shorter than 16 bytes".into());
            }
            let mut tag = u16::from_le_bytes([fmt[0], fmt[1]]);
            out.channels = Some(u16::from_le_bytes([fmt[2], fmt[3]]));
            out.sample_rate = Some(u32::from_le_bytes([fmt[4], fmt[5], fmt[6], fmt[7]]));
            block_align = u16::from_le_bytes([fmt[12], fmt[13]]) as u32;
            out.bit_depth = Some(u16::from_le_bytes([fmt[14], fmt[15]]));

            if tag == 0xFFFE && fmt.len() >= 26 {
                // Extensible: the real format tag is the first two bytes of the
                // SubFormat GUID at offset 24. This is where "32-bit float WAV
                // written by a DAW" usually hides.
                let sub = u16::from_le_bytes([fmt[24], fmt[25]]);
                out.codec = format!("WAVE_FORMAT_EXTENSIBLE ({})", wave_codec_name(sub));
                tag = sub;
            } else {
                out.codec = wave_codec_name(tag).to_string();
            }
        } else if &id == b"data" {
            data_bytes = Some(size);
            // Everything needed is known once data's header is seen.
            break;
        }

        // Chunks are word-aligned.
        pos = body + size + (size & 1);
    }

    if let (Some(bytes), true) = (data_bytes, block_align > 0) {
        if let Some(rate) = out.sample_rate.filter(|r| *r > 0) {
            let frames = bytes / block_align as u64;
            out.duration_ms = Some(frames * 1000 / rate as u64);
        }
    }

    if out.codec.is_empty() {
        return Err("no fmt chunk found".into());
    }
    Ok(out)
}

fn sniff_aiff(file: &mut File, container: &str) -> Result<FormatSniff, String> {
    let mut out = FormatSniff { container: container.into(), ..Default::default() };
    let mut pos: u64 = 12;

    for _ in 0..64 {
        if file.seek(SeekFrom::Start(pos)).is_err() {
            break;
        }
        let Some((id, size)) = read_chunk_header(file, true) else { break };
        let body = pos + 8;

        if &id == b"COMM" {
            let mut comm = vec![0u8; size.min(40) as usize];
            file.read_exact(&mut comm)
                .map_err(|e| format!("truncated COMM chunk: {e}"))?;
            if comm.len() < 18 {
                return Err("COMM chunk shorter than 18 bytes".into());
            }
            let channels = u16::from_be_bytes([comm[0], comm[1]]);
            let frames = u32::from_be_bytes([comm[2], comm[3], comm[4], comm[5]]) as u64;
            let bits = u16::from_be_bytes([comm[6], comm[7]]);
            let rate = extended80_to_f64(&comm[8..18]);

            out.channels = Some(channels);
            out.bit_depth = Some(bits);
            out.codec = if container == "AIFC" && comm.len() >= 22 {
                let c = String::from_utf8_lossy(&comm[18..22]).trim().to_string();
                match c.as_str() {
                    "NONE" | "sowt" => format!("PCM ({c})"),
                    "fl32" | "FL32" => "IEEE float (fl32)".to_string(),
                    other => format!("compressed ({other})"),
                }
            } else {
                "PCM".to_string()
            };
            if rate > 0.0 {
                out.sample_rate = Some(rate as u32);
                out.duration_ms = Some((frames as f64 * 1000.0 / rate) as u64);
            }
            break;
        }

        pos = body + size + (size & 1);
    }

    if out.codec.is_empty() {
        return Err("no COMM chunk found".into());
    }
    Ok(out)
}

/// AIFF stores its sample rate as an 80-bit IEEE 754 extended float.
fn extended80_to_f64(b: &[u8]) -> f64 {
    if b.len() < 10 {
        return 0.0;
    }
    let sign = if b[0] & 0x80 != 0 { -1.0 } else { 1.0 };
    let exponent = (((b[0] as u32 & 0x7F) << 8) | b[1] as u32) as i32;
    let mantissa = u64::from_be_bytes([b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9]]);
    if exponent == 0 && mantissa == 0 {
        return 0.0;
    }
    // Unbiased exponent, minus the 63 fractional bits of the explicit mantissa.
    sign * (mantissa as f64) * 2f64.powi(exponent - 16383 - 63)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Writes `bytes` to a uniquely-named temp file and sniffs it.
    fn sniff_bytes(name: &str, bytes: &[u8]) -> FormatSniff {
        let path = std::env::temp_dir().join(format!("kitbench-spike-{name}"));
        let mut f = File::create(&path).expect("create temp file");
        f.write_all(bytes).expect("write temp file");
        drop(f);
        let out = sniff(&path);
        let _ = std::fs::remove_file(&path);
        out
    }

    fn chunk(id: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut v = id.to_vec();
        v.extend((body.len() as u32).to_le_bytes());
        v.extend(body);
        if body.len() % 2 == 1 {
            v.push(0); // RIFF chunks are word-aligned.
        }
        v
    }

    fn riff(chunks: &[Vec<u8>]) -> Vec<u8> {
        let body: Vec<u8> = chunks.concat();
        let mut v = b"RIFF".to_vec();
        v.extend(((body.len() + 4) as u32).to_le_bytes());
        v.extend(b"WAVE");
        v.extend(body);
        v
    }

    fn fmt_pcm(channels: u16, rate: u32, bits: u16) -> Vec<u8> {
        let align = channels * bits / 8;
        let mut b = Vec::new();
        b.extend(1u16.to_le_bytes()); // WAVE_FORMAT_PCM
        b.extend(channels.to_le_bytes());
        b.extend(rate.to_le_bytes());
        b.extend((rate * align as u32).to_le_bytes());
        b.extend(align.to_le_bytes());
        b.extend(bits.to_le_bytes());
        b
    }

    #[test]
    fn reads_16_bit_pcm_wav() {
        // 44100 frames of 16-bit mono == exactly one second.
        let data = vec![0u8; 44100 * 2];
        let f = sniff_bytes(
            "pcm16.wav",
            &riff(&[chunk(b"fmt ", &fmt_pcm(1, 44100, 16)), chunk(b"data", &data)]),
        );
        assert_eq!(f.container, "RIFF/WAVE");
        assert_eq!(f.codec, "PCM");
        assert_eq!(f.channels, Some(1));
        assert_eq!(f.sample_rate, Some(44100));
        assert_eq!(f.bit_depth, Some(16));
        assert_eq!(f.duration_ms, Some(1000));
        assert!(f.note.is_none(), "unexpected note: {:?}", f.note);
    }

    #[test]
    fn reads_24_bit_stereo_96k_wav() {
        // 9600 frames at 96 kHz == 100 ms.
        let data = vec![0u8; 9600 * 6];
        let f = sniff_bytes(
            "pcm24.wav",
            &riff(&[chunk(b"fmt ", &fmt_pcm(2, 96_000, 24)), chunk(b"data", &data)]),
        );
        assert_eq!(f.bit_depth, Some(24));
        assert_eq!(f.channels, Some(2));
        assert_eq!(f.sample_rate, Some(96_000));
        assert_eq!(f.duration_ms, Some(100));
    }

    #[test]
    fn unwraps_extensible_float_to_its_real_subformat() {
        // The case that matters: DAW-bounced 32-bit float lands here, and a
        // sniffer that stops at the 0xFFFE tag would label it "unknown".
        let mut fmt = Vec::new();
        fmt.extend(0xFFFEu16.to_le_bytes());
        fmt.extend(2u16.to_le_bytes());
        fmt.extend(48_000u32.to_le_bytes());
        fmt.extend((48_000u32 * 8).to_le_bytes());
        fmt.extend(8u16.to_le_bytes());
        fmt.extend(32u16.to_le_bytes());
        fmt.extend(22u16.to_le_bytes()); // cbSize
        fmt.extend(32u16.to_le_bytes()); // valid bits
        fmt.extend(3u32.to_le_bytes()); // channel mask
        fmt.extend(0x0003u16.to_le_bytes()); // SubFormat GUID: IEEE float
        fmt.extend([0u8; 14]);

        let f = sniff_bytes(
            "ext-float.wav",
            &riff(&[chunk(b"fmt ", &fmt), chunk(b"data", &vec![0u8; 4800 * 8])]),
        );
        assert_eq!(f.codec, "WAVE_FORMAT_EXTENSIBLE (IEEE float)");
        assert_eq!(f.bit_depth, Some(32));
        assert_eq!(f.duration_ms, Some(100));
    }

    #[test]
    fn skips_leading_metadata_chunks() {
        // Real WAVs from a DAW lead with JUNK/bext/LIST. An odd-length chunk is
        // in there on purpose: miss the word-alignment pad and every subsequent
        // chunk header is read one byte off.
        let f = sniff_bytes(
            "junk-first.wav",
            &riff(&[
                chunk(b"JUNK", &[0u8; 512]),
                chunk(b"LIST", b"INFOodd number of bytes"),
                chunk(b"fmt ", &fmt_pcm(1, 44100, 16)),
                chunk(b"data", &vec![0u8; 22050 * 2]),
            ]),
        );
        assert_eq!(f.codec, "PCM");
        assert_eq!(f.sample_rate, Some(44100));
        assert_eq!(f.duration_ms, Some(500));
    }

    #[test]
    fn reads_aiff_with_80_bit_extended_sample_rate() {
        let mut comm = Vec::new();
        comm.extend(2u16.to_be_bytes());
        comm.extend(22_050u32.to_be_bytes()); // frames == 500 ms at 44.1k
        comm.extend(24u16.to_be_bytes());
        // 44100 as an 80-bit IEEE extended float.
        comm.extend([0x40, 0x0E, 0xAC, 0x44, 0, 0, 0, 0, 0, 0]);

        let mut body = b"COMM".to_vec();
        body.extend((comm.len() as u32).to_be_bytes());
        body.extend(&comm);

        let mut file = b"FORM".to_vec();
        file.extend(((body.len() + 4) as u32).to_be_bytes());
        file.extend(b"AIFF");
        file.extend(body);

        let f = sniff_bytes("test.aiff", &file);
        assert_eq!(f.container, "AIFF");
        assert_eq!(f.codec, "PCM");
        assert_eq!(f.channels, Some(2));
        assert_eq!(f.bit_depth, Some(24));
        assert_eq!(f.sample_rate, Some(44_100), "80-bit extended float decode");
        assert_eq!(f.duration_ms, Some(500));
    }

    #[test]
    fn extended80_handles_the_common_rates() {
        for (bytes, expected) in [
            ([0x40u8, 0x0E, 0xAC, 0x44, 0, 0, 0, 0, 0, 0], 44_100.0),
            ([0x40, 0x0E, 0xBB, 0x80, 0, 0, 0, 0, 0, 0], 48_000.0),
            ([0x40, 0x0F, 0xBB, 0x80, 0, 0, 0, 0, 0, 0], 96_000.0),
            ([0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 0.0),
        ] {
            assert!(
                (extended80_to_f64(&bytes) - expected).abs() < 0.001,
                "expected {expected}, got {}",
                extended80_to_f64(&bytes)
            );
        }
    }

    #[test]
    fn broken_files_produce_a_note_not_a_panic() {
        // SPEC §15: a malformed file in the library must not sink the run.
        assert!(sniff_bytes("tiny.wav", b"RIF").note.is_some());
        assert!(sniff_bytes("empty.wav", b"").note.is_some());

        // Recognised container, no fmt chunk.
        let f = sniff_bytes("no-fmt.wav", &riff(&[chunk(b"data", &[0u8; 16])]));
        assert!(f.note.is_some(), "expected a note, got {f:?}", f = f.note);

        // Not audio at all.
        let f = sniff_bytes("notaudio.mp3", b"\xff\xfb\x90\x00 not really an mp3");
        assert_eq!(f.container, "MP3");
        assert!(f.note.is_none());
    }
}
