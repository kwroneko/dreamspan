// Chat RPC handlers (@rp/shared/chatApi.ts). Every handler acts as the authenticated user;
// storage enforces ownership, so another user's ids are NotFound. Each change is published
// to the chat's subscribers, from every tab of the user, after it's committed.
import { type AppApi, CurrentUser } from "@rp/shared/api.ts"
import type { ChatId, EntityId, NewVersion, PathEntry, SlotId } from "@rp/shared/chat.ts"
import { BranchSwitch, GenerationUnavailable, messageDraftKey, NotContinuable } from "@rp/shared/chatApi.ts"
import { TextTooLong } from "@rp/shared/composerApi.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { foldState } from "@rp/shared/state.ts"
import { Effect, Option, Stream } from "effect"
import { CacheWarmth } from "../chat/CacheWarmth.ts"
import { ChatHub } from "../chat/ChatHub.ts"
import { Generator } from "../chat/Generator.ts"
import { Generations } from "../chat/Generations.ts"
import { Reader, Writer } from "../db/Database.ts"
import { DraftTooLarge } from "../db/ops.ts"
import { internal, toServerError } from "./internal.ts"

const userText = (
  content: string,
  origin: NewVersion["origin"],
  speakerEntityId: EntityId | null,
  sourceVersionId?: NewVersion["sourceVersionId"]
) => ({
  speakerEntityId,
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

  /**
   * Whom a new model version of a message speaks as when the one it replaces names no one
   * (older text written before versions kept their speaker): another version's speaker, else
   * the first version's, else, on the user's side, the first card the user plays there, so
   * a version of the user's own turn is never written as a character (DESIGN §3.1).
   */
  const speakerOf = (user: UserId, chatId: ChatId, entry: PathEntry) =>
    Effect.gen(function* () {
      const versions = yield* reader.ListVersions({ userId: user, slotId: entry.slotId })
      const named = versions.find((v) => v.speakerEntityId !== null)?.speakerEntityId ?? entry.firstSpeakerEntityId
      if (named !== null || entry.side !== "user") return named
      const state = foldState(yield* reader.StateEventsAt({ userId: user, chatId, slotId: entry.parentSlotId }))
      return (state.playedByMe[0] as EntityId | undefined) ?? null
    })

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
    ListChats: ({ limit, before, entityId, search }) =>
      Effect.flatMap(userId, (id) =>
        reader.ListChats({
          userId: id,
          limit,
          before,
          ...(entityId ? { entityId } : {}),
          ...(search ? { search } : {})
        })
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

    RenameChat: ({ chatId, name }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const [chat] = yield* writer.RenameChats({ userId: id, chats: [{ chatId, from: null }], name })
        hub.publish(chatId, { _tag: "Chat", chat: chat! })
        return chat!
      }).pipe(internal("RenameChat")),

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
        const { chatId, entry: before } = yield* reader.GetSlot({ userId: id, slotId })
        const added = yield* writer.AddSelectedVersion({
          userId: id,
          slotId,
          version: {
            ...generating,
            speakerEntityId: before.version.speakerEntityId ?? (yield* speakerOf(id, chatId, before)),
            ...(before.version.direction ? { direction: before.version.direction } : {})
          },
          expectedRowVersion,
          ...(model ? { model } : {})
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

    // Continue (ST's, DESIGN §7.5): a new version that starts as the text continued and
    // streams on from its end, the old version left as it was. The slot is published before
    // the generation starts, so every tab has the starting text before the first delta.
    ContinueVersion: ({ versionId, expectedRowVersion }) =>
      Effect.gen(function* () {
        yield* needGenerator
        const id = yield* userId
        const source = yield* reader.GetVersion({ userId: id, versionId })
        const refuse = (message: string) => Effect.fail(new NotContinuable({ versionId, message }))
        if (source.writer !== "model") return yield* refuse("Only a reply the model wrote can be continued.")
        if (source.status === "generating") return yield* refuse("It's still being written.")
        if (source.content.trim() === "") return yield* refuse("It has no text to continue.")
        const added = yield* writer.AddSelectedVersion({
          userId: id,
          slotId: source.slotId,
          version: {
            ...generating,
            content: source.content,
            speakerEntityId: source.speakerEntityId,
            sourceVersionId: source.id,
            ...(source.direction ? { direction: source.direction } : {}),
            ...(source.reasoning ? { reasoning: source.reasoning } : {})
          },
          expectedRowVersion
        })
        const entry = yield* publishSlot(id, source.slotId)
        yield* generations.start({
          userId: id,
          chatId: added.chatId,
          slotId: source.slotId,
          versionId: added.version.id,
          initial: { text: added.version.content, reasoning: added.version.reasoning ?? "" }
        })
        return entry
      }).pipe(Effect.uninterruptible, internal("ContinueVersion")),

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

    // Starring and hiding a version change only the picker and the arrows, never the context.
    SetVersionFlags: ({ versionId, starred, hidden }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const { chatId, version } = yield* writer.SetVersionFlags({
          userId: id,
          versionId,
          ...(starred === undefined ? {} : { starred }),
          ...(hidden === undefined ? {} : { hidden })
        })
        hub.publish(chatId, { _tag: "Version", version })
        return version
      }).pipe(Effect.uninterruptible, internal("SetVersionFlags")),

    // Hiding is an edit (DESIGN §8): it changes what's sent next and starts nothing. The
    // slot's event also has the cache estimate read again (CacheWarmth listens).
    SetMessageHidden: ({ slotId, hidden }) =>
      Effect.gen(function* () {
        const id = yield* userId
        yield* writer.SetSlotHidden({ userId: id, slotId, hidden })
        return yield* publishSlot(id, slotId)
      }).pipe(Effect.uninterruptible, internal("SetMessageHidden")),

    // An edit or a version the user writes is still the message's speaker's, as a swipe is:
    // an edit its source's, a written version the one shown's.
    EditVersion: ({ slotId, sourceVersionId, content, expectedRowVersion, draft }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const source = yield* reader.GetVersion({ userId: id, versionId: sourceVersionId })
        const version = userText(content, "edited", source.speakerEntityId, sourceVersionId)
        yield* writer.AddSelectedVersion({
          userId: id,
          slotId,
          version,
          expectedRowVersion,
          commitDraft: draft ?? null
        })
        return yield* publishSlot(id, slotId)
      }).pipe(internal("EditVersion")),

    WriteVersion: ({ slotId, content, expectedRowVersion, draft }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const { entry } = yield* reader.GetSlot({ userId: id, slotId })
        const version = userText(content, "user_written", entry.version.speakerEntityId)
        yield* writer.AddSelectedVersion({
          userId: id,
          slotId,
          version,
          expectedRowVersion,
          commitDraft: draft ?? null
        })
        return yield* publishSlot(id, slotId)
      }).pipe(internal("WriteVersion")),

    MessageDrafts: ({ chatId }) =>
      Effect.gen(function* () {
        const id = yield* userId
        // Drafts are the user's own already; the chat must be too, as for every other read.
        yield* reader.GetChat({ userId: id, chatId })
        return yield* reader.ListMessageDrafts({ userId: id, chatId })
      }).pipe(internal("MessageDrafts")),

    SaveMessageDraft: ({ target, draftId, content, expectedRowVersion, expectedSession }) =>
      Effect.flatMap(userId, (id) =>
        writer.SaveDraft({
          userId: id,
          key: messageDraftKey(target),
          draftId,
          content,
          expectedRowVersion,
          expectedSession,
          baseRevision: null
        })
      ).pipe(
        Effect.catchIf(
          (error): error is DraftTooLarge => error instanceof DraftTooLarge,
          ({ length, max }) => Effect.fail(new TextTooLong({ length, max }))
        ),
        internal("SaveMessageDraft")
      ),

    DiscardMessageDraft: ({ target, draftId, expectedRowVersion }) =>
      Effect.flatMap(userId, (id) =>
        writer.ClearDraft({
          userId: id,
          key: messageDraftKey(target),
          draftId,
          outcome: "discarded",
          expectedRowVersion
        })
      ).pipe(internal("DiscardMessageDraft")),

    AmendVersion: ({ versionId, content, expectedRowVersion, draft }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const version = yield* writer.AmendVersion({
          userId: id,
          versionId,
          content,
          expectedRowVersion,
          commitDraft: draft ?? null
        })
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

    GetDisplayPrefs: () =>
      Effect.flatMap(userId, (id) => reader.GetDisplayPrefs({ userId: id })).pipe(internal("GetDisplayPrefs")),

    SetDisplayPrefs: ({ prefs }) =>
      Effect.flatMap(userId, (id) => writer.SetDisplayPrefs({ userId: id, prefs })).pipe(internal("SetDisplayPrefs")),
    ListBranches: ({ slotId }) =>
      Effect.flatMap(userId, (id) => reader.ListBranches({ userId: id, slotId })).pipe(internal("ListBranches")),

    NameBranch: ({ slotId, name }) =>
      Effect.gen(function* () {
        const id = yield* userId
        yield* writer.SetBranchName({ userId: id, slotId, name })
        return yield* publishSlot(id, slotId)
      }).pipe(internal("NameBranch")),

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
