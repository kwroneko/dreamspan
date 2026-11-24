// What a workshop's assistant sees without asking, and how its library classes stand
// (spec/WORKSHOP-CARDS.md §2.1, §2.5). Being in view is derived from the reply's path, never
// granted: the items attached on its messages, the items its runs made (and didn't undo), and
// what the caller names from the branch's state (the workshop's own cast, a story's cast and
// books beside it). Allow always grants are the user's settings (`workshop.cardGrants`,
// `workshop.alwaysGrants`), written only by the user's answer or Remove.
import type { UserId } from "@dreamspan/shared/domain.ts"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { capabilityDefaults, libraryClassIds, workshopCapabilities } from "../agent/capabilities.ts"
import { callsFrom } from "../agent/steps.ts"
import { inFork } from "./forkState.ts"
import { lcmPath } from "./lcmPath.ts"
import { NotFound, type ReadOps, type WriteOps } from "./ops.ts"
import { ALWAYS_GRANTS, CARD_GRANTS, putUserSetting, readSetting } from "./settings.ts"
import { resumeLineage } from "./subagentEffects.ts"
import { query, transaction } from "./tx.ts"
import { attributedEffects } from "./versionEffects.ts"

type Sql = SqlClient.SqlClient
type CardGrants = Readonly<Record<string, Readonly<Record<string, "allow">>>>
type AlwaysGrants = Readonly<Record<string, "allow">>

const cardGrantsOf = (sql: Sql, userId: string) =>
  Effect.map(readSetting(sql, "user", userId, CARD_GRANTS), ({ value }) => (value ?? {}) as CardGrants)
const alwaysGrantsOf = (sql: Sql, userId: string) =>
  Effect.map(readSetting(sql, "user", userId, ALWAYS_GRANTS), ({ value }) => (value ?? {}) as AlwaysGrants)

/**
 * The reply's runs: the top run (a subagent's is its parent's, spec/SUBAGENTS.md), the runs it
 * was resumed from, and every subagent they started. A class allowed for the reply covers them.
 */
const replyRuns = (sql: Sql, rolloutId: string) =>
  Effect.gen(function* () {
    const [top] = yield* sql<{ id: string }>`WITH RECURSIVE up(id, depth) AS (
        SELECT ${rolloutId}, 0
        UNION SELECT r.spawned_by_rollout_id, up.depth + 1 FROM up JOIN rollouts r ON r.id = up.id
          WHERE r.spawned_by_rollout_id IS NOT NULL AND up.depth < 16
      ) SELECT id FROM up ORDER BY depth DESC LIMIT 1`
    const replyId = top?.id ?? rolloutId
    const roots = (yield* resumeLineage(sql, replyId)).map((r) => r.id)
    return { replyId, runs: yield* descendants(sql, roots) }
  })

/** The runs and every subagent run they started, at any depth. */
const descendants = (sql: Sql, roots: ReadonlyArray<string>) =>
  roots.length === 0
    ? Effect.succeed([] as ReadonlyArray<string>)
    : Effect.map(
        sql<{ id: string }>`WITH RECURSIVE down(id, depth) AS (
          SELECT value, 0 FROM json_each(${JSON.stringify(roots)})
          UNION SELECT r.id, down.depth + 1 FROM down JOIN rollouts r ON r.spawned_by_rollout_id = down.id
            WHERE down.depth < 16
        ) SELECT DISTINCT id FROM down`,
        (rows) => rows.map((r) => r.id)
      )

