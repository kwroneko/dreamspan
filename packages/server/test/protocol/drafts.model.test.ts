// The draft protocol's invariants (ARCHITECTURE §3.10), checked by a randomized model:
// several tabs of one browser, each a real ComposerDraft and EditorStore (the client's own
// code, IndexedDB faked in memory), over a real server with its workers and sockets. Steps
// are drawn at random from what a user and the network can do: typing, saves on a timer,
// pages closing (keepalive) and reloading, going offline, sends and queued sends, branch
// switches and starts, messages appended below, undo and history, deleting to the bin and
// restoring, variants taking drafts along, and commits; every request may be held and
// delivered later in any order, lost before or after the server, or delivered twice.
//
// After every step the invariants are checked against the database and every tab:
// I1 every text typed and not removed by the user in a field that showed it is reachable:
//    in a field, a draft's history, the recovered texts, a message, queued entry or
//    revision, or (until it reaches the server) this browser's copies;
// I2 a commit commits exactly the text it names, and changes no other draft;
// I3 a save names the draft it was typed into;
// I4 a copy in this browser is deleted only when the server acknowledged exactly it, or a
//    newer copy of the same draft replaces it;
// I5 a write from a tab that sends text to the recovered texts says so, and the tab shows it.
// At the end everything is delivered and every tab reloaded: every text must then be on the
// server or in a field, and this browser must hold no copies.
//
// Seeded: DRAFT_MODEL_SEEDS (count, default 4) and DRAFT_MODEL_STEPS (default 150); a
// failing seed is shrunk to a short list of steps, printed with the requests each made.
// DRAFT_MODEL_SEED=<n> runs one seed.
import { DatabaseSync } from "node:sqlite"
import { assert, it } from "@effect/vitest"
import type { ChatId, SlotId } from "@rp/shared/chat.ts"
import { applyPatch, invertPatch } from "@rp/shared/drafts.ts"
import { getAt, textField } from "@rp/shared/editing.ts"
import type { RefId } from "@rp/shared/library.ts"
import { Cause, Deferred, Effect, Exit, Layer, Option, Stream } from "effect"
import { RpcClientError } from "effect/rpc"
import { type GenerationFailed, Generator } from "../../src/chat/Generator.ts"
import { databaseFile } from "../../src/db/connection.ts"
import { client, serverLayer, serverPort, testConfig } from "../support/config.ts"
import { type Completed, FakeIndexedDb } from "./fakeIndexedDb.ts"

const idb = new FakeIndexedDb()
globalThis.indexedDB = idb as unknown as IDBFactory
// Imported once IndexedDB is in place: backup.ts opens it on first use.
const { ComposerDraft } = await import("../../../client/src/features/chat/composerDraft.ts")
const { EditorStore } = await import("../../../client/src/features/editor/store.ts")
const { describeCause } = await import("../../../client/src/errors.ts")
type ComposerDraft = InstanceType<typeof ComposerDraft>
type EditorStore = InstanceType<typeof EditorStore>

const SEEDS = Number(process.env.DRAFT_MODEL_SEEDS ?? 4)
const STEPS = Number(process.env.DRAFT_MODEL_STEPS ?? 150)
const ONLY = process.env.DRAFT_MODEL_SEED
const TABS = Number(process.env.DRAFT_MODEL_TABS ?? 2)
/** The copies' user: the server runs in single-user mode. */
const USER = "model-user"
const FIELDS = [["content"], ["title"]] as const

// --- The server's generator: each reply waits until the model ends it.

const gates = new Map<string, Deferred.Deferred<void, GenerationFailed>>()
const gated = Layer.succeed(Generator)(
  Option.some({
    generate: (request) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void, GenerationFailed>()
          gates.set(request.versionId, gate)
          return Stream.concat(
            Stream.make("A line. "),
            Stream.fromEffect(Deferred.await(gate)).pipe(Stream.map(() => "The end."))
          )
        })
      )
  })
)

type Api = Effect.Success<ReturnType<typeof client>>
type AnyApi = Record<string, (payload: unknown) => Effect.Effect<unknown, unknown>>

const mulberry = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v
  )

const TOKEN = /#\d+#/g
const tokens = (text: string) => new Set(text.match(TOKEN) ?? [])

class Violation extends Error {}

// --- The network between the tabs and the server.

interface Request {
  readonly id: number
  readonly page: Page
  /** The editor that made it, if one did. */
  readonly store: EditorStore | null
  readonly tag: string
  readonly payload: unknown
  readonly keepalive: boolean
  /** The client hears nothing back: lost on the way, or the page is gone. */
  silent: boolean
  readonly answer: (outcome: Exit.Exit<unknown, unknown> | boolean) => void
}

const lost = () =>
  Exit.fail(
    new RpcClientError.RpcClientError({
      reason: new RpcClientError.RpcClientDefect({ message: "lost on the way", cause: null })
    })
  )

/** Requests that are retried or replayed by design, so delivering one twice is the network's doing. */
const REPEATABLE = new Set(["SaveComposer", "SaveEditorDraft", "keepalive"])

class Net {
  ready: Array<Request> = []
  held: Array<Request> = []
  private pumping: Promise<void> | null = null
  private next = 0
  /** Every request goes through, as the run drains at the end. */
  reliable = false
  private readonly world: World

  constructor(world: World) {
    this.world = world
  }

  get busy() {
    return this.ready.length > 0 || this.pumping !== null
  }

