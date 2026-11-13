// The chat RPCs (DESIGN §3, DATA-MODEL §4), merged into AppApi. Writes that change a
// selection or a text carry the row version the client saw (StaleWrite otherwise); a new
// message names the tip it was written under (LeafMoved otherwise).
import { Schema } from "effect"
import { RolloutStep } from "./agent.ts"
import { Rpc, RpcGroup } from "effect/rpc"
import { BinItem, CannotDeleteLastFork } from "./bin.ts"
import {
  MessageImages,
  Chat,
  ChatId,
  ChatSummary,
  EntityId,
  Fork,
  ForkId,
  PathEntry,
  QueuedMessage,
  SlotId,
  StoryAtField,
  Version,
  VersionId
} from "./chat.ts"
import { LeafMoved, NotFound, ServerError, StaleWrite } from "./errors.ts"
import { ComposerImageIds, ComposerChoice, TextTooLong } from "./composerApi.ts"
import {
  ObservedDeletion,
  Draft,
  DraftHistoryPolicy,
  DraftKey,
  DraftRestore,
  DraftState,
  insertDraftKey
} from "./drafts.ts"
import { NextContext } from "./inspectorApi.ts"
import { ModelChoice } from "./lcmSettings.ts"
import { RefId } from "./library.ts"
import { RawText } from "./regexScripts.ts"

/** Earlier saved text of a human-written version, newest first. */
export const VersionAmendment = Schema.Struct({
  id: Schema.Int,
  content: Schema.String,
  at: Schema.Number,
  /** The complete image set it had before this amendment, including text-only amendments. */
  images: Schema.optionalKey(MessageImages)
})
export type VersionAmendment = typeof VersionAmendment.Type

/** Generation needs a generator, and this server has none (only tests run one without). */
export class GenerationUnavailable extends Schema.TaggedError<GenerationUnavailable>()("GenerationUnavailable", {
  message: Schema.String
}) {}

/** Only a finished user-written version is amended in place; others get a new version (DESIGN §3.1). */
export class NotAmendable extends Schema.TaggedError<NotAmendable>()("NotAmendable", {
  versionId: Schema.String
}) {}

/**
 * Continue extends only a finished model-written version with text (ST's Continue, DESIGN
 * §7.5): one still generating, a user's, or an empty one can't be.
 */
export class NotContinuable extends Schema.TaggedError<NotContinuable>()("NotContinuable", {
  versionId: Schema.String,
  message: Schema.String
}) {}

/**
 * How streamed reasoning shows while a reply is written (DESIGN §7.4): open, or folded.
 * Collapsing or expanding it during a run makes that the user's choice from then on.
 * Finished replies show it folded either way.
 */
export const ReasoningDisplay = Schema.Literals(["expanded", "collapsed"])
export type ReasoningDisplay = typeof ReasoningDisplay.Type

/**
 * The chat column's widest, in CSS px (ST's Chat Width; owner 2026-11-01). ST's slider is
 * 25–100 % of the screen; this one follows the account to every screen, so it's a width the
 * column never exceeds and narrower screens fill: the top of the range is the full width.
 */
export const CHAT_WIDTH = { min: 480, max: 3840, step: 40, default: 1200 } as const

/**
 * The sorts of a preset list: by name (A–Z), last modified, last used. The list's fourth view,
 * Archived, isn't one: it always sorts by most recently archived and is never remembered.
 */
export const PresetSort = Schema.Literals(["name", "modified", "used"])
export type PresetSort = typeof PresetSort.Type

/** The sorts of an editor's lorebook, note or snippet switcher: by name (A–Z), last edited. */
export const DocumentSort = Schema.Literals(["name", "modified"])
export type DocumentSort = typeof DocumentSort.Type

/**
 * The card editor's header switcher: its sort (the card lists' four), the other way round from
 * the sort's own, and Include personas. Its filter starts afresh each time, as the lists' does.
 */
export const CardSwitcherView = Schema.Struct({
  sort: Schema.Literals(["recent", "created", "added", "name"]),
  reversed: Schema.Boolean,
  withPersonas: Schema.Boolean
})
export type CardSwitcherView = typeof CardSwitcherView.Type

