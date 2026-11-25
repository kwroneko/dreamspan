import { SqliteMigrator } from "@effect/sql-sqlite-node"
import { Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { baseline } from "./baseline.ts"
import { filesMigration } from "./migrationFiles.ts"
import { previewMacroMigration } from "./migrationPreviewMacro.ts"
import { subagentSchema } from "./subagentSchema.ts"
import { workshopBranchesMigration } from "./migrationWorkshopBranches.ts"
import { personaLocksMigration } from "./migrationPersonaLocks.ts"
import { contractRecordsMigration } from "./migrationContractRecords.ts"
import { attachmentPathsMigration } from "./migrationAttachmentPaths.ts"
import { shareInvitationsMigration } from "./migrationShareInvitations.ts"
import { shareBirthMigration } from "./migrationShareBirth.ts"
import { guidanceTargetMigration } from "./migrationGuidanceTarget.ts"
import { reasoningStatsMigration } from "./migrationReasoningStats.ts"
import { nativeReasoningMigration } from "./migrationNativeReasoning.ts"
import { pendingChatsMigration } from "./migrationPendingChats.ts"
import { rebuildTable, type OutsideStep } from "./tableRebuild.ts"

/**
 * A migration is data, so a recorded release can fingerprint exactly what it ran
 * (test/fixtures/releases, `releasedMigrationProblems`):
 * - `statements`: SQL run in order inside the migrator's one transaction, with foreign keys on.
 *   node:sqlite prepares one statement at a time, so DDL is kept as a list of statements.
 * - `outsideTransaction`: steps (SQL or table rebuilds, db/tableRebuild.ts) run in a transaction
 *   of their own with foreign keys off, for changes that need a table rebuilt. Every reference is
 *   checked before it commits (ARCHITECTURE.md §3.7 "Table rebuilds").
 */
export type MigrationDefinition =
  { readonly statements: ReadonlyArray<string> } | { readonly outsideTransaction: ReadonlyArray<OutsideStep> }

// Migrations run in the writer worker, before any reader connection is opened.
// A migration a recorded release ran is never edited (test/releasedSchema.test.ts); a schema
// change is a new migration numbered after the newest one.
export const migrationDefinitions = {
  "0001_baseline": { statements: baseline },
  // spec/FILES-AND-ENVIRONMENT.md §10: file versions and shares, attachment names and paths.
  "0002_files": { statements: filesMigration },
  // spec/SUBAGENTS.md §11. Numbered after 0002_files, and independent of it.
  "0003_subagents": { statements: subagentSchema },
  // spec/WORKSHOP-BRANCHES.md §7: workshop branches paired with story branches.
  "0004_workshop_branches": { statements: workshopBranchesMigration },
  // Greeting previews with macros replaced: one nullable column on the stored fork summaries.
  "0005_preview_macro": { statements: previewMacroMigration },
  // DESIGN §2.2 (owner, 2026-11-18): the persona a character's new single chats start with.
  "0006_persona_locks": { statements: personaLocksMigration },
  // spec/REPLY-CONTRACT.md §3.6: how each agent story reply met the send tool's contract.
  "0007_contract_records": { statements: contractRecordsMigration },
  // spec/FILES-AND-ENVIRONMENT.md §6.1: where a workshop's attachment draft was saved in Files.
  "0008_attachment_paths": { statements: attachmentPathsMigration },
  // spec/FILES-AND-ENVIRONMENT.md §1.4: shares bound to their folder, and accepted before they reach anyone.
  "0009_share_invitations": { statements: shareInvitationsMigration },
  // spec/FILES-AND-ENVIRONMENT.md §1.4: a share also bound to its folder's birth time; declined invitations kept for the owner's view.
  "0010_share_birth": { statements: shareBirthMigration },
  // DESIGN §2.2 (owner, 2026-11-21): the reply a composer's guidance is written for, kept with its draft.
  "0011_guidance_target": { statements: guidanceTargetMigration },
  // A reply's reasoning apart in its generation figures: whether its count is an estimate, and when its first reasoning and reply tokens came.
  "0012_reasoning_stats": { statements: reasoningStatsMigration },
  // ARCHITECTURE §15 "Reasoning sent back" (owner, 2026-11-23): a plain reply's reasoning as the provider sent it.
  "0013_native_reasoning": { statements: nativeReasoningMigration },
  // Receipts say which session accepted a composer save, even after the draft moves on.
  "0014_composer_save_session": {
    statements: ["ALTER TABLE composer_save_receipts ADD COLUMN accepted_session INTEGER"]
  },
  "0015_composer_commits": {
    statements: [
      `CREATE TABLE composer_commits (
        draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
        session INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        PRIMARY KEY (draft_id, session)
      ) STRICT, WITHOUT ROWID`
    ]
  },
  "0016_workshop_starts": {
    statements: [
      `CREATE TABLE workshop_starts (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        fork_id TEXT NOT NULL,
        slot_id TEXT NOT NULL,
        speaker_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('Send', 'Generate')),
        PRIMARY KEY (user_id, request_id)
      ) STRICT, WITHOUT ROWID`
    ]
  },
  // spec/WORKSHOP-CARDS.md §4.4: library items a workshop message carries, at the revision each
  // was sent at, and the same list on a message waiting in the queue.
  "0017_library_attachments": {
    statements: [
      `CREATE TABLE version_library (
        version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('card', 'lorebook', 'preset')),
        ref_id TEXT NOT NULL REFERENCES entity_refs(id) ON DELETE CASCADE,
        revision_id TEXT NOT NULL REFERENCES entity_revisions(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        PRIMARY KEY (version_id, ordinal)
      ) STRICT, WITHOUT ROWID`,
      `CREATE INDEX version_library_ref ON version_library(ref_id)`,
      `CREATE INDEX version_library_revision ON version_library(revision_id)`,
      `ALTER TABLE queued_messages ADD COLUMN library_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(library_json))`
    ]
  },
  // DESIGN §2.1 (owner, 2026-11-23): the new-chat page's chat, pending until its first turn, and the entry it was opened for.
  "0018_pending_chats": { statements: pendingChatsMigration },
  // Older queued sends stored no revision. Capture the head present at upgrade for those rows.
  // The original payload check predates library-only sends.
  "0019_queue_library_revisions": {
    outsideTransaction: [
      {
        table: "queued_messages",
        create: baseline
          .find((statement) => statement.startsWith("CREATE TABLE queued_messages ("))!
          // 0004 dropped story_at_json; 0017 added library_json in its place at the end.
          .replace(
            "    -- A side chat's story position for the reply this entry asks for (spec/WORKSHOP.md §4).\n" +
              "    story_at_json TEXT CHECK (story_at_json IS NULL OR json_valid(story_at_json)),",
            "    library_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(library_json)),"
          )
          .replace(
            "json_array_length(images_json) > 0)",
            "json_array_length(images_json) > 0 OR json_array_length(library_json) > 0)"
          )
      },
      `UPDATE queued_messages AS q SET library_json = (
        SELECT json_group_array(json_object('kind', kind, 'refId', id, 'revisionId', revision, 'name', label))
        FROM (
          SELECT e.kind, r.id, r.head_revision_id AS revision, r.label
          FROM json_each(q.library_json) j
          JOIN entity_refs r ON r.id = j.value ->> '$.refId'
          JOIN entities e ON e.id = r.entity_id AND e.kind = j.value ->> '$.kind'
          JOIN chats c ON c.id = q.chat_id AND c.kind = 'workshop' AND c.owner_user_id = e.owner_user_id
          WHERE e.purged_at IS NULL
          GROUP BY r.id ORDER BY min(j.key)
        )
      ) WHERE library_json <> '[]'`
    ]
  },
  // Message and queue attachments outlive their library entry. Keep purged documents only
  // while a version or queued send still carries the revision.
  "0020_retained_library_attachments": {
    statements: [
      `CREATE TABLE purged_library_documents (
        revision_id TEXT PRIMARY KEY,
        doc_json TEXT NOT NULL CHECK (json_valid(doc_json))
      ) STRICT, WITHOUT ROWID`,
      `CREATE TABLE retained_version_library (
        version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('card', 'lorebook', 'preset')),
        ref_id TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        name TEXT NOT NULL,
        PRIMARY KEY (version_id, ordinal)
      ) STRICT, WITHOUT ROWID`,
      `INSERT INTO retained_version_library SELECT * FROM version_library`,
      `DROP TABLE version_library`,
      `ALTER TABLE retained_version_library RENAME TO version_library`,
      `CREATE INDEX version_library_ref ON version_library(ref_id)`,
      `CREATE INDEX version_library_revision ON version_library(revision_id)`,
      `CREATE TRIGGER version_library_release_document AFTER DELETE ON version_library
      WHEN EXISTS (SELECT 1 FROM purged_library_documents WHERE revision_id = OLD.revision_id)
      BEGIN
        DELETE FROM purged_library_documents WHERE revision_id = OLD.revision_id
          AND NOT EXISTS (SELECT 1 FROM version_library WHERE revision_id = OLD.revision_id)
          AND NOT EXISTS (SELECT 1 FROM queued_messages q, json_each(q.library_json) j
            WHERE j.value ->> '$.revisionId' = OLD.revision_id);
      END`,
      `CREATE TRIGGER queued_library_release_documents AFTER DELETE ON queued_messages
      WHEN OLD.library_json <> '[]'
      BEGIN
        DELETE FROM purged_library_documents
          WHERE revision_id IN (SELECT value ->> '$.revisionId' FROM json_each(OLD.library_json))
          AND NOT EXISTS (SELECT 1 FROM version_library WHERE revision_id = purged_library_documents.revision_id)
          AND NOT EXISTS (SELECT 1 FROM queued_messages q, json_each(q.library_json) j
            WHERE j.value ->> '$.revisionId' = purged_library_documents.revision_id);
      END`
    ]
  },
  // Cards, lorebooks and presets attached to a workshop's composer and not sent yet
  // (spec/WORKSHOP-CARDS.md §4.4): one row per item, gone once sent or removed. The ref has no
  // foreign key: an item binned or purged meanwhile is left out of the reads and refused at send.
  "0021_composer_library": {
    statements: [
      `CREATE TABLE composer_library (
        draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
        ref_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('card', 'lorebook', 'preset')),
        position INTEGER NOT NULL,
        PRIMARY KEY (draft_id, ref_id)
      ) STRICT, WITHOUT ROWID`
    ]
  },
  // 0018 named the old new-chat pages' recovered texts by the card their draft's key named, whoever
  // owned it: a card that isn't the account's own names nothing of its (rev-draftchats3b #10).
  "0022_recovered_label_owner": {
    statements: [
      `UPDATE recovered_texts SET source_label = 'New chat'
        WHERE source_kind = 'user_field' AND source_id LIKE 'pending-chat:%'
          AND source_id NOT LIKE 'pending-chat:src:%' AND source_label LIKE 'New chat with %'
          AND NOT EXISTS (SELECT 1 FROM entities e
            WHERE e.id = substr(recovered_texts.source_id, 14) AND e.owner_user_id = recovered_texts.user_id)`
    ]
  },
  // A character card attached as a file (spec/WORKSHOP-CARDS.md §4.5): what the format worker
  // read from the copy's bytes when it was attached, once per content. The tile shows its name;
  // the model's `<attachment>` line names it and carries its fields (`doc_json`, our card document).
  "0023_card_files": {
    statements: [
      `CREATE TABLE media_card_files (
        media_id TEXT PRIMARY KEY REFERENCES media_assets(id) ON DELETE CASCADE,
        format TEXT NOT NULL CHECK (format IN ('png', 'json', 'charx')),
        spec TEXT NOT NULL,
        spec_version TEXT NOT NULL,
        name TEXT NOT NULL,
        doc_json TEXT NOT NULL
      ) STRICT`
    ]
  },
  "0024_workshop_import_media_quota": {
    statements: [
      "ALTER TABLE media_refs ADD COLUMN files_quota INTEGER NOT NULL DEFAULT 0 CHECK (files_quota IN (0, 1))"
    ]
  },
  // Revert and Redo of a workshop's changes (spec/WORKSHOP-CARDS.md §8.1): append-only records of
  // what each took back (its fields' values before and after), the revision or file content it
  // went from and to, and the changes it covers with the fields of each. `rollout_effects`'
  // `undone_at` stays one-shot Undo's.
  "0025_change_reversals": {
    statements: [
      `CREATE TABLE change_reversals (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
        target_kind TEXT NOT NULL CHECK (target_kind IN ('entity', 'file')),
        target_id TEXT NOT NULL,
        label TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('revert', 'redo')),
        reverses_id TEXT REFERENCES change_reversals(id) ON DELETE CASCADE,
        head_before TEXT,
        head_after TEXT,
        fields_json TEXT NOT NULL CHECK (json_valid(fields_json) AND json_type(fields_json) = 'array'),
        before_json TEXT NOT NULL CHECK (json_valid(before_json) AND json_type(before_json) = 'object'),
        after_json TEXT NOT NULL CHECK (json_valid(after_json) AND json_type(after_json) = 'object'),
        created_at INTEGER NOT NULL,
        CHECK ((action = 'redo') = (reverses_id IS NOT NULL))
      ) STRICT`,
      "CREATE INDEX change_reversals_chat ON change_reversals(chat_id, created_at)",
      "CREATE INDEX change_reversals_reverses ON change_reversals(reverses_id)",
      `CREATE TABLE change_reversal_effects (
        reversal_id TEXT NOT NULL REFERENCES change_reversals(id) ON DELETE CASCADE,
        rollout_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        fields_json TEXT NOT NULL CHECK (json_valid(fields_json) AND json_type(fields_json) = 'array'),
        of_json TEXT NOT NULL CHECK (json_valid(of_json) AND json_type(of_json) = 'array'),
        PRIMARY KEY (reversal_id, rollout_id, tool_call_id, seq),
        FOREIGN KEY (rollout_id, tool_call_id, seq) REFERENCES rollout_effects(rollout_id, tool_call_id, seq) ON DELETE CASCADE
      ) STRICT, WITHOUT ROWID`,
      "CREATE INDEX change_reversal_effects_effect ON change_reversal_effects(rollout_id, tool_call_id, seq)"
    ]
  },
  "0026_bin_reply_edits": {
    statements: [
      "DROP TRIGGER rollout_effects_identity",
      `CREATE TRIGGER rollout_effects_identity BEFORE UPDATE ON rollout_effects BEGIN
    SELECT RAISE(ABORT, 'effect identity is immutable') WHERE NEW.rollout_id <> OLD.rollout_id OR NEW.tool_call_id <> OLD.tool_call_id
      OR NEW.seq <> OLD.seq OR NEW.kind <> OLD.kind OR NEW.target_kind <> OLD.target_kind OR NEW.target_id <> OLD.target_id
      OR NEW.title <> OLD.title OR NEW.created_at <> OLD.created_at;
    SELECT RAISE(ABORT, 'effect cannot be undone twice') WHERE OLD.undone_at IS NOT NULL;
    SELECT RAISE(ABORT, 'effect updates must record undo') WHERE NEW.undone_at IS NULL;
    SELECT RAISE(ABORT, 'undo recipe is retained') WHERE NEW.undo_json IS NOT OLD.undo_json;
    SELECT RAISE(ABORT, 'revision undo must name a restored target revision and row version') WHERE NEW.kind = 'library.revise'
      AND NOT (
        json_type(NEW.undo_result_json, '$.binnedWithCreation') IS 'true'
        AND EXISTS (SELECT 1 FROM entities e WHERE e.id = NEW.target_id AND e.deleted_at IS NOT NULL)
        AND EXISTS (
          SELECT 1 FROM rollout_effects c JOIN rollouts created ON created.id = c.rollout_id
          JOIN rollouts edited ON edited.id = NEW.rollout_id
          WHERE c.kind = 'library.create' AND c.target_id = NEW.target_id AND c.undone_at IS NOT NULL
            AND coalesce(created.spawned_by_rollout_id, created.id) = coalesce(edited.spawned_by_rollout_id, edited.id)
        )
      ) AND (
      NOT EXISTS (SELECT 1 FROM entity_revisions v WHERE v.id = json_extract(NEW.undo_result_json, '$.restoredHead') AND v.entity_id = NEW.target_id)
      OR json_type(NEW.undo_result_json, '$.restoredRowVersion') IS NOT 'integer' OR json_extract(NEW.undo_result_json, '$.restoredRowVersion') < 0
    );
  END`
    ]
  },
  // The library's classes (spec/WORKSHOP-CARDS.md §2.2): "Read your library" became four, and a
  // workshop's choice for it is its choice for each of them.
  "0027_library_classes": {
    statements: [
      `INSERT OR IGNORE INTO workshop_grants (chat_id, capability, target, owner_user_id, mode, expires_at, updated_at)
        SELECT g.chat_id, c.value, g.target, g.owner_user_id, g.mode, g.expires_at, g.updated_at
        FROM workshop_grants g, json_each('["library.cards","library.lorebooks","library.presets","library.notes"]') c
        WHERE g.capability = 'library.read'`,
      "DELETE FROM workshop_grants WHERE capability = 'library.read'"
    ]
  },
  "0028_composer_library_carries": {
    statements: [
      `CREATE TABLE composer_library_carries (
        draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
        source_chat_id TEXT NOT NULL,
        ref_id TEXT NOT NULL,
        PRIMARY KEY (draft_id, source_chat_id, ref_id)
      ) STRICT, WITHOUT ROWID`
    ]
  },
  "0029_composer_library_handovers": {
    statements: [
      `CREATE TABLE composer_library_handovers (
        origin_chat_id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        operation_id TEXT NOT NULL,
        ref_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        PRIMARY KEY (origin_chat_id, user_id, operation_id, ref_id)
      ) STRICT, WITHOUT ROWID`,
      "CREATE INDEX composer_library_handovers_chat ON composer_library_handovers(chat_id, ref_id)"
    ]
  },
  "0030_composer_library_carry_cutover": {
    statements: [
      `CREATE TABLE composer_library_carry_cutover (before_ms INTEGER PRIMARY KEY) STRICT`,
      // 0028's ledger time has second precision. Include its final partial second, bounded
      // by this migration's actual time when both run in the same second. Only databases with
      // pre-cutover sweep receipts need the bound.
      `INSERT INTO composer_library_carry_cutover (before_ms)
        SELECT before_ms FROM (
          SELECT min((unixepoch(created_at) + 1) * 1000, CAST(unixepoch('subsec') * 1000 AS INTEGER)) AS before_ms
          FROM effect_sql_migrations WHERE migration_id = 28
        ) WHERE EXISTS (
          SELECT 1 FROM swept_pending_chats WHERE chat_id GLOB 'swept-library:*' AND swept_at < before_ms
        )`
    ]
  },
  "0031_swept_composer_library": {
    statements: [
      `CREATE TABLE swept_workshops (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        chat_id TEXT NOT NULL,
        draft_for TEXT NOT NULL,
        replacement_chat_id TEXT,
        PRIMARY KEY (user_id, chat_id)
      ) STRICT, WITHOUT ROWID`,
      `CREATE TABLE swept_composer_library (
        user_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        ref_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY (user_id, chat_id, ref_id),
        FOREIGN KEY (user_id, chat_id) REFERENCES swept_workshops(user_id, chat_id) ON DELETE CASCADE
      ) STRICT, WITHOUT ROWID`
    ]
  },
  "0032_staged_attachments": {
    statements: [
      "ALTER TABLE composer_images ADD COLUMN staged INTEGER NOT NULL DEFAULT 0 CHECK (staged IN (0,1))",
      "CREATE INDEX composer_images_staged ON composer_images(media_id, draft_id) WHERE staged = 1 AND status = 'active'",
      `CREATE TRIGGER composer_images_discard_staged AFTER DELETE ON composer_images
      WHEN OLD.staged = 1 AND OLD.media_id IS NOT NULL
      BEGIN
        DELETE FROM media_assets WHERE id = OLD.media_id
          AND NOT EXISTS (SELECT 1 FROM media_refs WHERE media_id = OLD.media_id)
          AND NOT EXISTS (SELECT 1 FROM file_versions WHERE media_id = OLD.media_id)
          AND NOT EXISTS (SELECT 1 FROM saved_media WHERE media_id = OLD.media_id)
          AND NOT EXISTS (SELECT 1 FROM chats WHERE cover_media_id = OLD.media_id)
          AND NOT EXISTS (SELECT 1 FROM forks WHERE cover_media_id = OLD.media_id)
          AND NOT EXISTS (SELECT 1 FROM version_attachments WHERE media_id = OLD.media_id)
          AND NOT EXISTS (SELECT 1 FROM composer_images WHERE media_id = OLD.media_id);
      END`
    ]
  }
} satisfies Readonly<Record<string, MigrationDefinition>>

const runAll = (statements: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    for (const statement of statements) yield* sql.unsafe(statement)
  })

