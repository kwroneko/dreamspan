// What a panel's frame may say to the app (spec/HTML-MESSAGES.md §3.4, "The bridge", Tier A), and
// all it may say: each message type has a schema, anything else is dropped. Nothing here reads
// or writes the app's data. Opening a link and copying need the user's click in the frame,
// checked in the bootstrap with a captured native getter, and again in the parent
// (DocumentFrame.tsx). Ancestor activation alone cannot authorize a panel action.
import { Option, Schema } from "effect"

/** At most this many characters copied from a panel, and this long a link. */
export const MAX_BRIDGE_COPY = 100_000
const MAX_BRIDGE_URL = 4096

// Generated privately by the bootstrap before any panel script runs. A token-bearing
// action can only come through its helpers, which check the frame's own native activation.
const Token = Schema.String.check(Schema.isMinLength(32), Schema.isMaxLength(32))
const Ready = Schema.Struct({ type: Schema.Literal("rp:ready"), token: Token })
const Height = Schema.Struct({ type: Schema.Literal("rp:height"), height: Schema.Finite })
const Open = Schema.Struct({
  type: Schema.Literal("rp:open"),
  token: Token,
  url: Schema.String.check(Schema.isMaxLength(MAX_BRIDGE_URL))
})
const Copy = Schema.Struct({
  type: Schema.Literal("rp:copy"),
  token: Token,
  text: Schema.String.check(Schema.isMaxLength(MAX_BRIDGE_COPY))
})
const BridgeMessage = Schema.Union([Ready, Height, Open, Copy])
export type BridgeMessage = typeof BridgeMessage.Type

const decode = Schema.decodeUnknownOption(BridgeMessage)

/** The frame's message, when it's one of the bridge's; null otherwise (dropped). */
export const parseBridgeMessage = (data: unknown): BridgeMessage | null => Option.getOrNull(decode(data))

/** A link a panel may ask to open: `http(s)` only, as an absolute URL. */
export const bridgeLink = (url: string): string | null => {
  const parsed = URL.parse(url)
  return parsed !== null && (parsed.protocol === "https:" || parsed.protocol === "http:") ? parsed.href : null
}
