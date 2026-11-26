// Deferred tools on the wire (spec/TOOL-LOADING.md §4): the request transforms that send a run's
// loaded tools without changing the prefix the provider cached. The agent session decides what's
// deferred and where each was loaded; these only serialize it, for the wire APIs the registry's
// `toolLoadingWires` names. Without `toolLoading` in the request they change nothing.

/** One deferred tool's definition, as the session froze it. */
interface DeferredDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: unknown
}

/** What the session tells the transforms about deferred tools in one request. */
export interface ToolLoadingRequest {
  readonly api: string
  /** Every deferred tool of the run, loaded or not, in offer order. */
  readonly deferred: ReadonlyArray<DeferredDefinition>
  /** Each successful loading call in this request's history, and the tools it loaded first. */
  readonly loads: ReadonlyArray<{
    readonly toolCallId: string
    readonly names: ReadonlyArray<string>
    readonly loader?: string
  }>
}

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v)

/** pi-ai's Anthropic tool call id normalization: a `tool_use_id` is the id as it sent it. */
export const anthropicId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)

/**
 * Anthropic Messages (tool search with a client-side loader, Anthropic's tool search guide):
 * every tool is declared on every request, the deferred ones with `defer_loading: true`, so the
 * tool list is the same bytes from the first request to the last. A deferred tool can't carry
 * `cache_control`, so the marker pi-ai put on the last tool moves to the last immediate one. Each
 * loading call's `tool_result` gets a `tool_reference` block per tool it loaded: the provider
 * expands those in place, after the cached prefix, which is how a load leaves the cache alone.
 */
export const applyAnthropicToolLoading = (payload: Json, loading: ToolLoadingRequest): Json => {
  const deferred = new Set(loading.deferred.map((t) => t.name))
  const tools = Array.isArray(payload.tools) ? (payload.tools as Array<unknown>) : []
  let marker: unknown
  for (const tool of tools) {
    if (!isObject(tool) || typeof tool.name !== "string" || !deferred.has(tool.name)) continue
    tool.defer_loading = true
    if (tool.cache_control !== undefined) {
      marker = tool.cache_control
      delete tool.cache_control
    }
  }
  if (marker !== undefined) {
    const last = tools.findLast((t) => isObject(t) && t.defer_loading !== true)
    if (isObject(last)) last.cache_control = marker
  }
  const loads = new Map(loading.loads.map((l) => [anthropicId(l.toolCallId), l.names]))
  if (loads.size === 0) return payload
  for (const message of Array.isArray(payload.messages) ? payload.messages : []) {
    if (!isObject(message) || message.role !== "user" || !Array.isArray(message.content)) continue
    // A tool_result holding references can hold nothing else (the API refuses the mix), so the
    // loading call's own text follows the message's tool results, where the API takes text.
    const moved: Array<unknown> = []
    for (const block of message.content as Array<unknown>) {
      if (!isObject(block) || block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue
      const names = loads.get(block.tool_use_id)
      if (!names) continue
      const content: Array<unknown> =
        typeof block.content === "string"
          ? [{ type: "text", text: block.content }]
          : Array.isArray(block.content)
            ? (block.content as Array<unknown>)
            : []
      moved.push(
        ...content
          .filter((c) => isObject(c) && c.type === "text")
          .map((c) => ({ type: "text", text: (c as Json).text }))
      )
      block.content = names.map((name) => ({ type: "tool_reference", tool_name: name }))
    }
    if (moved.length === 0) continue
    const blocks = message.content as Array<unknown>
    const after = blocks.findLastIndex((b) => isObject(b) && b.type === "tool_result") + 1
    blocks.splice(after, 0, ...moved)
  }
  return payload
}

/** The heading the loaded definitions follow in a loading call's result. */
export const LOADED_DEFINITIONS = "Loaded tool definitions (call them by name):"

/**
 * OpenRouter Chat Completions to Claude on an upstream that defers natively (OpenRouter's tool
 * search guide, "Client-side tool search"): every deferred tool is declared on every request with
 * `function.defer_loading: true`, and the flags never change. A tool sent without its flag joins
 * Anthropic's tool prefix and rewrites the cache, and a `tool_reference` reaches the model only as
 * its name (both measured), so the loading call's result carries the loaded definitions as text
 * instead and the model calls the declared tools.
 */
export const applyRouterToolLoading = (payload: Json, loading: ToolLoadingRequest): Json => {
  const byName = new Map(loading.deferred.map((t) => [t.name, t]))
  const tools = Array.isArray(payload.tools) ? (payload.tools as Array<unknown>) : []
  let marker: unknown
  for (const tool of tools) {
    const fn = isObject(tool) && isObject(tool.function) ? tool.function : undefined
    if (!isObject(tool) || !fn || typeof fn.name !== "string" || !byName.has(fn.name)) continue
    fn.defer_loading = true
    // Anthropic refuses a cache marker on a deferred tool (measured through OpenRouter: a bare
    // "Provider returned error"), so pi-ai's marker on the last tool moves to the last immediate one.
    if (tool.cache_control !== undefined) {
      marker = tool.cache_control
      delete tool.cache_control
    }
  }
  if (marker !== undefined) {
    const last = tools.findLast((t) => isObject(t) && isObject(t.function) && t.function.defer_loading !== true)
    if (isObject(last)) last.cache_control = marker
  }
  if (loading.loads.length === 0) return payload
  const loads = new Map(loading.loads.map((l) => [l.toolCallId, l.names]))
  for (const message of Array.isArray(payload.messages) ? payload.messages : []) {
    if (!isObject(message) || message.role !== "tool" || typeof message.tool_call_id !== "string") continue
    const names = loads.get(message.tool_call_id) ?? loads.get(message.tool_call_id.split("|")[0] ?? "")
    if (!names) continue
    const definitions = names.flatMap((name) => {
      const tool = byName.get(name)
      return tool
        ? [JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters })]
        : []
    })
    if (definitions.length === 0) continue
    const text = `\n\n${LOADED_DEFINITIONS}\n${definitions.join("\n")}`
    if (typeof message.content === "string") message.content = `${message.content}${text}`
    else if (Array.isArray(message.content)) message.content.push({ type: "text", text })
  }
  return payload
}

