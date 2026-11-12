// The `presence` decision point (spec/AGENTIC.md §7): after a reply completes in a chat with two
// or more characters, "is each character still in the scene?" over the last two messages. A
// character the model is sure has left is marked away (`away.set`, `source: "decision"`; spec/
// CHARACTER-CONTEXT.md §5, apart from Mute): Auto no longer picks them to reply next until
// they're back, and in a chat with separate contexts they don't see what's said meanwhile. One
// the model marked away comes back when it's sure they returned. The changes attach to the
// reply's version, so a swipe takes them back. Without a model nothing changes. The user's own
// away mark, and the agent's `set_presence`, are never overridden: only presence this point set
// itself is changed back. A narrator is never asked about (§6: never in or out of the scene).
import type { EntityId } from "@rp/shared/chat.ts"
import type { DecisionQuestion } from "@rp/shared/decisions.ts"
import { awayAt } from "@rp/shared/knowledge.ts"
import { foldState, type StoredStateEventData } from "@rp/shared/state.ts"

type StoredEvent = typeof StoredStateEventData.Type
import { Effect } from "effect"
import type { DecisionPoint } from "../engine.ts"
import { decisionStateStamp } from "../stateStamp.ts"

/** A message's text as the state carries it, at most this long (the newest part kept). */
const MESSAGE_CHARS = 4_000

interface PresenceCandidate {
  readonly entity: string
  readonly name: string
  readonly present: boolean
}

export interface PresenceInput {
  readonly candidates: ReadonlyArray<PresenceCandidate>
  /** Every character's name, the candidates' and those the user muted. */
  readonly characters: ReadonlyArray<string>
  /** The last two messages, oldest first. */
  readonly recent: ReadonlyArray<{ readonly from: string; readonly text: string }>
}

export interface PresenceChange {
  readonly entity: string
  readonly present: boolean
}

const id = (index: number) => `c${index}`

export const presencePoint: DecisionPoint<PresenceInput, ReadonlyArray<PresenceChange>> = {
  id: "presence",
  label: "Who is in the scene",
  description:
    "After each reply in a chat with several characters, asks whether each character is still in the scene. A character who left isn't picked to reply until they're back. Without it, no one is marked away automatically.",
  defaultThreshold: 0.85,
  questions: ({ candidates }) =>
    Object.fromEntries(
      candidates.map((c, i): [string, DecisionQuestion] => [
        id(i),
        {
          type: "noul",
          instructions: `${c.name} is in the scene at the end of the latest message.`,
          criteria: {
            true: `${c.name} is still there at the end of the latest message, or arrived during it.`,
            false: `${c.name} left during these messages, or the latest message says they are somewhere else.`
          }
        }
      ])
    ),
  state: ({ characters, recent }) => ({ characters, recent }),
  resolve: (answers, { candidates }, threshold) => {
    const changes: Array<PresenceChange> = []
    candidates.forEach((c, i) => {
      const answer = answers[id(i)]
      if (answer?.type !== "noul") return
      if (c.present && answer.noul <= 1 - threshold) changes.push({ entity: c.entity, present: false })
      if (!c.present && answer.noul >= threshold) changes.push({ entity: c.entity, present: true })
    })
    // Never everyone away: the scene still has someone to reply.
    const presentAfter = candidates.filter(
      (c) => (changes.find((change) => change.entity === c.entity)?.present ?? c.present) === true
    )
    return presentAfter.length > 0 ? changes : changes.filter((change) => change.present)
  },
  fallback: () => [],
  afterReply: (reply, { reader, writer, evaluate }) =>
    Effect.gen(function* () {
      const events = yield* reader.StateEventsAt({
        userId: reply.userId,
        chatId: reply.chatId,
        slotId: reply.slotId,
        forkId: reply.forkId
      })
      const state = foldState(events)
      const characters = state.participants.filter((entity) => !state.playedByMe.includes(entity))
      if (characters.length < 2) return false
      // Who set each character's away mark last: the user (or a tool), or this point.
      const lastSource = new Map<string, "decision" | "other">()
      for (const event of events)
        if (event.data.key === "away.set")
          lastSource.set(event.data.value.entity, event.data.value.source === "decision" ? "decision" : "other")
      const cards = yield* reader.CastCards({ userId: reply.userId, entityIds: characters as Array<EntityId> })
      const names = new Map(cards.map((card) => [card.entityId as string, card.modelName ?? card.name]))
      const away = awayAt(state)
      const candidates = characters.flatMap((entity): Array<PresenceCandidate> => {
        if (state.roles[entity] === "narrator") return []
        const present = !away.includes(entity)
        // Away by the user's own mark (or a tool): left as it is.
        if (!present && lastSource.get(entity) !== "decision") return []
        return [{ entity, name: names.get(entity) ?? "Unnamed", present }]
      })
      if (candidates.length === 0) return false
      const window = yield* reader.ReadPath({
        userId: reply.userId,
        chatId: reply.chatId,
        forkId: reply.forkId,
        leafSlotId: reply.slotId,
        range: { _tag: "Bottom" },
        limit: 2
      })
      // A completed reply may already have been swiped or edited before this background task runs.
      if (window.entries.at(-1)?.version.id !== reply.versionId) return false
      const speakers = [
        ...new Set(window.entries.flatMap((e) => (e.version.speakerEntityId ? [e.version.speakerEntityId] : [])))
      ]
      const speakerCards = speakers.length
        ? yield* reader.CastCards({ userId: reply.userId, entityIds: speakers as Array<EntityId> })
        : []
      const speakerNames = new Map(speakerCards.map((card) => [card.entityId as string, card.modelName ?? card.name]))
      const recent = window.entries.flatMap((entry) =>
        entry.contextExcluded || !entry.version.content.trim()
          ? []
          : [
              {
                from:
                  speakerNames.get(entry.version.speakerEntityId ?? "") ??
                  (entry.version.writer === "human" ? "User" : "Narrator"),
                text: entry.version.content.slice(-MESSAGE_CHARS)
              }
            ]
      )
      if (recent.length === 0) return false
      const outcome = yield* evaluate<PresenceInput, ReadonlyArray<PresenceChange>>(
        "presence",
        { candidates, characters: characters.map((e) => names.get(e) ?? "Unnamed"), recent },
        {
          userId: reply.userId,
          chatId: reply.chatId,
          slotId: reply.slotId,
          forkId: reply.forkId,
          requestClass: "background"
        }
      )
      if (outcome.source !== "model" || outcome.value.length === 0 || !outcome.rolloutId) return false
      const changes: Array<StoredEvent> = outcome.value.map((change) => ({
        key: "away.set",
        value: { entity: change.entity as EntityId, away: !change.present, source: "decision" }
      }))
      return yield* writer.ApplyDecisionEffect({
        userId: reply.userId,
        rolloutId: outcome.rolloutId,
        versionId: reply.versionId,
        expectedState: decisionStateStamp(events),
        events: changes
      })
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("the presence decision failed", cause).pipe(Effect.as(false)))
    )
}
