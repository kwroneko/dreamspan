import { cardNamesMigration } from "./cardNamesMigration.ts"
import { notesMigration } from "./notesMigration.ts"
import { personaNotesMigration } from "./personaNotesMigration.ts"
import { lcmDefaultsMigration } from "./lcmDefaultsMigration.ts"
import { promptPreset, LegacyPresetDoc } from "@rp/shared/docs/preset.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import { Schema } from "effect"
import { docHash, searchText } from "./documents.ts"
import { lcmEnableSchema } from "./schema/lcmEnable.ts"
import { composerChoiceSchema } from "./schema/composerChoice.ts"
import { historyChangesSchema } from "./historyChanges.ts"
import { lcm } from "./schema/lcm.ts"
import { SqliteMigrator } from "@effect/sql-sqlite-node"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import {
  accounts,
  bin,
  binIndex,
  credentials,
  dataModel,
  draftHistory,
  draftSessions,
  graphIntegrity,
  inspector,
  ownership,
  providers,
  queue,
  secretBindings,
  users
} from "./schema/index.ts"

/** node:sqlite prepares one statement at a time, so DDL is kept as a list of statements. */
const runAll = (statements: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    for (const statement of statements) yield* sql.unsafe(statement)
  })

/** 0005 recreates connections and models, which is only safe while nothing has written them. */
const providersMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{
    readonly n: number
  }>`SELECT (SELECT count(*) FROM connections) + (SELECT count(*) FROM models) AS n`
  if (rows[0]!.n > 0) return yield* Effect.die(new Error("0005_providers: connections or models already hold rows"))
  yield* runAll(providers)
})

/** 0006 retires per-connection keys, which is only safe while no connection holds one. */
const credentialsMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{ readonly n: number }>`SELECT count(*) AS n FROM connections WHERE api_key_enc IS NOT NULL`
  if (rows[0]!.n > 0) {
    return yield* Effect.die(
      new Error("0006_credentials: connections still hold keys; remove them and enter them again")
    )
  }
  yield* runAll(credentials)
})

