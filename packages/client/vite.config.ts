import { randomUUID } from "node:crypto"
import babel from "@rolldown/plugin-babel"
import tailwindcss from "@tailwindcss/vite"
import react, { reactCompilerPreset } from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"

// In development the client runs on Vite and proxies the RPC socket and login to the server.
const server = process.env.RP_SERVER ?? "http://127.0.0.1:8080"
const buildId = process.env.NODE_ENV === "production" ? randomUUID() : "development"

/** The panel frames' bootstrap (src/frame/bootstrap.ts), built unhashed at the path the frame page names. */
const FRAME_BOOTSTRAP = "frame/bootstrap.js"
/**
 * In development, the bootstrap from source at that path. It loads as a classic script (a
 * module's request would carry `Origin: null`), so it can't keep the module's empty export.
 */
const frameBootstrap: Plugin = {
  name: "frame-bootstrap",
  configureServer(dev) {
    dev.middlewares.use(`/${FRAME_BOOTSTRAP}`, (_request, response, next) => {
      dev
        .transformRequest("/src/frame/bootstrap.ts")
        .then((result) => {
          response.setHeader("content-type", "text/javascript; charset=utf-8")
          response.end((result?.code ?? "").replace(/^export\s*\{\s*\};?\s*$/m, ""))
        })
        .catch(next)
    })
  }
}

export default defineConfig({
  define: { "import.meta.env.VITE_BUILD_ID": JSON.stringify(buildId) },
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
    frameBootstrap,
    {
      name: "client-build-id",
      generateBundle() {
        this.emitFile({ type: "asset", fileName: "build-id.json", source: JSON.stringify({ buildId }) })
      }
    }
  ],
  build: {
    sourcemap: true,
    rolldownOptions: {
      input: { index: "index.html", "frame-bootstrap": "src/frame/bootstrap.ts" },
      output: {
        entryFileNames: (chunk) => (chunk.name === "frame-bootstrap" ? FRAME_BOOTSTRAP : "assets/[name]-[hash].js")
      }
    }
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
      "/healthz": { target: server },
      // The panel frames' page, with its own CSP; its bootstrap is served from source above.
      "/frame/panel": { target: server }
    }
  }
})
