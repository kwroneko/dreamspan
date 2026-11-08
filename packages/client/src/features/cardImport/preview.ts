// What "Import a new version…" will do, worked out from the preview before anything is
// stored: the fields that change, and, in words, what's kept from the card and what's
// replaced. The server writes the same document (`replacementDoc`, @rp/shared/cardReplace.ts).
import { type CardReplacePreview, PICTURE_FIELDS, replacementDoc } from "@rp/shared/cardReplace.ts"
import { canonicalJson } from "@rp/shared/editing.ts"
import type { Doc } from "@rp/shared/library.ts"
import { changedFields, type FieldChange, fieldLabel } from "../editor/fields.ts"

type PictureChange =
  /** The file has none: the card keeps its own. */
  | { readonly _tag: "Kept" }
  | { readonly _tag: "Same" }
  | {
      readonly _tag: "New"
      /** The card's picture's media id. */
      readonly before: string | null
      /** The file's picture, its type and bytes as base64; null when the server didn't send it. */
      readonly after: { readonly mime: string; readonly base64: string } | null
    }

export interface VersionPlan {
  readonly changes: ReadonlyArray<FieldChange & { readonly label: string }>
  readonly picture: PictureChange
  /** What stays as the card has it, a sentence each. */
  readonly kept: ReadonlyArray<string>
  /** What the file's version brings that the user might not expect, a sentence each. */
  readonly notes: ReadonlyArray<string>
  readonly following: number
  readonly pinned: number
  readonly revisionNumber: number
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

const noteContent = (json: string | null) => {
  if (json === null) return null
  const doc = JSON.parse(json) as { content?: unknown }
  return typeof doc.content === "string" ? doc.content : null
}

const hasScripts = (doc: Doc) => Array.isArray(doc.regex) && doc.regex.length > 0

export const versionPlan = (
  preview: CardReplacePreview & { card: NonNullable<CardReplacePreview["card"]> }
): VersionPlan => {
  const card = preview.card
  const current = JSON.parse(card.docJson) as Doc
  const file = JSON.parse(preview.docJson ?? "{}") as Doc
  const samePicture = preview.avatar === null || preview.avatar.sha256 === card.avatarSha256
  // The id the stored file will have isn't known yet; only whether it's the card's own matters.
  const after = replacementDoc(current, {
    ...file,
    avatar_media_id: samePicture ? current.avatar_media_id : "the file's picture"
  })
  const changes = changedFields(current, after)
    .filter((change) => !PICTURE_FIELDS.has(String(change.path[0])))
    .map((change) => ({ ...change, label: fieldLabel("card", after, change.path, current) }))
  const picture: PictureChange =
    preview.avatar === null
      ? { _tag: "Kept" }
      : samePicture
        ? { _tag: "Same" }
        : {
            _tag: "New",
            before: typeof current.avatar_media_id === "string" ? current.avatar_media_id : null,
            after: preview.avatar.base64 === null ? null : { mime: preview.avatar.mime, base64: preview.avatar.base64 }
          }

  const kept: Array<string> = []
  const notes: Array<string> = []
  if (picture._tag === "Kept" && typeof current.avatar_media_id === "string")
    kept.push("Its picture: the file has none.")
  if (picture._tag !== "New" && current.avatar_crop !== undefined) kept.push("The portrait cutout you chose.")
  if (picture._tag === "New")
    notes.push("The file's picture replaces the card's, with the file's own cutout or the default one.")
  kept.push(card.favourite ? "It stays a favourite." : "It stays out of your favourites.")
  kept.push("Its notes, as they are.")
  const fileNote = noteContent(preview.noteDocJson)
  if (fileNote !== null && fileNote !== (card.noteContent ?? ""))
    notes.push(
      "The file carries a Character's Note that differs from the card's note. It isn't applied: the card's notes stay as they are."
    )
  if (preview.otherNotes > 0)
    notes.push(`The file also carries ${plural(preview.otherNotes, "other note")}, which aren't applied either.`)
  if (current.regex_approved === true && after.regex_approved === true)
    kept.push("Permission to run its regex scripts: the file's scripts are the same ones.")
  else if (current.regex_approved === true)
    notes.push("The file's regex scripts differ, so they won't run until you allow them again.")
  else if (hasScripts(after) && canonicalJson(after.regex) !== canonicalJson(current.regex))
    notes.push("The file's regex scripts won't run until you allow them.")
  if (current.html_scripts_approved === true)
    kept.push(
      current.html_network_approved === true
        ? "Permission to run its panels' scripts and let them use the internet."
        : "Permission to run its panels' scripts."
    )
  kept.push("Which chats it's in.")
  if (!card.hasImport)
    notes.push("This card wasn't imported from a file: this one becomes the file its later versions update from.")
  return {
    changes,
    picture,
    kept,
    notes,
    following: card.followingChats,
    pinned: card.pinnedChats,
    revisionNumber: card.revisionNumber
  }
}

/** The chats' line: who reads the new version and who keeps theirs. */
export const chatsLine = (plan: Pick<VersionPlan, "following" | "pinned">) => {
  const following =
    plan.following === 0
      ? "No chat follows this card yet."
      : `${plural(plan.following, "chat follows", "chats follow")} this card and ${plan.following === 1 ? "uses" : "use"} the new version from then on; earlier messages stay as they were written.`
  const pinned =
    plan.pinned === 0
      ? ""
      : ` ${plural(plan.pinned, "chat is", "chats are")} on a fixed revision and ${plan.pinned === 1 ? "keeps it" : "keep theirs"}.`
  return following + pinned
}