/** The user's on/off choices by a registered part's id, over each part's default. */
const choicesById = Schema.Record(Schema.String, Schema.Boolean).check(
  Schema.isMaxProperties(200),
  Schema.makeFilter((choices: Record<string, boolean>) => Object.keys(choices).every((id) => id.length <= 200), {
    expected: "ids of at most 200 characters"
  })
)
/** The user's display choices that follow them across devices (`settings`). */
const messageColor = Schema.NullOr(Schema.String.check(Schema.isPattern(/^#[\da-f]{6}$/i)))
const displayFields = {
  mainTextColor: messageColor,
  italicsTextColor: messageColor,
  underlineTextColor: messageColor,
  quoteTextColor: messageColor,
  reasoning: ReasoningDisplay,
  /** An agent reply's steps while it's written, open or folded, as reasoning's (DESIGN §7.4). */
  steps: ReasoningDisplay,
  portraitSize: Schema.Literals(["small", "default", "large", "largest"]),
  timeline: Schema.Literals(["originals", "summaries"]),
  coverageRail: Schema.Boolean,
  outputMacros: Schema.Boolean,
  displayRegex: Schema.Boolean,
  /** "Show HTML as formatting" (spec/HTML-MESSAGES.md §3.1): off, a message's HTML shows as text. */
  htmlFormatting: Schema.Boolean,
  /**
   * "Run panels in the last N messages" (spec/HTML-MESSAGES.md §3.3): document blocks in older
   * messages wait for Run panel; null runs them in every message.
   */
  panelDepth: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 }))),
  enterSends: Schema.Literals(["automatic", "always", "never"]),
  chatWidth: Schema.Int.check(Schema.isBetween({ minimum: CHAT_WIDTH.min, maximum: CHAT_WIDTH.max })),
  /** How preset lists sort (the composer's picker, the Prompt preset tab's, the library's). */
  presetSort: PresetSort,
  /** How model lists sort (the composer's picker and the Model tab's). */
  modelSort: Schema.Literals(["name", "used"]),
  /** Model choices keyed by the connection/model pair, shared by all model pickers. */
  modelPins: Schema.Record(Schema.String, Schema.Boolean).check(Schema.isMaxProperties(500)),
  modelRecent: Schema.Record(Schema.String, Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))).check(
    Schema.isMaxProperties(100)
  ),
  /** How the editors' header switchers sort lorebooks, notes and snippets, each kind its own. */
  lorebookSort: DocumentSort,
  noteSort: DocumentSort,
  snippetSort: DocumentSort,
  /** The card editor's header switcher's sort, direction and Include personas. */
  cardSwitcher: CardSwitcherView,
  sidebarCards: CardSwitcherView,
  homeCards: CardSwitcherView,
  castCards: CardSwitcherView,
  /**
   * "Only keep one image open at a time" (owner, 2026-11-02): a portrait's click replaces the
   * one beside the chat instead of opening on top of it.
   */
  singlePortrait: Schema.Boolean,
  /**
   * Which message actions show as buttons on a message, by action id: the user's choices
   * over each action's default. An id no action has is kept and ignored.
   */
  messageToolbar: choicesById,
  /**
   * Which details show on a message (its time, model, number, generation time, tokens), by
   * the detail's id (messageDetails.tsx): false hides one. An id no detail has is kept and ignored.
   */
  dismissedInfo: choicesById,
  messageDetails: choicesById
}
export const DisplayPrefs = Schema.Struct(displayFields)
/** Writes merge only the named choices, so independent controls never reset each other. */
export const DisplayPrefsChange = Schema.Struct({
  mainTextColor: Schema.optionalKey(displayFields.mainTextColor),
  italicsTextColor: Schema.optionalKey(displayFields.italicsTextColor),
  underlineTextColor: Schema.optionalKey(displayFields.underlineTextColor),
  quoteTextColor: Schema.optionalKey(displayFields.quoteTextColor),
  reasoning: Schema.optionalKey(displayFields.reasoning),
  steps: Schema.optionalKey(displayFields.steps),
  portraitSize: Schema.optionalKey(displayFields.portraitSize),
  timeline: Schema.optionalKey(displayFields.timeline),
  coverageRail: Schema.optionalKey(displayFields.coverageRail),
  outputMacros: Schema.optionalKey(displayFields.outputMacros),
  displayRegex: Schema.optionalKey(displayFields.displayRegex),
  htmlFormatting: Schema.optionalKey(displayFields.htmlFormatting),
  panelDepth: Schema.optionalKey(displayFields.panelDepth),
  enterSends: Schema.optionalKey(displayFields.enterSends),
  chatWidth: Schema.optionalKey(displayFields.chatWidth),
  presetSort: Schema.optionalKey(displayFields.presetSort),
  modelSort: Schema.optionalKey(displayFields.modelSort),
  modelPins: Schema.optionalKey(displayFields.modelPins),
  modelRecent: Schema.optionalKey(displayFields.modelRecent),
  lorebookSort: Schema.optionalKey(displayFields.lorebookSort),
  noteSort: Schema.optionalKey(displayFields.noteSort),
  snippetSort: Schema.optionalKey(displayFields.snippetSort),
  cardSwitcher: Schema.optionalKey(displayFields.cardSwitcher),
  sidebarCards: Schema.optionalKey(displayFields.sidebarCards),
  homeCards: Schema.optionalKey(displayFields.homeCards),
  castCards: Schema.optionalKey(displayFields.castCards),
  singlePortrait: Schema.optionalKey(displayFields.singlePortrait),
  /** Merged by id with what's stored, so a write names only the choices it changes. */
  messageToolbar: Schema.optionalKey(displayFields.messageToolbar),
  /** Merged by id with what's stored, as the message toolbar's are. */
  dismissedInfo: Schema.optionalKey(displayFields.dismissedInfo),
  messageDetails: Schema.optionalKey(displayFields.messageDetails)
})
export type DisplayPrefsChange = typeof DisplayPrefsChange.Type
export const DEFAULT_DISPLAY_PREFS: DisplayPrefs = {
  mainTextColor: null,
  italicsTextColor: null,
  underlineTextColor: null,
  quoteTextColor: null,
  reasoning: "expanded",
  steps: "expanded",
  portraitSize: "default",
  timeline: "originals",
  coverageRail: false,
  outputMacros: false,
  displayRegex: true,
  htmlFormatting: true,
  panelDepth: null,
  enterSends: "automatic",
  chatWidth: CHAT_WIDTH.default,
  presetSort: "name",
  modelSort: "name",
  modelPins: {},
  modelRecent: {},
  lorebookSort: "name",
  noteSort: "name",
  snippetSort: "name",
  cardSwitcher: { sort: "recent", reversed: false, withPersonas: false },
  sidebarCards: { sort: "recent", reversed: false, withPersonas: false },
  homeCards: { sort: "recent", reversed: false, withPersonas: false },
  castCards: { sort: "recent", reversed: false, withPersonas: false },
  singlePortrait: false,
  messageToolbar: {},
  dismissedInfo: {},
  messageDetails: {}
}
export type DisplayPrefs = typeof DisplayPrefs.Type

/** The largest window one ReadPath returns. */
const MAX_WINDOW = 500

/**
 * Which part of a path to read. `Older` and `Newer` continue from a window's cursors:
 * `Older` reads the window ending at `from` (inclusive), `Newer` the one starting below
 * `after`. `Around` opens at a slot, about half the window on each side.
 */
