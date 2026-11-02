// Starting chats from cards, who's in them, their settings, and the send queue (DESIGN
// §2.1, §2.2, §3.5; DATA-MODEL §5.3), merged into AppApi. Every id is the caller's own;
// anything else is NotFound.
import { Schema } from "effect"
import { AvatarCrop } from "./media.ts"
import { Rpc, RpcGroup } from "effect/rpc"
import {
  MessageImages,
  CastCard,
  Chat,
  ChatId,
  EntityId,
  ForkId,
  ForkSplit,
  FrozenMacros,
  PathEntry,
  QueuedMessage,
  SlotId
} from "./chat.ts"
import { ChatNameInput, GenerationUnavailable } from "./chatApi.ts"
import { NotFound, ServerError, StaleWrite } from "./errors.ts"
import { EditRefused } from "./editorApi.ts"
import { Doc, LibraryRef, RefId, RevisionId } from "./library.ts"
import { ConnectionId, ModelId } from "./providers.ts"
import { RegexScript } from "./docs/regexScript.ts"
import { GlobalRegex, GlobalScripts } from "./regexScripts.ts"

/** A card's greetings and the fields its macros read, for a chat that isn't made yet. */
export class CardForChat extends Schema.Class<CardForChat>("CardForChat")({
  card: CastCard,
  /** `first_mes`, then the alternate greetings; empty ones left out. */
  greetings: Schema.Array(Schema.String),
  /** CCv3 group-only greetings, offered only with two or more character cards. */
  groupGreetings: Schema.Array(Schema.String),
  description: Schema.String,
  personality: Schema.String,
  scenario: Schema.String,
  /** Its regex scripts when the user allowed them (`regex_approved`); absent otherwise or without any. */
  regex: Schema.optionalKey(Schema.Array(RegexScript))
}) {}

/**
 * A character on the home grid (DESIGN §2.1): what lists show of it, and how it's been used.
 * Personas aren't characters here; cards in the bin aren't listed.
 */
export class CardUsage extends Schema.Class<CardUsage>("CardUsage")({
  entityId: EntityId,
  /** Its single upstream ref: the editor's `/library/$refId`. */
  refId: RefId,
  /** That ref's head, the definition the card page shows. */
  headRevisionId: RevisionId,
  /** Display name and version from the listed revision’s standard card fields. */
  label: Schema.String,
  subtitle: Schema.String,
  /** Standard display name. */
  name: Schema.String,
  modelName: Schema.optionalKey(Schema.String),
  /** Its avatar, served at `/library/media?id=`; null without one. */
  avatarMediaId: Schema.NullOr(Schema.String),
  /** The avatar's chosen cutout (ARCHITECTURE.md §14.5c); absent: the default. */
  avatarCrop: Schema.optionalKey(AvatarCrop),
  /** Chats it has joined, group chats included; chats in the bin don't count. */
  chats: Schema.Int,
  /**
   * In the shell read (`ShellCard.card`, what the home grid and the library show): the last
   * message the card itself spoke, so a card the user played has none. `ListCardUsage` gives the
   * last message in any of its chats instead. (A card's Recent is
   * `ShellCard.recentAt`.)
   */
  lastMessageAt: Schema.NullOr(Schema.Number),
  /** The one of them with the latest message (else the newest): what Continue opens. */
  latestChatId: Schema.NullOr(ChatId)
}) {}

/**
 * A group on the home grid (DESIGN §2.1; ST's group tiles). There's no group entity: a group
 * is the chats with the same readable name (`chatName`: an ST group's name, or the cast's
 * names for a chat made here) and the same characters the user doesn't play, two or more.
 * Chats in the bin aren't counted.
 */
export class ChatGroup extends Schema.Class<ChatGroup>("ChatGroup")({
  name: Schema.String,
  /** The characters in it (not the ones the user plays), in the latest chat's join order. */
  members: Schema.Array(
    Schema.Struct({
      entityId: EntityId,
      /** Display name from the selected card revision. */
      name: Schema.String,
      label: Schema.String,
      subtitle: Schema.optionalKey(Schema.String),
      avatarMediaId: Schema.NullOr(Schema.String),
      avatarCrop: Schema.optionalKey(AvatarCrop)
    })
  ),
  chats: Schema.Int,
  /** The last message in any of its chats. */
  lastMessageAt: Schema.NullOr(Schema.Number),
  /** The one with the latest message (else the newest): what a click continues, and the group's id in links. */
  latestChatId: ChatId
}) {}

