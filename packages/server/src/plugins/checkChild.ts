import { createHash, randomUUID } from "node:crypto"
// Entry for a bounded build child; never imported by the HTTP process.
import { writeFile, readdir, readFile, lstat } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import ts from "typescript"
import { build } from "rolldown"
import { snapshot } from "./repo.ts"
import { runPluginChild } from "./process.ts"
import { checkNetworkFilter } from "./checkNetwork.ts"
import { CLIENT_PLUGIN_SURFACES } from "@dreamspan/shared/pluginClient.ts"
import type { PluginReport } from "@dreamspan/shared/plugins.ts"
import { rewriteImports } from "./importPolicy.ts"
import { builtinReplacement } from "@dreamspan/shared/builtinParts.ts"

const [dataDir, owner, id, commit, folder, appStamp, previous, expectedReport, sourceMode, actorRole] =
  process.argv.slice(2) as [string, string, string, string, string, string, string, string, string, string]
let cached = false
let step: PluginReport["step"] = "snapshot"
let message = "Plugin tree is invalid or differs from its commit"
const root = fileURLToPath(new URL("../../../../", import.meta.url))
try {
  const manifest = await snapshot(
    dataDir,
    owner,
    id,
    commit,
    folder,
    sourceMode === "working",
    sourceMode === "historical"
  )
  step = "manifest"
  message = "Plugin manifest or declared surface is unsupported"
  const server = [
    "presence",
    "history",
    "notes",
    "rolloutTools",
    "operationTools",
    "workshopCapabilities",
    "orchestrationModes",
    "replyStrategies",
    "replyParsers",
    "liveRewrites",
    "chatKinds",
    "providerKinds",
    "requestTransforms",
    "responseObservers",
    "costFormulas",
    "commands",
    "decisionPoints",
    "subagentTypes",
    "storage"
  ]
  const worker = [
    "stateKeys",
    "storageKinds",
    "settingsRegistry",
    "macros",
    "stages",
    "projections",
    "transforms",
    "leafPlanners",
    "maintenancePlanners",
    "storage"
  ]
  if (
    actorRole === "regular" &&
    (manifest.server || manifest.worker || manifest.overrides.length || manifest.network)
  ) {
    message = "Server code needs an admin. Load probe and tests were skipped."
    throw new Error("Admin required")
  }
  if (manifest.overrides.length) throw new Error("Internal service overrides need a restart adapter")
  for (const part of manifest.replaces) {
    const adapter = builtinReplacement(part)
    if (!adapter || !manifest[adapter.side]) {
      message = "This replacement still needs a built-in copy adapter for its runtime."
      throw new Error("Unsupported replacement")
    }
  }
  if (owner && (manifest.server || manifest.worker || manifest.network))
    throw new Error("Server code needs an instance plugin and an admin")
  for (const surface of manifest.surfaces) {
    const [side, name] = surface.split(":")
    if (
      side === "server"
        ? !server.includes(name!)
        : side === "worker"
          ? !worker.includes(name!)
          : side !== "client" || !CLIENT_PLUGIN_SURFACES.includes(name!)
    )
      throw new Error("Unknown surface")
  }
  if (
    manifest.surfaces.some(
      (s) => s === "client:displayTransforms" || s === "client:displayScriptLists" || s === "client:timelineTransforms"
    ) &&
    (manifest.server ||
      manifest.worker ||
      manifest.surfaces.some(
        (s) => !["client:displayTransforms", "client:displayScriptLists", "client:timelineTransforms"].includes(s)
      ))
  ) {
    message = "Display rules run only in the browser and need a separate plugin from page controls."
    throw new Error("Mixed display plugin")
  }
  const sources: Array<string> = []
  const visit = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (/\.(?:[cm]?js|tsx?)$/.test(entry.name)) sources.push(path)
    }
  }
  await visit(folder)
  try {
    const encoded = await readFile(join(previous, "check.json"), "utf8")
    if (!expectedReport || createHash("sha256").update(encoded).digest("hex") !== expectedReport)
      throw new Error("Unattested cache")
    const prior = JSON.parse(encoded) as PluginReport & {
      artifacts: Record<string, string>
    }
    if (prior.ok && prior.appStamp === appStamp && prior.commit === commit && prior.artifacts) {
      const copied: Array<[string, Buffer]> = []
      for (const [file, checksum] of Object.entries(prior.artifacts)) {
        if (!/^(?:server|worker|client|worker-bridge|test-[0-9]+)\.mjs$/.test(file)) throw new Error("Invalid artifact")
        const path = join(previous, file),
          info = await lstat(path)
        if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024)
          throw new Error("Invalid cached artifact")
        const bytes = await readFile(path)
        if (createHash("sha256").update(bytes).digest("hex") !== checksum) throw new Error("Changed artifact")
        copied.push([file, bytes])
      }
      for (const [file, bytes] of copied) await writeFile(join(folder, file), bytes)
      cached = true
    }
  } catch {
    /* A cache miss always performs the complete check. */
  }
  if (!cached) {
    step = "types"
    message = "Plugin type check failed; use API v1 and vendored dependencies"
    const api = (side: string) => join(root, "packages/plugin-api/src", `${side}.ts`)
    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2024,
      module: ts.ModuleKind.Preserve,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      allowJs: true,
      checkJs: true,
      strict: true,
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      verbatimModuleSyntax: true,
      types: ["node"],
      typeRoots: [join(root, "node_modules/@types")],
      jsx: ts.JsxEmit.ReactJSX,
      paths: {
        "@dreamspan/plugin-api/server": [api("server")],
        "@dreamspan/plugin-api/worker": [api("worker")],
        "@dreamspan/plugin-api/client": [api("client")],
        "@dreamspan/plugin-api/display": [api("display")],
        react: [join(root, "node_modules/@types/react/index.d.ts")],
        "react/jsx-runtime": [join(root, "node_modules/@types/react/jsx-runtime.d.ts")]
      }
    }
    const compiler = ts.createCompilerHost(options)
    const program = ts.createProgram(sources, options, compiler)
    // Syntax/import policy applies to plugin sources; dependencies are vendored, never installed.
    for (const path of sources) {
      const source = program.getSourceFile(path)!
      const test = path.includes("/test/")
      const policy = rewriteImports(source.text, path, (value) => {
        if (
          !value.startsWith("./") &&
          !value.startsWith("../") &&
          ![
            "@dreamspan/plugin-api/server",
            "@dreamspan/plugin-api/worker",
            "@dreamspan/plugin-api/client",
            "@dreamspan/plugin-api/display",
            "react",
            "react/jsx-runtime",
            ...(test ? ["node:test", "node:assert/strict"] : [])
          ].includes(value)
        )
          return undefined
        if (
          value.includes("\\") ||
          value.includes("%") ||
          (value.startsWith(".") && !resolve(path, "..", value).startsWith(folder + "/"))
        )
          return undefined
        return value
      })
      if (policy.unsupported.length) {
        message =
          "This plugin needs an adapter for: " +
          policy.unsupported.join(", ") +
          ". Read plugin_api for supported imports."
        throw new Error("Unsupported import")
      }
    }
    // Only report plugin-local diagnostics. App/API contracts are checked by npm run check.
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .filter((d) => !d.file || d.file.fileName.startsWith(folder + "/"))
    if (diagnostics.length) {
      message =
        "Plugin type check failed. " +
        diagnostics
          .slice(0, 8)
          .map((d) => {
            const path = d.file?.fileName.slice(folder.length + 1) ?? "source"
            const line = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 1
            // No diagnostic interpolation: source literals and host paths can contain secrets.
            return `${path}:${line} TS${d.code} (consult plugin_api for supported types)`
          })
          .join("; ")
      throw new Error("Type error")
    }
    step = "bundle"
    message = "Plugin bundle failed"
    for (const side of ["server", "worker", "client"] as const) {
      const entry = manifest[side]
      if (!entry) continue
      await build({
        input: join(folder, entry),
        platform: side === "client" ? "browser" : "node",
        tsconfig: false,
        output: { file: join(folder, `${side}.mjs`), format: "esm" },
        plugins: [
          {
            name: "plugin-api-only",
            resolveId(source, importer) {
              if (importer === "\0rolldown/runtime.js" && source === "node:module")
                return { id: source, external: true }
              if (side === "client" && source === "@dreamspan/plugin-api/display")
                return { id: "/plugin-display.mjs", external: true }
              if (
                side === "client" &&
                ["@dreamspan/plugin-api/client", "react", "react/jsx-runtime", "react/jsx-dev-runtime"].includes(source)
              )
                return { id: "/plugin-host.mjs", external: true }
              if (source === `@dreamspan/plugin-api/${side}`)
                return { id: pathToFileURL(api(side)).href, external: true }
              if (source.startsWith("@dreamspan/plugin-api/")) throw new Error("Wrong API entry")
              if (importer && !source.startsWith(".") && !source.startsWith("/"))
                throw new Error("Plugin dependency must be vendored")
              return null
            }
          }
        ]
      })
    }
    const permissions = [
      "--permission",
      `--allow-fs-read=${folder}`,
      `--allow-fs-read=${join(root, "packages")}`,
      `--allow-fs-read=${join(root, "node_modules")}`
    ]
    step = "probe"
    message = "Plugin import, activation or declared registrations failed"
    if (actorRole !== "regular") {
      // Created by the trusted compiler, never selected or supplied by plugin source.
      // Failure to install it fails the check; there is no network-capable fallback.
      const networkFilter = join(folder, `.network-${randomUUID()}.bpf`)
      await writeFile(networkFilter, checkNetworkFilter(), { flag: "wx", mode: 0o600 })
      const probe = await runPluginChild(
        new URL("./probeChild.ts", import.meta.url),
        [folder, JSON.stringify(manifest)],
        {
          permissions,
          networkFilter,
          timeout: 15_000,
          memory: 256
        }
      )
      if (!probe.ok) throw new Error("Probe failed")
      step = "tests"
      message = "Plugin tests failed"
      let testIndex = 0
      for (const test of sources.filter((source) => source.includes("/test/") && source.endsWith(".test.ts"))) {
        const output = join(folder, `test-${testIndex++}.mjs`)
        await build({
          input: test,
          platform: "node",
          tsconfig: false,
          output: { file: output, format: "esm" },
          plugins: [
            {
              name: "plugin-test-imports",
              resolveId(source, importer) {
                if (
                  source === "node:test" ||
                  source === "node:assert/strict" ||
                  (source === "node:module" && importer === "\0rolldown/runtime.js")
                )
                  return { id: source, external: true }
                if (source === "@dreamspan/plugin-api/server")
                  return { id: pathToFileURL(api("server")).href, external: true }
                if (source === "@dreamspan/plugin-api/worker")
                  return { id: pathToFileURL(api("worker")).href, external: true }
                if (importer && !source.startsWith(".") && !source.startsWith("/"))
                  throw new Error("Test dependency must be vendored")
                return null
              }
            }
          ]
        })
        const tested = await runPluginChild(pathToFileURL(output), [], {
          permissions,
          networkFilter,
          timeout: 10_000,
          memory: 256
        })
        if (!tested.ok) throw new Error("Test failed")
      }
    }
  }
  if (manifest.worker)
    await writeFile(
      join(folder, "worker-bridge.mjs"),
      `import { installWorkerState, installWorkerAssembly } from ${JSON.stringify(new URL("./workerHost.ts", import.meta.url).href)};
import { activate } from "./worker.mjs";
const manifest = ${JSON.stringify(manifest)};
export const state = installWorkerState(manifest,activate);
export const assembly = installWorkerAssembly(manifest,activate);
`
    )
  step = "ready"
  message =
    manifest.server || manifest.worker
      ? "Plugin check passed. Server code has full access, including stored keys and network."
      : actorRole === "regular"
        ? "Type check and bundle passed. Load probe and tests skipped: an admin runs plugin tests."
        : "Plugin check passed"
} catch {
  /* Deliberately fixed messages: plugin exceptions can contain credentials and paths. */
}
const order = ["snapshot", "manifest", "types", "bundle", "probe", "tests", "ready"]
const report: PluginReport = {
  commit,
  appStamp,
  ok: step === "ready",
  step,
  message,
  at: Date.now(),
  cached,
  steps: order
    .slice(0, order.indexOf(step) + 1)
    .filter((current) => actorRole !== "regular" || !["probe", "tests"].includes(current))
    .map((current) => ({ step: current, ok: step === "ready" || current !== step }))
}

const artifacts: Record<string, string> = {}
for (const file of await readdir(folder).catch(() => []))
  if (/^(?:server|worker|client|worker-bridge|test-[0-9]+)\.mjs$/.test(file))
    artifacts[file] = createHash("sha256")
      .update(await readFile(join(folder, file)))
      .digest("hex")
await writeFile(join(folder, "check.json"), JSON.stringify({ ...report, artifacts })).catch(() => undefined)
