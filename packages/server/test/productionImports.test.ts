// Source, bundle and runtime-file closure of Docker's production entries. Computed references
// and data-volume reads require exact, explained reviews; missing files never disappear from
// the graph just because they are loaded only on a rarely used path.
import { readdirSync, existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync, realpathSync } from "node:fs"
import { isBuiltin } from "node:module"
import { tmpdir } from "node:os"
import { basename, dirname, extname, join, relative, sep } from "node:path"
import ts from "typescript"
import { describe, expect, inject, it } from "vitest"
import { LOCAL_ENCODINGS } from "../src/importer/tokenizer.ts"

const root = realpathSync(join(import.meta.dirname, "../../.."))
const server = join(root, "packages/server")

/** Read entry maps from the build scripts so a newly added worker/entry joins the audit. */
const objectStrings = (file: string, name: string) => {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true)
  let entries: Array<[string, string]> | undefined
  const visit = (node: ts.Node) => {
    if (
      (ts.isVariableDeclaration(node) && node.name.getText(source) === name) ||
      (ts.isPropertyAssignment(node) && node.name.getText(source) === name)
    ) {
      let value = node.initializer
      if (value && ts.isAsExpression(value)) value = value.expression
      if (!value || !ts.isObjectLiteralExpression(value)) throw new Error(`Nonliteral entry map ${name}`)
      entries = value.properties.map((property) => {
        if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.initializer))
          throw new Error(`Nonliteral entry in ${name}`)
        return [property.name.getText(source).replace(/^"|"$/g, ""), property.initializer.text]
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!entries) throw new Error(`Missing entry map ${name}`)
  return entries
}
const workers = objectStrings(join(server, "scripts/build-workers.ts"), "WORKERS")
const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8")
const command = JSON.parse(dockerfile.match(/^CMD (.+)$/m)![1]!) as Array<string>
if (command.length !== 2 || command[0] !== "node") throw new Error("Review the production CMD entry")
const ENTRIES = [join(root, command[1]!), ...workers.map(([, source]) => join(server, "src", source))]
const pluginEntries = Object.values(
  JSON.parse(readFileSync(join(root, "packages/plugin-api/package.json"), "utf8")).exports as Record<string, string>
).map((source) => join(root, "packages/plugin-api", source))
const clientEntries = objectStrings(join(root, "packages/client/vite.config.ts"), "input").flatMap(([, source]) => {
  if (!source.endsWith(".html")) return [join(root, "packages/client", source)]
  const html = readFileSync(join(root, "packages/client", source), "utf8")
  return [...html.matchAll(/<script[^>]+src="([^"?]+)"/g)].map((match) => join(root, "packages/client", match[1]!))
})

/** `.dockerignore`'s patterns, in order, as matchers on a repository-relative path (`!` re-includes). */
const dockerIgnore = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => {
      const negated = line.startsWith("!")
      const pattern = (negated ? line.slice(1) : line).replace(/^\/+|\/+$/g, "")
      const source = pattern
        .split("/")
        .map((part) =>
          part === "**"
            ? "(?:.*)"
            : part
                .replace(/[.+^${}()|[\]\\]/g, "\\$&")
                .replace(/\*/g, "[^/]*")
                .replace(/\?/g, "[^/]")
        )
        .join("/")
        .replace(/\(\?:\.\*\)\//g, "(?:.*/)?")
      // A pattern names a file or a directory, and a directory excludes everything under it.
      return { negated, pattern, test: new RegExp(`^${source}(?:/.*)?$`) }
    })

const excludedBy = (rules: ReturnType<typeof dockerIgnore>, path: string) => {
  let hit: string | null = null
  for (const rule of rules) if (rule.test.test(path)) hit = rule.negated ? null : rule.pattern
  return hit
}

const compilerOptions: ts.CompilerOptions = {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  allowImportingTsExtensions: true,
  target: ts.ScriptTarget.ES2024
}

