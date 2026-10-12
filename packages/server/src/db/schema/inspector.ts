// The request inspector and the cache-warmth estimate (ARCHITECTURE §15, migration 0013).
export const inspector = [
  // What a version shows of its context's issues, without reading the whole snapshot.
  `ALTER TABLE rollouts ADD COLUMN context_issues_json TEXT
    CHECK (context_issues_json IS NULL OR json_valid(context_issues_json))`,
  `UPDATE rollouts SET context_issues_json = (SELECT json_extract(p.context_snapshot_json, '$.issues')
    FROM rollout_payloads p WHERE p.rollout_id = rollouts.id)`,
  // A chat's latest request, for the estimate.
  `DROP INDEX llm_requests_chat`,
  `CREATE INDEX llm_requests_chat ON llm_requests(chat_id, started_at) WHERE chat_id IS NOT NULL`
]
