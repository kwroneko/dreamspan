import { counted, stepsOf } from "../agent/steps.ts"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { FrozenTool } from "../agent/tools.ts"
import type { StepsSummary } from "@dreamspan/shared/agent.ts"
// Row shapes and their mapping to domain types, shared by the writer and readers.
import type { StoredRewrite, VersionRewrite } from "@dreamspan/shared/regexScripts.ts"
import type { ReplySections } from "@dreamspan/shared/replySections.ts"
import {
  Chat,
  type ChatId,
  type ContextIssue,
  type EntityId,
  Fork,
  type ForkId,
  PathEntry,
  RecordedGeneration,
  type SlotId,
  type SpeakerPick,
  Version,
  type VersionId,
  versionInContext
} from "@dreamspan/shared/chat.ts"
import { User, type UserId } from "@dreamspan/shared/domain.ts"
import { recordedModelLabel } from "@dreamspan/shared/stApis.ts"
import { Schema } from "effect"

/**
 * Who generated an imported version and how, as the app it came from recorded it
 * (formats/stChat.ts `StGeneration`). Stored in two columns, null for none and for this app's
 * own generations (whose model is `model_id`, and figures the usage ledger):
 * `recorded_model_json` (`api`, `model`), which a duplicate or an edited copy keeps as it
 * keeps `model_id`, and `recorded_generation_json` (the figures), which they leave behind
 * with `usage_json`, since they weren't generated in that time.
 */
export const StoredGeneration = Schema.Struct({
  api: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
  model: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  ...RecordedGeneration.fields
})
export type StoredGeneration = typeof StoredGeneration.Type

/** The two columns `StoredGeneration` is kept in. */
export const recordedColumns = (generation: StoredGeneration | undefined) => {
  const { api, model, ...figures } = generation ?? {}
  return {
    recorded_model_json:
      api !== undefined || model !== undefined
        ? JSON.stringify({ ...(api !== undefined ? { api } : {}), ...(model !== undefined ? { model } : {}) })
        : null,
    recorded_generation_json: Object.keys(figures).length > 0 ? JSON.stringify(figures) : null
  }
}

export interface UserRow {
  readonly id: string
  readonly handle: string
  readonly display_name: string
  readonly role: "admin" | "user"
}

export const toUser = (row: UserRow) =>
  new User({ id: row.id as UserId, handle: row.handle, displayName: row.display_name, role: row.role })

export interface ChatRow {
  readonly id: string
  readonly kind: string
  readonly status: "pending" | "active" | "archived"
  readonly title: string
  readonly active_leaf_slot_id: string | null
  readonly current_fork_id: string | null
  readonly row_version: number
  readonly created_at: number
  readonly last_message_at: number | null
  readonly cover_media_id?: string | null
}

export const toChat = (row: ChatRow) =>
  new Chat({
    id: row.id as ChatId,
    kind: row.kind,
    status: row.status,
    title: row.title,
    activeLeafSlotId: row.active_leaf_slot_id as SlotId | null,
    currentForkId: row.current_fork_id as ForkId | null,
    rowVersion: row.row_version,
    createdAt: row.created_at,
    lastMessageAt: row.last_message_at,
    ...(row.cover_media_id ? { pictureMediaId: row.cover_media_id } : {})
  })

export interface ForkRow {
  readonly id: string
  readonly chat_id: string
  readonly parent_fork_id: string | null
  readonly base_slot_id: string | null
  readonly tip_slot_id: string | null
  readonly name: string | null
  readonly name_user: number
  readonly pinned_at: number | null
  readonly created_at: number
  readonly last_chatted_at: number | null
  readonly deleted_at: number | null
  readonly row_version: number
}

