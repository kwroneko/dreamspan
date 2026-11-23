// Whether a thinking panel's thinking goes to the model in later requests (owner, 2026-11-23):
// read from the next request's own decision (`NextContext.thinking`, the assembler's
// `reasoning-replay` stage), never worked out again here, so the panel can't disagree with
// what is sent. A reply still being written by a tool run keeps its thinking for the rest of
// the run unless the user left it out (spec/AGENTIC.md; thinkhide1).
import type { Version } from "@dreamspan/shared/chat.ts"
import type { ThinkingSendReason, ThinkingSends } from "@dreamspan/shared/thinkingSends.ts"

export interface ThinkingStatus {
  readonly sent: boolean
  /** Clicking flips the user's own choice; false when the settings keep it out anyway. */
  readonly toggles: boolean
  /** The state and why, then what a click does: the button's hover. */
  readonly hint: string
}

const WHY: Record<Exclude<ThinkingSendReason, "sent" | "hidden">, string> = {
  changed: "an earlier message changed since it was written, so the provider would refuse it",
  end: "this model takes it back only with everything before it unchanged, and the end-of-request text it was written after isn't kept in the chat",
  chain:
    "this model takes earlier reasoning only as an unbroken run, and a later reply's reasoning that followed it isn't sent",
  model: "another model or connection wrote it, so this one can't use it",
  provider: "this provider doesn't take earlier replies' reasoning",
  ignored: "this provider ignores earlier replies' reasoning",
  unrecorded: "there's nothing from the provider to send: it was edited, continued, imported or written in a tool run",
  merged: "its message is joined with others in the request"
}

const replies = (n: number) => (n === 1 ? "the last reply" : `the last ${n} replies`)

export const thinkingStatus = (input: {
  readonly version: Version
  readonly kind: "reasoning" | "sections"
  readonly hidden: boolean
  readonly streaming: boolean
  readonly sends: ThinkingSends | null | undefined
}): ThinkingStatus => {
  const { version, kind, hidden, streaming, sends } = input
  const what = kind === "reasoning" ? "reasoning" : "thinking"
  const flip = " Click to flip it, for this thinking only."
  if (streaming && version.agent)
    return hidden
      ? { sent: false, toggles: true, hint: `Not sent: you left it out after this tool turn.${flip}` }
      : { sent: true, toggles: true, hint: `Sent for the rest of this tool run.${flip}` }
  const item = sends?.items.find((i) => i.versionId === version.id && i.part === kind)
  if (hidden || item?.reason === "hidden")
    return {
      sent: false,
      toggles: true,
      hint: `Not sent: you left it out of later requests. Click to send it where the preset allows, for this thinking only.`
    }
  if (item?.sent) {
    const n = kind === "reasoning" ? sends!.reasoning : sends!.sections
    return {
      sent: true,
      toggles: true,
      hint: `Sent with the next replies: it's within ${replies(n)} the preset sends back.${flip}`
    }
  }
  if (item) return { sent: false, toggles: false, hint: `Not sent: ${WHY[item.reason as keyof typeof WHY]}.` }
  if (streaming) return { sent: false, toggles: false, hint: "Not sent yet: known once the reply is finished." }
  const n = kind === "reasoning" ? (sends?.reasoning ?? 0) : (sends?.sections ?? 0)
  if (n === 0)
    return {
      sent: false,
      toggles: false,
      hint:
        kind === "reasoning"
          ? "Not sent: the preset sends no provider reasoning back."
          : "Not sent: the preset sends no tagged thinking back."
    }
  if (kind === "reasoning" && sends?.toolRun)
    return {
      sent: false,
      toggles: false,
      hint: "Not sent: the next reply is a tool run, which starts from the replies' text."
    }
  const whose = n === 1 ? "the last reply's" : `the last ${n} replies'`
  return { sent: false, toggles: false, hint: `Not sent: the preset sends back only ${whose} ${what}.` }
}
