/** Settings, passphrase, recordings library, sharing a layout, and live. */
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { goLive, live, stopLive } from "../../live/whip";
import { formatBytes } from "../../record/names";
import {
  deriving,
  rec,
  recordings,
  refreshLibrary,
  sealKey,
  setPassphrase,
  storage,
} from "../../record/session";
import { deleteRecording, readRecording, saveFile } from "../../record/storage";
import { engine } from "../../studio/engine";
import { encodeLink } from "../../studio/scene";
import { doc } from "../../studio/store";
import { setSettings, settings } from "../settings";
import { toast } from "../toast";
import { Icon } from "./Icons";
import { Sheet } from "./Sheet";

export function PassphraseSheet(props: {
  open: boolean;
  onClose: () => void;
  onDone?: () => void;
}): JSX.Element {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const busy = deriving.value !== null;
  useEffect(() => {
    if (!props.open) {
      setA("");
      setB("");
      setErr(null);
    }
  }, [props.open]);
  const submit = async (e: Event) => {
    e.preventDefault();
    if (a.length < 8) return setErr("Use at least 8 characters; a few random words is best.");
    if (a !== b) return setErr("The two passphrases differ.");
    setErr(null);
    try {
      await setPassphrase(a);
      setA("");
      setB("");
      props.onClose();
      props.onDone?.();
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x));
    }
  };
  return (
    <Sheet
      open={props.open}
      title="Encryption passphrase"
      onClose={props.onClose}
      testid="passphrase-sheet"
    >
      <form class="stack" onSubmit={submit}>
        <p class="small">
          Recordings are sealed with AES-256-GCM under a key stretched from this passphrase
          (Argon2id). It is kept in memory for this session only.{" "}
          <strong>Without it, a sealed recording cannot be opened</strong> — there is no recovery.
        </p>
        <label class="field">
          <span class="field-label">Passphrase</span>
          <input
            type="password"
            autocomplete="new-password"
            value={a}
            onInput={(e) => setA(e.currentTarget.value)}
            data-testid="passphrase"
          />
        </label>
        <label class="field">
          <span class="field-label">Again</span>
          <input
            type="password"
            autocomplete="new-password"
            value={b}
            onInput={(e) => setB(e.currentTarget.value)}
            data-testid="passphrase-confirm"
          />
        </label>
        {err && (
          <p class="error small" role="alert">
            {err}
          </p>
        )}
        <button
          type="submit"
          class="btn btn-primary"
          disabled={busy}
          data-testid="passphrase-submit"
        >
          {busy
            ? `Deriving key… ${Math.round((deriving.value ?? 0) * 100)}%`
            : "Use this passphrase"}
        </button>
        <p class="small muted">
          Open sealed files with the CLI: <code>obscura decrypt file.mp4.obscura</code>
        </p>
      </form>
    </Sheet>
  );
}

export function SettingsSheet(props: {
  open: boolean;
  onClose: () => void;
  onPassphrase: () => void;
}): JSX.Element {
  const s = settings.value;
  const busy = rec.value.kind !== "idle";
  const est = storage.value;
  useEffect(() => {
    if (props.open) void refreshLibrary();
  }, [props.open]);
  return (
    <Sheet open={props.open} title="Settings" onClose={props.onClose} testid="settings-sheet">
      <div class="stack">
        <fieldset class="group" disabled={busy}>
          <legend>Recording</legend>
          <label class="field">
            <span class="field-label">Format</span>
            <select
              value={s.container}
              onChange={(e) => setSettings({ container: e.currentTarget.value as "mp4" | "webm" })}
              data-testid="container"
            >
              <option value="mp4">MP4 (H.264 when available)</option>
              <option value="webm">WebM (VP9 / AV1)</option>
            </select>
          </label>
          <label class="field">
            <span class="field-label">Quality</span>
            <select
              value={s.quality}
              onChange={(e) =>
                setSettings({ quality: e.currentTarget.value as "standard" | "high" })
              }
            >
              <option value="standard">Standard</option>
              <option value="high">High (bigger files)</option>
            </select>
          </label>
          <label class="check">
            <input
              type="checkbox"
              checked={s.encrypt}
              onChange={(e) => {
                setSettings({ encrypt: e.currentTarget.checked });
                if (e.currentTarget.checked && !sealKey.value) props.onPassphrase();
              }}
              data-testid="encrypt"
            />
            Encrypt recordings with a passphrase
          </label>
          {s.encrypt && (
            <p class="small">
              {sealKey.value ? "A passphrase is set for this session. " : "No passphrase yet. "}
              <button type="button" class="link" onClick={props.onPassphrase}>
                {sealKey.value ? "Change it" : "Set it"}
              </button>
            </p>
          )}
        </fieldset>
        <fieldset class="group">
          <legend>Preview</legend>
          <label class="check">
            <input
              type="checkbox"
              checked={s.guides}
              onChange={(e) => setSettings({ guides: e.currentTarget.checked })}
            />
            Show centre lines and the title-safe area (never recorded)
          </label>
        </fieldset>
        <fieldset class="group">
          <legend>Privacy</legend>
          <ul class="small facts">
            <li>Nothing leaves this device: the recording page cannot connect anywhere.</li>
            <li>
              Recordings are written to this site's private storage as they are made, then saved
              where you choose.
            </li>
            <li>Layouts are saved in this browser; device names and ids never are.</li>
            {est && (
              <li>
                Storage: {formatBytes(est.usage)} used of {formatBytes(est.quota)} available.
              </li>
            )}
          </ul>
        </fieldset>
        <fieldset class="group">
          <legend>Live</legend>
          <p class="small">
            Streaming over WHIP needs a network connection, so it lives on a separate page with its
            own, wider security policy. Your scenes come along.
          </p>
          <a class="btn sm" href="./live.html" data-testid="live-link">
            <Icon name="broadcast" size={15} /> Open live mode
          </a>
        </fieldset>
        <p class="small muted">
          Open source, MIT.{" "}
          <a href="https://github.com/maxgfr/obscura" rel="noopener noreferrer" target="_blank">
            Source and CLI
          </a>
        </p>
      </div>
    </Sheet>
  );
}

