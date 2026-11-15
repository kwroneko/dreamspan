// A separate graph keeps the worker's pure API free of page/React/RPC chunks.
import { defineConfig } from "vite"
export default defineConfig({
  build: {
    emptyOutDir: false,
    manifest: ".vite/display-manifest.json",
    rolldownOptions: {
      input: { pluginDisplay: "src/pluginDisplay.ts" },
      preserveEntrySignatures: "strict",
      output: { entryFileNames: "assets/plugin-display-[hash].js" }
    }
  }
})
