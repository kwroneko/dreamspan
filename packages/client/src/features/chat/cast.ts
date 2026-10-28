export { nextInTurn, type NextInTurn } from "./replyPolicy.ts"
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
    user: (played && (cards.get(played)?.modelName ?? cards.get(played)?.name)) || "User",
    char: (other && (cards.get(other)?.modelName ?? cards.get(other)?.name)) || "Character"
  }
}

export const CastContext = createContext<CastView>(castView(null))

export const useCast = () => useContext(CastContext)

export const nameOf = (view: CastView, id: EntityId | null) => (id === null ? null : (view.cards.get(id)?.name ?? null))

/**
 * The faces Reply from offers: the candidates and the muted characters, who are never next in
 * turn but can still be picked to reply (DESIGN §3.5), in the cast's order.
 */
export const replyFaces = (cast: Cast | null, speaker: EntityId | null): Array<EntityId> => {
  const characters = (cast?.participants ?? []).filter((id) => !cast!.playedByMe.includes(id))
  const others = characters.filter((id) => id !== speaker)
  return others.length > 0 ? others : characters
}

/**
 * The composer's speaker when none is picked at its tip: the first card they play.
 */
export const defaultSpeaker = (cast: Cast | null): EntityId | null => cast?.playedByMe[0] ?? null

/** Up to `count` speakers of the loaded messages, most recent first. */
export const recentSpeakers = (entries: ReadonlyArray<PathEntry>, count: number): Array<EntityId> => {
  const seen: Array<EntityId> = []
  for (let i = entries.length - 1; i >= 0 && seen.length < count; i--) {
    const speaker = entries[i]!.version.speakerEntityId
    if (speaker !== null && !seen.includes(speaker)) seen.push(speaker)
  }
  return seen
}

export const modelNameOf = (view: CastView, id: EntityId | null) =>
  id === null ? null : (view.cards.get(id)?.modelName ?? view.cards.get(id)?.name ?? null)
