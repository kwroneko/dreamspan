// Chat RPC handlers (@rp/shared/chatApi.ts). Every handler acts as the authenticated user;
// storage enforces ownership, so another user's ids are NotFound. Each change is published
// to the chat's subscribers, from every tab of the user, after it's committed.
import { type AppApi, CurrentUser } from "@rp/shared/api.ts"
import type { ChatId, EntityId, NewVersion, SlotId } from "@rp/shared/chat.ts"
import { BranchSwitch, GenerationUnavailable } from "@rp/shared/chatApi.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect, Option, Stream } from "effect"
import { CacheWarmth } from "../chat/CacheWarmth.ts"
import { ChatHub } from "../chat/ChatHub.ts"
import { Generator } from "../chat/Generator.ts"
import { Generations } from "../chat/Generations.ts"
import { Reader, Writer } from "../db/Database.ts"
import { internal, toServerError } from "./internal.ts"

const userText = (content: string, origin: NewVersion["origin"], sourceVersionId?: NewVersion["sourceVersionId"]) => ({
  speakerEntityId: null,
  writer: "human" as const,
  content,
  status: "complete" as const,
  macroMode: "verbatim" as const,
  origin,
  ...(sourceVersionId ? { sourceVersionId } : {})
})

const generating = {
  speakerEntityId: null,
  writer: "model" as const,
  content: "",
  status: "generating" as const,
  macroMode: "verbatim" as const,
  origin: "generated" as const
}

