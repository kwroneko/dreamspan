import type { EntityId, PathEntry } from "@dreamspan/shared/chat.ts"
import type { Cast } from "@dreamspan/shared/chatSetupApi.ts"
import {
  hashSeed,
  listOrder,
  manualOrder,
  mulberry32,
  naturalOrder,
  pooledOrder,
  TALKATIVENESS_DEFAULT
} from "@dreamspan/shared/naturalOrder.ts"
import { makeRegistry } from "../../registry.ts"

/**
 * Who can reply to the composer's next send: the participants present that the user doesn't
 * play, neither muted nor away, in the cast's order, less the composer's own speaker (one
 * writing as a character isn't answered by that character), unless no one else is there.
 */
const replyCandidates = (cast: Cast | null, speaker: EntityId | null): Array<EntityId> => {
  const present = (cast?.participants ?? []).filter(
    (id) => !cast!.playedByMe.includes(id) && !cast!.absent.includes(id) && !(cast!.away ?? []).includes(id)
  )
  const others = present.filter((id) => id !== speaker)
  return others.length > 0 ? others : present
}

/**
 * The next reply in turn, and whose turn it follows (null: no one's spoken yet). `then`: who
 * replies after it in the same round, in turn, as ST's group replies do (DESIGN §2.3); none
 * when the chat takes one reply per user action (`Cast.replySingle`).
 */
export interface NextInTurn {
  readonly id: EntityId
  readonly after: EntityId | null
  readonly then?: ReadonlyArray<EntityId>
}

/** Whether the chat takes one reply per user action instead of ST's rounds (the Cast tab's switch). */
export const oneReplyAtATime = (cast: Cast | null) => cast?.replySingle === true

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
 * ST's natural order (`@dreamspan/shared/naturalOrder.ts`): everyone it activates, in turn (one reply
 * a send, the first, when the chat takes one at a time). Those named in the text being sent
 * reply first; then each candidate who passes a roll by their card's talkativeness. With nothing typed, the mentions come from the tip's message and, when a
 * character wrote it, they don't answer themselves unless no one else can. The rolls are seeded
 * by the tip's version and the candidates, so the preview, Send, a reload and a queued send agree.
 */
const natural = (
  cast: Cast | null,
  entries: ReadonlyArray<PathEntry>,
  speaker: EntityId | null,
  input: string | null = null,
  hasImages = false
): NextInTurn | null => {
  const candidates = replyCandidates(cast, speaker)
  if (cast === null || candidates.length === 0) return null
  const after = lastCharacter(cast, entries)
  const tip = entries.at(-1)?.version
  const typed = (input !== null && input.trim() !== "") || hasImages
  const tipSpeaker = tip?.speakerEntityId ?? null
  const banned = !typed && tipSpeaker !== null && tipSpeaker === after ? tipSpeaker : null
  const members = candidates.map((id) => {
    const card = cast.cards.find((c) => c.entityId === id)
    return { id, name: card?.name ?? "", talkativeness: card?.talkativeness ?? TALKATIVENESS_DEFAULT }
  })
  const seed = hashSeed([tip?.id ?? "", ...members.flatMap((m) => [m.id, String(m.talkativeness)])])
  const [id, ...then] = naturalOrder(members, typed ? (input ?? "") : (tip?.content ?? ""), banned, mulberry32(seed))
  return id === undefined ? null : { id, after, then }
}

/**
 * Whether a turn is the user's: a card they play, or one written by a person as no one or as a
 * card no longer in the chat (an earlier persona, an imported chat's other personas).
 */
const userTurn = (cast: Cast, entry: PathEntry) => {
  const id = entry.version.speakerEntityId
  return id === null || !cast.participants.includes(id)
    ? entry.version.writer === "human"
    : cast.playedByMe.includes(id)
}