export const PathRange = Schema.Union([
  Schema.TaggedStruct("Bottom", {}),
  Schema.TaggedStruct("Older", { from: SlotId }),
  Schema.TaggedStruct("Newer", { after: SlotId }),
  Schema.TaggedStruct("Around", { slot: SlotId })
])
export type PathRange = typeof PathRange.Type

/**
 * A window of a path, root to leaf order. Deleted messages are walked through but not
 * returned, so a window can be short or empty while the cursors still move on.
 */
export class PathWindow extends Schema.Class<PathWindow>("PathWindow")({
  /**
   * The path's leaf. For `Around` a slot that isn't on the asked path opens the path
   * through it instead, continuing on its latest replies, and this says which.
   */
  leafSlotId: Schema.NullOr(SlotId),
  /** The fork read; for `Around`, the fork opened instead. Null for a path read by its leaf. */
  forkId: Schema.NullOr(ForkId),
  entries: Schema.Array(PathEntry),
  /** Where the next older window ends; null at the root. */
  older: Schema.NullOr(SlotId),
  /** Where the next newer window starts below; null at the leaf. */
  newer: Schema.NullOr(SlotId)
}) {}

const LiveReplace = Schema.optionalKey(Schema.Boolean)

/** Pushed to a chat's subscribers. Streamed text comes as deltas, never as whole messages. */
export const ChatEvent = Schema.Union([
  /** The first event of every subscription, with the text so far of each version generating now. */
  Schema.TaggedStruct("Hello", {
    live: Schema.Array(
      Schema.Struct({
        versionId: VersionId,
        text: Schema.String,
        waitingCache: Schema.optionalKey(Schema.Boolean),
        /** The reasoning streamed so far, when there is any. */
        reasoning: Schema.optionalKey(Schema.String),
        /** The reply sections' panel text streamed so far, when there is any (spec/REPLY-SECTIONS.md). */
        sections: Schema.optionalKey(Schema.String),
        /** An agent reply's steps so far, when it has any (spec/AGENTIC.md §5.1). */
        steps: Schema.optionalKey(Schema.Array(RolloutStep))
      })
    )
  }),
  /**
   * Text appended to a generating version at `offset`, so a client can tell a repeat from a gap.
   * `replace`: the shown text from `offset` on is now `text`, as regex scripts rewrote the text
   * so far (ARCHITECTURE §12, "Live rewrites"); the text may get shorter.
   */
  Schema.TaggedStruct("Delta", { versionId: VersionId, offset: Schema.Int, text: Schema.String, replace: LiveReplace }),
  /** A generating agent reply's steps, all of them as they stand (spec/AGENTIC.md §5.1). */
  Schema.TaggedStruct("Steps", { versionId: VersionId, steps: Schema.Array(RolloutStep) }),
  /** Reasoning appended to a generating version at `offset`, as `Delta` is for its text. */
  Schema.TaggedStruct("Reasoning", {
    versionId: VersionId,
    offset: Schema.Int,
    text: Schema.String,
    replace: LiveReplace
  }),
  /** Reply-section text appended at `offset` of the panel's text (`sectionsDisplay`), as `Delta` is. */
  Schema.TaggedStruct("Section", {
    versionId: VersionId,
    offset: Schema.Int,
    text: Schema.String,
    replace: LiveReplace
  }),
  Schema.TaggedStruct("WaitingCache", { versionId: VersionId, waiting: Schema.Boolean }),
  /** A slot was added, or its selection or versions changed. */
  Schema.TaggedStruct("Slot", { entry: PathEntry }),
  /**
   * A version's text, status or flags changed: a generation ended, it was amended, or starred.
   * With `forkId`, as that fork shows it: tabs on another fork leave it.
   */
  Schema.TaggedStruct("Version", { version: Version, forkId: Schema.optionalKey(ForkId) }),
  /** The chat changed: its active leaf, title or last message. */
  Schema.TaggedStruct("Chat", { chat: Chat }),
  /** Something was deleted: windows read before it are out of date. */
  Schema.TaggedStruct("Reload", { forkId: Schema.optionalKey(ForkId) }),
  /** The chat went to the bin. It's the subscription's last event. */
  Schema.TaggedStruct("Deleted", {}),
  /** The chat's send queue changed: every entry still waiting, in order. */
  Schema.TaggedStruct("Queue", { queue: Schema.Array(QueuedMessage) }),
  /** Chat state changed (participants, presence, settings): read it again. */
  Schema.TaggedStruct("State", { forkId: Schema.optionalKey(ForkId) }),
  /** The chat's summaries changed (made, edited, selected, failed, asked for again) or LCM was switched: read GetLcmState again. */
  Schema.TaggedStruct("Lcm", { forkId: Schema.optionalKey(ForkId) }),
  /** The cache-warmth estimate changed; null when there's none to show (DESIGN §5.5). */
  Schema.TaggedStruct("Cache", NextContext.fields),
  /** A composer's speaker or reply choice changed, in this tab or another. */
  Schema.TaggedStruct("ComposerChoice", { choice: ComposerChoice })
])
export type ChatEvent = typeof ChatEvent.Type

/** The note comparison changed while the fork dialog was open. Reload before choosing. */
export class ForkNotesChanged extends Schema.TaggedError<ForkNotesChanged>()("ForkNotesChanged", {
  message: Schema.String
}) {}

