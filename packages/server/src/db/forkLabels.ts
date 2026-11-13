// Fork labels (spec/FORK-COST.md §4): where each fork sits in a nested-interval order of the
// chat's fork tree, so a per-fork lookup is one index probe whatever the fork's depth or the
// number of forks.
//
// Each fork F has a base B(F) (bytes) and an epoch e(F), how many forks were made from it so
// far. Its point is B(F)·enc(e(F)); its range is every label from B(F)·enc(0) up to its end
// B(F)·ff. Making G from F sets B(G) to F's point and moves F's epoch on, so whatever F writes
// afterwards sorts after everything in G's range, and whatever it wrote before, before. `enc`
// is order-preserving and prefix-free: one byte e + 1 below 224, f0 and two bytes below
// 65,760, else f1 and eight bytes; ff never starts a code.
//
// A per-fork row (`fork_overrides`) of (kind, target) written in F adds a step at F's point
// naming the row and, the first time F writes that key, a step at F's end naming the row in
// force there just before (null: none): what F inherited. The effective row of a key in fork
// X is the step with the greatest label at or below X's point. Rows that are added rather
// than keyed (fork-scoped `state_events`, `history_changes`) carry their writer's point and
// are visible in X when label <= point(X) < end(writer).
//
// Triggers keep all of it (`forkLabelSchema`, in the baseline); bulk loads pause them with a
// row in `fork_label_pause` and call `rebuildForkLabels`.
import type { DatabaseSync } from "node:sqlite"

/** SQL: the code of epoch `e` (an SQL expression) as hex text. */
const encHexSql = (e: string) =>
  `(CASE WHEN ${e} < 224 THEN printf('%02X', ${e} + 1)
    WHEN ${e} < 65760 THEN 'F0' || printf('%04X', ${e} - 224)
    ELSE 'F1' || printf('%016X', ${e} - 224) END)`

/** SQL: the label `base`·enc(`e`) (SQL expressions; `||` on blobs makes text, hence hex). */
const labelSql = (base: string, e: string) => `unhex(hex(${base}) || ${encHexSql(e)})`

/** The code of epoch `e`. */
const enc = (e: number): Uint8Array => {
  if (e < 224) return Uint8Array.of(e + 1)
  if (e < 65760) return Uint8Array.of(0xf0, (e - 224) >> 8, (e - 224) & 0xff)
  const out = new Uint8Array(9)
  out[0] = 0xf1
  new DataView(out.buffer).setBigUint64(1, BigInt(e) - 224n)
  return out
}

const concat = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}
const END = Uint8Array.of(0xff)

const live = `NOT EXISTS (SELECT 1 FROM fork_label_pause)`

/** SQL: fork `fork`'s point (an SQL expression naming a fork id). */
export const pointSql = (fork: string) => `(SELECT fx_l.point FROM fork_labels fx_l WHERE fx_l.fork_id = ${fork})`

/** SQL: fork `fork`'s range end. */
export const endSql = (fork: string) => `(SELECT fx_w.label_end FROM fork_labels fx_w WHERE fx_w.fork_id = ${fork})`

/**
 * SQL: the point fork `fork` had when the chat's state seq was `seq` (both SQL expressions): its
 * epoch then counts the forks made from it before, as `rebuildForkLabels` places rows.
 */
export const pointAtSql = (fork: string, seq: string) =>
  labelSql(
    `(SELECT fx_b.base FROM fork_labels fx_b WHERE fx_b.fork_id = ${fork})`,
    `(SELECT count(*) FROM forks fx_c WHERE fx_c.parent_fork_id = ${fork} AND fx_c.branched_at < ${seq})`
  )

/**
 * SQL: a recursive CTE `name(fork_id, bound, n)` of fork `fork`'s lineage (an SQL expression):
 * itself, unbounded, then its parent up to when it was made, and so on up (`n` from 0). For
 * the few reads that list rows rather than look a key up; O(depth), once per statement.
 */
export const lineageCte = (name: string, fork: string) => `${name}(fork_id, bound, n) AS (
    SELECT id, 9223372036854775807, 0 FROM forks WHERE id = ${fork}
    UNION ALL SELECT c.parent_fork_id, c.branched_at, ${name}.n + 1 FROM ${name} JOIN forks c ON c.id = ${name}.fork_id
    WHERE c.parent_fork_id IS NOT NULL)`

