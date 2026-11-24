import { startingFolder } from "./workingFolders.ts"
import type { RefId } from "@dreamspan/shared/library.ts"
/** One writer transaction creates the seeds, their setting, the chat and its greeting. */
import { type ChatId, type EntityId, type ForkId, NewVersion } from "@dreamspan/shared/chat.ts"
import { newCardDoc } from "@dreamspan/shared/editing.ts"
import { uuidv7 } from "@dreamspan/shared/id.ts"
import { Effect } from "effect"
import type { Bin } from "./bin.ts"
import type { LibrarySteps } from "./editorWrites.ts"
import { newChatLcmSettings, ownedPersona, readDefaults } from "./generationSettings.ts"
import { makeGraphWrites } from "./graphWrites.ts"
import { NotFound, type WriteOps } from "./ops.ts"
import { chatKinds } from "@dreamspan/shared/chatKinds.ts"
import { writeGrant } from "./workshopGrants.ts"
import { SIDE_STORY_READ_MODE } from "../agent/capabilities.ts"
import { type ChatRow, toChat } from "./rows.ts"
import { putUserSetting } from "./settings.ts"
import { transaction } from "./tx.ts"
import {
  ownedCard,
  personaInStory,
  workshopSpeaker,
  readStoredWorkshopDefaults,
  type StoredWorkshopDefaults,
  workshopDefaultsOf
} from "./workshopDefaults.ts"
import { WORKSHOP_SUMMARY_INSTRUCTION, workshopLcmSizes } from "@dreamspan/shared/workshopLcm.ts"
import { resolveModel } from "@dreamspan/shared/providers.ts"
import { toModel, type ModelRow } from "./providers.ts"
import { defaultSeed } from "./workshopSeeds.ts"
import { getWorkshopStart } from "./workshopAttach.ts"

