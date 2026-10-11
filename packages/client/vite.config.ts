import babel from "@rolldown/plugin-babel"
import tailwindcss from "@tailwindcss/vite"
import react, { reactCompilerPreset } from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// In development the client runs on Vite and proxies the RPC socket and login to the server.
const server = process.env.RP_SERVER ?? "http://127.0.0.1:8080"

export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] }), tailwindcss()],
  build: { sourcemap: true },
  server: {
    port: 5173,
    proxy: { "/rpc": { target: server.replace(/^http/, "ws"), ws: true }, "/auth": { target: server } }
  }
})
