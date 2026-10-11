// What macros read: the state at the position of the text being expanded (DESIGN §5.6).
// The caller builds it from the folded chat state, so expansion itself stays pure.

export interface MacroNames {
  /** `{{user}}`: the persona name, or the pinned binding (DESIGN §5.3). */
  readonly user: string
  /** `{{char}}`: the character name, or the pinned binding. */
  readonly char: string
}

export interface MacroContext {
  readonly names: MacroNames
}
