// Row shapes and their mapping to domain types, shared by the writer and readers.
import {
  Chat,
  type ChatId,
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
}

/** The version columns, prefixed `v_`, for queries that join slots and versions. */
export const versionColumns = (alias: string) =>
  [
    "id",
    "slot_id",
    "ordinal",
    "status",
    "speaker_entity_id",
    "writer",
    "content",
    "macro_mode",
    "origin",
    "source_version_id",
    "direction",
    "hidden",
    "starred",
    "created_at"
  ]
    .map((c) => `${alias}.${c} AS v_${c}`)
    .join(", ")

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
    createdAt: row.created_at
  })

/** Strips the `v_` prefix from a joined row's version columns. */
export const versionFromPrefixed = (row: Record<string, unknown>) => {
  const fields: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) if (key.startsWith("v_")) fields[key.slice(2)] = value
  return toVersion(fields as unknown as VersionRow)
}

export interface PathRow {
  readonly slot_id: string
  readonly lane_id: string
  readonly parent_slot_id: string | null
  readonly depth: number
  readonly row_version: number
  readonly context_excluded: number
  readonly version_count: number
}

export const toPathEntry = (row: PathRow & Record<string, unknown>) => {
  const version = versionFromPrefixed(row)
  const contextExcluded = row.context_excluded === 1
  return new PathEntry({
    slotId: row.slot_id as SlotId,
    laneId: row.lane_id as LaneId,
    parentSlotId: row.parent_slot_id as SlotId | null,
    depth: row.depth,
    rowVersion: row.row_version,
    contextExcluded,
    version,
    versionCount: row.version_count,
    inContext: versionInContext(version.status, version.content, contextExcluded)
  })
}
