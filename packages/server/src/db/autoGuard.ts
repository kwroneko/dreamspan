// Auto replies' guard (ARCHITECTURE §15, Auto replies): an Auto turn is admitted only while
// nothing changed that its run didn't cause. A run is a row the writer keeps on its own
// connection (TEMP tables: nothing in the database file changes, and a restart ends every run):
// the branch it runs in, the reply its last turn wrote, and the token that turn handed back.
// TEMP triggers note what each write touched, as db/summaryValidity.ts does, and at the end of
// every write transaction the notes are settled against the live runs:
// - written by the run's own turn (the operation names its reply, or a rollout of it): nothing;
// - written by a summary job (the summaries the user turned on): nothing;
// - anything else that reaches the run's branch, or the configuration: the run is broken, for good.
// What reaches a branch:
// - a row the branch wrote for itself (an override, an event, its own row);
// - a message on its path, in the version it shows there;
// - anything the notes can't place (a chat-wide event, one changed in place, threads, a summary
//   edited by hand): every branch of the chat.
// The configuration is the user's settings, connections, models, the library's current
// revisions and the text being typed into an entry: a change to any breaks every run.
// So a turn costs one probe of an empty table when nothing was noted, whatever the chat's size;
// a foreign write to a message walks the branch's path once, down to that message's depth.
import { AutoRefused } from "@rp/shared/errors.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { selectedIn, shownIn } from "./forkState.ts"

const FORK = "fork"
const SLOT = "slot"
const VERSION = "version"
const CHAT = "chat"
const CONFIG = "config"
const LIBRARY = "library"
const SUMMARY = "summary"
const CALIBRATION = "calibration"

const liveIn = (chat: string) =>
  `EXISTS (SELECT 1 FROM auto_guards ag_ WHERE ag_.broken IS NULL AND ag_.chat_id = ${chat})`

/** Notes a touch of `chat` (SQL expressions), when `when` holds and a live run is in that chat. */
const touch = (kind: string, chat: string, ref = "NULL", when = "1") =>
  `INSERT INTO auto_touches (kind, chat_id, ref) SELECT '${kind}', ${chat}, ${ref} WHERE (${when}) AND ${liveIn(chat)};`

/** Notes a change of the configuration, when `when` holds and any run is live. */
const config = (when = "1", kind = CONFIG) =>
  `INSERT INTO auto_touches (kind) SELECT '${kind}' WHERE (${when})
    AND EXISTS (SELECT 1 FROM auto_guards ag_ WHERE ag_.broken IS NULL);`

const differs = (...columns: ReadonlyArray<string>) => columns.map((c) => `NEW.${c} IS NOT OLD.${c}`).join(" OR ")

const slotChat = (slot: string) => `(SELECT chat_id FROM slots WHERE id = ${slot})`
const splitChat = (split: string) => `(SELECT chat_id FROM thread_splits WHERE id = ${split})`
const summaryChat = (summary: string) => `(SELECT chat_id FROM summaries WHERE id = ${summary})`

const SLOT_COLUMNS = [
  "chat_id",
  "parent_slot_id",
  "depth",
  "selected_version_id",
  "context_excluded",
  "deleted_at",
  "purged_at",
  "inserted",
  "created_at"
]
const VERSION_COLUMNS = [
  "slot_id",
  "status",
  "speaker_entity_id",
  "macro_mode",
  "source_version_id",
  "deleted_at",
  "purged_at",
  "fork_id",
  "ordinal",
  "writer",
  "origin",
  "hidden",
  "created_at",
  "rollout_id"
]
const TEXT_COLUMNS = [
  "content",
  "context_form",
  "reasoning",
  "reply_sections",
  "frozen_macros",
  "cast_json",
  "presence_json",
  "direction"
]
const FORK_COLUMNS = ["parent_fork_id", "base_slot_id", "tip_slot_id", "deleted_at", "purged_at"]
const CONNECTION_COLUMNS = [
  "name",
  "credential_id",
  "headers_origin",
  "provider",
  "provider_settings_json",
  "kind",
  "api",
  "base_url",
  "headers_enc",
  "header_names_json",
  "compat_json",
  "cache_ttl_s",
  "proxy_mode",
  "proxy_url_enc",
  "preset_override_ref_id",
  "deleted_at",
  "purged_at"
]
const MODEL_COLUMNS = ["connection_id", "model_key", "upstream_json", "overrides_json", "hidden", "missing_since"]
/** Overrides that never change what's sent: a star, a version kept out of the picker. */
const UNSENT_OVERRIDES = `('star', 'picker_hide')`
/** The settings a request can read: the user's and the app's, never a device's own. */
const SENT_SCOPES = `('app', 'user')`
/** The drafts a request reads: text typed into a library entry (editorWrites.ts, CheckpointLiveText). */
const SENT_DRAFTS = `('entity_field')`

