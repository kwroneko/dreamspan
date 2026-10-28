// What the Lorebooks tab lists under "Added to this chat" and "Global" (DESIGN §5.0), from the
// cast at the leaf shown, the books switched off while the tab is open and the user's globals.

export interface LorebookRow {
  readonly id: string
  /** Its switch: attached (added), or not turned off in this chat (global). */
  readonly on: boolean
  /** Also one of the user's global books. */
  readonly global: boolean
  /** Also added to this chat by hand. */
  readonly attached: boolean
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
  const added = [...input.attached, ...input.detached.filter((id) => !input.attached.includes(id))].filter(
    (id) => !globals.includes(id)
  )
  return {
    added: added.map((id): LorebookRow => ({ id, on: input.attached.includes(id), global: false, attached: true })),
    // A global book is listed once, here, even when it's also attached to this chat: attached,
    // it's used whatever the global switch says, so it's on while either holds.
    global: globals.map((id): LorebookRow => ({
      id,
      on: input.attached.includes(id) || !input.globalsOff.includes(id),
      global: true,
      attached: input.attached.includes(id)
    }))
  }
}
