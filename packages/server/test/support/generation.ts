// A real generation for server tests: a chat with Mira, the user playing Tobin, a greeting,
// the user's message and a reply generated through the model the test's mock provider serves.
import { type Chat, type EntityId, NewVersion, type VersionId } from "@rp/shared/chat.ts"
import type { ChatEvent } from "@rp/shared/chatApi.ts"
import type { CardDoc } from "@rp/shared/docs/card.ts"
import type { UserId } from "@rp/shared/domain.ts"
import type { ModelOverrides, ProviderSettings } from "@rp/shared/providers.ts"
import type { StateEventData } from "@rp/shared/state.ts"
import { Effect, Stream } from "effect"
import { Writer } from "../../src/db/Database.ts"
import { importCard } from "../../src/formats/cardImport.ts"
import { importStPreset } from "../../src/formats/preset.ts"
import { json, run } from "../formats/support.ts"
import { type client, posted } from "./config.ts"

type Api = Effect.Success<ReturnType<typeof client>>

const cardDoc = (name: string, description: string, personality = ""): CardDoc =>
  run(importCard(json({ spec: "chara_card_v2", spec_version: "2.0", data: { name, description, personality } }))).card

const presetDoc = (fields: Record<string, unknown>) =>
  importStPreset(JSON.stringify({ frequency_penalty: 0, ...fields })).document!

export const eventually = (check: () => boolean, ms = 20_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + ms
    while (!check()) {
      if (Date.now() > deadline) return yield* Effect.die(new Error("timed out waiting"))
      yield* Effect.sleep(10)
    }
  })

export const finished = (events: ReadonlyArray<ChatEvent>, versionId: VersionId) =>
  events.flatMap((e) => (e._tag === "Version" && e.version.id === versionId ? [e.version] : [])).at(-1)

