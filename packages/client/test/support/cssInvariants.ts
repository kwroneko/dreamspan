// What message CSS must never do, checked on the scoper's output by a walk of its own (not the
// scoper's code): every style rule is inside `@scope (.message-html)` or starts with
// `.message-html `, no at-rule but the allowed ones, and nothing that loads a resource except
// `data:`, `#` and, with consent, the app's own media proxy.
import { type CSSToken, TokenType, tokenize } from "@csstools/css-tokenizer"
import {
  type ComponentValue,
  isCommentNode,
  isFunctionNode,
  isSimpleBlockNode,
  isTokenNode,
  isWhitespaceNode,
  parseListOfComponentValues
} from "@csstools/css-parser-algorithms"

const LOADING = new Set([
  "src",
  "image",
  "image-set",
  "-webkit-image-set",
  "cross-fade",
  "-webkit-cross-fade",
  "element",
  "-moz-element",
  "paint",
  "attr",
  "expression"
])
const ALLOWED_AT = new Set([
  "scope",
  "media",
  "supports",
  "container",
  "starting-style",
  "keyframes",
  "-webkit-keyframes",
  "font-face"
])

const tokenOf = (value: ComponentValue | undefined): CSSToken | null =>
  value && isTokenNode(value) ? value.value : null
const blank = (value: ComponentValue) => isWhitespaceNode(value) || isCommentNode(value)
const text = (values: ReadonlyArray<ComponentValue>) =>
  values
    .filter((value) => !isCommentNode(value))
    .map((value) => value.toString())
    .join("")
    .trim()

function address(value: string, consent: boolean, fragmentsOnly: boolean): string | null {
  const trimmed = value.trim()
  if (trimmed.startsWith("#")) return null
  if (fragmentsOnly) return `url to ${trimmed}`
  if (/^data:/i.test(trimmed)) return null
  if (consent && trimmed.startsWith("/media/external?")) return null
  return `url to ${trimmed}`
}

/** Loading constructs anywhere in these values. */
export function loadingViolations(
  values: ReadonlyArray<ComponentValue>,
  consent: boolean,
  fragmentsOnly = false
): string[] {
  const found: string[] = []
  for (const value of values) {
    const token = tokenOf(value)
    if (token?.[0] === TokenType.URL) {
      const problem = address((token[4] as { value: string }).value, consent, fragmentsOnly)
      if (problem) found.push(problem)
    }
    if (token && [TokenType.BadURL, TokenType.BadString].includes(token[0])) found.push(`bad token ${token[1]}`)
    if (token?.[0] === TokenType.AtKeyword) found.push(`at-keyword ${token[1]} in a value`)
    if (isFunctionNode(value)) {
      const name = value.getName().toLowerCase()
      if (LOADING.has(name)) found.push(`loading function ${name}(`)
      if (name === "url") {
        const args = value.value.filter((inner) => !blank(inner))
        const string = tokenOf(args[0])
        if (args.length !== 1 || string?.[0] !== TokenType.String) found.push("url() without one string")
        else {
          const problem = address((string[4] as { value: string }).value, consent, fragmentsOnly)
          if (problem) found.push(problem)
        }
      }
    }
    if (isFunctionNode(value) || isSimpleBlockNode(value))
      found.push(...loadingViolations(value.value, consent, fragmentsOnly))
  }
  return found
}

function parseOrViolation(css: string): { values: ComponentValue[] } | { violation: string } {
  let error: string | null = null
  const tokens = tokenize({ css }, { onParseError: (problem) => (error ??= problem.message) })
  const values = parseListOfComponentValues(tokens, { onParseError: (problem) => (error ??= problem.message) })
  return error ? { violation: `does not parse cleanly: ${error}` } : { values }
}

/** Violations of the stylesheet invariants; empty when the output is safe. */
export function stylesheetViolations(css: string, consent: boolean): string[] {
  const parsed = parseOrViolation(css)
  if ("violation" in parsed) return [parsed.violation]
  const found: string[] = []
  const rules = (values: ReadonlyArray<ComponentValue>, scoped: boolean) => {
    let prelude: ComponentValue[] = []
    for (const value of values) {
      if (prelude.length === 0 && blank(value)) continue
      if (isSimpleBlockNode(value) && value.startToken[0] === TokenType.OpenCurly) {
        const keyword = tokenOf(prelude[0])
        if (keyword?.[0] === TokenType.AtKeyword) {
          const name = (keyword[4] as { value: string }).value.toLowerCase()
          if (!ALLOWED_AT.has(name)) found.push(`at-rule @${name}`)
          if (name === "scope") {
            if (scoped || text(prelude.slice(1)) !== "(.message-html)") found.push(`@scope ${text(prelude.slice(1))}`)
            rules(value.value, true)
          } else if (name === "keyframes" || name === "-webkit-keyframes" || name === "font-face")
            found.push(...loadingViolations(value.value, consent))
          else {
            found.push(...loadingViolations(prelude, false))
            rules(value.value, scoped)
          }
        } else {
          // A style rule: each selector scoped, or inside @scope.
          const selectors: ComponentValue[][] = [[]]
          for (const part of prelude)
            if (tokenOf(part)?.[0] === TokenType.Comma) selectors.push([])
            else selectors[selectors.length - 1]!.push(part)
          for (const selector of selectors.map(text)) {
            const ok = scoped ? /^:scope\s/.test(selector) : /^\.message-html\s+(?![+~|])/.test(selector)
            if (!ok) found.push(`selector outside the scope: ${selector}`)
          }
          found.push(...loadingViolations(prelude, false), ...loadingViolations(value.value, consent))
        }
        prelude = []
      } else if (tokenOf(value)?.[0] === TokenType.Semicolon && tokenOf(prelude[0])?.[0] === TokenType.AtKeyword) {
        found.push(`statement at-rule ${text(prelude)}`)
        prelude = []
      } else prelude.push(value)
    }
    if (prelude.some((value) => !blank(value))) found.push(`dangling ${text(prelude)}`)
  }
  rules(parsed.values, false)
  return found
}

/** Violations of a single property value (a style attribute's, a presentation attribute's). */
export function valueViolations(value: string, consent: boolean, fragmentsOnly = false): string[] {
  const parsed = parseOrViolation(value)
  if ("violation" in parsed) return [parsed.violation]
  const found = loadingViolations(parsed.values, consent, fragmentsOnly)
  for (const node of parsed.values) {
    const token = tokenOf(node)
    if (token && [TokenType.Semicolon, TokenType.OpenCurly, TokenType.CloseCurly].includes(token[0]))
      found.push(`declaration syntax ${token[1]} in a value`)
    if (isSimpleBlockNode(node) && node.startToken[0] === TokenType.OpenCurly) found.push("a block in a value")
  }
  return found
}
