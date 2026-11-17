// 0004_workshop_branches (spec/WORKSHOP-BRANCHES.md §7): a side workshop's branches each go with one
// story branch. Numbered after 0003_subagents: the migrator runs only ids above the newest it
// recorded, so it refuses a ledger that skipped a known one (migrations.ts).
//
// - The reverse lookup of `workshop.paired` (which workshop branches go with story branch B).
// - `queued_messages.story_at_json` goes: a queued reply reads the story where its paired branch
//   stands when it posts, so the browser's position isn't kept any more. SQLite drops a column
//   in place when nothing else in the schema names it (only its own CHECK does).
// - A backfill: every fork of each workshop beside a story gets its own `workshop.paired`, naming
//   the story's current fork, so the workshop keeps reading the branch it read by default. Each
//   is written at its fork's own point (the label trigger), so the fork sees it.
export const workshopBranchesMigration: ReadonlyArray<string> = [
  `CREATE INDEX state_events_workshop_paired ON state_events(json_extract(value_json, '$.fork'), chat_id)
      WHERE key = 'workshop.paired'`,
  `ALTER TABLE queued_messages DROP COLUMN story_at_json`,
  `INSERT INTO state_events (id, chat_id, slot_id, version_id, seq, key, scope, value_json, origin, created_at,
      fork_id, fork_seq)
    SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-7' || substr(hex(randomblob(2)), 2) || '-'
        || hex(randomblob(2)) || '-' || hex(randomblob(6))),
      f.chat_id, NULL, NULL,
      (SELECT coalesce(max(x.seq), -1) FROM state_events x WHERE x.chat_id = f.chat_id AND x.slot_id IS NULL)
        + row_number() OVER (PARTITION BY f.chat_id ORDER BY f.id),
      'workshop.paired', NULL, json_object('fork', s.current_fork_id), 'user',
      CAST(unixepoch('subsec') * 1000 AS INTEGER), f.id,
      w.state_seq + row_number() OVER (PARTITION BY f.chat_id ORDER BY f.id)
    FROM forks f JOIN chats w ON w.id = f.chat_id
      JOIN state_events a ON a.chat_id = w.id AND a.key = 'workshop.attached' AND a.slot_id IS NULL
      JOIN chats s ON s.id = json_extract(a.value_json, '$.chat')
    WHERE w.kind = 'workshop' AND s.current_fork_id IS NOT NULL`,
  `UPDATE chats SET state_seq = state_seq + (SELECT count(*) FROM state_events e
      WHERE e.chat_id = chats.id AND e.key = 'workshop.paired')
    WHERE id IN (SELECT chat_id FROM state_events WHERE key = 'workshop.paired')`
]
