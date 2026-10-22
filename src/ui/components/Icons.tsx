/** Inline stroke icons (24-grid), drawn as elements: no markup strings anywhere. */
import type { JSX } from "preact";

const PATHS = {
  screen: ["M3 5h18v11H3z", "M8 20h8", "M12 16v4"],
  camera: ["M3 7h12v10H3z", "M15 10l6-3v10l-6-3"],
  mic: ["M9 4a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0z", "M5 10a7 7 0 0 0 14 0", "M12 17v4"],
  image: ["M3 5h18v14H3z", "M3 16l5-5 4 4 3-3 6 6", "M15.5 9.5h.01"],
  text: ["M5 6V4h14v2", "M12 4v16", "M9 20h6"],
  color: [
    "M12 3a9 9 0 1 0 0 18c1 0 1.5-.8 1.5-1.6 0-1.4 1-2.4 2.4-2.4H18a3 3 0 0 0 3-3A9 9 0 0 0 12 3z",
  ],
  mask: ["M3 5h18v14H3z", "M3 5l18 14", "M21 5L3 19"],
  plus: ["M12 5v14", "M5 12h14"],
  x: ["M6 6l12 12", "M18 6L6 18"],
  eye: ["M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z", "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"],
  eyeOff: [
    "M3 3l18 18",
    "M10.6 6.1A10 10 0 0 1 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3.2 3.9",
    "M6.6 6.6C3.7 8.4 2 12 2 12s3.6 7 10 7c1.8 0 3.4-.5 4.7-1.2",
    "M9.9 10a3 3 0 0 0 4.1 4.1",
  ],
  lock: ["M6 11h12v9H6z", "M8 11V8a4 4 0 0 1 8 0v3"],
  unlock: ["M6 11h12v9H6z", "M8 11V8a4 4 0 0 1 7.5-2"],
  up: ["M12 19V5", "M6 11l6-6 6 6"],
  down: ["M12 5v14", "M6 13l6 6 6-6"],
  trash: ["M4 7h16", "M10 11v6", "M14 11v6", "M6 7l1 13h10l1-13", "M9 7V4h6v3"],
  copy: ["M9 9h11v11H9z", "M5 15H4V4h11v1"],
  settings: [
    "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
    "M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  ],
  folder: ["M3 6h6l2 2h10v11H3z"],
  link: [
    "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1",
    "M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  ],
  pause: ["M8 5v14", "M16 5v14"],
  play: ["M7 5l12 7-12 7z"],
  stop: ["M6 6h12v12H6z"],
  download: ["M12 4v11", "M7 10l5 5 5-5", "M5 20h14"],
  shield: ["M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"],
  headphones: ["M4 15v-3a8 8 0 0 1 16 0v3", "M4 15h3v5H4z", "M17 15h3v5h-3z"],
  volume: ["M4 9h4l5-4v14l-5-4H4z", "M17 9a4 4 0 0 1 0 6"],
  volumeOff: ["M4 9h4l5-4v14l-5-4H4z", "M17 10l4 4", "M21 10l-4 4"],
  pip: ["M3 5h18v14H3z", "M12 12h7v5h-7z"],
  alert: ["M12 3l10 18H2z", "M12 10v4", "M12 17h.01"],
  broadcast: [
    "M12 12h.01",
    "M8.5 15.5a5 5 0 0 1 0-7",
    "M15.5 8.5a5 5 0 0 1 0 7",
    "M5.6 18.4a9 9 0 0 1 0-12.8",
    "M18.4 5.6a9 9 0 0 1 0 12.8",
  ],
  refresh: [
    "M20 11a8 8 0 0 0-14.7-4.3L3 9",
    "M3 4v5h5",
    "M4 13a8 8 0 0 0 14.7 4.3L21 15",
    "M21 20v-5h-5",
  ],
  scenes: ["M3 4h18v6H3z", "M3 14h18v6H3z"],
  users: [
    "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
    "M2 21a7 7 0 0 1 14 0",
    "M16 3.5a4 4 0 0 1 0 7",
    "M18 14a6 6 0 0 1 4 7",
  ],
  grid: ["M3 3h8v8H3z", "M13 3h8v8h-8z", "M3 13h8v8H3z", "M13 13h8v8h-8z"],
  layers: ["M12 3l9 5-9 5-9-5z", "M3 13l9 5 9-5"],
  sliders: [
    "M4 6h10",
    "M18 6h2",
    "M4 12h4",
    "M12 12h8",
    "M4 18h12",
    "M20 18h0",
    "M16 4v4",
    "M10 10v4",
    "M18 16v4",
  ],
} as const;

export type IconName = keyof typeof PATHS;

export function Icon(props: { name: IconName; size?: number; label?: string }): JSX.Element {
  const s = props.size ?? 18;
  return (
    <svg
      class="icon"
      width={s}
      height={s}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden={props.label ? undefined : "true"}
      role={props.label ? "img" : undefined}
      aria-label={props.label}
    >
      {PATHS[props.name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

export const KIND_ICON: Record<string, IconName> = {
  display: "screen",
  camera: "camera",
  mic: "mic",
  image: "image",
  text: "text",
  color: "color",
  mask: "mask",
  guest: "users",
};

export function Logo(props: { size?: number }): JSX.Element {
  const s = props.size ?? 24;
  return (
    <svg class="logo" width={s} height={s} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="var(--logo-bg)" />
      <circle cx="16" cy="16" r="8.5" fill="none" stroke="var(--logo-fg)" stroke-width="2.4" />
      <circle cx="16" cy="16" r="3.6" fill="var(--rec)" />
    </svg>
  );
}
