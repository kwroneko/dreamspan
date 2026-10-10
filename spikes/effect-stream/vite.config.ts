import babel from "@rolldown/plugin-babel"
import react, { reactCompilerPreset } from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const backend = { "/rpc": { target: "ws://localhost:47100", ws: true } }

export default defineConfig({
  root: "src/client",
  build: { outDir: "../../dist", emptyOutDir: true, sourcemap: true },
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
  server: { port: 47101, strictPort: true, proxy: backend },
  preview: { port: 47102, strictPort: true, proxy: backend }
})
