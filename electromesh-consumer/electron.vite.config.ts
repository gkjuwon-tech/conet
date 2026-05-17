import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/main/index.ts") }
      }
    },
    resolve: {
      alias: {
        "@main": resolve(__dirname, "src/main")
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/preload/index.ts") }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    plugins: [react()],
    resolve: {
      alias: {
        "@": resolve(__dirname, "src/renderer"),
        "@design": resolve(__dirname, "..", "design")
      },
      // Prefer .ts/.tsx over .js so that bare imports like
      // `@design/theme` resolve to `theme.tsx` (the React module) instead
      // of `theme.js` (the vanilla snippet that landing/phone-agent load
      // via <script src>). Both must coexist in design/.
      extensions: [".mjs", ".ts", ".tsx", ".js", ".jsx", ".json"]
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/renderer/index.html") }
      }
    },
    server: {
      port: 5181
    }
  }
});