/** Creations on visible messages, plus changes already made in the live reply. */
const visibleCreations = Effect.fnUntraced(function* (
  sql: Sql,
  chatId: string,
  versions: string,
  replyId: string | null
) {
  // Find candidates without opening the transcript of every reply in a long chat.
  const rows = yield* sql<{ rolloutId: string; versionId: string | null }>`
    WITH RECURSIVE creation_runs(id) AS (
      SELECT r.id FROM rollouts r JOIN rollout_effects e ON e.rollout_id = r.id
      WHERE r.chat_id = ${chatId} AND e.kind = 'library.create' AND e.target_kind = 'entity' AND e.undone_at IS NULL
      UNION SELECT r.spawned_by_rollout_id FROM creation_runs c JOIN rollouts r ON r.id = c.id
        WHERE r.spawned_by_rollout_id IS NOT NULL
      UNION SELECT v.rollout_id FROM creation_runs c JOIN versions src ON src.rollout_id = c.id
        JOIN versions v ON v.source_version_id = src.id WHERE v.origin = 'resumed' AND v.rollout_id IS NOT NULL
    )
    SELECT v.rollout_id AS rolloutId,
      CASE WHEN v.fork_id IS NOT NULL THEN coalesce(v.source_version_id, v.id) ELSE v.id END AS versionId
    FROM json_each(${versions}) p JOIN versions v ON v.id = p.value
      JOIN creation_runs c ON c.id = v.rollout_id
    UNION SELECT id, NULL FROM creation_runs WHERE id = ${replyId}`
  const byRollout = new Map<string, Array<string | null>>()
  for (const row of rows) {
    const messages = byRollout.get(row.rolloutId) ?? []
    messages.push(row.versionId)
    byRollout.set(row.rolloutId, messages)
  }
  const made = new Set<string>()
  for (const [rolloutId, visible] of byRollout) {
    const [run] = yield* sql<{ status: string; transcript: string | null }>`
      SELECT r.status, p.transcript_json AS transcript FROM rollouts r
      JOIN rollout_payloads p ON p.rollout_id = r.id WHERE r.id = ${rolloutId}`
    if (!run?.transcript) continue
    const transcript = JSON.parse(run.transcript) as ReadonlyArray<AgentMessage>
    const calls = new Map<string, string | null>()
    if (rolloutId === replyId) {
      const turn = transcript.findLastIndex((m) => m.role === "user" || m.role === "rpUser")
      for (const [id, result] of callsFrom(transcript.slice(turn + 1))) calls.set(id, result)
    } else {
      for (const version of visible) {
        if (version === null) continue
        for (const [id, result] of callsFrom(transcript, version, { final: run.status === "completed" }))
          calls.set(id, result)
      }
    }
    for (const effect of yield* attributedEffects(sql, rolloutId, transcript, calls, true))
      if (effect.targetKind === "entity") made.add(effect.targetId)
  }
  if (replyId !== null) {
    // In-flight calls may have committed their effects before saving their transcript result.
    const live = yield* descendants(sql, [replyId])
    const effects = yield* sql<{ target_id: string }>`SELECT target_id FROM rollout_effects
      WHERE rollout_id IN (SELECT value FROM json_each(${JSON.stringify(live)}))
        AND kind = 'library.create' AND target_kind = 'entity' AND undone_at IS NULL`
    for (const effect of effects) made.add(effect.target_id)
  }
  return [...made]
})

/**
 * What's in view on a path up to `leafSlotId` (§2.1, §4.4): the items attached on its messages,
 * those its calls and the live reply made and didn't undo, and the caller's `entities`
 * and `refs`; only the user's own, with the notes of the cards among them. Run inside `inFork`.
 */
const pathView = (
  sql: Sql,
  userId: string,
  chatId: string,
  leafSlotId: string | null,
  replyId: string | null,
  entities: ReadonlyArray<string>,
  refs: ReadonlyArray<string>
) =>
  Effect.gen(function* () {
    const path =
      leafSlotId === null
        ? []
        : yield* lcmPath(
            sql,
            userId as UserId,
            chatId,
            leafSlotId,
            undefined,
            Number.MAX_SAFE_INTEGER,
            undefined,
            false
          )
    const versions = JSON.stringify(path.flatMap(({ versionId }) => (versionId ? [versionId] : [])))
    const made = yield* visibleCreations(sql, chatId, versions, replyId)
    const seen = yield* sql<{ id: string }>`
      SELECT r.entity_id AS id FROM version_library l JOIN entity_refs r ON r.id = l.ref_id
        WHERE l.version_id IN (SELECT value FROM json_each(${versions}))
      UNION SELECT value FROM json_each(${JSON.stringify(made)})
      UNION SELECT r.entity_id FROM entity_refs r WHERE r.id IN (SELECT value FROM json_each(${JSON.stringify(refs)}))
      UNION SELECT value FROM json_each(${JSON.stringify(entities)})`
    const owned = (yield* sql<{ id: string }>`SELECT e.id FROM entities e
      WHERE e.owner_user_id = ${userId} AND e.id IN (SELECT value FROM json_each(${JSON.stringify(seen.map((s) => s.id))}))`).map(
      (o) => o.id
    )
    const notes =
      owned.length === 0
        ? []
        : yield* sql<{ id: string }>`SELECT e.id FROM entities e JOIN entity_refs r ON r.entity_id = e.id
            JOIN entity_revisions h ON h.id = r.head_revision_id
          WHERE e.owner_user_id = ${userId} AND e.kind = 'note' AND e.deleted_at IS NULL
            AND json_extract(h.doc_json, '$.owner.card') IN (SELECT value FROM json_each(${JSON.stringify(owned)}))`
    return { inView: [...new Set([...owned, ...notes.map((n) => n.id)])], versions }
  })

