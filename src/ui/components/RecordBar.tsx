/** Record, pause and stop; the timer, the size on disk and whether the file is sealed. */
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { formatBytes, formatDuration } from "../../record/names";
import {
  elapsed,
  lastSaved,
  rec,
  recError,
  sealKey,
  startRecording,
  stopRecording,
  togglePause,
} from "../../record/session";
import { saveFile } from "../../record/storage";
import { engine } from "../../studio/engine";
import { doc } from "../../studio/store";
import { settings } from "../settings";
import { toast } from "../toast";
import { Icon } from "./Icons";

export function useNow(active: boolean, ms = 500): number {
  const [now, setNow] = useState(performance.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(performance.now()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return now;
}

export function record(onNeedKey: () => void): void {
  const e = engine;
  if (!e) return;
  if (settings.value.encrypt && !sealKey.value) {
    onNeedKey();
    return;
  }
  void e.mixer.resume().then(() =>
    startRecording({
      canvas: e.canvas,
      video: e.videoTrack,
      audio: e.mixer.track,
      clock: () => e.mixer.now,
      tap: (fn) => e.mixer.tap(fn),
      onFrame: (fn) => {
        e.frameHook = fn;
      },
      size: doc.value.canvas,
    }),
  );
}

export function RecordBar(props: { onNeedKey: () => void; onPip?: () => void }): JSX.Element {
  const s = rec.value;
  const active = s.kind === "recording" || s.kind === "paused";
  const now = useNow(active);
  const sealed = settings.value.encrypt;
  const saved = lastSaved.value;

  return (
    <div class="recbar" data-testid="recbar">
      {active ? (
        <>
          <button
            type="button"
            class="btn btn-stop"
            onClick={() => void stopRecording()}
            data-testid="stop"
          >
            <Icon name="stop" /> Stop
          </button>
          <button
            type="button"
            class="btn"
            onClick={togglePause}
            aria-pressed={s.kind === "paused"}
            data-testid="pause"
          >
            <Icon name={s.kind === "paused" ? "play" : "pause"} />
            {s.kind === "paused" ? "Resume" : "Pause"}
          </button>
          <span class={s.kind === "paused" ? "rec-status paused" : "rec-status"} role="timer">
            <span class="rec-dot" />
            <span class="tabular">{formatDuration(elapsed(s, now))}</span>
            <span class="tabular muted">{formatBytes(s.rec.bytes())}</span>
          </span>
        </>
      ) : (
        <button
          type="button"
          class="btn btn-rec"
          disabled={s.kind !== "idle"}
          onClick={() => record(props.onNeedKey)}
          data-testid="record"
        >
          <span class="rec-dot" />
          {s.kind === "starting" ? "Starting…" : s.kind === "stopping" ? "Saving…" : "Record"}
        </button>
      )}
      <span
        class={sealed ? "chip chip-ok" : "chip"}
        title={
          sealed
            ? sealKey.value
              ? "Recordings are encrypted with your session passphrase."
              : "You will be asked for a passphrase."
            : "Recordings are not encrypted."
        }
      >
        <Icon name={sealed ? "lock" : "unlock"} size={14} />
        {sealed ? "Encrypted" : "Not encrypted"}
      </span>
      {active && (
        <span class="chip" title="Engine and codec">
          {s.rec.engine === "webcodecs" ? s.rec.codec.toUpperCase() : "MediaRecorder"}
          {s.rec.sink === "memory" ? " · in memory" : ""}
        </span>
      )}
      {props.onPip && (
        <button
          type="button"
          class="icon-btn"
          onClick={props.onPip}
          aria-label="Pop out recording controls"
          title="Pop out controls (stays on top)"
        >
          <Icon name="pip" />
        </button>
      )}
      {!active && saved && s.kind === "idle" && (
        <span class="saved" data-testid="saved">
          <span class="small">
            Saved <strong>{saved.name.replace(/\.part$/, "")}</strong> · {formatBytes(saved.size)}
          </span>
          <button
            type="button"
            class="btn sm"
            onClick={async () => {
              const r = await saveFile(saved.file).catch(() => "cancelled" as const);
              if (r === "saved") toast("Saved.");
            }}
            data-testid="save-last"
          >
            <Icon name="download" size={15} /> Save…
          </button>
        </span>
      )}
      {recError.value && (
        <p class="rec-error" role="alert">
          {recError.value}
        </p>
      )}
    </div>
  );
}