const trigger = (name: string, event: string, table: string, body: string, when?: string) =>
  `CREATE TEMP TRIGGER IF NOT EXISTS auto_touch_${name} AFTER ${event} ON main.${table}
    ${when === undefined ? "" : `WHEN ${when}`} BEGIN ${body} END`

const overrideTouch = (row: "NEW" | "OLD") =>
  `${touch(FORK, `${row}.chat_id`, `${row}.fork_id`, `${row}.kind NOT IN ('summary_revision', 'summary_choice', 'summary_superseded')`)}
   ${touch(SUMMARY, `${row}.chat_id`, `${row}.fork_id`, `${row}.kind IN ('summary_revision', 'summary_choice', 'summary_superseded')`)}`

const statements: ReadonlyArray<string> = [
  `CREATE TEMP TABLE IF NOT EXISTS auto_guards (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    fork_id TEXT NOT NULL,
    -- What its last turn handed back: the next turn must present exactly this.
    token TEXT NOT NULL,
    configuration TEXT NOT NULL DEFAULT '',
    turn INTEGER NOT NULL,
    -- The reply its last turn wrote: writes that name it, or a rollout of it, are the run's own.
    slot_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    -- 1: the chat has threads, whose branches read each other; every touch of the chat reaches it.
    wide INTEGER NOT NULL,
    -- Why it can't go on ('changed', 'settings'), and the operation that broke it.
    broken TEXT,
    cause TEXT,
    at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS temp.auto_guards_expiry ON auto_guards(at)`,
  `CREATE INDEX IF NOT EXISTS temp.auto_guards_version ON auto_guards(version_id)`,
  `CREATE INDEX IF NOT EXISTS temp.auto_guards_live ON auto_guards(chat_id) WHERE broken IS NULL`,
  `CREATE TEMP TABLE IF NOT EXISTS auto_touches (kind TEXT NOT NULL, chat_id TEXT, ref TEXT)`,
  // A new message is on no branch's path until a tip moves; an inserted one sits below its anchor.
  trigger("slot_insert", "INSERT", "slots", touch(SLOT, "NEW.chat_id", "NEW.parent_slot_id"), "NEW.inserted = 1"),
  // Imported suffixes can sit beside a local continuation without moving its tip. Versions
  // are inserted before their new slots, so version_insert cannot place them yet. Publication
  // of imported content ends every run in that chat; staging never writes either table.
  trigger(
    "import_slot",
    "INSERT",
    "slots",
    touch(CHAT, "NEW.chat_id"),
    "EXISTS (SELECT 1 FROM versions WHERE id = NEW.selected_version_id AND origin = 'imported')"
  ),
  trigger("import_version", "INSERT", "versions", touch(CHAT, slotChat("NEW.slot_id")), "NEW.origin = 'imported'"),
  trigger(
    "slot",
    `UPDATE OF ${SLOT_COLUMNS.join(", ")}`,
    "slots",
    `${touch(SLOT, "NEW.chat_id", "NEW.id")} ${touch(CHAT, "OLD.chat_id", "NULL", "OLD.chat_id IS NOT NEW.chat_id")}`,
    differs(...SLOT_COLUMNS)
  ),
  trigger("slot_delete", "DELETE", "slots", touch(CHAT, "OLD.chat_id")),
  // Even an unselected alternative changes lastSwipeId and the macro message projection.
  trigger(
    "version_insert",
    "INSERT",
    "versions",
    `${touch(SLOT, slotChat("NEW.slot_id"), "NEW.slot_id", "NEW.fork_id IS NULL")}
     ${touch(FORK, slotChat("NEW.slot_id"), "NEW.fork_id", "NEW.fork_id IS NOT NULL")}`
  ),
  trigger(
    "version",
    `UPDATE OF ${VERSION_COLUMNS.join(", ")}`,
    "versions",
    `${touch(VERSION, slotChat("NEW.slot_id"), "NEW.id")}
     ${touch(SLOT, slotChat("OLD.slot_id"), "OLD.slot_id", "OLD.slot_id IS NOT NEW.slot_id")}`,
    differs(...VERSION_COLUMNS)
  ),
  trigger(
    "version_delete",
    "DELETE",
    "versions",
    `${touch(SLOT, slotChat("OLD.slot_id"), "OLD.slot_id", "OLD.fork_id IS NULL")}
     ${touch(FORK, slotChat("OLD.slot_id"), "OLD.fork_id", "OLD.fork_id IS NOT NULL")}`
  ),
  `CREATE TEMP TRIGGER IF NOT EXISTS auto_touch_text AFTER UPDATE OF ${TEXT_COLUMNS.join(", ")} ON main.version_texts
    WHEN ${differs(...TEXT_COLUMNS)} BEGIN
      INSERT INTO auto_touches (kind, chat_id, ref)
        SELECT '${VERSION}', s.chat_id, v.id FROM versions v JOIN slots s ON s.id = v.slot_id
        WHERE v.seq = NEW.version_seq AND ${liveIn("s.chat_id")};
    END`,
  trigger("override_insert", "INSERT", "fork_overrides", overrideTouch("NEW"), `NEW.kind NOT IN ${UNSENT_OVERRIDES}`),
  trigger(
    "override_update",
    "UPDATE",
    "fork_overrides",
    `${overrideTouch("OLD")} ${overrideTouch("NEW")}`,
    `OLD.kind NOT IN ${UNSENT_OVERRIDES} OR NEW.kind NOT IN ${UNSENT_OVERRIDES}`
  ),
  trigger("override_delete", "DELETE", "fork_overrides", overrideTouch("OLD"), `OLD.kind NOT IN ${UNSENT_OVERRIDES}`),
  // An event a branch wrote is its own (and its later branches'); a shared one, or one changed
  // or removed in place, can be read anywhere in the chat.
  trigger(
    "event_insert",
    "INSERT",
    "state_events",
    `${touch(FORK, "NEW.chat_id", "NEW.fork_id", "NEW.fork_id IS NOT NULL")}
     ${touch(CHAT, "NEW.chat_id", "NULL", "NEW.fork_id IS NULL")}`
  ),
  trigger(
    "event_update",
    "UPDATE",
    "state_events",
    `${touch(CHAT, "OLD.chat_id")} ${touch(CHAT, "NEW.chat_id", "NULL", "OLD.chat_id IS NOT NEW.chat_id")}`
  ),
  trigger("event_delete", "DELETE", "state_events", touch(CHAT, "OLD.chat_id")),
  trigger(
    "fork",
    `UPDATE OF ${FORK_COLUMNS.join(", ")}`,
    "forks",
    touch(FORK, "NEW.chat_id", "NEW.id"),
    differs(...FORK_COLUMNS)
  ),
  trigger("fork_delete", "DELETE", "forks", touch(FORK, "OLD.chat_id", "OLD.id")),
  // A message or a reply another tab queued behind the run's reply posts when that reply ends,
  // in the reply's own transaction: the queueing is what the run didn't cause.
  trigger("queued", "INSERT", "queued_messages", touch(FORK, "NEW.chat_id", "NEW.fork_id")),
  ...(["INSERT", "UPDATE", "DELETE"] as const).flatMap((event) => {
    const row = event === "DELETE" ? "OLD" : "NEW"
    const name = event.toLowerCase()
    return [
      trigger(`split_${name}`, event, "thread_splits", touch(CHAT, `${row}.chat_id`)),
      trigger(`member_${name}`, event, "thread_members", touch(CHAT, splitChat(`${row}.split_id`))),
      trigger(`setting_${name}`, event, "settings", config(), `${row}.scope IN ${SENT_SCOPES}`),
      trigger(`draft_${name}`, event, "drafts", config("1", LIBRARY), `${row}.target_kind IN ${SENT_DRAFTS}`)
    ]
  }),
  // A summary's text or choice changed outside a summary job.
  trigger(
    "summary",
    "UPDATE OF selected_revision_id",
    "summaries",
    touch(SUMMARY, "NEW.chat_id"),
    differs("selected_revision_id")
  ),
  trigger(
    "summary_text",
    "UPDATE OF content",
    "summary_revisions",
    touch(SUMMARY, summaryChat("NEW.summary_id")),
    differs("content")
  ),
  trigger(
    "connection",
    `UPDATE OF ${CONNECTION_COLUMNS.join(", ")}`,
    "connections",
    config(),
    differs(...CONNECTION_COLUMNS)
  ),
  trigger("connection_delete", "DELETE", "connections", config()),
  trigger("model", `UPDATE OF ${MODEL_COLUMNS.join(", ")}`, "models", config(), differs(...MODEL_COLUMNS)),
  trigger("model_delete", "DELETE", "models", config()),
  // A new entry can be read at once: a chat's note names its chat itself (editorWrites.ts).
  trigger("ref_insert", "INSERT", "entity_refs", config("1", LIBRARY)),
  trigger("ref", "UPDATE OF head_revision_id", "entity_refs", config("1", LIBRARY), differs("head_revision_id")),
  trigger("ref_delete", "DELETE", "entity_refs", config("1", LIBRARY)),
  ...(["INSERT", "UPDATE", "DELETE"] as const).flatMap((event) => {
    const row = event === "DELETE" ? "OLD" : "NEW"
    const name = event.toLowerCase()
    const version = `(SELECT slot_id FROM versions WHERE id = ${row}.version_id)`
    return [
      trigger(`image_count_${name}`, event, "image_token_counts", config()),
      trigger(`image_sample_${name}`, event, "image_token_samples", config("1", CALIBRATION)),
      trigger(`plugin_${name}`, event, "plugin_data", config()),
      trigger(`credential_${name}`, event, "credentials", config()),
      trigger(
        `attachment_${name}`,
        event,
        "version_attachments",
        touch(VERSION, slotChat(version), `${row}.version_id`)
      ),
      trigger(`history_${name}`, event, "version_history", touch(VERSION, slotChat(version), `${row}.version_id`)),
      trigger(
        `merge_${name}`,
        event,
        "chat_merge_messages",
        touch(
          SLOT,
          `(SELECT chat_id FROM chat_merges WHERE id = ${row}.merge_id)`,
          `(SELECT slot_id FROM chat_merges WHERE id = ${row}.merge_id)`
        )
      ),
      trigger(`merge_join_${name}`, event, "chat_merges", touch(SLOT, `${row}.chat_id`, `${row}.slot_id`)),
      trigger(`summary_${name}`, event, "summaries", touch(SUMMARY, `${row}.chat_id`)),
      trigger(`summary_revision_${name}`, event, "summary_revisions", touch(SUMMARY, summaryChat(`${row}.summary_id`))),
      trigger(`summary_input_${name}`, event, "summary_inputs", touch(SUMMARY, summaryChat(`${row}.summary_id`))),
      trigger(`summary_parent_${name}`, event, "summary_parents", touch(SUMMARY, summaryChat(`${row}.summary_id`))),
      trigger(`summary_choice_${name}`, event, "lcm_summary_choices", touch(SUMMARY, summaryChat(`${row}.summary_id`))),
      trigger(
        `activation_${name}`,
        event,
        "lore_activations",
        touch(
          SLOT,
          `(SELECT chat_id FROM rollouts WHERE id = ${row}.rollout_id)`,
          `(SELECT slot_id FROM rollouts WHERE id = ${row}.rollout_id)`
        )
      ),
      trigger(`library_merge_${name}`, event, "library_merges", config("1", LIBRARY)),
      trigger(`media_${name}`, event, "media_assets", config())
    ]
  }),
  trigger(
    "user_sent",
    "UPDATE OF role, display_name, disabled_at",
    "users",
    config(),
    differs("role", "display_name", "disabled_at")
  ),
  trigger(
    "entity_sent",
    "UPDATE OF kind, archived_at, deleted_at, purged_at",
    "entities",
    config("1", LIBRARY),
    differs("kind", "archived_at", "deleted_at", "purged_at")
  ),
  trigger(
    "ref_sent",
    "UPDATE OF label, source_path",
    "entity_refs",
    config("1", LIBRARY),
    differs("label", "source_path")
  ),
  trigger(
    "chat_sent",
    "UPDATE OF title, kind, deleted_at",
    "chats",
    touch(CHAT, "NEW.id"),
    differs("title", "kind", "deleted_at")
  ),
  trigger("revision", "UPDATE OF doc_json", "entity_revisions", config("1", LIBRARY), differs("doc_json"))
]

