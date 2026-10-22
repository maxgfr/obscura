import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { isLivePage, live } from "../live/whip";
import { rec, recordings, refreshLibrary, stopRecording, togglePause } from "../record/session";
import { captures, Engine, engine, renderStats, setEngine } from "../studio/engine";
import { decodeLink } from "../studio/scene";
import {
  doc,
  goToScene,
  moveLayer,
  removeLayer,
  replaceDoc,
  selected,
  selectedLayer,
  setLayer,
  update,
} from "../studio/store";
import { Icon, KIND_ICON, Logo } from "./components/Icons";
import { Inspector } from "./components/Inspector";
import { openMiniControls, pipSupported } from "./components/MiniControls";
import { Mixer } from "./components/Mixer";
import { LayersPanel, ScenesPanel } from "./components/Panels";
import { RecordBar, record } from "./components/RecordBar";
import {
  LivePanel,
  PassphraseSheet,
  RecordingsSheet,
  SettingsSheet,
  ShareSheet,
} from "./components/Sheets";
import { Stage } from "./components/Stage";
import { applyUpdate, updateReady } from "./pwa";
import { dismiss, toast, toasts } from "./toast";

type SheetName = "settings" | "recordings" | "share" | "passphrase" | null;
type Tab = "scenes" | "sources" | "edit" | "audio";

function CaptureIndicator(): JSX.Element | null {
  const list = captures.value;
  if (!list.length) return null;
  return (
    <ul class="captures" aria-label="Live captures" data-testid="captures">
      {list.map((c) => (
        <li key={c.source} class="capture">
          <span class="dot dot-live" />
          <Icon name={KIND_ICON[c.kind] ?? "screen"} size={14} />
          <span class="capture-label">{c.label}</span>
          <button
            type="button"
            class="icon-btn xs"
            aria-label={`Stop capturing ${c.label}`}
            title="Stop this capture"
            onClick={() => engine?.stop(c.source)}
          >
            <Icon name="x" size={12} />
          </button>
        </li>
      ))}
    </ul>
  );
}

function useHotkeys(onNeedKey: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) ||
        document.querySelector("dialog[open]")
      )
        return;
      const s = rec.value;
      if (e.key === "r" || e.key === "R") {
        if (s.kind === "recording" || s.kind === "paused") void stopRecording();
        else record(onNeedKey);
      } else if (e.key === "p" || e.key === "P") togglePause();
      else if (/^[1-9]$/.test(e.key)) goToScene(Number(e.key) - 1);
      else if (e.key === "Escape") selected.value = null;
      else {
        const l = selectedLayer.value;
        if (!l) return;
        if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          removeLayer(l.id);
        } else if (e.key === "[") update((d) => moveLayer(d, l.id, -1));
        else if (e.key === "]") update((d) => moveLayer(d, l.id, +1));
        else if (e.key.startsWith("Arrow") && !l.locked) {
          e.preventDefault();
          const step = (e.shiftKey ? 10 : 1) / doc.value.canvas.width;
          const stepY = (e.shiftKey ? 10 : 1) / doc.value.canvas.height;
          const r = l.rect;
          const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
          const dy = e.key === "ArrowUp" ? -stepY : e.key === "ArrowDown" ? stepY : 0;
          setLayer(l.id, { rect: { ...r, x: r.x + dx, y: r.y + dy } });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onNeedKey]);
}

