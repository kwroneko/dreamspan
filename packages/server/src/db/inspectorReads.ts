import { selectSummaryLayer } from "./lcmLayer.ts"
import { tokensOf } from "../assembler/st.ts"
// The request inspector's reads (DESIGN §7.4; ARCHITECTURE §15): a version's context as it
// was sent, from its rollout's stored snapshot, with each piece's source named for the user.
import { createHash } from "node:crypto"
import type { ChatId, SlotId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { NotFound } from "@rp/shared/errors.ts"
import { type ContextSource, RunContext } from "@rp/shared/inspectorApi.ts"
import { Effect } from "effect"
import { SqlClient, type SqlError } from "effect/sql"
import type { ContextSnapshot, Source, WireContext, InspectionInputs } from "../assembler/types.ts"
import { builtinPreset } from "./assemblySources.ts"
import type { ReadOps } from "./ops.ts"
import type { LlmRequestRow } from "./providers.ts"
import type { InspectorUsage } from "@rp/shared/inspectorApi.ts"
import { query } from "./tx.ts"

const unique = <A>(list: ReadonlyArray<A>) => [...new Set(list)]

/**
 * Names for the sources of these snapshots' pieces: cards and notes by the revision they
 * were read at, preset prompts by the preset revision's names, messages by their place.
 */
export const describer = (
  sql: SqlClient.SqlClient,
  userId: UserId,
  chatId: ChatId,
  snapshots: ReadonlyArray<ContextSnapshot>
): Effect.Effect<(source: Source) => ContextSource, SqlError.SqlError> =>
  Effect.gen(function* () {
    const sources = snapshots.flatMap((s) => s.pieces.map((p) => p.source))
    const revisions = unique(
      sources.flatMap((s) => (s.kind === "card" || s.kind === "note" || s.kind === "lorebook" ? [s.revision] : []))
    )
    const entities =
      revisions.length === 0
        ? []
        : yield* sql<{ id: string; name: string | null; label: string | null }>`
            SELECT v.id, json_extract(v.doc_json, '$.name') AS name,
              (SELECT r.label FROM entity_refs r WHERE r.entity_id = e.id AND r.ref_kind = 'upstream') AS label
            FROM entity_revisions v JOIN entities e ON e.id = v.entity_id
            WHERE v.id IN ${sql.in(revisions)} AND e.owner_user_id = ${userId}`
    const names = new Map(entities.map((row) => [row.id, row.name ?? row.label ?? "unnamed"]))
    const presets = unique(sources.flatMap((s) => (s.kind === "preset" && s.revision !== null ? [s.revision] : [])))
    const prompts =
      presets.length === 0
        ? []
        : yield* sql<{ revision: string; identifier: string; name: string }>`
            SELECT v.id AS revision, json_extract(p.value, '$.identifier') AS identifier,
              json_extract(p.value, '$.name') AS name
            FROM entity_revisions v JOIN entities e ON e.id = v.entity_id, json_each(v.doc_json, '$.prompts') p
            WHERE v.id IN ${sql.in(presets)} AND e.owner_user_id = ${userId}`
    const promptNames = new Map(prompts.map((row) => [`${row.revision}:${row.identifier}`, row.name]))
    for (const prompt of builtinPreset.prompts) promptNames.set(`null:${prompt.identifier}`, prompt.name)
    const slots = unique(sources.flatMap((s) => (s.kind === "message" ? [s.slot] : [])))
    const depths =
      slots.length === 0
        ? []
        : yield* sql<{ id: string; depth: number }>`
            SELECT s.id, s.depth FROM slots s JOIN chats c ON c.id = s.chat_id
            WHERE s.id IN ${sql.in(slots)} AND c.id = ${chatId} AND c.owner_user_id = ${userId}`
    const depthOf = new Map(depths.map((row) => [row.id, row.depth]))

    return (source: Source): ContextSource => {
      const identity =
        source.kind === "lorebook"
          ? [source.kind, source.book, source.revision, source.uid]
          : source.kind === "note"
            ? [source.kind, source.entity, source.revision]
            : source
      const common = {
        id: createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
        activation:
          source.kind === "lorebook"
            ? { kind: "lorebook" as const, ...source.activation }
            : source.kind === "note"
              ? (source.activation ?? null)
              : null
      }
      switch (source.kind) {
        case "preset": {
          const name = promptNames.get(`${source.revision}:${source.identifier}`)
          // Its other text (`utility.new_chat_prompt`, `prefill.assistant`) by what it is.
          const other = source.identifier.replace(/^utility\./, "").replaceAll("_", " ")
          return {
            ...common,
            kind: "preset",
            label: name ? `Preset prompt “${name}”` : `Preset: ${other}`,
            slotId: null
          }
        }
        case "card":
          return {
            ...common,
            kind: "card",
            label: `Card “${names.get(source.revision) ?? "unnamed"}”: ${source.field}`,
            slotId: null
          }
        case "lorebook":
          return {
            ...common,
            kind: "lorebook",
            label: `Lorebook “${names.get(source.revision) ?? "unnamed"}”: entry ${source.uid}`,
            slotId: null
          }
        case "note":
          return { ...common, kind: "note", label: `Note “${names.get(source.revision) ?? "unnamed"}”`, slotId: null }
        case "summary":
          return {
            ...common,
            kind: "summary",
            label: `Summary, level ${source.level}, messages ${source.from}–${source.to}, revision ${source.revisionNumber}`,
            slotId: null,
            summary: { id: source.id, revision: source.revision, stale: source.stale }
          }
        case "message": {
          const depth = depthOf.get(source.slot)
          return {
            ...common,
            kind: "message",
            label: depth === undefined ? "A message" : `Message ${depth + 1}`,
            slotId: source.slot as SlotId
          }
        }
        case "direction":
          return { ...common, kind: "direction", label: "One-turn direction", slotId: null }
        case "assembler":
          return {
            ...common,
            kind: "assembler",
            label: source.what.charAt(0).toUpperCase() + source.what.slice(1),
            slotId: null
          }
      }
    }
  })

/** Explicit projection also excludes metadata from old ledger records. */
export const rolloutUsage = (sql: SqlClient.SqlClient, userId: UserId, rolloutId: string) =>
  sql<
    Pick<
      LlmRequestRow,
      | "id"
      | "status"
      | "input_uncached"
      | "cache_read"
      | "cache_write"
      | "output"
      | "usage_source"
      | "cost"
      | "cost_currency"
    >
  >`
    SELECT id, status, input_uncached, cache_read, cache_write, output, usage_source, cost, cost_currency
    FROM llm_requests INDEXED BY llm_requests_rollout WHERE rollout_id = ${rolloutId} AND owner_user_id = ${userId}
    ORDER BY started_at, id`

/** Raw display metadata leaves the reader only with generation, never through the public inspector. */
export const inspectionInputs = (sql: SqlClient.SqlClient, userId: UserId, snapshot: ContextSnapshot) =>
  Effect.gen(function* () {
    const describe = yield* describer(sql, userId, snapshot.inputs.chatId as ChatId, [snapshot])
    const { model, preset } = snapshot.inputs
    const [connection] = model
      ? yield* sql<{ name: string }>`
      SELECT name FROM connections WHERE id = ${model.connectionId} AND owner_user_id = ${userId}`
      : []
    const [presetRef] = preset.ref
      ? yield* sql<{ label: string }>`
      SELECT r.label FROM entity_refs r JOIN entities e ON e.id = r.entity_id
      WHERE r.id = ${preset.ref} AND e.owner_user_id = ${userId}`
      : []
    const sources = snapshot.request.messages.map((): Array<ContextSource> => [])
    for (const piece of snapshot.pieces) {
      const source = describe(piece.source)
      for (const i of piece.messages) {
        if (!sources[i]!.some((s) => s.id === source.id)) sources[i]!.push(source)
      }
    }
    // Continue's prefill, the message after the assembled ones, is the text it continues.
    const target = snapshot.sources?.target
    if (target?.continues && snapshot.request.prefill !== null) {
      sources.push([
        {
          id: createHash("sha256")
            .update(JSON.stringify(["continue", target.continues.version]))
            .digest("hex"),
          kind: "message",
          label: `Message ${target.depth + 1} as it was, continued from its end`,
          slotId: target.slotId as SlotId,
          activation: null
        }
      ])
    }
    return {
      model: model && {
        connection: connection?.name ?? "a deleted connection",
        model: model.key,
        kind: model.kind,
        breakpoints: model.cacheBreakpoints
      },
      preset: { label: presetRef?.label ?? null, scope: preset.scope },
      sources,
      issues: snapshot.issues
    } satisfies InspectionInputs
  })

export const makeInspectorReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const handlers = {
    RunContext: ({ userId, versionId }) =>
      Effect.gen(function* () {
        const [row] = yield* sql<{
          chat_id: string
          slot_id: string
          rollout_id: string
          status: string
          snapshot: string
          sent_context_json: string | null
        }>`
        SELECT s.chat_id, v.slot_id, r.id AS rollout_id, r.status, p.context_snapshot_json AS snapshot, p.sent_context_json
        FROM versions v JOIN slots s ON s.id = v.slot_id JOIN chats c ON c.id = s.chat_id
        JOIN rollouts r ON r.id = v.rollout_id JOIN rollout_payloads p ON p.rollout_id = r.id
        WHERE v.id = ${versionId} AND c.owner_user_id = ${userId} AND p.context_snapshot_json IS NOT NULL
          AND v.deleted_at IS NULL AND s.deleted_at IS NULL AND c.deleted_at IS NULL`
        if (!row) return yield* new NotFound({ entity: "context", id: versionId })
        const snapshot = JSON.parse(row.snapshot) as ContextSnapshot
        const chatId = row.chat_id as ChatId
        const requests = yield* rolloutUsage(sql, userId, row.rollout_id)
        const wire = row.sent_context_json ? (JSON.parse(row.sent_context_json) as WireContext) : null
        const display = wire?.display
        const current = new Map<string, { readonly revisionId: string; readonly fresh: boolean }>()
        if (snapshot.lcm?.selected.length) {
          const [settings] = yield* sql<{
            enabled: number
          }>`SELECT json_extract(value_json, '$.enabled') AS enabled FROM state_events
            WHERE chat_id = ${chatId} AND slot_id IS NULL AND scope IS NULL AND key = 'lcm.settings' ORDER BY seq DESC LIMIT 1`
          if (settings?.enabled)
            for (const summary of (yield* selectSummaryLayer(sql, userId, chatId, snapshot.inputs.leafSlotId))
              .summaries)
              current.set(summary.id, summary)
        }
        return new RunContext({
          chatId,
          slotId: row.slot_id as SlotId,
          versionId,
          builtAt: snapshot.inputs.now,
          status: row.status,
          type: snapshot.inputs.type,
          mode: snapshot.inputs.mode,
          capture: display ? "captured" : "unavailable",
          messages: display
            ? wire!.messages.map((message) => ({
                role: message.role,
                ...(message.prefill ? { prefill: message.prefill } : {}),
                name: message.name ?? null,
                content: message.content,
                tokens: tokensOf(message),
                sources: (message.sources ?? []).map((source) => {
                  if (!source.summary) return source
                  const now = current.get(source.summary.id)
                  return {
                    ...source,
                    summary: {
                      ...source.summary,
                      changed:
                        !now || now.revisionId !== source.summary.revision || (!source.summary.stale && !now.fresh)
                    }
                  }
                }),
                breakpoint: message.breakpoint ?? null
              }))
            : [],
          samplers: display ? { ...wire!.samplers } : {},
          ...(display ?? {
            model: null,
            preset: { label: null, scope: "unavailable" },
            issues: []
          }),
          requests: requests.map((r): InspectorUsage => ({
            id: r.id as InspectorUsage["id"],
            status: r.status,
            usageSource: r.usage_source,
            counts: {
              inputUncached: r.input_uncached,
              cacheRead: r.cache_read,
              cacheWrite: r.cache_write,
              output: r.output
            },
            cost: r.cost === null ? null : { amount: r.cost, currency: r.cost_currency! }
          }))
        })
      }).pipe(query("RunContext"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
  return handlers
})
