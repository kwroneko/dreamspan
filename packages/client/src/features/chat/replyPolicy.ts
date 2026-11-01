import type { EntityId, PathEntry } from "@rp/shared/chat.ts"
import type { Cast } from "@rp/shared/chatSetupApi.ts"
import { hashSeed, mulberry32, naturalOrder, TALKATIVENESS_DEFAULT } from "@rp/shared/naturalOrder.ts"
import { makeRegistry } from "../../registry.ts"

/**
 * Who can reply to the composer's next send: the participants present that the user doesn't
 * play, in the cast's order, less the composer's own speaker (one writing as a character
 * isn't answered by that character), unless no one else is there.
 */
const replyCandidates = (cast: Cast | null, speaker: EntityId | null): Array<EntityId> => {
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

/** The character who spoke last on the path (null: none has). */
const lastCharacter = (cast: Cast, entries: ReadonlyArray<PathEntry>): EntityId | null => {
  const characters = cast.participants.filter((id) => !cast.playedByMe.includes(id))
  for (let i = entries.length - 1; i >= 0; i--) {
    const id = entries[i]!.version.speakerEntityId
    if (id !== null && characters.includes(id)) return id
  }
  return null
}

/**
 * Turns go round the cast in its order (a round-robin, one reply a turn): the candidate
 * after the character who spoke last on the path, or the first when none has.
 */
const roundRobin = (
  cast: Cast | null,
  entries: ReadonlyArray<PathEntry>,
  speaker: EntityId | null
): NextInTurn | null => {
  const candidates = replyCandidates(cast, speaker)
  if (cast === null || candidates.length === 0) return null
  const after = lastCharacter(cast, entries)
  if (after === null) return { id: candidates[0]!, after: null }
  const from = cast.participants.indexOf(after)
  for (let step = 1; step <= cast.participants.length; step++) {
    const id = cast.participants[(from + step) % cast.participants.length]!
    if (candidates.includes(id)) return { id, after }
  }
  return { id: candidates[0]!, after }
}

/**
 * ST's natural order (`@rp/shared/naturalOrder.ts`), one reply a send: the first it activates.
 * Someone named in the text being sent replies; else each candidate replies by their card's
 * talkativeness. With nothing typed, the mentions come from the tip's message and, when a
 * character wrote it, they don't answer themselves unless no one else can. The rolls are seeded
 * by the tip's version and the candidates, so the preview, Send, a reload and a queued send agree.
 */
const natural = (
  cast: Cast | null,
  entries: ReadonlyArray<PathEntry>,
  speaker: EntityId | null,
  input: string | null = null
): NextInTurn | null => {
  const candidates = replyCandidates(cast, speaker)
  if (cast === null || candidates.length === 0) return null
  const after = lastCharacter(cast, entries)
  const tip = entries.at(-1)?.version
  const typed = input !== null && input.trim() !== ""
  const tipSpeaker = tip?.speakerEntityId ?? null
  const banned = !typed && tipSpeaker !== null && tipSpeaker === after ? tipSpeaker : null
  const members = candidates.map((id) => {
    const card = cast.cards.find((c) => c.entityId === id)
    return { id, name: card?.name ?? "", talkativeness: card?.talkativeness ?? TALKATIVENESS_DEFAULT }
  })
  const seed = hashSeed([tip?.id ?? "", ...members.flatMap((m) => [m.id, String(m.talkativeness)])])
  const [id] = naturalOrder(members, typed ? input : (tip?.content ?? ""), banned, mulberry32(seed))
  return id === undefined ? null : { id, after }
}

export interface ReplyPolicy {
  readonly id: string
  /** `input`: the text being sent; null or blank when nothing is typed (Reply now, an empty box). */
  readonly next: (
    cast: Cast | null,
    entries: ReadonlyArray<PathEntry>,
    speaker: EntityId | null,
    input?: string | null
  ) => NextInTurn | null
  /** Whether Send can request an unnamed reply when this policy selects no character. */
  readonly unnamedReply?: (cast: Cast | null) => boolean
}

/** With no character in the chat, Send still asks for a reply, unnamed. */
const noCharacters = (cast: Cast | null) => !(cast?.participants.some((id) => !cast.playedByMe.includes(id)) ?? false)

export const replyPolicies = makeRegistry<ReplyPolicy>()
replyPolicies.register({ id: "round-robin", next: roundRobin, unnamedReply: noCharacters })
replyPolicies.register({ id: "natural", next: natural, unnamedReply: noCharacters })

/** The policy Auto follows (DESIGN §2.3); round-robin stays registered for a plugin to choose. */
export const AUTO_POLICY = "natural"

/** The same dispatch drives the preview and the speaker submitted by the composer. */
export const nextInTurn = (
  cast: Cast | null,
  entries: ReadonlyArray<PathEntry>,
  speaker: EntityId | null,
  input: string | null = null
): NextInTurn | null => replyPolicies.get(AUTO_POLICY)?.next(cast, entries, speaker, input) ?? null

/** One decision for the preview, immediate sends and queued sends (`input`: the text being
 * sent, so the preview follows the box as Send does). A null speaker
 * is a valid unnamed reply, so disabling automatic replies needs an explicit flag. */
export const planReply = (
  cast: Cast | null,
  entries: ReadonlyArray<PathEntry> | null,
  speaker: EntityId | null,
  picked: EntityId | null,
  input: string | null = null
) => {
  const policy = replyPolicies.get(AUTO_POLICY)
  const next = entries === null ? null : nextInTurn(cast, entries, speaker, input)
  return {
    next,
    replier: picked ?? next?.id ?? null,
    reply: picked !== null || next !== null || policy?.unnamedReply?.(cast) === true
  }
}