/** Whether this thread's connection keeps runs: only the writer's does. */
let tracking = false

/** Who is writing: the operation the writer is serving, and what its input names. */
interface Actor {
  readonly operation: string
  readonly rolloutId: string | undefined
  readonly versionId: string | undefined
  readonly autoToken: string | undefined
  readonly status: string | undefined
  /** A summary job's write: the summaries the user turned on, never a change from outside. */
  readonly maintenance: boolean
}

let actor: Actor | null = null
let sweepAfter = 0

const named = (input: unknown, key: string) => {
  const value = typeof input === "object" && input !== null ? (input as Record<string, unknown>)[key] : undefined
  return typeof value === "string" ? value : undefined
}

/** Installs the runs and the notes on the writer's connection, once, after the migrations. */
export const trackAutoRuns = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    for (const statement of statements) yield* sql.unsafe(statement)
    tracking = true
  })

interface GuardRow {
  readonly id: string
  readonly user_id: string
  readonly chat_id: string
  readonly fork_id: string
  readonly configuration: string
  readonly token: string
  readonly slot_id: string
  readonly version_id: string
  readonly wide: number
  readonly broken: string | null
  readonly at: number
}

/** Whether `by`'s write belongs to the run's own turn: it names its reply, or a rollout of it. */
const own = (sql: SqlClient.SqlClient, guard: GuardRow, by: Actor) =>
  Effect.gen(function* () {
    if (by.operation === "FinishGeneration" && by.status !== "complete") return false
    const versionWrites = new Set([
      "StartRollout",
      "SaveGeneration",
      "FinishRollout",
      "FinishGeneration",
      "PickSpeaker",
      "SettleSpeaker",
      "ApplyDecisionEffect",
      "PostRolloutMessage"
    ])
    const rolloutWrites = new Set([
      "StartRollout",
      "FinishRollout",
      "ApplyRolloutEffect",
      "DeclareRolloutPresence",
      "PostRolloutMessage",
      "PickSpeaker",
      "ApplyDecisionEffect"
    ])
    if (by.operation === "RecordImageTokenSample" && by.autoToken === guard.token) return true
    // claimAutoTurn alone grants the admitting operation its placeholder, not other RPCs.
    if (by.operation === "SendOrQueue" && by.versionId === guard.version_id) return true
    if (versionWrites.has(by.operation) && by.versionId === guard.version_id) return true
    const rolloutId = rolloutWrites.has(by.operation) ? by.rolloutId : undefined
    const versionId = versionWrites.has(by.operation) ? by.versionId : undefined
    if (rolloutId === undefined && versionId === undefined) return false
    // The reply's rollout, one it started (a tool's, a subagent's), or a decision asked for it.
    const [row] = yield* sql<{ one: number }>`
      WITH RECURSIVE up(id, parent, kind, slot) AS (
        SELECT id, parent_rollout_id, kind, slot_id FROM rollouts WHERE id = coalesce(${rolloutId ?? null}, (SELECT rollout_id FROM versions WHERE id = ${versionId ?? null}))
        UNION ALL SELECT r.id, r.parent_rollout_id, r.kind, r.slot_id FROM up JOIN rollouts r ON r.id = up.parent
      )
      SELECT 1 AS one FROM up WHERE up.id = (SELECT rollout_id FROM versions WHERE id = ${guard.version_id})
        OR (up.kind = 'decision' AND up.slot = ${guard.slot_id}
          AND (SELECT fork_id FROM rollouts WHERE id = up.id) IS ${guard.fork_id}) LIMIT 1`
    return row !== undefined
  })

