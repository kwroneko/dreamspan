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
