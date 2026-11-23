// ST's manual-summary pattern through the folder import by path (ARCHITECTURE.md §13
// "Imported summaries", §12 "Context membership", §15): long chats whose messages are hidden
// (`is_system`) up to where the Summarize extension's summary (`extra.memory`) ends. After the
// import the hidden messages stay hidden in the path read (what the timeline marks), the next
// request sends the summary in their place and leaves them out, and the next context says
// they're out because they're hidden, not cut for size (owner, 2026-11-23). Synthetic only.
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { assert, layer } from "@effect/vitest"
import { type ChatId, NewVersion, type SlotId } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import { databaseFile } from "../src/db/connection.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { card, encode, header, jsonl } from "./support/stFolder.ts"
import { importStPath } from "./support/stUpload.ts"
import { tempDir } from "./support/tempDir.ts"

const config = testConfig()
const at = (i: number) => new Date(Date.UTC(2025, 0, 1, 10, 0, 0, i)).toISOString()

interface Spec {
  /** The card (or the group's members, taking turns). */
  readonly names: ReadonlyArray<string>
  readonly count: number
  readonly hidden: (i: number) => boolean
  readonly memory?: (i: number) => string | undefined
  /** Every tenth card message has a second swipe. */
  readonly swipes?: boolean
  /** Each message's text, past its "<name> line <i>." opening. */
  readonly pad?: string
  readonly group?: boolean
}

const line = (spec: Spec, i: number) => {
  const user = i % 2 === 1
  const who = user ? "Sam" : spec.names[Math.floor(i / 2) % spec.names.length]!
  const text = `${who} line ${i}.${spec.pad ?? ""}`
  const swipes = spec.swipes && !user && i % 10 === 0 ? [text, `${who} line ${i}, again.`] : null
  const memory = spec.memory?.(i)
  return {
    name: who,
    is_user: user,
    is_system: spec.hidden(i),
    send_date: at(i),
    mes: text,
    ...(swipes ? { swipes, swipe_id: 0, swipe_info: swipes.map(() => ({ send_date: at(i), extra: {} })) } : {}),
    ...(spec.group && !user ? { original_avatar: `${who}.png` } : {}),
    extra: memory ? { memory } : {}
  }
}
const lines = (spec: Spec) => Array.from({ length: spec.count }, (_, i) => line(spec, i))

const upTo249 = (i: number) => i <= 249
// The summary on the last hidden message, with earlier ones before it.
const ann: Spec = {
  names: ["Ann"],
  count: 300,
  hidden: upTo249,
  memory: (i) => (i === 99 ? "Part one." : i === 199 ? "Parts one and two." : i === 249 ? "All up to 249." : undefined),
  swipes: true
}
const ANN_MAIN = "Ann - 2025-01-01@10h00m00s"
const annMain = lines(ann)
// A branch made at message 280, going elsewhere: its first 281 messages are the main's.
const annBranch = [
  ...annMain.slice(0, 281),
  ...Array.from({ length: 10 }, (_, k) => ({
    name: k % 2 === 0 ? "Sam" : "Ann",
    is_user: k % 2 === 0,
    is_system: false,
    send_date: at(281 + k),
    mes: `Branch line ${k}.`,
    extra: {}
  }))
]
// Summaries on later, unhidden messages; the latest at 270.
const ben: Spec = {
  names: ["Ben"],
  count: 300,
  hidden: upTo249,
  memory: (i) => (i === 120 ? "Up to 120." : i === 270 ? "All up to 270." : undefined)
}
// A hidden run that starts at 50.
const cat: Spec = {
  names: ["Cat"],
  count: 300,
  hidden: (i) => i >= 50 && i <= 249,
  memory: (i) => (i === 249 ? "From 50 to 249." : undefined)
}
const duo: Spec = {
  names: ["Dee", "Eve"],
  count: 300,
  hidden: upTo249,
  memory: (i) => (i === 249 ? "The duo so far." : undefined),
  group: true
}
// The owner's shape: 900 messages, the first 831 hidden, the summary on the last of them.
const fay: Spec = {
  names: ["Fay"],
  count: 900,
  hidden: (i) => i <= 830,
  memory: (i) => (i === 830 ? "Fay's story so far." : undefined)
}
// Hidden up to 249, then messages long enough that a small context cuts some of them too.
const gil: Spec = {
  names: ["Gil"],
  count: 300,
  hidden: upTo249,
  memory: (i) => (i === 249 ? "Gil's story so far." : undefined),
  pad: " The river ran loud below the bridge, and the lantern swung.".repeat(16)
}

