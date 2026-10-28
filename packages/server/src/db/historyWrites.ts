import { FoldableEvent, branchOwned } from "@rp/shared/state.ts"
import { checkStateReferences } from "./stateRefs.ts"
import { HistoryRejected, type HistoryEdit } from "@rp/shared/historyApi.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import { NotFound } from "@rp/shared/errors.ts"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { effectiveOverride, nextSeq, writeOverride } from "./forkState.ts"
import { historyCurrent, historyFork } from "./historyShared.ts"
import { recordHistoryReduction, recordReduction } from "./historyChanges.ts"
import { transaction } from "./tx.ts"
import type { WriteOps } from "./ops.ts"

export const makeHistoryWriteHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const override = Effect.fnUntraced(function* (
    fork: { id: string; chat_id: string },
    edit: Pick<HistoryEdit, "kind" | "targetId">,
    valueId: string | null,
    slotId: string | null,
    changesetId: string | null
  ) {
    if (edit.kind === "version_replace") {
      yield* writeOverride(
        sql,
        { id: fork.id, chatId: fork.chat_id },
        { kind: "replace", targetId: edit.targetId, slotId, valueId, flag: null }
      )
      yield* sql`UPDATE fork_overrides SET changeset_id=${changesetId} WHERE id=${effectiveOverride(sql, "replace", fork.id, `'${edit.targetId.replaceAll("'", "''")}'`)}`
    } else if (edit.kind === "state_event") {
      yield* writeOverride(
        sql,
        { id: fork.id, chatId: fork.chat_id },
        { kind: "suppress_event", targetId: edit.targetId, slotId, valueId, flag: valueId === null ? 0 : 1 }
      )
      yield* sql`UPDATE fork_overrides SET changeset_id=${changesetId} WHERE id=${effectiveOverride(sql, "suppress_event", fork.id, "'" + edit.targetId.replaceAll("'", "''") + "'")}`
    } else {
      const seq = yield* nextSeq(sql, fork.chat_id)
      yield* sql`INSERT INTO fork_overrides (id, chat_id, fork_id, seq, kind, target_id, slot_id, slot_depth, value_id, changeset_id)
        VALUES (${uuidv7()}, ${fork.chat_id}, ${fork.id}, ${seq}, 'summary_revision', ${edit.targetId}, ${slotId},
          (SELECT depth FROM slots WHERE id=${slotId}), ${valueId}, ${changesetId})`
    }
  })
  return {
    ApplyHistoryEdits: ({ userId, title, groupId: existingGroup, applications }) =>
      Effect.gen(function* () {
        if (applications.reduce((n, a) => n + a.edits.length, 0) > 10000)
          return yield* new HistoryRejected({ message: "Too many edits in one batch; narrow the search." })
        const groupId = existingGroup ?? uuidv7()
        if (existingGroup) {
          const [group] = yield* sql`SELECT 1 FROM changeset_groups WHERE id=${groupId} AND owner_user_id=${userId}`
          if (!group) return yield* new NotFound({ entity: "changeset group", id: groupId })
        } else
          yield* sql`INSERT INTO changeset_groups(id, owner_user_id, title, origin, created_at) VALUES (${groupId}, ${userId}, ${title}, 'user', ${Date.now()})`
        const changesetIds: string[] = []
        const copies = new Map<string, string>()
        const seen = new Set<string>()
        for (const application of applications) {
          const { chatId, forkId, edits } = application
          const fork = yield* historyFork(sql, userId, chatId, forkId)
          if (!edits.length) continue
          // One application per fork, even when a panel adds later replacements to its group.
          let [record] = yield* sql<{
            id: string
          }>`SELECT id FROM changesets WHERE group_id=${groupId} AND fork_id=${forkId}`
          if (record) {
            const [child] = yield* sql`SELECT 1 FROM forks f JOIN changesets c ON c.id=${record.id}
            WHERE f.parent_fork_id=${forkId} AND f.branched_at>=c.seq LIMIT 1`
            if (child) record = undefined
          }
          if (!record) {
            const id = uuidv7()
            const seq = yield* nextSeq(sql, chatId)
            yield* sql`INSERT INTO changesets(id, chat_id, fork_id, seq, group_id, title, origin, status, created_at)
            VALUES (${id}, ${chatId}, ${forkId}, ${seq}, ${groupId}, ${title}, 'user', 'applied', ${Date.now()})`
            record = { id }
          }
          changesetIds.push(record.id)
          for (const edit of edits) {
            const key = `${forkId}:${edit.kind}:${edit.targetId}`
            if (edit.targetId && seen.has(key))
              return yield* new HistoryRejected({ message: "A batch contains the same target twice." })
            seen.add(key)
            const current =
              edit.kind === "state_event" && edit.targetId === "" && edit.beforeId === ""
                ? { id: "", content: "", slot_id: null }
                : yield* historyCurrent(sql, fork, edit)
            if (!current) return yield* new NotFound({ entity: "history target", id: edit.targetId })
            if (current.id !== edit.beforeId || current.content !== edit.before)
              return yield* new HistoryRejected({
                message: "History changed since the preview. Search again before replacing."
              })
            if (edit.before === edit.after) continue
            let afterId: string
            if (edit.kind === "version_replace") {
              const [live] = yield* sql`SELECT 1 FROM versions v JOIN slots s ON s.id=v.slot_id WHERE v.id=${current.id}
              AND v.status <> 'generating' AND v.deleted_at IS NULL AND v.purged_at IS NULL AND s.deleted_at IS NULL AND s.purged_at IS NULL`
              if (!live) return yield* new HistoryRejected({ message: "A target is no longer editable." })
              const copyKey = `${current.id}:${edit.after}`
              const [existingCopy] = copies.has(copyKey)
                ? []
                : yield* sql<{ id: string }>`SELECT v.id FROM versions v JOIN changesets c ON c.id=v.changeset_id
                JOIN changeset_items i ON i.changeset_id=c.id AND i.target_kind='version_replace' AND i.target_id=${edit.targetId}
                WHERE c.group_id=${groupId} AND i.before_json ->> '$.id'=${current.id} AND v.content=${edit.after}
                  AND v.source_version_id=${edit.targetId} AND v.purged_at IS NULL LIMIT 1`
              const shared = copies.get(copyKey) ?? existingCopy?.id
              afterId = shared ?? uuidv7()
              if (!shared) {
                // Copy every persisted version field, including frozen macros and provider metadata.
                const excluded = new Set([
                  "seq",
                  "id",
                  "ordinal",
                  "content",
                  "origin",
                  "source_version_id",
                  "fork_id",
                  "fork_seq",
                  "changeset_id",
                  "created_at",
                  "updated_at"
                ])
                const columns = (yield* sql<{ name: string }>`SELECT name FROM pragma_table_info('versions')`)
                  .map((c) => c.name)
                  .filter((c) => !excluded.has(c))
                yield* sql.unsafe(
                  `INSERT INTO versions (id, ordinal, content, origin, source_version_id, fork_id, changeset_id, created_at, updated_at, ${columns.join(",")})
                SELECT ?, (SELECT max(ordinal)+1 FROM versions WHERE slot_id=v.slot_id), ?, 'changeset', ?, ?, ?, ?, ?, ${columns.map((c) => `v.${c}`).join(",")}
                FROM versions v WHERE id=?`,
                  [afterId, edit.after, edit.targetId, forkId, record.id, Date.now(), Date.now(), current.id]
                )
                yield* sql`INSERT INTO version_attachments(version_id, ordinal, media_id, kind, alt_text)
                SELECT ${afterId}, ordinal, media_id, kind, alt_text FROM version_attachments WHERE version_id=${current.id}`
                copies.set(copyKey, afterId)
              }
              yield* recordHistoryReduction(sql, current.slot_id!, edit.after, current.id, forkId)
            } else if (edit.kind === "state_event") {
              const event = yield* Schema.decodeUnknownEffect(FoldableEvent)(
                yield* Effect.try({
                  try: () => JSON.parse(edit.after),
                  catch: () => new HistoryRejected({ message: "Invalid state event JSON." })
                })
              ).pipe(Effect.mapError(() => new HistoryRejected({ message: "Invalid state event." })))
              yield* checkStateReferences(sql, userId, chatId, event.data, event.scope)
              const [storedBase] = yield* sql<{
                slot_id: string | null
                version_id: string | null
              }>`SELECT slot_id,version_id FROM state_events WHERE id=${current.id}`
              const base = storedBase ?? { slot_id: null, version_id: null }
              if (branchOwned.has(event.data.key) && (base!.slot_id !== null || event.scope !== null))
                return yield* new HistoryRejected({ message: "Branch-owned state must be chat-wide." })
              if (current.id && current.id !== edit.targetId)
                yield* writeOverride(
                  sql,
                  { id: forkId, chatId },
                  { kind: "suppress_event", targetId: current.id, slotId: current.slot_id, valueId: null, flag: 1 }
                )
              afterId = uuidv7()
              const seq = yield* nextSeq(sql, chatId)
              yield* sql`INSERT INTO state_events(id,chat_id,slot_id,version_id,seq,key,scope,value_json,origin,origin_ref,created_at,fork_id,fork_seq)
              SELECT ${afterId},${chatId},${base!.slot_id},${base!.version_id},coalesce(max(seq),-1)+1,${event.data.key},${event.scope},${JSON.stringify(event.data.value)},'changeset',${record.id},${Date.now()},${forkId},${seq}
              FROM state_events WHERE chat_id=${chatId} AND slot_id IS ${base!.slot_id}`
            } else {
              afterId = uuidv7()
              yield* sql`INSERT INTO summary_revisions(id, summary_id, content, token_count, origin, created_at)
              VALUES (${afterId}, ${edit.targetId}, ${edit.after}, ${Math.ceil(edit.after.length / 3.5)}, 'changeset', ${Date.now()})`
            }
            const storedEdit = edit.kind === "state_event" && !edit.targetId ? { ...edit, targetId: afterId } : edit
            const [previous] = yield* sql<{
              id: number
            }>`SELECT id FROM changeset_items WHERE changeset_id=${record.id} AND target_kind=${edit.kind} AND target_id=${storedEdit.targetId}`
            const [prior] =
              edit.kind === "version_replace"
                ? yield* sql<{
                    summaries_done: number
                    changeset_id: string | null
                  }>`SELECT summaries_done,changeset_id FROM fork_overrides WHERE id=${effectiveOverride(sql, "replace", forkId, "'" + edit.targetId.replaceAll("'", "''") + "'")}`
                : []
            const before = JSON.stringify({
              id: current.id,
              content: current.content,
              slotId: current.slot_id,
              summariesDone: prior?.summaries_done ?? 0,
              changesetId: prior?.changeset_id ?? null
            })
            const afterContent =
              edit.kind === "state_event"
                ? (yield* sql<{
                    content: string
                  }>`SELECT json_object('scope',scope,'data',json_object('key',key,'value',json(value_json))) AS content FROM state_events WHERE id=${afterId}`)[0]!
                    .content
                : edit.after
            const after = JSON.stringify({ id: afterId, content: afterContent })
            if (previous) yield* sql`UPDATE changeset_items SET after_json=${after} WHERE id=${previous.id}`
            else
              yield* sql`INSERT INTO changeset_items(changeset_id, target_kind, target_id, before_json, after_json)
            VALUES (${record.id}, ${edit.kind}, ${storedEdit.targetId}, ${before}, ${after})`
            if (edit.kind === "state_event" && !edit.targetId) {
              yield* writeOverride(
                sql,
                { id: forkId, chatId },
                { kind: "suppress_event", targetId: afterId, slotId: null, valueId: null, flag: 0 }
              )
              yield* sql`UPDATE fork_overrides SET changeset_id=${record.id} WHERE id=${effectiveOverride(sql, "suppress_event", forkId, "'" + afterId + "'")}`
            } else yield* override(fork, edit, afterId, current.slot_id, record.id)
            if (edit.kind === "version_replace")
              yield* sql`
            UPDATE fork_overrides SET summaries_done=${application.summariesIncluded ? 1 : 0} WHERE id=${effectiveOverride(sql, "replace", fork.id, "'" + edit.targetId.replaceAll("'", "''") + "'")}`
          }
        }
        return { groupId, changesetIds }
      }).pipe(transaction(sql, "ApplyHistoryEdits")),
    UndoHistoryEdit: ({ userId, chatId, forkId, changesetId, slotId, itemIds }) =>
      Effect.gen(function* () {
        const fork = yield* historyFork(sql, userId, chatId, forkId)
        const [visible] = yield* sql`WITH RECURSIVE ancestry(id, bound) AS (
        SELECT ${forkId}, 9223372036854775807 UNION ALL SELECT f.parent_fork_id, min(a.bound, f.branched_at)
        FROM ancestry a JOIN forks f ON f.id=a.id WHERE f.parent_fork_id IS NOT NULL)
        SELECT 1 FROM changesets c JOIN ancestry a ON a.id=c.fork_id AND c.seq<=a.bound WHERE c.id=${changesetId} AND c.chat_id=${chatId}`
        if (!visible) return yield* new NotFound({ entity: "changeset", id: changesetId })
        const items = yield* sql<{
          id: number
          target_kind: HistoryEdit["kind"]
          target_id: string
          before_json: string
          after_json: string
        }>`SELECT * FROM changeset_items WHERE changeset_id=${changesetId}`
        let undone = 0
        const conflicts: number[] = []
        for (const item of items) {
          const before = JSON.parse(item.before_json) as {
            id: string
            content: string
            slotId: string
            summariesDone?: number
            changesetId?: string | null
          }
          const after = JSON.parse(item.after_json) as { id: string; content: string }
          if (itemIds && !itemIds.includes(item.id)) continue
          if (slotId && before.slotId !== slotId) {
            if (item.target_kind !== "summary_revision") continue
            const [covered] = yield* sql`WITH RECURSIVE parents(id) AS (
            SELECT summary_id FROM summary_inputs WHERE slot_id=${slotId} UNION
            SELECT p.summary_id FROM summary_parents p JOIN parents c ON c.id=p.parent_id)
            SELECT 1 FROM parents WHERE id=${item.target_id}`
            if (!covered) continue
          }
          const edit = { kind: item.target_kind, targetId: item.target_id }
          const current = yield* historyCurrent(sql, fork, edit)
          // Comparing text as well as identity detects a later in-place amend.
          if (current?.id !== after.id || current.content !== after.content) {
            conflicts.push(item.id)
            continue
          }
          if (edit.kind === "version_replace") yield* recordReduction(sql, before.slotId, forkId)
          if (edit.kind === "state_event") {
            if (before.id && before.id !== item.target_id)
              yield* writeOverride(
                sql,
                { id: fork.id, chatId },
                { kind: "suppress_event", targetId: before.id, slotId: before.slotId, valueId: null, flag: 0 }
              )
            yield* writeOverride(
              sql,
              { id: fork.id, chatId: chatId },
              { kind: "suppress_event", targetId: after.id, slotId: before.slotId, valueId: null, flag: 1 }
            )
          }
          if (edit.kind !== "state_event" || before.id)
            yield* override(
              fork,
              edit,
              before.id === item.target_id && (edit.kind === "version_replace" || edit.kind === "state_event")
                ? null
                : before.id,
              before.slotId,
              null
            )
          if (edit.kind === "version_replace")
            yield* sql`UPDATE fork_overrides SET summaries_done=${before.summariesDone ?? 0},changeset_id=${before.changesetId ?? null}
            WHERE id=${effectiveOverride(sql, "replace", forkId, "'" + edit.targetId.replaceAll("'", "''") + "'")}`
          const seq = yield* nextSeq(sql, chatId)
          yield* sql`INSERT INTO changeset_reverts(changeset_id, fork_id, item_id, seq) VALUES (${changesetId},${forkId},${item.id},${seq})
          ON CONFLICT(fork_id,item_id) DO UPDATE SET seq=excluded.seq`
          undone++
        }
        return { undone, conflicts }
      }).pipe(transaction(sql, "UndoHistoryEdit"))
  } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
})