/** The cards a grant names, with their names now; a card gone from the library keeps its id. */
const grantedCards = (sql: Sql, userId: string, grants: CardGrants) =>
  Effect.gen(function* () {
    const ids = Object.keys(grants).filter((id) => Object.keys(grants[id] ?? {}).length > 0)
    if (ids.length === 0) return []
    const rows = yield* sql<{ entity_id: string; ref_id: string | null; label: string | null }>`
      SELECT e.id AS entity_id, r.id AS ref_id, r.label FROM entities e
        LEFT JOIN entity_refs r ON r.entity_id = e.id
      WHERE e.owner_user_id = ${userId} AND e.id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`
    const known = new Map(rows.map((r) => [r.entity_id, r]))
    return ids.map((entityId) => ({
      entityId,
      refId: known.get(entityId)?.ref_id ?? null,
      name: known.get(entityId)?.label ?? "A card no longer in your library",
      classes: libraryClassIds.filter((id) => grants[entityId]?.[id] === "allow")
    }))
  })

const libraryGrantsOf = (sql: Sql, userId: string) =>
  Effect.gen(function* () {
    const always = yield* alwaysGrantsOf(sql, userId)
    const cards = yield* grantedCards(sql, userId, yield* cardGrantsOf(sql, userId))
    return {
      classes: workshopCapabilities
        .list()
        .filter((entry) => entry.scoped)
        .sort((a, b) => a.order - b.order)
        .map((entry) => ({ id: entry.id, label: entry.label })),
      always: libraryClassIds.filter((id) => always[id] === "allow"),
      cards: cards.filter((card) => card.classes.length > 0).sort((a, b) => a.name.localeCompare(b.name)) as never
    }
  })

/** A class the registry knows, with a default (Ask first): only those take an Allow always. */
const knownClass = (capability: string) =>
  workshopCapabilities.get(capability)?.scoped !== undefined && capabilityDefaults.get(capability) !== undefined

/** Writes an Allow always, for one card or for every workshop. In the caller's transaction. */
export const writeClassGrant = (sql: Sql, userId: string, capability: string, cardEntityId: string | null) =>
  Effect.gen(function* () {
    if (!knownClass(capability)) return
    if (cardEntityId === null) {
      yield* putUserSetting(sql, userId, ALWAYS_GRANTS, {
        ...(yield* alwaysGrantsOf(sql, userId)),
        [capability]: "allow"
      })
      return
    }
    const [card] =
      yield* sql`SELECT 1 FROM entities WHERE id = ${cardEntityId} AND owner_user_id = ${userId} AND kind = 'card'`
    if (!card) return yield* new NotFound({ entity: "card", id: cardEntityId })
    const grants = yield* cardGrantsOf(sql, userId)
    yield* putUserSetting(sql, userId, CARD_GRANTS, {
      ...grants,
      [cardEntityId]: { ...grants[cardEntityId], [capability]: "allow" }
    })
  })

