// 0007_contract_records (replycontract6; spec/REPLY-CONTRACT.md §3.6, milestone 4): how each agent
// story reply met the send tool's contract, for the per-model metrics in Settings → Models. Two
// nullable columns on the rollout, written with its transcript once the run ends (null for a run
// under another contract, one still going, or one stopped or failed), and an index for the
// metrics' read. Additive only.
export const contractRecordsMigration: ReadonlyArray<string> = [
  `ALTER TABLE rollouts ADD COLUMN contract_outcome TEXT
    CHECK (contract_outcome IS NULL OR contract_outcome IN ('clean', 'recovered', 'gave_up', 'exhausted'))`,
  `ALTER TABLE rollouts ADD COLUMN contract_nudges INTEGER CHECK (contract_nudges IS NULL OR contract_nudges >= 0)`,
  `CREATE INDEX rollouts_contract ON rollouts(model_id) WHERE contract_outcome IS NOT NULL`
]
