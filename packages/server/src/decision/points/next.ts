// The `next` decision point, "Who replies next" (spec/AGENTIC.md §7; DESIGN §2.3). Before a
// reply whose speaker Auto picked is written, in a chat with two or more characters the user
// doesn't play, one choice question: which present character speaks next, over the last few
// messages. The model's pick becomes the reply's speaker, recorded on the version with how sure it
// was; below the threshold, on a timeout, an error or a malformed answer, Auto uses an eligible
// fallback. It runs for each reply of a round too, at its turn, so a round follows the scene. A pick
// under Next, No one, Generate and Speak now never come here: their versions aren't Auto's pick.
import type { EntityId, Version } from "@dreamspan/shared/chat.ts"
import type { DecisionQuestion } from "@dreamspan/shared/decisions.ts"
import { awayAt } from "@dreamspan/shared/knowledge.ts"
import { foldState } from "@dreamspan/shared/state.ts"
import { Effect } from "effect"
import type { DecisionPoint } from "../engine.ts"

/**
 * The messages the state carries, and each one's length at most (its end kept). Six messages are
 * three turns of a two-character exchange, enough to see who is talking to whom; who speaks next
 * is mostly settled by the end of the latest message (who it addresses or asks). At most ~1.8k
 * tokens in all, under the smallest window a decision route reads (hosted Clef keeps the first
 * ~2.2k), so no route loses the newest message, and the call stays cheap.
 */
const NEXT_RECENT = 6
const NEXT_MESSAGE_CHARS = 1_200
/** Choice options some decision models take at most (reference-harness's survey: Tev1, 20). */
const MAX_CANDIDATES = 20
/**
 * The point's deadline: it holds the reply up. Decision models answer in 0.3–1.2 s (p50,
 * reference-harness's survey); past 3 s the wait outgrows what a better pick is worth, and Auto decides.
 */
export const NEXT_TIMEOUT_MS = 3_000

interface NextCandidate {
  readonly entity: string
  readonly name: string
}

interface NextInput {
  /** Present characters the user doesn't play, but the last speaker; Auto's pick among them first. */
  readonly candidates: ReadonlyArray<NextCandidate>
  /** Auto's pick, which replies when the model doesn't decide. */
  readonly fallback: NextCandidate
  /** Who wrote the latest message, by name. */
  readonly lastSpeaker: string
  /** The last messages, oldest first. */
  readonly recent: ReadonlyArray<{ readonly from: string; readonly text: string }>
}

/** Who replies, and how sure the model was (null: Auto's pick). */
interface NextPick {
  readonly entity: string
  readonly name: string
  readonly confidence: number | null
}

const id = (index: number) => `c${index}`

