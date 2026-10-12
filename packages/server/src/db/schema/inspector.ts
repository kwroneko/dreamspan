import { ContextIssue } from "@rp/shared/chat.ts"

// The request inspector and the cache-warmth estimate (ARCHITECTURE §15, migration 0016).
export const inspector = [
  // What a version shows of its context's issues, without reading the whole snapshot.
  `ALTER TABLE rollouts ADD COLUMN context_issues_json TEXT
    CHECK (context_issues_json IS NULL OR json_valid(context_issues_json))`,
  `UPDATE rollouts SET context_issues_json = (
    SELECT CASE WHEN json_type(p.context_snapshot_json, '$.issues') = 'array'
      AND NOT EXISTS (
        SELECT 1 FROM json_each(p.context_snapshot_json, '$.issues') i
        WHERE CASE WHEN i.type = 'object' THEN
          json_type(i.value, '$.message') IS NOT 'text'
          OR json_extract(i.value, '$.kind') IS NULL
          OR json_extract(i.value, '$.kind') NOT IN
            (${ContextIssue.fields.kind.literals.map((kind) => `'${kind}'`).join(", ")})
          ELSE 1 END
      ) THEN json_extract(p.context_snapshot_json, '$.issues') ELSE NULL END
    FROM rollout_payloads p WHERE p.rollout_id = rollouts.id)`,
  `ALTER TABLE connections ADD COLUMN cache_revision INTEGER NOT NULL DEFAULT 0`,
  `CREATE TRIGGER connections_cache_revision AFTER UPDATE OF base_url, proxy_mode, proxy_url_enc,
    credential_id, headers_enc, compat_json, deleted_at, purged_at ON connections
    WHEN NEW.base_url IS NOT OLD.base_url OR NEW.proxy_mode IS NOT OLD.proxy_mode
      OR NEW.proxy_url_enc IS NOT OLD.proxy_url_enc OR NEW.credential_id IS NOT OLD.credential_id
      OR NEW.headers_enc IS NOT OLD.headers_enc OR NEW.compat_json IS NOT OLD.compat_json
      OR NEW.deleted_at IS NOT OLD.deleted_at OR NEW.purged_at IS NOT OLD.purged_at
    BEGIN UPDATE connections SET cache_revision = OLD.cache_revision + 1 WHERE id = NEW.id; END`,
  `CREATE TRIGGER credentials_cache_revision AFTER UPDATE OF key_enc ON credentials
    WHEN NEW.key_enc IS NOT OLD.key_enc
    BEGIN UPDATE connections SET cache_revision = cache_revision + 1 WHERE credential_id = NEW.id; END`,
  `CREATE TRIGGER network_cache_insert AFTER INSERT ON app_settings WHEN NEW.key = 'network'
    BEGIN UPDATE connections SET cache_revision = cache_revision + 1; END`,
  `CREATE TRIGGER network_cache_update AFTER UPDATE ON app_settings WHEN NEW.key = 'network'
    BEGIN UPDATE connections SET cache_revision = cache_revision + 1; END`,
  // A chat's latest request, for the estimate.
  `DROP INDEX llm_requests_chat`,
  `CREATE INDEX llm_requests_chat ON llm_requests(chat_id, started_at) WHERE chat_id IS NOT NULL`
]
