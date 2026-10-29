// What macros read: the state at the position of the text being expanded (DESIGN §5.6).
// The caller builds it from the folded chat state, so expansion itself stays pure.
import type { VariableValues } from "./variables.ts"

interface MacroNames {
  /** `{{user}}`: the persona name, or the pinned binding (DESIGN §5.3). */
  readonly user: string
  /** `{{char}}`: the character name, or the pinned binding. */
  readonly char: string
  /** `{{group}}`: every member, muted ones included. ST's default in a one-to-one chat: `char`. */
  readonly group?: string
  /** `{{groupNotMuted}}`. Default: `char`. */
  readonly groupNotMuted?: string
  /** `{{notChar}}`: everyone but the speaker, the user included. Default: `user`. */
  readonly notChar?: string
}

/**
 * The card's fields as stored, macros unresolved: they're expanded where they're used,
 * like ST's baseChatReplace. Absent fields read as empty.
 */
export interface CardFields {
  readonly description?: string
  readonly personality?: string
  readonly scenario?: string
  /** The persona's description: `{{persona}}`. */
  readonly persona?: string
  readonly mesExamples?: string
  /** The card's main prompt override: `{{charPrompt}}`. */
  readonly systemPrompt?: string
  /** The card's post-history instructions: `{{charInstruction}}`. */
  readonly postHistoryInstructions?: string
  /** The depth note: `{{charDepthPrompt}}`. */
  readonly depthPrompt?: string
  readonly creatorNotes?: string
  /** Used as is, unexpanded, as in ST. */
  readonly version?: string
  readonly firstMessage?: string
  readonly alternateGreetings?: ReadonlyArray<string>
  /**
   * Every character's field joined as the per-field markers fill it (ST's group join), already
   * expanded: `{{description}}`, `{{personality}}` and `{{scenario}}` read these as they are.
   */
  readonly joined?: {
    readonly description: string
    readonly personality: string
    readonly scenario: string
  }
}

export interface ChatMessage {
  readonly text: string
  readonly fromUser: boolean
  /** ST's system messages, which the last-message macros skip. */
  readonly system?: boolean
  /** Epoch milliseconds, for `{{idle_duration}}`. */
  readonly sentAt?: number
  /** For `{{lastSwipeId}}` and `{{currentSwipeId}}`: the number of versions, and the selected one (0-based). */
  readonly versions?: number
  readonly selectedVersion?: number
}

export interface MacroContext {
  readonly names: MacroNames
  /**
   * The chat's variables (`vars` in the chat state) and the global ones, as they were before
   * this text: for a message, before its own `var.set` events.
   */
  readonly variables?: VariableValues
  readonly card?: CardFields
  /** ST's collapse_newlines applies to expanded card fields, including field macros. */
  readonly collapseNewlines?: boolean
  /** The messages before the text's position, oldest first, as resolved text (never expanded again). */
  readonly messages?: ReadonlyArray<ChatMessage>
  readonly firstIncludedMessageId?: number
  readonly firstDisplayedMessageId?: number
  /** Epoch milliseconds and an IANA time zone, for the time macros. */
  readonly now: number
  readonly timeZone: string
  readonly model?: string
  /** The composer's text: `{{input}}`. */
  readonly input?: string
  /** The text a character's prompt override replaces: `{{original}}`, once. */
  readonly original?: string
  /** Who the model writes as in this generation (its in-chat name): `{{speaker}}` (DESIGN §2.2). */
  readonly speaker?: string
  /** The generation's one-turn direction, verbatim: `{{direction}}` (DESIGN §2.2). */
  readonly direction?: string
  /** The chat's summary, as ST's Summarize extension keeps it: `{{summary}}`. */
  readonly summary?: string
  /** World-info outlets by key: `{{outlet::key}}`. */
  readonly outlets?: Readonly<Record<string, string>>
  readonly maxContextTokens?: number
  readonly maxResponseTokens?: number
  readonly lastGenerationType?: string
  readonly isMobile?: boolean
  /** Seeds `{{pick}}` with the chat, as ST seeds it with the chat id. */
  readonly pickSeed?: string
}
