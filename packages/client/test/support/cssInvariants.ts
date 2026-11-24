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
function loadingViolations(values: ReadonlyArray<ComponentValue>, consent: boolean, fragmentsOnly = false): string[] {
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

/** Grouping rules a style rule may nest: relative to the rule, so scoped with it. */
const NESTED_AT = new Set(["media", "supports", "container", "starting-style"])

/** A second implementation of the generated-text policy, operating on emitted declarations. */
function textAttributesOnly(declaration: ComponentValue[]): boolean {
  const tokens = declaration.filter((node) => !blank(node))
  const property = tokenOf(tokens.shift())
  if (
    property?.[0] !== TokenType.Ident ||
    property[4].value !== "content" ||
    tokenOf(tokens.shift())?.[0] !== TokenType.Colon
  )
    return false
  if (text(tokens.slice(-2)) === "!important") tokens.splice(-2)
  return (
    tokens.length > 0 &&
    tokens.every((node) => {
      if (tokenOf(node)?.[0] === TokenType.String) return true
      if (!isFunctionNode(node) || node.getName() !== "attr") return false
      const args = node.value.filter((inner) => !blank(inner))
      const argument = tokenOf(args[0])
      return (
        args.length === 1 &&
        argument?.[0] === TokenType.Ident &&
        /^(title|alt|data-label|data-value|data-text|data-tooltip)$/.test(argument[4].value)
      )
    })
  )
}
const generatedSelector = (values: ReadonlyArray<ComponentValue>) => {
  const selectors: ComponentValue[][] = [[]]
  for (const value of values) {
    if (tokenOf(value)?.[0] === TokenType.Comma) selectors.push([])
    else selectors[selectors.length - 1]!.push(value)
  }
  return selectors.every((selector) => /::(?:before|after)$/i.test(text(selector)))
}

/** A style rule's contents: declarations, nested rules and nested grouping rules, nothing loading. */
function styleBlockViolations(values: ReadonlyArray<ComponentValue>, consent: boolean, generated = false): string[] {
  const found: string[] = []
  const rest: ComponentValue[] = []
  let prelude: ComponentValue[] = []
  const ampersands = (nodes: ReadonlyArray<ComponentValue>): number =>
    nodes.reduce((count, node) => {
      const token = tokenOf(node)
      return (
        count +
        (token?.[0] === TokenType.Delim && token[4].value === "&" ? 1 : 0) +
        (isFunctionNode(node) || isSimpleBlockNode(node) ? ampersands(node.value) : 0)
      )
    }, 0)
  for (const value of values) {
    const token = tokenOf(value)
    if (isSimpleBlockNode(value) && value.startToken[0] === TokenType.OpenCurly) {
      const head = prelude.filter((node) => !blank(node))
      const first = tokenOf(head[0])
      if (first?.[0] !== TokenType.AtKeyword) {
        const count = ampersands(head)
        if (count > 0 && !(count === 1 && first?.[0] === TokenType.Delim && first[4].value === "&"))
          found.push(`nested selector can escape its parent: ${text(prelude)}`)
      }
      const nonKeywords = prelude.filter((node) => tokenOf(node)?.[0] !== TokenType.AtKeyword)
      found.push(...loadingViolations(nonKeywords, false))
      rest.splice(rest.length - nonKeywords.length)
      found.push(
        ...styleBlockViolations(
          value.value,
          consent,
          first?.[0] === TokenType.AtKeyword ? generated : generatedSelector(prelude)
        )
      )
      prelude = []
    } else {
      if (token?.[0] === TokenType.AtKeyword) {
        const name = (token[4] as { value: string }).value.toLowerCase()
        if (!NESTED_AT.has(name)) found.push(`nested at-rule @${name}`)
      } else rest.push(value)
      if (token?.[0] === TokenType.Semicolon) prelude = []
      else prelude.push(value)
    }
  }
  const declarations: ComponentValue[][] = [[]]
  for (const value of rest) {
    if (tokenOf(value)?.[0] === TokenType.Semicolon) declarations.push([])
    else declarations[declarations.length - 1]!.push(value)
  }
  for (const declaration of declarations) {
    const checked =
      generated && textAttributesOnly(declaration)
        ? declaration.filter((node) => !(isFunctionNode(node) && node.getName() === "attr"))
        : declaration
    found.push(...loadingViolations(checked, consent))
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
            found.push(...loadingViolations(prelude.slice(1), false))
            rules(value.value, scoped)
          }
        } else {
          // A style rule: each selector scoped, or inside @scope.
          const selectors: ComponentValue[][] = [[]]
          for (const part of prelude)
            if (tokenOf(part)?.[0] === TokenType.Comma) selectors.push([])
            else selectors[selectors.length - 1]!.push(part)
          for (const selector of selectors.map(text)) {
            const ok = scoped
              ? /^:scope(?::where\((?:\.rpfont-[0-9a-f-]+|:not\(\.rpfont-[0-9a-f-]+\))\))?\s/.test(selector)
              : /^\.message-html(?::where\((?:\.rpfont-[0-9a-f-]+|:not\(\.rpfont-[0-9a-f-]+\))\))?\s+(?![+~|])/.test(
                  selector
                )
            if (!ok) found.push(`selector outside the scope: ${selector}`)
          }
          found.push(
            ...loadingViolations(prelude, false),
            ...styleBlockViolations(value.value, consent, generatedSelector(prelude))
          )
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

/** Violations of a style attribute's text: declarations only, nothing that loads. */
export function declarationListViolations(text: string, consent: boolean): string[] {
  const parsed = parseOrViolation(text)
  if ("violation" in parsed) return [parsed.violation]
  const found = loadingViolations(parsed.values, consent)
  for (const node of parsed.values) {
    const token = tokenOf(node)
    if (token && [TokenType.OpenCurly, TokenType.CloseCurly].includes(token[0]))
      found.push(`rule syntax ${token[1]} in a style attribute`)
    if (isSimpleBlockNode(node) && node.startToken[0] === TokenType.OpenCurly)
      found.push("a block in a style attribute")
  }
  return found
}
