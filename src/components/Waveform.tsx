import { useEffect, useRef } from "react";

import { decodePeaks, downsample } from "../audio/peaks";

interface WaveformProps {
  sampleId: number;
  /** Base64 blob from the index, or null when the file has not been analysed. */
  peaks: string | null;
  width: number;
  height: number;
  /** 0–1 through the sample, or null when it is not playing. */
  playhead?: number | null;
  color?: string;
  className?: string;
}

/**
 * Draws a stored waveform (SPEC §7.4).
 *
 * Canvas rather than SVG: a list of a few hundred rows each holding a path of
 * forty-odd segments is a lot of DOM for something that never needs to be
 * hit-tested, and the inspector redraws on every animation frame while a
 * playhead is moving.
 */
export function Waveform(props: WaveformProps): React.JSX.Element {
  const { sampleId, peaks, width, height, playhead = null, color, className } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;

    // Match the backing store to the device so the waveform is not soft on a
    // scaled display.
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const decoded = decodePeaks(sampleId, peaks);
    const stroke = color ?? "#8b8b9c";
    const mid = height / 2;

    if (decoded === null) {
      // Not analysed, or unreadable. A flat line says "no waveform" without
      // pretending the file is silent.
      ctx.strokeStyle = "#3a3a46";
      ctx.beginPath();
      ctx.moveTo(0, mid);
      ctx.lineTo(width, mid);
      ctx.stroke();
      return;
    }

    const buckets = downsample(decoded, Math.max(8, Math.floor(width)));
    const count = Math.floor(buckets.length / 2);
    const step = width / count;
    // Leave a hair of headroom so a full-scale sample is not clipped by the
    // canvas edge.
    const scale = (height / 2) * 0.94;

    ctx.fillStyle = stroke;
    for (let i = 0; i < count; i++) {
      const lo = (buckets[i * 2] ?? 0) / 127;
      const hi = (buckets[i * 2 + 1] ?? 0) / 127;
      const top = mid - hi * scale;
      const bottom = mid - lo * scale;
      // Always at least a pixel, or near-silence disappears entirely.
      ctx.fillRect(i * step, top, Math.max(step * 0.8, 1), Math.max(bottom - top, 1));
    }

    if (playhead !== null && playhead >= 0 && playhead <= 1) {
      ctx.fillStyle = "#e8a84a";
      ctx.fillRect(Math.round(playhead * width), 0, 1.5, height);
    }
  }, [sampleId, peaks, width, height, playhead, color]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width, height, display: "block" }}
      aria-hidden="true"
    />
  );
}