  send(page: Page, tag: string, payload: unknown, keepalive: boolean, store: EditorStore | null = null) {
    return new Promise<Exit.Exit<unknown, unknown> | boolean>((resolve) => {
      const request: Request = {
        id: this.next++,
        page,
        store,
        tag,
        payload,
        keepalive,
        silent: false,
        answer: (outcome) => {
          if (answered) return
          answered = true
          page.outstanding--
          if (page.alive) resolve(outcome)
        }
      }
      let answered = false
      page.outstanding++
      this.world.checkRequest(request)
      const fail = () => request.answer(keepalive ? false : lost())
      if (page.tab.offline) {
        this.world.log(`  r${request.id} ${tag} from tab ${page.tab.id}: offline`)
        return fail()
      }
      const roll = this.reliable ? 0 : this.world.rng()
      const repeatable = REPEATABLE.has(tag)
      // Reads mostly go through; writes are held more, so typing meets them on their way.
      const now = tag.startsWith("Open") || tag.endsWith("History") ? 0.75 : 0.5
      const how = roll < now ? "now" : roll < 0.8 ? "held" : roll < 0.87 ? "lost" : roll < 0.94 ? "reply lost" : "twice"
      const policy = how === "twice" && !repeatable ? "now" : how
      this.world.log(`  r${request.id} ${tag} from tab ${page.tab.id}: ${policy}`)
      if (policy === "lost") return fail()
      if (policy === "held") return void this.held.push(request)
      if (policy === "reply lost") {
        fail()
        request.silent = true
      }
      this.ready.push(request)
      if (policy === "twice") this.held.push({ ...request, id: this.next++, silent: true })
    })
  }

  /** A held request goes on: delivered, delivered with its reply lost, or lost. */
  release(rng: () => number) {
    if (this.held.length === 0) return null
    const [request] = this.held.splice(Math.floor(rng() * this.held.length), 1)
    const roll = rng()
    if (roll < 0.1) {
      request!.answer(request!.keepalive ? false : lost())
      return `r${request!.id} lost`
    }
    if (roll < 0.2 && !request!.silent) {
      request!.answer(request!.keepalive ? false : lost())
      request!.silent = true
      this.ready.push(request!)
      return `r${request!.id} delivered, reply lost`
    }
    this.ready.push(request!)
    return `r${request!.id} delivered`
  }

  /** A page went: its RPCs still on their way may reach the server or not; its keepalives do. */
  pageGone(page: Page, rng: () => number) {
    const keep = (request: Request) => request.page !== page || request.keepalive || rng() < 0.5
    this.ready = this.ready.filter(keep)
    this.held = this.held.filter(keep)
  }

  async drain() {
    this.pumping ??= (async () => {
      while (this.ready.length > 0) await this.world.deliver(this.ready.shift()!)
    })().finally(() => {
      this.pumping = null
    })
    await this.pumping
  }
}

// --- The tabs.

interface Tab {
  readonly id: number
  offline: boolean
  page: Page
}

class Page {
  alive = true
  /** Requests this page made that haven't been answered. */
  outstanding = 0
  readonly timers = new Map<number, () => void>()
  private nextTimer = 0
  readonly composer: ComposerDraft
  editor: EditorStore
  ref: RefId
  tip: SlotId | null
  /** The view follows the chat's active leaf as messages are appended. */
  follows: boolean

  /** The page's timers wait for the model to fire them; its keepalives go through the network. */
  private readonly env = {
    setTimer: (run: () => void) => {
      const id = this.nextTimer++
      this.timers.set(id, run)
      return id
    },
    clearTimer: (timer: unknown) => void this.timers.delete(timer as number),
    now: () => this.world.now(),
    keepalive: (_path: string, body: string) =>
      this.world.net.send(this, "keepalive", JSON.parse(body), true) as Promise<boolean>
  }

  readonly world: World
  readonly tab: Tab

  constructor(world: World, tab: Tab, ref: RefId, tip: SlotId | null, follows: boolean) {
    this.world = world
    this.tab = tab
    const session = { id: world.chatId, call: (rpc: Rpc) => this.call(rpc) }
    this.composer = new ComposerDraft(session as never, USER, "", this.env)
    this.ref = ref
    this.editor = this.store(ref)
    this.tip = tip
    this.follows = follows
    this.composer.setTip(tip, false, false)
    void this.editor.load()
  }

  /** An editor's store, its requests marked as its own. */
  private store(ref: RefId): EditorStore {
    const store: EditorStore = new EditorStore(ref, USER, (rpc) => this.callEditor(rpc, store) as never, this.env)
    return store
  }

  private async run(rpc: Rpc, store: EditorStore | null) {
    const client = (tag: string, payload: unknown) =>
      Effect.flatMap(
        Effect.promise(() => this.world.net.send(this, tag, payload, false, store)),
        (exit) => exit as Exit.Exit<unknown, unknown>
      )
    return Effect.runPromiseExit(rpc(client as never) as Effect.Effect<unknown, unknown>)
  }

  async call(rpc: Rpc) {
    const exit = await this.run(rpc, null)
    return Exit.isSuccess(exit)
      ? { ok: true as const, value: exit.value }
      : { ok: false as const, error: describeCause(exit.cause) }
  }

  async callEditor(rpc: Rpc, store: EditorStore = this.editor) {
    const exit = await this.run(rpc, store)
    return Exit.isSuccess(exit)
      ? { ok: true as const, value: exit.value }
      : { ok: false as const, error: describeCause(exit.cause), cause: Cause.squash(exit.cause) }
  }

  /** Another entry in the editor: the store goes as a page's would, saving what's typed. */
  openRef(ref: RefId) {
    void this.editor.flush()
    this.ref = ref
    this.editor = this.store(ref)
    void this.editor.load()
  }

  go(tip: SlotId | null, appended: boolean, branch: boolean) {
    this.tip = tip
    this.composer.setTip(tip, appended, branch)
  }
}

