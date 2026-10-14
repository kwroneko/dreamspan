// Row shapes and their mapping to domain types, shared by the writer and readers.
import {
  Chat,
  type ChatId,
  type ContextIssue,
  type EntityId,
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
    rowVersion: row.row_version,
    createdAt: row.created_at,
    lastMessageAt: row.last_message_at
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
  readonly direction: string | null
  readonly hidden: number
  readonly starred: number
  readonly created_at: number
  readonly error_json: string | null
  /** Absent where a query doesn't select it. */
  readonly reasoning?: string | null
  readonly mark?: "refused" | null
  readonly frozen_macros: string | null
  readonly rollout_id: string | null
  /** How often a user-written version was amended (`versionExtras`); absent on a row just inserted. */
  readonly amend_count?: number
  /** Its rollout's context issues as JSON (`versionExtras`); absent on a row just inserted. */
  readonly context_issues?: string | null
  readonly has_context?: number
}

/** The columns `toVersion` reads beyond the version's own: its row version and its context's issues. */
export const versionExtras = (alias: string) =>
  `(SELECT count(*) FROM version_history h WHERE h.version_id = ${alias}.id) AS amend_count,
  (SELECT r.context_issues_json FROM rollouts r WHERE r.id = ${alias}.rollout_id) AS context_issues,
  EXISTS (SELECT 1 FROM rollout_payloads p WHERE p.rollout_id = ${alias}.rollout_id
    AND p.context_snapshot_json IS NOT NULL) AS has_context`

const toVersionError = (json: string | null) => {
  if (json === null) return null
  const error = JSON.parse(json) as { class?: unknown; message?: unknown }
  return { class: String(error.class ?? "unknown"), message: String(error.message ?? "") }
}

export const toVersion = (row: VersionRow) =>
  new Version({
    id: row.id as VersionId,
    slotId: row.slot_id as SlotId,
    ordinal: row.ordinal,
    status: row.status,
    speakerEntityId: row.speaker_entity_id as EntityId | null,
    writer: row.writer,
    content: row.content,
    macroMode: row.macro_mode,
    origin: row.origin,
    sourceVersionId: row.source_version_id as VersionId | null,
    direction: row.direction,
    hidden: row.hidden === 1,
    starred: row.starred === 1,
    createdAt: row.created_at,
    error: toVersionError(row.error_json),
    ...(row.reasoning ? { reasoning: row.reasoning } : {}),
    mark: row.mark ?? null,
    frozenMacros: row.frozen_macros === null ? null : (JSON.parse(row.frozen_macros) as Record<string, string>),
    context: !row.has_context
      ? null
      : {
          issues: row.context_issues
            ? (JSON.parse(row.context_issues) as Array<ContextIssue>).filter(
                (issue) => issue.kind !== "history_truncated"
              )
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
  readonly slot_deleted: number
  readonly version_count: number
  readonly branch_count: number
  readonly branch_index: number
  /** Whether the slot's first version, deleted or not, is the user's (`PathEntry.side`). */
  readonly user_side: number
  /** The speaker of the slot's first version, deleted or not (`PathEntry.firstSpeakerEntityId`). */
  readonly first_speaker: string | null
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
    version,
    versionCount: row.version_count,
    branchCount: row.branch_count,
    branchIndex: row.branch_index,
    side: row.user_side === 1 ? "user" : "assistant",
    firstSpeakerEntityId: row.first_speaker as EntityId | null,
    inContext: versionInContext(version.status, version.content, contextExcluded)
  })
}