/** A fork with its tip's text (`tip_excerpt`) and whether it's its chat's current one. */
export const toFork = (row: ForkRow & { readonly tip_excerpt: string | null; readonly current: number }) =>
  new Fork({
    id: row.id as ForkId,
    chatId: row.chat_id as ChatId,
    parentForkId: row.parent_fork_id as ForkId | null,
    baseSlotId: row.base_slot_id as SlotId | null,
    tipSlotId: row.tip_slot_id as SlotId | null,
    name: row.name,
    pinnedAt: row.pinned_at,
    createdAt: row.created_at,
    lastChattedAt: row.last_chatted_at,
    tipExcerpt: row.tip_excerpt ?? "",
    current: row.current === 1,
    rowVersion: row.row_version
  })

export interface VersionRow {
  readonly id: string
  readonly slot_id: string
  readonly ordinal: number
  readonly status: Version["status"]
  readonly speaker_entity_id: string | null
  /** How Auto chose the speaker (`SpeakerPick`); absent where a query doesn't select it. */
  readonly speaker_pick_json?: string | null
  readonly writer: Version["writer"]
  readonly content: string
  readonly macro_mode: Version["macroMode"]
  readonly origin: Version["origin"]
  readonly source_version_id: string | null
  /** The fork whose copy it is, standing in for its source (schema/forkVersions.ts); absent where not selected. */
  readonly fork_id?: string | null
  /** Creation provenance; omitted by hot read projections and public version DTOs. */
  readonly authoring_fork_id?: string
  readonly direction: string | null
  readonly hidden: number
  readonly starred: number
  readonly created_at: number
  readonly error_json: string | null
  /** Absent where a query doesn't select it. */
  readonly reasoning?: string | null
  /** Its leading tagged sections as JSON (spec/REPLY-SECTIONS.md); absent where a query doesn't select it. */
  readonly reply_sections?: string | null
  readonly mark?: "refused" | "silent" | null
  readonly frozen_macros: string | null
  /** Absent where a query doesn't select them. */
  readonly raw_content?: string | null
  readonly raw_reasoning?: string | null
  readonly raw_sections?: string | null
  readonly rewrite_json?: string | null
  /** Whether the raw texts are kept, where a query reads that instead of the texts (`shownVersionColumns`). */
  readonly raw_kept?: number
  readonly raw_reasoning_kept?: number
  readonly raw_sections_kept?: number
  readonly rollout_id: string | null
  /** Ordered image references (`versionExtras`); absent on a row just inserted without images. */
  readonly images_json?: string
  /** Its library items as recorded at send (`libraryJson`); absent on a row just inserted. */
  readonly library_json?: string
  /** How often a user-written version was amended (`versionExtras`); absent on a row just inserted. */
  readonly amend_count?: number
  /** Its rollout's context issues as JSON (`versionExtras`); absent on a row just inserted. */
  readonly context_issues?: string | null
  readonly has_context?: number
  /** Its model as "connection · model" (`versionExtras`); absent on a row just inserted. */
  readonly model_label?: string | null
  /** Its model's connection kind and key, as JSON (`versionExtras`); absent on a row just inserted. */
  readonly model_ref_json?: string | null
  /** Its agent rollout's tool calls and run time, as JSON (`versionExtras`); null without steps. */
  readonly steps_material?: string | null
  readonly steps_json?: string | null
  /** What an imported version's app recorded about its model and generation (`StoredGeneration`). */
  readonly recorded_model_json?: string | null
  readonly recorded_generation_json?: string | null
}

/**
 * An attachment row (`version_attachments`, `alias`) as `MessageImages` holds it: an image, or a
 * workshop's file of any type, with its name and path in Files when it has one (§6.1).
 */
export const attachmentJson = (alias: string) =>
  `json(CASE WHEN ${alias}.path IS NULL AND ${alias}.kind <> 'file'
    THEN json_object('mediaId', ${alias}.media_id, 'altText', coalesce(${alias}.alt_text, ''))
    ELSE json_patch(json_object('mediaId', ${alias}.media_id, 'altText', coalesce(${alias}.alt_text, '')),
      json_object('kind', CASE WHEN ${alias}.kind = 'file' THEN 'file' END, 'name', ${alias}.name, 'path', ${alias}.path)) END)`

