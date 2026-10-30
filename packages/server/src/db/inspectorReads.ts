import { eventApplies, inFork, viewAt } from "./forkState.ts"
import { selectSummaryLayer } from "./lcmLayer.ts"
import { tokensOf } from "../assembler/st.ts"
import { contextImage, wireImages } from "../assembler/imageTokens.ts"
// The request inspector's reads (DESIGN §7.4; ARCHITECTURE §15): a version's context as it
// was sent, from its rollout's stored snapshot, with each piece's source named for the user.
import { createHash } from "node:crypto"
import type { ChatId, SlotId, VersionId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { NotFound } from "@rp/shared/errors.ts"
import { type ContextSource, type RequestFigures, RunContext, versionMetricsOf } from "@rp/shared/inspectorApi.ts"
import type { Assembler } from "../assembler/assembler.ts"
import { withAssemblyModules } from "../assembler/modules.ts"
import { fallbackDescription } from "../assembler/sourceDescriptors.ts"
import { Effect } from "effect"
import { SqlClient, type SqlError } from "effect/sql"
import type { ContextSnapshot, Source, WireContext, InspectionInputs, InspectionNode } from "../assembler/types.ts"
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
  snapshots: ReadonlyArray<ContextSnapshot>,
  assembler: Assembler
): Effect.Effect<(source: Source) => ContextSource, SqlError.SqlError> =>
  Effect.gen(function* () {
    // Copy active entries while the trusted request's module scope is open.
    const descriptors = yield* withAssemblyModules(
      assembler,
      Effect.sync(() => new Map(assembler.sourceDescriptors.list().map((entry) => [entry.id, entry])))
    )
    const sources = snapshots.flatMap((s) => [...s.pieces.map((p) => p.source), ...(s.skippedPrompts ?? [])])
    const revisions = unique(
      sources.flatMap((s) => (s.kind === "card" || s.kind === "note" || s.kind === "lorebook" ? [s.revision] : []))
    )
    const entities =
      revisions.length === 0
        ? []
        : yield* sql<{ id: string; name: string | null; label: string | null; ref: string | null }>`
            SELECT v.id, COALESCE(json_extract(v.doc_json, '$.name'), json_extract(v.doc_json, '$.title')) AS name,
              (SELECT r.label FROM entity_refs r WHERE r.entity_id = e.id AND r.ref_kind = 'upstream') AS label,
              (SELECT r.id FROM entity_refs r WHERE r.entity_id = e.id AND r.ref_kind = 'upstream') AS ref
            FROM entity_revisions v JOIN entities e ON e.id = v.entity_id
            WHERE v.id IN ${sql.in(revisions)} AND e.owner_user_id = ${userId}`
    const names = new Map(entities.map((row) => [row.id, row.name || row.label || "unnamed"]))
    const refs = new Map(entities.flatMap((row) => (row.ref === null ? [] : [[row.id, row.ref] as const])))
    // A lorebook entry by its title (ST's comment), as the book's revision has it.
    const books = unique(sources.flatMap((s) => (s.kind === "lorebook" ? [s.revision] : [])))
    const entries =
      books.length === 0
        ? []
        : yield* sql<{ revision: string; uid: number; comment: string | null }>`
            SELECT v.id AS revision, json_extract(x.value, '$.uid') AS uid, json_extract(x.value, '$.comment') AS comment
            FROM entity_revisions v JOIN entities e ON e.id = v.entity_id, json_each(v.doc_json, '$.entries') x
            WHERE v.id IN ${sql.in(books)} AND e.owner_user_id = ${userId}`
    const titles = new Map(entries.map((row) => [`${row.revision}:${row.uid}`, row.comment?.trim() ?? ""]))
    // A history message's version by its place among its slot's versions.
    const versions = unique(sources.flatMap((s) => (s.kind === "message" ? [s.version] : [])))
    const ordinals =
      versions.length === 0
        ? []
        : yield* sql<{ id: string; ordinal: number }>`
            SELECT v.id, v.ordinal FROM versions v JOIN slots s ON s.id = v.slot_id JOIN chats c ON c.id = s.chat_id
            WHERE v.id IN ${sql.in(versions)} AND c.id = ${chatId} AND c.owner_user_id = ${userId}`
    const ordinalOf = new Map(ordinals.map((row) => [row.id, row.ordinal]))
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

    const linkOf = (revision: string) => {
      const ref = refs.get(revision)
      return ref === undefined ? {} : { ref }
    }

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
      return {
        ...common,
        kind: source.kind,
        ...(descriptors
          .get(source.kind)
          ?.describe(source, { names, titles, promptNames, depthOf, ordinalOf, linkOf }) ?? fallbackDescription(source))
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
      | "started_at"
      | "first_token_at"
      | "ended_at"
      | "input_uncached"
      | "cache_read"
      | "cache_write"
      | "output"
      | "usage_source"
      | "cost"
      | "cost_currency"
    >
  >`
    SELECT id, status, started_at, first_token_at, ended_at, input_uncached, cache_read, cache_write, output,
      usage_source, cost, cost_currency
    FROM llm_requests INDEXED BY llm_requests_rollout WHERE rollout_id = ${rolloutId} AND owner_user_id = ${userId}
    ORDER BY started_at, id`

/** Raw display metadata leaves the reader only with generation, never through the public inspector. */
export const inspectionInputs = (
  sql: SqlClient.SqlClient,
  userId: UserId,
  snapshot: ContextSnapshot,
  assembler: Assembler
) =>
  Effect.gen(function* () {
    const describe = yield* describer(sql, userId, snapshot.inputs.chatId as ChatId, [snapshot], assembler)
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
    const texts = snapshot.request.messages.map((): Array<InspectionNode> => [])
    // What `{{description}}`, `{{personality}}` and `{{scenario}}` read: the joined, wrapped fields,
    // recorded though not sent as pieces of their own. A prompt holding one holds its parts.
    const macros = snapshot.pieces.flatMap((piece, index) =>
      piece.id.startsWith("cards:macro:") && piece.text.trim() !== "" ? [index] : []
    )
    const childrenOf = (index: number, inBlock: boolean): ReadonlyArray<number> => {
      const piece = snapshot.pieces[index]!
      if (piece.parts?.length) return piece.parts
      return piece.source.kind === "preset" && !inBlock
        ? macros.filter((m) => piece.text.includes(snapshot.pieces[m]!.text))
        : []
    }
    // A labelled block's text is found by its parts: the card fields, the entries, the wrappers.
    const nodeOf = (index: number, i: number, inBlock: boolean): InspectionNode => {
      const piece = snapshot.pieces[index]!
      const source = describe(piece.source)
      if (!sources[i]!.some((s) => s.id === source.id)) sources[i]!.push(source)
      const parts = childrenOf(index, inBlock).map((part) => nodeOf(part, i, true))
      const frame =
        inBlock &&
        piece.source.kind === "preset" &&
        /^utility\.card_join_(prefix|suffix)$/.test(piece.source.identifier)
      return { source: source.id, text: piece.text, ...(frame ? { frame } : {}), ...(parts.length ? { parts } : {}) }
    }
    // Each message's outermost pieces, in recording order: those not held by another piece in it.
    const placed = snapshot.request.messages.map((): Array<number> => [])
    for (const [index, piece] of snapshot.pieces.entries()) {
      const source = describe(piece.source)
      for (const i of piece.messages) {
        placed[i]?.push(index)
        if (!sources[i]!.some((s) => s.id === source.id)) sources[i]!.push(source)
      }
    }
    for (const [i, indices] of placed.entries()) {
      const inner = new Set(indices.flatMap((index) => snapshot.pieces[index]!.parts ?? []))
      for (const index of indices) if (!inner.has(index)) texts[i]!.push(nodeOf(index, i, false))
    }
    // What this turn left out: notes and prompts by their condition, lorebook entries skipped.
    const notSent: Array<ContextSource> = []
    for (const source of [
      ...snapshot.pieces
        .map((piece) => piece.source)
        .filter(
          (source) =>
            (source.kind === "note" && source.activation?.due === false) ||
            (source.kind === "lorebook" && source.activation.status === "skipped")
        ),
      ...(snapshot.skippedPrompts ?? [])
    ]) {
      const described = describe(source)
      if (!notSent.some((s) => s.id === described.id)) notSent.push(described)
    }
    // The path's images it left out, each with its rule: "taken out by you", the last-N limit…
    for (const image of snapshot.imagesLeftOut?.images ?? [])
      notSent.push({
        id: createHash("sha256")
          .update(JSON.stringify(["image", image.versionId, image.mediaId, image.index]))
          .digest("hex"),
        kind: "message",
        label: `Image ${image.index + 1} of message ${image.depth + 1}: ${image.message}`,
        slotId: image.slotId,
        activation: null
      })
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
      texts,
      notSent,
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
          fork_id: string | null
          slot_id: string
          rollout_id: string
          status: string
          snapshot: string
          sent_context_json: string | null
        }>`
        SELECT s.chat_id, r.fork_id, v.slot_id, r.id AS rollout_id, r.status, p.context_snapshot_json AS snapshot, p.sent_context_json
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
        // Captured wire messages are text; their images are the snapshot's, with its estimates.
        const images = wire ? wireImages(wire.messages, snapshot.request) : []
        const current = new Map<string, { readonly revisionId: string; readonly fresh: boolean }>()
        yield* Effect.gen(function* () {
          if (snapshot.lcm?.selected.length) {
            const [settings] = yield* sql<{
              enabled: number
            }>`SELECT json_extract(value_json, '$.enabled') AS enabled FROM state_events e
            WHERE chat_id = ${chatId} AND slot_id IS NULL AND scope IS NULL AND key = 'lcm.settings' AND ${eventApplies(sql, yield* viewAt(sql, chatId, null), "e")} ORDER BY seq DESC LIMIT 1`
            if (settings?.enabled)
              for (const summary of (yield* selectSummaryLayer(sql, userId, chatId, snapshot.inputs.leafSlotId))
                .summaries)
                current.set(summary.id, summary)
          }
        }).pipe(inFork(sql, chatId, row.fork_id, snapshot.inputs.leafSlotId))
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
            ? wire!.messages.map((message, at) => ({
                role: message.role,
                ...(message.prefill ? { prefill: message.prefill } : {}),
                name: message.name ?? null,
                content: message.content,
                tokens: tokensOf({ ...message, images: images[at] }),
                ...(images[at]?.length ? { images: images[at].map(contextImage) } : {}),
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
                ...(message.parts ? { parts: message.parts } : {}),
                ...(message.groups ? { groups: message.groups } : {}),
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
            startedAt: r.started_at,
            firstTokenAt: r.first_token_at,
            endedAt: r.ended_at,
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
      }).pipe(query("RunContext")),

    // A version's generation requests and those of the versions it continued, followed through
    // `source_version_id`. UNION deduplicates identities, including any cycle. Only roots with requests count:
    // an edit isn't timed by the reply it was made from.
    VersionMetrics: ({ userId, versionIds }) =>
      Effect.gen(function* () {
        const ids = unique(versionIds).slice(0, 200)
        if (ids.length === 0) return []
        const rows = yield* sql<{
          root: string
          status: RequestFigures["status"]
          started_at: number
          first_token_at: number | null
          ended_at: number | null
          output: number | null
          reasoning: number | null
          usage_source: RequestFigures["usageSource"]
        }>`
          WITH RECURSIVE chain(root, id) AS (
            SELECT v.id, v.id FROM versions v JOIN slots s ON s.id = v.slot_id JOIN chats c ON c.id = s.chat_id
            WHERE v.id IN ${sql.in(ids)} AND c.owner_user_id = ${userId}
              AND EXISTS (SELECT 1 FROM llm_requests q INDEXED BY llm_requests_version
                WHERE q.version_id = v.id AND q.purpose = 'generation' AND q.owner_user_id = ${userId})
            UNION
            SELECT chain.root, v.source_version_id FROM chain JOIN versions v ON v.id = chain.id
            WHERE v.source_version_id IS NOT NULL
          )
          SELECT chain.root, q.status, q.started_at, q.first_token_at, q.ended_at, q.output, q.reasoning, q.usage_source
          FROM chain JOIN llm_requests q INDEXED BY llm_requests_version ON q.version_id = chain.id
          WHERE q.purpose = 'generation' AND q.owner_user_id = ${userId}
          ORDER BY chain.root, q.started_at, q.id`
        const byVersion = new Map<string, Array<RequestFigures>>()
        for (const row of rows) {
          const list = byVersion.get(row.root) ?? []
          list.push({
            status: row.status,
            startedAt: row.started_at,
            firstTokenAt: row.first_token_at,
            endedAt: row.ended_at,
            output: row.output,
            reasoning: row.reasoning,
            usageSource: row.usage_source
          })
          byVersion.set(row.root, list)
        }
        return [...byVersion].map(([id, requests]) => versionMetricsOf(id as VersionId, requests))
      }).pipe(query("VersionMetrics"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
  return handlers
})
