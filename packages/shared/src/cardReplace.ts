// Replacing a card with a new version of its file (ARCHITECTURE.md §11.1, "Import a new
// version…"): the file's content becomes the card's next revision, wholesale, keeping only
// what a file can't carry. The server writes it with this, and the client's preview shows
// the same result before anything is stored.
import { Schema } from "effect"
import { keepsRegexApproval, withoutGrantedAgentEdits } from "./editing.ts"
import { ImportReport } from "./importReport.ts"
import { type Doc, RevisionId } from "./library.ts"

/**
 * The card a file replaces wholesale: the file's document (`file`, with the media the import
 * gives it: its own avatar, or the card's when it has none) and, from the card here, what a
 * file can't carry:
 * - the portrait cutout, while the picture is the same one (a new picture starts from the
 *   file's own cutout or the default, as on import, §14.5c);
 * - the permission to run its regex scripts, only if the file's scripts are the same ones
 *   (a file never grants capabilities, DESIGN §11);
 * - the agent's permission to edit a module stays off where it was off.
 */
export const replacementDoc = (current: Doc, file: Doc): Doc => {
  let next = withoutGrantedAgentEdits("card", current, file)
  if (next.avatar_media_id === current.avatar_media_id) {
    const { avatar_crop: _, ...rest } = next
    next = current.avatar_crop === undefined ? rest : { ...rest, avatar_crop: current.avatar_crop }
  }
  if (keepsRegexApproval(current, { ...next, regex_approved: true })) next = { ...next, regex_approved: true }
  else if (next.regex_approved === true) next = { ...next, regex_approved: false }
  return next
}

/** The fields the picture is: the preview shows them as images, never as a diff of ids. */
export const PICTURE_FIELDS: ReadonlySet<string> = new Set(["avatar_media_id", "avatar_crop", "asset_media_ids"])

/** The card as it is now, for the preview: read in a reader worker (`CardReplaceSource`). */
export class CardReplaceSource extends Schema.Class<CardReplaceSource>("CardReplaceSource")({
  /** The head a Replace must still find, or it's refused as changed meanwhile. */
  headRevisionId: RevisionId,
  /** Its number in History (`revisionNumber`): restoring it undoes a Replace. */
  revisionNumber: Schema.Int,
  docJson: Schema.String,
  /** The SHA-256 of the card's picture, to tell whether the file's is the same one. */
  avatarSha256: Schema.NullOr(Schema.String),
  /** The text of the card's first note, the one ST's Character's Note maps to. */
  noteContent: Schema.NullOr(Schema.String),
  /** The user's live chats that use the card's latest revision: they read the new version. */
  followingChats: Schema.Int,
  /** The user's live chats bound to a fixed revision of it where they stand: they keep it. */
  pinnedChats: Schema.Int,
  /** Whether the card was imported from a file before; if not, this file starts its import line. */
  hasImport: Schema.Boolean,
  favourite: Schema.Boolean
}) {}

/** The file's picture, so the preview can show it beside the card's before anything is stored. */
const PreviewAvatar = Schema.Struct({
  sha256: Schema.String,
  mime: Schema.String,
  /**
   * The image's bytes as base64, which the client shows through a `blob:` URL (the page's CSP
   * allows no `data:` images); null for a picture too large to send back, or not an image type
   * the browser is shown.
   */
  base64: Schema.NullOr(Schema.String)
})

/** `POST /library/import?mode=preview`: the parsed file and the card, nothing stored. */
export class CardReplacePreview extends Schema.Class<CardReplacePreview>("CardReplacePreview")({
  report: ImportReport,
  /** The file's card document as JSON, without media ids (nothing was stored); null: not importable. */
  docJson: Schema.NullOr(Schema.String),
  /** ST's Character's Note the file carries, as a note document's JSON. */
  noteDocJson: Schema.NullOr(Schema.String),
  /** The file's other notes (an export of ours carries them), which a Replace doesn't apply either. */
  otherNotes: Schema.Int,
  avatar: Schema.NullOr(PreviewAvatar),
  /** Embedded files (CHARX assets) the file holds. */
  assets: Schema.Int,
  card: Schema.NullOr(CardReplaceSource)
}) {}
