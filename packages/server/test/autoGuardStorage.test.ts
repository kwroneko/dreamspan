// Synthetic writer transactions: the guard must classify the write, not merely a reply id.
import { join } from "node:path"
import { SqliteMigrator } from "@effect/sql-sqlite-node"
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { attributed, checkAutoTurn, claimAutoTurn, trackAutoRuns } from "../src/db/autoGuard.ts"
import { writerConnection } from "../src/db/connection.ts"
import { migrations } from "../src/db/migrations.ts"
import { transaction } from "../src/db/tx.ts"
import { tempDir } from "./support/tempDir.ts"

const at = { userId: "u", chatId: "chat", forkId: "chat" }
const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(migrations) })
  yield* trackAutoRuns(sql)
  yield* sql`INSERT INTO users (id, handle, display_name, role, created_at) VALUES ('u', 'u', 'U', 'admin', 1)`
  yield* sql`INSERT INTO chats (id, owner_user_id, kind, status, created_at) VALUES ('chat', 'u', 'rp', 'active', 1)`
  yield* Effect.gen(function* () {
    yield* sql`INSERT INTO version_records (id, slot_id, ordinal, status, writer, content, macro_mode, origin, created_at, updated_at, authoring_fork_id)
      VALUES ('v', 's', 0, 'complete', 'human', 'Synthetic text', 'verbatim', 'user_written', 1, 1, 'chat')`
    yield* sql`INSERT INTO slots (id, chat_id, depth, selected_version_id, created_at) VALUES ('s', 'chat', 0, 'v', 1)`
    yield* sql`UPDATE forks SET tip_slot_id = 's' WHERE id = 'chat'`
  }).pipe(transaction(sql, "Fixture"))
  const start = claimAutoTurn(sql, at, null, { slotId: "s", versionId: "v" }).pipe(transaction(sql, "Start"))
  const write = <A, E>(operation: string, input: unknown, body: Effect.Effect<A, E>) =>
    attributed({ [operation]: (_input: unknown) => body.pipe(transaction(sql, operation)) })[operation]!(input)
  const refused = (token: string, reason = "changed") =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(checkAutoTurn(sql, at, token))
      assert.strictEqual(error._tag, "AutoRefused")
      if (error._tag === "AutoRefused") assert.strictEqual(error.reason, reason)
    })
  return { sql, start, write, refused }
})
const run = <A, E>(body: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  body.pipe(Effect.provide(writerConnection(join(tempDir("auto-guard-storage"), "db.sqlite"))))

for (const operation of [
  "AmendVersion",
  "SetThinkingHidden",
  "SelectVersion",
  "StartResumedVersion",
  "ApplyWorkshopEffect"
]) {
  it.effect(`${operation} cannot claim ownership merely by naming the run's reply`, () =>
    run(
      Effect.gen(function* () {
        const { sql, start, write, refused } = yield* setup
        const token = yield* start
        yield* write(
          operation,
          { versionId: "v" },
          sql`UPDATE version_records SET content = 'External edit' WHERE id = 'v'`
        )
        yield* refused(token)
      })
    )
  )
}

const holes = {
  plugin_data: "INSERT INTO plugin_data VALUES ('synthetic', 'u', 'prompt', '\"Changed\"', 1, 1)",
  credentials: "UPDATE credentials SET key_enc = x'02' WHERE id = 'key'",
  version_attachments:
    "INSERT INTO version_attachments (version_id,media_id,ordinal,kind) VALUES ('v','image',0,'image')",
  version_history: "INSERT INTO version_history (version_id,content,replaced_at) VALUES ('v','Old wording',1)"
}
for (const [table, statement] of Object.entries(holes)) {
  it.effect(`${table} changes cannot escape the guard`, () =>
    run(
      Effect.gen(function* () {
        const { sql, start, write, refused } = yield* setup
        yield* sql`INSERT INTO media_assets (id,sha256,mime,byte_size,path,created_at) VALUES ('image','synthetic','image/png',1,'synthetic.png',1)`
        if (table === "credentials") {
          yield* sql`INSERT INTO credentials (id,owner_user_id,name,key_enc,key_hint,created_at,updated_at)
            VALUES ('key','u','Synthetic',x'01','test',1,1)`
          yield* sql`INSERT INTO connections (id,owner_user_id,name,provider,kind,api,credential_id,created_at,updated_at)
            VALUES ('connection','u','Synthetic','openai','openai-chat','openai-completions','key',1,1)`
        }
        const token = yield* start
        yield* write("External", {}, sql.unsafe(statement))
        yield* refused(token, table === "plugin_data" || table === "credentials" ? "settings" : "changed")
      })
    )
  )
}

it.effect("an unrelated job id cannot exempt a history edit", () =>
  run(
    Effect.gen(function* () {
      const { sql, start, write, refused } = yield* setup
      const token = yield* start
      yield* write(
        "External",
        { jobId: "not-a-summary-job" },
        sql`UPDATE version_records SET content = 'External' WHERE id = 'v'`
      )
      yield* refused(token)
    })
  )
)

it.effect("expiry is enforced even when no new run is started", () =>
  run(
    Effect.gen(function* () {
      const { sql, start, refused } = yield* setup
      const token = yield* start
      yield* sql`UPDATE auto_guards SET at = 1`
      yield* refused(token, "expired")
    })
  )
)

it.effect("settings cannot hide in the same transaction as an own reply", () =>
  run(
    Effect.gen(function* () {
      const { sql, start, write, refused } = yield* setup
      const token = yield* start
      yield* write(
        "SaveGeneration",
        { versionId: "v" },
        Effect.gen(function* () {
          yield* sql`UPDATE version_records SET content = 'Own output' WHERE id = 'v'`
          yield* sql`INSERT INTO settings VALUES ('user','u','synthetic','{}',1,1)`
        })
      )
      yield* refused(token, "settings")
    })
  )
)

it.effect("a summary job exempts only summary rows, never a history edit", () =>
  run(
    Effect.gen(function* () {
      const { sql, start, write, refused } = yield* setup
      const token = yield* start
      yield* write(
        "CompleteSummary",
        { jobId: "summary-job" },
        sql`UPDATE version_records SET content = 'External' WHERE id = 'v'`
      )
      yield* refused(token)
    })
  )
)

it.effect("summary jobs survive, whereas a user's summary rewrite ends the run", () =>
  run(
    Effect.gen(function* () {
      const { sql, start, write, refused } = yield* setup
      const token = yield* start
      yield* write(
        "CompleteSummary",
        { jobId: "summary-job" },
        Effect.gen(function* () {
          yield* sql`INSERT INTO summary_revisions (id,summary_id,content,token_count,origin,created_at) VALUES ('rev','summary','Job summary',2,'generated',1)`
          yield* sql`INSERT INTO summaries (id,chat_id,level,selected_revision_id,first_slot_id,last_slot_id,slot_count,created_at)
      VALUES ('summary','chat',1,'rev','s','s',1,1)`
          yield* sql`INSERT INTO summary_inputs VALUES ('summary',0,'s','v',0)`
        })
      )
      yield* checkAutoTurn(sql, at, token)
      yield* write(
        "EditSummary",
        {},
        Effect.gen(function* () {
          yield* sql`INSERT INTO summary_revisions (id,summary_id,content,token_count,origin,created_at) VALUES ('user-rev','summary','User rewrite',2,'user',2)`
          yield* sql`INSERT INTO fork_overrides (id,chat_id,fork_id,seq,kind,target_id,slot_id,slot_depth,value_id)
          VALUES ('summary-edit','chat','chat',1,'summary_revision','summary','s',0,'user-rev')`
        })
      )
      yield* refused(token)
    })
  )
)

it.effect("own text and tool effects survive, workshop writes with the same rollout do not", () =>
  run(
    Effect.gen(function* () {
      const { sql, start, write, refused } = yield* setup
      yield* sql`INSERT INTO rollouts (id,chat_id,kind,status,slot_id,fork_id,role,request_class,created_at,updated_at)
    VALUES ('run','chat','generation','running','s','chat','narrator','interactive',1,1)`
      yield* sql`UPDATE versions SET rollout_id = 'run' WHERE id = 'v'`
      const token = yield* start
      yield* write("SaveGeneration", { versionId: "v" }, sql`UPDATE version_records SET content = 'Own' WHERE id = 'v'`)
      yield* write(
        "ApplyRolloutEffect",
        { rolloutId: "run" },
        sql`INSERT INTO state_events
    (id,chat_id,slot_id,version_id,seq,key,value_json,origin,created_at,fork_id,fork_seq)
    VALUES ('presence','chat','s','v',1,'away.set','{}','rollout',1,'chat',1)`
      )
      yield* checkAutoTurn(sql, at, token)
      yield* write(
        "ApplyWorkshopEffect",
        { rolloutId: "run" },
        sql`UPDATE version_records SET content = 'Workshop' WHERE id = 'v'`
      )
      yield* refused(token)
    })
  )
)

it.effect("an unselected alternative changes macro swipe counts and ends the run", () =>
  run(
    Effect.gen(function* () {
      const { sql, start, write, refused } = yield* setup
      const token = yield* start
      yield* write(
        "AddVersion",
        {},
        sql`INSERT INTO version_records (id,slot_id,ordinal,status,writer,content,macro_mode,origin,created_at,updated_at,authoring_fork_id)
    VALUES ('v2','s',1,'complete','human','Alternative','verbatim','user_written',1,1,'chat')`
      )
      yield* refused(token)
    })
  )
)

it.effect("tokens are confined to their account, chat, branch and run", () =>
  run(
    Effect.gen(function* () {
      const { start } = yield* setup
      const sql = yield* SqlClient.SqlClient
      const token = yield* start
      for (const other of [
        { ...at, userId: "other" },
        { ...at, chatId: "other" },
        { ...at, forkId: "other" }
      ]) {
        const error = yield* Effect.flip(checkAutoTurn(sql, other, token))
        assert.strictEqual(error._tag, "AutoRefused")
      }
      // A second Start in the same branch revokes the first tab, even with its correct nonce.
      yield* start
      const error = yield* Effect.flip(checkAutoTurn(sql, at, token))
      assert.strictEqual(error._tag, "AutoRefused")
    })
  )
)

for (const [label, statement, reason] of [
  ["chat title", "UPDATE chats SET title='Changed' WHERE id='chat'", "changed"],
  ["account role", "UPDATE users SET role='user' WHERE id='u'", "settings"],
  ["user setting", "INSERT INTO settings VALUES ('user','u','synthetic','{}',1,1)", "settings"],
  ["app setting", "INSERT INTO settings VALUES ('app','','synthetic','{}',1,1)", "settings"],
  ["library head", "UPDATE entity_refs SET head_revision_id='rev2' WHERE id='ref'", "settings"],
  ["library source name", "UPDATE entity_refs SET source_path='renamed.png' WHERE id='ref'", "settings"],
  ["library deletion", "UPDATE entities SET deleted_at=2 WHERE id='card'", "settings"],
  [
    "live library text",
    "INSERT INTO drafts (id,user_id,target_kind,target_id,field,content,updated_at) VALUES ('draft','u','entity_field','ref','description','Changed',1)",
    "settings"
  ],
  ["connection decision ordering", "UPDATE connections SET name='A different order' WHERE id='conn'", "settings"],
  ["connection credential binding", "UPDATE connections SET credential_id='key' WHERE id='conn'", "settings"],
  ["model overrides", "UPDATE models SET overrides_json='{\"temperature\":0.5}' WHERE id='model'", "settings"]
] as const) {
  it.effect(`captures ${label} independently of reply text`, () =>
    run(
      Effect.gen(function* () {
        const { sql, start, write, refused } = yield* setup
        yield* sql`INSERT INTO entities (id,owner_user_id,kind,created_at) VALUES ('card','u','card',1)`
        yield* sql`INSERT INTO entity_revisions (id,entity_id,doc_json,doc_hash,schema_version,origin,created_at)
      VALUES ('rev','card','{}','synthetic',1,'user',1), ('rev2','card','{}','synthetic2',1,'user',2)`
        yield* sql`INSERT INTO entity_refs (id,entity_id,head_revision_id,label,created_at,updated_at) VALUES ('ref','card','rev','Synthetic',1,1)`
        yield* sql`INSERT INTO credentials (id,owner_user_id,name,key_enc,key_hint,created_at,updated_at) VALUES ('key','u','Synthetic',x'01','test',1,1)`
        yield* sql`INSERT INTO connections (id,owner_user_id,name,provider,kind,api,created_at,updated_at) VALUES ('conn','u','Synthetic','openai','openai-chat','openai-completions',1,1)`
        yield* sql`INSERT INTO models (id,connection_id,model_key,source,created_at) VALUES ('model','conn','synthetic','user',1)`
        const token = yield* start
        yield* write("External", {}, sql.unsafe(statement))
        yield* refused(token, reason)
      })
    )
  )
}

it.effect("device settings and ordinary bookkeeping leave authorization intact", () =>
  run(
    Effect.gen(function* () {
      const { sql, start, write } = yield* setup
      const token = yield* start
      yield* write(
        "Bookkeeping",
        {},
        Effect.gen(function* () {
          yield* sql`INSERT INTO settings VALUES ('device','["u","synthetic"]','interface','{}',1,1)`
          yield* sql`UPDATE versions SET updated_at=2 WHERE id='v'`
          yield* sql`UPDATE chats SET last_message_at=2 WHERE id='chat'`
        })
      )
      yield* checkAutoTurn(sql, at, token)
    })
  )
)

// stack1115: both import writers insert their new versions before inserting the slots,
// and can preserve a local continuation rather than moving this run's fork tip.
for (const kind of ["new suffix", "alternative"] as const)
  it.effect(`imported ${kind} publication fences Auto even without moving the local tip`, () =>
    run(
      Effect.gen(function* () {
        const { sql, start, write, refused } = yield* setup
        const token = yield* start
        yield* write(
          "StImportCommitChat",
          {},
          Effect.gen(function* () {
            const slot = kind === "alternative" ? "s" : "imported-slot"
            yield* sql`INSERT INTO version_records (id,slot_id,ordinal,status,writer,content,macro_mode,origin,created_at,updated_at,authoring_fork_id)
          VALUES ('imported-version',${slot},${kind === "alternative" ? 1 : 0},'complete','model','Imported content','verbatim','imported',2,2,'chat')`
            if (kind === "new suffix")
              yield* sql`INSERT INTO slots (id,chat_id,fork_id,parent_slot_id,depth,selected_version_id,created_at)
            VALUES ('imported-slot','chat','chat','s',1,'imported-version',2)`
          })
        )
        yield* refused(token)
      })
    )
  )

it.effect("publishing imported content in another chat leaves the Auto handle valid", () =>
  run(
    Effect.gen(function* () {
      const { sql, start, write } = yield* setup
      yield* sql`INSERT INTO chats (id,owner_user_id,kind,status,created_at) VALUES ('other','u','rp','active',1)`
      const token = yield* start
      yield* write(
        "StImportCommitBatch",
        {},
        Effect.gen(function* () {
          yield* sql`INSERT INTO version_records (id,slot_id,ordinal,status,writer,content,macro_mode,origin,created_at,updated_at,authoring_fork_id)
        VALUES ('other-version','other-slot',0,'complete','model','Imported elsewhere','verbatim','imported',2,2,'other')`
          yield* sql`INSERT INTO slots (id,chat_id,fork_id,depth,selected_version_id,created_at)
        VALUES ('other-slot','other','other',0,'other-version',2)`
        })
      )
      yield* checkAutoTurn(sql, at, token)
    })
  )
)