/** Why the noted touches end the run, or null: none of them reaches its branch or the configuration. */
const reached = (sql: SqlClient.SqlClient, guard: GuardRow) =>
  Effect.gen(function* () {
    const [direct] = yield* sql<{ config: number; chat: number }>`SELECT
      EXISTS (SELECT 1 FROM auto_touches WHERE kind IN (${CONFIG}, ${LIBRARY}, ${CALIBRATION})) AS config,
      EXISTS (SELECT 1 FROM auto_touches WHERE chat_id = ${guard.chat_id} AND (${guard.wide} = 1 OR kind IN (${CHAT}, ${SUMMARY})
        OR (kind = ${FORK} AND ref = ${guard.fork_id}))) AS chat`
    if (direct!.config === 1) return "settings" as const
    if (direct!.chat === 1) return "changed" as const
    const slotOf = sql.literal(
      `CASE t.kind WHEN '${SLOT}' THEN t.ref ELSE (SELECT slot_id FROM versions WHERE id = t.ref) END`
    )
    const [low] = yield* sql<{ depth: number | null; n: number }>`
      SELECT min(s.depth) AS depth, count(*) AS n FROM auto_touches t JOIN slots s ON s.id = ${slotOf}
      WHERE t.chat_id = ${guard.chat_id} AND t.kind IN (${SLOT}, ${VERSION})`
    if (!low || low.n === 0) return null
    // The branch's path from its tip down to the shallowest message touched, and no further.
    const [hit] = yield* sql<{ one: number }>`
      WITH RECURSIVE up(id, depth) AS (
        SELECT s.id, s.depth FROM forks f JOIN slots s ON s.id = f.tip_slot_id WHERE f.id = ${guard.fork_id}
        UNION ALL SELECT p.id, p.depth FROM up JOIN slots c ON c.id = up.id JOIN slots p ON p.id = c.parent_slot_id
        WHERE up.depth > ${low.depth ?? 0}
      )
      SELECT 1 AS one FROM auto_touches t JOIN slots s ON s.id = ${slotOf}
      WHERE t.chat_id = ${guard.chat_id} AND t.kind IN (${SLOT}, ${VERSION})
        AND (t.kind = ${SLOT} OR t.ref IN (${shownIn(sql, guard.fork_id, "s")}, ${selectedIn(sql, guard.fork_id, "s")}))
        -- An inserted message sits off the structural path: it counts wherever it is.
        AND (s.inserted = 1 OR s.id IN (SELECT id FROM up)) LIMIT 1`
    return hit === undefined ? null : ("changed" as const)
  })

