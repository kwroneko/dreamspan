// Row shapes and their mapping to domain types, shared by the writer and readers.
import type { ReplySections } from "@rp/shared/replySections.ts"
import {
  Chat,
  type ChatId,
  type ContextIssue,
  type EntityId,
  Fork,
  type ForkId,
  type LaneId,
  PathEntry,
  type SlotId,
  Version,
  type VersionId,
  versionInContext
} from "@rp/shared/chat.ts"
import { User, type UserId } from "@rp/shared/domain.ts"

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
  readonly kind: "rp" | "workshop"
  readonly status: "pending" | "active" | "archived"
  readonly title: string
  readonly active_leaf_slot_id: string | null
  readonly current_fork_id: string | null
  readonly row_version: number
  readonly created_at: number
  readonly last_message_at: number | null
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
    lastMessageAt: row.last_message_at
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
  /** `[[fork, bound], …]`, itself first (forkState.ts). */
  readonly lineage_json: string | null
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
  readonly writer: Version["writer"]
  readonly content: string
  readonly macro_mode: Version["macroMode"]
  readonly origin: Version["origin"]
  readonly source_version_id: string | null
  /** The fork whose copy it is, standing in for its source (schema/forkVersions.ts); absent where not selected. */
  readonly fork_id?: string | null
  readonly direction: string | null
  readonly hidden: number
  readonly starred: number
  readonly created_at: number
  readonly error_json: string | null
  /** Absent where a query doesn't select it. */
  readonly reasoning?: string | null
  /** Its leading tagged sections as JSON (spec/REPLY-SECTIONS.md); absent where a query doesn't select it. */
  readonly reply_sections?: string | null
  readonly mark?: "refused" | null
  readonly frozen_macros: string | null
  readonly rollout_id: string | null
  /** Ordered image references (`versionExtras`); absent on a row just inserted without images. */
  readonly images_json?: string
  /** How often a user-written version was amended (`versionExtras`); absent on a row just inserted. */
  readonly amend_count?: number
  /** Its rollout's context issues as JSON (`versionExtras`); absent on a row just inserted. */
  readonly context_issues?: string | null
  readonly has_context?: number
  /** Its model as "connection · model" (`versionExtras`); absent on a row just inserted. */
  readonly model_label?: string | null
}

/** The columns `toVersion` reads beyond the version's own: its row version, its context's issues and its model's name. */
export const versionExtras = (alias: string) =>
  `(SELECT json_group_array(json_object('mediaId', a.media_id, 'altText', coalesce(a.alt_text, '')))
    FROM (SELECT * FROM version_attachments WHERE version_id = ${alias}.id ORDER BY ordinal) a) AS images_json,
  (SELECT count(*) FROM version_history h WHERE h.version_id = ${alias}.id) AS amend_count,
  (SELECT r.context_issues_json FROM rollouts r WHERE r.id = ${alias}.rollout_id) AS context_issues,
  EXISTS (SELECT 1 FROM rollout_payloads p WHERE p.rollout_id = ${alias}.rollout_id
    AND p.context_snapshot_json IS NOT NULL) AS has_context,
  (SELECT c.name || ' · ' || m.model_key FROM models m JOIN connections c ON c.id = m.connection_id
    WHERE m.id = ${alias}.model_id) AS model_label`

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
 * Issues a version doesn't show: a cut history is normal, and the added closing user turn is
 * visible only in the request inspector (contexts assembled before version 30 recorded it).
 */
const UNSHOWN: ReadonlySet<string> = new Set(["history_truncated", "last_turn_filled"])

export const toVersion = (row: VersionRow) =>
  new Version({
    id: row.id as VersionId,
    slotId: row.slot_id as SlotId,
    ordinal: row.ordinal,
    status: row.status,
    speakerEntityId: row.speaker_entity_id as EntityId | null,
    writer: row.writer,
    content: row.content,
    ...(row.images_json ? { images: JSON.parse(row.images_json) } : {}),
    macroMode: row.macro_mode,
    origin: row.origin,
    sourceVersionId: row.source_version_id as VersionId | null,
    direction: row.direction,
    hidden: row.hidden === 1,
    starred: row.starred === 1,
    createdAt: row.created_at,
    model: row.model_label ?? null,
    error: toVersionError(row.error_json),
    ...(row.reasoning ? { reasoning: row.reasoning } : {}),
    ...(row.reply_sections ? { replySections: JSON.parse(row.reply_sections) as ReplySections } : {}),
    mark: row.mark ?? null,
    frozenMacros: row.frozen_macros === null ? null : (JSON.parse(row.frozen_macros) as Record<string, string>),
    context: !row.has_context
      ? null
      : {
          issues: row.context_issues
            ? (JSON.parse(row.context_issues) as Array<ContextIssue>).filter((issue) => !UNSHOWN.has(issue.kind))
            : []
        },
    rowVersion: 1 + (row.amend_count ?? 0)
  })

/** A slot on a path, with its selected version's columns under their own names. */
export interface PathRow extends VersionRow {
  readonly lane_id: string
  readonly parent_slot_id: string | null
  readonly depth: number
  readonly row_version: number
  readonly context_excluded: number
  readonly hidden_by_user: number
  /** Media ids of the shown version's images the fork took out, as a JSON array; absent on older reads. */
  readonly excluded_images?: string
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
}

export const toPathEntry = (row: PathRow) => {
  const version = toVersion(row)
  const contextExcluded = row.context_excluded === 1
  return new PathEntry({
    slotId: row.slot_id as SlotId,
    laneId: row.lane_id as LaneId,
    parentSlotId: row.parent_slot_id as SlotId | null,
    depth: row.depth,
    rowVersion: row.row_version,
    contextExcluded,
    hiddenByUser: contextExcluded && row.hidden_by_user === 1,
    ...(row.excluded_images && row.excluded_images !== "[]"
      ? { excludedImages: JSON.parse(row.excluded_images) as Array<string> }
      : {}),
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
    side: row.user_side === 1 ? "user" : "assistant",
    firstSpeakerEntityId: row.first_speaker as EntityId | null,
    inContext: versionInContext(version.status, version.content, contextExcluded, version.images?.length)
  })
}