/** Where a card's tile opens: the line it last spoke, else its latest chat's end. */
const ShellOpen = Schema.Struct({
  chatId: ChatId,
  forkId: Schema.String,
  leaf: Schema.NullOr(SlotId),
  slot: Schema.NullOr(SlotId)
})

/** The independent shell's cards and individual fork rows. */
export class ShellCard extends Schema.Class<ShellCard>("ShellCard")({
  /** The shell uses character_version as the subtitle, independent of a legacy ref subtitle. */
  card: CardUsage,
  /**
   * Its Created: the entity's making. An ST import dates it by ST's `create_date` (else the
   * file's ctime); a single-file upload or a card written here, by when it came in.
   */
  createdAt: Schema.Number,
  /** Its Added: when it came into this app (its upstream ref's making), imported or written here. */
  addedAt: Schema.Number,
  /** The user's favourite (`cards.favourites`; an import's ST `fav` until the user sets it here). */
  favourite: Schema.Boolean,
  /** Null: the card is in no chat yet, and its tile starts one. */
  open: Schema.NullOr(ShellOpen),
  /**
   * Its Recent: the latest activity in any chat it joined (a fork's `recentAt`), imported dates
   * included, as ST's date_last_chat; null while it has none. (`card.lastMessageAt` is its own last turn.)
   */
  recentAt: Schema.NullOr(Schema.Number)
}) {}
export class ShellFork extends Schema.Class<ShellFork>("ShellFork")({
  forkId: Schema.String,
  preview: Schema.String,
  messages: Schema.Int,
  /** Only what the rows show; the chat's own record is read when it opens. */
  chat: Schema.Struct({ id: ChatId, title: Schema.String, createdAt: Schema.optionalKey(Schema.Number) }),
  leaf: Schema.NullOr(SlotId),
  /** The fork's name, else its chat's. */
  name: Schema.String,
  /** Its chat's readable name: what a row standing for the chat shows. */
  chatName: Schema.String,
  current: Schema.Boolean,
  named: Schema.Boolean,
  pinned: Schema.Boolean,
  /** The chat's first fork: made from no other. */
  original: Schema.Boolean,
  /** Where it parts from the fork it was made from (`ForkSplit`); null for the original. */
  split: Schema.NullOr(ForkSplit),
  createdAt: Schema.Number,
  /** Its last shown message's time; null without one. */
  endAt: Schema.NullOr(Schema.Number),
  /** Its last shown message (else its chat's start), or its making when it was branched from another. */
  recentAt: Schema.Number,
  /** Its chat's Recent: the latest `recentAt` of the chat's live forks. */
  chatRecentAt: Schema.Number,
  /** How many live forks (branches) its chat has. */
  branches: Schema.Int,
  /** Present characters the model writes, by id; `ShellLibrary.people` describes each once. */
  cast: Schema.Array(EntityId),
  joined: Schema.Array(EntityId),
  departed: Schema.Array(EntityId),
  activity: Schema.Array(
    Schema.Struct({
      entityId: EntityId,
      at: Schema.Number,
      slot: SlotId,
      category: Schema.Literals(["just", "with", "was"])
    })
  )
}) {}
export class ShellLibrary extends Schema.Class<ShellLibrary>("ShellLibrary")({
  cards: Schema.Array(ShellCard),
  forks: Schema.Array(ShellFork),
  /** Every card some fork's cast names, once, rather than repeated in each of 5,000 rows. */
  people: Schema.Array(CastCard),
  pinsCollapsed: Schema.Boolean
}) {}

/** The shell's cards without their forks: what home, the grids and Start a chat read (GetShellCards). */
export class ShellCards extends Schema.Class<ShellCards>("ShellCards")({
  cards: Schema.Array(ShellCard),
  pinsCollapsed: Schema.Boolean
}) {}