export function RecordingsSheet(props: { open: boolean; onClose: () => void }): JSX.Element {
  useEffect(() => {
    if (props.open) void refreshLibrary();
  }, [props.open]);
  const list = recordings.value;
  const recordingNow = rec.value.kind !== "idle";
  return (
    <Sheet
      open={props.open}
      title="Recordings"
      onClose={props.onClose}
      wide
      testid="recordings-sheet"
    >
      <div class="stack">
        <p class="small muted">
          Kept in this browser's private storage until you delete them. Save them somewhere safe;
          clearing site data deletes them.
        </p>
        {list.length === 0 ? (
          <p class="empty">No recordings yet.</p>
        ) : (
          <ul class="files" data-testid="recordings">
            {list.map((r) => {
              const display = r.name.replace(/\.part$/, "");
              const inProgress = recordingNow && r.interrupted;
              return (
                <li key={r.name} class="file">
                  <div class="file-main">
                    <span class="file-name">
                      {r.sealed && <Icon name="lock" size={14} label="Encrypted" />} {display}
                    </span>
                    <span class="small muted tabular">
                      {formatBytes(r.size)} · {new Date(r.modified).toLocaleString()}
                      {r.interrupted && !inProgress && (
                        <span
                          class="badge badge-warn"
                          title="The tab closed or crashed during this recording"
                        >
                          Interrupted — playable up to the cut
                        </span>
                      )}
                      {inProgress && <span class="badge">Recording…</span>}
                    </span>
                  </div>
                  <div class="file-actions">
                    <button
                      type="button"
                      class="btn sm"
                      disabled={inProgress}
                      onClick={async () => {
                        const f = await readRecording(r.name);
                        const res = await saveFile(f).catch(() => "cancelled" as const);
                        if (res === "saved") toast("Saved.");
                      }}
                      data-testid="save-recording"
                    >
                      <Icon name="download" size={15} /> Save…
                    </button>
                    <button
                      type="button"
                      class="icon-btn sm"
                      disabled={inProgress}
                      aria-label={`Delete ${display}`}
                      title="Delete"
                      onClick={async () => {
                        await deleteRecording(r.name);
                        await refreshLibrary();
                      }}
                      data-testid="delete-recording"
                    >
                      <Icon name="trash" size={15} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Sheet>
  );
}

export function ShareSheet(props: { open: boolean; onClose: () => void }): JSX.Element {
  const [link, setLink] = useState("");
  useEffect(() => {
    if (!props.open) return;
    void encodeLink(doc.value).then((frag) => {
      const u = new URL(location.href);
      u.search = "";
      u.hash = frag;
      setLink(u.href);
    });
  }, [props.open]);
  return (
    <Sheet open={props.open} title="Share this layout" onClose={props.onClose} testid="share-sheet">
      <div class="stack">
        <p class="small">
          The link carries your scenes and layout in its <code>#fragment</code>, which browsers
          never send to a server. It contains no capture, no device and no image: whoever opens it
          picks their own screen and camera.
        </p>
        <textarea
          class="mono small"
          readOnly
          rows={4}
          value={link}
          aria-label="Layout link"
          data-testid="share-link"
        />
        <button
          type="button"
          class="btn btn-primary"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(link);
              toast("Link copied.");
            } catch {
              toast("Copy failed: select the link and copy it.", "warn");
            }
          }}
        >
          <Icon name="copy" size={15} /> Copy link
        </button>
      </div>
    </Sheet>
  );
}

export function LivePanel(): JSX.Element {
  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState("");
  const state = live.value;
  const on = state.kind === "connecting" || state.kind === "live";
  return (
    <section class="panel live-panel" aria-labelledby="live-title" data-testid="live-panel">
      <header class="panel-head">
        <h2 id="live-title">Live (WHIP)</h2>
        {state.kind === "live" && <span class="badge badge-live">LIVE</span>}
      </header>
      <form
        class="stack"
        onSubmit={(e) => {
          e.preventDefault();
          const en = engine;
          if (!en) return;
          if (on) void stopLive();
          else {
            void en.mixer.resume();
            void goLive(endpoint, token, en.videoTrack, en.mixer.track);
          }
        }}
      >
        <label class="field">
          <span class="field-label">WHIP URL</span>
          <input
            type="url"
            inputMode="url"
            placeholder="https://…"
            value={endpoint}
            disabled={on}
            onInput={(e) => setEndpoint(e.currentTarget.value)}
            data-testid="whip-url"
          />
        </label>
        <label class="field">
          <span class="field-label">Bearer token</span>
          <input
            type="password"
            autocomplete="off"
            value={token}
            disabled={on}
            onInput={(e) => setToken(e.currentTarget.value)}
            data-testid="whip-token"
          />
          <span class="field-hint">Kept in memory only, sent to this URL only.</span>
        </label>
        <button
          type="submit"
          class={on ? "btn btn-stop" : "btn btn-primary"}
          disabled={!on && !endpoint}
          data-testid="go-live"
        >
          <Icon name="broadcast" size={16} />
          {state.kind === "connecting" ? "Connecting…" : on ? "End stream" : "Go live"}
        </button>
        {state.kind === "error" && (
          <p class="error small" role="alert">
            {state.message}
          </p>
        )}
      </form>
    </section>
  );
}