const settings = {
  username: "Sam",
  user_avatar: "user.png",
  power_user: { personas: { "user.png": "Sam" }, persona_descriptions: {}, default_persona: "user.png" },
  // ST's default placement: after the main prompt.
  extension_settings: {
    memory: { position: 0, depth: 2, role: 0, template: "[Summary: {{summary}}]" },
    disabledExtensions: []
  }
}

const files: ReadonlyArray<readonly [string, Uint8Array]> = [
  ["settings.json", encode(settings)],
  ["characters/Ann.png", card("Ann", "Ann waves.", {}, {}, { chat: ANN_MAIN })],
  ...["Ben", "Cat", "Dee", "Eve", "Fay", "Gil"].map(
    (name) => [`characters/${name}.png`, card(name, "Hello.")] as const
  ),
  [`chats/Ann/${ANN_MAIN}.jsonl`, jsonl([header({}), ...annMain])],
  [`chats/Ann/${ANN_MAIN} - Branch #1.jsonl`, jsonl([header({ main_chat: ANN_MAIN }), ...annBranch])],
  ["chats/Ben/Ben - later.jsonl", jsonl([header({}), ...lines(ben)])],
  ["chats/Cat/Cat - middle.jsonl", jsonl([header({}), ...lines(cat)])],
  ["chats/Fay/Fay - long.jsonl", jsonl([header({}), ...lines(fay)])],
  ["chats/Gil/Gil - both.jsonl", jsonl([header({}), ...lines(gil)])],
  [
    "groups/g1.json",
    encode({ id: "g1", name: "Duo", members: ["Dee.png", "Eve.png"], chats: ["Duo - 2025"], chat_id: "Duo - 2025" })
  ],
  ["group chats/Duo - 2025.jsonl", jsonl([header({}), ...lines(duo)])]
]

const onDisk = () => {
  const root = tempDir("st-sumhidden")
  for (const [path, bytes] of files) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), bytes)
  }
  return root
}

/** The chat holding a message with this exact text. */
const chatWith = (text: string) => {
  const conn = new DatabaseSync(databaseFile(config.dataDir), { readOnly: true })
  const row = conn
    .prepare(
      `SELECT s.chat_id AS id FROM slots s JOIN version_records v ON v.slot_id = s.id WHERE v.content = ? LIMIT 1`
    )
    .get(text)
  conn.close()
  return row?.id as ChatId
}

const notesOf = (chatId: ChatId) => {
  const conn = new DatabaseSync(databaseFile(config.dataDir), { readOnly: true })
  const rows = conn
    .prepare(
      `SELECT h.doc_json FROM entities e JOIN entity_refs r ON r.entity_id = e.id JOIN entity_revisions h ON h.id = r.head_revision_id
       WHERE e.kind = 'note' AND json_extract(h.doc_json, '$.owner.chat') = ?`
    )
    .all(chatId)
  conn.close()
  return rows.map((row) => JSON.parse(row.doc_json as string) as Record<string, unknown>)
}

