// The end-of-request instruction (DESIGN §2.2, owner 2026-10-29, provisional): who writes next
// and the one-turn direction, always the request's last message, one user message. Its three
// texts are prompts of the preset with fixed identifiers, so layering, merging, versioning and
// export treat them as any prompt, but they're never in the prompt order.

/** Sent when the model writes as a card the user doesn't play (ST's group nudge imports here). */
export const GROUP_NUDGE = "groupNudge"
/** Sent when the model writes as a card the user plays (ST's impersonation prompt imports here). */
export const IMPERSONATION_PROMPT = "impersonationPrompt"
/** Added after the turn text when the version has a direction. ST has no such field. */
export const DIRECTION_PROMPT = "directionPrompt"

/**
 * The defaults. Each text closes its own bracket, so the turn text stands alone when there's
 * no direction (DESIGN's literal defaults split one bracket across the two).
 */
export const TURN_TEXT = "[Write {{speaker}}'s next message. Write only for {{speaker}}.]"
export const DIRECTION_TEXT = "[What happens next: {{direction}}]"

/**
 * The one fallback: the request would end on an assistant message, no prefill is sent, and
 * the end-of-request texts are empty.
 */
export const FALLBACK_TEXT = "[Write {{speaker}}'s next message.]"

interface EndOfRequestText {
  readonly identifier: string
  /** The editor's label; the inspector names a piece "End of request: <label>". */
  readonly label: string
  /** When it's sent, under the editor's field. */
  readonly hint: string
  readonly content: string
}

export const END_OF_REQUEST: ReadonlyArray<EndOfRequestText> = [
  {
    identifier: GROUP_NUDGE,
    label: "When a character speaks",
    hint: "Sent last when the model writes as a card you don't play.",
    content: TURN_TEXT
  },
  {
    identifier: IMPERSONATION_PROMPT,
    label: "When your card speaks",
    hint: "Sent last instead when the model writes as a card you play.",
    content: TURN_TEXT
  },
  {
    identifier: DIRECTION_PROMPT,
    label: "When you give a direction",
    hint: "Sent on a new line after the turn text when you give a direction; {{direction}} is your text.",
    content: DIRECTION_TEXT
  }
]

const byIdentifier = new Map(END_OF_REQUEST.map((text) => [text.identifier, text]))

/** One of the end-of-request texts, by its prompt identifier. */
export const endOfRequestText = (identifier: string): EndOfRequestText | undefined => byIdentifier.get(identifier)