/**
 * The lists of fork rows a screen shows (GetShellForks): each a part of the forks in the view's
 * scope (a card's chats, one chat's forks, or every chat), matching its search.
 * - `pinned`: the pinned ones, by `sort`;
 * - `chats`: each chat once, by its current fork, the most recent chat first (All chats);
 * - `just`, `with`, `was`: the scope card's chats, once each, by how it is in them, its latest turn first;
 * - `current`, `peers`, `other`: a chat's current fork; its pinned and named ones, the current
 *   one among them when it is; the rest; the last two by their last message, newest first;
 * - `groups`: chats of two or more characters, once each, by `sort`;
 * - `card`: each chat the scope card joined, once, its latest turn first, then newest;
 * - `all`: every fork in scope, newest first.
 * A chat listed once is its current fork's row when that one is in the list, else its first
 * there; `branches` says how many it has. Recent sorts chats by `chatRecentAt`.
 */
export const ShellSection = Schema.Literals([
  "pinned",
  "chats",
  "just",
  "with",
  "was",
  "current",
  "peers",
  "other",
  "groups",
  "card",
  "all"
])
export type ShellSection = typeof ShellSection.Type
const ShellForkSort = Schema.Literals(["recent", "created", "name"])
export const ShellForksView = Schema.Struct({
  entity: Schema.NullOr(EntityId),
  chat: Schema.NullOr(ChatId),
  /** Only these chats (a list's rows), when given. */
  chats: Schema.optionalKey(Schema.Array(ChatId).check(Schema.isMaxLength(500))),
  /** Matched against each fork's name and its cast's names, ignoring case. */
  search: Schema.String,
  sort: ShellForkSort,
  /** The sort the other way round from its own: oldest first, or Z to A. */
  reversed: Schema.optionalKey(Schema.Boolean),
  sections: Schema.Array(
    Schema.Struct({ id: ShellSection, limit: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5000 })) })
  ).check(Schema.isMaxLength(12))
})
export type ShellForksView = typeof ShellForksView.Type
export class ShellForks extends Schema.Class<ShellForks>("ShellForks")({
  /** In the view's order: each section's first `limit` rows, and how many it has. */
  sections: Schema.Array(Schema.Struct({ id: ShellSection, rows: Schema.Array(ShellFork), total: Schema.Int })),
  /** Every card the rows' casts name, once. */
  people: Schema.Array(CastCard)
}) {}

/** An open id, resolved against the server's role-projection registry when a context is assembled. */
const RolesProjection = Schema.String

export const RoleProjectionOption = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  description: Schema.optionalKey(Schema.String)
})

/**
 * Who is in a chat, and its settings, at one position: the fold of its state events
 * (DATA-MODEL §5.2), with every card named there.
 */
export class Cast extends Schema.Class<Cast>("Cast")({
  /** The position: state after this slot (null: before the first message). */
  slotId: Schema.NullOr(SlotId),
  /** In join order. */
  participants: Schema.Array(EntityId),
  /** Participants marked absent (DESIGN §3.5). */
  absent: Schema.Array(EntityId),
  /** The "played by me" set: the composer's default speaker and `{{user}}` (DESIGN §2.2). */
  playedByMe: Schema.Array(EntityId),
  /** The chat-wide model and preset; the context assembler reads these. */
  model: Schema.NullOr(Schema.Struct({ connection: ConnectionId, model: ModelId })),
  preset: Schema.NullOr(RefId),
  lorebooks: Schema.Array(RefId),
  /** Cards whose own lorebook this chat has turned off. */
  cardLorebooksOff: Schema.Array(EntityId),
  /** Every lorebook attached to the chat and not removed, on or off, in the order first attached. */
  listedLorebooks: Schema.Array(Schema.Struct({ ref: RefId, on: Schema.Boolean })),
  /** Lorebook entries only below the history (DESIGN §1.3); on unless the chat turned it off. */
  loreBelowHistory: Schema.Boolean,
  /** Explicit prompt-name pins; an empty string is a pin too. */
  macroBindings: Schema.Record(Schema.String, Schema.String),
  /** Stable preset/chat names, independent of the current speaker. */
  macroNames: Schema.Struct({ user: Schema.String, char: Schema.String }),
  rolesProjection: Schema.NullOr(RolesProjection),
  roleProjections: Schema.Array(RoleProjectionOption),
  /** Who replies when nobody is picked (`reply.order`, a reply policy's id); absent is the default, natural order. */
  replyOrder: Schema.optionalKey(Schema.String),
  /** Active and departed cards, including former personas, to retain historical names and portraits. */
  cards: Schema.Array(CastCard)
}) {}