const idOf = (key: string) => Number(key.slice(0, key.indexOf("_")))
const nameOf = (key: string) => key.slice(key.indexOf("_") + 1)

/**
 * Each migration as an effect the migrator runs in its transaction, for tests that build a
 * database at an older schema. A migration that must run outside the transaction dies here:
 * run it through `migrate`.
 */
export const migrations = Object.fromEntries(
  Object.entries(migrationDefinitions as Readonly<Record<string, MigrationDefinition>>).map(([key, definition]) => [
    key,
    "statements" in definition
      ? runAll(definition.statements)
      : Effect.die(new Error(`${key} runs outside the migrator's transaction: run it through migrate()`))
  ])
) as { readonly [K in keyof typeof migrationDefinitions]: Effect.Effect<void, unknown, SqlClient.SqlClient> }

const pad = (id: number) => String(id).padStart(4, "0")

/**
 * A database whose ledger holds ids this code doesn't know was made by a newer build, or by an
 * older schema this code can't read. The migrator would skip what it thinks is older and run the
 * rest on top of a schema it never made, so it is refused before the migrator starts, with
 * nothing changed. None of these messages ever tell anyone to empty the data folder.
 */
const refuseUnknownLedger = (definitions: Readonly<Record<string, MigrationDefinition>>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [ledger] = yield* sql<{
      n: number
    }>`SELECT count(*) AS n FROM sqlite_master WHERE name = 'effect_sql_migrations'`
    if (ledger!.n === 0) return
    const keys = Object.keys(definitions)
    const known = new Set(keys.map(idOf))
    const newestKnown = Math.max(...known)
    const rows = yield* sql<{
      migration_id: number
      name: string
    }>`SELECT migration_id, name FROM effect_sql_migrations`
    const unknown = rows.filter(
      (row) => !known.has(row.migration_id) || !(`${pad(row.migration_id)}_${row.name}` in definitions)
    )
    // The migrator runs only ids above the newest recorded one, so a migration numbered below it
    // (one merged after a later number was applied, say 0003 after 0004) would be skipped silently.
    const newest = Math.max(-1, ...rows.map((row) => row.migration_id))
    const recorded = new Set(rows.map((row) => row.migration_id))
    const skipped = keys.filter((key) => idOf(key) < newest && !recorded.has(idOf(key)))
    if (unknown.length === 0 && skipped.length > 0)
      return yield* Effect.die(
        new Error(
          `This build has a database change (${skipped.join(", ")}) numbered below one this data already has, so it would never run. ` +
            `Nothing was changed. This is a fault in the build, not in the data: renumber the change above the newest one.`
        )
      )
    if (unknown.length === 0) return
    const ids = unknown.map((row) => `${pad(row.migration_id)}_${row.name}`).join(", ")
    if (unknown.every((row) => row.migration_id > newestKnown))
      return yield* Effect.die(
        new Error(
          `This data was made by a newer version of Dreamspan (it has ${ids}, which this version doesn't know). Nothing was changed. ` +
            `Update Dreamspan to the version that made it, or restore the backup taken before that version's update.`
        )
      )
    return yield* Effect.die(
      new Error(
        `This data was made by a version of Dreamspan whose database this version can't read (it has ${ids}; this version knows ${keys.join(", ")}). ` +
          `Nothing was changed. Run the version that made it, or restore a backup made by this version.`
      )
    )
  })