export const makeChatHandlers = Effect.gen(function* () {
  const reader = yield* Reader
  const writer = yield* Writer
  const hub = yield* ChatHub
  const warmth = yield* CacheWarmth
  const generations = yield* Generations
  const generator = yield* Generator

  const userId = Effect.map(CurrentUser, (user) => user.id)

  const unavailable = new GenerationUnavailable({
    message: "This server has nothing to generate with."
  })
  const needGenerator = Option.isSome(generator) ? Effect.void : Effect.fail(unavailable)

  /** A slot as it is now, published to its chat. */
  const publishSlot = (user: UserId, slotId: SlotId) =>
    Effect.map(reader.GetSlot({ userId: user, slotId }), ({ chatId, entry }) => {
      hub.publish(chatId, { _tag: "Slot", entry })
      return entry
    })

  const publishChat = (user: UserId, chatId: ChatId) =>
    Effect.map(reader.GetChat({ userId: user, chatId }), (chat) => {
      hub.publish(chatId, { _tag: "Chat", chat })
      return chat
    })

  /** Stops the chat's generations whose versions went to the bin. */
  const stopDeleted = (user: UserId, chatId: ChatId) =>
    Effect.gen(function* () {
      const running = generations.runningIn(chatId)
      const live = new Set(
        running.length === 0 ? [] : yield* reader.LiveVersions({ userId: user, versionIds: running })
      )
      yield* Effect.forEach(running, (versionId) =>
        live.has(versionId) ? Effect.void : Effect.ignore(generations.stop(user, versionId))
      )
    })

  /**
   * After a delete within a chat: reload, the leaf may have moved, and generations under
   * what went are stopped. Delete handlers are uninterruptible, so a caller going away
   * can't skip this.
   */
  const afterDelete = (user: UserId, chatId: ChatId) =>
    Effect.gen(function* () {
      hub.publish(chatId, { _tag: "Reload" })
      // Any delete can evict an older shared dependency from the user's bin.
      yield* warmth.refreshUser(user)
      yield* stopDeleted(user, chatId)
      yield* publishChat(user, chatId).pipe(Effect.catchTag("NotFound", () => Effect.void))
    })

  /**
   * A message or a reply under `parentSlotId`, posted or queued behind a reply still
   * being written (DESIGN §2.2). A posted reply starts generating.
   */
  const sendOrQueue = (
    user: UserId,
    params: {
      readonly chatId: ChatId
      readonly parentSlotId: SlotId | null
      readonly branch: boolean
      readonly kind: "message" | "generate"
      readonly content: string
      readonly speakerEntityId: EntityId | null
      readonly replySpeakerEntityId: EntityId | null
      readonly direction: string | null
      readonly composer: { readonly draftId: string; readonly session: number } | undefined
    }
  ) =>
    Effect.gen(function* () {
      const { composer, ...send } = params
      const outcome = yield* writer.SendOrQueue({
        userId: user,
        ...send,
        // The composer draft the text was taken from (DESIGN §6.2).
        commitDraft: composer === undefined ? null : { draftId: composer.draftId, session: composer.session }
      })
      if (outcome._tag === "Queued") {
        hub.publish(params.chatId, { _tag: "Queue", queue: outcome.queue })
        return {
          _tag: "Queued" as const,
          queued: outcome.queued,
          queue: outcome.queue,
          draft: outcome.draft,
          recovered: outcome.recovered
        }
      }
      const { result } = outcome
      if (params.kind === "generate") {
        yield* generations.start({
          userId: user,
          chatId: params.chatId,
          slotId: result.slotId,
          versionId: result.version.id
        })
      }
      const entry = yield* publishSlot(user, result.slotId)
      hub.publish(params.chatId, { _tag: "Chat", chat: result.chat })
      return { _tag: "Posted" as const, entry, chat: result.chat, draft: result.draft, recovered: result.recovered }
    })

  const handlers = {
    ListChatSummaries: ({ chatIds }) =>
      Effect.flatMap(userId, (id) => reader.ChatSummaries({ userId: id, chatIds })).pipe(internal("ListChatSummaries")),
    ListChats: ({ limit, before, entityId }) =>
      Effect.flatMap(userId, (id) =>
        reader.ListChats({ userId: id, limit, before, ...(entityId ? { entityId } : {}) })
      ).pipe(internal("ListChats")),

    CreateChat: ({ title }) =>
      Effect.flatMap(userId, (id) =>
        writer.CreateChat({
          userId: id,
          kind: "rp",
          status: "active",
          title: title.trim(),
          participants: [],
          greeting: null
        })
      ).pipe(
        // No participants or greeting, so nothing it names can be missing.
        Effect.catchTag("NotFound", toServerError("CreateChat")),
        internal("CreateChat")
      ),

    GetChat: ({ chatId }) =>
      Effect.flatMap(userId, (id) => reader.GetChat({ userId: id, chatId })).pipe(internal("GetChat")),

    ReadPath: ({ chatId, leafSlotId, range, limit }) =>
      Effect.flatMap(userId, (id) => reader.ReadPath({ userId: id, chatId, leafSlotId, range, limit })).pipe(
        internal("ReadPath")
      ),

    ListVersions: ({ slotId }) =>
      Effect.flatMap(userId, (id) => reader.ListVersions({ userId: id, slotId })).pipe(internal("ListVersions")),

    SendMessage: ({ chatId, parentSlotId, branch, content, speakerEntityId, replySpeakerEntityId, composer }) =>
      Effect.flatMap(userId, (id) =>
        sendOrQueue(id, {
          chatId,
          parentSlotId,
          branch,
          kind: "message",
          content,
          speakerEntityId: speakerEntityId ?? null,
          replySpeakerEntityId: replySpeakerEntityId ?? null,
          direction: null,
          composer
        })
      ).pipe(internal("SendMessage")),

    // Once the version is written, its generation starts even if the caller has gone:
    // otherwise it would stay `generating` with nothing behind it.
    Generate: ({ chatId, parentSlotId, branch, speakerEntityId, direction, composer }) =>
      Effect.gen(function* () {
        yield* needGenerator
        const id = yield* userId
        return yield* sendOrQueue(id, {
          chatId,
          parentSlotId,
          branch,
          kind: "generate",
          content: "",
          speakerEntityId: speakerEntityId ?? null,
          replySpeakerEntityId: null,
          direction: direction ?? null,
          composer
        })
      }).pipe(Effect.uninterruptible, internal("Generate")),

    Regenerate: ({ slotId, expectedRowVersion, model }) =>
      Effect.gen(function* () {
        yield* needGenerator
        const id = yield* userId
        // A swipe keeps the speaker and the one-turn direction of the version it replaces
        // (DESIGN §2.2): the direction belongs to that turn, never to later ones.
        const { entry: before } = yield* reader.GetSlot({ userId: id, slotId })
        const added = yield* writer.AddSelectedVersion({
          userId: id,
          slotId,
          version: {
            ...generating,
            speakerEntityId: before.version.speakerEntityId,
            ...(before.version.direction ? { direction: before.version.direction } : {})
          },
          expectedRowVersion
        })
        yield* generations.start({
          userId: id,
          chatId: added.chatId,
          slotId,
          versionId: added.version.id,
          ...(model ? { model } : {})
        })
        const { entry } = yield* reader.GetSlot({ userId: id, slotId })
        hub.publish(added.chatId, { _tag: "Slot", entry })
        return entry
      }).pipe(Effect.uninterruptible, internal("Regenerate")),

    StopGeneration: ({ versionId }) =>
      Effect.flatMap(userId, (id) =>
        generations.stop(id, versionId).pipe(
          // A Stop that loses the race with the natural finish (or comes twice) gets the
          // version as saved, as long as it's the user's and done.
          Effect.catchTag("NotFound", (notFound) =>
            reader
              .GetVersion({ userId: id, versionId })
              .pipe(
                Effect.flatMap((version) =>
                  version.status === "generating" ? Effect.fail(notFound) : Effect.succeed(version)
                )
              )
          ),
          internal("StopGeneration")
        )
      ),

    // Selecting a finished version lets what was queued behind the slot post (DESIGN §2.2).
    SelectVersion: ({ slotId, versionId, expectedRowVersion }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const outcome = yield* writer.SelectAndDrain({ userId: id, slotId, versionId, expectedRowVersion })
        // The queue event first, in commit order (Generations.continueQueue).
        yield* generations.continueQueue(id, outcome)
        return yield* publishSlot(id, slotId)
      }).pipe(Effect.uninterruptible, internal("SelectVersion")),

    EditVersion: ({ slotId, sourceVersionId, content, expectedRowVersion }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const version = userText(content, "edited", sourceVersionId)
        yield* writer.AddSelectedVersion({ userId: id, slotId, version, expectedRowVersion })
        return yield* publishSlot(id, slotId)
      }).pipe(internal("EditVersion")),

    WriteVersion: ({ slotId, content, expectedRowVersion }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const version = userText(content, "user_written")
        yield* writer.AddSelectedVersion({ userId: id, slotId, version, expectedRowVersion })
        return yield* publishSlot(id, slotId)
      }).pipe(internal("WriteVersion")),

    AmendVersion: ({ versionId, content, expectedRowVersion }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const version = yield* writer.AmendVersion({ userId: id, versionId, content, expectedRowVersion })
        const { chatId } = yield* reader.GetSlot({ userId: id, slotId: version.slotId })
        hub.publish(chatId, { _tag: "Version", version })
        return version
      }).pipe(internal("AmendVersion")),

    DeleteChat: ({ chatId }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const item = yield* writer.DeleteChat({ userId: id, chatId })
        yield* stopDeleted(id, chatId)
        // After the stopped versions, the subscriptions end.
        hub.close(chatId, { _tag: "Deleted" })
        yield* warmth.refreshUser(id)
        return item
      }).pipe(Effect.uninterruptible, internal("DeleteChat")),

    DeleteMessage: ({ slotId }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const item = yield* writer.DeleteMessage({ userId: id, slotId })
        yield* afterDelete(id, item.origin.chatId as ChatId)
        return item
      }).pipe(Effect.uninterruptible, internal("DeleteMessage")),

    DeleteBranch: ({ slotId }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const item = yield* writer.DeleteBranch({ userId: id, slotId })
        yield* afterDelete(id, item.origin.chatId as ChatId)
        return item
      }).pipe(Effect.uninterruptible, internal("DeleteBranch")),

    DeleteVersion: ({ versionId }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const item = yield* writer.DeleteVersion({ userId: id, versionId })
        yield* afterDelete(id, item.origin.chatId as ChatId)
        return item
      }).pipe(Effect.uninterruptible, internal("DeleteVersion")),

    // The tip is read, and the leaf moved there only if the chat hasn't changed since: a
    // message arriving in between gets the tip read again.
    SwitchBranch: ({ chatId, slotId, index }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const target = yield* reader.BranchTip({ userId: id, chatId, slotId, index })
        const chat = yield* writer.SetActiveLeaf({
          userId: id,
          chatId,
          slotId: target.tipSlotId,
          expectedRowVersion: target.chatRowVersion
        })
        hub.publish(chatId, { _tag: "Chat", chat })
        return new BranchSwitch({ slotId: target.slotId, chat })
      }).pipe(Effect.retry({ times: 2, while: (error) => error._tag === "StaleWrite" }), internal("SwitchBranch")),

    GetNextContext: ({ chatId, leafSlotId }) =>
      Effect.flatMap(userId, (id) => reader.CacheWarmth({ userId: id, chatId, leafSlotId })).pipe(
        internal("GetNextContext")
      ),

    SubscribeChat: ({ chatId }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const id = yield* userId
          const queue = yield* hub.subscribe(chatId, () => ({ _tag: "Hello", live: generations.live(chatId) }))
          // Checked once subscribed, so a chat deleted in between can't leave a subscription
          // its close missed. Nothing is sent before it, so nothing reaches another user.
          yield* reader.GetChat({ userId: id, chatId })
          yield* warmth.watch(id, chatId)
          return Stream.fromQueue(queue)
        }).pipe(internal("SubscribeChat"))
      )
  } satisfies Partial<Parameters<typeof AppApi.of>[0]>
  return handlers
})