/**
 * Settles the touches noted so far against the live runs and forgets them. Run inside the
 * write's transaction, at its end (`transaction` in tx.ts); `foreign`: the touches are of no
 * operation the writer can name, so they are nobody's own.
 */
export const settleAutoRuns = (sql: SqlClient.SqlClient, operation: string, foreign = false) =>
  Effect.gen(function* () {
    if (!tracking) return
    const now = Date.now()
    if (now >= sweepAfter) {
      yield* sql`DELETE FROM auto_guards WHERE at < ${now - KEPT_MS}`
      sweepAfter = now + 60_000
    }
    const [noted] = yield* sql<{ n: number }>`SELECT EXISTS (SELECT 1 FROM auto_touches) AS n`
    if (!noted || noted.n === 0) return
    const by = foreign ? null : actor
    if (by?.maintenance === true) yield* sql`DELETE FROM auto_touches WHERE kind = ${SUMMARY}`
    {
      const guards = yield* sql<GuardRow>`SELECT * FROM auto_guards WHERE broken IS NULL`
      for (const guard of guards) {
        // An own reply can write notes, but cannot authorize settings/key/plugin changes in
        // the same transaction. These always end the run.
        const [configuration] = yield* sql<{
          n: number
        }>`SELECT EXISTS (SELECT 1 FROM auto_touches WHERE kind = ${CONFIG}) AS n`
        if (configuration!.n === 0 && by !== null && (yield* own(sql, guard, by))) continue
        const reason = yield* reached(sql, guard)
        if (reason === null) continue
        yield* sql`UPDATE auto_guards SET broken = ${reason}, cause = ${by?.operation ?? operation} WHERE id = ${guard.id}`
        yield* Effect.logInfo(`auto replies ${guard.id} ended (${reason}) by ${by?.operation ?? operation}`)
      }
    }
    yield* sql`DELETE FROM auto_touches`
  })