export const forkLabelSchema: ReadonlyArray<string> = [
  // A row here pauses the label triggers, for a bulk load that calls rebuildForkLabels after.
  `CREATE TABLE fork_label_pause (paused INTEGER NOT NULL) STRICT`,
  `CREATE TABLE fork_labels (
    fork_id TEXT PRIMARY KEY REFERENCES forks(id) ON DELETE CASCADE,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    base BLOB NOT NULL,
    -- How many forks were made from it so far.
    epoch INTEGER NOT NULL CHECK (epoch >= 0),
    -- base·enc(epoch): where its own rows are written and its lookups are made.
    point BLOB NOT NULL,
    -- base·ff: everything from base·enc(0) up to here is it and the forks made from it.
    label_end BLOB NOT NULL
  ) STRICT`,
  `CREATE INDEX fork_labels_point ON fork_labels(chat_id, point)`,
  `CREATE TABLE fork_steps (
    kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    label BLOB NOT NULL,
    -- The effective override of (kind, target) from this label on; null: none, the base column.
    override_id TEXT,
    PRIMARY KEY (kind, target_id, label)
  ) STRICT, WITHOUT ROWID`,
  `CREATE TRIGGER fork_labels_made AFTER INSERT ON forks WHEN ${live} BEGIN
    INSERT INTO fork_labels (fork_id, chat_id, base, epoch, point, label_end)
      SELECT NEW.id, NEW.chat_id, b, 0, ${labelSql("b", "0")}, unhex(hex(b) || 'FF')
      FROM (SELECT coalesce((SELECT point FROM fork_labels WHERE fork_id = NEW.parent_fork_id), x'') AS b);
    UPDATE fork_labels SET epoch = epoch + 1, point = ${labelSql("base", "epoch + 1")}
      WHERE fork_id = NEW.parent_fork_id;
  END`,
  `CREATE TRIGGER fork_labels_fixed BEFORE UPDATE OF fork_id, chat_id, base, label_end ON fork_labels
    BEGIN SELECT RAISE(ABORT, 'a fork keeps its place in the fork tree'); END`,
  `CREATE TRIGGER forks_parent_fixed BEFORE UPDATE OF parent_fork_id, branched_at ON forks
    WHEN NEW.parent_fork_id IS NOT OLD.parent_fork_id OR NEW.branched_at IS NOT OLD.branched_at
    BEGIN SELECT RAISE(ABORT, 'a fork keeps its parent and the moment it was made'); END`,
  // The end step first, while the point step doesn't hide what was in force at the end.
  `CREATE TRIGGER fork_overrides_steps AFTER INSERT ON fork_overrides WHEN ${live} BEGIN
    INSERT OR IGNORE INTO fork_steps (kind, target_id, label, override_id)
      SELECT NEW.kind, NEW.target_id, l.label_end, (SELECT p.override_id FROM fork_steps p
        WHERE p.kind = NEW.kind AND p.target_id = NEW.target_id AND p.label <= l.label_end ORDER BY p.label DESC LIMIT 1)
      FROM fork_labels l WHERE l.fork_id = NEW.fork_id;
    INSERT OR REPLACE INTO fork_steps (kind, target_id, label, override_id)
      SELECT NEW.kind, NEW.target_id, l.point, NEW.id FROM fork_labels l WHERE l.fork_id = NEW.fork_id;
  END`,
  // Overrides go only with their chat (its cascade), which takes every step of their keys with it.
  `CREATE TRIGGER fork_overrides_go_with_chat BEFORE DELETE ON fork_overrides
    WHEN EXISTS (SELECT 1 FROM chats WHERE id = OLD.chat_id)
    BEGIN SELECT RAISE(ABORT, 'an override goes only with its chat'); END`,
  `CREATE TRIGGER fork_overrides_steps_gone AFTER DELETE ON fork_overrides BEGIN
    DELETE FROM fork_steps WHERE kind = OLD.kind AND target_id = OLD.target_id;
  END`,
  // A legacy interrupted import copies events with their original labels and fork seqs.
  `CREATE TRIGGER state_events_fork_label AFTER INSERT ON state_events
    WHEN NEW.fork_id IS NOT NULL AND NEW.fork_label IS NULL AND ${live} BEGIN
    UPDATE state_events SET fork_label = (SELECT point FROM fork_labels WHERE fork_id = NEW.fork_id) WHERE id = NEW.id;
  END`,
  `CREATE TRIGGER state_events_fork_label_fixed BEFORE UPDATE OF fork_label ON state_events
    WHEN OLD.fork_label IS NOT NULL AND NEW.fork_label IS NOT OLD.fork_label AND ${live}
    BEGIN SELECT RAISE(ABORT, 'a state event keeps its fork label'); END`,
  `CREATE TRIGGER history_changes_label AFTER INSERT ON history_changes WHEN NEW.fork_id <> '' AND ${live} BEGIN
    UPDATE history_changes SET label = (SELECT point FROM fork_labels WHERE fork_id = NEW.fork_id)
      WHERE slot_id = NEW.slot_id AND fork_id = NEW.fork_id AND seq = NEW.seq;
  END`
]

/**
 * Recomputes every label and step of chat `chatId` from seqs and `branched_at` (the lineage
 * rule: a fork sees its parent's rows with seq up to its `branched_at`, its own, and so on
 * up), for bulk loads that paused the triggers; it pauses them itself while it runs. Children
 * are ordered by `(branched_at, id)`, and a row of seq s goes at the epoch counting its fork's
 * children with `branched_at` < s.
 */
