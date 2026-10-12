// ST's chat and time macros (public/scripts/macros/definitions/chat-macros.js and
// time-macros.js at 06bde939), over the messages and clock in the context.
import type { ChatMessage } from "../context.ts"
import type { MacroCall, MacroSpec } from "../registry.ts"
import { atOffset, formatMoment, humanize, inZone, MAX_FORMAT_GROWTH, parseMoment } from "../time.ts"

/** The last message passing the filter. Each message looked at costs work. */
const lastIndex = (call: MacroCall, filter?: (message: ChatMessage) => boolean) => {
  const messages = call.context.messages ?? []
  let i = messages.length - 1
  while (i >= 0 && filter && !filter(messages[i]!)) i--
  call.charge(messages.length - i)
  return i >= 0 ? i : undefined
}

const lastText = (call: MacroCall, filter?: (message: ChatMessage) => boolean) => {
  const i = lastIndex(call, filter)
  return i === undefined ? "" : call.context.messages![i]!.text
}

const optional = (value: number | undefined) => (value === undefined ? "" : String(value))

const now = (call: MacroCall, format: string) => formatMoment(inZone(call.context.now, call.context.timeZone), format)

/** The time since the user's last message before the latest one, as ST measures it. */
const idleDuration = (call: MacroCall) => {
  const messages = call.context.messages ?? []
  let takeNext = false
  call.charge(messages.length)
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.system) continue
    if (message.fromUser && takeNext)
      return message.sentAt ? humanize(call.context.now - message.sentAt, false) : "just now"
    takeNext = true
  }
  return "just now"
}

export const chatMacros: ReadonlyArray<MacroSpec> = [
  { name: "lastMessage", handler: (call) => lastText(call) },
  { name: "lastMessageId", handler: (call) => optional(lastIndex(call)) },
  { name: "lastUserMessage", handler: (call) => lastText(call, (m) => m.fromUser && !m.system) },
  { name: "lastCharMessage", handler: (call) => lastText(call, (m) => !m.fromUser && !m.system) },
  { name: "firstIncludedMessageId", handler: (call) => optional(call.context.firstIncludedMessageId) },
  { name: "firstDisplayedMessageId", handler: (call) => optional(call.context.firstDisplayedMessageId) },
  {
    name: "lastSwipeId",
    handler: (call) => {
      const i = lastIndex(call)
      return optional(i === undefined ? undefined : call.context.messages![i]!.versions)
    }
  },
  {
    name: "currentSwipeId",
    handler: (call) => {
      const i = lastIndex(call)
      const selected = i === undefined ? undefined : call.context.messages![i]!.selectedVersion
      return optional(selected === undefined ? undefined : selected + 1)
    }
  },
  {
    name: "allChatRange",
    handler: (call) => {
      const length = call.context.messages?.length ?? 0
      return length === 0 ? "" : `0-${length - 1}`
    }
  },
  {
    name: "time",
    volatile: "clock",
    args: [{ name: "offset", optional: true }],
    handler: (call) => {
      const m = /^UTC([+-]\d+)$/.exec(call.args[0] ?? "")
      return m ? formatMoment(atOffset(call.context.now, Number.parseInt(m[1]!, 10)), "LT") : now(call, "LT")
    }
  },
  { name: "date", volatile: "clock", handler: (call) => now(call, "LL") },
  { name: "weekday", volatile: "clock", handler: (call) => now(call, "dddd") },
  { name: "isotime", volatile: "clock", handler: (call) => now(call, "HH:mm") },
  { name: "isodate", volatile: "clock", handler: (call) => now(call, "YYYY-MM-DD") },
  {
    name: "datetimeformat",
    args: [{ name: "format" }],
    volatile: "clock",
    handler: (call) => {
      call.charge(call.args[0]!.length * MAX_FORMAT_GROWTH)
      return now(call, call.args[0]!)
    }
  },
  { name: "idleDuration", aliases: ["idle_duration"], volatile: "clock", handler: idleDuration },
  {
    name: "timeDiff",
    args: [{ name: "left" }, { name: "right" }],
    handler: (call) => humanize(parseMoment(call.args[0]!) - parseMoment(call.args[1]!), true)
  }
]
