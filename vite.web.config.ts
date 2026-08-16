// Standalone build for the mobile web terminal page. The build script
// (scripts/build-web.mjs) inlines the JS/CSS into src-tauri/web.html.
import path from "node:path";
import { defineConfig, type UserConfig } from "vite";

const rootDir = import.meta.dirname;

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "./src"),
    },
  },
  build: {
    outDir: "dist-web",
    emptyOutDir: true,
    target: "es2022",
    assetsInlineLimit: 100000000,
    cssCodeSplit: false,
    rolldownOptions: {
      input: path.resolve(rootDir, "web.html"),
      output: {
        codeSplitting: false,
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
} satisfies UserConfig);
