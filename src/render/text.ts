/** Text layers are drawn with the 2D canvas, at the layer's pixel size, then uploaded as a texture. */
import type { TextProps } from "../studio/scene";

const FAMILIES = {
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: 'ui-serif, Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
};

export function wrap(measure: (s: string) => number, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/(\s+)/)) {
      const next = line + word;
      if (line && measure(next.trimEnd()) > maxWidth) {
        out.push(line.trimEnd());
        line = word.trimStart();
      } else line = next;
    }
    out.push(line.trimEnd());
  }
  return out;
}

export function renderText(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  t: TextProps,
  width: number,
  height: number,
): void {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  if (t.background) {
    ctx.fillStyle = t.background;
    ctx.fillRect(0, 0, w, h);
  }
  const pad = t.background ? t.size * 0.35 : 0;
  ctx.font = `${t.weight} ${t.size}px ${FAMILIES[t.font]}`;
  ctx.fillStyle = t.color;
  ctx.textBaseline = "top";
  ctx.textAlign = t.align;
  const lines = wrap((s) => ctx.measureText(s).width, t.value, w - pad * 2);
  const lh = t.size * 1.2;
  const x = t.align === "left" ? pad : t.align === "right" ? w - pad : w / 2;
  lines.forEach((line, i) => {
    ctx.fillText(line, x, pad + i * lh + t.size * 0.08);
  });
}