/** The first turn of a new chat: what turns a card's greeting into a chat. */
export const FirstTurn = Schema.Union([
  Schema.TaggedStruct("Send", {
    images: Schema.optionalKey(MessageImages),
    content: Schema.String,
    speakerEntityId: Schema.NullOr(EntityId)
  }),
  Schema.TaggedStruct("Generate", { speakerEntityId: Schema.NullOr(EntityId), direction: Schema.String })
])
export type FirstTurn = typeof FirstTurn.Type

/** A change to who's in a chat, or to its settings, from a position on. */
export const CastChange = Schema.Union([
  Schema.TaggedStruct("Swap", { entityId: EntityId, replaces: EntityId }),
  Schema.TaggedStruct("Join", { entityId: EntityId }),
  Schema.TaggedStruct("Leave", { entityId: EntityId }),
  Schema.TaggedStruct("Presence", { entityId: EntityId, present: Schema.Boolean }),
  Schema.TaggedStruct("PlayedByMe", { entityIds: Schema.Array(EntityId) }),
  /**
   * The one persona from here on (DESIGN §2.2, who `{{user}}` is), in one write: the card joins
   * if it isn't in the chat, and a persona-folder card played until now leaves, since it isn't
   * one of the characters.
   */
  Schema.TaggedStruct("Persona", { entityId: EntityId }),
  Schema.TaggedStruct("Model", { connection: ConnectionId, model: ModelId }),
  Schema.TaggedStruct("Preset", { ref: RefId }),
  /** The chat's own model or preset taken off (`model.unbind`, `preset.unbind`): it uses the default again. */
  Schema.TaggedStruct("DefaultModel", {}),
  Schema.TaggedStruct("DefaultPreset", {}),
  /** A stable prompt-name pin; null removes it and follows the cast/personas again. */
  Schema.TaggedStruct("MacroBinding", { name: Schema.Literals(["user", "char"]), value: Schema.NullOr(Schema.String) }),
  Schema.TaggedStruct("Roles", { projection: RolesProjection }),
  /** A note on or off (`note.activate`, `note.deactivate`): the chat's own, or a participant card's. */
  Schema.TaggedStruct("Lorebook", { ref: RefId, active: Schema.Boolean }),
  /** A card's own lorebook on or off (`lorebook.embedded`). */
  Schema.TaggedStruct("CardLorebook", { entityId: EntityId, on: Schema.Boolean }),
  /** An attached lorebook taken out of the chat's list (`lorebook.remove`). */
  Schema.TaggedStruct("RemoveLorebook", { ref: RefId }),
  /** Lorebook entries only below the history, or where their positions say (`lorebook.below_history`). */
  Schema.TaggedStruct("LoreBelowHistory", { on: Schema.Boolean }),
  /** Who replies when nobody is picked (`reply.order`): a reply policy's id. */
  Schema.TaggedStruct("ReplyOrder", { order: Schema.String.check(Schema.isMaxLength(200)) }),
  Schema.TaggedStruct("Note", { entityId: EntityId, active: Schema.Boolean })
])
export type CastChange = typeof CastChange.Type

/** A preset that lists a lorebook (`PresetDoc.lorebooks`), and whether it's on there. */
export const LorebookPreset = Schema.Struct({ refId: RefId, label: Schema.String, enabled: Schema.Boolean })
export type LorebookPreset = typeof LorebookPreset.Type

