// Count slot visits by the production overridden-path query, without a timing budget.
import { DatabaseSync } from "node:sqlite"
import { parentPort, workerData } from "node:worker_threads"
import { shellOutlineSlotsQuery } from "../../src/db/shellQueries.ts"
import { baseline } from "../../src/db/baseline.ts"

const { file } = workerData as { file: string }
const db = new DatabaseSync(file)
db.exec(`CREATE TABLE chats(id TEXT PRIMARY KEY,deleted_at INTEGER);
  CREATE TABLE forks(id TEXT PRIMARY KEY,chat_id TEXT,tip_slot_id TEXT,deleted_at INTEGER);
  CREATE TABLE slots(id TEXT PRIMARY KEY,chat_id TEXT,parent_slot_id TEXT,depth INTEGER,chain_id TEXT,
    created_at INTEGER,deleted_at INTEGER,purged_at INTEGER,selected_version_id TEXT);
  CREATE UNIQUE INDEX slots_chain ON slots(chain_id,depth);
  CREATE TABLE versions(slot_id TEXT,id TEXT NOT NULL UNIQUE,purged_at INTEGER,status TEXT,speaker_entity_id TEXT,
    origin TEXT,created_at INTEGER,seq INTEGER PRIMARY KEY,content_length INTEGER,ordinal INTEGER);
  CREATE TABLE fork_overrides(id TEXT PRIMARY KEY,chat_id TEXT,value_id TEXT,flag INTEGER);
  CREATE INDEX fork_overrides_chat ON fork_overrides(chat_id);
  CREATE TABLE fork_labels(fork_id TEXT PRIMARY KEY,point BLOB);
  CREATE TABLE fork_steps(kind TEXT,target_id TEXT,label BLOB,override_id TEXT,PRIMARY KEY(kind,target_id,label)) WITHOUT ROWID;`)
for (const name of ["slots_chat_depth", "slots_shell_chain", "versions_shell"])
  db.exec(baseline.find((ddl) => ddl.startsWith(`CREATE INDEX ${name} `))!)
db.exec(`BEGIN; INSERT INTO chats VALUES('chat',NULL);
  INSERT INTO forks VALUES('current','chat','s999',NULL),('frozen','chat','s999',NULL);
  INSERT INTO fork_labels VALUES('current',X'20'),('frozen',X'01');`)
const slot = db.prepare("INSERT INTO slots VALUES(?,'chat',?,?, 's0',?,NULL,NULL,?)")
const version = db.prepare("INSERT INTO versions VALUES(?,?,NULL,'complete',NULL,?,?,?,42,?)")
for (let i = 0; i < 1000; i++) {
  slot.run(`s${i}`, i ? `s${i - 1}` : null, i, i, `v${i}-0`)
  for (let n = 0; n < 20 + (i % 31); n++)
    version.run(`s${i}`, `v${i}-${n}`, n === 5 ? "edited" : "generated", 1000 + i, i * 100 + n, n)
}
db.exec(`INSERT INTO fork_overrides VALUES('select','chat','v700-4',NULL),('replace','chat','v700-5',NULL),('delete','chat',NULL,1);
  INSERT INTO fork_steps VALUES('select','s700',X'10','select'),('replace','v700-4',X'10','replace'),('delete_slot','s123',X'10','delete');
  COMMIT;`)
let visits = 0
let labels = 0
db.function("visit", { deterministic: false, varargs: true }, () => {
  visits++
  return 1
})
db.exec("CREATE TEMP VIEW slots AS SELECT * FROM main.slots WHERE visit(rowid)")
db.function("label_visit", { deterministic: false, varargs: true }, () => {
  labels++
  return 1
})
db.exec("CREATE TEMP VIEW fork_labels AS SELECT * FROM main.fork_labels WHERE label_visit(rowid)")
const rows = db.prepare(shellOutlineSlotsQuery).all(JSON.stringify(["current", "frozen"]))
db.close()
parentPort!.postMessage({ visits, labels, rows })
