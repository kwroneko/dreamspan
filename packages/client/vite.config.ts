import { randomUUID } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { extname, join } from "node:path"
import { fileURLToPath } from "node:url"
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

/**
 * The libraries a panel with scripts gets (spec/HTML-MESSAGES.md §3.3), as Tavern Helper
 * injects them, from our own server at `frame/lib/`: each served path and where it is in
 * node_modules (pinned in package.json). A path ending in `/` is a folder of its files.
 */
const FRAME_LIBRARIES: Record<string, string> = {
  "fontawesome/css/all.min.css": "@fortawesome/fontawesome-free/css/all.min.css",
  "fontawesome/webfonts/": "@fortawesome/fontawesome-free/webfonts/",
  "tailwind.js": "@tailwindcss/browser/dist/index.global.js",
  "jquery.min.js": "jquery/dist/jquery.min.js",
  "jquery-ui.min.js": "jquery-ui/dist/jquery-ui.min.js",
  "jquery-ui/theme.css": "jquery-ui/themes/base/theme.css",
  "jquery-ui/images/": "jquery-ui/themes/base/images/",
  "jquery.ui.touch-punch.min.js": "jquery-ui-touch-punch/jquery.ui.touch-punch.min.js",
  "lodash.min.js": "lodash/lodash.min.js",
  "vue.global.prod.js": "vue/dist/vue.global.prod.js",
  "vue-router.global.prod.js": "vue-router/dist/vue-router.global.prod.js"
}
const MODULES = [
  fileURLToPath(new URL("./node_modules/", import.meta.url)),
  fileURLToPath(new URL("../../node_modules/", import.meta.url))
]
const moduleFile = (path: string) => {
  const found = MODULES.map((root) => join(root, path)).find((file) => existsSync(file))
  if (found === undefined) throw new Error(`frame library ${path} isn't installed`)
  return found
}
/** Every served file under `frame/lib/` and its source. */
const frameLibraryFiles = () =>
  Object.entries(FRAME_LIBRARIES).flatMap(([served, source]) =>
    served.endsWith("/")
      ? readdirSync(moduleFile(source)).map((name) => [`${served}${name}`, join(moduleFile(source), name)] as const)
      : [[served, moduleFile(source)] as const]
  )
const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".png": "image/png"
}
/** Copied into the build, and served from node_modules in development. */
const frameLibraries: Plugin = {
  name: "frame-libraries",
  configureServer(dev) {
    const files = new Map(frameLibraryFiles())
    dev.middlewares.use("/frame/lib/", (request, response, next) => {
      const file = files.get((request.url ?? "").split("?")[0]!.replace(/^\//, ""))
      if (file === undefined) return next()
      response.setHeader("content-type", TYPES[extname(file)] ?? "application/octet-stream")
      response.setHeader("access-control-allow-origin", "*")
      response.end(readFileSync(file))
    })
  },
  generateBundle() {
    for (const [served, file] of frameLibraryFiles())
      this.emitFile({ type: "asset", fileName: `frame/lib/${served}`, source: readFileSync(file) })
  }
}

export default defineConfig({
  define: { "import.meta.env.VITE_BUILD_ID": JSON.stringify(buildId) },
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
    frameBootstrap,
    frameLibraries,
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
