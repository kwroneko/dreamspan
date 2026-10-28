import type { UserId } from "@rp/shared/domain.ts"
import type { ChatId, ForkId } from "@rp/shared/chat.ts"
import { DraftKey } from "@rp/shared/drafts.ts"
import { Snippet } from "@rp/shared/snippetsApi.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { effectiveOverride, viewAt } from "./forkState.ts"
import { makeDraftStore } from "./drafts.ts"
import { makeLibraryQueries, toLibraryRef, type RefRow } from "./library.ts"
import { NotFound } from "./ops.ts"

export const snippetFork = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  userId: UserId,
  chatId: ChatId | null,
  forkId: ForkId | null
) {
  if (chatId === null) return null
  const [row] = yield* sql<{ id: string }>`SELECT f.id FROM chats c JOIN forks f
    ON f.id = coalesce(${forkId}, c.current_fork_id) AND f.chat_id = c.id
    WHERE c.id = ${chatId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL AND f.deleted_at IS NULL`
  if (!row) return yield* new NotFound({ entity: "chat", id: chatId })
  return row.id
})

/** A scoped snippet exists only in forks with a binding, including frozen inherited ones. */
export const snippetRevision = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  chatId: string,
  entity: string,
  forkId?: string
) {
  const fork = forkId ?? (yield* viewAt(sql, chatId, null))
  const [binding] = yield* sql<{
    revision: string
  }>`SELECT o.value_id AS revision FROM entities se JOIN fork_overrides o
    ON o.id = ${effectiveOverride(sql, "snippet_revision", fork, "se.id")} WHERE se.id = ${entity}`
  return binding?.revision ?? null
})

export const snippetKey = (ref: string, fork: string | null) =>
  new DraftKey({ targetKind: "snippet", targetId: ref, field: fork ?? "" })

export const readSnippet = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  userId: UserId,
  ref: RefRow,
  chatId: string | null,
  fork: string | null
) {
  const lib = makeLibraryQueries(sql)
  const head = yield* lib.loadDoc(ref.head_revision_id)
  const scope = (head.owner as { shared?: string } | undefined)?.shared
  if (ref.kind !== "note" || scope === undefined || (scope !== "global" && scope !== chatId)) return null
  const revision =
    scope === "global" ? ref.head_revision_id : yield* snippetRevision(sql, chatId!, ref.entity_id, fork!)
  if (revision === null) return null
  const doc = yield* lib.loadDoc(revision)
  const drafts = makeDraftStore(sql)
  const draft = yield* drafts.find(userId, snippetKey(ref.id, scope === "global" ? null : fork))
  return new Snippet({
    ref: toLibraryRef(ref),
    revision: revision as Snippet["revision"],
    title: String(doc.title ?? ""),
    content: String(doc.content ?? ""),
    global: scope === "global",
    draft: draft === null ? null : drafts.toDraft(draft)
  })
})
