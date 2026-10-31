// Chat RPC handlers (@rp/shared/chatApi.ts). Every handler acts as the authenticated user;
// storage enforces ownership, so another user's ids are NotFound. Each change is published
// to the chat's subscribers, from every tab of the user, after it's committed.
import { originalReply } from "@rp/shared/replySections.ts"
import { type AppApi, CurrentUser } from "@rp/shared/api.ts"
import type { ChatId, EntityId, ForkId, NewVersion, PathEntry, SlotId } from "@rp/shared/chat.ts"
import { BranchSwitch, GenerationUnavailable, messageDraftKey, NotContinuable } from "@rp/shared/chatApi.ts"
import { TextTooLong } from "@rp/shared/composerApi.ts"
import { NotFound } from "@rp/shared/errors.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { DraftHistoryPolicy } from "@rp/shared/drafts.ts"
import type { PresetPrompt, PromptOrderEntry } from "@rp/shared/docs/preset.ts"
import { conditionOf } from "@rp/shared/presetConditions.ts"
import { foldState, swappedCard } from "@rp/shared/state.ts"
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
      const versions = yield* reader.ListVersions({
        userId: user,
        slotId: entry.slotId,
        forkId: entry.shownForkId ?? null
      })
      const named = versions.find((v) => v.speakerEntityId !== null)?.speakerEntityId ?? entry.firstSpeakerEntityId
      if (named !== null || entry.side !== "user") return named
      const state = foldState(
        yield* reader.StateEventsAt({
          userId: user,
          chatId,
          slotId: entry.parentSlotId,
          forkId: entry.shownForkId ?? null
        })
      )
      return (state.playedByMe[0] as EntityId | undefined) ?? null
    })

  const speakerNow = (user: UserId, chatId: ChatId, entry: PathEntry, speaker: EntityId | null) =>
    Effect.map(
      reader.StateEventsAt({ userId: user, chatId, slotId: entry.parentSlotId, forkId: entry.shownForkId ?? null }),
      (events) => swappedCard(events, speaker) as EntityId | null
    )

  /**
   * A slot as it is now in a fork (null: the fork through it), published to its chat. Tabs
   * showing another fork read it again as theirs shows it (`PathEntry.shownForkId`).
   */
  const publishSlot = (user: UserId, slotId: SlotId, forkId: ForkId | null = null) =>
    Effect.map(reader.GetSlot({ userId: user, slotId, forkId }), ({ chatId, entry }) => {
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
      readonly forkId: ForkId | null
      readonly parentSlotId: SlotId | null
      readonly branch: boolean
      readonly kind: "message" | "generate"
      readonly imageDraftIds?: readonly string[]
      readonly images?: import("@rp/shared/chat.ts").MessageImages
      readonly content: string
      readonly speakerEntityId: EntityId | null
      readonly replySpeakerEntityId: EntityId | null
      /** A message that posts without a reply (every character muted, DESIGN §3.5). */
      readonly noReply?: boolean
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
          versionId: result.version.id,
          forkId: result.forkId
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

    ReadPath: ({ chatId, forkId, leafSlotId, range, limit }) =>
      Effect.flatMap(userId, (id) =>
        reader.ReadPath({ userId: id, chatId, forkId: forkId ?? null, leafSlotId, range, limit })
      ).pipe(internal("ReadPath")),

    ListVersions: ({ slotId, forkId }) =>
      Effect.flatMap(userId, (id) => reader.ListVersions({ userId: id, slotId, forkId: forkId ?? null })).pipe(
        internal("ListVersions")
      ),

    SendMessage: ({
      chatId,
      forkId,
      parentSlotId,
      branch,
      content,
      speakerEntityId,
      replySpeakerEntityId,
      images,
      imageDraftIds,
      reply,
      composer
    }) =>
      Effect.flatMap(userId, (id) =>
        sendOrQueue(id, {
          chatId,
          forkId: forkId ?? null,
          parentSlotId,
          branch,
          kind: "message",
          ...(images === undefined ? {} : { images }),
          ...(imageDraftIds === undefined ? {} : { imageDraftIds }),
          content,
          speakerEntityId: speakerEntityId ?? null,
          replySpeakerEntityId: replySpeakerEntityId ?? null,
          ...(reply === false ? { noReply: true } : {}),
          direction: null,
          composer
        })
      ).pipe(internal("SendMessage")),

    // Once the version is written, its generation starts even if the caller has gone:
    // otherwise it would stay `generating` with nothing behind it.
    Generate: ({ chatId, forkId, parentSlotId, branch, speakerEntityId, direction, composer }) =>
      Effect.gen(function* () {
        yield* needGenerator
        const id = yield* userId
        return yield* sendOrQueue(id, {
          chatId,
          forkId: forkId ?? null,
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

    Regenerate: ({ slotId, forkId, expectedRowVersion, model, direction }) =>
      Effect.gen(function* () {
        yield* needGenerator
        const id = yield* userId
        // A swipe keeps the speaker and the direction of the version it replaces (DESIGN §2.2,
        // guidance on swipes), unless a direction is given now: an empty one is none.
        const { chatId, entry: before } = yield* reader.GetSlot({ userId: id, slotId, forkId: forkId ?? null })
        const guidance = direction ?? before.version.direction
        const added = yield* writer.AddSelectedVersion({
          userId: id,
          slotId,
          forkId: forkId ?? null,
          version: {
            ...generating,
            ...(before.version.images === undefined ? {} : { images: before.version.images }),
            speakerEntityId: yield* speakerNow(
              id,
              chatId,
              before,
              before.version.speakerEntityId ?? (yield* speakerOf(id, chatId, before))
            ),
            ...(guidance?.trim() ? { direction: guidance } : {})
          },
          expectedRowVersion,
          ...(model ? { model } : {})
        })
        yield* generations.start({
          userId: id,
          chatId: added.chatId,
          slotId,
          versionId: added.version.id,
          forkId: added.forkId,
          ...(model ? { model } : {})
        })
        const { entry } = yield* reader.GetSlot({ userId: id, slotId, forkId: added.forkId })
        hub.publish(added.chatId, { _tag: "Slot", entry })
        return entry
      }).pipe(Effect.uninterruptible, internal("Regenerate")),

    // Continue (ST's, DESIGN §7.5): a new version that starts as the text continued and
    // streams on from its end, the old version left as it was. Whoever wrote the version
    // continued (an edit is the user's), the new one is the model's. The slot is published before
    // the generation starts, so every tab has the starting text before the first delta.
    ContinueVersion: ({ versionId, forkId, expectedRowVersion, direction }) =>
      Effect.gen(function* () {
        yield* needGenerator
        const id = yield* userId
        const source = yield* reader.GetVersion({ userId: id, versionId })
        const refuse = (message: string) => Effect.fail(new NotContinuable({ versionId, message }))
        if (source.status === "generating") return yield* refuse("It's still being written.")
        if (originalReply(source.content, source.replySections).trim() === "")
          return yield* refuse("It has no text to continue.")
        const { chatId, entry: before } = yield* reader.GetSlot({
          userId: id,
          slotId: source.slotId,
          forkId: forkId ?? null
        })
        const added = yield* writer.AddSelectedVersion({
          userId: id,
          slotId: source.slotId,
          forkId: forkId ?? null,
          version: {
            ...generating,
            content: source.content,
            speakerEntityId: yield* speakerNow(id, chatId, before, source.speakerEntityId),
            sourceVersionId: source.id,
            ...(direction?.trim() ? { direction } : {}),
            ...(source.reasoning ? { reasoning: source.reasoning } : {}),
            ...(source.replySections ? { replySections: source.replySections } : {})
          },
          expectedRowVersion
        })
        const entry = yield* publishSlot(id, source.slotId, added.forkId)
        yield* generations.start({
          userId: id,
          chatId: added.chatId,
          slotId: source.slotId,
          versionId: added.version.id,
          forkId: added.forkId,
          initial: {
            text: added.version.content,
            reasoning: added.version.reasoning ?? "",
            ...(added.version.replySections ? { sections: added.version.replySections } : {})
          }
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
    SelectVersion: ({ slotId, versionId, forkId, expectedVersionId }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const outcome = yield* writer.SelectAndDrain({
          userId: id,
          slotId,
          versionId,
          forkId: forkId ?? null,
          expectedVersionId
        })
        // The queue event first, in commit order (Generations.continueQueue).
        yield* generations.continueQueue(id, outcome)
        return yield* publishSlot(id, slotId, forkId ?? null)
      }).pipe(Effect.uninterruptible, internal("SelectVersion")),

    // Starring and hiding a version change only the picker and the arrows, never the context.
    // They're the fork's (spec/FORK-INDEPENDENCE-DELTA.md §2.2): tabs on another fork leave the event.
    SetVersionFlags: ({ versionId, forkId, starred, hidden }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const {
          chatId,
          forkId: fork,
          version
        } = yield* writer.SetVersionFlags({
          userId: id,
          versionId,
          forkId: forkId ?? null,
          ...(starred === undefined ? {} : { starred }),
          ...(hidden === undefined ? {} : { hidden })
        })
        hub.publish(chatId, { _tag: "Version", version, forkId: fork })
        return version
      }).pipe(Effect.uninterruptible, internal("SetVersionFlags")),

    // Hiding is an edit (DESIGN §8): it changes what's sent next and starts nothing. The
    // slot's event also has the cache estimate read again (CacheWarmth listens).
    SetMessageHidden: ({ slotId, forkId, hidden }) =>
      Effect.gen(function* () {
        const id = yield* userId
        yield* writer.SetSlotHidden({ userId: id, slotId, forkId: forkId ?? null, hidden })
        return yield* publishSlot(id, slotId, forkId ?? null)
      }).pipe(Effect.uninterruptible, internal("SetMessageHidden")),

    // Taking an image out is an edit too: it changes what's sent next and starts nothing.
    SetImageExcluded: ({ versionId, mediaId, forkId, excluded }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const written = yield* writer.SetImageExcluded({
          userId: id,
          versionId,
          mediaId,
          forkId: forkId ?? null,
          excluded
        })
        return yield* publishSlot(id, written.slotId, written.forkId)
      }).pipe(Effect.uninterruptible, internal("SetImageExcluded")),

    // An edit or a version the user writes is still the message's speaker's, as a swipe is:
    // an edit its source's, a written version the one shown's.
    EditVersion: ({ images, slotId, forkId, sourceVersionId, content, expectedRowVersion, draft }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const source = yield* reader.GetVersion({ userId: id, versionId: sourceVersionId })
        const version = userText(content, "edited", source.speakerEntityId, sourceVersionId)
        const added = yield* writer.AddSelectedVersion({
          userId: id,
          slotId,
          forkId: forkId ?? null,
          version: { ...version, ...(images === undefined ? {} : { images }) },
          expectedRowVersion,
          commitDraft: draft ?? null
        })
        return yield* publishSlot(id, slotId, added.forkId)
      }).pipe(internal("EditVersion")),

    // A wrong parse undone: the reply's text as it came, as an edit of it (model output stays frozen).
    ShowSectionsAsText: ({ versionId, forkId, expectedRowVersion }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const source = yield* reader.GetVersion({ userId: id, versionId })
        if (!source.replySections || source.status === "generating")
          return yield* new NotFound({ entity: "reply sections", id: versionId })
        const added = yield* writer.AddSelectedVersion({
          userId: id,
          slotId: source.slotId,
          forkId: forkId ?? null,
          version: {
            ...userText(
              originalReply(source.content, source.replySections),
              "edited",
              source.speakerEntityId,
              source.id
            ),
            ...(source.images ? { images: source.images } : {}),
            ...(source.reasoning ? { reasoning: source.reasoning } : {})
          },
          expectedRowVersion,
          commitDraft: null
        })
        return yield* publishSlot(id, source.slotId, added.forkId)
      }).pipe(internal("ShowSectionsAsText")),

    WriteVersion: ({ images, slotId, forkId, content, expectedRowVersion, draft }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const { entry } = yield* reader.GetSlot({ userId: id, slotId, forkId: forkId ?? null })
        const version = userText(content, "user_written", entry.version.speakerEntityId)
        const added = yield* writer.AddSelectedVersion({
          userId: id,
          slotId,
          forkId: forkId ?? null,
          version: {
            ...version,
            images: images ?? entry.version.images ?? []
          },
          expectedRowVersion,
          commitDraft: draft ?? null
        })
        return yield* publishSlot(id, slotId, added.forkId)
      }).pipe(internal("WriteVersion")),

    VersionAmendments: ({ versionId }) =>
      Effect.flatMap(userId, (id) => reader.VersionAmendments({ userId: id, versionId })).pipe(
        internal("VersionAmendments")
      ),

    RestoreVersionAmendment: ({ versionId, amendmentId, forkId, expectedRowVersion }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const states = yield* reader.VersionAmendments({ userId: id, versionId })
        const state = states.find((state) => state.id === amendmentId)
        if (!state) return yield* new NotFound({ entity: "version amendment", id: String(amendmentId) })
        const version = yield* writer.AmendVersion({
          userId: id,
          versionId,
          forkId,
          content: state.content,
          ...(state.images === undefined ? {} : { images: state.images }),
          expectedRowVersion,
          commitDraft: null
        })
        yield* publishSlot(id, version.slotId, forkId)
        return version
      }).pipe(internal("RestoreVersionAmendment")),

    MessageDraftHistory: ({ target, limit }) =>
      Effect.flatMap(userId, (id) => reader.DraftHistory({ userId: id, key: messageDraftKey(target), limit })).pipe(
        internal("MessageDraftHistory")
      ),

    RestoreMessageDraft: ({ target, ...restore }) =>
      Effect.flatMap(userId, (id) =>
        writer.RestoreDraftState({ userId: id, key: messageDraftKey(target), ...restore })
      ).pipe(internal("RestoreMessageDraft")),

    MessageDrafts: ({ chatId }) =>
      Effect.gen(function* () {
        const id = yield* userId
        // Drafts are the user's own already; the chat must be too, as for every other read.
        yield* reader.GetChat({ userId: id, chatId })
        return yield* reader.ListMessageDrafts({ userId: id, chatId })
      }).pipe(internal("MessageDrafts")),

    SaveMessageDraft: ({ target, draftId, content, images, expectedRowVersion, expectedSession }) =>
      Effect.flatMap(userId, (id) =>
        writer.SaveDraft({
          userId: id,
          key: messageDraftKey(target),
          draftId,
          content,
          ...(images === undefined ? {} : { images }),
          expectedRowVersion,
          expectedSession,
          baseRevision: target._tag === "Queue" ? String(target.rowVersion) : null
        })
      ).pipe(
        Effect.catchIf(
          (error): error is DraftTooLarge => error instanceof DraftTooLarge,
          ({ length, max }) => Effect.fail(new TextTooLong({ length, max }))
        ),
        internal("SaveMessageDraft")
      ),

    QueueDraftHistory: ({ chatId, queuedId }) =>
      Effect.flatMap(userId, (id) =>
        reader.DraftHistory({
          userId: id,
          key: messageDraftKey({ _tag: "Queue", chatId, queuedId, rowVersion: 0 }),
          limit: DraftHistoryPolicy.maxEntries + 1
        })
      ).pipe(internal("QueueDraftHistory")),
    RestoreQueueDraft: ({ chatId, queuedId, ...restore }) =>
      Effect.flatMap(userId, (id) =>
        writer.RestoreDraftState({
          userId: id,
          key: messageDraftKey({ _tag: "Queue", chatId, queuedId, rowVersion: 0 }),
          ...restore
        })
      ).pipe(internal("RestoreQueueDraft")),
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

    // An amend another fork shows gives this fork a copy in its place: its message changed
    // here only, and tabs on other forks read it again as theirs shows it.
    AmendVersion: ({ versionId, forkId, content, images, expectedRowVersion, draft }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const version = yield* writer.AmendVersion({
          userId: id,
          versionId,
          forkId: forkId ?? null,
          content,
          ...(images === undefined ? {} : { images }),
          expectedRowVersion,
          commitDraft: draft ?? null
        })
        const { chatId, entry } = yield* reader.GetSlot({ userId: id, slotId: version.slotId, forkId: forkId ?? null })
        if (version.id === versionId) hub.publish(chatId, { _tag: "Version", version })
        else {
          hub.publish(chatId, { _tag: "Slot", entry })
          hub.publish(chatId, {
            _tag: "Version",
            version,
            ...(entry.shownForkId === undefined ? {} : { forkId: entry.shownForkId })
          })
        }
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

    DeleteMessage: ({ slotId, forkId }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const item = yield* writer.DeleteMessage({ userId: id, slotId, forkId: forkId ?? null })
        yield* afterDelete(id, item.origin.chatId as ChatId)
        return item
      }).pipe(Effect.uninterruptible, internal("DeleteMessage")),

    DeleteFork: ({ forkId }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const item = yield* writer.DeleteFork({ userId: id, forkId })
        yield* afterDelete(id, item.origin.chatId as ChatId)
        return item
      }).pipe(Effect.uninterruptible, internal("DeleteFork")),

    DeleteVersion: ({ versionId, forkId }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const item = yield* writer.DeleteVersion({ userId: id, versionId, forkId: forkId ?? null })
        yield* afterDelete(id, item.origin.chatId as ChatId)
        return item
      }).pipe(Effect.uninterruptible, internal("DeleteVersion")),

    // Opens a fork; only one made for a line no fork followed is news to other tabs.
    SwitchBranch: ({ chatId, slotId, index, forkId }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const target = yield* writer.SwitchBranch({ userId: id, chatId, slotId, index, forkId: forkId ?? null })
        return new BranchSwitch(target)
      }).pipe(internal("SwitchBranch")),

    GetDisplayPrefs: () =>
      Effect.flatMap(userId, (id) => reader.GetDisplayPrefs({ userId: id })).pipe(internal("GetDisplayPrefs")),

    SetDisplayPrefs: ({ prefs }) =>
      Effect.flatMap(userId, (id) => writer.SetDisplayPrefs({ userId: id, prefs })).pipe(internal("SetDisplayPrefs")),

    // Once per preset per account (DESIGN §2.2), unless a prompt of its order is marked for
    // writing as {{user}}. The end-of-request text "when your card speaks" is outside the order
    // and has no condition, so it doesn't count: a preset with only that shows the notice once.
    ImpersonationNotice: () =>
      Effect.gen(function* () {
        const id = yield* userId
        const { preset } = yield* reader.GetGenerationDefaults({ userId: id })
        if (preset === null) return { show: false, preset }
        const { doc } = yield* reader.OpenEditor({ userId: id, refId: preset })
        const enabled = new Set(
          ((doc.order ?? []) as ReadonlyArray<PromptOrderEntry>).filter((e) => e.enabled).map((e) => e.identifier)
        )
        // A prompt only for writing as {{user}}: by its condition, or its ST triggers.
        const marked = ((doc.prompts ?? []) as ReadonlyArray<PresetPrompt>).some(
          (p) =>
            enabled.has(p.identifier) &&
            (conditionOf(p) === "as_user" ||
              (p.injection_trigger.length > 0 && p.injection_trigger.every((t) => t === "impersonate")))
        )
        if (marked) return { show: false, preset }
        return { show: yield* writer.MarkNoticeShown({ userId: id, notice: "impersonation", key: preset }), preset }
      }).pipe(
        Effect.catchTag("NotFound", () => Effect.succeed({ show: false, preset: null })),
        internal("ImpersonationNotice")
      ),
    ListBranches: ({ slotId, forkId }) =>
      Effect.flatMap(userId, (id) => reader.ListBranches({ userId: id, slotId, forkId: forkId ?? null })).pipe(
        internal("ListBranches")
      ),

    ListForks: ({ chatId }) =>
      Effect.flatMap(userId, (id) => reader.ListForks({ userId: id, chatId })).pipe(internal("ListForks")),

    PreviewForkNotes: (payload) =>
      Effect.flatMap(userId, (id) => reader.PreviewForkNotes({ userId: id, ...payload })).pipe(
        internal("PreviewForkNotes")
      ),

    CreateFork: ({ chatId, fromForkId, atSlotId, notes, name }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const made = yield* writer.CreateFork({
          userId: id,
          chatId,
          fromForkId,
          atSlotId,
          ...(notes ? { notes } : {}),
          ...(name === undefined ? {} : { name })
        })
        hub.publish(chatId, { _tag: "Chat", chat: made.chat })
        return made
      }).pipe(internal("CreateFork")),

    // The fork's first message shows its name among the alternates: subscribers get it again.
    NameFork: ({ forkId, name }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const named = yield* writer.SetForkName({ userId: id, forkId, name })
        if (named.startSlotId !== null)
          yield* publishSlot(id, named.startSlotId).pipe(Effect.catchTag("NotFound", () => Effect.void))
        return named.fork
      }).pipe(internal("NameFork")),

    PinFork: ({ forkId, pinned }) =>
      Effect.flatMap(userId, (id) => writer.SetForkPinned({ userId: id, forkId, pinned })).pipe(internal("PinFork")),

    GetNextContext: ({ chatId, leafSlotId, forkId }) =>
      Effect.flatMap(userId, (id) =>
        reader.CacheWarmth({ userId: id, chatId, leafSlotId, forkId: forkId ?? null })
      ).pipe(
        // What to count is the server's own business (ImageTokenCounts).
        Effect.map(({ uncounted: _, ...next }) => next),
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
