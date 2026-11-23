// 0012_reasoning_stats (reasoningstats1, 2026-11-23): a reply's reasoning apart in its generation
// figures. `reasoning_estimated`: the app counted the reasoning tokens (from the thinking text,
// or what's left of the output after the reply's own tokens) because the provider gave no count.
// `first_reasoning_at` / `first_reply_at`: when the first streamed reasoning and the first reply
// token arrived (first_token_at stays the earlier of the two). Rows from before have neither time
// and 0, which is what they knew. Frozen with the rest of a closed row.
export const reasoningStatsMigration: ReadonlyArray<string> = [
  `ALTER TABLE llm_requests ADD COLUMN reasoning_estimated INTEGER NOT NULL DEFAULT 0 CHECK (reasoning_estimated IN (0, 1))`,
  `ALTER TABLE llm_requests ADD COLUMN first_reasoning_at INTEGER`,
  `ALTER TABLE llm_requests ADD COLUMN first_reply_at INTEGER`,
  `CREATE TRIGGER llm_requests_closed_frozen_reasoning BEFORE UPDATE OF reasoning_estimated, first_reasoning_at, first_reply_at
    ON llm_requests
    WHEN OLD.status <> 'running' AND (NEW.reasoning_estimated IS NOT OLD.reasoning_estimated
      OR NEW.first_reasoning_at IS NOT OLD.first_reasoning_at OR NEW.first_reply_at IS NOT OLD.first_reply_at)
    BEGIN SELECT RAISE(ABORT, 'a closed request is a record; only its cost can be recomputed'); END`
]
