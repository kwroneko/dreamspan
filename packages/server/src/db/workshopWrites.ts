import type { RefId } from "@rp/shared/library.ts"
/** One writer transaction creates the seeds, their setting, the chat and its greeting. */
import { type ChatId, type EntityId, NewVersion } from "@rp/shared/chat.ts"
import { newCardDoc } from "@rp/shared/editing.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import { Effect } from "effect"
import type { Bin } from "./bin.ts"
import type { LibrarySteps } from "./editorWrites.ts"
import { newChatLcmSettings, ownedPersona, readDefaults } from "./generationSettings.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { makeGraphWrites } from "./graphWrites.ts"
import { NotFound, type WriteOps } from "./ops.ts"
import { chatKinds } from "@rp/shared/chatKinds.ts"
import { writeGrant } from "./workshopGrants.ts"
import { SIDE_STORY_READ_MODE } from "../agent/capabilities.ts"
import { type ChatRow, toChat } from "./rows.ts"
import { putUserSetting } from "./settings.ts"
import { transaction } from "./tx.ts"
import {
  ownedCard,
  readStoredWorkshopDefaults,
  type StoredWorkshopDefaults,
  workshopDefaultsOf
} from "./workshopDefaults.ts"
import { defaultSeed } from "./workshopSeeds.ts"

