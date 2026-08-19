// Test-only vite build: bundle src/web/conversation.ts for the Node replay
// harness (scripts/web-replay.mjs). Not part of the app build.
import { defineConfig } from "vite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: join(here, ".."),
  publicDir: false,
  logLevel: "error",
  build: {
    outDir: join(here, "convo-bundle"),
    emptyOutDir: true,
    lib: {
      entry: "src/web/conversation.ts",
      formats: ["es"],
      fileName: () => "conversation.mjs",
    },
    target: "node22",
    sourcemap: false,
    minify: false,
    cssCodeSplit: false,
  },
});
