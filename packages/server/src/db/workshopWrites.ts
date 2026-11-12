import type { RefId } from "@rp/shared/library.ts"
/** One writer transaction creates the seeds, their setting, the chat and its greeting. */
import { type ChatId, type EntityId, NewVersion } from "@rp/shared/chat.ts"
import { newCardDoc } from "@rp/shared/editing.ts"
import { promptPreset, type PresetDoc } from "@rp/shared/docs/preset.ts"
import { charDefinitions, mainPrompt, newestMessage } from "@rp/shared/presetOrder.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import { Effect } from "effect"
import { builtinPreset } from "./assemblySources.ts"
import type { Bin } from "./bin.ts"
import type { LibrarySteps } from "./editorWrites.ts"
import { readDefaults, newChatLcmSettings } from "./generationSettings.ts"
import { makeGraphWrites } from "./graphWrites.ts"
import { NotFound, type WriteOps } from "./ops.ts"
import { chatKinds } from "@rp/shared/chatKinds.ts"
import { writeGrant } from "./workshopGrants.ts"
import { type ChatRow, toChat } from "./rows.ts"
import { putUserSetting, readSetting } from "./settings.ts"
import { transaction } from "./tx.ts"

const assistant = {
  ...newCardDoc("Assistant"),
  description:
    "Practical and brief. You say what you're about to change, change it, then say what you changed. You don't describe changes you haven't made.",
  first_mes: "What would you like to work on, {{user}}?"
}
const preset: PresetDoc = {
  ...promptPreset(builtinPreset),
  prompts: [
    {
      ...mainPrompt,
      content:
        "You are the workshop assistant in a roleplay app. You help {{user}} with the app itself: characters, chats, prompt presets, lorebooks, settings, and plugins that change how the app works. You don't roleplay here."
    },
    charDefinitions,
    { ...newestMessage, identifier: "chatHistory", name: "Chat history" },
    newestMessage
  ],
  order: ["main", "charDefinitions", "chatHistory", "newestMessage"].map((identifier) => ({
    identifier,
    enabled: true
  })),
  utility_prompts: { ...builtinPreset.utility_prompts, new_chat_prompt: "", new_group_chat_prompt: "" },
  prefill: { assistant: "", impersonation: "", continue: false, continue_postfix: "" }
}

export const makeWorkshopWriteHandlers = (steps: LibrarySteps, bin: Bin) => {
  const { sql } = steps
  const graph = makeGraphWrites(sql, bin.drafts)
  return {
    CreateWorkshop: ({ userId, title, attachTo }) =>
      Effect.gen(function* () {
        // A side chat's story: the user's, live, of a kind that takes one (spec/WORKSHOP.md §4).
        const [story] =
          attachTo === undefined
            ? []
            : yield* sql<{ title: string | null; kind: string }>`SELECT title, kind FROM chats
                WHERE id = ${attachTo} AND owner_user_id = ${userId} AND deleted_at IS NULL`
        if (attachTo !== undefined && (!story || chatKinds.get(story.kind)?.allowsSideChat !== true))
          return yield* new NotFound({ entity: "chat", id: attachTo })
        const stored = (yield* readSetting(sql, "user", userId, "workshop.defaults")).value as {
          card: string
          preset: string
        } | null
        // A deleted or foreign seed is replaced individually; the other editable seed survives.
        const seed = (kind: "card" | "preset", id: string | undefined) =>
          Effect.gen(function* () {
            const [existing] = yield* sql<{ entity_id: string; id: string }>`SELECT r.entity_id, r.id
          FROM entity_refs r JOIN entities e ON e.id = r.entity_id
          WHERE e.owner_user_id = ${userId} AND e.kind = ${kind} AND e.deleted_at IS NULL
            AND e.purged_at IS NULL AND ${kind === "card" ? sql`e.id = ${id ?? null}` : sql`r.id = ${id ?? null}`}`
            if (existing) return existing
            return yield* steps.createUpstream({
              userId,
              kind,
              label: kind === "card" ? "Assistant" : "Workshop",
              subtitle: "",
              doc: steps.encode(kind === "card" ? assistant : preset),
              schemaVersion: 1,
              origin: "import",
              originRef: kind === "card" ? "builtin:workshop-assistant@1" : "builtin:workshop-preset@1",
              sourcePath: null,
              sourceHash: null
            })
          })
        const card = yield* seed("card", stored?.card)
        const prompt = yield* seed("preset", stored?.preset)
        const defaults = { card: card.entity_id, preset: prompt.id }
        if (!stored || stored.card !== defaults.card || stored.preset !== defaults.preset)
          yield* putUserSetting(sql, userId, "workshop.defaults", defaults)
        const account = yield* readDefaults(sql, userId)
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
          yield* writeGrant(sql, userId, chatId, "chats.read", "allow")
        }
        yield* graph.insertStateEvent(userId, chatId, null, null, null, {
          key: "lcm.settings",
          value: yield* newChatLcmSettings(sql, userId, false)
        })
        for (const entity of new Set([card.entity_id, ...(account.persona ? [account.persona] : [])]))
          yield* graph.insertStateEvent(userId, chatId, null, null, null, {
            key: "participant.join",
            value: { entity: entity as EntityId }
          })
        if (account.persona)
          yield* graph.insertStateEvent(userId, chatId, null, null, null, {
            key: "played_by_me.set",
            value: { entities: [account.persona] }
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
      }).pipe(transaction(sql, "CreateWorkshop"))
  } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
}