/** Inspect the whole AST: a rarely called path still belongs to the image. */
const references = (file: string, text = readFileSync(file, "utf8")) => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const fsBindings = new Set<string>(["readFile", "readFileSync", "readdir", "readdirSync", "createReadStream"])
  const fsNamespaces = new Set<string>()
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !/^(?:node:)?fs(?:\/promises)?$/.test(statement.moduleSpecifier.text)
    )
      continue
    if (statement.importClause?.name) fsNamespaces.add(statement.importClause.name.text)
    const bindings = statement.importClause?.namedBindings
    if (bindings && ts.isNamedImports(bindings))
      for (const entry of bindings.elements)
        if (
          /^(readFile|readFileSync|readdir|readdirSync|open|opendir|createReadStream)$/.test(
            (entry.propertyName ?? entry.name).text
          )
        )
          fsBindings.add(entry.name.text)
    if (bindings && ts.isNamespaceImport(bindings)) fsNamespaces.add(bindings.name.text)
  }
  const imports: Array<{ specifier: string; dynamic: boolean; condition?: string; handled?: boolean }> = []
  const computed: Array<string> = []
  const reads: Array<string> = []
  const urls: Array<string> = []
  const literal = (node: ts.Node | undefined): node is ts.StringLiteralLike =>
    node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause
      const onlyTypes =
        clause?.isTypeOnly ||
        (clause &&
          !clause.name &&
          clause.namedBindings &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.length > 0 &&
          clause.namedBindings.elements.every((element) => element.isTypeOnly))
      if (!onlyTypes && literal(node.moduleSpecifier))
        imports.push({ specifier: node.moduleSpecifier.text, dynamic: false })
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && literal(node.moduleSpecifier)) {
      const onlyTypes =
        node.exportClause &&
        ts.isNamedExports(node.exportClause) &&
        node.exportClause.elements.length > 0 &&
        node.exportClause.elements.every((element) => element.isTypeOnly)
      if (!onlyTypes) imports.push({ specifier: node.moduleSpecifier.text, dynamic: false })
    } else if (ts.isCallExpression(node)) {
      const name = node.expression.getText(source)
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        name === "require" ||
        name.endsWith(".glob") ||
        name.endsWith(".globEager")
      ) {
        if (
          (node.expression.kind === ts.SyntaxKind.ImportKeyword || name === "require") &&
          literal(node.arguments[0])
        ) {
          let condition: string | undefined
          let handled = false
          for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
            if (ts.isConditionalExpression(parent)) condition = parent.condition.getText(source)
            if (ts.isCallExpression(parent) && parent.expression.getText(source) === "Effect.tryPromise") handled = true
          }
          imports.push({
            specifier: node.arguments[0].text,
            dynamic: node.expression.kind === ts.SyntaxKind.ImportKeyword,
            ...(condition === undefined ? {} : { condition }),
            handled
          })
        } else computed.push(node.getText(source))
      }
      if (
        fsBindings.has(name) ||
        (ts.isPropertyAccessExpression(node.expression) &&
          fsNamespaces.has(node.expression.expression.getText(source)) &&
          /^(readFile|readFileSync|readdir|readdirSync|open|opendir|createReadStream)$/.test(node.expression.name.text))
      )
        reads.push(node.getText(source).replace(/\s+/g, " "))
    } else if (
      ts.isNewExpression(node) &&
      node.expression.getText(source) === "Worker" &&
      node.arguments?.[0] &&
      !(
        ts.isNewExpression(node.arguments[0]) &&
        node.arguments[0].expression.getText(source) === "URL" &&
        node.arguments[0].arguments?.[1]?.getText(source) === "import.meta.url"
      )
    ) {
      computed.push(`worker(${node.arguments[0].getText(source)})`)
    } else if (
      ts.isNewExpression(node) &&
      node.expression.getText(source) === "URL" &&
      node.arguments?.[1]?.getText(source) === "import.meta.url"
    ) {
      if (literal(node.arguments[0])) urls.push(node.arguments[0].text)
      else computed.push(node.getText(source))
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { imports, computed, reads, urls }
}
const staticImports = (file: string) => references(file).imports.map((entry) => entry.specifier)