layer(serverLayer(config), { excludeTestServices: true, timeout: "240 seconds" })(
  "ST summaries over hidden messages (folder import)",
  (it) => {
    it.effect("keeps each hidden run hidden, sends the summary in its place, and says why in the next context", () =>
      Effect.gen(function* () {
        const api = yield* client()
        const userId = (yield* api.Whoami()).id
        // A model with a 1M window, so nothing in these chats is cut for size.
        const connection = yield* api.CreateConnection({
          kind: "openai-chat",
          settings: {
            name: "Wide",
            baseUrl: "http://127.0.0.1:9/v1",
            compat: {},
            cacheTtlS: null,
            maxConcurrent: null,
            presetOverrideRefId: null
          }
        })
        const wide = yield* api.AddUserModel({
          connectionId: connection.id,
          key: "wide",
          overrides: { context: 1_000_000 }
        })
        const narrow = yield* api.AddUserModel({
          connectionId: connection.id,
          key: "narrow",
          overrides: { context: 12_000 }
        })
        const useModel = (id: string) =>
          api.ChangeGenerationDefaults({ change: { model: { connection: connection.id, model: id as never } } })
        yield* useModel(wide.id)

        const { job, report } = yield* importStPath(api, onDisk())
        assert.strictEqual(job.status, "complete")
        const writer = yield* Writer
        const reader = yield* Reader

        const pathOf = (chatId: ChatId) =>
          Effect.map(
            api.ReadPath({ chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 500 }),
            (w) => w.entries
          )
        /** Every entry of the chat's current path, root first. */
        const wholePath = (chatId: ChatId) =>
          Effect.gen(function* () {
            let window = yield* api.ReadPath({ chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 500 })
            const all = [...window.entries]
            while (window.older !== null) {
              window = yield* api.ReadPath({
                chatId,
                leafSlotId: null,
                range: { _tag: "Older", from: window.entries[0]!.slotId },
                limit: 500
              })
              all.unshift(...window.entries.filter((e) => !all.some((had) => had.slotId === e.slotId)))
            }
            return all
          })
        const sentAfter = (chatId: ChatId, parentSlotId: SlotId) =>
          Effect.gen(function* () {
            const target = yield* writer.AppendMessage({
              userId,
              chatId,
              parentSlotId,
              branch: true,
              version: new NewVersion({
                speakerEntityId: null,
                writer: "model",
                content: "",
                status: "generating",
                macroMode: "verbatim",
                origin: "generated"
              }),
              commitDraft: null
            })
            const { snapshot } = yield* reader.AssembleContext({
              userId,
              chatId,
              slotId: target.slotId,
              versionId: target.version.id,
              now: Date.UTC(2026, 0, 1),
              timeZone: "UTC",
              frozen: null
            })
            return (JSON.parse(snapshot) as ContextSnapshot).request.messages.map((m) => m.content).join("\n")
          })
        const hiddenCount = (entries: ReadonlyArray<{ contextExcluded: boolean }>) =>
          entries.filter((e) => e.contextExcluded).length
        const summaryNote = (chatId: ChatId) => notesOf(chatId).find((n) => n.kind === "imported_summary")

        // Ann: the summary on the last hidden message. Hidden kept, offered (not applied) for
        // un-hiding, the note covers the run, and the request sends it without the run.
        const annId = chatWith("Ann line 0.")
        const annPath = yield* pathOf(annId)
        assert.strictEqual(hiddenCount(annPath), 250)
        assert.isTrue(annPath.slice(0, 250).every((e) => e.contextExcluded && !e.hiddenByUser))
        const annOffer = report!.hiddenRuns.find((run) => run.chatId === annId)!
        assert.deepStrictEqual([annOffer.hidden, annOffer.summaryCovers], [250, true])
        const annNote = summaryNote(annId)!
        assert.strictEqual(annNote.content, "All up to 249.")
        assert.strictEqual((annNote.covers as { slot_count: number }).slot_count, 250)
        const annSent = yield* sentAfter(annId, annPath.at(-1)!.slotId)
        assert.include(annSent, "[Summary: All up to 249.]")
        assert.notInclude(annSent, "Ann line 10.")
        assert.notInclude(annSent, "line 249.")
        assert.include(annSent, "line 250.")
        assert.include(annSent, "line 280.")
        // A swipe of a hidden message is hidden with it.
        assert.strictEqual(annPath[10]!.version.content, "Ann line 10.")
        // The branch shares the main's messages, hidden as in ST, and sends the same summary.
        let branchSeen = false
        for (const fork of yield* api.ListForks({ chatId: annId })) {
          const branch = (yield* api.ReadPath({
            chatId: annId,
            forkId: fork.id,
            leafSlotId: null,
            range: { _tag: "Bottom" },
            limit: 500
          })).entries
          if (branch.at(-1)?.version.content !== "Branch line 9.") continue
          branchSeen = true
          assert.strictEqual(hiddenCount(branch), 250)
          assert.strictEqual(branch[249]!.slotId, annPath[249]!.slotId)
          const sent = yield* sentAfter(annId, branch.at(-1)!.slotId)
          assert.include(sent, "[Summary: All up to 249.]")
          assert.notInclude(sent, "Ann line 10.")
          assert.include(sent, "Branch line 9.")
        }
        assert.isTrue(branchSeen)

        // Ben: summaries on later, unhidden messages; the latest (270) covers the run.
        const benId = chatWith("Ben line 0.")
        const benPath = yield* pathOf(benId)
        assert.strictEqual(hiddenCount(benPath), 250)
        const benSent = yield* sentAfter(benId, benPath.at(-1)!.slotId)
        assert.include(benSent, "[Summary: All up to 270.]")
        assert.notInclude(benSent, "Ben line 100.")
        assert.include(benSent, "line 251.")
        assert.isTrue(report!.hiddenRuns.find((run) => run.chatId === benId)!.summaryCovers === true)

        // Cat: a run from message 50 isn't offered for un-hiding; it stays hidden and the summary goes.
        const catId = chatWith("Cat line 0.")
        const catPath = yield* pathOf(catId)
        assert.strictEqual(hiddenCount(catPath), 200)
        assert.isUndefined(report!.hiddenRuns.find((run) => run.chatId === catId))
        const catSent = yield* sentAfter(catId, catPath.at(-1)!.slotId)
        assert.include(catSent, "[Summary: From 50 to 249.]")
        assert.include(catSent, "Cat line 0.")
        assert.notInclude(catSent, "Cat line 100.")

        // The group chat: the same.
        const duoId = chatWith("Dee line 0.")
        const duoPath = yield* pathOf(duoId)
        assert.strictEqual(hiddenCount(duoPath), 250)
        const duoSent = yield* sentAfter(duoId, duoPath.at(-1)!.slotId)
        assert.include(duoSent, "[Summary: The duo so far.]")
        assert.notInclude(duoSent, "Dee line 10.")
        assert.include(duoSent, "line 299.")

        // Fay, the owner's shape: 900 messages, the first 831 hidden, a 1M window. The next
        // context starts at #832 and says nothing was cut for size: the messages above it are
        // hidden, and the summary note goes in their place.
        const fayId = chatWith("Fay line 0.")
        const fayPath = yield* wholePath(fayId)
        assert.lengthOf(fayPath, 900)
        assert.strictEqual(hiddenCount(fayPath), 831)
        const fayNext = yield* api.GetNextContext({ chatId: fayId, leafSlotId: null })
        assert.isNull(fayNext.assemblyError ?? null)
        assert.strictEqual(fayNext.budget?.maximum, 1_000_000)
        assert.strictEqual(fayNext.historyStart?.depth, 831)
        assert.strictEqual(fayNext.historyStart?.cutThrough, null)
        assert.strictEqual(fayNext.historyStart?.hiddenBefore, 831)
        assert.deepStrictEqual(fayNext.summaryNotes, ["Summary (from ST)"])
        const faySent = yield* sentAfter(fayId, fayPath.at(-1)!.slotId)
        assert.include(faySent, "[Summary: Fay's story so far.]")
        assert.notInclude(faySent, "Fay line 830.")
        assert.include(faySent, "line 831.")

        // Gil, with a small context: the budget cuts some of the messages after the hidden run
        // too. The next context names the last one it cut, and the hidden run above the first.
        yield* useModel(narrow.id)
        const gilId = chatWith(`Gil line 0.${gil.pad}`)
        const gilNext = yield* api.GetNextContext({ chatId: gilId, leafSlotId: null })
        assert.isNull(gilNext.assemblyError ?? null)
        const gilStart = gilNext.historyStart!
        assert.isAbove(gilStart.depth, 251)
        assert.strictEqual(gilStart.cutThrough, gilStart.depth - 1)
        assert.strictEqual(gilStart.hiddenBefore, 250)
        assert.deepStrictEqual(gilNext.summaryNotes, ["Summary (from ST)"])
      })
    )
  }
)
