import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

/**
 * The library ships several entry points: the player itself, the optional
 * plugins, the offline helpers, and one wrapper per framework. Building
 * them as separate entries (rather than one bundle) is what lets a React
 * app import the wrapper without a Vue dependency, and lets a page that
 * never shows an ad avoid downloading the VAST parser.
 *
 * UMD is built separately, from the player entry alone: it can't express
 * multiple entries or code splitting, and a single global script is the
 * only thing it's actually useful for.
 */
const isUmd = process.env.LUMEN_FORMAT === "umd";

// Anything the browser resolves at runtime, or that belongs to the host
// application, must never be bundled in.
const EXTERNAL = ["hls.js", "mp4box", "dashjs", "react", "react-dom", "vue", "svelte"];

export default defineConfig({
  build: {
    emptyOutDir: !isUmd, // the second pass must not delete the first's output
    lib: isUmd
      ? {
          entry: resolve(__dirname, "src/index.ts"),
          name: "Lumen",
          formats: ["umd"],
          fileName: () => "lumen.umd.cjs",
        }
      : {
          entry: {
            index: resolve(__dirname, "src/index.ts"),
            "plugins/ads": resolve(__dirname, "src/plugins/ads/index.ts"),
            "plugins/ambient": resolve(__dirname, "src/plugins/ambient.ts"),
            offline: resolve(__dirname, "src/offline.ts"),
            react: resolve(__dirname, "src/react/index.tsx"),
            vue: resolve(__dirname, "src/vue/index.ts"),
            svelte: resolve(__dirname, "src/svelte/index.ts"),
          },
          formats: ["es"],
          fileName: (_format, name) => (name === "index" ? "lumen.js" : `${name}.js`),
        },
    rollupOptions: {
      external: EXTERNAL,
      output: {
        globals: {
          "hls.js": "Hls",
          mp4box: "MP4Box",
          dashjs: "dashjs",
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