/** Rows that point at a row that isn't there, counted by table and the table they point into. */
export interface BrokenReference {
  readonly table: string
  readonly parent: string
  readonly rows: number
}

/** What a start did to the database: the migrations it applied, and the broken references left. */
export interface MigrationReport {
  readonly applied: ReadonlyArray<string>
  readonly broken: ReadonlyArray<BrokenReference>
}

/** The writer's migration report, for the admin's Server status page (`GetDatabaseStartup`). */
export class DatabaseStartup extends Context.Service<DatabaseStartup, MigrationReport>()("rp/db/DatabaseStartup") {}

const brokenReferences = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return yield* sql<BrokenReference>`SELECT "table", parent, count(*) AS rows
    FROM pragma_foreign_key_check GROUP BY "table", parent ORDER BY rows DESC, "table", parent`
})

const describeBroken = (broken: ReadonlyArray<BrokenReference>) => {
  const total = broken.reduce((sum, row) => sum + row.rows, 0)
  const where = broken
    .slice(0, 6)
    .map((row) => `${row.rows} in ${row.table} (pointing into ${row.parent})`)
    .join(", ")
  return `${total} ${total === 1 ? "row pointing at a row that doesn't" : "rows pointing at rows that don't"} exist: ${where}${broken.length > 6 ? ", and more" : ""}`
}