/** The characters who spoke since the user's last turn on the path, latest last (none when the user is sending). */
const sinceUser = (cast: Cast, entries: ReadonlyArray<PathEntry>, typed: boolean): Array<EntityId> => {
  if (typed) return []
  const spoke: Array<EntityId> = []
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!
    if (userTurn(cast, entry)) break
    const id = entry.version.speakerEntityId
    if (id !== null && cast.participants.includes(id)) spoke.unshift(id)
  }
  return spoke
}

/** The seeded rolls for a pick: by the tip's version and the candidates, as `natural`'s. */
const rollsFor = (entries: ReadonlyArray<PathEntry>, candidates: ReadonlyArray<EntityId>) =>
  mulberry32(hashSeed([entries.at(-1)?.version.id ?? "", ...candidates]))

const typedText = (input: string | null | undefined) => input !== null && input !== undefined && input.trim() !== ""

/**
 * ST's list order (`activateListOrder`): every candidate in the cast's order, after a message or
 * an empty send alike. One at a time, it's the first in the cast's order after your message;
 * asked again with nothing typed, the next after the last to reply since your turn, then the
 * first again.
 */
const list = (
  cast: Cast | null,
  entries: ReadonlyArray<PathEntry>,
  speaker: EntityId | null,
  input: string | null = null,
  hasImages = false
): NextInTurn | null => {
  const candidates = replyCandidates(cast, speaker)
  if (cast === null || candidates.length === 0) return null
  if (!oneReplyAtATime(cast)) {
    const [id, ...then] = candidates
    return { id: id!, after: lastCharacter(cast, entries), then }
  }
  const last = sinceUser(cast, entries, typedText(input) || hasImages).at(-1) ?? null
  const id = listOrder(cast.participants, candidates, last)
  return id === null ? null : { id, after: lastCharacter(cast, entries) }
}

/** ST's pooled order: someone who hasn't spoken since your turn, at random; when all have, anyone but the last. */
const pooled = (
  cast: Cast | null,
  entries: ReadonlyArray<PathEntry>,
  speaker: EntityId | null,
  input: string | null = null,
  hasImages = false
): NextInTurn | null => {
  const candidates = replyCandidates(cast, speaker)
  if (cast === null || candidates.length === 0) return null
  const spoke = sinceUser(cast, entries, typedText(input) || hasImages)
  const id = pooledOrder(candidates, spoke, spoke.at(-1) ?? null, rollsFor(entries, candidates))
  return id === null ? null : { id, after: lastCharacter(cast, entries) }
}

/** ST's manual order: no one replies to what you send unless you pick them; Send with nothing typed picks one at random. */
const manual = (
  cast: Cast | null,
  entries: ReadonlyArray<PathEntry>,
  speaker: EntityId | null,
  input: string | null = null,
  hasImages = false
): NextInTurn | null => {
  const candidates = replyCandidates(cast, speaker)
  if (cast === null || candidates.length === 0) return null
  const id = manualOrder(candidates, typedText(input) || hasImages, rollsFor(entries, candidates))
  return id === null ? null : { id, after: lastCharacter(cast, entries) }
}

export interface ReplyPolicy {
  readonly id: string
  /** Its name in the Cast tab's choice of who replies; a policy without one isn't offered there. */
  readonly label?: string
  /** What choosing it means, as the choice's explanation. */
  readonly description?: string
  /** How Auto picks under it, in the Next chooser. */
  readonly autoDetail?: string
  /** `input`: text being sent; `hasImages`: attachments make a posted turn even with blank text. */
  readonly next: (
    cast: Cast | null,
    entries: ReadonlyArray<PathEntry>,
    speaker: EntityId | null,
    input?: string | null,
    hasImages?: boolean
  ) => NextInTurn | null
  /** Whether Send can request an unnamed reply when this policy selects no character. */
  readonly unnamedReply?: (cast: Cast | null) => boolean
}

/** With no character in the chat, Send still asks for a reply, unnamed. */
const noCharacters = (cast: Cast | null) => !(cast?.participants.some((id) => !cast.playedByMe.includes(id)) ?? false)

