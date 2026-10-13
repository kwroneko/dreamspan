import { lcm } from "./lcm.ts"

const inputs = lcm.find((s) => s.startsWith("CREATE TRIGGER summary_inputs_chain"))!
const chain = lcm.find((s) => s.startsWith("CREATE TRIGGER summaries_chain"))!
export const lcmEnableSchema = [
  `CREATE TABLE lcm_enable_runs (
    id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), cursor TEXT, gathered INTEGER NOT NULL DEFAULT 0,
    copied INTEGER NOT NULL DEFAULT 0, phase TEXT NOT NULL DEFAULT 'gather', published INTEGER NOT NULL DEFAULT 0
  ) STRICT`,
  `CREATE UNIQUE INDEX lcm_enable_one_staging ON lcm_enable_runs(chat_id) WHERE published = 0 AND phase <> 'cancelled'`,
  `CREATE TABLE lcm_enable_slots (
    run_id TEXT NOT NULL REFERENCES lcm_enable_runs(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL, slot_id TEXT NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
    version_id TEXT REFERENCES versions(id), amend_count INTEGER NOT NULL, shown INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY(run_id, ordinal)
  ) STRICT`,
  `CREATE INDEX lcm_enable_slots_slot ON lcm_enable_slots(slot_id, shown, run_id)`,
  `CREATE TRIGGER lcm_enable_explicit_visibility AFTER UPDATE OF context_excluded ON slots
    BEGIN UPDATE lcm_enable_slots SET shown = 0 WHERE slot_id = NEW.id; END`,
  "DROP TRIGGER summary_inputs_chain",
  inputs.replace(
    "NEW.ordinal = (SELECT count(*) FROM summary_inputs WHERE summary_id = s.id)",
    "NEW.ordinal = coalesce((SELECT ordinal + 1 FROM summary_inputs WHERE summary_id = s.id ORDER BY ordinal DESC LIMIT 1), 0)"
  ),
  "DROP TRIGGER summaries_chain",
  chain.replace(
    "WHEN NOT EXISTS (",
    `WHEN NOT EXISTS (SELECT 1 FROM lcm_enable_runs r
    WHERE r.id = NEW.id AND r.chat_id = NEW.chat_id AND r.phase = 'copy' AND r.gathered = NEW.slot_count
      AND json_extract(r.payload_json, '$.imported.firstSlotId') = NEW.first_slot_id
      AND json_extract(r.payload_json, '$.imported.lastSlotId') = NEW.last_slot_id)
    AND NOT EXISTS (`
  )
]
