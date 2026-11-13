// Provider-specific tool schema compatibility; the frozen catalog and validation stay intact.
/** A regex using Unicode property escapes (`\p{…}`, `\P{…}`), which OpenAI's tool schemas reject. */
const PROPERTY_ESCAPE = /\\[pP]\{/

/**
 * A wire-only compatibility copy for OpenAI models through OpenRouter. OpenAI models through OpenRouter answer
 * 400 to a pattern with a Unicode property escape, and to parameters that aren't an object schema
 * (an empty payload comes out as `{ "not": { "type": "null" } }`). Measured live 2026-11-13. Such
 * patterns are left out of the model's copy only: the Effect schema still checks every call.
 */
export const portableParameters = (schema: Record<string, unknown>): Record<string, unknown> => {
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip)
    if (!node || typeof node !== "object") return node
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(node)) {
      if (key === "pattern" && typeof value === "string" && PROPERTY_ESCAPE.test(value)) continue
      out[key] = strip(value)
    }
    if (Array.isArray(out.allOf)) {
      const kept = (out.allOf as Array<unknown>).filter(
        (part) => !(part && typeof part === "object" && Object.keys(part).length === 0)
      )
      if (kept.length === 0) delete out.allOf
      else out.allOf = kept
    }
    return out
  }
  const stripped = strip(schema) as Record<string, unknown>
  return stripped.type === "object" || "properties" in stripped
    ? stripped
    : {
        type: "object",
        properties: {},
        additionalProperties: false,
        ...("$defs" in stripped ? { $defs: stripped.$defs } : {})
      }
}
