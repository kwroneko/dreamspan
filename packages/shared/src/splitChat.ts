import { BinChanged, BinItem } from "./bin.ts"
import { Rpc, RpcGroup } from "effect/rpc"
import { NotFound, ServerError } from "./errors.ts"
import { Schema } from "effect"
import { ChatId, ForkId, ForkSplit, SlotId } from "./chat.ts"
import { EditRefused } from "./editorApi.ts"

/** A title change guarded by the branch name the confirmation actually showed. */
export const SplitChatTitle = Schema.Struct({
  name: Schema.String.check(Schema.isMaxLength(200)),
  expectedName: Schema.NullOr(Schema.String)
})
export const SetSplitChatFields = {
  forkId: ForkId,
  split: Schema.Boolean,
  title: Schema.optionalKey(SplitChatTitle)
}

/** A navigation group; chatId remains the unchanged physical chat owning its history. */
export const SplitChatLink = Schema.Struct({
  id: ChatId,
  chatId: ChatId,
  forkId: ForkId,
  rootForkId: ForkId,
  title: Schema.String,
  /** The group's own picture (SetChatPicture), a media id; absent: its characters' faces. */
  picture: Schema.optionalKey(Schema.String),
  slotId: Schema.NullOr(SlotId),
  /** Where a split group's first branch parts from the chat it was split from; null for an original group. */
  split: Schema.NullOr(ForkSplit)
})
export type SplitChatLink = typeof SplitChatLink.Type
export const SplitChats = Schema.Struct({
  group: SplitChatLink,
  parent: Schema.NullOr(SplitChatLink),
  children: Schema.Array(SplitChatLink),
  forkIds: Schema.Array(ForkId),
  hasSplits: Schema.Boolean,
  canSplit: Schema.Boolean
})
export type SplitChats = typeof SplitChats.Type

export class SplitChatApi extends RpcGroup.make(
  Rpc.make("DeleteChatGroup", {
    payload: { chatId: ChatId, forkId: ForkId, expectedForkIds: Schema.Array(ForkId) },
    success: Schema.Struct({ item: BinItem, next: Schema.NullOr(SplitChatLink) }),
    error: Schema.Union([NotFound, ServerError, BinChanged])
  }),
  Rpc.make("GetSplitChats", {
    payload: { chatId: ChatId, forkId: Schema.NullOr(ForkId) },
    success: SplitChats,
    error: Schema.Union([NotFound, ServerError])
  }),
  /**
   * Gives a chat its own picture, shown in lists and its header in place of its characters'
   * faces; null removes it. `chatId` is the chat as lists name it (`SplitChatLink.id`), so a
   * chat split off from another has its own. `mediaId`: an image the user uploaded
   * (`POST /chat/image`). Returns the picture it had, for Undo. Here, with the split chats,
   * so the core group stays under TypeScript's instantiation limit.
   */
  Rpc.make("SetChatPicture", {
    payload: { chatId: ChatId, mediaId: Schema.NullOr(Schema.String.check(Schema.isMaxLength(64))) },
    success: Schema.Struct({ previous: Schema.NullOr(Schema.String) }),
    error: Schema.Union([NotFound, ServerError])
  }),
  Rpc.make("SetSplitChat", {
    payload: SetSplitChatFields,
    success: Schema.Void,
    error: Schema.Union([NotFound, ServerError, EditRefused])
  })
) {}
