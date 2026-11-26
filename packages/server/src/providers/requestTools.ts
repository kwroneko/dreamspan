// Inspector projection of final provider payloads. A native deferred declaration counts once
// the request activates it. Responses and dispatchers carry it in the loading result itself.
import { createHash } from "node:crypto"
import { DISPATCH_DEFINITIONS } from "../agent/dispatcher.ts"
import { anthropicId, LOADED_DEFINITIONS, responsesId, type ToolLoadingRequest } from "./toolLoading.ts"

type Json = Record<string, unknown>
const object = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value)
const objects = (value: unknown): Array<Json> => (Array.isArray(value) ? value.filter(object) : [])

interface Definition {
  readonly name: string
  readonly description: string
  readonly parameters?: unknown
  readonly format?: unknown
}

export interface CapturedTool extends Definition {
  readonly loadedBy?: string
}

export interface CapturedRequestTools {
  readonly latest: string
  /** JSON strings preserve nulls inside schemas when the writer merges successive captures. */
  readonly definitions: Readonly<Record<string, string>>
  readonly attempts: Readonly<Record<string, ReadonlyArray<string>>>
}

const definition = (item: Json): Definition | undefined => {
  const custom = item.type === "custom"
  const fn = custom && object(item.custom) ? item.custom : object(item.function) ? item.function : item
  if (typeof fn.name !== "string") return undefined
  return {
    name: fn.name,
    description: typeof fn.description === "string" ? fn.description : "",
    ...(custom && fn.format !== undefined
      ? { format: fn.format }
      : { parameters: fn.parameters ?? fn.input_schema ?? fn.parametersJsonSchema ?? {} })
  }
}

export const toolText = (tool: Definition) =>
  JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters, format: tool.format })

const clean = (value: unknown, scrub: (text: string) => string): unknown => {
  if (typeof value === "string") return scrub(value)
  if (Array.isArray(value)) return value.map((entry) => clean(entry, scrub))
  if (object(value))
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [scrub(key), clean(entry, scrub)]))
  return value
}

export function captureRequestTools(
  payload: Json,
  requestId: string,
  loading: ToolLoadingRequest | undefined,
  scrub: (text: string) => string
): { declarations: CapturedRequestTools; extraMessageText: ReadonlyArray<string> } {
  const configured = object(payload.config) ? payload.config.tools : undefined
  const items = objects(payload.tools ?? configured).flatMap((item) =>
    item.functionDeclarations === undefined ? [item] : objects(item.functionDeclarations)
  )
  for (const item of objects(payload.input)) if (item.type === "additional_tools") items.push(...objects(item.tools))
  const messages = objects(payload.messages ?? payload.input ?? payload.contents)
  const itemsByCall = new Map(
    messages.flatMap((message) =>
      typeof message.tool_call_id === "string"
        ? [[message.tool_call_id, message] as const, [message.tool_call_id.split("|")[0]!, message] as const]
        : []
    )
  )
  const byName = new Map(loading?.deferred.map((tool) => [tool.name, tool]))
  const loaded = new Map<string, CapturedTool>()
  const extraMessageText: Array<string> = []
  for (const load of loading?.loads ?? []) {
    const loadedBy = load.loader ?? "a loading call"
    if (loading?.api === "anthropic-messages") {
      const result = messages
        .flatMap((message) => objects(message.content))
        .find((block) => block.type === "tool_result" && block.tool_use_id === anthropicId(load.toolCallId))
      for (const reference of objects(result?.content)) {
        const tool = typeof reference.tool_name === "string" ? byName.get(reference.tool_name) : undefined
        if (reference.type === "tool_reference" && tool) loaded.set(tool.name, { ...tool, loadedBy })
      }
    } else if (loading?.api === "openai-responses") {
      const output = messages.find(
        (item) =>
          item.type === "tool_search_output" &&
          item.call_id === `rp_tool_load_${responsesId(load.toolCallId)}`.slice(0, 64)
      )
      for (const item of objects(output?.tools)) {
        const tool = definition(item)
        if (tool) loaded.set(tool.name, { ...tool, loadedBy })
      }
    } else {
      const result = itemsByCall.get(load.toolCallId) ?? itemsByCall.get(load.toolCallId.split("|")[0]!)
      if (!result || result.role !== "tool") continue
      const content = textOf(result.content)
      const marker = "\n\n" + (loading?.api === "dispatcher" ? DISPATCH_DEFINITIONS : LOADED_DEFINITIONS) + "\n"
      const at = content.lastIndexOf(marker)
      if (at < 0) continue
      const definitions = new Set(content.slice(at + marker.length).split("\n"))
      for (const name of load.names) {
        const tool = byName.get(name)
        if (tool && definitions.has(toolText(tool))) loaded.set(name, { ...tool, loadedBy })
      }
      extraMessageText.push(content.slice(0, at))
      itemsByCall.delete(result.tool_call_id as string)
    }
  }

  const tools = items.flatMap((item) => {
    const tool = definition(item)
    if (!tool) return []
    if (item.defer_loading === true || (object(item.function) && item.function.defer_loading === true)) {
      const load = loaded.get(tool.name)
      if (!load) return []
      loaded.delete(tool.name)
      return [{ ...tool, loadedBy: load.loadedBy }]
    }
    return [tool]
  })
  tools.push(...loaded.values())

  const definitions: Record<string, string> = {}
  const order = tools.map((tool) => {
    const sanitized = JSON.stringify(clean(tool, scrub))
    const id = createHash("sha256").update(sanitized).digest("hex")
    definitions[id] = sanitized
    return id
  })
  // The message view already has ordinary text. Calls, results and replayed reasoning which
  // have their own place in Steps still contribute to the request's message count.
  for (const message of messages) {
    if (message.role === "tool" && itemsByCall.has(message.tool_call_id as string))
      extraMessageText.push(textOf(message.content))
    for (const call of objects(message.tool_calls))
      if (object(call.function)) extraMessageText.push(JSON.stringify(call.function))
    if (typeof message.reasoning_content === "string") extraMessageText.push(message.reasoning_content)
    if (message.type === "function_call") extraMessageText.push(JSON.stringify([message.name, message.arguments]))
    if (message.type === "function_call_output") extraMessageText.push(textOf(message.output))
    for (const block of objects(message.content)) {
      if (block.type === "tool_use") extraMessageText.push(JSON.stringify([block.name, block.input]))
      if (block.type === "tool_result") extraMessageText.push(textOf(block.content))
      if (block.type === "thinking" && typeof block.thinking === "string") extraMessageText.push(block.thinking)
    }
  }
  return {
    declarations: { latest: requestId, definitions, attempts: { [requestId]: order } },
    extraMessageText: extraMessageText.filter(Boolean).map(scrub)
  }
}

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : objects(content)
        .flatMap((item) => (typeof item.text === "string" ? [item.text] : []))
        .join("\n")
