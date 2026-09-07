import { useEffect, useState } from "react";
import { envInfo, errorText, type EnvInfo } from "../lib/ipc";
import { log } from "../lib/log";

/** Attributes the findings to a specific WebView2 build — RESULTS.md needs it. */
export function EnvBanner(): React.JSX.Element {
  const [info, setInfo] = useState<EnvInfo | null>(null);

  useEffect(() => {
    envInfo()
      .then((i) => {
        setInfo(i);
        log.info("env", `${i.os}/${i.arch} · tauri ${i.tauriVersion} · WebView2 ${i.webviewVersion}`);
        log.info("env", i.dragPluginNote);
      })
      .catch((e: unknown) => log.error("env", "env_info failed", errorText(e)));
  }, []);

  return (
    <div className="env">
      {info === null ? (
        <span>reading environment…</span>
      ) : (
        <>
          <span>
            <strong>{info.os}</strong>/{info.arch}
          </span>
          <span>tauri {info.tauriVersion}</span>
          <span>WebView2 {info.webviewVersion}</span>
          {info.os !== "windows" && (
            <span className="badge badge-warn">
              not Windows — this spike only answers its question on Windows
            </span>
          )}
        </>
      )}
    </div>
  );
}
