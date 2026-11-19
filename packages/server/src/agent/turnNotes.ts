// Lines a workshop turn tells the model at its tail, after the workshop instructions
// (spec/FILES-AND-ENVIRONMENT.md §2.1: "Working folder: /files/thesis"). They go in the
// end-of-request message, never the system prompt, so a change never moves the cached prefix.
// Registered, so a feature (or a plugin) adds, replaces or disables its own line.
import type { Effect } from "effect"
import type { ChatState } from "@dreamspan/shared/state.ts"

interface TurnNoteInput {
  readonly userId: string
  readonly chatId: string
  readonly kind: string
  /** The branch's state before the reply (causal order). */
  readonly state: ChatState
  /** The tools this turn offers. */
  readonly offered: ReadonlyArray<string>
}

export interface TurnNote {
  readonly id: string
  /** Its line, or null when it has nothing to say this turn. Never fails the turn. */
  readonly line: (input: TurnNoteInput) => Effect.Effect<string | null>
}
