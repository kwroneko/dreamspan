import { LibraryLabel } from "@rp/shared/editorApi.ts"
import { offeredGreetings } from "@rp/shared/greetings.ts"
import { freezeTemplate } from "../../chat/macros.ts"
import { Type, validateToolArguments, type ToolCall } from "@earendil-works/pi-ai"
import { newCardDoc } from "@rp/shared/editing.ts"
import { Effect, Schema } from "effect"
import type { EntityId } from "@rp/shared/chat.ts"
import type { ModelId } from "@rp/shared/providers.ts"
import type { RolloutTool, ToolContext, ToolOutput } from "../tools.ts"
import { resolveLibrary } from "./library.ts"
import { workshopLimits as limits } from "../../workshopLimits.ts"

const receiptFirst = <A>(tool: RolloutTool<A>): RolloutTool<A> => ({
  ...tool,
  execute: (ctx, args) =>
    safely(
      ctx.reader.RolloutToolReceipt(key(ctx)).pipe(
        Effect.flatMap((receipt) =>
          receipt === null
            ? Effect.try({
                try: () =>
                  validateToolArguments(
                    { name: tool.id, description: tool.description, parameters: tool.parameters },
                    { type: "toolCall", id: ctx.toolCallId, name: tool.id, arguments: args as ToolCall["arguments"] }
                  ) as A,
                catch: () => ({
                  message: "Invalid tool arguments. Use only the listed fields and stay within their size limits."
                })
              }).pipe(Effect.flatMap((validated) => tool.execute(ctx, validated)))
            : Effect.succeed(receipt.isError ? receipt : { text: receipt.text })
        )
      )
    )
})
const key = (ctx: ToolContext) => ({ userId: ctx.userId, rolloutId: ctx.rolloutId, toolCallId: ctx.toolCallId })
const safely = <E>(body: Effect.Effect<ToolOutput, E>) =>
  body.pipe(
    Effect.catch((error) => {
      const failure = error as { _tag?: string; message?: string; reason?: string; problems?: ReadonlyArray<string> }
      const text =
        failure._tag === "StorageError" || failure._tag === "RpcClientError"
          ? "The change could not be saved. Try again."
          : failure._tag === "StaleWrite"
            ? "The saved card changed. Read it again before editing."
            : failure._tag === "NotFound"
              ? "That item is unavailable in your library."
              : (failure.problems?.join("; ") ?? failure.reason ?? failure.message ?? "The change could not be saved.")
      return Effect.succeed({ text, isError: true })
    })
  )
const findRef = (ctx: ToolContext, kind: "card" | "preset", name: string) =>
  resolveLibrary(ctx, kind, name).pipe(
    Effect.flatMap((found) => ("error" in found ? Effect.fail({ message: found.error }) : Effect.succeed(found.ref)))
  )
