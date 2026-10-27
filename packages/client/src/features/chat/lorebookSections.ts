// What the Lorebooks tab lists under "Added to this chat" and "Global" (DESIGN §5.0), from the
// cast at the leaf shown, the books switched off while the tab is open and the user's globals.

export interface LorebookRow {
  readonly id: string
  /** Its switch: attached (added), or not turned off in this chat (global). */
  readonly on: boolean
  /** Also one of the user's global books. */
  readonly global: boolean
}

export const lorebookSections = (input: {
  readonly attached: ReadonlyArray<string>
  /** Detached while the tab is open: still listed, off, so the switch can bring them back. */
  readonly detached: ReadonlyArray<string>
  /** Null until read. */
  readonly globals: ReadonlyArray<string> | null
  readonly globalsOff: ReadonlyArray<string>
}) => {
  const globals = input.globals ?? []
  const added = [...input.attached, ...input.detached.filter((id) => !input.attached.includes(id))]
  return {
    added: added.map((id): LorebookRow => ({ id, on: input.attached.includes(id), global: globals.includes(id) })),
    // A global book attached here is listed once, with the books added to this chat.
    global: globals
      .filter((id) => !input.attached.includes(id))
      .map((id): LorebookRow => ({ id, on: !input.globalsOff.includes(id), global: true }))
  }
}
