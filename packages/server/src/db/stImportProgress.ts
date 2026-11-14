// What an ST chat file's import keeps as its batches are written, and where its state goes
// once they're in (ARCHITECTURE.md §13). Pure, and one code path for both writers of a chat
// file: the import that writes batch by batch (`StImports.writeBatch`, `finishChat`) and the
// confirmed re-import that writes a whole file in one transaction (`StImportCommitChat`).
import { createHash } from "node:crypto"
import type { EntityId, SlotId } from "@rp/shared/chat.ts"
import type { RefId } from "@rp/shared/library.ts"
import type { StImportNote } from "./ops.ts"

/** The hash a chat file's mapped state keeps of a value (stMapping.ts `chatStateChange`). */
export const stStateHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")

/**
 * The slot of the file's message `index`, before it's written: what a confirmed re-import's
 * finish names a slot by, as its writes happen only in the transaction that resolves them
 * (`resolveStSlot`).
 */
export const stIndexSlot = (index: number) => `st-index:${index}` as SlotId

/** The slot `stIndexSlot` stands for, given the file's slots in order. Others are as they are. */
const resolveStSlot = (slot: SlotId, slotIds: ReadonlyArray<SlotId>): SlotId => {
  if (!slot.startsWith("st-index:")) return slot
  const resolved = slotIds[Number(slot.slice("st-index:".length))]
  if (resolved === undefined) throw new Error(`no slot for ${slot}`)
  return resolved
}

/** A summary note with the slots it names resolved, its keys in the same order. */
export const resolveStNote = (note: StImportNote, slotIds: ReadonlyArray<SlotId>): StImportNote => ({
  ...note,
  ...(note.sources === undefined
    ? {}
    : { sources: note.sources.map((slot) => (slot === null ? null : resolveStSlot(slot, slotIds))) }),
  ...(note.covers === undefined
    ? {}
    : {
        covers: {
          ...note.covers,
          first_slot_id: resolveStSlot(note.covers.first_slot_id, slotIds),
          last_slot_id: resolveStSlot(note.covers.last_slot_id, slotIds)
        }
      })
})

/** One parsed batch a confirmed re-import holds until its file is written (`StImportStage`). */
export interface StStagedBatch {
  readonly messagesJson: string
  readonly hashes?: ReadonlyArray<string>
  readonly speakers: Readonly<Record<string, EntityId | null>>
  readonly arrivalRefs?: Readonly<Record<string, RefId>>
}

/** The part of a chat file's progress its writes move. */
export interface StWriteProgress {
  /** The first slot this run added, and the first past `prevEnd` on this run's path. */
  firstAdded: SlotId | null
  afterEnd: SlotId | null
  atEnd: boolean
  firstSlot: SlotId | null
  throughSlot: SlotId | null
  /** Messages written. */
  written: number
  cursor: SlotId | null
  matching: boolean
  added: number
  updated: number
  differing: number
}

export const emptyWriteProgress = (matching: boolean): StWriteProgress => ({
  firstAdded: null,
  afterEnd: null,
  atEnd: false,
  firstSlot: null,
  throughSlot: null,
  written: 0,
  cursor: null,
  matching,
  added: 0,
  updated: 0,
  differing: 0
})

/** What one batch's write returned (`StImportMessages`). */
export interface StBatchWritten {
  readonly slotIds: ReadonlyArray<SlotId>
  readonly matching: boolean
  readonly added: number
  readonly updated: number
  readonly differing: number
}

/**
 * Moves `progress` past one written batch. `prevEnd`: where the file ended when last imported;
 * `hiddenRun`: the run of messages hidden from the file's first; `summaries`: the file's, which
 * take the slot of the message each was saved on. True when the batch is the first to add.
 */
export const stepWriteProgress = (
  progress: StWriteProgress,
  written: StBatchWritten,
  prevEnd: SlotId | null,
  hiddenRun: number,
  summaries: ReadonlyArray<{ readonly index: number; slot?: SlotId | undefined }>
) => {
  let first = false
  if (written.added > 0 && progress.firstAdded === null) {
    progress.firstAdded = written.slotIds[written.slotIds.length - written.added]!
    first = true
  }
  for (const slotId of written.slotIds) {
    if (progress.atEnd && progress.afterEnd === null) progress.afterEnd = slotId
    progress.atEnd = slotId === prevEnd
  }
  progress.firstSlot ??= written.slotIds[0] ?? null
  for (const summary of summaries) {
    const at = summary.index - progress.written
    if (at >= 0 && at < written.slotIds.length) summary.slot = written.slotIds[at]!
  }
  const lastHidden = hiddenRun - 1
  if (lastHidden >= progress.written && lastHidden < progress.written + written.slotIds.length) {
    progress.throughSlot = written.slotIds[lastHidden - progress.written]!
  }
  progress.written += written.slotIds.length
  progress.cursor = written.slotIds.at(-1) ?? progress.cursor
  progress.matching = written.matching
  progress.added += written.added
  progress.updated += written.updated
  progress.differing += written.differing
  return first
}

/**
 * Where a finished file's state goes. A new chat's goes at its start. A chat merged into gets
 * what changed from the first message past where this file last ended (which an interrupted
 * run may have written), else from where an unfinished run of it went its own way, else from
 * its first new message. `leaf`: the chat's new leaf, if any.
 */
export const stFinishAt = (file: {
  readonly isNew: boolean
  readonly branch: boolean
  readonly prevEnd: SlotId | null
  readonly resumeAt: SlotId | null
  readonly afterEnd: SlotId | null
  readonly firstAdded: SlotId | null
  readonly cursor: SlotId | null
}) => {
  const position = file.isNew ? null : (file.afterEnd ?? file.resumeAt ?? file.firstAdded)
  const applies = file.isNew || position !== null || (file.branch && file.prevEnd === null)
  // The writer moves it only if it's unset or still where this file last ended.
  const leaf = file.cursor === null || file.branch || !applies ? null : file.cursor
  return { position, applies, leaf }
}