// Migrations run in the writer worker, before any reader connection is opened.
// Until the first release, the schema can still be reshaped freely here.
export const migrations = {
  "0001_users": runAll(users),
  "0002_data_model": runAll(dataModel),
  "0003_draft_history": runAll(draftHistory),
  "0004_recycle_bin": runAll(bin),
  "0005_providers": providersMigration,
  "0006_credentials": credentialsMigration,
  "0007_accounts": runAll(accounts),
  "0008_secret_bindings": runAll(secretBindings),
  "0009_bin_index": runAll(binIndex),
  "0010_graph_integrity": runAll(graphIntegrity),
  "0011_ownership": runAll(ownership),
  "0012_queued_messages": runAll(queue),
  "0013_draft_sessions": runAll(draftSessions),
  "0014_deleted_subtree_roots": runAll([
    `ALTER TABLE slots ADD COLUMN branch_deleted INTEGER NOT NULL DEFAULT 0 CHECK (branch_deleted IN (0, 1))`,
    `UPDATE slots SET branch_deleted = 1 WHERE id IN (SELECT target_id FROM bin_items WHERE kind = 'branch')`,
    // Purged subtree roots can still be identified by the shared deletion mark of their children.
    `UPDATE slots AS s SET branch_deleted = 1 WHERE s.deleted_at IS NOT NULL AND s.bin_item_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM slots child INDEXED BY slots_parent
        WHERE child.parent_slot_id = s.id AND child.bin_item_id = s.bin_item_id)
      AND NOT EXISTS (SELECT 1 FROM slots parent WHERE parent.id = s.parent_slot_id AND parent.bin_item_id = s.bin_item_id)`,
    // The rest of the purged slots can't say how they were deleted: a branch whose replies
    // were deleted on their own shares its mark with none of them. A purged message leaves its
    // replies live, a purged branch nothing; so one with nothing live below is taken for a
    // branch, and a reply restored from the bin later stays behind it (ARCHITECTURE §3.11).
    `UPDATE slots AS s SET branch_deleted = 1 WHERE s.purged_at IS NOT NULL AND s.branch_deleted = 0
      AND NOT EXISTS (
        WITH RECURSIVE below(id) AS (
          SELECT id FROM slots INDEXED BY slots_parent WHERE parent_slot_id = s.id
          UNION ALL SELECT c.id FROM slots c INDEXED BY slots_parent JOIN below ON c.parent_slot_id = below.id
        )
        SELECT 1 FROM below JOIN slots x ON x.id = below.id WHERE x.deleted_at IS NULL)`
  ]),
  "0015_composer_save_receipts": runAll([
    `CREATE TABLE composer_save_receipts (
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      operation_id TEXT NOT NULL,
      recovered INTEGER NOT NULL CHECK (recovered IN (0, 1)),
      PRIMARY KEY (chat_id, operation_id)
    ) STRICT`
  ]),
  "0016_inspector": runAll(inspector),
  "0017_sent_context": runAll([
    `ALTER TABLE rollout_payloads ADD COLUMN sent_context_json TEXT
      CHECK (sent_context_json IS NULL OR json_valid(sent_context_json))`
  ]),
  "0018_draft_displacement_receipts": runAll([
    `ALTER TABLE composer_save_receipts ADD COLUMN displaced_json TEXT
      CHECK (displaced_json IS NULL OR json_valid(displaced_json))`
  ]),
  "0019_cache_stagger": runAll([
    `ALTER TABLE llm_requests ADD COLUMN cache_stagger_json TEXT CHECK (cache_stagger_json IS NULL OR json_valid(cache_stagger_json))`,
    `CREATE TRIGGER llm_requests_stagger_frozen BEFORE UPDATE OF cache_stagger_json ON llm_requests
      WHEN OLD.status <> 'running' AND NEW.cache_stagger_json IS NOT OLD.cache_stagger_json
      BEGIN SELECT RAISE(ABORT, 'a closed request is a record'); END`
  ]),
  "0020_cache_identity": runAll([
    `ALTER TABLE llm_requests ADD COLUMN cache_identity_json TEXT CHECK (cache_identity_json IS NULL OR json_valid(cache_identity_json))`,
    `CREATE TRIGGER llm_requests_cache_identity_frozen BEFORE UPDATE OF cache_identity_json ON llm_requests
      WHEN OLD.status <> 'running' AND NEW.cache_identity_json IS NOT OLD.cache_identity_json
      BEGIN SELECT RAISE(ABORT, 'a closed request is a record'); END`
  ]),
  "0021_stepped_history": runAll([
    `ALTER TABLE rollouts ADD COLUMN history_start_slot_id TEXT`,
    `ALTER TABLE rollouts ADD COLUMN history_start_depth INTEGER`,
    `ALTER TABLE rollouts ADD COLUMN history_depth INTEGER`,
    `CREATE INDEX rollouts_history ON rollouts(chat_id, history_depth DESC, id DESC) WHERE history_depth IS NOT NULL`
  ]),
  "0022_history_changes": runAll(historyChangesSchema),
  "0023_lcm": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{
      n: number
    }>`SELECT (SELECT count(*) FROM summaries) + (SELECT count(*) FROM summary_revisions) + (SELECT count(*) FROM summary_inputs) + (SELECT count(*) FROM summary_parents) + (SELECT count(*) FROM summarization_jobs) AS n`
    if (row!.n !== 0) return yield* Effect.die(new Error("0023_lcm requires empty summary tables"))
    yield* runAll(lcm)
  }),
  "0024_summary_attempts": runAll([
    `ALTER TABLE summarization_jobs ADD COLUMN clip_tokens INTEGER NOT NULL DEFAULT 6000 CHECK (clip_tokens > 0)`,
    `ALTER TABLE summarization_jobs ADD COLUMN claim_epoch INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE summarization_jobs ADD COLUMN rollout_id TEXT REFERENCES rollouts(id)`,
    `CREATE INDEX summarization_jobs_rollout ON summarization_jobs(rollout_id)`,
    ...["INSERT", "UPDATE OF rollout_id, chat_id"].map(
      (event, i) =>
        `CREATE TRIGGER summarization_jobs_rollout_same_chat${i ? "_update" : ""} BEFORE ${event} ON summarization_jobs WHEN NEW.rollout_id IS NOT NULL AND (SELECT chat_id FROM rollouts WHERE id = NEW.rollout_id) IS NOT NEW.chat_id BEGIN SELECT RAISE(ABORT, 'summary rollout must belong to its job chat'); END`
    ),
    `CREATE INDEX summarization_jobs_chat_status ON summarization_jobs(chat_id, status, level)`
  ]),
  "0025_summary_prefix": runAll([
    `ALTER TABLE summarization_jobs ADD COLUMN prefix_json TEXT CHECK (prefix_json IS NULL OR json_valid(prefix_json))`
  ]),
  // The UI's "summarize this again with the next reply": a request the planner finds, so a
  // click never starts a generation. A request names a summary or a job that gave up.
  "0026_summary_reruns": runAll([
    `CREATE TABLE summary_reruns (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      summary_id TEXT REFERENCES summaries(id) ON DELETE CASCADE,
      job_id TEXT REFERENCES summarization_jobs(id) ON DELETE CASCADE,
      requested_at INTEGER NOT NULL,
      CHECK ((summary_id IS NULL) <> (job_id IS NULL))
    ) STRICT`,
    `CREATE INDEX summary_reruns_chat ON summary_reruns(chat_id)`,
    `CREATE UNIQUE INDEX summary_reruns_summary ON summary_reruns(summary_id) WHERE summary_id IS NOT NULL`,
    `CREATE UNIQUE INDEX summary_reruns_job ON summary_reruns(job_id) WHERE job_id IS NOT NULL`,
    `CREATE TRIGGER summary_reruns_same_chat BEFORE INSERT ON summary_reruns
      WHEN (NEW.summary_id IS NOT NULL AND (SELECT chat_id FROM summaries WHERE id = NEW.summary_id) IS NOT NEW.chat_id)
        OR (NEW.job_id IS NOT NULL AND (SELECT chat_id FROM summarization_jobs WHERE id = NEW.job_id) IS NOT NEW.chat_id)
      BEGIN SELECT RAISE(ABORT, 'a rerun request must name something in its own chat'); END`,
    `CREATE TRIGGER summary_reruns_fixed BEFORE UPDATE OF chat_id, summary_id, job_id ON summary_reruns
      BEGIN SELECT RAISE(ABORT, 'a rerun request is withdrawn and asked again, never moved'); END`
  ]),
  "0027_refusals": runAll([
    // The model chosen for this job (Retry with…, or the fallback), over the chat's summarizer binding.
    `ALTER TABLE summarization_jobs ADD COLUMN model_json TEXT CHECK (model_json IS NULL OR json_valid(model_json))`,
    `ALTER TABLE summarization_jobs ADD COLUMN fallback_used INTEGER NOT NULL DEFAULT 0 CHECK (fallback_used IN (0, 1))`,
    // A judge model's finding on a version's text (spec/LCM.md §2.4). Only the mark changes.
    `ALTER TABLE versions ADD COLUMN mark TEXT CHECK (mark IS NULL OR mark IN ('refused'))`
  ]),
  "0028_condensation": runAll([
    // A job started because the layer was over its budget (spec/LCM.md §2.6); its episode goes on to the target.
    `ALTER TABLE summarization_jobs ADD COLUMN eager INTEGER NOT NULL DEFAULT 0 CHECK (eager IN (0, 1))`
  ]),
  "0029_rerun_models": runAll([
    // "Retry with…": the model a rerun request wants for the new job.
    `ALTER TABLE summary_reruns ADD COLUMN model_json TEXT CHECK (model_json IS NULL OR json_valid(model_json))`
  ]),
  "0030_lcm_backfill": runAll([
    // The backfill of a chat that LCM was enabled on is a `jobs` row (spec/LCM.md §2.11) found by its chat.
    `CREATE INDEX jobs_lcm_backfill ON jobs(json_extract(payload_json, '$.chatId')) WHERE kind = 'lcm-backfill'`
  ]),
  "0031_lcm_reply_maintenance": runAll([
    `CREATE TABLE lcm_reply_maintenance (
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      leaf_slot_id TEXT NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
      pins_json TEXT NOT NULL CHECK (json_valid(pins_json)),
      PRIMARY KEY (chat_id, leaf_slot_id)
    ) STRICT`,
    `ALTER TABLE summarization_jobs ADD COLUMN source_summary_id TEXT REFERENCES summaries(id)`,
    `ALTER TABLE summarization_jobs ADD COLUMN source_revision_id TEXT REFERENCES summary_revisions(id)`,
    `ALTER TABLE summarization_jobs ADD COLUMN rerun_ids_json TEXT CHECK (rerun_ids_json IS NULL OR json_valid(rerun_ids_json))`,
    `ALTER TABLE summarization_jobs ADD COLUMN explicit_requested INTEGER NOT NULL DEFAULT 0 CHECK (explicit_requested IN (0, 1))`,
    `CREATE INDEX summarization_jobs_source ON summarization_jobs(source_summary_id)`,
    `CREATE INDEX summarization_jobs_source_revision ON summarization_jobs(source_revision_id)`,
    `CREATE INDEX lcm_reply_maintenance_leaf ON lcm_reply_maintenance(leaf_slot_id)`,
    `CREATE TABLE lcm_summary_choices (
      summary_id TEXT PRIMARY KEY REFERENCES summaries(id) ON DELETE CASCADE,
      chosen_id TEXT NOT NULL REFERENCES summaries(id) ON DELETE CASCADE
    ) STRICT`,
    `CREATE INDEX lcm_summary_choices_chosen ON lcm_summary_choices(chosen_id)`
  ]),
  "0032_lcm_request_budget": runAll([
    `ALTER TABLE llm_requests ADD COLUMN backfill_id TEXT REFERENCES jobs(id)`,
    `ALTER TABLE llm_requests ADD COLUMN reserved_tokens INTEGER`,
    `ALTER TABLE llm_requests ADD COLUMN reserved_cost REAL`,
    `ALTER TABLE llm_requests ADD COLUMN reserved_currency TEXT`,
    `CREATE INDEX llm_requests_backfill ON llm_requests(backfill_id, status)`
  ]),
  "0033_lcm_enable_staging": runAll(lcmEnableSchema),
  // The cards each chat joined, for the home grid's one read (CardUsage) and a card's chats
  // (ListChats by card), without reading every other state event.
  "0034_chat_participants": runAll([
    `CREATE INDEX state_events_participants ON state_events(json_extract(value_json, '$.entity'), chat_id)
      WHERE key = 'participant.join' AND superseded_by_changeset IS NULL`
  ]),
  // A message the user hid from the model here (SetSlotHidden), told apart from one that
  // came hidden from an ST import, so its mark says who hid it.
  "0035_hidden_by_user": runAll([
    `ALTER TABLE slots ADD COLUMN hidden_by_user INTEGER NOT NULL DEFAULT 0 CHECK (hidden_by_user IN (0, 1))`
  ]),
  // Who a composer speaks as and who replies to its next send (ComposerChoice), on its draft
  // row, so they move with the draft from tip to tip and survive a reload (ST-GRIPES D8).
  "0036_composer_choice": runAll(composerChoiceSchema),
  // A branch's name, on the message that starts it (the slot among its alternates; NameBranch).
  // Null: unnamed, shown as "Branch k".
  "0039_branch_names": runAll([`ALTER TABLE slots ADD COLUMN branch_name TEXT`]),
  // Imports may select changed ST text until a local slot mutation takes over. Existing
  // slots at revision 1 have never been changed here; others are conservatively kept.
  "0041_st_import_selection": runAll([
    `ALTER TABLE slots ADD COLUMN st_import_row_version INTEGER NOT NULL DEFAULT 1 CHECK (st_import_row_version > 0)`
  ]),
  // An import that forks a shared ST path copies deleted messages and swipes with their bin
  // item, so one deletion still covers both copies. Deleting it for good may empty every
  // row that carries the item, not only the row the item names.
  "0042_bin_item_copies": runAll([
    `DROP TRIGGER versions_model_content_frozen`,
    `CREATE TRIGGER versions_model_content_frozen BEFORE UPDATE OF content ON versions
      WHEN OLD.writer = 'model' AND OLD.status <> 'generating' AND NEW.content IS NOT OLD.content
        AND NOT (NEW.purged_at IS NOT NULL AND NEW.content = '' AND EXISTS (
          SELECT 1 FROM slots s JOIN chats c ON c.id = s.chat_id
            JOIN bin_items b ON b.user_id = c.owner_user_id AND b.chat_id = c.id
          WHERE s.id = OLD.slot_id AND (
            (b.id = OLD.bin_item_id AND b.kind = 'version')
            OR (b.id = s.bin_item_id AND b.kind IN ('message', 'branch')))))
      BEGIN SELECT RAISE(ABORT, 'model-written versions are immutable once generated; create a new version'); END`
  ]),
  // Naming, including clearing a name, is a local choice independent of an ST filename.
  // Older slots have no naming provenance: conservatively protect local revision changes.
  "0043_branch_name_user": runAll([
    `ALTER TABLE slots ADD COLUMN branch_name_user INTEGER NOT NULL DEFAULT 0 CHECK (branch_name_user IN (0, 1))`,
    `UPDATE slots SET branch_name_user = 1 WHERE row_version <> st_import_row_version`
  ]),
  "0044_card_names": cardNamesMigration,
  "0045_shell": runAll([
    `ALTER TABLE chats ADD COLUMN current_leaf_slot_id TEXT`,
    `UPDATE chats SET current_leaf_slot_id = active_leaf_slot_id`,
    `CREATE TABLE chat_pins (user_id TEXT NOT NULL REFERENCES users(id), chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, fork_id TEXT NOT NULL, PRIMARY KEY(user_id, chat_id, fork_id))`,
    `CREATE TABLE shell_preferences (user_id TEXT PRIMARY KEY REFERENCES users(id), pins_collapsed INTEGER NOT NULL DEFAULT 0)`
  ]),
  "0046_shell_owner_reads": runAll([
    `CREATE INDEX chats_owner_live ON chats(owner_user_id, id) WHERE deleted_at IS NULL`
  ]),
  "0047_global_model_settings": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const heads = yield* sql<{
      id: string
      entity_id: string
      doc_json: string
    }>`SELECT DISTINCT v.id, v.entity_id, v.doc_json
      FROM entity_refs r JOIN entities e ON e.id = r.entity_id JOIN entity_revisions v ON v.id = r.head_revision_id
      WHERE e.kind = 'preset'`
    for (const head of heads) {
      const decoded = Schema.decodeUnknownExit(LegacyPresetDoc)(JSON.parse(head.doc_json))
      if (decoded._tag !== "Success") continue
      const doc = promptPreset(decoded.value)
      const id = uuidv7()
      yield* sql`INSERT INTO entity_revisions ${sql.insert({
        id,
        entity_id: head.entity_id,
        parents: JSON.stringify([head.id]),
        doc_json: JSON.stringify(doc),
        doc_hash: docHash(doc),
        schema_version: doc.schema_version,
        origin: "user",
        message: "Move model settings out of the prompt preset; original settings remain in the parent revision.",
        search_text: searchText(doc),
        created_at: Date.now()
      })}`
      yield* sql`UPDATE entity_refs SET head_revision_id = ${id}, row_version = row_version + 1 WHERE head_revision_id = ${head.id}`
    }
    // Legacy model/preset state events stay as historical data. Live assembly ignores them;
    // none is adopted as an account default and no sampler is copied to any model.
  }),
  // A queued message sent with every character muted posts without a reply (DESIGN §3.5),
  // as an immediate send does.
  "0048_queued_no_reply": runAll([
    `ALTER TABLE queued_messages ADD COLUMN no_reply INTEGER NOT NULL DEFAULT 0 CHECK (no_reply IN (0, 1))`
  ]),
  "0049_notes": notesMigration,
  // A persona's description note is an ordinary note, and the card keeps one copy of the text (DESIGN §4.1).
  "0050_persona_notes": personaNotesMigration,
  // Chats that never changed the copied built-in summarization sizes take the new ones (DESIGN §8).
  "0051_lcm_new_defaults": lcmDefaultsMigration
}

export const Migrations = SqliteMigrator.layer({ loader: SqliteMigrator.fromRecord(migrations) })
