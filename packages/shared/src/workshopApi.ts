import { EntityId, ForkId, MessageLibrary, SlotId } from "./chat.ts"
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Chat } from "./chat.ts"
import { Forbidden, NotFound, ServerError } from "./errors.ts"
import { GenerationUnavailable } from "./chatApi.ts"

/** What the assistant may do with a capability in one workshop (spec/WORKSHOP.md §3.4). */
export const CapabilityMode = Schema.Literals(["allow", "ask", "off"])
export type CapabilityMode = typeof CapabilityMode.Type

export const WorkshopCapability = Schema.Struct({
  id: Schema.String,
  order: Schema.Number,
  label: Schema.String,
  explanation: Schema.String,
  /** A plain example of what it covers, for the hover explanation. */
  example: Schema.optionalKey(Schema.String),
  /** How it stands in this workshop: the workshop's choice, else the default. */
  mode: CapabilityMode,
  /** The default, from the one registered defaults table. */
  defaultMode: CapabilityMode,
  /** The choices it offers, in order; one means it can't be changed. */
  modes: Schema.Array(CapabilityMode),
  /** This workshop chose `mode` (it isn't the default). */
  chosen: Schema.Boolean,
  /** Only one choice: it can't be changed. */
  always: Schema.optionalKey(Schema.Boolean),
  /**
   * What the row is for within its capability: an MCP server's connection id (spec/MCP.md §5.1).
   * Absent: the capability as a whole.
   */
  target: Schema.optionalKey(Schema.String),
  /** A consent the client asks for before turning it on (no sandbox, spec/FILES-AND-ENVIRONMENT.md §3.7). */
  confirm: Schema.optionalKey(
    Schema.Struct({
      title: Schema.String,
      body: Schema.String,
      confirmLabel: Schema.String,
      cancelLabel: Schema.String
    })
  )
})
export type WorkshopCapability = typeof WorkshopCapability.Type

/** A folder on the server an admin can't use as a working folder (spec/FILES-AND-ENVIRONMENT.md §3.7). */
export class HostFolderRefused extends Schema.TaggedError<HostFolderRefused>()("HostFolderRefused", {
  message: Schema.String
}) {}

/** A folder in the server folder browser (§3.7): the roots HOST_FOLDERS allows when `path` is null. */
const HostFolderListing = Schema.Struct({
  path: Schema.NullOr(Schema.String),
  /** Where Up goes: a folder, "" for the list of allowed folders, null at that list. */
  parent: Schema.NullOr(Schema.String),
  folders: Schema.Array(Schema.Struct({ name: Schema.String, path: Schema.String })),
  truncated: Schema.Boolean
})

/** An approval the server refused: answered already, no longer waiting, or for another call. */
export class ApprovalRefused extends Schema.TaggedError<ApprovalRefused>()("ApprovalRefused", {
  message: Schema.String
}) {}

/** A grant the server refused: a capability this workshop doesn't offer, or a choice it can't take. */
export class GrantRefused extends Schema.TaggedError<GrantRefused>()("GrantRefused", {
  message: Schema.String
}) {}

export const ApprovalAnswer = Schema.Literals(["allow", "allow_chat", "deny"])
export type ApprovalAnswer = typeof ApprovalAnswer.Type

export class EffectUndoRefused extends Schema.TaggedError<EffectUndoRefused>()("EffectUndoRefused", {
  message: Schema.String
}) {}

export const RolloutEffectRecord = Schema.Struct({
  kind: Schema.String,
  targetKind: Schema.String,
  targetId: Schema.String,
  title: Schema.String,
  undo: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))
})
export type RolloutEffectRecord = typeof RolloutEffectRecord.Type
export const RolloutEffect = Schema.Struct({
  rolloutId: Schema.String,
  toolCallId: Schema.String,
  seq: Schema.Int,
  ...RolloutEffectRecord.fields,
  undoResult: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
  undoneAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
  /**
   * Made by a subagent (spec/SUBAGENTS.md §8): its handle, and the reply's run and `agent` call
   * that started it, so the change is listed and kept with that call.
   */
  subagent: Schema.optionalKey(
    Schema.Struct({ handle: Schema.String, rolloutId: Schema.String, callId: Schema.String })
  )
})
export type RolloutEffect = typeof RolloutEffect.Type
/**
 * What "Undo all of this reply" did: the changes it undid, newest first; the one it couldn't undo
 * and why; and the older ones it left untried because of it.
 */
