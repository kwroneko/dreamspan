// Which replies' thinking the next request sends back (owner, 2026-11-23): the assembler's own
// decision, recorded as it builds the request, so a thinking panel's "Sent to the model" can
// never disagree with what is sent. Only the replies within the preset's last N are listed;
// one not listed is outside them (or the preset sends none).
import { Schema } from "effect"
import { ThinkingPart, VersionId } from "./chat.ts"

/**
 * Why a reply's thinking is or isn't in the next request:
 * - `sent`: within the last N, and the provider takes it;
 * - `hidden`: the user left it out (SetThinkingHidden);
 * - `changed`: something before it changed since it was written, so the provider would refuse
 *   its signature (an earlier one changed, for every one after it too);
 * - `model`: written by another model or connection, whose signature this one refuses;
 * - `provider`: this provider doesn't take earlier replies' reasoning;
 * - `ignored`: this provider takes it but ignores it, so it isn't sent;
 * - `unrecorded`: no provider record to send: edited, continued, imported or written in a tool run;
 * - `merged`: its message is joined with others in the request, so it can't carry it.
 */
export const ThinkingSendReason = Schema.Literals([
  "sent",
  "hidden",
  "changed",
  "model",
  "provider",
  "ignored",
  "unrecorded",
  "merged"
])
export type ThinkingSendReason = typeof ThinkingSendReason.Type

export const ThinkingSend = Schema.Struct({
  versionId: VersionId,
  part: ThinkingPart,
  sent: Schema.Boolean,
  reason: ThinkingSendReason
})
export type ThinkingSend = typeof ThinkingSend.Type

export const ThinkingSends = Schema.Struct({
  /** The preset's last N for tagged thinking and for the provider's reasoning, as this request used them. */
  sections: Schema.Int,
  reasoning: Schema.Int,
  /** The next reply is a tool run: it starts from the replies' text, so no reasoning is sent back. */
  toolRun: Schema.optionalKey(Schema.Boolean),
  items: Schema.Array(ThinkingSend)
})
export type ThinkingSends = typeof ThinkingSends.Type
