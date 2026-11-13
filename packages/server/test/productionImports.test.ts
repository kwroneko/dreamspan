// The production image runs the server's TypeScript and its bundled workers from what the
// Dockerfile copies; `.dockerignore` keeps the development and test files out (ARCHITECTURE §12).
// So no module a production entry reaches through a static import may lie under a path
// `.dockerignore` excludes, or the image fails to start (ERR_MODULE_NOT_FOUND), and no package it
// imports may be a development dependency (`npm ci --omit=dev`). A module meant only for
// development is loaded with a dynamic import behind its switch.
import { readFileSync, realpathSync } from "node:fs"
import { join, relative, sep } from "node:path"
import ts from "typescript"
import { describe, expect, it } from "vitest"

const root = realpathSync(join(import.meta.dirname, "../../.."))
const server = join(root, "packages/server")

/** What the image starts (Dockerfile CMD) and every worker bundle's entry (scripts/build-workers.ts). */
const ENTRIES = ["src/main.ts", "src/db/writer.ts", "src/db/reader.ts", "src/importer/worker.ts"].map((entry) =>
  join(server, entry)
)

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

/** A top-level `await import("…")` (or `const x = await import("…")`): it always runs, as a static import does. */
const topLevelImport = (statement: ts.Statement) => {
  const expressions = ts.isExpressionStatement(statement)
    ? [statement.expression]
    : ts.isVariableStatement(statement)
      ? statement.declarationList.declarations.flatMap((declaration) =>
          declaration.initializer ? [declaration.initializer] : []
        )
      : []
  return expressions.flatMap((expression) => {
    const call = ts.isAwaitExpression(expression) ? expression.expression : expression
    return ts.isCallExpression(call) &&
      call.expression.kind === ts.SyntaxKind.ImportKeyword &&
      call.arguments[0] !== undefined &&
      ts.isStringLiteral(call.arguments[0])
      ? [call.arguments[0].text]
      : []
  })
}

/**
 * The modules a file always loads: its static imports (not `import type`) and its top-level
 * `await import()`s. A dynamic import inside a condition or a function is a switch's own choice.
 */
const staticImports = (file: string) => {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false)
  const specifiers: Array<string> = []
  for (const statement of source.statements) {
    specifiers.push(...topLevelImport(statement))
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause
      const typeOnly =
        clause?.isTypeOnly === true ||
        (clause !== undefined &&
          clause.name === undefined &&
          clause.namedBindings !== undefined &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.length > 0 &&
          clause.namedBindings.elements.every((element) => element.isTypeOnly))
      if (!typeOnly && ts.isStringLiteral(statement.moduleSpecifier)) specifiers.push(statement.moduleSpecifier.text)
    } else if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    )
      specifiers.push(statement.moduleSpecifier.text)
  }
  return specifiers
}

const packageName = (specifier: string) =>
  specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!

/** The packages production installs: every workspace's and the root's `dependencies`. */
const productionPackages = () => {
  const names = new Set<string>()
  for (const manifest of ["package.json", "packages/server/package.json", "packages/shared/package.json"]) {
    const json = JSON.parse(readFileSync(join(root, manifest), "utf8")) as {
      name?: string
      dependencies?: Record<string, string>
    }
    if (json.name) names.add(json.name)
    for (const name of Object.keys(json.dependencies ?? {})) names.add(name)
  }
  return names
}

/** Walks the static import graph from the entries; each problem names the importing chain's last step. */
const productionImportProblems = (entries: ReadonlyArray<string>, ignoreText: string) => {
  const rules = dockerIgnore(ignoreText)
  const installed = productionPackages()
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
    for (const specifier of staticImports(file)) {
      if (specifier.startsWith("node:")) continue
      const bare = !specifier.startsWith(".") && !specifier.startsWith("/")
      if (bare && !installed.has(packageName(specifier)))
        problems.push(`${specifier} is not a production dependency, imported by ${path}`)
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
    const { problems, modules } = productionImportProblems(ENTRIES, readFileSync(join(root, ".dockerignore"), "utf8"))
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