/** The shared note a slot links to (DESIGN §4.1): in the bin, the slot sends nothing. */
export const LinkedNote = Schema.Struct({
  refId: RefId,
  entityId: EntityId,
  title: Schema.String,
  binned: Schema.Boolean,
  /** How many slots link to it. */
  usedBy: Schema.Int
})
export type LinkedNote = typeof LinkedNote.Type

/**
 * A note a chat can use (DESIGN §4.1): the chat's own, or one of a cast card's (a card the
 * user plays included), by its upstream ref, and whether it's on at the position asked
 * about. A linked slot's `doc.content` is its shared note's text.
 */
export class ChatNote extends Schema.Class<ChatNote>("ChatNote")({
  ref: LibraryRef,
  doc: Doc,
  /** The card whose note it is; null for the chat's own. */
  card: Schema.NullOr(EntityId),
  /** A card's note on in every chat unless the chat switches it off (`on_by_default`). */
  onByDefault: Schema.Boolean,
  linked: Schema.NullOr(LinkedNote),
  active: Schema.Boolean
}) {}

/** What a preset does with a card's prompt in place of one of its own (DESIGN §5.0). */
const PromptUse = Schema.Struct({
  /** The preset prompt's name, as the editor shows it. */
  name: Schema.String,
  /** A card's text replaces it; it forbids that; it's off; or the preset has none. */
  state: Schema.Literals(["replaceable", "forbidden", "disabled", "missing"])
})

/**
 * Whether a card's system prompt and post-history instructions are used: in place of the
 * Main Prompt and the post-history prompt of the preset chats use now.
 */
export class CardPromptUse extends Schema.Class<CardPromptUse>("CardPromptUse")({
  preset: Schema.String,
  main: PromptUse,
  jailbreak: PromptUse
}) {}

/** A card's definition as a chat shows it, read-only: the fields ST's character panel shows. */
export class CardDefinition extends Schema.Class<CardDefinition>("CardDefinition")({
  description: Schema.String,
  personality: Schema.String,
  scenario: Schema.String,
  firstMessage: Schema.String,
  exampleDialogue: Schema.String,
  creatorNotes: Schema.String,
  /** How many alternate greetings it has besides the first message. */
  alternateGreetings: Schema.Int
}) {}

/**
 * A card in a chat, as the Cast tab shows it (DESIGN §2.1, §4): the library entry an edit
 * changes and how many chats that reaches, and the definition the next request reads at the position asked about, picked as the
 * context assembler picks it (ARCHITECTURE §library).
 */
export class ChatCard extends Schema.Class<ChatCard>("ChatCard")({
  entityId: EntityId,
  /** The card's single upstream ref. */
  refId: RefId,
  /** Chats a change to that entry reaches ("used by N chats", ARCHITECTURE §14.2). */
  usedByChats: Schema.Int,
  /**
   * The card's latest library revision, or a fixed revision pinned by chat state.
   */
  binding: Schema.Literals(["default", "revision"]),
  definition: CardDefinition
}) {}

const Errors = [NotFound, ServerError] as const