type Rpc = (client: never) => unknown

// --- The world: the server, the tabs and what the model knows.

interface Step {
  readonly index: number
  readonly seed: number
}

class World {
  rng: () => number = Math.random
  readonly net = new Net(this)
  readonly tabs: Array<Tab> = []
  /** Tokens typed and not removed by the user in a field that showed them. */
  readonly live = new Set<string>()
  /**
   * What a tab showed as the user picked an earlier state to restore, by tab and state: the
   * restore removes what's not in that state, once the server makes it, heard back or not.
   */
  readonly picked = new Map<string, string>()
  /** Canonical payloads the server answered for: the copies a client may delete. */
  readonly acked = new Set<string>()
  readonly lines: Array<string> = []
  /** The pages' clock: it moves on with every reading, so copies made in a run are ordered. */
  private clock = Date.now()
  private token = 0
  chatId!: ChatId
  noteRef!: RefId
  refs: Array<RefId> = []
  /** The server's own work a step started (another device's writes, a reply ending). */
  background: Array<Promise<unknown>> = []
  /** A violation found where it can't be thrown (as IndexedDB completes). */
  pending: Violation | null = null

  readonly api: Api
  readonly port: number
  readonly db: DatabaseSync

  constructor(api: Api, port: number, db: DatabaseSync) {
    this.api = api
    this.port = port
    this.db = db
  }

  log(line: string) {
    this.lines.push(line)
  }

  now() {
    return this.clock++
  }

  /** Time passes: copies made before are stale now. */
  wait(ms: number) {
    this.clock += ms
  }

  /** A write another device makes, which the step waits for. */
  later(write: Effect.Effect<unknown, unknown>) {
    this.background.push(Effect.runPromise(Effect.ignore(write)))
  }

  newToken() {
    const token = `#${this.token++}#`
    this.live.add(token)
    return token
  }

  /** The user removed these from a field that showed them. */
  removed(before: string, after: string) {
    for (const token of tokens(before)) if (!after.includes(token)) this.live.delete(token)
  }

  fail(message: string): never {
    throw new Violation(message)
  }

  // --- Database reads (a read-only connection on the server's file).

  all<T>(query: string, ...params: Array<string | number | null>) {
    return this.db.prepare(query).all(...params) as Array<T>
  }

  leaf() {
    return this.all<{ leaf: SlotId | null }>(
      `SELECT active_leaf_slot_id AS leaf FROM chats WHERE id = ?`,
      this.chatId
    )[0]!.leaf
  }

  liveSlots() {
    return this.all<{ id: SlotId; parent: SlotId | null }>(
      `SELECT id, parent_slot_id AS parent FROM slots WHERE chat_id = ? AND deleted_at IS NULL ORDER BY rowid`,
      this.chatId
    )
  }

  tipsOf() {
    const slots = this.liveSlots()
    const parents = new Set(slots.map((slot) => slot.parent))
    return slots.filter((slot) => !parents.has(slot.id)).map((slot) => slot.id)
  }

  recoveredCount() {
    return this.all<{ n: number }>(`SELECT count(*) AS n FROM recovered_texts`)[0]!.n
  }

  drafts() {
    return this.all<{ id: string; content: string; session: number; status: string }>(
      `SELECT id, content, session, status FROM drafts`
    )
  }

  // --- Requests, checked as they're made and as they're delivered.

  checkRequest(request: Request) {
    const payload = request.payload as Record<string, unknown>
    // I3: a save names the draft it was typed into.
    const fieldSaves =
      request.tag === "SaveEditorDraft"
        ? [payload]
        : request.keepalive
          ? (payload.drafts as Array<Record<string, unknown>>)
          : []
    for (const save of fieldSaves) {
      if (save.expectedRowVersion !== null && typeof save.draftId !== "string")
        this.fail(`I3: a field save names no draft: ${canonical(save)}`)
    }
    if (request.tag === "CommitEditorDrafts") {
      const store = request.store!
      commitStores.set(request, store)
      // I2: what the revision must hold is what the fields show as the commit leaves.
      const shown = new Map<string, string>()
      for (const { field } of payload.fields as Array<{ field: string }>) {
        const path = FIELDS.find((f) => textField(f) === field)
        if (path !== undefined) shown.set(field, store.text(path))
      }
      commitsShown.set(request, shown)
    }
  }