/** A version's library items (`version_library`) as `VersionLibrary` holds them, in their sent order. */
export const libraryJson = (alias: string) =>
  `(SELECT json_group_array(json_object('kind', l.kind, 'refId', l.ref_id, 'name', l.name) ORDER BY l.ordinal)
    FROM version_library l WHERE l.version_id = ${alias}.id)`

/** The columns `toVersion` reads beyond the version's own: its row version, its context's issues and its model's name. */
export const versionExtras = (alias: string) =>
  `(SELECT json_group_array(${attachmentJson("a")})
    FROM (SELECT * FROM version_attachments WHERE version_id = ${alias}.id ORDER BY ordinal) a) AS images_json,
  ${libraryJson(alias)} AS library_json,
  (SELECT count(*) FROM version_history h WHERE h.version_id = ${alias}.id) AS amend_count,
  (SELECT r.context_issues_json FROM rollouts r WHERE r.id = ${alias}.rollout_id) AS context_issues,
  EXISTS (SELECT 1 FROM rollout_payloads p WHERE p.rollout_id = ${alias}.rollout_id
    AND p.context_snapshot_json IS NOT NULL) AS has_context,
  (SELECT c.name || ' · ' || m.model_key FROM models m JOIN connections c ON c.id = m.connection_id
    WHERE m.id = ${alias}.model_id) AS model_label,
  (SELECT json_object('provider', c.kind, 'model', m.model_key) FROM models m JOIN connections c ON c.id = m.connection_id
    WHERE m.id = ${alias}.model_id) AS model_ref_json,
  (SELECT json_object('count', r.step_count, 'ms', r.completed_at - r.started_at) FROM rollouts r
    WHERE r.id = ${alias}.rollout_id AND (r.step_count > 0 OR r.mode IS NOT NULL)) AS steps_json,
  (SELECT json_object('transcript', json(p.transcript_json), 'tools', json_extract(p.context_snapshot_json, '$.agent.tools'),
    'final', r.status NOT IN ('created', 'running'),
    'perVersion', json_extract(p.context_snapshot_json, '$.agent.contract') = 'several')
    FROM rollout_payloads p JOIN rollouts r ON r.id = p.rollout_id
    WHERE p.rollout_id = ${alias}.rollout_id AND (
      json_extract(p.context_snapshot_json, '$.agent.contract') = 'several'
      OR (r.step_count = 0 AND json_extract(p.context_snapshot_json, '$.agent.contract') IN ('send_message', 'both'))
    )) AS steps_material`

const toVersionError = (json: string | null) => {
  if (json === null) return null
  const error = JSON.parse(json) as {
    class?: unknown
    message?: unknown
    contextLimit?: { tokens?: unknown; modelId?: unknown }
  }
  const limit = error.contextLimit
  return {
    class: String(error.class ?? "unknown"),
    message: String(error.message ?? ""),
    ...(limit && Number.isSafeInteger(limit.tokens) && typeof limit.modelId === "string"
      ? { contextLimit: { tokens: limit.tokens as number, modelId: limit.modelId } }
      : {})
  }
}

/**
 * Issues a version doesn't show: a cut history is normal, and so are the card's example
 * dialogues left out once the history fills the context (owner 2026-11-23), and earlier reasoning
 * a request couldn't send back; they stay in the request inspector. The added closing user turn is visible only there too (contexts assembled
 * before version 30 recorded it).
 */
const UNSHOWN: ReadonlySet<string> = new Set([
  "history_truncated",
  "examples_truncated",
  "last_turn_filled",
  // Earlier reasoning a request couldn't send back is left out silently (owner, 2026-11-23).
  "reasoning_left_out"
])

/** The record of what regex scripts did, and whether the text before is kept; never the text itself. */
const toRewrite = (row: VersionRow) => {
  const { applied, failed } = JSON.parse(row.rewrite_json!) as Pick<VersionRewrite, "applied" | "failed">
  return {
    applied,
    failed,
    raw: row.raw_kept === 1 || row.raw_content != null,
    rawReasoning: row.raw_reasoning_kept === 1 || row.raw_reasoning != null,
    rawSections: row.raw_sections_kept === 1 || row.raw_sections != null
  }
}