const ForkNoteState = Schema.Struct({ revision: Schema.String, content: Schema.String, enabled: Schema.Boolean })
export const ForkNote = Schema.Struct({
  note: EntityId,
  title: Schema.String,
  owner: Schema.String,
  card: Schema.Boolean,
  then: ForkNoteState,
  now: ForkNoteState,
  /**
   * A chat note's unsaved text on the branch forked from, when it differs from `now`: the
   * latest state, so "As it is now" takes it to the new branch, still unsaved, and "As it was
   * then" leaves it where it was typed (owner, 2026-11-02, and DESIGN §4.1).
   */
  unsaved: Schema.optionalKey(Schema.String)
})
export type ForkNote = typeof ForkNote.Type
export const ForkNoteSelection = Schema.Struct({
  /** The exact comparison reviewed by the user, checked again inside the write transaction. */
  comparison: Schema.String,
  choices: Schema.Array(Schema.Struct({ note: EntityId, choice: Schema.Literals(["then", "now"]) }))
})
export type ForkNoteSelection = typeof ForkNoteSelection.Type

const Errors = [NotFound, ServerError] as const
const WriteErrors = [NotFound, StaleWrite, ServerError] as const

/**
 * The composer draft (composerApi.ts) the text was taken from: its id, the session it was
 * typed in, and exactly the text taken. The draft is committed in the same transaction as
 * the send only if it still holds that text, so a reload never shows text already sent
 * (DESIGN §6.2) and a send never ends text it didn't take.
 */
const ComposerCommit = Schema.optionalKey(Schema.Struct({ draftId: Schema.String, session: Schema.Int }))

/**
 * A message editor's draft (DESIGN §6.2): the edit of a version, or a version of a
 * message the user is writing. The text typed is saved to it as in every other field,
 * so it survives a reload, and an edit or written version that saves it names it (by id
 * and session) to commit it with exactly the text saved.
 */
export const MessageDraftTarget = Schema.Union([
  Schema.TaggedStruct("Edit", { versionId: VersionId }),
  Schema.TaggedStruct("Write", { slotId: SlotId }),
  Schema.TaggedStruct("Queue", { chatId: ChatId, queuedId: Schema.String, rowVersion: Schema.Int }),
  /** A message being inserted below `anchor` (null: above the first message), spec/MESSAGE-INSERT.md §4.2. */
  Schema.TaggedStruct("Insert", { chatId: ChatId, forkId: ForkId, anchor: Schema.NullOr(SlotId) })
])
export type MessageDraftTarget = typeof MessageDraftTarget.Type

/** A message editor's draft: an edit's is keyed by the version edited, a written version's by the slot. */
export const messageDraftKey = (target: MessageDraftTarget) =>
  target._tag === "Edit"
    ? new DraftKey({ targetKind: "version_edit", targetId: target.versionId, field: "" })
    : target._tag === "Write"
      ? new DraftKey({ targetKind: "scratchpad", targetId: target.slotId, field: "" })
      : target._tag === "Queue"
        ? new DraftKey({ targetKind: "queue_edit", targetId: target.chatId, field: target.queuedId })
        : insertDraftKey(target.chatId, target.forkId, target.anchor)

/**
 * Text typed into a message editor, onto the draft as the tab last saw it (null before it
 * had one). Also what a browser copy replays (`messages` in `POST /library/drafts`).
 */
export const MessageDraftSave = Schema.Struct({
  target: MessageDraftTarget,
  observedDeletion: Schema.optionalKey(ObservedDeletion),
  draftId: Schema.NullOr(Schema.String),
  content: Schema.String,
  images: Schema.optionalKey(MessageImages),
  expectedRowVersion: Schema.NullOr(Schema.Int),
  expectedSession: Schema.NullOr(Schema.Int)
})

const DraftCommit = Schema.optionalKey(Schema.Struct({ draftId: Schema.String, session: Schema.Int }))

/** Where a branch switch went: the sibling, and the fork to open through it. */
export class BranchSwitch extends Schema.Class<BranchSwitch>("BranchSwitch")({
  slotId: SlotId,
  fork: Fork,
  chat: Chat
}) {}

/**
 * The composer draft the text came from, as the send left it: committed, or still active
 * with another tab's newer text (§3.10); null without `composer`. `recovered` counts the
 * earlier texts of its session that committing it sent to the bin's recovered texts.
 */
const Sent = { draft: Schema.NullOr(Draft), recovered: Schema.Int }

/**
 * What a send or a Generate did: posted at once, or queued behind a reply still being
 * written (DESIGN §2.2), with every entry now waiting in the chat.
 */
export const SendResult = Schema.Union([
  Schema.TaggedStruct("Posted", { entry: PathEntry, chat: Chat, ...Sent }),
  Schema.TaggedStruct("Queued", { queued: QueuedMessage, queue: Schema.Array(QueuedMessage), ...Sent })
])
export type SendResult = typeof SendResult.Type

/**
 * Where a page of chats ends: its last chat's last message time (else its creation time)
 * and id; `empty` when that chat has no message (a card's list puts those last).
 */
export const ChatCursor = Schema.Struct({ at: Schema.Number, id: ChatId, empty: Schema.optionalKey(Schema.Boolean) })

/** The cursor after `chat` in a list of chats. */
export const chatCursor = (chat: Pick<Chat, "id" | "createdAt" | "lastMessageAt">) => ({
  at: chat.lastMessageAt ?? chat.createdAt,
  id: chat.id,
  empty: chat.lastMessageAt === null
})

/** A name the user gives a chat or a group (RenameChat, RenameGroup); empty: the automatic name. */
export const ChatNameInput = Schema.String.check(Schema.isMaxLength(200))

/** A name the user gives a fork (NameFork); empty: unnamed again. */
const BranchNameInput = Schema.String.check(Schema.isMaxLength(100))

/** One of the alternates at a place the path branches, as the header's branch menu lists it. */
export class Branch extends Schema.Class<Branch>("Branch")({
  /** The message that starts it. */
  slotId: SlotId,
  /** Its place among the alternates, oldest first (`PathEntry.branchIndex`). */
  index: Schema.Int,
  /** Its name; null when it has none. */
  name: Schema.NullOr(Schema.String),
  /** The start of its first message's text; empty for a message deleted on its own. */
  preview: Schema.String
}) {}

