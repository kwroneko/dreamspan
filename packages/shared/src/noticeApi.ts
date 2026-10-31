// What a user hears about wherever they are in the app (DESIGN §10.1, CLIENT-FRAMEWORK R13),
// merged into AppApi: a reply that finished in any of their chats, so a chat they aren't
// looking at gets a badge, and the tab's title and icon say so.
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { ChatId, SlotId, VersionId } from "./chat.ts"
import { Draft } from "./drafts.ts"
import { ServerError } from "./errors.ts"
import { StImportId, StImportStatus } from "./stImportApi.ts"

export const Notice = Schema.Union([
  /** A generation ended on its own: complete, or failed with its cause on the version. */
  Schema.TaggedStruct("ReplyFinished", {
    chatId: ChatId,
    slotId: SlotId,
    versionId: VersionId,
    status: Schema.Literals(["complete", "failed"])
  }),
  Schema.TaggedStruct("UserDraftChanged", { draft: Draft }),
  /** Initial subscription and backlog overflow: re-read open private draft workspaces. */
  Schema.TaggedStruct("UserDraftSync", {}),
  /** An ST folder import made progress or ended (ARCHITECTURE.md §13): at most about once a second per import. */
  Schema.TaggedStruct("StImportChanged", { importId: StImportId, status: StImportStatus })
])
export type Notice = typeof Notice.Type

export class NoticeApi extends RpcGroup.make(
  /** The caller's notices from now on, in batches. Only ever the caller's own. */
  Rpc.make("SubscribeNotices", { success: Schema.Array(Notice), error: ServerError, stream: true })
) {}
