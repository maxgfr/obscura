/**
 * The render clock. Timers and animation frames of a hidden tab are
 * throttled to a crawl — exactly when you switch to the window you are
 * recording — but a worker's timer keeps its pace, and its messages wake the page.
 */
export {};

let timer: ReturnType<typeof setInterval> | undefined;

self.onmessage = (e: MessageEvent<{ fps: number } | null>) => {
  clearInterval(timer);
  if (!e.data) return;
  const ms = 1000 / Math.max(1, Math.min(120, e.data.fps));
  timer = setInterval(() => (self as unknown as Worker).postMessage(performance.now()), ms);
};