/**
 * Capture the operation for its transaction's settlement, then clear it even on failure.
 * All supported writes settle inside their synchronous transaction; no probe or mutation
 * runs outside that transaction. The writer serves one operation at a time.
 */
export const attributed = <H extends object>(handlers: H): H =>
  Object.fromEntries(
    Object.entries(handlers).map(([operation, handler]) => [
      operation,
      (input: unknown, ...rest: ReadonlyArray<unknown>) =>
        Effect.suspend(() => {
          actor = {
            operation,
            rolloutId: named(input, "rolloutId"),
            versionId: named(input, "versionId"),
            autoToken: named(input, "autoToken"),
            status: named(input, "status"),
            maintenance: operation === "CompleteSummary" && named(input, "jobId") !== undefined
          }
          return (handler as (input: unknown, ...rest: ReadonlyArray<unknown>) => Effect.Effect<unknown, unknown>)(
            input,
            ...rest
          ).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                actor = null
              })
            )
          )
        })
    ])
  ) as H

const refused = (reason: "changed" | "settings" | "replayed" | "expired") => new AutoRefused({ reason })

/**
 * The run `token` names, if its next turn may start in `fork` now: AutoRefused otherwise, with
 * why (`expired`: the server knows no such run, as after a restart; `replayed`: the token isn't
 * the one its last turn handed back; `changed` or `settings`: something it didn't cause changed).
 */