/** pi-ai's Responses call id normalization (`call_id` is the part before `|`). */
export const responsesId = (id: string) =>
  (id.split("|")[0] ?? id)
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 64)
    .replace(/_+$/, "")

/**
 * OpenAI Responses (client-executed tool search, OpenAI's tool search guide): only immediate
 * tools are top-level; each load point is followed by a `tool_search_call` and its
 * `tool_search_output` carrying the loaded definitions with `defer_loading: true`. OpenAI puts
 * loaded tools at the end of the context, so the request's earlier items keep their bytes. A
 * replayed call to a loaded tool names its namespace (the tool's own name), which the endpoint
 * requires for a function outside the default namespace.
 */
export const applyResponsesToolLoading = (payload: Json, loading: ToolLoadingRequest): Json => {
  const byName = new Map(loading.deferred.map((t) => [t.name, t]))
  const deferred = new Set(byName.keys())
  // A deferred definition that reached the top level anyway is taken out: it travels at its load.
  if (Array.isArray(payload.tools))
    payload.tools = (payload.tools as Array<unknown>).filter(
      (t) => !(isObject(t) && typeof t.name === "string" && deferred.has(t.name))
    )
  const strict = (Array.isArray(payload.tools) ? (payload.tools as Array<unknown>) : []).find(
    (t): t is Json => isObject(t) && t.type === "function" && typeof t.strict === "boolean"
  )?.strict
  const loads = new Map(loading.loads.map((l) => [responsesId(l.toolCallId), l]))
  const loaded = new Set(loading.loads.flatMap((l) => l.names))
  const input = Array.isArray(payload.input) ? (payload.input as Array<unknown>) : []
  const out: Array<unknown> = []
  for (const item of input) {
    if (isObject(item) && item.type === "function_call" && typeof item.name === "string" && loaded.has(item.name))
      item.namespace ??= item.name
    out.push(item)
    if (!isObject(item) || item.type !== "function_call_output" || typeof item.call_id !== "string") continue
    const load = loads.get(item.call_id)
    if (!load) continue
    const callId = `rp_tool_load_${item.call_id}`.slice(0, 64)
    out.push(
      {
        type: "tool_search_call",
        call_id: callId,
        execution: "client",
        status: "completed",
        arguments: { query: load.names.join(" "), limit: load.names.length }
      },
      {
        type: "tool_search_output",
        call_id: callId,
        execution: "client",
        status: "completed",
        tools: load.names.flatMap((name) => {
          const tool = byName.get(name)
          return tool
            ? [
                {
                  type: "function",
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                  ...(strict !== undefined ? { strict } : {}),
                  defer_loading: true
                }
              ]
            : []
        })
      }
    )
  }
  payload.input = out
  return payload
}