const text = Type.String({ maxLength: limits.textChars })
const name = Type.String({ minLength: 1, maxLength: limits.nameChars })
const shortText = Type.String({ maxLength: limits.nameChars })
const strict = { additionalProperties: false } as const
const cardFields = {
  nickname: Type.Optional(shortText),
  description: Type.Optional(text),
  personality: Type.Optional(text),
  scenario: Type.Optional(text),
  first_message: Type.Optional(text),
  alternate_greetings: Type.Optional(Type.Array(text, { maxItems: limits.listItems })),
  example_messages: Type.Optional(text),
  system_prompt: Type.Optional(text),
  tags: Type.Optional(Type.Array(name, { maxItems: limits.listItems })),
  persona: Type.Optional(Type.Boolean())
}
interface CreateArgs {
  readonly name: string
  readonly nickname?: string
  readonly description?: string
  readonly personality?: string
  readonly scenario?: string
  readonly first_message?: string
  readonly alternate_greetings?: ReadonlyArray<string>
  readonly example_messages?: string
  readonly system_prompt?: string
  readonly tags?: ReadonlyArray<string>
  readonly persona?: boolean
}
const createCard: RolloutTool<CreateArgs> = {
  id: "create_card",
  label: "Created the card",
  titleField: "name",
  explanation: "Create an ordinary card in your library.",
  effect: "library",
  capability: "library.write",
  description:
    "Creates a card in the library, with one agent revision. Use first_message for her greeting. Returns its library and entity ids. Undo moves it to the bin if untouched.",
  parameters: Type.Object({ name, ...cardFields }, strict),
  summarize: ({ name }) => name,
  execute: (ctx, args) =>
    !Schema.is(LibraryLabel)(args.name)
      ? Effect.succeed({
          text: "Give the card a name of 1 to 200 characters, without control characters or surrounding spaces.",
          isError: true
        })
      : safely(
          ctx.writer
            .AgentCreateEntity({
              ...key(ctx),
              kind: "card",
              label: args.name,
              doc: {
                ...newCardDoc(args.name),
                nickname: args.nickname ?? "",
                description: args.description ?? "",
                personality: args.personality ?? "",
                scenario: args.scenario ?? "",
                first_mes: args.first_message ?? "",
                alternate_greetings: args.alternate_greetings ?? [],
                mes_example: args.example_messages ?? "",
                system_prompt: args.system_prompt ?? "",
                tags: args.tags ?? []
              },
              tags: [...new Set([...(args.tags ?? []), ...(args.persona ? ["persona"] : [])])]
            })
            .pipe(Effect.map((text) => ({ text })))
        )
}
const fields = [
  "name",
  "nickname",
  "character_version",
  "description",
  "personality",
  "scenario",
  "first_mes",
  "mes_example",
  "system_prompt",
  "post_history_instructions",
  "creator_notes",
  "creator"
]
const editCard: RolloutTool<{
  readonly card: string
  readonly changes: ReadonlyArray<{
    readonly field: string
    readonly text?: string
    readonly find?: string
    readonly replace?: string
  }>
}> = {
  id: "edit_card",
  label: "Edited the card",
  titleField: "card",
  explanation: "Edit the saved library card, leaving drafts and history intact.",
  effect: "library",
  capability: "library.write",
  description:
    "Edits a library card by name or id. Each change replaces a whole text field with text, or one exact find with replace. A find must occur exactly once. All changes save together on the head read; a moved head is an error. Does not grant permissions or approvals. Unsaved drafts remain unsaved.",
  parameters: Type.Object(
    {
      card: name,
      changes: Type.Array(
        Type.Union([
          Type.Object({ field: name, text }, strict),
          Type.Object(
            { field: name, find: Type.String({ minLength: 1, maxLength: limits.textChars }), replace: text },
            strict
          )
        ]),
        { minItems: 1, maxItems: limits.listItems }
      )
    },
    strict
  ),
  summarize: ({ card }) => card,
  execute: (ctx, args) =>
    safely(
      Effect.gen(function* () {
        const ref = yield* findRef(ctx, "card", args.card)
        const saved = yield* ctx.reader.OpenEditor({ userId: ctx.userId, refId: ref.id })
        const doc = { ...saved.doc }
        for (const change of args.changes) {
          const field =
            ({ first_message: "first_mes", example_messages: "mes_example" } as Record<string, string>)[change.field] ??
            change.field
          if (!fields.includes(field))
            return { text: `The text field ${change.field} cannot be edited by this tool.`, isError: true }
          if (change.text !== undefined) doc[field] = change.text
          else {
            const current = String(doc[field] ?? "")
            if (!change.find || current.split(change.find).length !== 2)
              return { text: `Find must occur exactly once in ${field}. Read the card again.`, isError: true }
            doc[field] = current.replace(change.find, () => change.replace ?? "")
          }
        }
        const text = yield* ctx.writer.AgentReviseEntity({
          ...key(ctx),
          refId: ref.id,
          expectedRowVersion: saved.ref.rowVersion,
          doc
        })
        return { text }
      })
    )
}
const cloneCard: RolloutTool<{
  readonly card: string
  readonly name: string
  readonly nickname?: string
  readonly version?: string
}> = {
  id: "clone_card",
  label: "Cloned the card",
  titleField: "name",
  explanation: "Fork a card into an ordinary card of its own.",
  effect: "library",
  capability: "library.write",
  description:
    "Clones a card through the library's ForkCard operation, including its notes and draft handling. Name and version must distinguish it. Returns the new card's ids.",
  parameters: Type.Object(
    {
      card: name,
      name,
      nickname: Type.Optional(shortText),
      version: Type.Optional(shortText)
    },
    strict
  ),
  summarize: ({ name }) => name,
  execute: (ctx, args) =>
    safely(
      Effect.gen(function* () {
        const ref = yield* findRef(ctx, "card", args.card)
        const text = yield* ctx.writer.AgentCloneCard({
          ...key(ctx),
          refId: ref.id,
          name: args.name,
          nickname: args.nickname ?? "",
          characterVersion: args.version ?? ""
        })
        return { text }
      })
    )
}
const startChat: RolloutTool<{
  readonly cards: ReadonlyArray<string>
  readonly persona?: string
  readonly greeting?: number
  readonly title?: string
  readonly preset?: string
  readonly model?: string
}> = {
  id: "start_chat",
  label: "Started the chat",
  titleField: "title",
  explanation: "Set up a story chat with greetings, without requesting a reply.",
  effect: "setup",
  capability: "chats.setup",
  description:
    "Starts a story chat with library cards (names or ids), an optional persona, greeting index (0 is the first), title, preset name/id and model id. Posts only card greetings; never sends a provider request. Returns chatId.",
  parameters: Type.Object(
    {
      cards: Type.Array(name, { minItems: 1, maxItems: limits.castCards }),
      persona: Type.Optional(name),
      greeting: Type.Optional(Type.Integer({ minimum: 0 })),
      title: Type.Optional(shortText),
      preset: Type.Optional(name),
      model: Type.Optional(name)
    },
    strict
  ),
  summarize: ({ title, cards }) => title ?? cards.join(", "),
  execute: (ctx, args) =>
    safely(
      Effect.gen(function* () {
        const cards: Array<EntityId> = []
        for (const name of args.cards) {
          const ref = yield* findRef(ctx, "card", name)
          if (!cards.includes(ref.entityId)) cards.push(ref.entityId)
        }
        const persona = args.persona ? (yield* findRef(ctx, "card", args.persona)).entityId : null
        const [player] =
          persona === null ? [] : yield* ctx.reader.CastCards({ userId: ctx.userId, entityIds: [persona] })
        const greeters = []
        for (const entityId of cards) {
          const card = yield* ctx.reader.GetCardForChat({ userId: ctx.userId, entityId })
          const options = offeredGreetings(card, cards.filter((id) => id !== persona).length)
          const picked = args.greeting ?? options[0]?.index ?? 0
          if (args.greeting !== undefined && !options.some((o) => o.index === picked))
            return { text: "That greeting is not available. Read the card again.", isError: true }
          const fields = { description: card.description, personality: card.personality, scenario: card.scenario }
          const names = {
            user: player?.modelName ?? player?.name ?? "User",
            char: card.card.modelName ?? card.card.name
          }
          greeters.push({
            entityId,
            greeting: picked,
            options: options.map((option) => ({
              index: option.index,
              text: option.text,
              frozen: freezeTemplate(option.text, fields, names, {})
            }))
          })
        }
        const preset = args.preset ? (yield* findRef(ctx, "preset", args.preset)).id : null
        const text = yield* ctx.writer.AgentStartChat({
          ...key(ctx),
          cards,
          persona,
          greeters,
          title: args.title ?? null,
          preset,
          model: (args.model as ModelId | undefined) ?? null
        })
        return { text }
      })
    )
}
export const libraryEditCard = receiptFirst(editCard)
export const setupTools: ReadonlyArray<RolloutTool<never>> = [
  receiptFirst(createCard),
  receiptFirst(cloneCard),
  receiptFirst(startChat)
]