/** A chat with Mira and the user as Tobin, greeted, the user's message sent, and a reply generated. */
export const generateReply = (
  api: Api,
  options: {
    readonly connection: {
      /** The provider (providerDefinitions.ts); by default the one the API type and base URL imply. */
      readonly provider?: string
      readonly kind: string
      readonly baseUrl: string
      /** Changes to the provider's defaults (its advanced section). */
      readonly providerSettings?: ProviderSettings
      readonly apiKey?: string
      readonly cacheTtlS?: number
    }
    readonly modelKey?: string
    readonly model: ModelOverrides
    readonly preset?: Record<string, unknown>
    /** Fields of our preset document, over the imported ST preset's (ones ST has no field for). */
    readonly presetFields?: Record<string, unknown>
    readonly content?: string
    readonly images?: import("@rp/shared/chat.ts").MessageImages
    readonly example?: string
    readonly greeting?: string
    readonly personality?: string
    /** The preset's regex scripts allowed to run, as the user would allow them. */
    readonly approveRegex?: boolean
    /** More of Mira's card: her regex scripts, say. */
    readonly mira?: Partial<CardDoc>
    /** The connection's Token counts set to its own provider (off by default, DESIGN §11). */
    readonly countWithProvider?: boolean
    /** Chat-wide state events set before the reply: a reply mode, say. */
    readonly state?: ReadonlyArray<StateEventData>
    /** More characters in the chat, after Mira (cards with these names). */
    readonly characters?: ReadonlyArray<string>
    /** Of those, the ones the user muted. */
    readonly muted?: ReadonlyArray<string>
    /** A lorebook the chat reads. */
    readonly lorebook?: import("@rp/shared/docs/lorebook.ts").LorebookDoc
    /** The reply as Auto asks for it: its speaker (by card name) and the round after it, Auto's picks. */
    readonly auto?: { readonly speaker: string; readonly round?: ReadonlyArray<string> }
    /** Called once the chat is set up, before anything is sent, with the `characters`' ids in order. */
    readonly before?: (chat: Chat, characters: ReadonlyArray<EntityId>) => Effect.Effect<void, unknown, Writer>
  }
) =>
  Effect.gen(function* () {
    const writer = yield* Writer
    const me = yield* api.Whoami()
    const userId = me.id as UserId
    const connection = yield* api.CreateConnection({
      ...(options.connection.provider ? { provider: options.connection.provider } : {}),
      kind: options.connection.kind,
      settings: {
        name: "Mock",
        baseUrl: options.connection.baseUrl,
        compat: {},
        cacheTtlS: options.connection.cacheTtlS ?? null,
        maxConcurrent: null,
        presetOverrideRefId: null,
        ...(options.connection.providerSettings ? { providerSettings: options.connection.providerSettings } : {})
      },
      ...(options.connection.apiKey ? { apiKey: options.connection.apiKey } : {})
    })
    if (options.countWithProvider) yield* api.SetTokenCounting({ connectionId: connection.id, via: connection.id })
    const model = yield* api.AddUserModel({
      connectionId: connection.id,
      key: options.modelKey ?? "mock-model",
      // Explicit fixture model settings preserve the old test scenarios; production imports never do this.
      overrides: {
        ...options.model,
        settings: {
          ...presetDoc(options.preset ?? {}),
          ...options.model.settings,
          samplers: { ...presetDoc(options.preset ?? {}).samplers, ...options.model.settings?.samplers }
        }
      }
    })
    const entity = (kind: "card" | "preset" | "lorebook", label: string, doc: object) =>
      writer.CreateEntity({
        userId,
        kind,
        label,
        subtitle: "",
        doc: doc as never,
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
    const mira = yield* entity("card", "Mira", {
      ...cardDoc("Mira", "{{char}} keeps the ledger for {{user}}.", options.personality),
      mes_example: options.example ?? "",
      ...options.mira
    })
    const tobin = yield* entity("card", "Tobin", cardDoc("Tobin", "{{user}} draws maps."))
    const preset = yield* entity("preset", "Preset", {
      ...presetDoc(options.preset ?? {}),
      ...options.presetFields,
      ...(options.approveRegex ? { regex_approved: true } : {})
    })
    yield* api.SetGenerationDefaults({
      defaults: { model: { connection: connection.id, model: model.id }, preset: preset.ref.id }
    })
    const chat: Chat = yield* writer.CreateChat({
      userId,
      kind: "rp",
      status: "active",
      title: "Ledger",
      participants: [mira.entityId as EntityId],
      greeting: new NewVersion({
        speakerEntityId: mira.entityId as EntityId,
        writer: "model",
        content: options.greeting ?? "*{{char}} looks up.* Late again, {{user}}.",
        // Frozen when the chat is made, as StartChat freezes every greeting.
        ...(options.greeting ? { frozenMacros: {} } : {}),
        status: "complete",
        macroMode: "template",
        origin: "greeting"
      })
    })
    const state = (data: StateEventData) =>
      writer.AddStateEvent({ userId, chatId: chat.id, slotId: null, versionId: null, scope: null, data })
    yield* state({ key: "played_by_me.set", value: { entities: [tobin.entityId as EntityId] } })
    for (const data of options.state ?? []) yield* state(data)
    const characters: Array<Effect.Success<ReturnType<typeof entity>>> = []
    for (const name of options.characters ?? []) {
      const card = yield* entity("card", name, cardDoc(name, `{{char}} rides with {{user}}.`))
      yield* state({ key: "participant.join", value: { entity: card.entityId as EntityId } })
      if (options.muted?.includes(name))
        yield* state({ key: "presence.set", value: { entity: card.entityId as EntityId, present: false } })
      characters.push(card)
    }
    if (options.lorebook) {
      const book = yield* writer.CreateEntity({
        userId,
        kind: "lorebook",
        label: options.lorebook.name,
        subtitle: "",
        doc: options.lorebook as never,
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
      yield* state({ key: "lorebook.attach", value: { ref: book.ref.id as never } })
    }
    const events: Array<ChatEvent> = []
    yield* api.SubscribeChat({ chatId: chat.id }).pipe(
      Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
      Effect.forkScoped
    )
    yield* eventually(() => events.length > 0)
    if (options.before)
      yield* Effect.orDie(
        options.before(
          chat,
          characters.map((card) => card.entityId as EntityId)
        )
      )
    const sent = yield* posted(
      api.SendMessage({
        chatId: chat.id,
        parentSlotId: chat.activeLeafSlotId,
        branch: false,
        content: options.content ?? "The road flooded.",
        ...(options.images === undefined ? {} : { images: options.images })
      })
    )
    const byName = (name: string) =>
      (name === "Mira" ? mira : characters[(options.characters ?? []).indexOf(name)]!).entityId as EntityId
    const { entry } = yield* posted(
      api.Generate({
        chatId: chat.id,
        parentSlotId: sent.entry.slotId,
        branch: false,
        ...(options.auto
          ? {
              speakerEntityId: byName(options.auto.speaker),
              autoPick: true,
              ...(options.auto.round ? { round: options.auto.round.map(byName) } : {})
            }
          : {})
      })
    )
    yield* eventually(() => finished(events, entry.version.id) !== undefined)
    return {
      version: finished(events, entry.version.id)!,
      chat,
      connection,
      model,
      events,
      sent: sent.entry,
      mira,
      characters,
      preset
    }
  })