/** Final-stage COPY contract. Reject unsupported syntax rather than silently guessing. */
const imageCopies = (text: string) => {
  const final = text.split(/^FROM .+$/m).at(-1)!
  return final
    .split("\n")
    .filter((line) => line.startsWith("COPY "))
    .flatMap((line) => {
      const words = line.split(/\s+/).slice(1)
      const stage = words[0]?.startsWith("--from=") ? words.shift()!.slice(7) : null
      if (words.length < 2 || words.some((word) => /[\[\]*?$]/.test(word))) throw new Error(`Unsupported COPY: ${line}`)
      const destination = words.pop()!.replace(/^\.\//, "").replace(/\/$/, "") || "."
      return words.map((source) => ({ stage, source: source.replace(/^\/app\//, "").replace(/\/$/, ""), destination }))
    })
}
const copies = imageCopies(dockerfile)
const copiedBy = (path: string, built: boolean, set = copies) =>
  set.some((copy) => {
    if (
      (built ? copy.stage !== "build" : copy.stage !== null) ||
      !(path === copy.source || path.startsWith(copy.source + "/"))
    )
      return false
    // COPY of a directory copies its contents; a file may name its directory as destination.
    const destination =
      extname(copy.source) && [".", dirname(copy.source)].includes(copy.destination)
        ? join(copy.destination, basename(copy.source))
        : copy.destination
    return destination === copy.source
  })
const copied = (path: string, built = false) => copiedBy(path, built)

// Exact, reviewed exceptions, never a blanket skip of dynamic imports. Development files
// are absent from the image and both loaders turn a missing module into a plain startup error.
const developmentImports = new Set(["./dev/fakeCardSource.ts", "./dev/fakeSavedMedia.ts"])
const computedReviews: Record<string, string> = {
  "packages/client/src/plugins.tsx: import(/* @vite-ignore */ url)":
    "Canonical same-origin checked client module URLs built only from authenticated enabled-commit descriptors; no content or arbitrary caller import path.",
  'packages/server/src/plugins/Host.ts: import(pathToFileURL(join(folder, "server.mjs")).href)':
    "Only explicit admin-enabled, checked server bundle URLs in the confined plugin build tree; never content.",
  "packages/server/src/plugins/probeChild.ts: import(pathToFileURL(join(folder, `${side}.mjs`)).href)":
    "Checked synthetic/admin-authorized server and worker bundles, in a bounded clean-environment permission child.",

  "packages/server/src/db/Database.ts: worker(entry)":
    "The source writer/reader/formats URLs and stamped bundle entries, checked by this graph and the bundle test.",
  "packages/server/src/assembler/modules.ts: import(source.module)":
    "Trusted registry module URLs supplied by installed code; no built-in external file.",
  "packages/server/src/importer/workerHandlers.ts: import(source.module)":
    "Trusted parser registry URLs; built-ins use the statically imported parser table.",
  "packages/server/src/db/stateModules.ts: import(source.module)":
    "Trusted state registry modules, never public RPC input.",
  "packages/server/src/db/stateModules.ts: import(snapshot.schemaModule)":
    "Effect schema URL supplied by the parent process.",
  "packages/server/src/importer/tokenizer.ts: new URL(`./tokenizers/${encoding}.json.gz`, import.meta.url)":
    "Finite LOCAL_ENCODINGS assets, checked below in source and worker output."
}

/** Every filesystem read is classified; a new expression requires review. */
const readReviews: Record<string, { reason: string; expressions: Array<string> }> = {
  "packages/server/src/plugins/copy.ts": {
    reason:
      "Only the finite shipped-source catalog, matched by registry/id; validates all parents, excludes the configured data volume, refuses links and non-text/oversized files. base.path is matched to the catalog and never opened. Client src is copied by Docker for inert authenticated copies, never served as modules.",
    expressions: ["readFile(file)"]
  },
  "packages/server/src/plugins/reference.ts": {
    reason:
      "Shipped allowlisted agent/plugin/API source only; bounded index, confined non-link UTF-8 files, and finite API topic declarations, including credential-free macro context types. Source workspaces are included by final Docker COPY.",
    expressions: [
      "readdir(join(root, p), { withFileTypes: true })",
      'readFile(join(root, p), "utf8")',
      'readFile(join(root, "packages/plugin-api/src", doc.side + ".ts"), "utf8")',
      'readFile( join( root, topic === "stateKeys" ? "packages/shared/src/state.ts" : topic === "macroContext" ? "packages/shared/src/macros/context.ts" : "packages/shared/src/macros/registry.ts" ), "utf8" )'
    ]
  },
  "packages/server/src/plugins/authorRepo.ts": {
    reason:
      "Private operation journals and creation markers inside validated plugin Git metadata; no caller-selected journal paths, links or source execution. Directory listings detect an existing repository or its empty pre-intent metadata directory.",
    expressions: [
      'readFile(file, "utf8")',
      'readFile(join(journals, request.undo + ".json"), "utf8")',
      'readFile(marker, "utf8")',
      'readdir(join(folder, ".git"))',
      "readdir(folder)"
    ]
  },
  "packages/server/src/plugins/serve.ts": {
    reason:
      "The Vite build manifest shipped with the configured client dist; facade points only to a validated assets filename.",
    expressions: ['readFile(join(config.clientDist, ".vite/manifest.json"), "utf8")']
  },
  "packages/server/src/plugins/repoTask.ts": {
    reason:
      "Confined synthetic request/response files for bounded Git operations under DATA_DIR/plugins/.ops; no plugin code is evaluated.",
    expressions: ['readFile(response, "utf8")']
  },
  "packages/server/src/plugins/repoChild.ts": {
    reason:
      "Confined synthetic request/response files for bounded Git operations under DATA_DIR/plugins/.ops; no plugin code is evaluated.",
    expressions: ['readFile(join(folder, "request.json"), "utf8")']
  },

  "packages/server/src/plugins/Host.ts": {
    reason:
      "Confined plugin repositories in the configured data volume; source/manifest size and symlink checks precede execution.",
    expressions: ["readdir(base)"]
  },
  "packages/server/src/plugins/check.ts": {
    reason:
      "Installed source/API closure and worker stamp hash, and confined checked-plugin artifacts in the data volume.",
    expressions: [
      "readdir(dir, { withFileTypes: true })",
      "readFile(file)",
      'readFile(join(root, "package-lock.json"))',
      'readFile(join(root, "packages/server/dist/workers/stamp.json"))',
      'readFile(join(staging, "check.json"), "utf8")',
      'readFile(join(build, "check.json"))',
      'readFile(join(folder, "rp-plugin.json"), "utf8")',
      'readFile(join(folder, "check.json"), "utf8")'
    ]
  },
  "packages/server/src/plugins/checkChild.ts": {
    reason:
      "Installed source/API closure and worker stamp hash, and confined checked-plugin artifacts in the data volume.",
    expressions: [
      "readdir(dir, { withFileTypes: true })",
      'readFile(join(previous, "check.json"), "utf8")',
      "readFile(path)",
      "readdir(folder)",
      "readFile(join(folder, file))"
    ]
  },
  "packages/server/src/plugins/processSupervisor.ts": {
    reason: "Only the checked child PID in /proc; sampled RSS limit, no process discovery.",
    expressions: ['readFile(`/proc/${child.pid}/status`, "utf8")']
  },
  "packages/server/src/plugins/repo.ts": {
    reason:
      "Confined plugin repositories in the configured data volume; source/manifest size and symlink checks precede execution.",
    expressions: [
      "readdir(dir, { withFileTypes: true })",
      "readFile(join(dir, entry.name))",
      "readdir(folder)",
      'readFile(file, "utf8")'
    ]
  },

  "packages/server/src/server.ts": {
    reason: "Generated client build-id.json; final COPY includes the whole dist directory.",
    expressions: ['readFile(join(config.clientDist, "build-id.json"), "utf8")']
  },
  "packages/server/src/sources/CardSources.ts": {
    reason: "Thumbnails created in the configured data volume.",
    expressions: ["readFile(join(config.dataDir, thumb.value.path))"]
  },
  "packages/server/src/importer/thumbnail.ts": {
    reason: "Imported or generated media in the configured data volume.",
    expressions: ["readFile(original)", "readFile(join(input.dataDir, input.path))"]
  },
  "packages/server/src/importer/tokenizer.ts": {
    reason: "Vendored finite tokenizer set, copied beside the bundled formats worker; checked below.",
    expressions: ["readFile(new URL(`./tokenizers/${encoding}.json.gz`, import.meta.url))"]
  },
  "packages/server/src/api/savedMedia.ts": {
    reason: "Imported or generated media in the configured data volume.",
    expressions: ["readFile(file.path)"]
  },
  "packages/server/src/auth/Accounts.ts": {
    reason: "Operator-supplied ADMIN_PASSWORD_FILE, deliberately outside the image.",
    expressions: ['readFileSync(file, "utf8")']
  },
  "packages/server/src/importer/routes.ts": {
    reason: "Imported or generated media in the configured data volume.",
    expressions: ["readFile(join(config.dataDir, path))"]
  },
  "packages/server/src/secrets.ts": {
    reason: "Operator-supplied secret file or generated secret.key in the data volume.",
    expressions: ['readFileSync(path, "utf8")']
  },
  "packages/server/src/importer/mediaFiles.ts": {
    reason: "Imported or generated media in the configured data volume.",
    expressions: ["readdir(path)", "readFile(join(dataDir, path))"]
  },
  "packages/server/src/sources/cache.ts": {
    reason: "Card-source cache entries and blobs created in the data volume.",
    expressions: [
      "readdir(dir)",
      "readFile(join(options.dataDir, blobPath(sha)))",
      "readdir(entriesDir)",
      'readFile(path, "utf8")',
      "readdir(blobsDir)"
    ]
  },
  "packages/server/src/db/workerStamp.ts": {
    reason: "Generated stamp.json and its listed sources; all source COPY paths checked below.",
    expressions: ["readFileSync(file)", 'readFileSync(file, "utf8")']
  },
  "packages/server/src/net/externalMedia.ts": {
    reason: "Approved media downloaded into the data volume.",
    expressions: ['open(path, "r")', 'open(path, "wx", 0o600)']
  },
  "packages/server/src/importer/stFolderDisk.ts": {
    reason: "Explicit user-selected import directory; synthetic fixtures only in tests.",
    expressions: [
      'open(file, "r")',
      "opendir(dir)",
      "readdir(folder)",
      "opendir(folder)",
      'open(join(root, path), "r")',
      "readFile(path)",
      "createReadStream(path, { highWaterMark: 1 << 20 })",
      'readFile(full, "utf8")'
    ]
  }
}

const packageName = (specifier: string) =>
  specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!

/** The packages production installs: every workspace's and the root's `dependencies`. */
const productionPackages = (client = false) => {
  const names = new Set<string>()
  for (const manifest of [
    "package.json",
    "packages/shared/package.json",
    "packages/plugin-api/package.json",
    client ? "packages/client/package.json" : "packages/server/package.json"
  ]) {
    const json = JSON.parse(readFileSync(join(root, manifest), "utf8")) as {
      name?: string
      dependencies?: Record<string, string>
    }
    if (json.name) names.add(json.name)
    for (const name of Object.keys(json.dependencies ?? {})) names.add(name)
  }
  return names
}

/** Walks the runtime import graph from the entries; each problem names the importing chain's last step. */
const productionImportProblems = (
  entries: ReadonlyArray<string>,
  ignoreText: string,
  client = false,
  copyText?: string
) => {
  const included = copyText === undefined ? copied : (path: string) => copiedBy(path, false, imageCopies(copyText))
  const rules = dockerIgnore(ignoreText)
  const installed = productionPackages(client)
  const host = ts.createCompilerHost(compilerOptions)
  const problems: Array<string> = []
  const seen = new Set<string>()
  const queue = entries.map((entry) => ({ file: realpathSync(entry), from: "(entry)" }))
  while (queue.length > 0) {
    const { file, from } = queue.shift()!
    if (seen.has(file)) continue
    seen.add(file)
    const path = relative(root, file).split(sep).join("/")
    const excluded = excludedBy(rules, path)
    if (excluded !== null) {
      problems.push(`${path} (excluded by .dockerignore "${excluded}") is imported by ${from}`)
      continue
    }
    if (!client && !included(path)) problems.push(`${path} is not in the final Docker COPY set`)
    const refs = references(file)
    for (const expression of refs.reads) {
      if (!readReviews[path]?.expressions.includes(expression))
        problems.push(`Unreviewed runtime read: ${path}: ${expression}`)
    }
    for (const expression of refs.computed) {
      if (!computedReviews[`${path}: ${expression}`])
        problems.push(`Unreviewed computed reference: ${path}: ${expression}`)
    }
    for (const asset of refs.urls) {
      const target = relative(root, join(file, "..", asset))
        .split(sep)
        .join("/")
      // Directory URLs select generated worker output or the stamp root; checked separately.
      if (["../../dist/workers", "../../../../"].includes(asset)) continue
      if (asset === "../../client/dist" && copied(target, true)) continue
      if (!client && (!included(target) || excludedBy(rules, target)))
        problems.push(`Missing runtime URL: ${target} from ${path}`)
      if (/\.[cm]?[jt]sx?$/.test(asset)) queue.push({ file: realpathSync(join(root, target)), from: path })
    }
    for (const { specifier, dynamic, condition, handled } of refs.imports) {
      if (path === "packages/server/src/runMain.ts" && dynamic && developmentImports.has(specifier)) {
        const expected = specifier.endsWith("fakeCardSource.ts")
          ? 'setup === "fake"'
          : 'process.env[serverEnvironment.FAKE_SAVED_MEDIA] === "on"'
        if (condition === expected && handled) continue
        problems.push(`Development import must stay conditional and handle failure: ${specifier}`)
      }
      if (isBuiltin(specifier)) continue
      const bare = !specifier.startsWith(".") && !specifier.startsWith("/")
      if (bare && !installed.has(packageName(specifier)))
        problems.push(`${specifier} is not a production dependency, imported by ${path}`)
      const clean = specifier.split("?")[0]!
      const asset = join(file, "..", clean)
      if (!bare && /\.(css|svg|png|woff2?|json|md)$/.test(clean)) {
        const target = relative(root, asset).split(sep).join("/")
        if (!existsSync(asset) || excludedBy(rules, target) || (!client && !included(target)))
          problems.push(`Missing asset: ${target}`)
        continue
      }
      const resolved = ts.resolveModuleName(specifier, file, compilerOptions, host).resolvedModule
      if (!resolved) {
        problems.push(`${specifier} doesn't resolve, imported by ${path}`)
        continue
      }
      const target = realpathSync(resolved.resolvedFileName)
      // Installed packages are copied whole from production node_modules; only our sources are walked.
      if (target.split(sep).includes("node_modules") || !target.startsWith(root + sep)) continue
      queue.push({ file: target, from: path })
    }
  }
  return { problems, modules: seen.size }
}

describe("production entries", () => {
  it("reach no module the image leaves out", () => {
    const { problems, modules } = productionImportProblems(
      [...ENTRIES, ...pluginEntries],
      readFileSync(join(root, ".dockerignore"), "utf8")
    )
    expect(modules).toBeGreaterThan(100)
    expect(problems).toEqual([])
  })

  it("walks the client entries, lazy panels and browser workers before bundling", () => {
    const { problems, modules } = productionImportProblems(
      clientEntries,
      readFileSync(join(root, ".dockerignore"), "utf8"),
      true
    )
    expect(modules).toBeGreaterThan(100)
    expect(problems).toEqual([])
  })

  it("reads .dockerignore's directory and glob patterns", () => {
    const rules = dockerIgnore("**/node_modules\n# note\npackages/server/src/dev\n**/*.db*\nspikes\n!spikes/keep\n")
    expect(excludedBy(rules, "packages/server/src/dev/fakeSavedMedia.ts")).toBe("packages/server/src/dev")
    expect(excludedBy(rules, "packages/server/src/devices.ts")).toBeNull()
    expect(excludedBy(rules, "a/node_modules/x/index.js")).toBe("**/node_modules")
    expect(excludedBy(rules, "node_modules/x/index.js")).toBe("**/node_modules")
    expect(excludedBy(rules, "data/app.db-wal")).toBe("**/*.db*")
    expect(excludedBy(rules, "spikes/a.ts")).toBe("spikes")
    expect(excludedBy(rules, "spikes/keep")).toBeNull()
  })

  it("flags a static import of an excluded module", () => {
    const { problems } = productionImportProblems(
      [join(server, "src/dev/runMain.ts")],
      readFileSync(join(root, ".dockerignore"), "utf8")
    )
    expect(problems[0]).toMatch(/^packages\/server\/src\/dev\/runMain\.ts \(excluded by \.dockerignore/)
  })
})

it("walks nested imports and ignores type-only re-exports", () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-import-probe-"))
  try {
    const file = join(dir, "probe.ts")
    writeFileSync(
      file,
      `import "./side.ts"; export * from "./export.ts";
      export { type Only } from "./type.ts";
      async function run() { return import("./nested.ts") }
      if (enabled) void import("./conditional.ts")`
    )
    expect(staticImports(file)).toEqual(["./side.ts", "./export.ts", "./nested.ts", "./conditional.ts"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it("reports computed imports, globs, worker URLs and fs aliases instead of silently skipping", () => {
  const found = references(
    "probe.ts",
    `import { readFile as read } from "node:fs/promises";
    import type { Hidden } from "./hidden.ts";
    import { type AlsoHidden } from "./also-hidden.ts";
    import { type Hidden, shown } from "./shown.ts";
    export type * from "./hidden-export.ts";
    const worker = new Worker(new URL("./worker.ts", import.meta.url));
    const raw = import("./data.json", { with: { type: "json" } });
    void import(variable); import.meta.glob("./*.ts"); require(variable); new Worker(new URL(variable, base));
    read(new URL("./fixture.txt", import.meta.url));`
  )
  expect(found.imports.map((entry) => entry.specifier)).toEqual(["node:fs/promises", "./shown.ts", "./data.json"])
  expect(found.urls).toEqual(["./worker.ts", "./fixture.txt"])
  expect(found.computed).toEqual([
    "import(variable)",
    'import.meta.glob("./*.ts")',
    "require(variable)",
    "worker(new URL(variable, base))"
  ])
  expect(found.reads).toEqual(['read(new URL("./fixture.txt", import.meta.url))'])
})

it("fails for reachable files absent from the final COPY set", () => {
  const { problems } = productionImportProblems(
    [join(server, "src/main.ts")],
    "",
    false,
    "FROM node\nCOPY package.json ./"
  )
  expect(problems).toContain("packages/server/src/main.ts is not in the final Docker COPY set")
  expect(imageCopies("FROM build\nCOPY . .\nFROM node\nCOPY --from=build /app/out out\nCOPY a b ./")).toEqual([
    { stage: "build", source: "out", destination: "out" },
    { stage: null, source: "a", destination: "." },
    { stage: null, source: "b", destination: "." }
  ])
  expect(() => imageCopies('FROM node\nCOPY ["a", "b"]')).toThrow("Unsupported COPY")
})

it("copies every stamped worker source, tokenizer and licence, and installs external imports", () => {
  const dir = inject("bundleDir")
  const stamp = JSON.parse(readFileSync(join(dir, "stamp.json"), "utf8")) as { sources: Array<string> }
  const rules = dockerIgnore(readFileSync(join(root, ".dockerignore"), "utf8"))
  expect(stamp.sources.length).toBeGreaterThan(100)
  for (const source of stamp.sources) {
    expect(copied(source), source).toBe(true)
    expect(excludedBy(rules, source), source).toBeNull()
  }
  const tokenizerDir = join(server, "src/importer/tokenizers")
  for (const encoding of LOCAL_ENCODINGS) {
    if (!["o200k_base", "cl100k_base", "llama3"].includes(encoding))
      expect(existsSync(join(dir, "tokenizers", `${encoding}.json.gz`)), encoding).toBe(true)
  }
  for (const name of readdirSync(tokenizerDir)) {
    expect(readFileSync(join(dir, "tokenizers", name)).equals(readFileSync(join(tokenizerDir, name))), name).toBe(true)
  }
  for (const [worker] of workers) {
    for (const { fileName: specifier } of ts.preProcessFile(
      readFileSync(join(dir, `${worker}.mjs`), "utf8"),
      true,
      true
    ).importedFiles) {
      if (!isBuiltin(specifier)) expect(productionPackages().has(packageName(specifier)), specifier).toBe(true)
    }
  }
  expect(
    copies.some(
      (copy) => copy.stage === "prod-deps" && copy.source === "node_modules" && copy.destination === "node_modules"
    )
  ).toBe(true)
  expect(copied("packages/server/dist/workers", true)).toBe(true)
  expect(copied("packages/client/dist", true)).toBe(true)
})

it("rejects a COPY to the wrong runtime location and keeps development imports guarded", () => {
  expect(
    copiedBy("packages/server/src/main.ts", false, imageCopies("FROM node\nCOPY packages/server/src elsewhere"))
  ).toBe(false)
  const refs = references(join(server, "src/runMain.ts"))
  for (const specifier of developmentImports) {
    const found = refs.imports.find((entry) => entry.specifier === specifier)!
    expect(found.dynamic).toBe(true)
    expect(found.condition).toBeDefined()
    expect(found.handled).toBe(true)
  }
})
