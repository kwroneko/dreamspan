// A synthetic, owner-shaped library for the table-rebuild tests (test/tableRebuild.test.ts): chats
// with a long main path, many branches off it, 1 to `maxSwipes` swipes on model turns, selection
// and star overrides, state events, sealed summaries with their inputs, rollouts, usage-ledger rows
// (which point at chats and versions with ON DELETE SET NULL), chat pins and one reply still
// generating. Written on the test's own connection with foreign keys on, in one transaction.
import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export interface RebuildShape {
  /** Chats, the first of them `long`, the others `short` messages without branches. */
  readonly chats: number
  readonly long: number
  readonly short: number
  /** Branches of the long chat, each `branchLength` messages from a point on its main path. */
  readonly branches: number
  readonly branchLength: number
  readonly maxSwipes: number
}

const words = ["harbor", "lantern", "meadow", "quarry", "orchard", "beacon", "glacier", "willow"]
const text = (n: number, writer: "human" | "model") =>
  `${writer === "human" ? "The traveler asks" : "The guide answers"} about the ${words[n % words.length]} and the ${words[(n * 3 + 1) % words.length]}, turn ${n}.`

export const writeRebuildFixture = (shape: RebuildShape) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    let seq = 0
    let n = 0
    yield* sql`INSERT INTO users (id, handle, display_name, role, created_at) VALUES ('u', 'u', 'Owner', 'user', 0)`
    yield* sql`INSERT INTO connections (id, owner_user_id, name, provider, kind, api, created_at, updated_at)
      VALUES ('conn', 'u', 'Synthetic', 'anthropic', 'anthropic', 'anthropic-messages', 0, 0)`
    // One message: its versions (a human turn has one, a model turn 1 to maxSwipes), then its slot.
    const message = (chat: string, fork: string, id: string, parent: string | null, depth: number) =>
      Effect.gen(function* () {
        const writer = depth % 2 === 0 ? "human" : "model"
        const swipes = writer === "human" ? 1 : 1 + ((depth * 7 + fork.length) % shape.maxSwipes)
        for (let i = 0; i < swipes; i++)
          yield* sql`INSERT INTO version_records (id, slot_id, ordinal, status, writer, content, macro_mode, origin,
              created_at, updated_at, authoring_fork_id)
            VALUES (${`${id}-v${i}`}, ${id}, ${i}, 'complete', ${writer}, ${text(++n, writer)}, 'verbatim',
              ${writer === "human" ? "user_written" : "generated"}, 1, 1, ${fork})`
        yield* sql`INSERT INTO slots (id, chat_id, parent_slot_id, depth, selected_version_id, fork_id, inserted, created_at)
          VALUES (${id}, ${chat}, ${parent}, ${depth}, ${`${id}-v0`}, ${fork}, 0, 1)`
        if (swipes > 1)
          yield* sql`INSERT INTO fork_overrides (id, chat_id, fork_id, seq, kind, target_id, slot_id, slot_depth, value_id)
            VALUES (${`${id}-sel`}, ${chat}, ${fork}, ${++seq}, 'select', ${id}, ${id}, ${depth}, ${`${id}-v${swipes - 1}`})`
        if (depth % 7 === 3)
          yield* sql`INSERT INTO fork_overrides (id, chat_id, fork_id, seq, kind, target_id, slot_id, slot_depth, flag)
            VALUES (${`${id}-star`}, ${chat}, ${fork}, ${++seq}, 'star', ${`${id}-v0`}, ${id}, ${depth}, 1)`
        if (depth % 25 === 5)
          yield* sql`INSERT INTO state_events (id, chat_id, slot_id, seq, key, value_json, origin, fork_id, fork_seq, created_at)
            VALUES (${`${id}-ev`}, ${chat}, ${id}, ${++seq}, 'var.set', ${JSON.stringify({ name: `place${depth}`, value: fork })},
              'user', ${fork}, ${seq}, 1)`
        if (writer === "model" && depth % 10 === 1) {
          yield* sql`INSERT INTO rollouts (id, chat_id, kind, status, slot_id, role, request_class, created_at, updated_at)
            VALUES (${`${id}-r`}, ${chat}, 'reply', 'completed', ${id}, 'reply', 'interactive', 1, 1)`
          yield* sql`INSERT INTO llm_requests (id, owner_user_id, connection_id, chat_id, rollout_id, version_id, purpose,
              api, provider, model_key, status, started_at, ended_at)
            VALUES (${`${id}-q`}, 'u', 'conn', ${chat}, ${`${id}-r`}, ${`${id}-v0`}, 'reply', 'anthropic-messages',
              'anthropic', 'synthetic-model', 'complete', 1, 2)`
        }
        return id
      })

    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (let c = 0; c < shape.chats; c++) {
          const chat = `chat${c}`
          const length = c === 0 ? shape.long : shape.short
          // The chat's first fork is made by a trigger, under the chat's id.
          yield* sql`INSERT INTO chats (id, owner_user_id, kind, status, title, created_at)
            VALUES (${chat}, 'u', 'rp', 'active', ${`Synthetic chat ${c}`}, ${c})`
          const main: Array<string> = []
          for (let depth = 0; depth < length; depth++)
            main.push(yield* message(chat, chat, `${chat}-m${depth}`, main.at(-1) ?? null, depth))
          yield* sql`UPDATE forks SET tip_slot_id = ${main.at(-1)!} WHERE id = ${chat}`
          if (c % 3 === 0) yield* sql`INSERT INTO chat_pins (user_id, chat_id) VALUES ('u', ${chat})`
          if (c > 0) continue
          for (let b = 1; b <= shape.branches; b++) {
            const fork = `${chat}-f${b}`
            const baseDepth = (b * 37) % (length - 1)
            const base = main[baseDepth]!
            yield* sql`INSERT INTO forks (id, chat_id, parent_fork_id, base_slot_id, tip_slot_id, branched_at, created_at)
              VALUES (${fork}, ${chat}, ${chat}, ${base}, ${base}, ${++seq}, 1)`
            let parent = base
            for (let i = 1; i <= shape.branchLength; i++)
              parent = yield* message(chat, fork, `${fork}-m${i}`, parent, baseDepth + i)
            yield* sql`UPDATE forks SET tip_slot_id = ${parent} WHERE id = ${fork}`
          }
          // A reply still generating: kept out of the full-text index until it finishes.
          yield* sql`INSERT INTO version_records (id, slot_id, ordinal, status, writer, content, macro_mode, origin,
              created_at, updated_at, authoring_fork_id)
            VALUES (${`${main[1]!}-streaming`}, ${main[1]!}, 999, 'generating', 'model', 'The lantern flickers mid-sentence',
              'verbatim', 'generated', 1, 1, ${chat})`
          // Sealed level-one summaries over the main path, 50 messages each.
          for (let at = 0; at + 50 <= length; at += 50) {
            const id = `${chat}-sum${at}`
            yield* sql`INSERT INTO summary_revisions (id, summary_id, content, token_count, origin, created_at)
              VALUES (${`${id}-r`}, ${id}, 'The travelers continued their synthetic journey.', 10, 'generated', 1)`
            yield* sql`INSERT INTO summaries (id, chat_id, level, selected_revision_id, first_slot_id, last_slot_id, slot_count, status, created_at)
              VALUES (${id}, ${chat}, 1, ${`${id}-r`}, ${main[at]!}, ${main[at + 49]!}, 50, 'complete', 1)`
            for (let i = 0; i < 50; i++)
              yield* sql`INSERT INTO summary_inputs (summary_id, ordinal, slot_id, version_id, amend_count)
                VALUES (${id}, ${i}, ${main[at + i]!}, ${`${main[at + i]!}-v0`}, 0)`
            yield* sql`UPDATE summaries SET sealed = 1 WHERE id = ${id}`
          }
        }
        yield* sql`UPDATE chats SET current_fork_id = id, state_seq = ${seq}`
      })
    )
  })
