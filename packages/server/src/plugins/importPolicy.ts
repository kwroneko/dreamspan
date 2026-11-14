// Compiler-child code only. Parse syntax, never regex-rewrite strings/comments or execute source.
import ts from "typescript"

/** Fixed descriptions: never expose arbitrary module strings (which may contain source secrets). */
const importReason = (value: string) =>
  value.startsWith("node:")
    ? "file or system access"
    : value.includes("session")
      ? "the chat session"
      : value.includes("plugin")
        ? "another plugin or an app-only module"
        : "an app-only module or an unbundled dependency"
export const rewriteImports = (
  text: string,
  file: string,
  resolveImport: (value: string) => string | undefined
): { text: string; unsupported: ReadonlyArray<string> } => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const edits: Array<{ start: number; end: number; text: string }> = []
  const unsupported = new Set<string>()
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === "require") unsupported.add("require-style imports")
    if (ts.isImportEqualsDeclaration(node)) unsupported.add("require-style imports")
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    )
      unsupported.add(
        node.expression.kind === ts.SyntaxKind.ImportKeyword ? "dynamic imports" : "require-style imports"
      )
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isImportTypeNode(node)) {
      const spec = ts.isImportTypeNode(node)
        ? ts.isLiteralTypeNode(node.argument)
          ? node.argument.literal
          : undefined
        : node.moduleSpecifier
      if (spec) {
        if (!ts.isStringLiteralLike(spec)) unsupported.add("computed imports")
        else {
          const next = resolveImport(spec.text)
          if (next === undefined) unsupported.add(importReason(spec.text))
          else edits.push({ start: spec.getStart(source), end: spec.end, text: JSON.stringify(next) })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  for (const e of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, e.start) + e.text + text.slice(e.end)
  return { text, unsupported: [...unsupported] }
}