export const makeWorkshopWriteHandlers = (steps: LibrarySteps, bin: Bin) => {
  const { sql } = steps
  const graph = makeGraphWrites(sql, bin.drafts, true)
  const stepsFor = {
    createWorkshop: ({
      userId,
      title,
      attachTo,
      attachFork,
      card: chosenCard,
      persona: chosenPersona,
      preset: chosenPreset,
      grants
    }: Parameters<Parameters<typeof WriteOps.of>[0]["CreateWorkshop"]>[0]) =>
      Effect.gen(function* () {
        // A side chat's story: the user's, live, of a kind that takes one (spec/WORKSHOP.md §4).
        const [story] =
          attachTo === undefined
            ? []
            : yield* sql<{ title: string | null; kind: string }>`SELECT title, kind FROM chats
                WHERE id = ${attachTo} AND owner_user_id = ${userId} AND deleted_at IS NULL AND status = 'active'`
        if (attachTo !== undefined && (!story || chatKinds.get(story.kind)?.allowsSideChat !== true))
          return yield* new NotFound({ entity: "chat", id: attachTo })
        // The story branch it's started beside (spec/WORKSHOP-BRANCHES.md §2.1): a live one of that story.
        const [pairedFork] =
          attachTo === undefined
            ? []
            : yield* sql<{ id: string }>`SELECT f.id FROM forks f JOIN chats c ON c.id = f.chat_id
                WHERE c.id = ${attachTo} AND f.deleted_at IS NULL AND f.id = coalesce(${attachFork ?? null}, c.current_fork_id)`
        if (attachTo !== undefined && !pairedFork)
          return yield* new NotFound({ entity: "fork", id: attachFork ?? attachTo })
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
        // A preset chosen before the first message: one of the user's live presets.
        const presetRef = chosenPreset?._tag === "Lock" ? chosenPreset.ref : null
        if (presetRef !== null) {
          const [owned] = yield* sql<{
            id: string
          }>`SELECT r.id FROM entity_refs r JOIN entities e ON e.id = r.entity_id
            WHERE r.id = ${presetRef} AND e.owner_user_id = ${userId} AND e.kind = 'preset'
              AND e.deleted_at IS NULL AND e.purged_at IS NULL`
          if (!owned) return yield* new NotFound({ entity: "preset", id: presetRef })
        }
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
          yield* graph.insertStateEvent(userId, chatId, null, null, null, {
            key: "workshop.paired",
            value: { fork: pairedFork!.id as ForkId }
          })
          // §4: reading the story it's beside is allowed in this workshop; the strip can change it.
          yield* writeGrant(sql, userId, chatId, "chats.read", SIDE_STORY_READ_MODE)
        }
        // What the assistant may do, chosen before the first message (the API checked each is
        // offered): written as the strip's choices are, after the side chat's own.
        for (const grant of grants ?? [])
          yield* writeGrant(sql, userId, chatId, grant.capability, grant.mode, grant.target ?? "")
        yield* graph.insertStateEvent(userId, chatId, null, null, null, {
          key: "lcm.settings",
          // As a new story chat: the user's default (spec/WORKSHOP-CONTEXT.md §2.4).
          value: yield* Effect.gen(function* () {
            const defaults = yield* readDefaults(sql, userId)
            const [row] = defaults.model
              ? yield* sql<ModelRow>`SELECT * FROM models WHERE id=${defaults.model.model} AND connection_id=${defaults.model.connection}`
              : []
            const model = row ? toModel(row) : null
            const resolved = model ? resolveModel(model.key, model.upstream, model.overrides) : null
            return {
              ...(yield* newChatLcmSettings(sql, userId)),
              ...workshopLcmSizes(resolved?.context.value, resolved?.maxOutput.value ?? undefined),
              enabled: true,
              withPreset: "raw" as const,
              withNotes: false,
              tail: WORKSHOP_SUMMARY_INSTRUCTION
            }
          })
        })
        // A side chat plays the workshop persona too, but never the account's story persona nor a
        // card of its story: their descriptions and books would put the story's roleplay in its
        // context (workfix1). It then has none, and {{user}} is the account name.
        const played =
          attachTo === undefined || !account.persona
            ? account.persona
            : (yield* personaInStory(sql, userId, attachTo, account.persona))
              ? null
              : account.persona
        for (const entity of new Set([card.entity_id, ...(played ? [played] : [])]))
          yield* graph.insertStateEvent(userId, chatId, null, null, null, {
            key: "participant.join",
            value: { entity: entity as EntityId }
          })
        // Its working folder (spec/FILES-AND-ENVIRONMENT.md §2.3): its card's, else the last picked.
        const folder = yield* startingFolder(sql, userId, card.entity_id)
        if (folder)
          yield* graph.insertStateEvent(userId, chatId, null, null, null, { key: "workshop.folder", value: folder })
        if (played)
          yield* graph.insertStateEvent(userId, chatId, null, null, null, {
            key: "played_by_me.set",
            value: { entities: [played as EntityId] }
          })
        // Kept for this workshop (the default, or the one chosen; none: the built-in one), unless
        // it was chosen to follow the account's preset.
        if (chosenPreset?._tag !== "Account")
          yield* graph.insertStateEvent(userId, chatId, null, null, null, {
            key: "preset.binding",
            value:
              chosenPreset === undefined
                ? { ref: prompt.id as RefId }
                : presetRef === null
                  ? {}
                  : { ref: presetRef as RefId }
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
        return { chat: toChat(row!), assistant: card.entity_id as EntityId, persona: played as EntityId | null }
      })
  }
  return {
    CreateWorkshop: (input) =>
      stepsFor.createWorkshop(input).pipe(
        Effect.map(({ chat }) => chat),
        transaction(sql, "CreateWorkshop")
      ),
    StartWorkshop: ({ requestId, first, speaker: picked, rewrite, ...input }) =>
      Effect.gen(function* () {
        const { userId } = input
        const existing = yield* getWorkshopStart(sql, userId, requestId)
        if (existing) return existing
        const { chat, assistant, persona } = yield* stepsFor.createWorkshop(input)
        const speaker = workshopSpeaker(picked, assistant, persona)
        const version = new NewVersion({
          speakerEntityId: speaker,
          macroMode: "verbatim",
          ...(first._tag === "Send"
            ? {
                writer: "human",
                content: first.content,
                status: "complete",
                origin: "user_written",
                ...(rewrite === undefined ? {} : { rewrite })
              }
            : {
                writer: "model",
                content: "",
                status: "generating",
                origin: "generated",
                ...(first.direction.trim() === "" ? {} : { direction: first.direction })
              })
        })
        const posted = yield* graph
          .appendMessage({
            userId,
            chatId: chat.id,
            parentSlotId: chat.activeLeafSlotId,
            branch: false,
            version,
            commitDraft: null
          })
          .pipe(Effect.catchTag("LeafMoved", (error) => Effect.die(error)))
        yield* sql`INSERT INTO workshop_starts ${sql.insert({
          user_id: userId,
          request_id: requestId,
          chat_id: chat.id,
          fork_id: posted.forkId,
          slot_id: posted.slotId,
          speaker_id: speaker,
          kind: first._tag
        })}`
        return {
          chat: posted.chat,
          forkId: posted.forkId,
          slotId: posted.slotId,
          speaker,
          kind: first._tag,
          ...(first._tag === "Generate" ? { generate: posted.version.id } : {})
        }
      }).pipe(transaction(sql, "StartWorkshop")),
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
