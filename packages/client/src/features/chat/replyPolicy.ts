import type { EntityId, PathEntry } from "@rp/shared/chat.ts"
import type { Cast } from "@rp/shared/chatSetupApi.ts"
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

/**
 * Turns go round the cast in its order (a round-robin default, one reply a turn): the candidate
 * after the character who spoke last on the path, or the first when none has.
 */
const roundRobin = (
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

export interface ReplyPolicy {
  readonly id: string
  readonly next: (cast: Cast | null, entries: ReadonlyArray<PathEntry>, speaker: EntityId | null) => NextInTurn | null
  /** Whether Send can request an unnamed reply when this policy selects no character. */
  readonly unnamedReply?: (cast: Cast | null) => boolean
}

export const replyPolicies = makeRegistry<ReplyPolicy>()
replyPolicies.register({
  id: "round-robin",
  next: roundRobin,
  unnamedReply: (cast) => !(cast?.participants.some((id) => !cast.playedByMe.includes(id)) ?? false)
})

/** The same dispatch drives the preview and the speaker submitted by the composer. */
export const nextInTurn = (
  cast: Cast | null,
  entries: ReadonlyArray<PathEntry>,
  speaker: EntityId | null
): NextInTurn | null => replyPolicies.get("round-robin")?.next(cast, entries, speaker) ?? null

/** One decision for the preview, immediate sends and queued sends. A null speaker
 * is a valid unnamed reply, so disabling automatic replies needs an explicit flag. */
export const planReply = (
  cast: Cast | null,
  entries: ReadonlyArray<PathEntry> | null,
  speaker: EntityId | null,
  picked: EntityId | null
) => {
  const policy = replyPolicies.get("round-robin")
  const next = entries === null ? null : nextInTurn(cast, entries, speaker)
  return {
    next,
    replier: picked ?? next?.id ?? null,
    reply: picked !== null || next !== null || policy?.unnamedReply?.(cast) === true
  }
}
