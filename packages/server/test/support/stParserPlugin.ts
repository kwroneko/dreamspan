// Synthetic trusted plugin exports, loaded by URL in both source and bundled workers.
import { isMainThread } from "node:worker_threads"
import { Effect } from "effect"
import { builtinParsers, type StParsers } from "../../src/importer/stParse.ts"

export const chatPart: StParsers["chat-part"] = (input) => {
  if (isMainThread) throw new Error("plugin parser ran on the main thread")
  return Effect.map(builtinParsers["chat-part"](input), (part) => Object.assign(part, { messages: 7 }))
}

export const settings: StParsers["settings"] = (bytes) => {
  if (isMainThread) throw new Error("plugin parser ran on the main thread")
  return Effect.map(builtinParsers.settings(bytes), (parsed) => ({
    ...parsed,
    settings: parsed.settings && Object.assign(parsed.settings, { selectedPreset: "Plugin preset" })
  }))
}

export const crash: StParsers["chat-part"] = () => {
  if (isMainThread) throw new Error("plugin parser ran on the main thread")
  return Effect.sync(() => process.exit(1))
}

/** Reference path for database parity: plugins may omit the optional prefix hashes. */
export const positionalChatPart: StParsers["chat-part"] = (input) =>
  Effect.map(builtinParsers["chat-part"](input), (part) =>
    Object.assign(part, {
      batches: part.batches.map(({ messagesJson, speakers }) => ({ messagesJson, speakers }))
    })
  )