export class ChatSetupApi extends RpcGroup.make(
  /** Every card and every fork row at once: for tools and tests; the app pages it (the two below). */
  Rpc.make("GetShellLibrary", { success: ShellLibrary, error: Schema.Union([...Errors]) }),
  Rpc.make("GetShellCards", { success: ShellCards, error: Schema.Union([...Errors]) }),
  Rpc.make("GetShellForks", { payload: ShellForksView, success: ShellForks, error: Schema.Union([...Errors]) }),
  Rpc.make("SetChatPin", {
    payload: {
      chatId: ChatId,
      leaf: Schema.NullOr(SlotId),
      pinned: Schema.Boolean,
      forkId: Schema.optional(Schema.String)
    },
    success: Schema.Void,
    error: Schema.Union([...Errors])
  }),
  Rpc.make("SetHomePinsCollapsed", {
    payload: { collapsed: Schema.Boolean },
    success: Schema.Void,
    error: Schema.Union([...Errors])
  }),
  /** Marks a card of the user's a favourite or not; an import's ST `fav` no longer changes it. */
  Rpc.make("SetCardFavourite", {
    payload: { entityId: EntityId, favourite: Schema.Boolean },
    success: Schema.Void,
    error: Schema.Union([...Errors])
  }),
  /** Every live card of the user's, by label: the speaker switcher's All cards and Personas. */
  Rpc.make("ListCards", { success: Schema.Array(CastCard), error: ServerError }),
  /** Every live character card of the user's with its use, for the home grid, in one read. */
  Rpc.make("ListCardUsage", { success: Schema.Array(CardUsage), error: ServerError }),
  /** The user's groups (`ChatGroup`), for the home grid, in one read. */
  Rpc.make("ListChatGroups", { success: Schema.Array(ChatGroup), error: ServerError }),
  /** The group a chat is in, with its chats, latest message first; NotFound when it's in none. */
  Rpc.make("ListGroupChats", {
    payload: { chatId: ChatId },
    success: Schema.Struct({ group: ChatGroup, chats: Schema.Array(Chat) }),
    error: Schema.Union([...Errors])
  }),
  /**
   * Names the group `chatId` is in: every chat of it is renamed (as RenameChat), so the group
   * stays one, under its new name, and its new chats take that name. A chat renamed
   * elsewhere meanwhile keeps that name. Returns the group as it is now.
   */
  Rpc.make("RenameGroup", {
    payload: { chatId: ChatId, name: ChatNameInput },
    success: Schema.Struct({ group: ChatGroup, chats: Schema.Array(Chat) }),
    error: Schema.Union([...Errors])
  }),
  /** Puts a card in the persona folder, or takes it out (DESIGN §2.2). */
  Rpc.make("SetPersona", {
    payload: { entityId: EntityId, persona: Schema.Boolean },
    success: CastCard,
    error: Schema.Union([...Errors])
  }),
  /** A card's greetings, for showing it before any chat exists (DESIGN §2.1). */
  Rpc.make("GetCardForChat", {
    payload: { entityId: EntityId },
    success: CardForChat,
    error: Schema.Union([...Errors])
  }),
  /**
   * Makes a chat from cards on its first turn, never before (DESIGN §2.1): the cards and
   * the persona join at the start, the persona is played by the user, and each member's
   * greeting is a message with its card's greetings as versions. Then the first turn:
   * the user's message (the client asks for the reply, as after any send), or a reply.
   */
  Rpc.make("StartChat", {
    payload: {
      cards: Schema.Array(EntityId).check(Schema.isMinLength(1)),
      persona: Schema.NullOr(EntityId),
      greeting: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
      first: FirstTurn,
      /**
       * What the picked greeting's random and time macros showed, kept so the chat shows it as
       * it was seen (DESIGN §5.6). The server freezes every greeting either way: it checks
       * these and draws whatever is missing.
       */
      frozen: Schema.optionalKey(FrozenMacros),
      /**
       * Who greets, in order, each greeting as its own message with all its card's greetings
       * as versions (the one picked selected) and its preview's frozen values, as ST starts a
       * group chat with each member's greeting in turn. Each must be one of `cards`; a card
       * without greetings is skipped. Absent: every card greets in cards order, randomly
       * for a group as in ST (an explicit `greeting` still chooses the first card's);
       * a single card uses `greeting` and `frozen`.
       */
      greeters: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            entityId: EntityId,
            greeting: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
            frozen: Schema.optionalKey(FrozenMacros)
          })
        ).check(Schema.isMaxLength(100))
      ),
      /**
       * The chat's title; absent or blank, its cast's names. A new chat of a group takes the
       * group's name, so it's one of the group's chats (`ChatGroup`).
       */
      title: Schema.optionalKey(Schema.String)
    },
    success: Schema.Struct({ entry: PathEntry, chat: Chat }),
    error: Schema.Union([...Errors, GenerationUnavailable])
  }),
  /** Who's in the chat, and its settings, after `slotId` (null: at the start). */
  Rpc.make("GetCast", {
    payload: { chatId: ChatId, forkId: Schema.optionalKey(Schema.NullOr(ForkId)), slotId: Schema.NullOr(SlotId) },
    success: Cast,
    error: Schema.Union([...Errors])
  }),
  /**
   * These cards as the chat uses them after `slotId` (the Cast tab, at the leaf shown).
   * Another user's chat or slot, or a card that isn't the user's live card, is NotFound.
   */
  Rpc.make("ListChatCards", {
    payload: {
      chatId: ChatId,
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      slotId: Schema.NullOr(SlotId),
      entityIds: Schema.Array(EntityId)
    },
    success: Schema.Array(ChatCard),
    error: Schema.Union([...Errors])
  }),
  Rpc.make("ForkCardForChat", {
    payload: {
      chatId: ChatId,
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      slotId: Schema.NullOr(SlotId),
      entityId: EntityId,
      name: Schema.String.check(Schema.isMinLength(1)),
      nickname: Schema.String,
      characterVersion: Schema.String
    },
    success: LibraryRef,
    error: Schema.Union([...Errors, EditRefused])
  }),
  /** The user's live presets whose current revision lists the lorebook `ref`, with its switch there. */
  Rpc.make("LorebookPresets", {
    payload: { ref: RefId },
    success: Schema.Array(LorebookPreset),
    error: Schema.Union([...Errors])
  }),
  /** The account's global regex scripts (ST's "Global scripts"), which run in every chat. */
  Rpc.make("GetGlobalRegex", { success: GlobalRegex, error: Schema.Union([...Errors]) }),
  /** Replaces them; StaleWrite unless `expectedRevision` is the revision the caller read. */
  Rpc.make("SetGlobalRegex", {
    payload: { scripts: GlobalScripts, expectedRevision: Schema.Int },
    success: GlobalRegex,
    error: Schema.Union([NotFound, StaleWrite, ServerError])
  }),
  /** What the preset in use does with a card's own prompts, for the card editor. */
  Rpc.make("GetCardPromptUse", { success: CardPromptUse, error: Schema.Union([...Errors]) }),
  /** Changes the cast or a setting from `slotId` on, on that branch (DESIGN §3.4). */
  Rpc.make("ChangeCast", {
    payload: {
      chatId: ChatId,
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      slotId: Schema.NullOr(SlotId),
      change: CastChange
    },
    success: Cast,
    error: Schema.Union([...Errors])
  }),
  /**
   * The chat's own notes, then each cast card's (the ones the user plays included), each
   * with whether it's on after `slotId` (null: at the start).
   */
  Rpc.make("ListChatNotes", {
    payload: { chatId: ChatId, forkId: Schema.optionalKey(Schema.NullOr(ForkId)), slotId: Schema.NullOr(SlotId) },
    success: Schema.Array(ChatNote),
    error: Schema.Union([...Errors])
  }),
  /**
   * A note of the chat's own, off until the chat turns it on (`ChangeCast` with `Note`); with
   * `link`, a slot showing that shared note.
   */
  Rpc.make("CreateChatNote", {
    payload: {
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      chatId: ChatId,
      title: Schema.String,
      link: Schema.optionalKey(EntityId)
    },
    success: LibraryRef,
    error: Schema.Union([...Errors])
  }),
  /** The chat's send queue, in order. */
  Rpc.make("ListQueued", {
    payload: { chatId: ChatId },
    success: Schema.Array(QueuedMessage),
    error: Schema.Union([...Errors])
  }),
  /** Changes a queued message's text or speaker, until it posts. */
  Rpc.make("EditQueued", {
    payload: {
      queuedId: Schema.String,
      content: Schema.String,
      speakerEntityId: Schema.NullOr(EntityId),
      expectedRowVersion: Schema.Int,
      draft: Schema.optionalKey(Schema.Struct({ draftId: Schema.String, session: Schema.Int }))
    },
    success: QueuedMessage,
    error: Schema.Union([NotFound, StaleWrite, ServerError])
  }),
  /**
   * Takes a queued entry back before it posts, as the user last saw it (StaleWrite if
   * another tab changed it since); returns it, so its text can go back to the composer.
   */
  Rpc.make("WithdrawQueued", {
    payload: { queuedId: Schema.String, expectedRowVersion: Schema.Int },
    success: QueuedMessage,
    error: Schema.Union([NotFound, StaleWrite, ServerError])
  })
) {}
