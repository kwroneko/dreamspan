// What a panel's frame may say to the app (spec/HTML-MESSAGES.md §3.4, "The bridge", Tier A), and
// all it may say: each message type has a schema, anything else is dropped. Nothing here reads
// or writes the app's data. Opening a link and copying need the user's click in the frame,
// which the parent checks when the message arrives (DocumentFrame.tsx).
import { Option, Schema } from "effect"

/** At most this many characters copied from a panel, and this long a link. */
export const MAX_BRIDGE_COPY = 100_000
const MAX_BRIDGE_URL = 4096

const Ready = Schema.Struct({ type: Schema.Literal("rp:ready") })
const Height = Schema.Struct({ type: Schema.Literal("rp:height"), height: Schema.Finite })
const Open = Schema.Struct({
  type: Schema.Literal("rp:open"),
  url: Schema.String.check(Schema.isMaxLength(MAX_BRIDGE_URL))
})
const Copy = Schema.Struct({
  type: Schema.Literal("rp:copy"),
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