export const checkAutoTurn = (
  sql: SqlClient.SqlClient,
  at: { readonly userId: string; readonly chatId: string; readonly forkId: string },
  token: string,
  configuration = ""
) =>
  Effect.gen(function* () {
    if (!tracking) return yield* refused("expired")
    const [guard] = yield* sql<GuardRow>`SELECT * FROM auto_guards WHERE id = ${token.split(".")[0] ?? ""}`
    if (!guard || guard.at < Date.now() - KEPT_MS) return yield* refused("expired")
    if (guard.token !== token) return yield* refused("replayed")
    if (guard.broken !== null) return yield* refused(guard.broken === "settings" ? "settings" : "changed")
    if (guard.configuration !== configuration) return yield* refused("settings")
    if (guard.user_id !== at.userId || guard.chat_id !== at.chatId || guard.fork_id !== at.forkId)
      return yield* refused("changed")
    return guard.id
  })

/** How long a run nobody continued is kept. */
const KEPT_MS = 24 * 60 * 60 * 1000

/**
 * A turn was admitted: its reply is the run's own from here, this transaction's writes included,
 * and the token for the turn after it is returned. `run` null: a new run, the user's Start,
 * replacing any in the same branch.
 */
export const claimAutoTurn = (
  sql: SqlClient.SqlClient,
  at: { readonly userId: string; readonly chatId: string; readonly forkId: string },
  run: string | null,
  reply: { readonly slotId: string; readonly versionId: string },
  configuration = ""
) =>
  Effect.gen(function* () {
    if (!tracking) return yield* refused("expired")
    const now = Date.now()
    const id = run ?? uuidv7()
    const token = `${id}.${crypto.randomUUID()}`
    if (run === null) {
      yield* sql`DELETE FROM auto_guards WHERE at < ${now - KEPT_MS}
        OR (user_id = ${at.userId} AND chat_id = ${at.chatId} AND fork_id = ${at.forkId})`
      yield* sql`INSERT INTO auto_guards (id, user_id, chat_id, fork_id, token, turn, slot_id, version_id, wide, at, configuration)
        SELECT ${id}, ${at.userId}, ${at.chatId}, ${at.forkId}, ${token}, 1, ${reply.slotId}, ${reply.versionId},
          EXISTS (SELECT 1 FROM thread_splits WHERE chat_id = ${at.chatId}), ${now}, ${configuration}`
    } else {
      yield* sql`UPDATE auto_guards SET token = ${token}, turn = turn + 1, slot_id = ${reply.slotId},
        version_id = ${reply.versionId}, at = ${now} WHERE id = ${id}`
    }
    // What this transaction wrote (the reply's placeholder, the tip) is the turn's own.
    if (actor !== null) actor = { ...actor, versionId: reply.versionId }
    return token
  })

