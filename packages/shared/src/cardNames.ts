import type { Doc, LibraryRef } from "./library.ts"

const text = (value: unknown) => (typeof value === "string" ? value : "")

/** CCv3: nickname replaces {{char}}, falling back to name only when empty. */
export const modelName = (doc: { readonly name: string; readonly nickname?: string | undefined }) =>
  doc.nickname || doc.name

export const cardNames = (doc: Doc) => ({
  displayName: text(doc.name),
  modelName: modelName({ name: text(doc.name), nickname: text(doc.nickname) }),
  version: text(doc.character_version)
})

/** Imports may collide. Only a new name/version pair needs checking against other refs. */
export const cardNameClash = (
  refs: ReadonlyArray<Pick<LibraryRef, "id" | "label" | "subtitle">>,
  name: string,
  version: string,
  current?: Pick<LibraryRef, "id" | "label" | "subtitle">
): string | null => {
  if (current && name === current.label && version === current.subtitle) return null
  return refs.some((ref) => ref.id !== current?.id && ref.label === name && ref.subtitle === version)
    ? `Another card is already called ${name}${version ? ` · ${version}` : ""}: change the display name or the version`
    : null
}

/**
 * What a change of a card's names asks right where it's confirmed (owner, 2026-11-01). Only a
 * change of the name chats use (the nickname, else the display name) asks anything:
 * - `history`: replace the old chat name with the new one in past messages (No, this chat, or
 *   all its chats): the nickname changed, was set for the first time to something other than
 *   the display name, or was cleared while the display name differs.
 * - `display`: the display name changed with no nickname: keep the old name in chats (it becomes
 *   the nickname, history untouched), rename everywhere (replace in history), or just change it.
 * A display name changed while a nickname is set asks nothing: chats keep the nickname.
 */
export interface RenameQuestion {
  readonly kind: "history" | "display"
  readonly oldName: string
  readonly newName: string
}

export const renameQuestion = (
  before: { readonly name: string; readonly nickname: string },
  after: { readonly name: string; readonly nickname: string }
): RenameQuestion | null => {
  const oldName = modelName(before)
  const newName = modelName(after)
  if (oldName === newName || oldName === "" || newName === "") return null
  const display = before.nickname === "" && after.nickname === "" && before.name !== after.name
  return { kind: display ? "display" : "history", oldName, newName }
}