export const UndoAllReport = Schema.Struct({
  undone: Schema.Array(RolloutEffect),
  refused: Schema.NullOr(Schema.Struct({ effect: RolloutEffect, reason: Schema.String })),
  left: Schema.Array(RolloutEffect)
})
export type UndoAllReport = typeof UndoAllReport.Type
export const ReplyEffects = { chatId: Chat.fields.id, rolloutId: Schema.String }
export const EffectKey = { rolloutId: Schema.String, toolCallId: Schema.String, seq: Schema.Int }
export const EffectList = {
  chatId: Chat.fields.id,
  before: Schema.optionalKey(
    Schema.Struct({ createdAt: Schema.Number, rolloutId: Schema.String, toolCallId: Schema.String, seq: Schema.Int })
  ),
  limit: Schema.optionalKey(Schema.Int)
}

/** What new workshops start with; null where none is set yet or it is gone. */
export const WorkshopDefaults = Schema.Struct({
  card: Schema.NullOr(Schema.String),
  preset: Schema.NullOr(Schema.String),
  persona: Schema.NullOr(Schema.String),
  /** True while no workshop persona was ever chosen: the next workshop makes one from the account's name. */
  makesPersona: Schema.optionalKey(Schema.Boolean)
})
export type WorkshopDefaults = typeof WorkshopDefaults.Type

/**
 * A new workshop's prompt preset, chosen before its first message (owner, 2026-11-17): kept for
 * this workshop (`Lock`, a preset ref of the user's, or null for the built-in one), or following
 * the account's preset (`Account`). Absent: the workshop default preset, kept for this workshop.
 */
export const WorkshopPresetChoice = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Lock"), ref: Schema.NullOr(Schema.String) }),
  Schema.Struct({ _tag: Schema.Literal("Account") })
])
export type WorkshopPresetChoice = typeof WorkshopPresetChoice.Type

/** What an attached workshop is about: the story's title, or that it was deleted (no title then). */
export const WorkshopStory = Schema.Struct({
  workshopId: Chat.fields.id,
  storyId: Chat.fields.id,
  title: Schema.NullOr(Schema.String)
})
export type WorkshopStory = typeof WorkshopStory.Type

/**
 * A capability's standing chosen before a workshop's first message (owner, 2026-11-17: the
 * composer before the first send is the saved one): as `SetWorkshopGrant` takes it, null for the
 * default. The server takes only what a new workshop offers, as the strip lists it.
 */
export const WorkshopGrantChoice = Schema.Struct({
  capability: Schema.String,
  mode: Schema.NullOr(CapabilityMode),
  /** One target of the capability (an MCP server's connection id); absent: the capability's own standing. */
  target: Schema.optionalKey(Schema.String)
})
export type WorkshopGrantChoice = typeof WorkshopGrantChoice.Type

export const WorkshopCreationFields = {
  title: Schema.optionalKey(Schema.String),
  attachTo: Schema.optionalKey(Chat.fields.id),
  /** Absent: the story's current fork. */
  attachFork: Schema.optionalKey(ForkId),
  card: Schema.optionalKey(Schema.String),
  persona: Schema.optionalKey(Schema.NullOr(Schema.String)),
  preset: Schema.optionalKey(WorkshopPresetChoice),
  grants: Schema.optionalKey(Schema.Array(WorkshopGrantChoice).check(Schema.isMaxLength(256)))
}

export const WorkshopStartFields = {
  ...WorkshopCreationFields,
  requestId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  first: Schema.Union([
    Schema.TaggedStruct("Send", {
      content: Schema.String,
      /** Cards, lorebooks and presets the first message carries (spec/WORKSHOP-CARDS.md §4.1 point 3). */
      library: Schema.optionalKey(MessageLibrary)
    }),
    Schema.TaggedStruct("Generate", { direction: Schema.String })
  ]),
  /** The picked speaker, if still in the new workshop's cast. Otherwise use its persona. */
  speaker: Schema.NullOr(EntityId)
}

