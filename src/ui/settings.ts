/** Preferences (never secrets): saved in localStorage, validated when read back. */
import { effect, signal } from "@preact/signals";
import type { Container } from "../record/recorder";

export interface Settings {
  container: Container;
  quality: "standard" | "high";
  /** Seal recordings with the session passphrase (asked each session, never stored). */
  encrypt: boolean;
  /** Show a centre guide and safe areas over the preview (never recorded). */
  guides: boolean;
}

export const SETTINGS_KEY = "obscura.settings.v1";
export const DEFAULTS: Settings = {
  container: "mp4",
  quality: "standard",
  encrypt: false,
  guides: false,
};

export function parseSettings(raw: unknown): Settings {
  const s = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    container: s.container === "webm" ? "webm" : "mp4",
    quality: s.quality === "high" ? "high" : "standard",
    encrypt: s.encrypt === true,
    guides: s.guides === true,
  };
}

function load(): Settings {
  try {
    const raw = globalThis.localStorage?.getItem(SETTINGS_KEY);
    return raw ? parseSettings(JSON.parse(raw)) : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

export const settings = signal<Settings>(load());

effect(() => {
  const s = settings.value;
  try {
    globalThis.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // Blocked storage: preferences last for this session.
  }
});

export function setSettings(patch: Partial<Settings>): void {
  settings.value = { ...settings.value, ...patch };
}
