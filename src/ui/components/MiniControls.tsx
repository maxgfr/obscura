/**
 * Recording controls in an always-on-top Document Picture-in-Picture window
 * (Chromium), so you can stop or pause while working in the window you
 * record. The window is part of this page: same origin, same policy.
 */

import type { JSX } from "preact";
import { render } from "preact";
import { formatDuration } from "../../record/names";
import { elapsed, rec, stopRecording, togglePause } from "../../record/session";
import { Icon } from "./Icons";
import { record, useNow } from "./RecordBar";

interface DocumentPip {
  requestWindow(o: { width: number; height: number }): Promise<Window>;
  window: Window | null;
}

export function pipSupported(): boolean {
  return "documentPictureInPicture" in window;
}

function Mini(props: { onNeedKey: () => void }): JSX.Element {
  const s = rec.value;
  const active = s.kind === "recording" || s.kind === "paused";
  const now = useNow(active);
  return (
    <div class="mini">
      {active ? (
        <>
          <span class={s.kind === "paused" ? "rec-status paused" : "rec-status"}>
            <span class="rec-dot" />
            <span class="tabular">{formatDuration(elapsed(s, now))}</span>
          </span>
          <button
            type="button"
            class="icon-btn"
            onClick={togglePause}
            aria-label={s.kind === "paused" ? "Resume" : "Pause"}
          >
            <Icon name={s.kind === "paused" ? "play" : "pause"} />
          </button>
          <button type="button" class="btn btn-stop sm" onClick={() => void stopRecording()}>
            <Icon name="stop" size={15} /> Stop
          </button>
        </>
      ) : (
        <button
          type="button"
          class="btn btn-rec sm"
          disabled={s.kind !== "idle"}
          onClick={() => record(props.onNeedKey)}
        >
          <span class="rec-dot" /> Record
        </button>
      )}
    </div>
  );
}

export async function openMiniControls(onNeedKey: () => void): Promise<void> {
  const dpip = (window as unknown as { documentPictureInPicture?: DocumentPip })
    .documentPictureInPicture;
  if (!dpip) return;
  if (dpip.window) {
    dpip.window.focus();
    return;
  }
  const win = await dpip.requestWindow({ width: 300, height: 64 });
  // Same stylesheets as the page (same origin, allowed by style-src 'self').
  for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
    const l = win.document.createElement("link");
    l.rel = "stylesheet";
    l.href = link.href;
    win.document.head.append(l);
  }
  win.document.documentElement.dataset.theme = document.documentElement.dataset.theme ?? "";
  win.document.body.className = "mini-body";
  const root = win.document.createElement("div");
  win.document.body.append(root);
  render(
    <Mini
      onNeedKey={() => {
        window.focus();
        onNeedKey();
      }}
    />,
    root,
  );
  win.addEventListener("pagehide", () => render(null, root), { once: true });
}