export const WorkshopStarted = Schema.Struct({
  chat: Chat,
  forkId: ForkId,
  slotId: SlotId,
  speaker: Schema.NullOr(EntityId),
  kind: Schema.Literals(["Send", "Generate"])
})

/**
 * One branch of a workshop beside a story and the story branch it goes with
 * (spec/WORKSHOP-BRANCHES.md §8): `story` null when that branch isn't live, or for a workshop
 * beside no story. Ordered by the branch chatted in last first.
 */
export const WorkshopBranch = Schema.Struct({
  forkId: ForkId,
  story: Schema.NullOr(
    Schema.Struct({
      chatId: Chat.fields.id,
      forkId: ForkId,
      name: Schema.NullOr(Schema.String),
      original: Schema.Boolean,
      createdAt: Schema.Number
    })
  )
})
export type WorkshopBranch = typeof WorkshopBranch.Type

export class WorkshopApi extends RpcGroup.make(
  Rpc.make("ListWorkshopCapabilities", {
    payload: { chatId: Chat.fields.id },
    success: Schema.Array(WorkshopCapability),
    error: Schema.Union([NotFound, ServerError])
  }),
  /**
   * What a workshop not made yet would offer, at its defaults: one of its own, or (`attachTo`)
   * one beside that story. Its composer's chip lists these before the first send.
   */
  Rpc.make("ListNewWorkshopCapabilities", {
    payload: { attachTo: Schema.optionalKey(Chat.fields.id) },
    success: Schema.Array(WorkshopCapability),
    error: Schema.Union([NotFound, ServerError])
  }),
  /**
   * A new workshop. `card`: the card to talk to (any of the user's cards; default the workshop's
   * default assistant). `persona`: who the user is there (default the workshop persona, never
   * the story one; null for none). `attachTo`: a side chat beside that story, reading it through
   * its tools (spec/WORKSHOP.md §4); it never plays the story's persona or one of its cards.
   * `preset`: its prompt preset (`WorkshopPresetChoice`; default the workshop default preset).
   * `grants`: what the assistant may do there, chosen before its first message; each must be one
   * a new workshop offers (`ListNewWorkshopCapabilities`), else `GrantRefused` and nothing is made.
   */
  Rpc.make("CreateWorkshop", {
    payload: WorkshopCreationFields,
    success: Chat,
    error: Schema.Union([NotFound, GrantRefused, ServerError])
  }),
  /** Creates a workshop and writes its first turn together. Retries keep the first result. */
  Rpc.make("StartWorkshop", {
    payload: WorkshopStartFields,
    success: WorkshopStarted,
    error: Schema.Union([NotFound, GrantRefused, GenerationUnavailable, ServerError])
  }),
  /** The workshops beside a story, newest first; with `forkId`, those with a branch going with that story branch. */
  Rpc.make("ListAttachedWorkshops", {
    payload: { chatId: Chat.fields.id, forkId: Schema.optionalKey(ForkId) },
    success: Schema.Array(Chat),
    error: Schema.Union([NotFound, ServerError])
  }),
  /**
   * The working-folder chip's popover (spec/FILES-AND-ENVIRONMENT.md §2.2): where the folder stored
   * on the branch (`stored`, from the cast) is now (`current`: found again by inode after a rename;
   * null: gone), the folders picked last, and the folder remembered for the workshop's assistant
   * card (`card`, with its name) when it differs from the stored one.
   */
  Rpc.make("WorkshopFolderChoices", {
    payload: {
      chatId: Chat.fields.id,
      stored: Schema.NullOr(
        Schema.Struct({
          path: Schema.String,
          inode: Schema.NullOr(Schema.Number),
          host: Schema.optionalKey(Schema.Literal(true))
        })
      ),
      cardId: Schema.NullOr(Schema.String)
    },
    success: Schema.Struct({
      current: Schema.NullOr(Schema.String),
      recent: Schema.Array(Schema.String),
      card: Schema.NullOr(Schema.String),
      /** The caller may choose a folder on the server (an admin, with HOST_FOLDERS set; §3.7). */
      hostFolders: Schema.Boolean
    }),
    error: Schema.Union([NotFound, ServerError])
  }),
  /**
   * A folder on the server's subfolders for choosing a working folder (§3.7), under HOST_FOLDERS;
   * null lists the allowed folders. Admins only.
   */
  Rpc.make("ListHostFolders", {
    payload: { path: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4096))) },
    success: HostFolderListing,
    error: Schema.Union([Forbidden, HostFolderRefused, ServerError])
  }),
  /** A workshop's branches, each with the story branch it goes with. */
  Rpc.make("ListWorkshopBranches", {
    payload: { chatId: Chat.fields.id },
    success: Schema.Array(WorkshopBranch),
    error: Schema.Union([NotFound, ServerError])
  }),
  /** The story each of these workshops is about (its title, or deleted); none for one without. */
  Rpc.make("ListWorkshopStories", {
    payload: { chatIds: Schema.Array(Chat.fields.id) },
    success: Schema.Array(WorkshopStory),
    error: Schema.Union([ServerError])
  }),
  /** The workshop defaults: the assistant card, the preset and the persona new workshops start with. */
  Rpc.make("GetWorkshopDefaults", {
    payload: {},
    success: WorkshopDefaults,
    error: Schema.Union([ServerError])
  }),
  /** Sets the workshop persona new workshops start with; the story default persona never changes. */
  Rpc.make("SetWorkshopPersona", {
    payload: { persona: Schema.NullOr(Schema.String) },
    success: WorkshopDefaults,
    error: Schema.Union([NotFound, ServerError])
  }),
  Rpc.make("ListRolloutEffects", {
    payload: EffectList,
    success: Schema.Array(RolloutEffect),
    error: Schema.Union([NotFound, ServerError])
  }),
  Rpc.make("UndoRolloutEffect", {
    payload: EffectKey,
    success: RolloutEffect,
    error: Schema.Union([NotFound, EffectUndoRefused, ServerError])
  }),
  /** Undoes every change one reply made, newest first, stopping at the first that can't be undone. */
  Rpc.make("UndoRolloutEffects", {
    payload: ReplyEffects,
    success: UndoAllReport,
    error: Schema.Union([NotFound, ServerError])
  }),
  /** Sets what the assistant may do with a capability in this workshop; null goes back to the default. */
  Rpc.make("SetWorkshopGrant", {
    payload: {
      chatId: Chat.fields.id,
      capability: Schema.String,
      mode: Schema.NullOr(CapabilityMode),
      /** The row's `target` (an MCP server), when it has one. */
      target: Schema.optionalKey(Schema.String),
      /**
       * The user agreed to the row's `confirm` just now. Required to turn on a row that has one;
       * the server records it with the grant.
       */
      consented: Schema.optionalKey(Schema.Boolean)
    },
    success: Schema.Array(WorkshopCapability),
    error: Schema.Union([NotFound, GrantRefused, ServerError])
  }),
  /**
   * Answers a tool call waiting for the user, bound to that call: its rollout, its id and its
   * arguments' digest. `allow_chat` also allows the capability in this workshop.
   */
  Rpc.make("AnswerToolApproval", {
    payload: {
      rolloutId: Schema.String,
      toolCallId: Schema.String,
      digest: Schema.String,
      answer: ApprovalAnswer,
      note: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000)))
    },
    success: Schema.Struct({ waiting: Schema.Boolean }),
    error: Schema.Union([NotFound, ApprovalRefused, ServerError])
  }),
  /** The changes a reply's run made, for its steps' Undo and Open and the regenerate warning. */
  Rpc.make("ListVersionEffects", {
    payload: { versionId: Schema.String },
    success: Schema.Array(RolloutEffect),
    error: Schema.Union([NotFound, ServerError])
  })
) {}
