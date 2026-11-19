// Whom the insertion editor speaks as when it opens (spec/MESSAGE-INSERT.md §4.2): a convenience,
// registered so a plugin can change it; the user picks in the editor's switcher. The entry with
// the lowest order decides.
import type { EntityId, PathEntry } from "@dreamspan/shared/chat.ts"
import type { Cast } from "@dreamspan/shared/chatSetupApi.ts"
import { makeRegistry } from "../../../registry.ts"
import { messageSide } from "../cast.ts"

export interface InsertSpeakerContext {
  /** The message it goes below; null above the first message. */
  readonly anchor: PathEntry | null
  /** The messages loaded, in display order. */
  readonly entries: ReadonlyArray<PathEntry>
  readonly cast: Cast | null
  /** Who the composer writes as now. */
  readonly composerSpeaker: EntityId | null
}

export interface InsertSpeakerDefault {
  readonly id: string
  readonly order: number
  readonly pick: (context: InsertSpeakerContext) => EntityId | null
}

export const insertSpeakerDefaults = makeRegistry<InsertSpeakerDefault>()

/**
 * Below a character's message: who the user writes as (the composer's speaker). Below the user's
 * own: the character who spoke last before it, else the first character of the cast. Above the
 * first message: the composer's speaker.
 */
export const insertSpeakerDefault = ({ anchor, entries, cast, composerSpeaker }: InsertSpeakerContext) => {
  if (anchor === null || messageSide(anchor, cast) === "assistant") return composerSpeaker
  const at = entries.findIndex((entry) => entry.slotId === anchor.slotId)
  for (let i = at - 1; i >= 0; i--) {
    const entry = entries[i]!
    const speaker = entry.version.speakerEntityId ?? entry.firstSpeakerEntityId
    if (speaker !== null && messageSide(entry, cast, speaker) === "assistant") return speaker
  }
  return cast?.participants.find((id) => !cast.playedByMe.includes(id)) ?? composerSpeaker
}

export const pickInsertSpeaker = (context: InsertSpeakerContext) =>
  [...insertSpeakerDefaults.snapshot().entries].sort((a, b) => a.order - b.order)[0]?.pick(context) ??
  context.composerSpeaker

export const registerInsertSpeakerDefault = () => [
  insertSpeakerDefaults.register({ id: "insert.speaker-default", order: 10, pick: insertSpeakerDefault })
]
