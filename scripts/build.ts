/**
 * Production build: Bun.build on the two HTML entrypoints (the studio and
 * live mode), hashed assets, relative paths (the site lives under
 * /obscura/), a CSP injected into each page, and a generated service worker
 * that precaches every hashed asset.
 *
 * The recording page's CSP has no network: `connect-src 'self'` and nothing
 * else. Only live.html may open https: (WHIP) and wss: (room relays) connections. The build fails
 * if a page has an inline script or a reference to an external origin.
 */
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

function csp(connect: string): string {
  return [
    "default-src 'none'",
    // RNNoise (opt-in strong noise reduction) compiles WebAssembly; no eval of JavaScript.
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self'",
    `connect-src ${connect}`,
    "img-src 'self' blob: data:",
    "media-src 'self' blob:",
    "worker-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "require-trusted-types-for 'script'",
  ].join("; ");
}

/** The studio: recording never needs the network. */
export const CSP = csp("'self'");
/** Live mode: the WHIP ingest is wherever the user says, over https; rooms meet through wss: relays. */
export const LIVE_CSP = csp("'self' https: wss:");

export const PAGES = { "index.html": CSP, "live.html": LIVE_CSP } as const;

function headInject(policy: string): string {
  return [
    `<meta http-equiv="Content-Security-Policy" content="${policy}" />`,
    `<meta name="referrer" content="no-referrer" />`,
    `<meta name="color-scheme" content="dark light" />`,
    `<meta name="theme-color" content="#16141c" />`,
    `<meta name="description" content="A light, private recording studio in your browser: scenes, screen and camera, overlays, audio mixer, encrypted recordings. Nothing is uploaded." />`,
    `<meta name="apple-mobile-web-app-capable" content="yes" />`,
    `<meta name="mobile-web-app-capable" content="yes" />`,
    `<link rel="manifest" href="./manifest.webmanifest" />`,
    `<link rel="icon" href="./icons/icon.svg" type="image/svg+xml" />`,
    `<link rel="apple-touch-icon" href="./icons/apple-touch-icon.png" />`,
  ].join("\n    ");
}

export interface BuildOptions {
  outdir?: string;
  minify?: boolean;
}

export interface BuildResult {
  outdir: string;
  version: string;
  files: string[];
}

function fail(msg: string): never {
  throw new Error(`build: ${msg}`);
}

async function listFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(p, base)));
    else out.push(relative(base, p).split("\\").join("/"));
  }
  return out.sort();
}

/** The opt-in noise reduction's files: downloaded only when it is turned on, so never precached. */
export const LAZY_DIR = "assets/noise";

const NOISE_FILES = {
  worklet: "rnnoise/workletProcessor.js",
  wasm: "rnnoise.wasm",
  simd: "rnnoise_simd.wasm",
} as const;

type NoiseAssets = Record<keyof typeof NOISE_FILES, string>;

async function copyNoiseAssets(outdir: string): Promise<NoiseAssets> {
  const src = join(ROOT, "node_modules/@sapphi-red/web-noise-suppressor/dist");
  await mkdir(join(outdir, LAZY_DIR), { recursive: true });
  const urls = {} as NoiseAssets;
  for (const [key, file] of Object.entries(NOISE_FILES) as [keyof NoiseAssets, string][]) {
    const data = await readFile(join(src, file));
    const hash = createHash("sha256").update(data).digest("hex").slice(0, 8);
    const name = (file.split("/").pop() ?? file).replace(/\.(js|wasm)$/, `-${hash}.$1`);
    await writeFile(join(outdir, LAZY_DIR, name), data);
    urls[key] = `./${LAZY_DIR}/${name}`;
  }
  return urls;
}

function assertOk(result: Awaited<ReturnType<typeof Bun.build>>, what: string): void {
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    fail(`${what} failed`);
  }
}

/** Throws if the HTML has an inline script, inline handler or external URL. */
export function auditHtml(html: string, page = "index.html"): void {
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1] ?? "";
    const body = (m[2] ?? "").trim();
    if (!/\bsrc\s*=/.test(attrs) || body.length > 0) fail(`inline <script> found in ${page}`);
  }
  if (/\son[a-z]+\s*=/i.test(html)) fail(`inline event handler found in ${page}`);
  if (/<style\b/i.test(html)) fail(`inline <style> found in ${page}`);
  for (const m of html.matchAll(/\b(?:src|href)\s*=\s*"([^"]*)"/gi)) {
    const url = m[1] ?? "";
    if (/^(?:[a-z]+:)?\/\//i.test(url)) fail(`external URL in ${page}: ${url}`);
    if (url.startsWith("/")) fail(`absolute path in ${page} (breaks the /obscura/ base): ${url}`);
  }
}