const list = (keys: ReadonlyArray<string>) => keys.join(", ")
const plural = (keys: ReadonlyArray<string>, one: string, many: string) => (keys.length === 1 ? one : many)

/**
 * The reference check that ends each run of migrations, inside the run's transaction. Broken
 * references that were there before this start (`before`) are not this run's doing: they were
 * logged when the start began, and the run goes on. Any more than that, and the run rolls back
 * and the writer stops, saying exactly what was kept: the runs this start committed before it
 * (`kept`) passed the same check and stay.
 */
const refuseNewBreakage = (
  before: ReadonlyArray<BrokenReference>,
  run: ReadonlyArray<string>,
  kept: ReadonlyArray<string>
) =>
  Effect.gen(function* () {
    const now = yield* brokenReferences
    const had = new Map(before.map((row) => [`${row.table}\u0000${row.parent}`, row.rows]))
    const added = now.flatMap((row) => {
      const more = row.rows - (had.get(`${row.table}\u0000${row.parent}`) ?? 0)
      return more > 0 ? [{ ...row, rows: more }] : []
    })
    if (added.length === 0) return now
    const these = plural(run, "this database change", "these database changes")
    return yield* Effect.die(
      new Error(
        `Dreamspan won't start: this update's database ${plural(run, "change", "changes")} ${list(run)} would leave ${describeBroken(added)}. ` +
          `So ${these} ${plural(run, "was", "were")} undone, and the data is not served. ` +
          (kept.length === 0
            ? `Nothing else was changed: the data is as the version you ran before left it. Go back to that version, or restore the backup taken before this update, and report this problem.`
            : `The ${plural(kept, "change", "changes")} before ${plural(run, "it", "them")} at this start (${list(kept)}) passed the same check and ${plural(kept, "was", "were")} kept, so the version you ran before can't open this data any more: restore the backup taken before this update, and report this problem.`)
      )
    )
  })

