import { history } from "./history.ts"
import { graphIntegrity } from "./graphIntegrity.ts"
import { integrity, raise } from "./integrity.ts"
import { search } from "./search.ts"
import { draftHistory } from "./drafts.ts"

const tables = ["summaries", "summary_revisions", "summary_inputs", "summary_parents", "summarization_jobs"]
const belongs = (statement: string) => tables.some((table) => new RegExp(`\\b${table}\\b`).test(statement))
const original = [...history, ...graphIntegrity, ...integrity, ...search, ...draftHistory].filter(
  (statement) => belongs(statement) && /^CREATE /.test(statement)
)

export const lcm = [
  ...original.filter((s) => s.startsWith("CREATE TRIGGER")).map((s) => `DROP TRIGGER ${s.split(/\s+/)[2]}`),
  "DROP TABLE summary_revisions_fts",
  ...["summary_inputs", "summary_parents", "summarization_jobs", "summary_revisions", "summaries"].map(
    (table) => `DROP TABLE ${table}`
  ),
  ...original.map((statement) => {
    if (statement.startsWith("CREATE TABLE summaries"))
      return statement
        .replace("'truncated', 'superseded'", "'truncated', 'superseded', 'failed'")
        .replace(
          "rollout_id TEXT",
          "error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)), batch_id TEXT, rollout_id TEXT"
        )
    if (statement.startsWith("CREATE TABLE summary_revisions"))
      return statement.replace("'user', 'changeset'", "'user', 'changeset', 'imported'")
    if (statement.startsWith("CREATE TABLE summary_inputs"))
      return statement
        .replace("version_id TEXT NOT NULL", "version_id TEXT")
        .replace("PRIMARY KEY", "amend_count INTEGER NOT NULL DEFAULT 0 CHECK (amend_count >= 0), PRIMARY KEY")
    if (statement.startsWith("CREATE TABLE summary_parents"))
      return statement.replace(
        "ordinal INTEGER NOT NULL,",
        "ordinal INTEGER NOT NULL, parent_revision_id TEXT NOT NULL REFERENCES summary_revisions(id), UNIQUE (summary_id, ordinal),"
      )
    if (statement.startsWith("CREATE TABLE summarization_jobs"))
      return statement.replace(
        "input_token_count INTEGER,",
        "batch_id TEXT, leaf_slot_id TEXT REFERENCES slots(id), input_token_count INTEGER,"
      )
    if (statement.includes("CREATE TRIGGER summary_inputs_version_in_slot"))
      return statement.replace("WHEN (SELECT", "WHEN NEW.version_id IS NOT NULL AND (SELECT")
    return statement
  }),
  "CREATE INDEX summary_parents_revision ON summary_parents(parent_revision_id)",
  "CREATE INDEX summarization_jobs_batch ON summarization_jobs(batch_id)",
  "CREATE INDEX summarization_jobs_leaf ON summarization_jobs(leaf_slot_id)",
  `CREATE TRIGGER summary_parents_own_revision BEFORE INSERT ON summary_parents
    WHEN (SELECT summary_id FROM summary_revisions WHERE id = NEW.parent_revision_id) IS NOT NEW.parent_id
    BEGIN ${raise("lineage must pin a revision of its child")}; END`,
  ...["INSERT", "UPDATE OF leaf_slot_id, chat_id"].map(
    (event, i) =>
      `CREATE TRIGGER summarization_jobs_leaf_same_chat${i ? "_update" : ""} BEFORE ${event} ON summarization_jobs
      WHEN NEW.leaf_slot_id IS NOT NULL AND (SELECT chat_id FROM slots WHERE id = NEW.leaf_slot_id) IS NOT NEW.chat_id
      BEGIN ${raise("a summary job's leaf must be in its chat")}; END`
  ),
  ...[
    ["summaries", "id = NEW.id"],
    ["summary_revisions", "id = NEW.id OR seq = NEW.seq"],
    ["summary_inputs", "summary_id = NEW.summary_id AND ordinal = NEW.ordinal"],
    ["summary_parents", "summary_id = NEW.summary_id AND (parent_id = NEW.parent_id OR ordinal = NEW.ordinal)"]
  ].map(
    ([table, condition]) => `CREATE TRIGGER ${table}_no_replace BEFORE INSERT ON ${table}
    WHEN EXISTS (SELECT 1 FROM ${table} WHERE ${condition})
    BEGIN ${raise("summary identities cannot be replaced")}; END`
  ),
  ...["summary_inputs", "summary_parents"].flatMap((table) => [
    `CREATE TRIGGER ${table}_immutable BEFORE UPDATE ON ${table} BEGIN ${raise("summary lineage is immutable")}; END`,
    `CREATE TRIGGER ${table}_retained BEFORE DELETE ON ${table}
      WHEN EXISTS (SELECT 1 FROM summaries s JOIN chats c ON c.id = s.chat_id WHERE s.id = OLD.summary_id)
      BEGIN ${raise("summary lineage lives as long as its chat")}; END`
  ]),
  `CREATE TRIGGER summaries_immutable BEFORE UPDATE ON summaries WHEN
    NEW.id IS NOT OLD.id OR NEW.chat_id IS NOT OLD.chat_id OR NEW.level IS NOT OLD.level OR
    NEW.first_slot_id IS NOT OLD.first_slot_id OR NEW.last_slot_id IS NOT OLD.last_slot_id OR
    NEW.slot_count IS NOT OLD.slot_count OR NEW.audience_json IS NOT OLD.audience_json OR
    NEW.rollout_id IS NOT OLD.rollout_id OR NEW.error_json IS NOT OLD.error_json OR
    NEW.batch_id IS NOT OLD.batch_id OR NEW.created_at IS NOT OLD.created_at OR
    (NEW.status IS NOT OLD.status AND NEW.status <> 'superseded')
    BEGIN ${raise("only summary selection, supersession and row version can change")}; END`,
  ...["summaries", "summary_revisions"].map(
    (table) =>
      `CREATE TRIGGER ${table}_retained BEFORE DELETE ON ${table}
      WHEN EXISTS (SELECT 1 FROM chats c ${table === "summary_revisions" ? "JOIN summaries s ON s.chat_id = c.id WHERE s.id = OLD.summary_id" : "WHERE c.id = OLD.chat_id"})
      BEGIN ${raise("summaries and revisions live as long as their chat")}; END`
  )
]