  async deliver(request: Request) {
    const payload = request.payload as Record<string, unknown>
    const recoveredBefore = this.recoveredCount()
    const draftsBefore = new Map(this.drafts().map((d) => [d.id, d]))
    let outcome: Exit.Exit<unknown, unknown> | boolean
    if (request.keepalive) {
      const response = await fetch(`http://127.0.0.1:${this.port}/library/drafts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      })
      outcome = response.ok
      if (response.ok) {
        for (const save of [...(payload.drafts as Array<unknown>), ...((payload.composers as Array<unknown>) ?? [])])
          this.acked.add(canonical(save))
      }
    } else {
      outcome = await Effect.runPromiseExit((this.api as unknown as AnyApi)[request.tag]!(payload))
      if (Exit.isSuccess(outcome) && (request.tag === "SaveComposer" || request.tag === "SaveEditorDraft"))
        this.acked.add(canonical(payload))
    }
    const ok = typeof outcome === "boolean" ? outcome : Exit.isSuccess(outcome)
    if (ok && typeof outcome !== "boolean" && Exit.isSuccess(outcome) && request.tag.startsWith("Restore")) {
      const seen = this.picked.get(`${request.page.tab.id} ${payload.seq as number}`)
      if (seen !== undefined) this.removed(seen, (outcome.value as { content: string }).content)
    }
    this.log(`  r${request.id} ${request.tag} delivered: ${ok ? "ok" : "failed"}${request.silent ? " (no reply)" : ""}`)
    if (process.env.DRAFT_MODEL_DEBUG !== undefined) {
      const short = (value: unknown) =>
        JSON.stringify(value)
          ?.replace(/"[0-9a-f-]{30}([0-9a-f]{6})"/g, "$1")
          .slice(0, 400)
      this.log(`      ${short(payload)}`)
      this.log(
        `      → ${typeof outcome === "boolean" ? outcome : short(Exit.isSuccess(outcome) ? outcome.value : String(outcome.cause))}`
      )
    }
    if (ok && typeof outcome !== "boolean" && Exit.isSuccess(outcome)) {
      this.checkCommit(request, draftsBefore, outcome.value as Record<string, unknown>)
      this.checkRecovered(request, recoveredBefore, outcome.value as Record<string, unknown>)
    }
    request.answer(outcome)
  }

  /** I2: a commit ends only the draft it names, holding exactly the text it names. */
  private checkCommit(request: Request, before: Map<string, Draft>, value: Record<string, unknown>) {
    const payload = request.payload as Record<string, unknown>
    const named = new Set<string>()
    if ((request.tag === "SendMessage" || request.tag === "Generate") && payload.composer !== undefined) {
      const composer = payload.composer as { draftId: string; session: number; text: string }
      named.add(composer.draftId)
      const was = before.get(composer.draftId)
      const now = this.drafts().find((d) => d.id === composer.draftId)
      if (was !== undefined && now !== undefined && now.session !== was.session && was.content !== composer.text)
        this.fail(`I2: a send of ${JSON.stringify(composer.text)} committed ${JSON.stringify(was.content)}`)
    } else if (request.tag === "CommitEditorDrafts") {
      for (const { draftId } of payload.fields as Array<{ draftId: string }>) named.add(draftId)
      const shown = commitsShown.get(request)!
      const [head] = this.all<{ doc: string }>(
        `SELECT r.doc_json AS doc FROM entity_refs f JOIN entity_revisions r ON r.id = f.head_revision_id WHERE f.id = ?`,
        payload.refId as string
      )
      const doc = JSON.parse(head!.doc) as Record<string, unknown>
      for (const [field, text] of shown) {
        const path = FIELDS.find((f) => textField(f) === field)!
        if (getAt(doc, [...path]) !== text)
          this.fail(
            `I2: the revision holds ${JSON.stringify(getAt(doc, [...path]))} where the field showed ${JSON.stringify(text)}`
          )
      }
      void value
    } else return
    for (const now of this.drafts()) {
      const was = before.get(now.id)
      if (was === undefined || named.has(now.id)) continue
      if (was.content !== now.content || was.session !== now.session)
        this.fail(
          `I2: ${request.tag} changed another draft (${JSON.stringify(was.content)} → ${JSON.stringify(now.content)})`
        )
    }
  }

  /** I5: a tab's write that put text in the recovered texts says so, and the tab shows it. */
  private checkRecovered(request: Request, before: number, value: Record<string, unknown>) {
    if (this.recoveredCount() === before) return
    const says =
      request.tag === "SaveComposer"
        ? value.recovered === true
        : request.tag === "SendMessage" || request.tag === "Generate" || request.tag === "CommitEditorDrafts"
          ? (value.recovered as number) > 0 || ((value.setAside as Array<unknown> | undefined)?.length ?? 0) > 0
          : null
    if (says === false) this.fail(`I5: ${request.tag} sent text to the recovered texts without saying so`)
    if (says && !request.silent && request.page.alive) {
      if (request.tag === "CommitEditorDrafts") expectEditorNotice.add(commitStores.get(request)!)
      else expectComposerNotice.add(request.page)
    }
  }

  // --- Invariants over the whole world.

  /** Every text the server keeps where the user can reach it, a draft's every state included. */
  serverTexts() {
    const texts: Array<string> = []
    const history = this.all<{ draft: string; start: number; removed: string; inserted: string }>(
      `SELECT draft_id AS draft, start, removed, inserted FROM draft_history ORDER BY draft_id, seq DESC`
    )
    for (const draft of this.all<{ id: string; content: string }>(`SELECT id, content FROM drafts`)) {
      let text = draft.content
      texts.push(text)
      for (const entry of history.filter((h) => h.draft === draft.id)) {
        text = applyPatch(text, invertPatch(entry))
        texts.push(text)
      }
    }
    for (const row of this.all<{ t: string | null }>(`SELECT content AS t FROM recovered_texts`))
      texts.push(row.t ?? "")
    for (const row of this.all<{ c: string; d: string | null }>(`SELECT content AS c, direction AS d FROM versions`))
      texts.push(row.c, row.d ?? "")
    for (const row of this.all<{ c: string; d: string | null }>(
      `SELECT content AS c, direction AS d FROM queued_messages`
    ))
      texts.push(row.c, row.d ?? "")
    for (const row of this.all<{ d: string }>(`SELECT doc_json AS d FROM entity_revisions`)) texts.push(row.d)
    return texts
  }

  shownTexts() {
    return this.tabs.flatMap(({ page }) => [
      page.composer.snapshot().text,
      ...FIELDS.map((path) => (page.editor.snapshot === null ? "" : page.editor.text(path)))
    ])
  }

  /** The state after a step, for reading a trace. */
  dump() {
    for (const { id, page } of this.tabs) {
      const base = (page.composer as unknown as { base: { id: string; rowVersion: number; session: number } | null })
        .base
      this.log(
        `    tab ${id} composer ${JSON.stringify(page.composer.snapshot().text)} on ${base?.id.slice(-6)}@${base?.rowVersion}/${base?.session} tip ${page.tip?.slice(-6)}`
      )
    }
    for (const d of this.all<{ id: string; field: string; content: string; v: number; s: number; st: string }>(
      `SELECT id, field, content, row_version AS v, session AS s, status AS st FROM drafts WHERE target_kind = 'composer'`
    ))
      this.log(
        `    draft ${d.id.slice(-6)} at ${d.field.slice(-6)}: ${JSON.stringify(d.content)} v${d.v} s${d.s} ${d.st}`
      )
    this.log(
      `    copies: ${idb
        .values()
        .map((c) => JSON.stringify(c.content))
        .join(", ")}`
    )
  }

  check(withCopies: boolean) {
    if (this.pending !== null) throw this.pending
    const haystack = [
      ...this.serverTexts(),
      ...this.shownTexts(),
      ...(withCopies ? idb.values().map((copy) => String(copy.content)) : [])
    ].join("\u0000")
    const missing = [...this.live].filter((token) => !haystack.includes(token))
    if (missing.length > 0) this.fail(`I1: typed text is nowhere: ${missing.join(" ")}`)
    // A page shows what came back once it has heard everything it asked.
    for (const page of expectComposerNotice) {
      if (!page.alive) expectComposerNotice.delete(page)
      else if (page.outstanding === 0 && page.composer.snapshot().ready) {
        if (!page.composer.snapshot().recovered)
          this.fail(`I5: tab ${page.tab.id}'s composer doesn't say text went to the recovered texts`)
        expectComposerNotice.delete(page)
      }
    }
    for (const store of expectEditorNotice) {
      if (store.state().recovered === 0) this.fail(`I5: the editor doesn't say text went to the recovered texts`)
    }
    expectEditorNotice.clear()
  }

  /** I4: a copy goes only once acknowledged, or replaced by a newer copy of the same draft typed from it. */
  completed({ put, deleted }: Completed) {
    for (const copy of deleted) {
      const save = copy.save as { kind: string; payload: Record<string, unknown> } | undefined
      if (save !== undefined && this.acked.has(canonical(save.payload))) continue
      // The same draft: a composer's copies are filed under its id, a field's under the
      // field (whose draft may have changed: moved to a variant, a new one started).
      const same = (other: Record<string, unknown>) =>
        other.key !== copy.key &&
        other.refId === copy.refId &&
        other.field === copy.field &&
        String(other.key) > String(copy.key)
      if (put.some(same) || idb.values().some(same)) continue
      this.fail(`I4: a copy was deleted unacknowledged: ${JSON.stringify(copy.content)}`)
    }
  }
}

type Draft = { id: string; content: string; session: number; status: string }
const commitsShown = new WeakMap<Request, Map<string, string>>()
const commitStores = new WeakMap<Request, EditorStore>()
const expectComposerNotice = new Set<Page>()
const expectEditorNotice = new Set<EditorStore>()

// --- What happens in a step.

const pick = <A>(rng: () => number, items: ReadonlyArray<A>) => items[Math.floor(rng() * items.length)]
/** Mostly the one field, so tabs meet on it. */
const field = (w: World) => (w.rng() < 0.8 ? FIELDS[0] : FIELDS[1])

/** A user's edit of a field's text: a word added, a word removed, or everything replaced. */
const edit = (w: World, before: string) => {
  const roll = w.rng()
  const words = [...tokens(before)]
  if (roll < 0.15 && words.length > 0) return before.replace(` ${pick(w.rng, words)!}`, "")
  if (roll < 0.22) return ` ${w.newToken()}`
  if (roll < 0.25) return ""
  return `${before} ${w.newToken()}`
}

type Op = { readonly name: string; readonly weight: number; readonly run: (w: World, tab: Tab) => string | null }

const OPS: ReadonlyArray<Op> = [
  {
    name: "type in the composer",
    weight: 14,
    run: (w, { page }) => {
      const { text, ready } = page.composer.snapshot()
      if (!ready) return null
      const after = edit(w, text)
      w.removed(text, after)
      page.composer.type(after)
      return JSON.stringify(after)
    }
  },
  {
    name: "type in the editor",
    weight: 12,
    run: (w, { page }) => {
      if (page.editor.snapshot === null) return null
      const path = field(w)
      const text = page.editor.text(path)
      const after = edit(w, text)
      w.removed(text, after)
      page.editor.setText(path, after)
      return `${path.join(".")} ${JSON.stringify(after)}`
    }
  },
  {
    name: "a save timer fires",
    weight: 12,
    run: (_, { page }) => {
      const [id, timer] = [...page.timers][0] ?? []
      if (id === undefined) return null
      page.timers.delete(id)
      timer!()
      return `timer ${id}`
    }
  },
  { name: "a held request goes on", weight: 12, run: (w) => w.net.release(w.rng) },
  {
    name: "send",
    weight: 6,
    run: (w, { page }) => {
      const { text, ready } = page.composer.snapshot()
      const generate = w.rng() < 0.3
      if (!ready || (!generate && text.trim() === "")) return null
      void page.composer.submit(async (from) => {
        // The view went to another branch since: Composer.tsx doesn't send.
        if (from.tip !== page.tip) return { sent: false }
        const composer = { draftId: from.draftId, session: from.session, text: from.text }
        const branch = from.tip !== w.leaf()
        const result = generate
          ? await page.call((c: never) =>
              (c as (tag: string, p: unknown) => unknown)("Generate", {
                chatId: w.chatId,
                parentSlotId: from.tip,
                branch,
                ...(from.text.trim() === "" ? {} : { direction: from.text }),
                composer
              })
            )
          : await page.call((c: never) =>
              (c as (tag: string, p: unknown) => unknown)("SendMessage", {
                chatId: w.chatId,
                parentSlotId: from.tip,
                branch,
                content: from.text,
                composer
              })
            )
        if (!result.ok) return { sent: false }
        const value = result.value as {
          _tag: string
          entry?: { slotId: SlotId }
          draft: never
          recovered: number
        }
        if (value._tag === "Posted" && page.tip === from.tip) {
          page.follows = true
          page.go(value.entry!.slotId, true, false)
        }
        return { sent: true, draft: value.draft, recovered: value.recovered }
      })
      return `${generate ? "generate" : "send"} ${JSON.stringify(text)}`
    }
  },
  {
    name: "go to another branch",
    weight: 4,
    run: (w, { page }) => {
      const tip = pick(w.rng, w.tipsOf())
      if (tip === undefined) return null
      page.follows = tip === w.leaf()
      page.go(tip, false, false)
      return tip
    }
  },
  {
    name: "start a branch",
    weight: 3,
    run: (w, { page }) => {
      const slot = pick(w.rng, w.liveSlots())
      if (slot === undefined) return null
      page.follows = slot.id === w.leaf()
      page.go(slot.id, false, true)
      return slot.id
    }
  },
  {
    name: "another device appends below the leaf",
    weight: 3,
    run: (w) => {
      const leaf = w.leaf()
      const generate = w.rng() < 0.5
      w.later(
        generate
          ? w.api.Generate({ chatId: w.chatId, parentSlotId: leaf, branch: false })
          : w.api.SendMessage({ chatId: w.chatId, parentSlotId: leaf, branch: false, content: "From elsewhere." })
      )
      return generate ? "a reply" : "a message"
    }
  },
  {
    name: "a reply ends",
    weight: 3,
    run: (w) => {
      const running = w.all<{ id: string }>(
        `SELECT v.id FROM versions v JOIN slots s ON s.id = v.slot_id
         WHERE s.chat_id = ? AND v.status = 'generating' ORDER BY v.rowid`,
        w.chatId
      )
      const version = pick(w.rng, running)
      if (version === undefined) return null
      // The reply ends on the server, posting what was queued behind it.
      w.background.push(
        (async () => {
          // A reply that has just started gets its gate once its generation runs.
          for (let tries = 0; tries < 600 && !gates.has(version.id); tries++)
            await new Promise((resolve) => setTimeout(resolve, 5))
          Effect.runSync(Deferred.succeed(gates.get(version.id)!, undefined))
          for (let tries = 0; tries < 600; tries++) {
            const [row] = w.all<{ s: string }>(`SELECT status AS s FROM versions WHERE id = ?`, version.id)
            if (row?.s !== "generating") return
            await new Promise((resolve) => setTimeout(resolve, 5))
          }
        })()
      )
      return version.id
    }
  },
  {
    name: "withdraw a queued message",
    weight: 2,
    run: (w, { page }) => {
      const entry = pick(
        w.rng,
        w.all<{ id: string; v: number }>(
          `SELECT id, row_version AS v FROM queued_messages WHERE chat_id = ? ORDER BY rowid`,
          w.chatId
        )
      )
      if (entry === undefined || !page.composer.snapshot().ready) return null
      void page
        .call((c: never) =>
          (c as (tag: string, p: unknown) => unknown)("WithdrawQueued", {
            queuedId: entry.id,
            expectedRowVersion: entry.v
          })
        )
        .then((result) => {
          if (!result.ok || !page.alive) return
          const queued = result.value as { kind: string; content: string; direction: string | null }
          const withdrawn = queued.kind === "message" ? queued.content : (queued.direction ?? "")
          const current = page.composer.snapshot().text
          page.composer.type(current === "" ? withdrawn : withdrawn === "" ? current : `${current}\n\n${withdrawn}`)
        })
      return entry.id
    }
  },
  {
    name: "undo in the composer",
    weight: 2,
    run: (w, { page }) => {
      if (!page.composer.snapshot().ready) return null
      const roll = w.rng()
      void page.composer.history().then(async (states) => {
        if (!states.ok || states.value.length < 2 || !page.alive) return
        const state = states.value[Math.min(states.value.length - 1, 1 + Math.floor(roll * (states.value.length - 1)))]!
        // The user picks a state from the list, seeing the box as it is now.
        w.picked.set(`${page.tab.id} ${state.seq}`, page.composer.snapshot().text)
        await page.composer.restore(state.seq)
      })
      return null
    }
  },
  {
    name: "undo in the editor",
    weight: 2,
    run: (w, { page }) => {
      const store = page.editor
      if (store.snapshot === null) return null
      const path = field(w)
      const key = textField(path)
      const roll = w.rng()
      void store.history(key).then(async (states) => {
        if (!states.ok || states.value.length < 2) return
        const state = states.value[Math.min(states.value.length - 1, 1 + Math.floor(roll * (states.value.length - 1)))]!
        w.picked.set(`${page.tab.id} ${state.seq}`, store.text(path))
        await store.restore(key, state.seq)
      })
      return path.join(".")
    }
  },
  {
    name: "revert a field",
    weight: 2,
    run: (w, { page }) => {
      if (page.editor.snapshot === null) return null
      const path = field(w)
      void page.editor.discard(textField(path))
      return path.join(".")
    }
  },
  {
    name: "save a revision",
    weight: 3,
    run: (w, { page }) => {
      const store = page.editor
      if (store.snapshot === null) return null
      const keep = w.rng() < 0.7
      void store.commit(null).then(async (result) => {
        if (result.ok || result.error.tag !== "EditConflict") return
        const cause = result.cause as { fields: ReadonlyArray<{ field: string; draft: unknown }> }
        // The picker: keep mine, or take the saved version (mine goes to the recovered texts).
        for (const { field, draft } of cause.fields) await store.rebase(field, keep ? (draft as string) : null)
      })
      return keep ? "conflicts: keep mine" : "conflicts: take theirs"
    }
  },
  {
    name: "make a variant with the changes",
    weight: 2,
    run: (w, { page }) => {
      const store = page.editor
      if (store.snapshot === null) return null
      void store.flush().then(async () => {
        const result = await page.callEditor((c: never) =>
          (c as (tag: string, p: unknown) => unknown)("ForkVariant", {
            refId: page.ref,
            label: "Variant",
            subtitle: "",
            moveDrafts: true
          })
        )
        if (!result.ok || !page.alive || page.editor !== store) return
        const ref = (result.value as { id: RefId }).id
        w.refs.push(ref)
        page.openRef(ref)
      })
      return null
    }
  },
  {
    name: "open another entry",
    weight: 3,
    run: (w, { page }) => {
      // The note most often: variants take its drafts, and new ones start there.
      const ref = w.rng() < 0.6 ? w.noteRef : pick(w.rng, w.refs)!
      page.openRef(ref)
      return ref
    }
  },
  {
    name: "delete to the bin",
    weight: 2,
    run: (w) => {
      const note = w.rng() < 0.4
      const slot = pick(w.rng, w.liveSlots())
      if (!note && slot === undefined) return null
      w.later(note ? w.api.DeleteCardNote({ noteRefId: w.noteRef }) : w.api.DeleteMessage({ slotId: slot!.id }))
      return note ? "the note" : slot!.id
    }
  },
  {
    name: "restore from the bin",
    weight: 2,
    run: (w) => {
      const item = pick(w.rng, w.all<{ id: string }>(`SELECT id FROM bin_items ORDER BY rowid`))
      if (item === undefined) return null
      w.later(w.api.RestoreBinItem({ itemId: item.id }))
      return item.id
    }
  },
  {
    name: "the page closes and reloads",
    weight: 3,
    run: (w, tab) => {
      const page = tab.page
      page.composer.beacon()
      page.editor.beacon()
      page.alive = false
      w.net.pageGone(page, w.rng)
      tab.page = new Page(w, tab, page.ref, page.tip, page.follows)
      return null
    }
  },
  {
    name: "the page is hidden",
    weight: 2,
    run: (_, { page }) => {
      void page.composer.flush()
      void page.editor.flush()
      return null
    }
  },
  {
    name: "the page closes, its keepalive held",
    weight: 1,
    run: (_, { page }) => {
      page.composer.beacon()
      page.editor.beacon()
      return null
    }
  },
  {
    name: "offline or online",
    weight: 2,
    run: (_, tab) => {
      tab.offline = !tab.offline
      return tab.offline ? "offline" : "online"
    }
  },
  {
    name: "half a minute passes",
    weight: 1,
    run: (w) => {
      w.wait(31_000)
      return null
    }
  }
]

// --- Running.

const total = OPS.reduce((sum, op) => sum + op.weight, 0)

/** Settles everything the step started: deliveries, the clients' work, the server's own. */
const settle = async (w: World) => {
  let quiet = 0
  for (let round = 0; round < 5000 && quiet < 3; round++) {
    if (w.background.length > 0) {
      const work = w.background
      w.background = []
      await Promise.all(work)
      quiet = 0
      continue
    }
    if (w.net.busy) {
      await w.net.drain()
      quiet = 0
      continue
    }
    await new Promise((resolve) => setImmediate(resolve))
    quiet = w.net.busy || idb.busy ? 0 : quiet + 1
  }
}

/** Views that follow the chat's leaf go where it went, as a session does on its events. */
const follow = (w: World, leafBefore: SlotId | null) => {
  const leaf = w.leaf()
  if (leaf === leafBefore) return
  const parents = new Map(w.liveSlots().map((slot) => [slot.id, slot.parent]))
  for (const { page } of w.tabs) {
    if (!page.follows || page.tip === leaf) continue
    page.go(leaf, leaf !== null && parents.get(leaf) === page.tip, false)
  }
}

const runSteps = async (w: World, steps: ReadonlyArray<Step>) => {
  for (const step of steps) {
    w.rng = mulberry(step.seed)
    const tab = pick(w.rng, w.tabs)!
    let roll = w.rng() * total
    const op = OPS.find((candidate) => (roll -= candidate.weight) < 0)!
    const leafBefore = w.leaf()
    w.log(`${step.index}: tab ${tab.id} ${op.name}`)
    const detail = op.run(w, tab)
    if (detail !== null) w.lines[w.lines.length - 1] += `: ${detail}`
    await settle(w)
    follow(w, leafBefore)
    await settle(w)
    if (process.env.DRAFT_MODEL_DEBUG !== undefined) w.dump()
    w.check(true)
  }
}

/** Everything delivered, every page reloaded and every entry opened: nothing may be left only here. */
const drain = async (w: World) => {
  w.log("drain")
  w.rng = mulberry(1)
  w.net.reliable = true
  for (const tab of w.tabs) tab.offline = false
  for (let round = 0; round < 50; round++) {
    while (w.net.held.length > 0) {
      const request = w.net.held.shift()!
      w.net.ready.push(request)
    }
    for (const { page } of w.tabs)
      for (const [id, timer] of [...page.timers]) {
        page.timers.delete(id)
        timer()
      }
    await settle(w)
    if (w.net.held.length === 0 && w.tabs.every(({ page }) => page.timers.size === 0)) break
  }
  for (const { id } of w.all<{ id: string }>(`SELECT id FROM bin_items`)) w.later(w.api.RestoreBinItem({ itemId: id }))
  await settle(w)
  w.wait(31_000)
  // Every entry with copies here is opened, then every page reloads, which saves every copy.
  const reload = async (tab: Tab, ref: RefId) => {
    tab.page.alive = false
    w.net.pageGone(tab.page, () => 0)
    tab.page = new Page(w, tab, ref, tab.page.tip, tab.page.follows)
    await settle(w)
  }
  const refs = new Set(
    idb
      .values()
      .map((copy) => String(copy.refId))
      .filter((ref) => !ref.startsWith("composer:"))
  )
  for (const ref of refs) await reload(w.tabs[0]!, ref as RefId)
  for (const tab of w.tabs) await reload(tab, tab.page.ref)
  for (let round = 0; round < 20; round++) {
    for (const { page } of w.tabs)
      for (const [id, timer] of [...page.timers]) {
        page.timers.delete(id)
        timer()
      }
    while (w.net.held.length > 0) w.net.ready.push(w.net.held.shift()!)
    await settle(w)
  }
  w.check(false)
  if (idb.values().length > 0)
    w.fail(
      `copies were left in this browser: ${idb
        .values()
        .map((copy) => JSON.stringify(copy.content))
        .join(", ")}`
    )
}

/** One run of `steps` on a fresh server; the lines it logged, and the violation if any. */
const runOnce = (steps: ReadonlyArray<Step>) =>
  Effect.gen(function* () {
    gates.clear()
    idb.clear()
    expectComposerNotice.clear()
    expectEditorNotice.clear()
    const config = testConfig()
    return yield* Effect.gen(function* () {
      const api = yield* client()
      const port = yield* serverPort
      const db = new DatabaseSync(databaseFile(config.dataDir), { readOnly: true })
      const w = new World(api, port, db)
      idb.onComplete = (completed) => {
        try {
          w.completed(completed)
        } catch (error) {
          w.pending ??= error as Violation
        }
      }
      const chat = yield* api.CreateChat({ title: "Model" })
      w.chatId = chat.id
      yield* api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "The first message." })
      const card = yield* api.CreateCard({ label: "Model card", name: "Model card" })
      w.noteRef = (yield* api.CreateCardNote({ cardRefId: card.id, title: "Model note" })).id
      w.refs = [w.noteRef]
      // The tabs open the same way in every run.
      w.rng = mulberry(0)
      const leaf = w.leaf()
      for (let id = 0; id < TABS; id++) {
        const tab = { id, offline: false } as Tab
        tab.page = new Page(w, tab, w.noteRef, leaf, true)
        w.tabs.push(tab)
      }
      const result = yield* Effect.promise(async () => {
        try {
          await settle(w)
          await runSteps(w, steps)
          await drain(w)
          if (w.pending !== null) throw w.pending
          return null
        } catch (error) {
          if (w.pending !== null) return w.pending
          if (error instanceof Violation) return error
          throw error
        } finally {
          for (const { page } of w.tabs) page.alive = false
          for (const gate of gates.values()) Effect.runSync(Deferred.succeed(gate, undefined))
          db.close()
        }
      })
      return { lines: w.lines, violation: result }
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config, gated)))
  })

