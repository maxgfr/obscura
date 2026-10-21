import { signal } from "@preact/signals";

export interface Toast {
  id: number;
  text: string;
  tone: "info" | "warn" | "error";
  action?: { label: string; run: () => void };
}

export const toasts = signal<Toast[]>([]);
let seq = 0;

export function toast(text: string, tone: Toast["tone"] = "info", action?: Toast["action"]): void {
  const id = ++seq;
  toasts.value = [...toasts.value, { id, text, tone, ...(action ? { action } : {}) }];
  setTimeout(() => dismiss(id), action ? 8000 : tone === "error" ? 7000 : 3500);
}

export function dismiss(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}