/** Turns foreign keys back on and the legacy rename off, whatever happened. */
const restoreConnection = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe("PRAGMA legacy_alter_table = OFF")
  yield* sql.unsafe("PRAGMA foreign_keys = ON")
}).pipe(Effect.orDie)

/**
 * The code an `outsideTransaction` migration runs besides its own steps: bump this when
 * `runOutside` changes what it does (the pragmas around the steps, the check, the ledger row),
 * so the fingerprint of every released migration that runs through it changes too
 * (db/releases.ts `fingerprint`).
 */
export const OUTSIDE_RUNNER_VERSION = 1

/**
 * Runs one `outsideTransaction` migration: foreign keys off (only possible outside a
 * transaction, so it is checked), then its steps, the reference check and its ledger row in one
 * transaction. A failure rolls all of it back, and the next start tries again.
 */
const runOutside = (
  key: string,
  steps: ReadonlyArray<OutsideStep>,
  check: Effect.Effect<unknown, never, SqlClient.SqlClient>
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe("PRAGMA foreign_keys = OFF")
    const [state] = yield* sql<{ foreign_keys: number }>`PRAGMA foreign_keys`
    if (state!.foreign_keys !== 0)
      return yield* Effect.die(new Error(`${key} must run outside a transaction, with foreign keys off`))
    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (const step of steps) yield* typeof step === "string" ? sql.unsafe(step) : rebuildTable(step)
        yield* check
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${idOf(key)}, ${nameOf(key)})`
      })
    )
  }).pipe(
    Effect.ensuring(restoreConnection),
    Effect.catch((error) => Effect.die(new Error(`Migration "${key}" failed`, { cause: error })))
  )

/** Two migrations with one number: the migrator would run only one of them. A fault in the build. */
export const duplicateMigrationIds = (keys: ReadonlyArray<string>): ReadonlyArray<string> => {
  const byId = new Map<number, Array<string>>()
  for (const key of keys) byId.set(idOf(key), [...(byId.get(idOf(key)) ?? []), key])
  return [...byId.values()].filter((same) => same.length > 1).map((same) => same.join(" and "))
}

/**
 * Brings a database up to `definitions`, in order, and says what it did. Runs of ordinary
 * migrations go through Effect's migrator, each run in one transaction; an `outsideTransaction`
 * migration between them runs on its own (`runOutside`). Every run ends with the reference check
 * in its own transaction, so a run that breaks a reference rolls back alone (`refuseNewBreakage`).
 * References already broken when the start began are logged as a warning and kept in the report:
 * the start goes on, so an old problem never stops the server for good.
 */
export const migrate = (definitions: Readonly<Record<string, MigrationDefinition>>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const duplicates = duplicateMigrationIds(Object.keys(definitions))
    if (duplicates.length > 0)
      return yield* Effect.die(
        new Error(
          `This build has database changes that share a number (${duplicates.join("; ")}), so only one of each would run. ` +
            `Nothing was changed. This is a fault in the build, not in the data.`
        )
      )
    yield* refuseUnknownLedger(definitions)
    const [ledger] = yield* sql<{
      n: number
    }>`SELECT count(*) AS n FROM sqlite_master WHERE name = 'effect_sql_migrations'`
    const latest =
      ledger!.n === 0
        ? 0
        : ((yield* sql<{ id: number | null }>`SELECT max(migration_id) AS id FROM effect_sql_migrations`)[0]?.id ?? 0)
    const pending = Object.keys(definitions)
      .filter((key) => idOf(key) > latest)
      .sort((a, b) => idOf(a) - idOf(b))

    let broken = yield* brokenReferences
    if (broken.length > 0)
      yield* Effect.logWarning(
        `Dreamspan's database has ${describeBroken(broken)}. ` +
          (pending.length === 0
            ? `No database change ran at this start, so this was already there; Dreamspan starts anyway. `
            : `They were there before this start's database changes (${list(pending)}), which run anyway. `) +
          `Items that use those rows may not open or change. Restore a backup from before the problem, or report it. Admins see this on the Server status page.`
      )

    // Consecutive ordinary migrations form one run; each outside-transaction migration is its own.
    const runs: Array<{ keys: Array<string>; outside?: ReadonlyArray<OutsideStep> }> = []
    for (const key of pending) {
      const definition = definitions[key]!
      if ("outsideTransaction" in definition) runs.push({ keys: [key], outside: definition.outsideTransaction })
      else if (runs.at(-1) !== undefined && runs.at(-1)!.outside === undefined) runs.at(-1)!.keys.push(key)
      else runs.push({ keys: [key] })
    }
    // The ledger an outside-transaction migration writes its row to (the migrator makes it itself).
    if (ledger!.n === 0 && runs.some((run) => run.outside !== undefined))
      yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord({}) })
    const applied: Array<string> = []
    for (const run of runs) {
      const before = broken
      const check = refuseNewBreakage(before, run.keys, [...applied]).pipe(
        Effect.tap((now) => Effect.sync(() => (broken = now))),
        Effect.orDie
      )
      if (run.outside !== undefined) yield* runOutside(run.keys[0]!, run.outside, check)
      else
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* SqliteMigrator.run({
              loader: SqliteMigrator.fromRecord(
                Object.fromEntries(
                  run.keys.map((key) => [
                    key,
                    runAll((definitions[key] as { statements: ReadonlyArray<string> }).statements)
                  ])
                )
              )
            })
            yield* check
          })
        )
      applied.push(...run.keys)
    }
    return { applied, broken } satisfies MigrationReport
  })

export const Migrations = Layer.effect(DatabaseStartup, migrate(migrationDefinitions))
