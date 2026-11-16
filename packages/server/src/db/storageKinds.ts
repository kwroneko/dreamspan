// Storage discriminants are extensible; the baseline keeps only kernel enums as CHECKs.
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { makeRegistry } from "@rp/shared/registry.ts"
import { StorageError } from "./ops.ts"

interface StorageKind {
  readonly id: string
  readonly values: ReadonlyArray<string>
}

/** Replace an entry to extend its values, or disable it, using a scoped registration. */
export const storageKinds = makeRegistry<StorageKind>([
  {
    id: "rollout_effects.kind",
    values: [
      "library.create",
      "library.revise",
      "chat.create",
      "chat.change",
      "setting.set",
      "changeset.apply",
      "plugin.create",
      "plugin.write",
      "plugin.disable",
      "plugin.commit",
      "plugin.enable",
      "reply.generate"
    ]
  },
  { id: "changeset_groups.origin", values: ["user", "agent"] },
  {
    id: "bin_items.kind",
    values: ["chat", "message", "branch", "version", "entity", "connection", "card_asset", "threads"]
  },
  {
    id: "drafts.target_kind",
    values: [
      "composer",
      "version_edit",
      "scratchpad",
      "entity_field",
      "summary_edit",
      "user_field",
      "queue_edit",
      "insert",
      "remote_card"
    ]
  },
  {
    id: "entities.kind",
    values: ["card", "preset", "lorebook", "note", "preset_overlay"]
  },
  {
    id: "entity_revisions.origin",
    values: ["import", "user", "agent", "changeset", "merge", "generation"]
  },
  {
    id: "chats.kind",
    values: ["rp", "workshop"]
  },
  {
    id: "versions.origin",
    values: [
      "generated",
      "user_written",
      "edited",
      "greeting",
      "imported",
      "changeset",
      "scratchpad",
      "duplicate",
      "merge",
      "resumed"
    ]
  },
  {
    id: "versions.mark",
    values: ["refused"]
  },
  {
    id: "version_attachments.kind",
    values: ["image"]
  },
  {
    id: "state_events.origin",
    values: ["user", "rollout", "changeset", "import"]
  },
  {
    id: "rollouts.kind",
    values: ["generation", "draft", "summarize", "condense", "decision", "workshop", "idle_job", "edit"]
  },
  {
    id: "changesets.origin",
    values: ["user", "agent"]
  },
  {
    id: "changeset_items.target_kind",
    values: ["version_replace", "summary_revision", "state_event"]
  },
  {
    id: "llm_requests.purpose",
    values: ["generation", "summarize", "condense", "decision", "workshop", "idle_job", "edit", "test"]
  },
  {
    id: "summary_revisions.origin",
    values: ["generated", "user", "changeset", "imported"]
  },
  {
    id: "fork_overrides.kind",
    values: [
      "select",
      "replace",
      "delete_slot",
      "delete_version",
      "hide",
      "hide_range",
      "star",
      "picker_hide",
      "summary_revision",
      "summary_choice",
      "summary_rerun",
      "summary_superseded",
      "suppress_event",
      "insert",
      // A message shown out of its place in a branch (MoveMessage; owner, 2026-11-16).
      "move",
      "image_exclude",
      // A version's thinking hidden from the model in a branch (SetThinkingHidden).
      "thinking_hide",
      // The per-branch correction of who was present (spec/THREADS.md §3.4, §16.2).
      "presence_away",
      "presence_range"
    ]
  },
  {
    id: "fork_overrides.origin",
    values: ["user", "import"]
  },
  // Parallel threads (spec/THREADS.md §4.1): who started threads, and how a join's line is read.
  {
    id: "thread_splits.origin",
    values: ["user", "rollout", "import"]
  },
  {
    id: "chat_merges.timelines",
    values: ["together", "separate"]
  }
])

// These TEMP objects belong only to the writer connection, never to the stored schema.
// Capturing distinct changed values covers every insert path (imports and copies included),
// then the writer validates them before committing its transaction.
const installed = new WeakSet<SqlClient.SqlClient>()
export const installStorageKindValidation = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(`CREATE TEMP TABLE storage_kind_writes (registry TEXT NOT NULL, value TEXT NOT NULL,
    PRIMARY KEY (registry, value)) STRICT, WITHOUT ROWID`)
  for (const entry of storageKinds.list()) {
    const [table, column] = entry.id.split(".") as [string, string]
    for (const event of ["INSERT", `UPDATE OF ${column}`]) {
      const changed = event === "INSERT" ? "" : ` AND NEW.${column} IS NOT OLD.${column}`
      yield* sql.unsafe(`CREATE TEMP TRIGGER storage_kind_${table}_${column}_${event === "INSERT" ? "insert" : "update"}
        AFTER ${event} ON main.${table} WHEN NEW.${column} IS NOT NULL${changed}
        BEGIN INSERT OR IGNORE INTO storage_kind_writes VALUES ('${entry.id}', NEW.${column}); END`)
    }
  }
  installed.add(sql)
})

export const validateStorageKindWrites = (sql: SqlClient.SqlClient, operation: string) =>
  Effect.gen(function* () {
    // Bare schema tests do not install the writer's TEMP objects.
    if (!installed.has(sql)) return
    const rows = yield* sql<{ registry: string; value: string }>`SELECT registry, value FROM storage_kind_writes`
    for (const row of rows) {
      if (!storageKinds.get(row.registry)?.values.includes(row.value))
        return yield* new StorageError({
          operation,
          reason: "constraint",
          message: `Unknown ${row.registry}: ${row.value}`
        })
    }
    if (rows.length) yield* sql`DELETE FROM storage_kind_writes`
  })
