// Builds the mobile web-terminal page into a single self-contained HTML file
// embedded in the Rust binary (src-tauri/web.html).
//
//   node scripts/build-web.mjs
//
// Steps:
//   1. vite build (vite.web.config.ts) → dist-web/web.html + assets
//   2. inline the css and js into one HTML file → src-tauri/web.html
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const viteBin = path.join(root, "node_modules", "vite", "bin", "vite.js");
const result = spawnSync(
  process.execPath,
  [viteBin, "build", "--config", "vite.web.config.ts"],
  { cwd: root, stdio: "inherit" },
);
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const dist = path.join(root, "dist-web");
let html = readFileSync(path.join(dist, "web.html"), "utf8");

// Inline the JS module bundle (whatever its asset name).
const scriptMatch = html.match(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/);
if (scriptMatch) {
  const js = readFileSync(path.join(dist, scriptMatch[1]), "utf8");
  html = html.replace(
    scriptMatch[0],
    `<script type="module">\n${js}\n</script>`,
  );
}
// Inline the CSS bundle.
const cssMatch = html.match(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/);
if (cssMatch) {
  const css = readFileSync(path.join(dist, cssMatch[1]), "utf8");
  html = html.replace(cssMatch[0], `<style>\n${css}\n</style>`);
}
// Strip any remaining asset references so the file is standalone.
html = html.replace(/<script type="module"[^>]*src="[^"]+"[^>]*><\/script>/g, "");
html = html.replace(/<link rel="icon"[^>]*>/g, "");

const out = path.join(root, "src-tauri", "web.html");
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, html);
rmSync(dist, { recursive: true, force: true });
console.log(`web page written to ${path.relative(root, out)} (${html.length} bytes)`);