const stepsOf = (seed: number, count: number): ReadonlyArray<Step> =>
  Array.from({ length: count }, (_, index) => ({ index, seed: seed * 100_003 + index }))

/** Removes steps while the run still breaks the same invariant, to a short list worth reading. */
const shrink = (steps: ReadonlyArray<Step>, budget = 40) =>
  Effect.gen(function* () {
    let kept = steps
    let last = yield* runOnce(kept)
    const kind = last.violation?.message.split(":")[0]
    let chunk = Math.ceil(kept.length / 2)
    while (chunk >= 1 && budget > 0) {
      let progressed = false
      for (let start = 0; start < kept.length && budget > 0; start += chunk) {
        const candidate = [...kept.slice(0, start), ...kept.slice(start + chunk)]
        budget--
        const run = yield* runOnce(candidate)
        if (run.violation !== null && run.violation.message.split(":")[0] === kind) {
          kept = candidate
          last = run
          progressed = true
          start -= chunk
        }
      }
      if (!progressed) chunk = Math.floor(chunk / 2)
    }
    return last
  })

const seeds = ONLY !== undefined ? [Number(ONLY)] : Array.from({ length: SEEDS }, (_, i) => i + 1)

for (const seed of seeds) {
  it.live(
    `the draft protocol keeps every text, seed ${seed}`,
    () =>
      Effect.gen(function* () {
        const steps = stepsOf(seed, STEPS)
        const run = yield* runOnce(steps)
        if (process.env.DRAFT_MODEL_TRACE !== undefined) process.stderr.write(`${run.lines.join("\n")}\n`)
        if (run.violation === null) return
        if (process.env.DRAFT_MODEL_SHRINK === "0")
          return assert.fail(
            [
              `seed ${seed}: ${run.violation.message}`,
              ...(process.env.DRAFT_MODEL_TRACE === undefined ? [] : run.lines)
            ].join("\n")
          )
        const small = yield* shrink(steps)
        const report = [
          `seed ${seed}: ${run.violation.message}`,
          `shrunk to ${small.lines.filter((line) => /^\d+:/.test(line)).length} steps: ${small.violation?.message}`,
          ...small.lines
        ].join("\n")
        assert.fail(report)
      }),
    { timeout: 600_000 }
  )
}