/** The columns a stored rewrite sets on a version; all null without one. */
export const rewriteColumns = (rewrite: StoredRewrite | undefined) => ({
  raw_content: rewrite?.raw ?? null,
  raw_reasoning: rewrite?.rawReasoning ?? null,
  raw_sections: rewrite?.rawSections ? JSON.stringify(rewrite.rawSections) : null,
  rewrite_json:
    rewrite && (rewrite.applied.length > 0 || rewrite.failed.length > 0)
      ? JSON.stringify({ applied: rewrite.applied, failed: rewrite.failed })
      : null
})

/** Its model's label and reference: the user's model where one is recorded, else what an import recorded. */
const modelOf = (row: VersionRow) => {
  const imported = row.recorded_model_json
    ? (JSON.parse(row.recorded_model_json) as { api?: string; model?: string })
    : null
  const ref = row.model_ref_json
    ? (JSON.parse(row.model_ref_json) as { provider: string; model: string })
    : imported
      ? { provider: imported.api ?? "", model: imported.model ?? "" }
      : null
  return {
    model: row.model_label ?? (imported ? recordedModelLabel(imported.api, imported.model) : null),
    ...(ref ? { modelRef: ref } : {}),
    ...(row.recorded_generation_json
      ? { recorded: JSON.parse(row.recorded_generation_json) as RecordedGeneration }
      : {})
  }
}

const versionSteps = (row: VersionRow): { readonly steps?: StepsSummary; readonly agent?: boolean } => {
  if (!row.steps_material) {
    if (!row.steps_json) return {}
    const steps = JSON.parse(row.steps_json) as StepsSummary
    return steps.count > 0 ? { steps, agent: true } : { agent: true }
  }
  const material = JSON.parse(row.steps_material) as {
    transcript: ReadonlyArray<AgentMessage> | null
    tools: ReadonlyArray<FrozenTool> | null
    final: boolean
    perVersion: boolean
  }
  const count = material.transcript
    ? counted(
        stepsOf(material.transcript, material.tools ?? [], !!material.final, material.perVersion ? row.id : undefined)
      )
    : 0
  const summary = row.steps_json ? (JSON.parse(row.steps_json) as StepsSummary) : { ms: null }
  return count ? { steps: { count, ms: summary.ms }, agent: true } : { agent: true }
}

export const toVersion = (row: VersionRow) =>
  new Version({
    id: row.id as VersionId,
    slotId: row.slot_id as SlotId,
    ordinal: row.ordinal,
    status: row.status,
    speakerEntityId: row.speaker_entity_id as EntityId | null,
    ...(row.speaker_pick_json ? { speakerPick: JSON.parse(row.speaker_pick_json) as SpeakerPick } : {}),
    writer: row.writer,
    content: row.content,
    ...(row.images_json ? { images: JSON.parse(row.images_json) } : {}),
    ...(row.library_json && row.library_json !== "[]" ? { library: JSON.parse(row.library_json) } : {}),
    macroMode: row.macro_mode,
    origin: row.origin,
    sourceVersionId: row.source_version_id as VersionId | null,
    direction: row.direction,
    hidden: row.hidden === 1,
    starred: row.starred === 1,
    createdAt: row.created_at,
    ...modelOf(row),
    error: toVersionError(row.error_json),
    ...(row.reasoning ? { reasoning: row.reasoning } : {}),
    ...(row.reply_sections ? { replySections: JSON.parse(row.reply_sections) as ReplySections } : {}),
    mark: row.mark ?? null,
    ...(row.rewrite_json ? { rewrite: toRewrite(row) } : {}),
    frozenMacros: row.frozen_macros === null ? null : (JSON.parse(row.frozen_macros) as Record<string, string>),
    context: !row.has_context
      ? null
      : {
          issues: row.context_issues
            ? (JSON.parse(row.context_issues) as Array<ContextIssue>).filter((issue) => !UNSHOWN.has(issue.kind))
            : []
        },
    ...versionSteps(row),
    rowVersion: 1 + (row.amend_count ?? 0)
  })