export const makeWorkshopSightReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    LibraryGrants: ({ userId }) => libraryGrantsOf(sql, userId).pipe(query("LibraryGrants")),
    LibraryAccess: ({ userId, chatId, forkId, leafSlotId, rolloutId, entities, refs, card }) =>
      Effect.gen(function* () {
        const [chat] = yield* sql`SELECT 1 FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId}
          AND kind = 'workshop' AND deleted_at IS NULL`
        if (!chat) return yield* new NotFound({ entity: "workshop", id: chatId })
        const { replyId, runs } = yield* replyRuns(sql, rolloutId)
        const { inView } = yield* pathView(sql, userId, chatId, leafSlotId, replyId, entities, refs)
        const chatGrants = yield* sql<{ capability: string; mode: "off" | "ask" | "allow" }>`SELECT capability, mode
          FROM workshop_grants WHERE chat_id = ${chatId} AND owner_user_id = ${userId} AND target = ''
            AND capability IN (SELECT value FROM json_each(${JSON.stringify(libraryClassIds)}))
            AND (expires_at IS NULL OR expires_at > ${Date.now()})`
        const answers = yield* sql<{ capability: string; status: "used" | "denied"; note: string | null }>`
          SELECT capability, status, note FROM tool_approvals
          WHERE rollout_id IN (SELECT value FROM json_each(${JSON.stringify(runs)}))
            AND capability IN (SELECT value FROM json_each(${JSON.stringify(libraryClassIds)}))
            AND json_type(prompt_json, '$.scoped') = 'object'
            AND ((status = 'used' AND answer <> 'deny') OR status = 'denied')
          ORDER BY answered_at DESC`
        const [named] =
          card === null
            ? []
            : yield* sql<{ label: string }>`SELECT r.label FROM entities e JOIN entity_refs r ON r.entity_id = e.id
                WHERE e.id = ${card} AND e.owner_user_id = ${userId} AND e.kind = 'card'`
        return {
          inView,
          replyId,
          card: card !== null && named ? { entityId: card, name: named.label } : null,
          chat: chatGrants,
          cardGrants: card !== null && named ? ((yield* cardGrantsOf(sql, userId))[card] ?? {}) : {},
          always: yield* alwaysGrantsOf(sql, userId),
          replyAllowed: [...new Set(answers.filter((a) => a.status === "used").map((a) => a.capability))],
          replyDeclined: answers
            .filter((a) => a.status === "denied")
            .map(({ capability, note }) => ({ capability, note }))
        }
      }).pipe(inFork(sql, chatId, forkId, leafSlotId), query("LibraryAccess")),
    ChangedInViewSince: ({ userId, chatId, forkId, leafSlotId, entities }) =>
      Effect.gen(function* () {
        const [chat] = yield* sql`SELECT 1 FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId}
          AND kind = 'workshop' AND deleted_at IS NULL`
        if (!chat) return yield* new NotFound({ entity: "workshop", id: chatId })
        const { inView, versions } = yield* pathView(sql, userId, chatId, leafSlotId, null, entities, [])
        if (inView.length === 0) return []
        // A reply on another path hasn't seen the items on this path.
        const [last] = yield* sql<{ at: number | null }>`SELECT max(r.completed_at) AS at
          FROM versions v JOIN rollouts r ON r.id = v.rollout_id
          WHERE v.id IN (SELECT value FROM json_each(${versions}))
            AND r.chat_id = ${chatId} AND r.status = 'completed'`
        if (last?.at == null) return []
        const rows = yield* sql<{
          kind: string
          label: string
          before_doc: string | null
          head_doc: string
          origins: string
        }>`SELECT e.kind, r.label, h.doc_json AS head_doc,
            (SELECT b.doc_json FROM entity_revisions b WHERE b.entity_id = e.id AND b.created_at <= ${last.at}
              ORDER BY b.seq DESC LIMIT 1) AS before_doc,
            (SELECT json_group_array(DISTINCT v.origin) FROM entity_revisions v
              WHERE v.entity_id = e.id AND v.created_at > ${last.at}
                -- This workshop's own edits are in its transcript; a revert is told by its own line.
                AND NOT (v.origin = 'agent' AND substr(v.origin_ref, 1, instr(v.origin_ref, ':') - 1)
                  IN (SELECT id FROM rollouts WHERE chat_id = ${chatId}))
                AND NOT EXISTS (SELECT 1 FROM change_reversals c WHERE c.head_after = v.id)) AS origins
          FROM entities e JOIN entity_refs r ON r.entity_id = e.id JOIN entity_revisions h ON h.id = r.head_revision_id
          WHERE e.owner_user_id = ${userId} AND e.deleted_at IS NULL AND h.created_at > ${last.at}
            AND e.id IN (SELECT value FROM json_each(${JSON.stringify(inView)}))
            -- Attached as it is now: the message carries it, so it's seen.
            AND NOT EXISTS (SELECT 1 FROM version_library l WHERE l.revision_id = r.head_revision_id
              AND l.version_id IN (SELECT value FROM json_each(${versions})))
          ORDER BY r.label`
        return rows.flatMap((row) => {
          const by = JSON.parse(row.origins) as Array<string>
          if (row.before_doc === null || by.length === 0) return []
          const before = JSON.parse(row.before_doc) as Record<string, unknown>
          const after = JSON.parse(row.head_doc) as Record<string, unknown>
          const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
            (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key])
          )
          return fields.length === 0 ? [] : [{ kind: row.kind, name: row.label, fields, by }]
        })
      }).pipe(inFork(sql, chatId, forkId, leafSlotId), query("ChangedInViewSince"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})

export const makeWorkshopSightWriteHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    RemoveLibraryGrant: ({ userId, capability, entityId }) =>
      Effect.gen(function* () {
        if (entityId === undefined) {
          const { [capability]: _, ...rest } = yield* alwaysGrantsOf(sql, userId)
          yield* putUserSetting(sql, userId, ALWAYS_GRANTS, rest)
        } else {
          const grants = yield* cardGrantsOf(sql, userId)
          const { [capability]: _, ...rest } = grants[entityId] ?? {}
          const { [entityId]: __, ...others } = grants
          yield* putUserSetting(
            sql,
            userId,
            CARD_GRANTS,
            Object.keys(rest).length ? { ...others, [entityId]: rest } : others
          )
        }
        return yield* libraryGrantsOf(sql, userId)
      }).pipe(transaction(sql, "RemoveLibraryGrant"))
  } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
})
