// Migration 0052: chains (spec/FORK-INDEPENDENCE-DELTA.md §2.1, §5 step 1). A chain is a
// run of slots at consecutive depths: a slot inserted as the first child of its parent, in
// its parent's lane, continues the parent's chain, and any other slot (a later child, a
// root) starts a chain whose id is its own. So the path from the root to a slot is a few
// segments of chains, one per branch point it passes, and reading it costs those segments
// instead of a walk up `parent_slot_id` (db/pathSegments.ts).
//
// The database assigns chains, so every insert gets one whatever wrote it, and a chain never
// changes. State events carry their slot's chain and depth, so the events on a path are
// found by segment too.

const raise = (message: string) => `SELECT RAISE(ABORT, '${message}')`

export const chains = [
  `ALTER TABLE slots ADD COLUMN chain_id TEXT`,
  `ALTER TABLE state_events ADD COLUMN slot_chain_id TEXT`,
  `ALTER TABLE state_events ADD COLUMN slot_depth INTEGER`,

  // Per parent, children by id: the first continues the parent's chain. Every other slot
  // heads its own, and the first children below it inherit it.
  `CREATE TEMP TABLE chain_first AS SELECT id, parent_slot_id FROM (
    SELECT id, parent_slot_id, row_number() OVER (PARTITION BY parent_slot_id ORDER BY id) AS n
    FROM slots WHERE parent_slot_id IS NOT NULL) WHERE n = 1`,
  `CREATE INDEX temp.chain_first_parent ON chain_first(parent_slot_id)`,
  `CREATE TEMP TABLE chain_of (id TEXT PRIMARY KEY, chain_id TEXT NOT NULL) WITHOUT ROWID`,
  `WITH RECURSIVE walk(id, chain_id) AS (
    SELECT id, id FROM slots WHERE id NOT IN (SELECT id FROM chain_first)
    UNION ALL
    SELECT f.id, w.chain_id FROM walk w JOIN chain_first f ON f.parent_slot_id = w.id
  )
  INSERT INTO chain_of SELECT id, chain_id FROM walk`,
  `UPDATE slots SET chain_id = (SELECT chain_id FROM chain_of WHERE chain_of.id = slots.id)`,
  `DROP TABLE temp.chain_of`,
  `DROP TABLE temp.chain_first`,
  `UPDATE state_events AS e SET slot_chain_id = s.chain_id, slot_depth = s.depth FROM slots s WHERE s.id = e.slot_id`,

  // One slot per chain and depth: what makes a segment a single line. Also the range scan
  // a path reads by.
  `CREATE UNIQUE INDEX slots_chain ON slots(chain_id, depth)`,
  `CREATE INDEX state_events_chain ON state_events(chat_id, slot_chain_id, slot_depth)`,

  `CREATE TRIGGER slots_chain_assigned AFTER INSERT ON slots BEGIN
    UPDATE slots SET chain_id = coalesce(
      (SELECT p.chain_id FROM slots p WHERE p.id = NEW.parent_slot_id AND p.lane_id = NEW.lane_id
        AND NOT EXISTS (SELECT 1 FROM slots c WHERE c.chain_id = p.chain_id AND c.depth = NEW.depth AND c.id <> NEW.id)),
      NEW.id)
    WHERE id = NEW.id;
  END`,
  `CREATE TRIGGER slots_chain_fixed BEFORE UPDATE OF chain_id ON slots
    WHEN OLD.chain_id IS NOT NULL AND NEW.chain_id IS NOT OLD.chain_id
    BEGIN ${raise("a slot keeps the chain it was inserted in")}; END`,
  `CREATE TRIGGER state_events_chain_unplaced BEFORE INSERT ON state_events
    WHEN NEW.slot_id IS NULL AND (NEW.slot_chain_id IS NOT NULL OR NEW.slot_depth IS NOT NULL)
    BEGIN ${raise("a chat-wide state event has no chain")}; END`,
  `CREATE TRIGGER state_events_chain_assigned AFTER INSERT ON state_events WHEN NEW.slot_id IS NOT NULL BEGIN
    UPDATE state_events SET slot_chain_id = (SELECT chain_id FROM slots WHERE id = NEW.slot_id),
      slot_depth = (SELECT depth FROM slots WHERE id = NEW.slot_id)
    WHERE id = NEW.id;
  END`,
  `CREATE TRIGGER state_events_chain_fixed BEFORE UPDATE OF slot_chain_id, slot_depth ON state_events
    WHEN (OLD.slot_chain_id IS NOT NULL OR OLD.slot_depth IS NOT NULL)
      AND (NEW.slot_chain_id IS NOT OLD.slot_chain_id OR NEW.slot_depth IS NOT OLD.slot_depth)
    BEGIN ${raise("a state event keeps the chain and depth of its slot")}; END`
]
