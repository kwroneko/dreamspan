// A server's tool listing as the app stores it (spec/MCP.md §4.1, §4.2): each tool's name for the
// model, fitted to every wire's limits and fixed while the server's name is; whether it can be
// used; and the catalog revision it was first listed in.
import { createHash } from "node:crypto"
import { MCP_SCHEMA_LIMIT, MCP_TOOL_NAME_LIMIT, type McpServerInfo, type McpTool } from "@dreamspan/shared/mcp.ts"

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const hex = (text: string, length: number) => createHash("sha256").update(text).digest("hex").slice(0, length)

/** `mcp_<key>_<tool>`, with every character a wire refuses (`.` included) made `_`. */
export const plainToolName = (key: string, name: string) => `mcp_${key}_${name.replace(/[^A-Za-z0-9_-]/g, "_")}`

/**
 * The plain name cut to 57 characters, with `_` and six hex characters of the SHA-256 of the
 * server's own name: used when the plain name is too long or two tools would share it.
 */
export const hashedToolName = (key: string, name: string, length = 6) => {
  const plain = plainToolName(key, name)
  return `${plain.slice(0, MCP_TOOL_NAME_LIMIT - 1 - length)}_${hex(name, length)}`
}

/**
 * The model's name for each of the server's tools. A name the catalog already gave a tool stays
 * (frozen runs and transcripts name tools by it). A new tool gets its plain name, or the hashed
 * one when that's too long or taken; tools new together that would share a name both get it.
 */
export const exposedNames = (
  key: string,
  names: ReadonlyArray<string>,
  previous: ReadonlyMap<string, string>
): Map<string, string> => {
  const result = new Map<string, string>()
  const used = new Set<string>()
  const prefix = `mcp_${key}_`
  for (const name of names) {
    const kept = previous.get(name)
    if (kept !== undefined && kept.startsWith(prefix) && !used.has(kept)) {
      result.set(name, kept)
      used.add(kept)
    }
  }
  const fresh = names.filter((name) => !result.has(name))
  const plain = new Map(fresh.map((name) => [name, plainToolName(key, name)]))
  const counts = new Map<string, number>()
  for (const candidate of plain.values()) counts.set(candidate, (counts.get(candidate) ?? 0) + 1)
  for (const name of fresh) {
    const candidate = plain.get(name)!
    let exposed =
      candidate.length > MCP_TOOL_NAME_LIMIT || counts.get(candidate)! > 1 || used.has(candidate)
        ? hashedToolName(key, name)
        : candidate
    // Six hex characters colliding too: longer ones, never two tools under one name.
    for (let length = 10; used.has(exposed); length += 4) exposed = hashedToolName(key, name, length)
    result.set(name, exposed)
    used.add(exposed)
  }
  return result
}

/** Why a listed tool can't be used, or null. */
const problemOf = (tool: Record<string, unknown>): string | null => {
  const name = tool.name
  if (typeof name !== "string" || name.length === 0 || name.length > 128) return "Its name isn't valid."
  const schema = tool.inputSchema
  if (!isObject(schema) || schema.type !== "object") return "Its parameters aren't valid."
  if (Buffer.byteLength(JSON.stringify(schema)) > MCP_SCHEMA_LIMIT) return "Its parameters are too large to use."
  return null
}

/**
 * The catalog for a listing: tools by their model-facing name, each with its first revision (the
 * previous catalog's, else `nextRevision`). Entries without a usable name are dropped; other
 * unusable tools are kept, marked with the reason.
 */
export const buildCatalog = (
  key: string,
  listed: ReadonlyArray<unknown>,
  previous: ReadonlyArray<McpTool>,
  nextRevision: number
): Array<McpTool> => {
  const seen = new Set<string>()
  const tools = listed.filter(isObject).filter((tool) => {
    // A server listing one name twice: the first counts.
    if (typeof tool.name !== "string" || tool.name.length === 0 || seen.has(tool.name)) return false
    seen.add(tool.name)
    return true
  })
  const before = new Map(previous.map((tool) => [tool.name, tool]))
  const names = exposedNames(
    key,
    tools.map((tool) => tool.name as string),
    new Map(previous.map((tool) => [tool.name, tool.exposed]))
  )
  return tools
    .map((tool): McpTool => {
      const name = tool.name as string
      const text = (value: unknown) => (typeof value === "string" ? value : null)
      const annotations = isObject(tool.annotations) ? tool.annotations : null
      return {
        name,
        exposed: names.get(name)!,
        title: text(tool.title) ?? text(annotations?.title),
        description: text(tool.description) ?? "",
        inputSchema: tool.inputSchema ?? null,
        outputSchema: isObject(tool.outputSchema) ? tool.outputSchema : null,
        annotations,
        firstRevision: before.get(name)?.firstRevision ?? nextRevision,
        problem: problemOf(tool)
      }
    })
    .sort((a, b) => (a.exposed < b.exposed ? -1 : a.exposed > b.exposed ? 1 : 0))
}

/** The server's description of itself from `initialize`, as stored. */
export const serverInfoOf = (
  info: { readonly name?: unknown; readonly title?: unknown; readonly version?: unknown } | undefined,
  protocolVersion: string,
  capabilities: unknown,
  instructions: string | undefined,
  truncated: boolean
): McpServerInfo => ({
  name: typeof info?.name === "string" ? info.name : "",
  title: typeof info?.title === "string" ? info.title : null,
  version: typeof info?.version === "string" ? info.version : "",
  protocolVersion,
  instructions: instructions ?? null,
  capabilities: isObject(capabilities) ? capabilities : {},
  truncated
})