/** A layout link (#s=…) replaces the current layout, with a way back. */
function useLinkImport(): void {
  useEffect(() => {
    const read = async () => {
      if (!location.hash.startsWith("#s=")) return;
      const hash = location.hash;
      history.replaceState(null, "", location.pathname + location.search);
      try {
        const next = await decodeLink(hash);
        const previous = doc.value;
        engine?.releaseAll();
        replaceDoc(next);
        toast("Layout loaded from the link.", "info", {
          label: "Undo",
          run: () => replaceDoc(previous),
        });
      } catch (err) {
        toast(
          `This link has no valid layout (${err instanceof Error ? err.message : err}).`,
          "error",
        );
      }
    };
    void read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
}

export function App(): JSX.Element {
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [sheet, setSheet] = useState<SheetName>(null);
  const [afterKey, setAfterKey] = useState(false);
  const [tab, setTab] = useState<Tab>("sources");
  const livePage = isLivePage();
  const created = useRef(false);

  useEffect(() => {
    if (created.current) return;
    created.current = true;
    const c = document.createElement("canvas");
    c.className = "program";
    c.setAttribute("aria-label", "Program preview");
    try {
      const e = new Engine(c);
      setEngine(e);
      setCanvas(c);
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    }
    void refreshLibrary().then(() => {
      const cut = recordings.value.filter((r) => r.interrupted);
      if (cut.length)
        toast(
          `${cut.length === 1 ? "A recording was" : `${cut.length} recordings were`} interrupted. It is kept, playable up to the cut.`,
          "warn",
          { label: "Show", run: () => setSheet("recordings") },
        );
    });
    const onHide = () => {
      if (rec.value.kind === "idle" && live.value.kind === "off") engine?.releaseAll();
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, []);

  const needKey = () => {
    setAfterKey(true);
    setSheet("passphrase");
  };
  useHotkeys(needKey);
  useLinkImport();

  if (failure) {
    return (
      <main class="fatal">
        <Logo size={40} />
        <h1>This browser cannot run the studio</h1>
        <p class="muted">
          {failure}. obscura needs WebGL 2; try a recent Chrome, Edge, Firefox or Safari.
        </p>
      </main>
    );
  }

  const stats = renderStats.value;
  const count = recordings.value.length;
  const interrupted = recordings.value.some((r) => r.interrupted) && rec.value.kind === "idle";

  return (
    <div class={livePage ? "app live-mode" : "app"}>
      <header class="topbar">
        <a class="brand" href="./" aria-label="obscura home">
          <Logo />
          <span>obscura</span>
          {livePage && <span class="badge">live mode</span>}
        </a>
        <CaptureIndicator />
        <div class="topbar-actions">
          {stats.lost && <span class="badge badge-warn">GPU reset — reload</span>}
          <span class="fps tabular small muted" title="Preview frame rate">
            {stats.fps} fps
          </span>
          <button
            type="button"
            class="btn ghost sm"
            onClick={() => setSheet("share")}
            data-testid="open-share"
          >
            <Icon name="link" size={16} /> <span class="hide-sm">Share layout</span>
          </button>
          <button
            type="button"
            class="btn ghost sm"
            onClick={() => setSheet("recordings")}
            data-testid="open-recordings"
          >
            <Icon name="folder" size={16} /> <span class="hide-sm">Recordings</span>
            {count > 0 && <span class={interrupted ? "count count-warn" : "count"}>{count}</span>}
          </button>
          <button
            type="button"
            class="icon-btn"
            onClick={() => setSheet("settings")}
            aria-label="Settings"
            title="Settings"
            data-testid="open-settings"
          >
            <Icon name="settings" />
          </button>
        </div>
      </header>

      {updateReady.value && (
        <div class="banner" role="status">
          A new version is ready.
          <button
            type="button"
            class="btn sm"
            onClick={applyUpdate}
            disabled={rec.value.kind !== "idle"}
          >
            Reload
          </button>
        </div>
      )}

      <main class="workspace" data-tab={tab}>
        <aside class="side side-left">
          <div class="tab-pane" data-pane="scenes">
            <ScenesPanel />
          </div>
          <div class="tab-pane" data-pane="sources">
            <LayersPanel />
          </div>
        </aside>
        <div class="center">
          <Stage canvas={canvas} />
        </div>
        <aside class="side side-right">
          <div class="tab-pane" data-pane="edit">
            {livePage && <LivePanel />}
            <Inspector />
          </div>
        </aside>
        <div class="bottom">
          <div class="tab-pane" data-pane="audio">
            <Mixer />
          </div>
          <RecordBar
            onNeedKey={needKey}
            {...(pipSupported() ? { onPip: () => void openMiniControls(needKey) } : {})}
          />
        </div>
        <nav class="tabs" aria-label="Panels">
          {(
            [
              ["scenes", "Scenes", "scenes"],
              ["sources", "Sources", "layers"],
              ["edit", "Edit", "sliders"],
              ["audio", "Audio", "volume"],
            ] as const
          ).map(([id, label, icon]) => (
            <button
              key={id}
              type="button"
              class="tab"
              aria-pressed={tab === id}
              onClick={() => setTab(id)}
            >
              <Icon name={icon} size={18} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
      </main>

      <div class="toasts" role="status" aria-live="polite">
        {toasts.value.map((t) => (
          <div key={t.id} class={`toast toast-${t.tone}`}>
            {t.tone !== "info" && <Icon name="alert" size={16} />}
            <span>{t.text}</span>
            {t.action && (
              <button
                type="button"
                class="btn sm"
                onClick={() => {
                  t.action?.run();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>

      <SettingsSheet
        open={sheet === "settings"}
        onClose={() => setSheet(null)}
        onPassphrase={() => setSheet("passphrase")}
      />
      <RecordingsSheet open={sheet === "recordings"} onClose={() => setSheet(null)} />
      <ShareSheet open={sheet === "share"} onClose={() => setSheet(null)} />
      <PassphraseSheet
        open={sheet === "passphrase"}
        onClose={() => {
          setSheet(null);
          setAfterKey(false);
        }}
        {...(afterKey ? { onDone: () => record(needKey) } : {})}
      />
    </div>
  );
}
