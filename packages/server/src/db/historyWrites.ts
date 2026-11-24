import { consumeHistoryStage, prepareHistoryStage } from "./historyStages.ts"
import { bulkUndoHistory, makeBulkHistory } from "./historyBulk.ts"
import { commitPendingChat } from "./pendingChats.ts"
import { FoldableEvent, branchOwned } from "@dreamspan/shared/state.ts"
import { checkStateReferences } from "./stateRefs.ts"
import { HistoryRejected, type HistoryEdit } from "@dreamspan/shared/historyApi.ts"
import { uuidv7 } from "@dreamspan/shared/id.ts"
import { NotFound } from "@dreamspan/shared/errors.ts"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { effectiveOverride, nextSeq, writeOverride, slotDeletedIn, versionDeletedIn } from "./forkState.ts"
import { undoPresenceCorrection } from "./presenceCorrection.ts"
import { onForkPath } from "./forks.ts"
import { historyCurrent, historyFork } from "./historyShared.ts"
import { recordHistoryReduction, recordReduction } from "./historyChanges.ts"
import { transaction } from "./tx.ts"
import type { WriteOps } from "./ops.ts"

export const makeHistoryWriteHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const bulk = yield* makeBulkHistory(sql)
  const override = Effect.fnUntraced(function* (
    fork: { id: string; chat_id: string },
    edit: Pick<HistoryEdit, "kind" | "targetId">,
    valueId: string | null,
    slotId: string | null,
    changesetId: string | null,
    summariesDone = false
  ) {
    if (edit.kind === "version_replace") {
      yield* writeOverride(
        sql,
        { id: fork.id, chatId: fork.chat_id },
        { kind: "replace", targetId: edit.targetId, slotId, valueId, flag: null, changesetId, summariesDone }
      )
    } else if (edit.kind === "state_event") {
      yield* writeOverride(
        sql,
        { id: fork.id, chatId: fork.chat_id },
        {
          kind: "suppress_event",
          targetId: edit.targetId,
          slotId,
          valueId,
          flag: valueId === null ? 0 : 1,
          changesetId
        }
      )
    } else {
      const seq = yield* nextSeq(sql, fork.chat_id)
      yield* sql`INSERT INTO fork_overrides (id, chat_id, fork_id, seq, kind, target_id, slot_id, slot_depth, value_id, changeset_id)
        VALUES (${uuidv7()}, ${fork.chat_id}, ${fork.id}, ${seq}, 'summary_revision', ${edit.targetId}, ${slotId},
          (SELECT depth FROM slots WHERE id=${slotId}), ${valueId}, ${changesetId})`
    }
  })
  const handlers = {
    PrepareHistoryEdits: (input) => prepareHistoryStage(sql, bulk, input).pipe(transaction(sql, "PrepareHistoryEdits")),
    ApplyHistoryEdits: ({ userId, title, groupId: existingGroup, applications, prepared }) =>
      Effect.gen(function* () {
        if (applications.reduce((n, a) => n + a.edits.length, 0) > 10000)
          return yield* new HistoryRejected({ message: "Too many edits in one batch; narrow the search." })
        const plan = yield* consumeHistoryStage(sql, { userId, groupId: existingGroup, applications, prepared })
        const groupId = existingGroup ?? plan?.groupId ?? uuidv7()
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
          const applicationId = plan?.token ?? uuidv7()
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
            const id = plan?.changesetId ?? uuidv7()
            const seq = yield* nextSeq(sql, chatId)
            yield* sql`INSERT INTO changesets(id, chat_id, fork_id, seq, group_id, title, origin, status, created_at)
            VALUES (${id}, ${chatId}, ${forkId}, ${seq}, ${groupId}, ${title}, 'user', 'applied', ${Date.now()})`
            record = { id }
          }
          if (plan && record.id !== plan.changesetId)
            return yield* new HistoryRejected({ message: "History changed while this edit was prepared." })
          changesetIds.push(record.id)
          // A replacement saved is the user's text: a pending chat's greeting edited here commits
          // it, as a saved edit of the greeting does (db/pendingChats.ts).
          yield* commitPendingChat(sql, chatId, Date.now())
          const previousItems = yield* sql<{
            id: number
            target_kind: string
            target_id: string
          }>`SELECT id,target_kind,target_id FROM changeset_items WHERE changeset_id=${record.id}`
          const previousByTarget = new Map(previousItems.map((i) => [`${i.target_kind}:${i.target_id}`, i]))
          for (let index = 0; index < edits.length; index++) {
            const edit = edits[index]!
            let end = index
            while (end < edits.length && edits[end]!.kind === "version_replace") end++
            if (end - index >= 2) {
              const batch = edits.slice(index, end)
              for (const target of batch) {
                const key = `${forkId}:${target.kind}:${target.targetId}`
                if (seen.has(key))
                  return yield* new HistoryRejected({ message: "A batch contains the same target twice." })
                seen.add(key)
              }
              if (plan && index === 0 && end === plan.total) {
                yield* bulk.publish({
                  fork,
                  changesetId: record.id,
                  summariesIncluded: application.summariesIncluded ?? false,
                  count: plan.count
                })
              } else
                yield* bulk.apply({
                  userId,
                  fork,
                  edits: batch,
                  groupId,
                  changesetId: record.id,
                  applicationId,
                  existingGroup: !!existingGroup,
                  summariesIncluded: application.summariesIncluded ?? false,
                  ...(application.summaryIds === undefined ? {} : { summaryIds: application.summaryIds }),
                  copies
                })
              index = end - 1
              continue
            }
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
              const [live] = yield* sql`SELECT 1 FROM versions v JOIN slots s ON s.id=v.slot_id
              JOIN versions o ON o.id=${edit.targetId} WHERE v.id=${current.id}
              AND NOT ${slotDeletedIn(sql, forkId, "s")} AND NOT ${versionDeletedIn(sql, forkId, "o")}
              AND v.status <> 'generating' AND v.deleted_at IS NULL AND v.purged_at IS NULL AND s.deleted_at IS NULL AND s.purged_at IS NULL`
              if (!live) return yield* new HistoryRejected({ message: "A target is no longer editable." })
              const copyKey = `${current.id}:${edit.after}`
              const [existingCopy] =
                copies.has(copyKey) || !existingGroup
                  ? []
                  : yield* sql<{
                      id: string
                    }>`SELECT v.id FROM version_records v JOIN changesets c ON c.id=v.changeset_id
                JOIN changeset_items i ON i.changeset_id=c.id AND i.target_kind='version_replace' AND i.target_id=${edit.targetId}
                WHERE c.group_id=${groupId} AND i.before_json ->> '$.id'=${current.id} AND v.content=${edit.after}
                  AND v.source_version_id=${edit.targetId} AND v.purged_at IS NULL LIMIT 1`
              const shared = copies.get(copyKey) ?? existingCopy?.id
              afterId = shared ?? uuidv7()
              if (!shared) {
                // Copy every persisted version field, including frozen macros and provider metadata.
                const excluded = new Set([
                  // A history edit's text isn't what any script made.
                  "raw_content",
                  "raw_reasoning",
                  "raw_sections",
                  "rewrite_json",
                  "seq",
                  "id",
                  "ordinal",
                  "content",
                  "origin",
                  "source_version_id",
                  "fork_id",
                  "authoring_fork_id",
                  "fork_seq",
                  "changeset_id",
                  "created_at",
                  "updated_at"
                ])
                const columns = (yield* sql<{ name: string }>`SELECT name FROM pragma_table_info('version_records')`)
                  .map((c) => c.name)
                  .filter((c) => !excluded.has(c))
                yield* sql.unsafe(
                  `INSERT INTO version_records (id, ordinal, content, origin, source_version_id, fork_id, authoring_fork_id, changeset_id, created_at, updated_at, ${columns.join(",")})
                SELECT ?, (SELECT max(ordinal)+1 FROM versions WHERE slot_id=v.slot_id), ?, 'changeset', ?, ?, ?, ?, ?, ?, ${columns.map((c) => `v.${c}`).join(",")}
                FROM version_records v WHERE id=?`,
                  [afterId, edit.after, edit.targetId, forkId, forkId, record.id, Date.now(), Date.now(), current.id]
                )
                yield* sql`INSERT INTO version_attachments(version_id, ordinal, media_id, kind, alt_text, name, path)
                SELECT ${afterId}, ordinal, media_id, kind, alt_text, name, path FROM version_attachments WHERE version_id=${current.id}`
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
              if (edit.atSlotId && !(yield* onForkPath(sql, chatId, fork, edit.atSlotId)))
                return yield* new NotFound({ entity: "message", id: edit.atSlotId })
              const base = storedBase ?? { slot_id: edit.atSlotId ?? null, version_id: null }
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
            const previous = previousByTarget.get(`${edit.kind}:${storedEdit.targetId}`)
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
              slotId: current.slot_id ?? edit.atSlotId ?? null,
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
            // Preserve only inputs connected by edits that also covered summaries. A
            // later rename must not bless an earlier amend or messages-only rewrite.
            let preservedInputs: Array<{ id: string; amends: number; summaryIds?: ReadonlyArray<string> }> = []
            if (edit.kind === "version_replace" && application.summariesIncluded) {
              const [amends] = yield* sql<{
                n: number
              }>`SELECT count(*) AS n FROM version_history WHERE version_id=${current.id}`
              const [previousProof] =
                prior?.summaries_done === 1
                  ? yield* sql<{ after_json: string }>`SELECT after_json FROM changeset_items
                  WHERE changeset_id=${prior.changeset_id} AND target_kind='version_replace'
                    AND target_id=${edit.targetId} AND after_json ->> '$.id'=${current.id}`
                  : []
              const inherited = previousProof
                ? ((JSON.parse(previousProof.after_json) as { preservedInputs?: typeof preservedInputs })
                    .preservedInputs ?? [])
                : []
              // Keep only searched summaries that actually depend on this message. A long
              // replace therefore stores a few ids per message, not the entire search per edit.
              const scope =
                application.summaryIds === undefined
                  ? undefined
                  : (yield* sql<{ id: string }>`
                WITH RECURSIVE covering(id) AS (
                  SELECT summary_id FROM summary_inputs WHERE slot_id=${current.slot_id}
                  UNION SELECT p.summary_id FROM summary_parents p JOIN covering c ON p.parent_id=c.id
                ) SELECT id FROM covering WHERE id IN (SELECT value FROM json_each(${JSON.stringify(application.summaryIds)}))`).map(
                      (s) => s.id
                    )
              const restrict = (previous: ReadonlyArray<string> | undefined) =>
                scope === undefined
                  ? previous
                  : previous === undefined
                    ? scope
                    : scope.filter((id) => previous.includes(id))
              preservedInputs = [
                ...inherited
                  .filter((p) => p.id !== current.id)
                  .map((p) => {
                    const summaryIds = restrict(p.summaryIds)
                    return { ...p, ...(summaryIds === undefined ? {} : { summaryIds }) }
                  }),
                { id: current.id, amends: amends!.n, ...(scope === undefined ? {} : { summaryIds: scope }) }
              ]
            }
            const after = JSON.stringify({ id: afterId, content: afterContent, preservedInputs, applicationId })
            if (previous) yield* sql`UPDATE changeset_items SET after_json=${after} WHERE id=${previous.id}`
            else
              yield* sql`INSERT INTO changeset_items(changeset_id, target_kind, target_id, before_json, after_json)
            VALUES (${record.id}, ${edit.kind}, ${storedEdit.targetId}, ${before}, ${after})`
            if (edit.kind === "state_event" && !edit.targetId) {
              yield* writeOverride(
                sql,
                { id: forkId, chatId },
                {
                  kind: "suppress_event",
                  targetId: afterId,
                  slotId: current.slot_id ?? edit.atSlotId ?? null,
                  valueId: null,
                  flag: 0,
                  changesetId: record.id
                }
              )
            } else
              yield* override(fork, edit, afterId, current.slot_id, record.id, application.summariesIncluded ?? false)
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
        for (let index = 0; index < items.length; index++) {
          const item = items[index]!
          let end = index
          while (end < items.length && items[end]!.target_kind === "version_replace") end++
          if (end - index >= 2) {
            const batch = items
              .slice(index, end)
              .filter(
                (i) =>
                  (!itemIds || itemIds.includes(i.id)) &&
                  (!slotId || (JSON.parse(i.before_json) as { slotId: string }).slotId === slotId)
              )
            const result = yield* bulkUndoHistory(sql, fork, changesetId, batch)
            undone += result.undone
            conflicts.push(...result.conflicts)
            index = end - 1
            continue
          }
          const before = JSON.parse(item.before_json) as {
            id: string
            content: string
            slotId: string
            summariesDone?: number
            changesetId?: string | null
          }
          const after = JSON.parse(item.after_json) as { id: string; content: string; presenceCorrectionGroup?: string }
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
          const presence = yield* undoPresenceCorrection(
            sql,
            chatId,
            forkId,
            item.target_id,
            after.presenceCorrectionGroup
          )
          if (presence !== null) {
            if (presence) undone++
            else conflicts.push(item.id)
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
              edit.kind === "version_replace" ? (before.changesetId ?? null) : null,
              before.summariesDone === 1
            )
          const seq = yield* nextSeq(sql, chatId)
          yield* sql`INSERT INTO changeset_reverts(changeset_id, fork_id, item_id, seq) VALUES (${changesetId},${forkId},${item.id},${seq})
          ON CONFLICT(fork_id,item_id) DO UPDATE SET seq=excluded.seq`
          undone++
        }
        return { undone, conflicts }
      }).pipe(transaction(sql, "UndoHistoryEdit"))
  } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
  return handlers
})