/**
 * Refuses the request of an Auto turn whose run was broken after the turn was admitted: its
 * context was read after the change, so nothing of it may be sent.
 */
export const refuseBrokenTurn = (sql: SqlClient.SqlClient, versionId: string) =>
  Effect.gen(function* () {
    if (!tracking) return
    const [guard] = yield* sql<{ broken: string }>`
      SELECT broken FROM auto_guards WHERE version_id = ${versionId} AND broken IS NOT NULL`
    if (guard) return yield* refused(guard.broken === "settings" ? "settings" : "changed")
  })

/** Whether the reply being started at `slotId` is an Auto turn whose run was broken since (`refuseBrokenTurn`). */
export const brokenTurnAt = (sql: SqlClient.SqlClient, slotId: string) =>
  Effect.gen(function* () {
    if (!tracking) return false
    const [guard] = yield* sql<{ one: number }>`
      SELECT 1 AS one FROM auto_guards g JOIN versions v ON v.id = g.version_id
      WHERE g.slot_id = ${slotId} AND g.broken IS NOT NULL`
    return guard !== undefined
  })

/** Final dispatch boundary: explicit token survives a writer restart as a refusal, never an
 * unguarded request. Checked after all live reads and cache/concurrency waits, for every round. */
export const authorizeAutoRequest = (sql: SqlClient.SqlClient, userId: string, token: string, configuration: string) =>
  Effect.gen(function* () {
    if (!tracking) return yield* refused("expired")
    const [guard] = yield* sql<GuardRow>`SELECT * FROM auto_guards WHERE id = ${token.split(".")[0] ?? ""}`
    if (!guard) return yield* refused("expired")
    yield* checkAutoTurn(sql, { userId, chatId: guard.chat_id, forkId: guard.fork_id }, token, configuration)
  })
