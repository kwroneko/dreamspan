import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import babel from "@rolldown/plugin-babel"
import tailwindcss from "@tailwindcss/vite"
import react, { reactCompilerPreset } from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const stub = (name: string) => fileURLToPath(new URL(`./src/stubs/${name}`, import.meta.url))

// In development the client runs on Vite and proxies the RPC socket and login to the server.
const server = process.env.RP_SERVER ?? "http://127.0.0.1:8080"
const buildId = process.env.NODE_ENV === "production" ? randomUUID() : "development"

export default defineConfig({
  define: { "import.meta.env.VITE_BUILD_ID": JSON.stringify(buildId) },
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
    {
      name: "client-build-id",
      generateBundle() {
        this.emitFile({ type: "asset", fileName: "build-id.json", source: JSON.stringify({ buildId }) })
      }
    }
  ],
  build: { sourcemap: true },
  resolve: {
    // Streamdown imports rehype-raw (and through it parse5, an HTML parser) for raw HTML,
    // which ui/Markdown.tsx never parses: a stub keeps them out of the bundle.
    alias: { "rehype-raw": stub("rehypeRaw.ts") }
  },
  server: {
    port: 5173,
    proxy: {
      "/rpc": { target: server.replace(/^http/, "ws"), ws: true },
      "/auth": { target: server },
      "/library": {
        target: server,
        bypass(req) {
          // Editor URLs share this prefix with media and upload APIs.
          // Let Vite's SPA fallback serve browser navigations, including refreshes.
          if ((req.method === "GET" || req.method === "HEAD") && req.headers.accept?.includes("text/html")) {
            return req.url
          }
        }
      },
      // A card source's pictures; its card pages are the app's own (browser navigations).
      "/sources": {
        target: server,
        bypass(req) {
          if ((req.method === "GET" || req.method === "HEAD") && req.headers.accept?.includes("text/html")) {
            return req.url
          }
        }
      },
      "/healthz": { target: server }
    }
  }
})
