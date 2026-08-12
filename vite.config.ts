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
      // hls.js is optional and loaded dynamically at runtime — never bundled
      // into the core, and never required for progressive/native playback.
      external: ["hls.js"],
      output: {
        globals: {
          "hls.js": "Hls",
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
