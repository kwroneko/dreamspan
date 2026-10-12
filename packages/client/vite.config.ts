import { fileURLToPath } from "node:url"
import babel from "@rolldown/plugin-babel"
import tailwindcss from "@tailwindcss/vite"
import react, { reactCompilerPreset } from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const stub = (name: string) => fileURLToPath(new URL(`./src/stubs/${name}`, import.meta.url))

// In development the client runs on Vite and proxies the RPC socket and login to the server.
const server = process.env.RP_SERVER ?? "http://127.0.0.1:8080"

export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] }), tailwindcss()],
  build: { sourcemap: true },
  resolve: {
    // Streamdown imports rehype-raw (and through it parse5, an HTML parser) for raw HTML,
    // which ui/Markdown.tsx never parses: a stub keeps them out of the bundle.
    alias: { "rehype-raw": stub("rehypeRaw.ts") }
  },
  server: {
    port: 5173,
    proxy: { "/rpc": { target: server.replace(/^http/, "ws"), ws: true }, "/auth": { target: server } }
  }
})
