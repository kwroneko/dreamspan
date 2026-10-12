// Chat RPC handlers (@rp/shared/chatApi.ts). Every handler acts as the authenticated user;
// storage enforces ownership, so another user's ids are NotFound. Each change is published
// to the chat's subscribers, from every tab of the user, after it's committed.
import { type AppApi, CurrentUser } from "@rp/shared/api.ts"
import type { ChatId, NewVersion, SlotId } from "@rp/shared/chat.ts"
import { GenerationUnavailable } from "@rp/shared/chatApi.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { ServerError } from "@rp/shared/errors.ts"
import { Effect, Option, Stream } from "effect"
import { RpcClientError } from "effect/rpc"
import { ChatHub } from "../chat/ChatHub.ts"
import { Generator } from "../chat/Generator.ts"
import { Generations } from "../chat/Generations.ts"
import { Reader, Writer } from "../db/Database.ts"
import { StorageError } from "../db/ops.ts"

/** Failures the client can't act on are logged here and reported without internals. */
const toServerError = (operation: string) => (error: unknown) =>
  Effect.logError(`${operation} failed`, error).pipe(
    Effect.andThen(Effect.fail(new ServerError({ message: `${operation} failed` })))
  )

type Internal = StorageError | RpcClientError.RpcClientError

const isInternal = <E>(error: E): error is Extract<E, Internal> =>
  error instanceof StorageError || error instanceof RpcClientError.RpcClientError

/** Storage and worker failures become ServerError; every other error keeps its tag. */
const internal =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, Exclude<E, Internal> | ServerError, R> =>
    Effect.catchIf(effect, isInternal, toServerError(operation)) as Effect.Effect<
      A,
      Exclude<E, Internal> | ServerError,
      R
    >

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
  const generations = yield* Generations
  const generator = yield* Generator

  const userId = Effect.map(CurrentUser, (user) => user.id)

  const unavailable = new GenerationUnavailable({
    message: "This server has nothing to generate with yet: the context assembler isn't built."
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
      yield* stopDeleted(user, chatId)
      yield* publishChat(user, chatId).pipe(Effect.catchTag("NotFound", () => Effect.void))
    })

  const append = (
    user: UserId,
    chatId: ChatId,
    parentSlotId: SlotId | null,
    branch: boolean,
    version: typeof NewVersion.Type
  ) =>
    Effect.gen(function* () {
      const result = yield* writer.AppendMessage({
        userId: user,
        chatId,
        parentSlotId,
        branch,
        version,
        commitDraft: null,
        // Provisional, until DESIGN §2.2 decides between queueing and cancelling: the one
        // place a message onto a reply still generating is refused.
        refuseWhileGenerating: true
      })
      const entry = yield* publishSlot(user, result.slotId)
      hub.publish(chatId, { _tag: "Chat", chat: result.chat })
      return { entry, chat: result.chat }
    })

  const handlers = {
    ListChats: ({ limit, before }) =>
      Effect.flatMap(userId, (id) => reader.ListChats({ userId: id, limit, before })).pipe(internal("ListChats")),

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

    SendMessage: ({ chatId, parentSlotId, branch, content }) =>
      Effect.flatMap(userId, (id) => append(id, chatId, parentSlotId, branch, userText(content, "user_written"))).pipe(
        internal("SendMessage")
      ),

    // Once the version is written, its generation starts even if the caller has gone:
    // otherwise it would stay `generating` with nothing behind it.
    Generate: ({ chatId, parentSlotId, branch }) =>
      Effect.gen(function* () {
        yield* needGenerator
        const id = yield* userId
        const result = yield* writer
          .AppendMessage({
            userId: id,
            chatId,
            parentSlotId,
            branch,
            version: generating,
            commitDraft: null
          })
          .pipe(Effect.catchTag("ChatBusy", (busy) => Effect.die(busy)))
        yield* generations.start({ userId: id, chatId, slotId: result.slotId, versionId: result.version.id })
        const entry = yield* publishSlot(id, result.slotId)
        hub.publish(chatId, { _tag: "Chat", chat: result.chat })
        return { entry, chat: result.chat }
      }).pipe(Effect.uninterruptible, internal("Generate")),

    Regenerate: ({ slotId, expectedRowVersion }) =>
      Effect.gen(function* () {
        yield* needGenerator
        const id = yield* userId
        const added = yield* writer.AddSelectedVersion({
          userId: id,
          slotId,
          version: generating,
          expectedRowVersion
        })
        yield* generations.start({ userId: id, chatId: added.chatId, slotId, versionId: added.version.id })
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

    SelectVersion: ({ slotId, versionId, expectedRowVersion }) =>
      Effect.gen(function* () {
        const id = yield* userId
        yield* writer.SelectVersion({ userId: id, slotId, versionId, expectedRowVersion })
        return yield* publishSlot(id, slotId)
      }).pipe(internal("SelectVersion")),

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

    SubscribeChat: ({ chatId }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const id = yield* userId
          const queue = yield* hub.subscribe(chatId, () => ({ _tag: "Hello", live: generations.live(chatId) }))
          // Checked once subscribed, so a chat deleted in between can't leave a subscription
          // its close missed. Nothing is sent before it, so nothing reaches another user.
          yield* reader.GetChat({ userId: id, chatId })
          return Stream.fromQueue(queue)
        }).pipe(internal("SubscribeChat"))
      )
  } satisfies Partial<Parameters<typeof AppApi.of>[0]>
  return handlers
})