const WORKERS = {
  __OPFS_WORKER_URL__: "src/workers/opfs-writer.ts",
  __KDF_WORKER_URL__: "src/workers/kdf-worker.ts",
  __CLOCK_WORKER_URL__: "src/workers/clock.ts",
  __TAP_WORKLET_URL__: "src/workers/tap-worklet.ts",
} as const;

export async function build(opts: BuildOptions = {}): Promise<BuildResult> {
  const outdir = resolve(ROOT, opts.outdir ?? "dist");
  const minify = opts.minify ?? true;
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });

  // 1. Workers: separate hashed entrypoints, their URLs injected into the app.
  const define: Record<string, string> = {};
  for (const [name, entry] of Object.entries(WORKERS)) {
    const res = await Bun.build({
      entrypoints: [join(ROOT, entry)],
      outdir,
      minify,
      target: "browser",
      format: "esm",
      naming: { entry: "assets/[name]-[hash].[ext]" },
    });
    assertOk(res, `${entry} build`);
    const out = res.outputs.find((o) => o.kind === "entry-point") ?? fail(`no output for ${entry}`);
    define[name] = JSON.stringify(`./${relative(outdir, out.path).split("\\").join("/")}`);
  }

  const noiseAssets = await copyNoiseAssets(outdir);

  // 2. The app, from its HTML entrypoints (one shared bundle).
  const app = await Bun.build({
    entrypoints: Object.keys(PAGES).map((p) => join(ROOT, p)),
    outdir,
    minify,
    splitting: true,
    target: "browser",
    format: "esm",
    naming: {
      entry: "[name].[ext]",
      chunk: "assets/[name]-[hash].[ext]",
      asset: "assets/[name]-[hash].[ext]",
    },
    define: {
      ...define,
      __NOISE_ASSETS__: JSON.stringify(noiseAssets),
      "process.env.NODE_ENV": JSON.stringify(minify ? "production" : "development"),
    },
  });
  assertOk(app, "app build");

  // 3. Static files (manifest, icons).
  await cp(join(ROOT, "public"), outdir, { recursive: true });

  // 4. Harden each page with its own policy.
  for (const [page, policy] of Object.entries(PAGES)) {
    const path = join(outdir, page);
    let html = await readFile(path, "utf8");
    if (!/<meta charset="utf-8"\s*\/?>/i.test(html)) fail(`${page} must start with <meta charset>`);
    html = html.replace(/(<meta charset="utf-8"\s*\/?>)/i, `$1\n    ${headInject(policy)}`);
    auditHtml(html, page);
    await writeFile(path, html);
  }

  // 5. Service worker, versioned by the content hash of everything it caches.
  const files = (await listFiles(outdir)).filter(
    (f) => f !== "sw.js" && !f.startsWith(`${LAZY_DIR}/`),
  );
  const hash = createHash("sha256");
  for (const f of files) {
    hash.update(f);
    hash.update(await readFile(join(outdir, f)));
  }
  const version = hash.digest("hex").slice(0, 16);
  const sw = await Bun.build({
    entrypoints: [join(ROOT, "src/sw.ts")],
    outdir,
    minify,
    target: "browser",
    format: "esm",
    naming: { entry: "sw.js" },
    define: {
      __SW_VERSION__: JSON.stringify(version),
      __PRECACHE__: JSON.stringify(["./", ...files.map((f) => `./${f}`)]),
    },
  });
  assertOk(sw, "service worker build");

  return { outdir, version, files: [...files, "sw.js"] };
}

if (import.meta.main) {
  const started = performance.now();
  const dev = process.argv.includes("--dev");
  const res = await build({ minify: !dev });
  let bytes = 0;
  for (const f of res.files) bytes += (await stat(join(res.outdir, f))).size;
  console.log(
    `built ${res.files.length} files (${(bytes / 1024).toFixed(1)} KiB) v${res.version} in ${Math.round(performance.now() - started)} ms`,
  );
}