export const replyPolicies = makeRegistry<ReplyPolicy>()
replyPolicies.register({ id: "round-robin", next: roundRobin, unnamedReply: noCharacters })
// ST's four reply strategies (`group_activation_strategy`), in its order, chosen per chat in the Cast tab.
replyPolicies.register({
  id: "natural",
  label: "Natural order",
  description:
    "Anyone you name replies first, then each character who feels like it, by how talkative they are. The default.",
  autoDetail: "Anyone you name first, then others by how talkative they are",
  next: natural,
  unnamedReply: noCharacters
})
replyPolicies.register({
  id: "list",
  label: "List order",
  description:
    "Every character replies, in the cast's order. One at a time: the first after your message, then the next each time you ask for another reply.",
  autoDetail: "In the cast's order",
  next: list,
  unnamedReply: noCharacters
})
replyPolicies.register({
  id: "pooled",
  label: "Pooled order",
  description:
    "Someone who hasn't spoken since your last message replies, at random; once all have, anyone but the last to speak.",
  autoDetail: "At random, among those who haven't spoken since your message",
  next: pooled,
  unnamedReply: noCharacters
})
replyPolicies.register({
  id: "manual",
  label: "Manual",
  description:
    "No one replies to what you send unless you pick them under Next or use Speak now; Send with nothing typed picks someone at random.",
  autoDetail: "No one replies to what you send; an empty Send picks at random",
  next: manual,
  unnamedReply: noCharacters
})

/** The default policy (DESIGN §2.3), ST's default too; a chat picks another in its Cast tab (`reply.order`). */
export const AUTO_POLICY = "natural"

/** The chat's policy: its `reply.order`, else the default (an order no policy has is the default too). */
export const replyPolicyOf = (cast: Cast | null): ReplyPolicy | undefined => {
  const chosen = cast?.replyOrder
  return (chosen === undefined ? undefined : replyPolicies.get(chosen)) ?? replyPolicies.get(AUTO_POLICY)
}

/** The same dispatch drives the preview and the speaker submitted by the composer. */
export const nextInTurn = (
  cast: Cast | null,
  entries: ReadonlyArray<PathEntry>,
  speaker: EntityId | null,
  input: string | null = null,
  hasImages = false
): NextInTurn | null => replyPolicyOf(cast)?.next(cast, entries, speaker, input, hasImages) ?? null

/** One decision for the preview, immediate sends and queued sends (`input`: the text being
 * sent, so the preview follows the box as Send does). A null speaker
 * is a valid unnamed reply, so disabling automatic replies needs an explicit flag.
 * `noReplies`: Next is No one (DESIGN §2.3). A message sent gets no reply unless a pick names
 * one; asking with nothing typed (an empty Send) gets Auto's pick, one reply. */
export const planReply = (
  cast: Cast | null,
  entries: ReadonlyArray<PathEntry> | null,
  speaker: EntityId | null,
  picked: EntityId | null,
  input: string | null = null,
  hasImages = false,
  noReplies = false
) => {
  const policy = replyPolicyOf(cast)
  const next = entries === null ? null : nextInTurn(cast, entries, speaker, input, hasImages)
  if (noReplies && picked === null) {
    const posted = typedText(input) || hasImages
    const asked = posted ? null : (next?.id ?? null)
    return { next, replier: asked, round: [], reply: asked !== null, auto: false }
  }
  return {
    next,
    replier: picked ?? next?.id ?? null,
    /** Auto picked the replier (and the round): the decision model's "Who replies next" may choose others. */
    auto: picked === null && next !== null,
    /** Who replies after the replier, in turn: none for a pick (ST's force talk) or one at a time. */
    round: picked !== null || oneReplyAtATime(cast) ? [] : [...(next?.then ?? [])],
    reply: picked !== null || next !== null || policy?.unnamedReply?.(cast) === true
  }
}