export const makeWorkshopWriteHandlers = (steps: LibrarySteps, bin: Bin) => {
  const { sql } = steps
  const graph = makeGraphWrites(sql, bin.drafts, true)
  /** Whether a persona is the account's story persona, or a card cast, played or speaking in `story`. */
  const inStory = (userId: UserId, story: string, persona: string) =>
    Effect.gen(function* () {
      if ((yield* readDefaults(sql, userId)).persona === persona) return true
      const [hit] = yield* sql<{ n: number }>`SELECT 1 AS n FROM state_events
        WHERE chat_id = ${story} AND key IN ('participant.join', 'played_by_me.set')
          AND (value_json ->> '$.entity' = ${persona}
            OR EXISTS (SELECT 1 FROM json_each(value_json, '$.entities') WHERE value = ${persona}))
        UNION ALL SELECT 1 FROM versions v JOIN slots s ON s.id = v.slot_id
          WHERE s.chat_id = ${story} AND v.speaker_entity_id = ${persona}
        LIMIT 1`
      return hit !== undefined
    })
  return {
    CreateWorkshop: ({ userId, title, attachTo, card: chosenCard, persona: chosenPersona }) =>
      Effect.gen(function* () {
        // A side chat's story: the user's, live, of a kind that takes one (spec/WORKSHOP.md §4).
        const [story] =
          attachTo === undefined
            ? []
            : yield* sql<{ title: string | null; kind: string }>`SELECT title, kind FROM chats
                WHERE id = ${attachTo} AND owner_user_id = ${userId} AND deleted_at IS NULL AND status = 'active'`
        if (attachTo !== undefined && (!story || chatKinds.get(story.kind)?.allowsSideChat !== true))
          return yield* new NotFound({ entity: "chat", id: attachTo })
        const stored = yield* readStoredWorkshopDefaults(sql, userId)
        // A deleted or foreign seed is replaced individually; the other editable seed survives.
        const seed = (kind: "card" | "preset", id: string | undefined) =>
          Effect.gen(function* () {
            const [existing] = yield* sql<{ entity_id: string; id: string }>`SELECT r.entity_id, r.id
          FROM entity_refs r JOIN entities e ON e.id = r.entity_id
          WHERE e.owner_user_id = ${userId} AND e.kind = ${kind} AND e.deleted_at IS NULL
            AND e.purged_at IS NULL AND ${kind === "card" ? sql`e.id = ${id ?? null}` : sql`r.id = ${id ?? null}`}`
            if (existing) return existing
            // The registered default of its kind (db/workshopSeeds.ts).
            const entry = defaultSeed(kind)
            if (!entry) return yield* new NotFound({ entity: kind, id: "workshop default" })
            return yield* steps.createUpstream({
              userId,
              kind,
              label: entry.label,
              subtitle: "",
              doc: steps.encode(entry.doc() as never),
              schemaVersion: 1,
              origin: "import",
              originRef: entry.originRef,
              sourcePath: null,
              sourceHash: null
            })
          })
        const defaultCard = yield* seed("card", stored?.card || undefined)
        const prompt = yield* seed("preset", stored?.preset || undefined)
        // The workshop persona, independent of the story default (owner, 2026-11-12): made once,
        // with the first seeds, from the account's display name, and never made again once it
        // was chosen, cleared or deleted (a deleted one leaves the workshop without a persona).
        let persona: string | null =
          typeof stored?.persona === "string" && (yield* ownedPersona(sql, userId, stored.persona))
            ? stored.persona
            : null
        if (stored?.persona === undefined) {
          const [account] = yield* sql<{
            display_name: string
          }>`SELECT display_name FROM users WHERE id = ${userId}`
          const name = account?.display_name.trim() || "Me"
          const made = yield* steps.createUpstream({
            userId,
            kind: "card",
            label: name,
            subtitle: "",
            doc: steps.encode(newCardDoc(name) as never),
            schemaVersion: 1,
            origin: "import",
            originRef: "builtin:workshop-persona@1",
            sourcePath: null,
            sourceHash: null
          })
          yield* sql`INSERT OR IGNORE INTO entity_tags (entity_id, tag) VALUES (${made.entity_id}, 'persona')`
          persona = made.entity_id
        }
        const defaults: StoredWorkshopDefaults = { card: defaultCard.entity_id, preset: prompt.id, persona }
        if (
          !stored ||
          stored.card !== defaults.card ||
          stored.preset !== defaults.preset ||
          stored.persona !== defaults.persona
        )
          yield* putUserSetting(sql, userId, "workshop.defaults", defaults)
        // This workshop's own choices; they never change the defaults.
        if (chosenCard !== undefined && !(yield* ownedCard(sql, userId, chosenCard)))
          return yield* new NotFound({ entity: "card", id: chosenCard })
        if (chosenPersona != null && !(yield* ownedPersona(sql, userId, chosenPersona)))
          return yield* new NotFound({ entity: "persona", id: chosenPersona })
        const card =
          chosenCard === undefined
            ? defaultCard
            : (yield* sql<{ entity_id: string; id: string }>`SELECT entity_id, id FROM entity_refs
                WHERE entity_id = ${chosenCard} ORDER BY id LIMIT 1`)[0]!
        const account = { persona: chosenPersona === undefined ? persona : chosenPersona }
        const at = Date.now()
        const chatId = uuidv7() as ChatId
        const storyTitle = story?.title?.trim()
        const name = title?.trim() || (storyTitle ? `About ${storyTitle}` : "Workshop")
        yield* sql`INSERT INTO chats ${sql.insert({ id: chatId, owner_user_id: userId, kind: "workshop", status: "active", title: name, created_at: at })}`
        if (attachTo !== undefined) {
          yield* graph.insertStateEvent(userId, chatId, null, null, null, {
            key: "workshop.attached",
            value: { chat: attachTo }
          })
          // §4: reading the story it's beside is allowed in this workshop; the strip can change it.
          yield* writeGrant(sql, userId, chatId, "chats.read", SIDE_STORY_READ_MODE)
        }
        yield* graph.insertStateEvent(userId, chatId, null, null, null, {
          key: "lcm.settings",
          // As a new story chat: the user's default (spec/WORKSHOP-CONTEXT.md §2.4).
          value: yield* newChatLcmSettings(sql, userId)
        })
        // A side chat plays the workshop persona too, but never the account's story persona nor a
        // card of its story: their descriptions and books would put the story's roleplay in its
        // context (workfix1). It then has none, and {{user}} is the account name.
        const played =
          attachTo === undefined || !account.persona
            ? account.persona
            : (yield* inStory(userId, attachTo, account.persona))
              ? null
              : account.persona
        for (const entity of new Set([card.entity_id, ...(played ? [played] : [])]))
          yield* graph.insertStateEvent(userId, chatId, null, null, null, {
            key: "participant.join",
            value: { entity: entity as EntityId }
          })
        if (played)
          yield* graph.insertStateEvent(userId, chatId, null, null, null, {
            key: "played_by_me.set",
            value: { entities: [played as EntityId] }
          })
        yield* graph.insertStateEvent(userId, chatId, null, null, null, {
          key: "preset.binding",
          value: { ref: prompt.id as RefId }
        })
        const doc = yield* steps.lib.loadDoc((yield* steps.reload(card.id)).head_revision_id)
        const greeting = typeof doc.first_mes === "string" ? doc.first_mes : ""
        const { slotId } = yield* graph.insertSlot(
          chatId,
          null,
          new NewVersion({
            speakerEntityId: card.entity_id as EntityId,
            writer: "model",
            content: greeting,
            status: "complete",
            macroMode: "template",
            origin: "greeting",
            greetingRef: { entity: card.entity_id as EntityId, index: 0 }
          }),
          at
        )
        yield* sql`UPDATE chats SET active_leaf_slot_id = ${slotId}, last_message_at = ${at} WHERE id = ${chatId}`
        const [row] = yield* sql<ChatRow>`SELECT * FROM chats WHERE id = ${chatId}`
        return toChat(row!)
      }).pipe(transaction(sql, "CreateWorkshop")),
    /** The workshop persona only; the story default persona (`chat.persona`) never changes here. */
    SetWorkshopPersona: ({ userId, persona }) =>
      Effect.gen(function* () {
        if (persona !== null && !(yield* ownedPersona(sql, userId, persona)))
          return yield* new NotFound({ entity: "persona", id: persona })
        const stored = yield* readStoredWorkshopDefaults(sql, userId)
        // Before the first workshop there are no seeds yet: empty ids make it seed them.
        yield* putUserSetting(sql, userId, "workshop.defaults", {
          card: stored?.card ?? "",
          preset: stored?.preset ?? "",
          persona
        })
        return yield* workshopDefaultsOf(sql, userId)
      }).pipe(transaction(sql, "SetWorkshopPersona"))
  } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
}