/** A slot on a path, with its selected version's columns under their own names. */
export interface PathRow extends VersionRow {
  readonly parent_slot_id: string | null
  readonly depth: number
  readonly row_version: number
  readonly context_excluded: number
  readonly hidden_by_user: number
  readonly has_library: number
  /** Media ids of the shown version's images the fork took out, as a JSON array; absent on older reads. */
  readonly excluded_images?: string
  /** Which of the shown version's thinking the fork hid (`thinkingHiddenSql`); absent on older reads. */
  readonly hidden_thinking?: number | null
  readonly branch_name: string | null
  readonly slot_fork_id: string | null
  readonly starts_fork_id: string | null
  readonly slot_deleted: number
  readonly version_count: number
  readonly branch_count: number
  readonly branch_index: number
  /** Whether the slot's first version, deleted or not, is the user's (`PathEntry.side`). */
  readonly user_side: number
  /** The speaker of the slot's first version, deleted or not (`PathEntry.firstSpeakerEntityId`). */
  readonly first_speaker: string | null
  /** The fork whose selections the row shows; null for a row read without one. */
  readonly shown_fork_id?: string | null
  /** Its index on the display path read (spec/MESSAGE-INSERT.md §2.3); absent outside a path window. */
  readonly position?: number | null
  readonly inserted?: number
  /** Its copies in other threads, as [slot, fork] pairs in JSON (`PathEntry.copies`); absent on older reads. */
  readonly send_copies?: string | null
}

/** The parts a `thinkingHiddenSql` value (forkState.ts) names. */
export const hiddenParts = (mask: number | null | undefined): Array<"reasoning" | "sections"> => [
  ...((mask ?? 0) & 1 ? (["reasoning"] as const) : []),
  ...((mask ?? 0) & 2 ? (["sections"] as const) : [])
]

const copiesOf = (json: string | null | undefined) => {
  const pairs = json ? (JSON.parse(json) as Array<[string, string]>) : []
  return pairs.length === 0
    ? {}
    : { copies: pairs.map(([slotId, forkId]) => ({ slotId: slotId as SlotId, forkId: forkId as ForkId })) }
}

export const toPathEntry = (row: PathRow) => {
  const version = toVersion(row)
  const contextExcluded = row.context_excluded === 1
  return new PathEntry({
    slotId: row.slot_id as SlotId,
    parentSlotId: row.parent_slot_id as SlotId | null,
    depth: row.depth,
    rowVersion: row.row_version,
    contextExcluded,
    hiddenByUser: contextExcluded && row.hidden_by_user === 1,
    ...(row.excluded_images && row.excluded_images !== "[]"
      ? { excludedImages: JSON.parse(row.excluded_images) as Array<string> }
      : {}),
    ...(row.hidden_thinking ? { hiddenThinking: hiddenParts(row.hidden_thinking) } : {}),
    version,
    versionCount: row.version_count,
    branchCount: row.branch_count,
    branchIndex: row.branch_index,
    ...(row.branch_name === null ? {} : { branchName: row.branch_name }),
    ...(row.slot_fork_id === null ? {} : { forkId: row.slot_fork_id as ForkId }),
    ...(row.starts_fork_id === null ? {} : { startsForkId: row.starts_fork_id as ForkId }),
    ...(row.shown_fork_id == null ? {} : { shownForkId: row.shown_fork_id as ForkId }),
    ...(row.position == null ? {} : { position: row.position }),
    ...(row.inserted === 1 ? { inserted: true } : {}),
    ...copiesOf(row.send_copies),
    side: row.user_side === 1 ? "user" : "assistant",
    firstSpeakerEntityId: row.first_speaker as EntityId | null,
    inContext: versionInContext(
      version.status,
      version.content,
      contextExcluded,
      (version.images?.length ?? 0) + row.has_library
    )
  })
}
