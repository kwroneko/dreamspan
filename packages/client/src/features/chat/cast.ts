// Who's in the open chat, as message rows and the composer read it: names by card, and who
// the user plays. Rows read it from context; it only changes when the cast does.
import type { CastCard, EntityId, PathEntry } from "@rp/shared/chat.ts"
import type { Cast } from "@rp/shared/chatSetupApi.ts"
import { createContext, useContext } from "react"

export interface CastView {
  readonly cast: Cast | null
  readonly cards: ReadonlyMap<string, CastCard>
  /** `{{user}}`: the first card the user plays, or "User". */
  readonly user: string
  /** `{{char}}` when a text has no speaker: the first participant the user doesn't play. */
  readonly char: string
}

export const castView = (cast: Cast | null, extra: ReadonlyArray<CastCard> = []): CastView => {
  const cards = new Map<string, CastCard>(extra.map((card) => [card.entityId, card]))
  for (const card of cast?.cards ?? []) cards.set(card.entityId, card)
  const played = cast?.playedByMe[0]
  const other = cast?.participants.find((id) => !cast.playedByMe.includes(id))
  return {
    cast,
    cards,
    user: (played && cards.get(played)?.name) || "User",
    char: (other && cards.get(other)?.name) || "Character"
  }
}

export const CastContext = createContext<CastView>(castView(null))

export const useCast = () => useContext(CastContext)

export const nameOf = (view: CastView, id: EntityId | null) => (id === null ? null : (view.cards.get(id)?.name ?? null))

/**
 * Who can reply to the composer's next send: the participants present that the user doesn't
 * play, in the cast's order, less the composer's own speaker (one writing as a character
 * isn't answered by that character), unless no one else is there.
 */
export const replyCandidates = (cast: Cast | null, speaker: EntityId | null): Array<EntityId> => {
  const present = (cast?.participants ?? []).filter(
    (id) => !cast!.playedByMe.includes(id) && !cast!.absent.includes(id)
  )
  const others = present.filter((id) => id !== speaker)
  return others.length > 0 ? others : present
}

/** The next reply in turn, and whose turn it follows (null: no one's spoken yet). */
export interface NextInTurn {
  readonly id: EntityId
  readonly after: EntityId | null
}

/**
 * Turns go round the cast in its order (ST's "list order", one reply a turn): the candidate
 * after the character who spoke last on the path, or the first when none has.
 */
export const nextInTurn = (
  cast: Cast | null,
  entries: ReadonlyArray<PathEntry>,
  speaker: EntityId | null
): NextInTurn | null => {
  const candidates = replyCandidates(cast, speaker)
  if (cast === null || candidates.length === 0) return null
  const characters = cast.participants.filter((id) => !cast.playedByMe.includes(id))
  let after: EntityId | null = null
  for (let i = entries.length - 1; i >= 0 && after === null; i--) {
    const id = entries[i]!.version.speakerEntityId
    if (id !== null && characters.includes(id)) after = id
  }
  if (after === null) return { id: candidates[0]!, after: null }
  const from = cast.participants.indexOf(after)
  for (let step = 1; step <= cast.participants.length; step++) {
    const id = cast.participants[(from + step) % cast.participants.length]!
    if (candidates.includes(id)) return { id, after }
  }
  return { id: candidates[0]!, after }
}

/**
 * The composer's speaker when none is picked at its tip: the card the user last wrote as on
 * the path, if they still play it, else the first card they play.
 */
export const defaultSpeaker = (cast: Cast | null, entries: ReadonlyArray<PathEntry>): EntityId | null => {
  const played = cast?.playedByMe ?? []
  for (let i = entries.length - 1; i >= 0; i--) {
    const id = entries[i]!.version.speakerEntityId
    if (id !== null && played.includes(id)) return id
  }
  return played[0] ?? null
}

/** Up to `count` speakers of the loaded messages, most recent first. */
export const recentSpeakers = (entries: ReadonlyArray<PathEntry>, count: number): Array<EntityId> => {
  const seen: Array<EntityId> = []
  for (let i = entries.length - 1; i >= 0 && seen.length < count; i--) {
    const speaker = entries[i]!.version.speakerEntityId
    if (speaker !== null && !seen.includes(speaker)) seen.push(speaker)
  }
  return seen
}