export const nextPoint: DecisionPoint<NextInput, NextPick> = {
  id: "next",
  label: "Who replies next",
  description:
    "When Auto chooses who replies in a chat with several characters, the decision model reads the last few messages and picks who speaks next. Without it, Auto picks by the chat's reply order.",
  instead: "The chat's reply order, or your own pick, chose who replied.",
  appliesTo: ({ state }) => state.participants.filter((entity) => !state.playedByMe.includes(entity)).length >= 2,
  defaultThreshold: 0.5,
  timeoutMs: NEXT_TIMEOUT_MS,
  questions: ({ candidates }) =>
    candidates.length < 2
      ? {}
      : {
          next: {
            type: "choice",
            instructions:
              "Choose the character who speaks next in this story, right after the latest message in `recent` (oldest first; the latest is from `last_speaker`). The character the latest message addresses, asks or answers speaks next; when it addresses no one, the character who would most naturally respond to it.",
            criteria: Object.fromEntries(candidates.map((c, i) => [id(i), `${c.name} speaks next.`]))
          } satisfies DecisionQuestion
        },
  state: ({ candidates, lastSpeaker, recent }) => ({
    characters: candidates.map((c) => c.name),
    last_speaker: lastSpeaker,
    recent
  }),
  resolve: (answers, { candidates }, threshold) => {
    const answer = answers["next"]
    if (answer?.type !== "choice") return null
    const chosen = candidates.find((_, i) => id(i) === answer.choice)
    if (!chosen) return null
    // How likely the chosen one is to speak next, as the other points read a probability; the
    // model's calibration signal when it gives no probabilities.
    const p = answer.probabilities[answer.choice] ?? answer.confidence
    return p >= threshold ? { entity: chosen.entity, name: chosen.name, confidence: p } : null
  },
  fallback: ({ fallback }) => ({ ...fallback, confidence: null }),
  beforeReply: (reply, { reader, writer, evaluate }) =>
    Effect.gen(function* () {
      const { version } = reply
      const auto = version.speakerEntityId
      if (version.speakerPick?.by !== "auto" || auto === null || reply.parentSlotId === null) return false
      const state = foldState(reply.events)
      const characters = state.participants.filter((entity) => !state.playedByMe.includes(entity))
      if (characters.length === 0 || (characters.length === 1 && characters[0] === auto)) return false
      const window = yield* reader.ReadPath({
        userId: reply.userId,
        chatId: reply.chatId,
        forkId: reply.forkId,
        leafSlotId: reply.parentSlotId,
        range: { _tag: "Bottom" },
        limit: NEXT_RECENT
      })
      const last = window.entries.at(-1)
      const lastId = last?.version.speakerEntityId ?? null
      // Present (not away, not muted), and not who just spoke: no one answers themselves.
      const away = awayAt(state)
      const present = characters.filter(
        (entity) => !state.absent.includes(entity) && !away.includes(entity) && entity !== lastId
      )
      const fallback = present.includes(auto) ? auto : present[0]
      if (fallback === undefined) return false
      const settleFallback = () =>
        fallback !== auto
          ? writer.SettleSpeaker({
              userId: reply.userId,
              versionId: reply.versionId,
              speakerEntityId: fallback as EntityId
            })
          : Effect.succeed(false)
      if (present.length < 2) return yield* settleFallback()
      // Auto's pick first, so a cap never drops it.
      const candidates = [...new Set([fallback, ...present])].slice(0, MAX_CANDIDATES)
      const speakers = window.entries.flatMap((e) => (e.version.speakerEntityId ? [e.version.speakerEntityId] : []))
      const cards = yield* reader.CastCards({
        userId: reply.userId,
        entityIds: [...new Set([...candidates, ...speakers])] as Array<EntityId>
      })
      const names = new Map(cards.map((card) => [card.entityId as string, card.modelName ?? card.name]))
      const nameOf = (entity: string | null, writer?: Version["writer"]) =>
        (entity ? names.get(entity) : undefined) ?? (writer === "human" ? "User" : entity ? "Unnamed" : "Narrator")
      const recent = window.entries.flatMap((entry) =>
        entry.contextExcluded || !entry.version.content.trim()
          ? []
          : [
              {
                from: nameOf(entry.version.speakerEntityId, entry.version.writer),
                text: entry.version.content.slice(-NEXT_MESSAGE_CHARS)
              }
            ]
      )
      if (recent.length === 0) return yield* settleFallback()
      const outcome = yield* evaluate<NextInput, NextPick>(
        "next",
        {
          candidates: candidates.map((entity) => ({ entity, name: nameOf(entity) })),
          fallback: { entity: fallback, name: nameOf(fallback) },
          lastSpeaker: last ? nameOf(lastId, last.version.writer) : "User",
          recent
        },
        {
          userId: reply.userId,
          chatId: reply.chatId,
          slotId: reply.slotId,
          forkId: reply.forkId,
          requestClass: "interactive"
        }
      )
      if (outcome.source !== "model" || !outcome.rolloutId || outcome.value.confidence === null)
        return yield* settleFallback()
      // Recorded even when it agrees with Auto, so the reply says the model chose it.
      return yield* writer.PickSpeaker({
        userId: reply.userId,
        rolloutId: outcome.rolloutId,
        versionId: reply.versionId,
        speakerEntityId: outcome.value.entity as EntityId,
        name: outcome.value.name,
        confidence: outcome.value.confidence
      })
    })
}
