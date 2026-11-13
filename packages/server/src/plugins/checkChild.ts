import { createHash } from "node:crypto"
// Entry for a bounded build child; never imported by the HTTP process.
import { writeFile, readdir, readFile, lstat } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import ts from "typescript"
import { build } from "rolldown"
import { snapshot } from "./repo.ts"
import { runPluginChild } from "./process.ts"
import type { PluginReport } from "@rp/shared/plugins.ts"

const [dataDir, owner, id, commit, folder, appStamp, previous, expectedReport] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string
]
let cached = false
let step: PluginReport["step"] = "snapshot"
let message = "Plugin tree is invalid or differs from its commit"
const root = fileURLToPath(new URL("../../../../", import.meta.url))
try {
  const manifest = await snapshot(dataDir, owner, id, commit, folder)
  step = "manifest"
  message = "Plugin manifest or declared surface is unsupported"
  const server = [
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
  if (manifest.overrides.length) throw new Error("Internal service overrides need a restart adapter")
  if (owner && (manifest.server || manifest.worker || manifest.network))
    throw new Error("Server code needs an instance plugin and an admin")
  for (const surface of manifest.surfaces) {
    const [side, name] = surface.split(":")
    if (side === "server" ? !server.includes(name!) : side === "worker" ? !worker.includes(name!) : side !== "client")
      throw new Error("Unknown surface")
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
        if (!/^(?:server|worker|worker-bridge|test-[0-9]+)\.mjs$/.test(file)) throw new Error("Invalid artifact")
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
      paths: { "@rp/plugin-api/server": [api("server")], "@rp/plugin-api/worker": [api("worker")] }
    }
    const compiler = ts.createCompilerHost(options)
    const program = ts.createProgram(sources, options, compiler)
    // Syntax/import policy applies to plugin sources; dependencies are vendored, never installed.
    for (const path of sources) {
      const source = program.getSourceFile(path)!
      const test = path.includes("/test/")
      const imports = (node: ts.Node) => {
        let spec: ts.Expression | undefined
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) spec = node.moduleSpecifier
        else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
          spec = node.arguments[0]
        if (spec) {
          if (!ts.isStringLiteralLike(spec)) throw new Error("Computed plugin imports are refused")
          const value = spec.text
          if (
            !value.startsWith("./") &&
            !value.startsWith("../") &&
            ![
              "@rp/plugin-api/server",
              "@rp/plugin-api/worker",
              ...(test ? ["node:test", "node:assert/strict"] : [])
            ].includes(value)
          )
            throw new Error("Undeclared dependency")
          if (value.startsWith(".") && !resolve(path, "..", value).startsWith(folder + "/"))
            throw new Error("Escaping import")
        }
        ts.forEachChild(node, imports)
      }
      imports(source)
    }
    // Only report plugin-local diagnostics. App/API contracts are checked by npm run check.
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .filter((d) => !d.file || d.file.fileName.startsWith(folder + "/"))
    if (diagnostics.length) throw new Error("Type error")
    step = "bundle"
    message = "Plugin bundle failed"
    for (const side of ["server", "worker", "client"] as const) {
      const entry = manifest[side]
      if (!entry) continue
      // P2 supplies the client API and browser output. P1 retains its entry in the manifest.
      if (side === "client") continue
      await build({
        input: join(folder, entry),
        platform: "node",
        tsconfig: false,
        output: { file: join(folder, `${side}.mjs`), format: "esm" },
        plugins: [
          {
            name: "plugin-api-only",
            resolveId(source, importer) {
              if (importer === "\0rolldown/runtime.js" && source === "node:module")
                return { id: source, external: true }
              if (source === `@rp/plugin-api/${side}`) return { id: pathToFileURL(api(side)).href, external: true }
              if (source === "@rp/plugin-api/server" || source === "@rp/plugin-api/worker")
                throw new Error("Wrong API entry")
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
    const probe = await runPluginChild(
      new URL("./probeChild.ts", import.meta.url),
      [folder, JSON.stringify(manifest)],
      {
        permissions,
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
              if (source === "@rp/plugin-api/server") return { id: pathToFileURL(api("server")).href, external: true }
              if (source === "@rp/plugin-api/worker") return { id: pathToFileURL(api("worker")).href, external: true }
              if (importer && !source.startsWith(".") && !source.startsWith("/"))
                throw new Error("Test dependency must be vendored")
              return null
            }
          }
        ]
      })
      const tested = await runPluginChild(pathToFileURL(output), [], { permissions, timeout: 10_000, memory: 256 })
      if (!tested.ok) throw new Error("Test failed")
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
    .map((current) => ({ step: current, ok: step === "ready" || current !== step }))
}

const artifacts: Record<string, string> = {}
for (const file of await readdir(folder).catch(() => []))
  if (/^(?:server|worker|worker-bridge|test-[0-9]+)\.mjs$/.test(file))
    artifacts[file] = createHash("sha256")
      .update(await readFile(join(folder, file)))
      .digest("hex")
await writeFile(join(folder, "check.json"), JSON.stringify({ ...report, artifacts })).catch(() => undefined)
