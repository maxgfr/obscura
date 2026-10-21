/** Dev loop: rebuilds dist/ (unminified) on every change and serves it, with a mock WHIP ingest. */
import { watch } from "node:fs";
import { join, resolve } from "node:path";
import { serveApp } from "../test/serve";
import { build } from "./build";

const ROOT = resolve(import.meta.dir, "..");
const port = Number(process.env.PORT ?? 5173);

async function rebuild(): Promise<void> {
  try {
    const res = await build({ minify: false });
    console.log(`rebuilt v${res.version}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
  }
}

await rebuild();
const server = serveApp({ port, dir: join(ROOT, "dist") });
console.log(`obscura dev server on http://localhost:${server.port}/  (live mode: /live.html)`);

let timer: ReturnType<typeof setTimeout> | undefined;
for (const target of ["src", "index.html", "live.html", "public"]) {
  watch(join(ROOT, target), { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(rebuild, 80);
  });
}
