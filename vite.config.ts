import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      name: "Lumen",
      formats: ["es", "umd"],
      fileName: (format) => (format === "es" ? "lumen.js" : "lumen.umd.cjs"),
    },
    rollupOptions: {
      // hls.js and mp4box are optional and loaded dynamically at runtime —
      // never bundled into the core, never required for basic playback.
      external: ["hls.js", "mp4box"],
      output: {
        globals: {
          "hls.js": "Hls",
          mp4box: "MP4Box",
        },
      },
    },
    sourcemap: true,
    target: "es2020",
  },
  test: {
    environment: "jsdom",
  },
});