/** Text to find chats by (ListChats). */
export const ChatSearch = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))

export class ChatApi extends RpcGroup.make(
  /**
   * The user's chats, most recent first. `before` is the last chat of the previous page.
   * With `entityId`, only the chats that card joined (a card's page), those with a message
   * first; NotFound if the card isn't the user's. With `search`, only the chats whose title,
   * or the name of a card in which, has that text.
   */
  Rpc.make("ListChats", {
    payload: {
      limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })),
      before: Schema.NullOr(ChatCursor),
      entityId: Schema.optionalKey(EntityId),
      search: Schema.optionalKey(ChatSearch)
    },
    success: Schema.Array(Chat),
    error: Schema.Union([...Errors])
  }),
  /** The chat list's details of these chats (cast, message count, last message); others' are left out. */
  Rpc.make("ListChatSummaries", {
    payload: { chatIds: Schema.Array(ChatId).check(Schema.isMaxLength(200)) },
    success: Schema.Array(ChatSummary),
    error: ServerError
  }),
  Rpc.make("CreateChat", { payload: { title: Schema.String }, success: Chat, error: ServerError }),
  /**
   * Names a chat (DESIGN §2.1): its title becomes the name, and a chat imported from ST keeps
   * the day ST started it. An empty name gives back the automatic one. Open tabs get `Chat`.
   * A chat of a group leaves it for a group of its own name (RenameGroup renames them all).
   */
  Rpc.make("RenameChat", {
    payload: { chatId: ChatId, name: ChatNameInput },
    success: Chat,
    error: Schema.Union([...Errors])
  }),
  Rpc.make("GetChat", { payload: { chatId: ChatId }, success: Chat, error: Schema.Union([...Errors]) }),
  /**
   * A window of fork `forkId`'s path (absent or null: the chat's current fork), or, when
   * `leafSlotId` is given, of the path ending there.
   */
  Rpc.make("ReadPath", {
    payload: {
      chatId: ChatId,
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      leafSlotId: Schema.NullOr(SlotId),
      range: PathRange,
      limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_WINDOW }))
    },
    success: PathWindow,
    error: Schema.Union([...Errors])
  }),
  /**
   * A slot's versions, for the version picker, as fork `forkId` shows them (absent or null:
   * the fork through the slot): a copy it amended in its original's place, with its stars and
   * picker flags.
   */
  Rpc.make("ListVersions", {
    payload: { slotId: SlotId, forkId: Schema.optionalKey(Schema.NullOr(ForkId)) },
    success: Schema.Array(Version),
    error: Schema.Union([...Errors])
  }),
  /**
   * The user's message under `parentSlotId` in fork `forkId` (absent or null: the current
   * one), as `speakerEntityId` (Send as X); the fork becomes current. Without `branch`, the
   * parent must be the fork's tip (LeafMoved otherwise); with it, any slot, starting a fork
   * there (DESIGN §3.2). Onto a reply still being written, it's queued and posts when that
   * reply ends (DESIGN §2.2), followed by a reply of its own.
   */
  Rpc.make("SendMessage", {
    payload: {
      chatId: ChatId,
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      parentSlotId: Schema.NullOr(SlotId),
      branch: Schema.Boolean,
      content: Schema.String,
      images: Schema.optionalKey(MessageImages),
      imageDraftIds: Schema.optionalKey(ComposerImageIds),
      speakerEntityId: Schema.optionalKey(Schema.NullOr(EntityId)),
      /**
       * Who replies to it, if it's queued: the reply then starts on the server, as the client
       * would have asked for it after an immediate send.
       */
      replySpeakerEntityId: Schema.optionalKey(Schema.NullOr(EntityId)),
      /**
       * False: no reply follows it (every character muted, DESIGN §3.5). Queued, it posts alone;
       * posted at once, the client asks for no reply.
       */
      reply: Schema.optionalKey(Schema.Boolean),
      /**
       * If it's queued: who replies after `replySpeakerEntityId`, in turn, the rest of the round
       * the send started (DESIGN §2.3). Posted at once, the client's Generate carries it.
       */
      round: Schema.optionalKey(Schema.Array(EntityId)),
      /**
       * If it's queued: `replySpeakerEntityId` and the round are Auto's picks, so the decision
       * model's "Who replies next", when the user turned it on, may choose another for each.
       */
      autoPick: Schema.optionalKey(Schema.Boolean),
      composer: ComposerCommit,
      /** From a side chat: where its story is read for the reply (spec/WORKSHOP.md §4). */
      storyAt: StoryAtField
    },
    success: SendResult,
    error: Schema.Union([NotFound, LeafMoved, ServerError])
  }),
  /**
   * A model reply under `parentSlotId`, as `speakerEntityId` (Generate X), streamed to
   * subscribers; `branch` as for SendMessage. `direction` is a one-turn direction stored on
   * the reply: its swipes reuse it, later turns never see it. Onto a reply still being
   * written, it's queued like a message.
   */
  Rpc.make("Generate", {
    payload: {
      chatId: ChatId,
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      parentSlotId: Schema.NullOr(SlotId),
      branch: Schema.Boolean,
      speakerEntityId: Schema.optionalKey(Schema.NullOr(EntityId)),
      direction: Schema.optionalKey(Schema.String),
      /**
       * Who replies after this reply, in turn: the rest of the round (DESIGN §2.3), queued on the
       * server behind it. Any Send or Generate at the fork's tip ends the round already there.
       */
      round: Schema.optionalKey(Schema.Array(EntityId)),
      /**
       * `speakerEntityId` and the round are Auto's picks: the decision model's "Who replies
       * next", when the user turned it on, may choose another for each (DESIGN §2.3).
       */
      autoPick: Schema.optionalKey(Schema.Boolean),
      composer: ComposerCommit,
      /** From a side chat: where its story is read for the reply (spec/WORKSHOP.md §4). */
      storyAt: StoryAtField
    },
    success: SendResult,
    error: Schema.Union([NotFound, LeafMoved, GenerationUnavailable, ServerError])
  }),
  /**
   * The fork's round (DESIGN §2.3). `continue`: a stopped round goes on, its next reply starting
   * at the fork's tip (or waiting for the reply being written there), the rest queued behind it;
   * nothing held leaves the queue as it is. `end`: what's left of it, waiting or stopped, is
   * dropped; the reply being written goes on. Returns the chat's queue.
   */
  Rpc.make("Round", {
    payload: { chatId: ChatId, forkId: Schema.NullOr(ForkId), action: Schema.Literals(["continue", "end"]) },
    success: Schema.Array(QueuedMessage),
    error: Schema.Union([NotFound, GenerationUnavailable, ServerError])
  }),
  /**
   * A swipe: a new model version of a slot, selected and streamed, with the speaker and
   * the one-turn direction of the version it replaces. Several can run at once. Any message
   * takes one, the user's own included (DESIGN §3.1): the model writes as its speaker.
   */
  Rpc.make("Regenerate", {
    payload: {
      slotId: SlotId,
      /** The fork it's done in, whose row version `expectedRowVersion` is (absent or null: the current one). */
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      expectedRowVersion: Schema.Int,
      /** Optional per-generation model override, recorded on the new version. */
      model: Schema.optionalKey(ModelChoice),
      /**
       * A one-turn direction for this version (the guidance editor's box); empty for none.
       * Absent, the version it replaces gives its own.
       */
      direction: Schema.optionalKey(Schema.String),
      /** From a side chat: where its story is read for the reply (spec/WORKSHOP.md §4). */
      storyAt: StoryAtField
    },
    success: PathEntry,
    error: Schema.Union([...WriteErrors, GenerationUnavailable])
  }),
  /**
   * Continue (ST's): a new version of the slot, selected, that starts as the text of
   * `versionId` and streams on from its end. The text is sent as the start of the reply
   * (a prefill), so only models that take one can continue; with another, the version
   * fails saying so. The version continued stays as it was (DESIGN §3.1).
   */
  Rpc.make("ContinueVersion", {
    payload: {
      versionId: VersionId,
      /** The fork it's done in, whose row version `expectedRowVersion` is (absent or null: the current one). */
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      expectedRowVersion: Schema.Int,
      /** A one-turn direction for the continued version; the continued one's isn't reused. */
      direction: Schema.optionalKey(Schema.String),
      /** From a side chat: where its story is read for the reply (spec/WORKSHOP.md §4). */
      storyAt: StoryAtField
    },
    success: PathEntry,
    error: Schema.Union([...WriteErrors, GenerationUnavailable, NotContinuable])
  }),
  /** Stops one generation; its text so far is kept. Returns the stopped version. */
  Rpc.make("StopGeneration", { payload: { versionId: VersionId }, success: Version, error: Schema.Union([...Errors]) }),
  /**
   * Shows `versionId` at the slot in fork `forkId` (absent or null: the current one) from
   * now on, if the fork still shows `expectedVersionId` there. Other forks keep theirs.
   */
  Rpc.make("SelectVersion", {
    payload: {
      slotId: SlotId,
      versionId: VersionId,
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      expectedVersionId: VersionId
    },
    success: PathEntry,
    error: Schema.Union([...WriteErrors])
  }),
  /**
   * Stars a version, or hides it from the arrows' cycle (the version picker, DESIGN §3.1),
   * or undoes either, in fork `forkId` (absent or null: the fork through its message). What's
   * sent to the model doesn't change.
   */
  Rpc.make("SetVersionFlags", {
    payload: {
      versionId: VersionId,
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      starred: Schema.optionalKey(Schema.Boolean),
      hidden: Schema.optionalKey(Schema.Boolean)
    },
    success: Version,
    error: Schema.Union([...Errors])
  }),
  /**
   * Takes an image of a message out of the context, or puts it back, in fork `forkId` (absent
   * or null: the fork through its message): it stays in the message, marked, and isn't sent.
   * Like any edit it never starts a generation. Returns the message as that fork shows it.
   */
  Rpc.make("SetImageExcluded", {
    payload: {
      versionId: VersionId,
      mediaId: Schema.String,
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      excluded: Schema.Boolean
    },
    success: PathEntry,
    error: Schema.Union([...Errors])
  }),
  /**
   * Hides a message from the model, or shows it to the model again (ST's ghost toggle): it
   * stays in the chat, marked, and isn't sent. Like any edit it never starts a generation.
   */
  Rpc.make("SetMessageHidden", {
    payload: { slotId: SlotId, forkId: Schema.optionalKey(Schema.NullOr(ForkId)), hidden: Schema.Boolean },
    success: PathEntry,
    error: Schema.Union([...Errors])
  }),
  /** An edit saved as a new version, "edited from" its source (DESIGN §3.1), and selected. */
  Rpc.make("EditVersion", {
    payload: {
      slotId: SlotId,
      /** The fork it's done in, whose row version `expectedRowVersion` is (absent or null: the current one). */
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),

      sourceVersionId: VersionId,
      content: Schema.String,
      images: Schema.optionalKey(MessageImages),
      expectedRowVersion: Schema.Int,
      draft: DraftCommit
    },
    success: PathEntry,
    error: Schema.Union([...WriteErrors])
  }),
  /**
   * "Show as reply text" (spec/REPLY-SECTIONS.md): a wrong parse undone. A new edited version,
   * selected, whose text is the reply as it came, its leading tagged sections back in it in
   * their tags; it keeps the provider's reasoning. The parsed version stays as it was.
   * NotFound for a version without sections.
   */
  Rpc.make("ShowSectionsAsText", {
    payload: {
      versionId: VersionId,
      /** The fork it's done in, whose row version `expectedRowVersion` is (absent or null: the current one). */
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      expectedRowVersion: Schema.Int
    },
    success: PathEntry,
    error: Schema.Union([...WriteErrors])
  }),
  /** "Write your own version" of any message, selected. */
  Rpc.make("WriteVersion", {
    payload: {
      slotId: SlotId,
      /** The fork it's done in, whose row version `expectedRowVersion` is (absent or null: the current one). */
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      content: Schema.String,
      images: Schema.optionalKey(MessageImages),
      expectedRowVersion: Schema.Int,
      draft: DraftCommit
    },
    success: PathEntry,
    error: Schema.Union([...WriteErrors])
  }),
  /**
   * Changes a user-written version as fork `forkId` shows it (absent or null: the fork through
   * its message); its earlier text is kept in its history. When another fork shows it too, the
   * fork gets a copy with the new text in its place, which is returned, and the others keep it.
   */
  Rpc.make("AmendVersion", {
    payload: {
      versionId: VersionId,
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      content: Schema.String,
      /** Its images from now on (absent: kept); the earlier set stays in its history. */
      images: Schema.optionalKey(MessageImages),
      expectedRowVersion: Schema.Int,
      draft: DraftCommit
    },
    success: Version,
    error: Schema.Union([...WriteErrors, NotAmendable])
  }),
  /**
   * A version's text, reasoning and reply sections as they were before regex scripts rewrote
   * them, when they did (null: unchanged). Only the owner reads it; it's never sent to a model.
   */
  Rpc.make("RawVersionText", {
    payload: { versionId: VersionId },
    success: RawText,
    error: Schema.Union([...Errors])
  }),
  /**
   * Puts a version's text from before the scripts back, as a new selected version of the slot
   * (an edit of it, `sourceVersionId` the version), which no script rewrites.
   */
  Rpc.make("RestoreRawText", {
    payload: {
      slotId: SlotId,
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      versionId: VersionId,
      expectedRowVersion: Schema.Int
    },
    success: PathEntry,
    error: Schema.Union([...WriteErrors])
  }),
  Rpc.make("VersionAmendments", {
    payload: { versionId: VersionId },
    success: Schema.Array(VersionAmendment),
    error: Schema.Union([...Errors])
  }),
  /** Restores saved text as an ordinary, optimistic, fork-local human amendment. */
  Rpc.make("RestoreVersionAmendment", {
    payload: { versionId: VersionId, amendmentId: Schema.Int, forkId: ForkId, expectedRowVersion: Schema.Int },
    success: Version,
    error: Schema.Union([...WriteErrors, NotAmendable])
  }),
  Rpc.make("MessageDraftHistory", {
    payload: {
      target: MessageDraftTarget,
      limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: DraftHistoryPolicy.maxEntries + 1 })),
      /** Pages on to the states before this seq: an edit's history outlives its saves (owner, 2026-11-02). */
      before: Schema.optionalKey(Schema.Int)
    },
    success: Schema.Array(DraftState),
    error: Schema.Union([...Errors])
  }),
  /**
   * A message editor's draft, active or resting (`NotFound`: none yet, as for its history): a
   * reopened edit reads it to list and put back the states from before its last save (owner,
   * 2026-11-02).
   */
  Rpc.make("GetMessageDraft", {
    payload: { target: MessageDraftTarget },
    success: Draft,
    error: Schema.Union([...Errors])
  }),
  Rpc.make("RestoreMessageDraft", {
    payload: { target: MessageDraftTarget, draftId: Schema.String, ...DraftRestore },
    success: Draft,
    error: Schema.Union([...WriteErrors])
  }),
  /** The chat's open message editors: the drafts with text of edits and versions being written. */
  Rpc.make("MessageDrafts", {
    payload: { chatId: ChatId },
    success: Schema.Array(Draft),
    error: Schema.Union([...Errors])
  }),
  /** Text typed into a message editor, onto the draft as this tab last saw it (null before it had one). */
  Rpc.make("SaveMessageDraft", {
    payload: MessageDraftSave.fields,
    success: Draft,
    error: Schema.Union([...Errors, TextTooLong])
  }),
  Rpc.make("QueueDraftHistory", {
    payload: { chatId: ChatId, queuedId: Schema.String },
    success: Schema.Array(DraftState),
    error: Schema.Union([...Errors])
  }),
  Rpc.make("RestoreQueueDraft", {
    payload: { chatId: ChatId, queuedId: Schema.String, draftId: Schema.String, ...DraftRestore },
    success: Draft,
    error: Schema.Union([...WriteErrors])
  }),
  /** Closes a message editor unsaved: an edit goes back to the saved text as a state of its history (the text cancelled one step back); a written version's text goes to the bin's recovered texts. */
  Rpc.make("DiscardMessageDraft", {
    payload: { target: MessageDraftTarget, draftId: Schema.String, expectedRowVersion: Schema.Int },
    success: Draft,
    error: Schema.Union([...WriteErrors])
  }),
  // --- Deleting goes to the recycle bin (ARCHITECTURE §3.11); generations under what was
  // deleted are stopped.
  Rpc.make("DeleteChat", { payload: { chatId: ChatId }, success: BinItem, error: Schema.Union([...Errors]) }),
  /** Deletes a message in a fork (absent or null: the fork through it); the other forks that show it keep it. */
  Rpc.make("DeleteMessage", {
    payload: { slotId: SlotId, forkId: Schema.optionalKey(Schema.NullOr(ForkId)) },
    success: BinItem,
    error: Schema.Union([...Errors])
  }),
  /**
   * Deletes one fork and nothing else (owner, 2026-10-27): forks made from it keep their shared
   * history. A chat's last live fork isn't deleted.
   */
  Rpc.make("DeleteFork", {
    payload: { forkId: ForkId },
    success: BinItem,
    error: Schema.Union([...Errors, CannotDeleteLastFork])
  }),
  /** Deletes a swipe in a fork (absent or null: the fork through its message); the other forks keep it. */
  Rpc.make("DeleteVersion", {
    payload: { versionId: VersionId, forkId: Schema.optionalKey(Schema.NullOr(ForkId)) },
    success: BinItem,
    error: Schema.Union([...Errors])
  }),
  /**
   * Where switching to the branch at `index` (0: the oldest) among the alternates at
   * `slotId` goes (DESIGN §3.2): the fork through that sibling that was current most
   * recently, made from `forkId` (the fork shown) if none is. It changes no fork and doesn't
   * make one current: the client opens it (`?fork=`). Each fork has its own composer.
   */
  Rpc.make("SwitchBranch", {
    payload: {
      chatId: ChatId,
      slotId: SlotId,
      index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      forkId: Schema.optionalKey(Schema.NullOr(ForkId))
    },
    success: BranchSwitch,
    error: Schema.Union([...WriteErrors])
  }),
  /** The user's display choices (reasoning shown open or folded while it streams). */
  Rpc.make("GetDisplayPrefs", { payload: {}, success: DisplayPrefs, error: ServerError }),
  /** Changes the user's display choices; answers with them as now stored. */
  Rpc.make("SetDisplayPrefs", { payload: { prefs: DisplayPrefsChange }, success: DisplayPrefs, error: ServerError }),
  /**
   * Asked as the user generates as a card they play (DESIGN §2.2): whether to say, once for
   * this account and its current preset, that a preset with no prompt conditioned on writing
   * as `{{user}}` may need its rules against writing for `{{user}}` marked. Asking marks it shown.
   */
  Rpc.make("ImpersonationNotice", {
    payload: {},
    success: Schema.Struct({ show: Schema.Boolean, preset: Schema.NullOr(RefId) }),
    error: ServerError
  }),
  /**
   * The alternates at `slotId`'s place (it and its siblings a path can reach), oldest first,
   * each with its first words as `forkId` (absent or null: the fork through it) shows them.
   */
  Rpc.make("ListBranches", {
    payload: { slotId: SlotId, forkId: Schema.optionalKey(Schema.NullOr(ForkId)) },
    success: Schema.Array(Branch),
    error: Schema.Union([...Errors])
  }),
  /** The chat's live forks, most recently current first, with names, pins and their tips' text. */
  Rpc.make("ListForks", {
    payload: { chatId: ChatId },
    success: Schema.Array(Fork),
    error: Schema.Union([...Errors])
  }),
  /**
   * A fork of `fromForkId` (null: the current one) at `atSlotId`, a message on its path
   * (null: before the first message): "Branch from here". It becomes the current fork.
   */
  Rpc.make("PreviewForkNotes", {
    payload: { chatId: ChatId, fromForkId: Schema.NullOr(ForkId), atSlotId: Schema.NullOr(SlotId) },
    success: Schema.Array(ForkNote),
    error: Schema.Union([...Errors])
  }),
  Rpc.make("CreateFork", {
    payload: {
      chatId: ChatId,
      fromForkId: Schema.NullOr(ForkId),
      atSlotId: Schema.NullOr(SlotId),
      notes: Schema.optionalKey(ForkNoteSelection),
      /** An automatic name ("From #14"): shown like a given one, and the user renames it as one. */
      name: Schema.optionalKey(BranchNameInput)
    },
    success: Schema.Struct({ fork: Fork, chat: Chat }),
    error: Schema.Union([...Errors, ForkNotesChanged])
  }),
  /**
   * Names a fork; an empty name takes the name off. Its first message, among the alternates
   * where it branched, shows the name, and subscribers get that slot as `Slot`.
   */
  Rpc.make("NameFork", {
    payload: { forkId: ForkId, name: BranchNameInput },
    success: Fork,
    error: Schema.Union([...Errors])
  }),
  /** Pins a fork, or unpins it: pinned forks are listed as the chat's peers (UX-REWORK §3). */
  Rpc.make("PinFork", {
    payload: { forkId: ForkId, pinned: Schema.Boolean },
    success: Fork,
    error: Schema.Union([...Errors])
  }),
  /** Next request at the displayed leaf; Cache events invalidate this read. */
  Rpc.make("GetNextContext", {
    payload: { chatId: ChatId, forkId: Schema.optionalKey(Schema.NullOr(ForkId)), leafSlotId: Schema.NullOr(SlotId) },
    success: NextContext,
    error: Schema.Union([...Errors])
  })
) {}

/** Message reads kept separate from the core handler group to bound TypeScript inference. */
export class MessageVersionApi extends RpcGroup.make(
  /** A URL-selected message version, including when its row is outside the loaded path window. */
  Rpc.make("ReadMessageVersion", {
    payload: { chatId: ChatId, forkId: ForkId, versionId: VersionId },
    success: PathEntry,
    error: Schema.Union([...Errors])
  })
) {}

/**
 * The chat's live updates, in a group (and handler layer) of their own: with the event union
 * in it, AppCoreApi's handler inference exceeds TypeScript's instantiation depth (TS2589).
 */
export class ChatEventsApi extends RpcGroup.make(
  /**
   * Live updates to one chat. Each element is a batch, coalesced on the server per frame
   * (about 16 ms). The first batch starts with Hello.
   */
  Rpc.make("SubscribeChat", {
    payload: { chatId: ChatId },
    success: Schema.Array(ChatEvent),
    error: Schema.Union([...Errors]),
    stream: true
  })
) {}