export const rebuildForkLabels = (db: DatabaseSync, chatId: string) => {
  db.prepare("INSERT INTO fork_label_pause (paused) VALUES (2)").run()
  const forks = db
    .prepare(
      "SELECT id, parent_fork_id AS parent, branched_at AS at FROM forks WHERE chat_id = ? ORDER BY branched_at, id"
    )
    .all(chatId) as Array<{ id: string; parent: string | null; at: number }>
  const kids = new Map<string, Array<{ id: string; at: number }>>()
  for (const f of forks)
    if (f.parent !== null) {
      const list = kids.get(f.parent) ?? []
      list.push(f)
      kids.set(f.parent, list)
    }
  const base = new Map<string, Uint8Array>()
  const stack = forks.filter((f) => f.parent === null).map((f) => f.id)
  for (const root of stack) base.set(root, new Uint8Array())
  while (stack.length > 0) {
    const id = stack.pop()!
    for (const [i, kid] of (kids.get(id) ?? []).entries()) {
      base.set(kid.id, concat(base.get(id)!, enc(i)))
      stack.push(kid.id)
    }
  }
  const epochAt = (fork: string, seq: number) => {
    const list = kids.get(fork) ?? []
    let lo = 0
    let hi = list.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (list[mid]!.at < seq) lo = mid + 1
      else hi = mid
    }
    return lo
  }
  const pointAt = (fork: string, seq: number) => concat(base.get(fork)!, enc(epochAt(fork, seq)))
  const endOf = (fork: string) => concat(base.get(fork)!, END)
  db.prepare("DELETE FROM fork_labels WHERE chat_id = ?").run(chatId)
  const label = db.prepare(
    "INSERT INTO fork_labels (fork_id, chat_id, base, epoch, point, label_end) VALUES (?, ?, ?, ?, ?, ?)"
  )
  for (const f of forks) {
    const e = kids.get(f.id)?.length ?? 0
    label.run(f.id, chatId, base.get(f.id)!, e, concat(base.get(f.id)!, enc(e)), endOf(f.id))
  }
  db.prepare(
    `DELETE FROM fork_steps WHERE (kind, target_id) IN (SELECT kind, target_id FROM fork_overrides WHERE chat_id = ?)`
  ).run(chatId)
  const prev = db.prepare(
    "SELECT override_id AS id FROM fork_steps WHERE kind = ? AND target_id = ? AND label <= ? ORDER BY label DESC LIMIT 1"
  )
  const end = db.prepare("INSERT OR IGNORE INTO fork_steps (kind, target_id, label, override_id) VALUES (?, ?, ?, ?)")
  const step = db.prepare("INSERT OR REPLACE INTO fork_steps (kind, target_id, label, override_id) VALUES (?, ?, ?, ?)")
  const rows = db
    .prepare(
      "SELECT id, fork_id AS fork, kind, target_id AS target, seq FROM fork_overrides WHERE chat_id = ? ORDER BY seq, id"
    )
    .all(chatId) as Array<{ id: string; fork: string; kind: string; target: string; seq: number }>
  for (const r of rows) {
    const stop = endOf(r.fork)
    const before = prev.get(r.kind, r.target, stop) as { id: string | null } | undefined
    end.run(r.kind, r.target, stop, before?.id ?? null)
    step.run(r.kind, r.target, pointAt(r.fork, r.seq), r.id)
  }
  const events = db
    .prepare("SELECT id, fork_id AS fork, fork_seq AS seq FROM state_events WHERE chat_id = ? AND fork_id IS NOT NULL")
    .all(chatId) as Array<{ id: string; fork: string; seq: number }>
  const setEvent = db.prepare("UPDATE state_events SET fork_label = ? WHERE id = ?")
  for (const e of events) setEvent.run(pointAt(e.fork, e.seq), e.id)
  const changes = db
    .prepare("SELECT slot_id, fork_id AS fork, seq FROM history_changes WHERE chat_id = ? AND fork_id <> ''")
    .all(chatId) as Array<{ slot_id: string; fork: string; seq: number }>
  const setChange = db.prepare("UPDATE history_changes SET label = ? WHERE slot_id = ? AND fork_id = ? AND seq = ?")
  for (const c of changes) setChange.run(pointAt(c.fork, c.seq), c.slot_id, c.fork, c.seq)
  // A thread split's label is its branch's point when it was made, before its threads' forks
  // (spec/THREADS.md §4.1): the forks made from that branch at or after its seq aren't counted.
  const splits = db
    .prepare("SELECT id, fork_id AS fork, seq FROM thread_splits WHERE chat_id = ?")
    .all(chatId) as Array<{ id: string; fork: string; seq: number }>
  const setSplit = db.prepare("UPDATE thread_splits SET fork_label = ? WHERE id = ?")
  for (const x of splits) setSplit.run(pointAt(x.fork, x.seq), x.id)
  db.prepare("DELETE FROM fork_label_pause WHERE paused = 2").run()
  return {
    forks: forks.length,
    overrides: rows.length,
    events: events.length,
    changes: changes.length,
    splits: splits.length
  }
}
