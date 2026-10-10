// Chat state on the graph, rollouts, summaries and changesets. DATA-MODEL.md §5, §7, §8, §9.

export const history = [
  // Every change to chat state is an event at a position in the graph (DESIGN §3.4).
  // slot_id NULL = the chat's initial state. version_id set = applies only while that
  // version of the slot is selected (rollout effects, DESIGN §7.3).
  `CREATE TABLE state_events (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    slot_id TEXT REFERENCES slots(id) ON DELETE CASCADE,
    version_id TEXT REFERENCES versions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    key TEXT NOT NULL,
    scope TEXT,
    value_json TEXT NOT NULL CHECK (json_valid(value_json)),
    origin TEXT NOT NULL CHECK (origin IN ('user', 'rollout', 'changeset', 'import')),
    origin_ref TEXT,
    created_at INTEGER NOT NULL,
    superseded_by_changeset TEXT REFERENCES changesets(id),
    CHECK (version_id IS NULL OR slot_id IS NOT NULL)
  ) STRICT`,
  `CREATE INDEX state_events_position ON state_events(chat_id, slot_id, seq)`,

  // The equivalent of reference-harness's agent_sessions. Every generation is a rollout,
  // including a plain non-agentic request (DATA-MODEL §1, principle 7). The versions
  // a rollout produced are found through versions.rollout_id.
  `CREATE TABLE rollouts (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN
      ('generation', 'summarize', 'condense', 'decision', 'workshop', 'idle_job', 'edit')),
    status TEXT NOT NULL CHECK (status IN
      ('created', 'running', 'completed', 'stopped', 'failed', 'interrupted', 'discarded')),
    slot_id TEXT REFERENCES slots(id) DEFERRABLE INITIALLY DEFERRED,
    leaf_slot_id TEXT REFERENCES slots(id) DEFERRABLE INITIALLY DEFERRED,
    parent_rollout_id TEXT REFERENCES rollouts(id),
    role TEXT NOT NULL,
    connection_id TEXT REFERENCES connections(id),
    model_id TEXT REFERENCES models(id),
    request_class TEXT NOT NULL CHECK (request_class IN ('interactive', 'idle', 'background')),
    -- Provider-reported usage, rolled up. NULL means unknown, not zero (as in reference-harness).
    llm_requests INTEGER,
    usage_input_tokens INTEGER,
    usage_output_tokens INTEGER,
    usage_cache_read_tokens INTEGER,
    usage_cache_write_tokens INTEGER,
    usage_cost REAL,
    cache_observed_json TEXT CHECK (cache_observed_json IS NULL OR json_valid(cache_observed_json)),
    error TEXT,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER
  ) STRICT`,
  `CREATE INDEX rollouts_chat ON rollouts(chat_id, created_at DESC)`,
  `CREATE INDEX rollouts_slot ON rollouts(slot_id) WHERE slot_id IS NOT NULL`,
  `CREATE INDEX rollouts_live ON rollouts(status, updated_at) WHERE status IN ('created', 'running', 'interrupted')`,

  // Heavy blobs live apart from rollouts, so queries that don't need them never walk
  // overflow pages (reference-harness's agent_session_payloads).
  `CREATE TABLE rollout_payloads (
    rollout_id TEXT PRIMARY KEY REFERENCES rollouts(id) ON DELETE CASCADE,
    context_snapshot_json TEXT CHECK (context_snapshot_json IS NULL OR json_valid(context_snapshot_json)),
    transcript_json TEXT CHECK (transcript_json IS NULL OR json_valid(transcript_json))
  ) STRICT`,

  // Spans discarded by step edits, redos and forks inside a rollout (reference-harness's
  // agent_session_branches). Branch 0 is the live transcript.
  `CREATE TABLE rollout_branches (
    rollout_id TEXT NOT NULL REFERENCES rollouts(id) ON DELETE CASCADE,
    branch_no INTEGER NOT NULL CHECK (branch_no >= 1),
    parent_branch_no INTEGER NOT NULL DEFAULT 0,
    fork_index INTEGER NOT NULL,
    reason TEXT NOT NULL,
    messages_json TEXT NOT NULL CHECK (json_valid(messages_json)),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (rollout_id, branch_no)
  ) STRICT, WITHOUT ROWID`,

  // LCM summaries over path segments: a contiguous chain of slots, each the primary
  // parent of the next (DATA-MODEL §8). Staleness is derived from summary_inputs.
  `CREATE TABLE summaries (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    level INTEGER NOT NULL CHECK (level >= 1),
    selected_revision_id TEXT NOT NULL REFERENCES summary_revisions(id) DEFERRABLE INITIALLY DEFERRED,
    first_slot_id TEXT NOT NULL REFERENCES slots(id),
    last_slot_id TEXT NOT NULL REFERENCES slots(id),
    slot_count INTEGER NOT NULL CHECK (slot_count >= 1),
    -- NULL = everyone; otherwise a JSON array of entity ids whose views may include it.
    audience_json TEXT CHECK (audience_json IS NULL OR json_valid(audience_json)),
    status TEXT NOT NULL DEFAULT 'complete' CHECK (status IN ('complete', 'truncated', 'superseded')),
    rollout_id TEXT REFERENCES rollouts(id),
    row_version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX summaries_chat_level ON summaries(chat_id, level)`,
  `CREATE INDEX summaries_last_slot ON summaries(last_slot_id)`,

  // seq is the rowid alias, so the FTS index keyed on it survives VACUUM.
  `CREATE TABLE summary_revisions (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    summary_id TEXT NOT NULL REFERENCES summaries(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    content TEXT NOT NULL,
    token_count INTEGER NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('generated', 'user', 'changeset')),
    created_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX summary_revisions_summary ON summary_revisions(summary_id, seq)`,

  // Level 1: the version of each slot that was summarized (DATA-MODEL §8.1).
  `CREATE TABLE summary_inputs (
    summary_id TEXT NOT NULL REFERENCES summaries(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    slot_id TEXT NOT NULL REFERENCES slots(id),
    version_id TEXT NOT NULL REFERENCES versions(id),
    PRIMARY KEY (summary_id, ordinal)
  ) STRICT, WITHOUT ROWID`,
  `CREATE INDEX summary_inputs_slot ON summary_inputs(slot_id)`,

  // Level >= 2 lineage, as in reference-harness.
  `CREATE TABLE summary_parents (
    summary_id TEXT NOT NULL REFERENCES summaries(id) ON DELETE CASCADE,
    parent_id TEXT NOT NULL REFERENCES summaries(id),
    ordinal INTEGER NOT NULL,
    PRIMARY KEY (summary_id, parent_id)
  ) STRICT, WITHOUT ROWID`,
  `CREATE INDEX summary_parents_parent ON summary_parents(parent_id)`,

  `CREATE TABLE summarization_jobs (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    level INTEGER NOT NULL CHECK (level >= 1),
    first_slot_id TEXT NOT NULL REFERENCES slots(id),
    last_slot_id TEXT NOT NULL REFERENCES slots(id),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'complete', 'failed')),
    request_class TEXT NOT NULL DEFAULT 'background' CHECK (request_class IN ('interactive', 'idle', 'background')),
    input_token_count INTEGER,
    target_token_count INTEGER NOT NULL,
    -- Level >= 2: the ordered child summary ids (JSON array).
    input_child_ids TEXT CHECK (input_child_ids IS NULL OR json_valid(input_child_ids)),
    absorbed_parent_id TEXT REFERENCES summaries(id),
    attempts INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 2,
    best_effort_draft TEXT,
    error TEXT,
    result_summary_id TEXT REFERENCES summaries(id),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX summarization_jobs_queue ON summarization_jobs(status, created_at) WHERE status IN ('pending', 'processing')`,
  // At most one live job per covered segment and level.
  `CREATE UNIQUE INDEX summarization_jobs_live_segment ON summarization_jobs(chat_id, first_slot_id, last_slot_id, level)
    WHERE status IN ('pending', 'processing')`,

  // One atomic batch of edits across slots, summaries, state and refs (DESIGN §10.3).
  `CREATE TABLE changesets (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('user', 'agent')),
    rollout_id TEXT REFERENCES rollouts(id),
    status TEXT NOT NULL CHECK (status IN ('applying', 'applied', 'reverted', 'partially_reverted')),
    created_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX changesets_chat ON changesets(chat_id, created_at DESC)`,

  `CREATE TABLE changeset_items (
    id INTEGER PRIMARY KEY,
    changeset_id TEXT NOT NULL REFERENCES changesets(id) ON DELETE CASCADE,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('slot_selection', 'summary_revision', 'state_event', 'ref_head')),
    target_id TEXT NOT NULL,
    before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
    after_json TEXT CHECK (after_json IS NULL OR json_valid(after_json)),
    reverted_at INTEGER
  ) STRICT`,
  `CREATE INDEX changeset_items_changeset ON changeset_items(changeset_id)`
]
