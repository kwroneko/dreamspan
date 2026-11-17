// Migration 0003_subagents (spec/SUBAGENTS.md §11): a subagent is a rollout another rollout's
// tool call started. Three nullable columns on `rollouts` link it to that run and call and name
// it by its handle; existing rows are untouched (all NULL). The index finds a run's children
// without reading every rollout of the chat; the triggers keep the link whole, in one chat, one
// level deep and fixed once written. Nothing here depends on another migration's objects.
export const subagentSchema: ReadonlyArray<string> = [
  `ALTER TABLE rollouts ADD COLUMN spawned_by_rollout_id TEXT REFERENCES rollouts(id)`,
  `ALTER TABLE rollouts ADD COLUMN spawned_by_call_id TEXT`,
  `ALTER TABLE rollouts ADD COLUMN agent_handle TEXT
    CHECK (agent_handle IS NULL OR length(agent_handle) BETWEEN 1 AND 64)`,
  `CREATE INDEX rollouts_spawned ON rollouts(spawned_by_rollout_id, spawned_by_call_id)
    WHERE spawned_by_rollout_id IS NOT NULL`,
  `CREATE TRIGGER rollouts_spawn_shape BEFORE INSERT ON rollouts
    WHEN (NEW.spawned_by_rollout_id IS NULL) <> (NEW.spawned_by_call_id IS NULL)
      OR (NEW.spawned_by_rollout_id IS NULL) <> (NEW.agent_handle IS NULL)
    BEGIN SELECT RAISE(ABORT, 'a subagent rollout names its parent, call and handle together'); END`,
  `CREATE TRIGGER rollouts_spawn_same_chat BEFORE INSERT ON rollouts
    WHEN NEW.spawned_by_rollout_id IS NOT NULL
      AND (SELECT chat_id FROM rollouts WHERE id = NEW.spawned_by_rollout_id) IS NOT NEW.chat_id
    BEGIN SELECT RAISE(ABORT, 'rollouts.spawned_by_rollout_id must be in the same chat'); END`,
  `CREATE TRIGGER rollouts_spawn_not_nested BEFORE INSERT ON rollouts
    WHEN NEW.spawned_by_rollout_id IS NOT NULL
      AND (SELECT spawned_by_rollout_id FROM rollouts WHERE id = NEW.spawned_by_rollout_id) IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'a subagent cannot start subagents'); END`,
  `CREATE TRIGGER rollouts_spawn_fixed BEFORE UPDATE OF spawned_by_rollout_id, spawned_by_call_id, agent_handle
    ON rollouts
    BEGIN SELECT RAISE(ABORT, 'a subagent rollout keeps its parent, call and handle'); END`
]
