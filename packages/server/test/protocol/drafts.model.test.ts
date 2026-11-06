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
import type { ChatId, ForkId, SlotId } from "@rp/shared/chat.ts"
import { applyPatch, invertPatch } from "@rp/shared/drafts.ts"
import { getAt, textField } from "@rp/shared/editing.ts"
import type { RefId } from "@rp/shared/library.ts"
import { Cause, Deferred, Effect, Exit, Layer, Option, Scope, Stream } from "effect"
import { RpcClientError } from "effect/rpc"
import { type GenerationFailed, Generator } from "../../src/chat/Generator.ts"
import { DraftClock } from "../../src/db/Database.ts"
import { databaseFile } from "../../src/db/connection.ts"
import { client, serverLayer, serverPort, testConfig } from "../support/config.ts"
import { type Completed, FakeIndexedDb } from "./fakeIndexedDb.ts"
import { deleteBranchBelow } from "../support/forkIds.ts"

const idb = new FakeIndexedDb()
globalThis.indexedDB = idb as unknown as IDBFactory
// Imported once IndexedDB is in place: backup.ts opens it on first use.
const { makeCopy, keepCopy, dropCopy, copiesOfUser, flushCopies } =
  await import("../../../client/src/features/editor/backup.ts")
const { ComposerDraft } = await import("../../../client/src/features/chat/composerDraft.ts")
const { EditorStore } = await import("../../../client/src/features/editor/store.ts")
const { describeCause } = await import("../../../client/src/errors.ts")
const { MessageDraft } = await import("../../../client/src/features/chat/messageDraft.ts")
type ComposerDraft = InstanceType<typeof ComposerDraft>
type EditorStore = InstanceType<typeof EditorStore>

const SEEDS = Number(process.env.DRAFT_MODEL_SEEDS ?? 4)
const STEPS = Number(process.env.DRAFT_MODEL_STEPS ?? 150)
const ONLY = process.env.DRAFT_MODEL_SEED
const TABS = Number(process.env.DRAFT_MODEL_TABS ?? 2)
/** The copies' user: the server runs in single-user mode. */
const USER = "model-user"
const OTHER_USER = "model-other-user"
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
  readonly copyIds: Array<string>
  /** The client hears nothing back: lost on the way, or the page is gone. */
  silent: boolean
  readonly answer: (
    outcome: Exit.Exit<unknown, unknown> | boolean | { readonly ok: boolean; readonly recovered: number }
  ) => void
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

  send(
    page: Page,
    tag: string,
    payload: unknown,
    keepalive: boolean,
    store: EditorStore | null = null,
    copyId?: string
  ) {
    return new Promise<Exit.Exit<unknown, unknown> | boolean | { readonly ok: boolean; readonly recovered: number }>(
      (resolve) => {
        const request: Request = {
          id: this.next++,
          page,
          store,
          tag,
          payload,
          keepalive,
          copyIds: [],
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
        try {
          this.world.checkRequest(request, copyId)
        } catch (error) {
          this.world.log(`request capture failed: ${String(error)}`)
          this.world.pending ??= error instanceof Violation ? error : new Violation(String(error))
          throw error
        }
        const fail = () => request.answer(keepalive ? false : lost())
        if (page.tab.offline) {
          this.world.log(`  r${request.id} ${tag} from tab ${page.tab.id}: offline`)
          return fail()
        }
        const roll = this.reliable ? 0 : this.world.rng()
        const repeatable = REPEATABLE.has(tag)
        // Reads mostly go through; writes are held more, so typing meets them on their way.
        const now = tag.startsWith("Open") || tag.endsWith("History") ? 0.75 : 0.5
        const how =
          roll < now ? "now" : roll < 0.8 ? "held" : roll < 0.87 ? "lost" : roll < 0.94 ? "reply lost" : "twice"
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
      }
    )
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
  fork: ForkId | null
  /** The view follows the chat's current fork as it changes. */
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
      this.world.net.send(this, "keepalive", JSON.parse(body), true) as Promise<
        boolean | { readonly ok: boolean; readonly recovered: number }
      >
  }

  readonly world: World
  readonly tab: Tab

  constructor(world: World, tab: Tab, ref: RefId, fork: ForkId | null, follows: boolean) {
    this.world = world
    this.tab = tab
    const session = { id: world.chatId, call: (rpc: Rpc) => this.call(rpc) }
    this.composer = new ComposerDraft(session as never, USER, this.env)
    this.ref = ref
    this.editor = this.store(ref)
    this.fork = fork
    this.follows = follows
    this.composer.setFork(fork, false)
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

  go(fork: ForkId | null, branch: boolean) {
    this.fork = fork
    this.composer.setFork(fork, branch)
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
  /** Complete texts typed and not removed by the user in a field that showed them. */
  readonly live = new Set<string>()
  /**
   * What a tab showed as the user picked an earlier state to restore, by tab and state: the
   * restore removes what's not in that state, once the server makes it, heard back or not.
   */
  readonly picked = new Map<string, string>()
  /** Canonical payloads the server answered for: the copies a client may delete. */
  readonly acknowledgedCopies = new Set<string>()
  readonly confirmedBases = new Map<string, string>()
  readonly sentBases = new Map<string, string>()
  readonly lines: Array<string> = []
  /** The pages' clock: it moves on with every reading, so copies made in a run are ordered. */
  private clock = Date.now()
  private token = 0
  chatId!: ChatId
  otherChatId!: ChatId
  otherRef!: RefId
  noteRef!: RefId
  refs: Array<RefId> = []
  /** The server's own work a step started (another device's writes, a reply ending). */
  background: Array<Promise<unknown>> = []
  /** A violation found where it can't be thrown (as IndexedDB completes). */
  pending: Violation | null = null
  recoveryOwner: string | null = null

  api: Api
  port: number
  restart: () => Promise<void> = async () => undefined
  readonly writerClock = new BigInt64Array(new SharedArrayBuffer(8))
  readonly copyHistory = new Map<string, Record<string, unknown>>()
  readonly db: DatabaseSync

  constructor(api: Api, port: number, db: DatabaseSync) {
    this.api = api
    this.port = port
    this.db = db
    Atomics.store(this.writerClock, 0, BigInt(this.clock))
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
    Atomics.add(this.writerClock, 0, BigInt(ms))
  }

  /** A write another device makes, which the step waits for. */
  later(write: Effect.Effect<unknown, unknown>) {
    this.background.push(Effect.runPromise(Effect.ignore(write)))
  }

  newToken() {
    const token = `#${this.token++}#`
    return token
  }

  /** The user removed these from a field that showed them. */
  removed(before: string, after: string) {
    for (const text of this.live) if (before.includes(text) && !after.includes(text)) this.live.delete(text)
  }

  fail(message: string): never {
    throw new Violation(message)
  }

  async copies(owner: string) {
    const copies = await copiesOfUser(owner)
    if (copies.some((copy) => copy.userId !== owner)) this.fail("I4: recovery exposed another account's copy")
    return copies
  }

  async recoverOwner(owner: string) {
    const remaining = [...(await this.copies(owner))]
    const original = globalThis.fetch
    globalThis.fetch = (async (url, init) => {
      if (url !== "/library/drafts") return original(url, init)
      const body = JSON.parse(init!.body as string) as { drafts: Array<unknown>; composers: Array<unknown> }
      const save = body.drafts[0] ?? body.composers[0]
      const at = remaining.findIndex((copy) => canonical(copy.save.payload) === canonical(save))
      const [copy] = remaining.splice(at, 1)
      const saving = this.net.send(this.tabs[0]!.page, "keepalive", body, true, null, copy?.key)
      await settle(this)
      const result = (await saving) as { ok: boolean; recovered: number } | boolean
      const ok = typeof result === "boolean" ? result : result.ok
      return new Response(null, {
        status: ok ? 204 : 503,
        headers: { "x-drafts-recovered": String(typeof result === "boolean" ? 0 : result.recovered) }
      })
    }) as typeof fetch
    try {
      return await flushCopies(owner)
    } finally {
      globalThis.fetch = original
    }
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

  /** The chat's current fork. */
  currentFork() {
    return this.all<{ fork: ForkId }>(`SELECT current_fork_id AS fork FROM chats WHERE id = ?`, this.chatId)[0]!.fork
  }

  /** A fork's tip; the current fork's for null. */
  tipOf(fork: ForkId | null) {
    return this.all<{ tip: SlotId | null }>(
      `SELECT tip_slot_id AS tip FROM forks WHERE id = coalesce(?, (SELECT current_fork_id FROM chats WHERE id = ?))`,
      fork,
      this.chatId
    )[0]!.tip
  }

  liveForks() {
    return this.all<{ id: ForkId; tip: SlotId | null }>(
      `SELECT id, tip_slot_id AS tip FROM forks WHERE chat_id = ? AND deleted_at IS NULL ORDER BY id`,
      this.chatId
    )
  }

  liveSlots() {
    return this.all<{ id: SlotId; parent: SlotId | null }>(
      `SELECT id, parent_slot_id AS parent FROM slots WHERE chat_id = ? AND deleted_at IS NULL ORDER BY rowid`,
      this.chatId
    )
  }

  recoveredCount() {
    return this.all<{ n: number }>(`SELECT count(*) AS n FROM recovered_texts`)[0]!.n
  }

  drafts() {
    return this.all<{
      id: string
      content: string
      session: number
      status: string
      targetId: string
      targetKind: string
    }>(`SELECT id, content, session, status, target_id AS targetId, target_kind AS targetKind FROM drafts`)
  }

  // --- Requests, checked as they're made and as they're delivered.

  checkRequest(request: Request, copyId?: string) {
    const payload = request.payload as Record<string, unknown>
    const payloads = request.keepalive
      ? [...(payload.drafts as Array<unknown>), ...((payload.composers as Array<unknown>) ?? [])]
      : [payload]
    type Pending = { key: string; save: { payload: unknown } }
    const editor = (request.store ?? request.page.editor) as unknown as {
      fields: Map<string, { pending: Pending | null }>
      sendingCopies: WeakSet<Pending>
    }
    if (copyId !== undefined) request.copyIds.push(copyId)
    else
      for (const save of payloads) {
        const operationId = (save as Record<string, unknown>).operationId
        if (typeof operationId === "string") {
          request.copyIds.push(operationId)
          continue
        }
        const composer = request.page.composer as unknown as {
          pending: { key: string; save: { payload: unknown } } | null
          sending: { copy: { key: string; save: { payload: unknown } } | null } | null
        }
        // The newest matching in-flight copy made this request. Pending text can
        // already be another copy with identical bytes and base (seed 60).
        const sending =
          request.tag === "SaveEditorDraft"
            ? [...idb.originals.values()].reverse().filter((copy) => editor.sendingCopies.has(copy as Pending))
            : []
        const shown = (sending as Array<Pending>).concat(
          [...editor.fields.values()]
            .flatMap((field) => (field.pending === null ? [] : [field.pending]))
            .concat(
              composer.pending === null ? [] : [composer.pending],
              composer.sending?.copy == null ? [] : [composer.sending.copy]
            )
        )
        const own = shown.find((copy) => canonical(copy.save.payload) === canonical(save))
        const copy =
          own ?? idb.values().find((copy) => canonical((copy.save as { payload: unknown }).payload) === canonical(save))
        if (copy !== undefined) request.copyIds.push(copy.key)
      }
    // I3: a save names the draft it was typed into.
    const fieldSaves =
      request.tag === "SaveEditorDraft"
        ? [payload]
        : request.keepalive
          ? (payload.drafts as Array<Record<string, unknown>>)
          : []
    for (const save of fieldSaves) {
      if (
        save.expectedRowVersion !== null &&
        (typeof save.draftId !== "string" || typeof save.expectedSession !== "number")
      )
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
    const composerSaves =
      request.tag === "SaveComposer"
        ? [payload]
        : request.keepalive
          ? ((payload.composers as Array<Record<string, unknown>>) ?? [])
          : []
    const duplicate =
      composerSaves.length === 1 &&
      this.all(
        `SELECT 1 FROM composer_save_receipts WHERE chat_id = ? AND operation_id = ?`,
        composerSaves[0]!.chatId as string,
        composerSaves[0]!.operationId as string
      ).length > 0
    const state = () =>
      canonical([
        this.all(`SELECT * FROM drafts ORDER BY id`),
        this.all(`SELECT * FROM draft_history ORDER BY draft_id, seq`),
        this.all(`SELECT * FROM recovered_texts ORDER BY id`)
      ])
    const prior = duplicate ? state() : null
    let keepaliveRecovered = 0
    let outcome: Exit.Exit<unknown, unknown> | boolean | { readonly ok: boolean; readonly recovered: number }
    if (request.keepalive) {
      const response = await fetch(`http://127.0.0.1:${this.port}/library/drafts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      })
      outcome = response.ok
      keepaliveRecovered = Number(response.headers.get("x-drafts-recovered") ?? 0)
      if (response.ok && this.recoveredCount() > recoveredBefore && keepaliveRecovered === 0)
        this.fail("I5: keepalive recovered text without reporting it")
    } else {
      outcome = await Effect.runPromiseExit((this.api as unknown as AnyApi)[request.tag]!(payload))
    }
    for (const save of composerSaves) {
      if ((typeof outcome !== "boolean" && Exit.isFailure(outcome)) || outcome === false) continue
      if (
        this.all(
          `SELECT 1 FROM composer_save_receipts WHERE chat_id = ? AND operation_id = ?`,
          save.chatId as string,
          save.operationId as string
        ).length !== 1
      )
        this.fail("I4: an acknowledged composer operation has no durable receipt")
    }
    if (prior !== null && state() !== prior) this.fail("I4: a replay applied an acknowledged operation twice")
    const ok = typeof outcome === "boolean" ? outcome : Exit.isSuccess(outcome)
    if (ok && !request.silent && request.page.alive) for (const key of request.copyIds) this.acknowledgedCopies.add(key)
    if (
      ok &&
      !request.silent &&
      request.page.alive &&
      typeof outcome !== "boolean" &&
      Exit.isSuccess(outcome) &&
      (request.tag === "SaveEditorDraft" || request.tag === "SaveComposer")
    ) {
      const value = outcome.value as Record<string, unknown>
      const draft = (request.tag === "SaveComposer" ? value.draft : value) as {
        id: string
        rowVersion: number
        session: number
        baseRevision: string | null
        content: string
      } | null
      if (draft !== null && draft.content === payload.content) {
        const kind = request.tag === "SaveComposer" ? "composer" : "editor"
        const saved = this.copyBase(kind, {
          draftId: draft.id,
          rowVersion: draft.rowVersion,
          session: draft.session,
          expectedRowVersion: draft.rowVersion,
          expectedSession: draft.session,
          baseRevisionId: draft.baseRevision
        })
        for (const key of request.copyIds) this.confirmedBases.set(key, saved)
      }
    }
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
      if (request.tag === "SendMessage" || request.tag === "Generate") {
        const value = outcome.value as {
          draft: { id: string; content: string; status: string; rowVersion: number; session: number } | null
        }
        const source = payload.composer as { draftId: string; session: number } | undefined
        const after = value.draft
        if (
          !request.silent &&
          request.page.alive &&
          source !== undefined &&
          after !== null &&
          after.id === source.draftId &&
          after.status === "committed" &&
          after.session === source.session + 1
        )
          this.sentBases.set(
            `${source.draftId}/${source.session}`,
            this.copyBase("composer", { draftId: after.id, rowVersion: after.rowVersion, session: after.session })
          )
      }
      this.checkCommit(request, draftsBefore, outcome.value as Record<string, unknown>)
      this.checkRecovered(request, recoveredBefore, outcome.value as Record<string, unknown>)
    }
    request.answer(request.keepalive ? { ok: outcome as boolean, recovered: keepaliveRecovered } : outcome)
  }

  /** I2: a commit ends only the draft it names, holding exactly the text it names. */
  private checkCommit(request: Request, before: Map<string, Draft>, value: Record<string, unknown>) {
    const payload = request.payload as Record<string, unknown>
    const named = new Set<string>()
    if ((request.tag === "SendMessage" || request.tag === "Generate") && payload.composer !== undefined) {
      const composer = payload.composer as { draftId: string; session: number }
      const text =
        request.tag === "Generate" ? ((payload.direction as string | undefined) ?? "") : (payload.content as string)
      named.add(composer.draftId)
      const was = before.get(composer.draftId)
      const now = this.drafts().find((d) => d.id === composer.draftId)
      const destination =
        value._tag === "Queued"
          ? (value.queued as { kind: string; content: string; direction: string | null })
          : (value.entry as { version: { content: string; direction: string | null } }).version
      const stored = request.tag === "Generate" ? (destination.direction ?? "") : destination.content
      if (stored !== text) this.fail(`I2: destination stored ${JSON.stringify(stored)} for ${JSON.stringify(text)}`)
      if (
        was !== undefined &&
        now !== undefined &&
        now.session !== was.session &&
        (was.content !== text ||
          was.session !== composer.session ||
          was.targetKind !== "composer" ||
          was.targetId !== payload.chatId)
      )
        this.fail(`I2: a send of ${JSON.stringify(text)} committed ${JSON.stringify(was.content)}`)
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
    if (request.tag === "SaveComposer" && value.draft !== null) {
      const nested = (value.draft as { recovered: number }).recovered
      if (nested > 0 !== value.recovered) this.fail("I5: composer recovery metadata surfaces disagree")
    }
    if (this.recoveredCount() === before) return
    const says =
      request.tag === "SaveComposer"
        ? value.recovered === true
        : ["SaveEditorDraft", "RestoreEditorDraft", "DiscardEditorDraft", "RestoreComposer"].includes(request.tag)
          ? (value.recovered as number) > 0
          : request.tag === "SendMessage" || request.tag === "Generate" || request.tag === "CommitEditorDrafts"
            ? (value.recovered as number) > 0 || ((value.setAside as Array<unknown> | undefined)?.length ?? 0) > 0
            : null
    if (says === false) this.fail(`I5: ${request.tag} sent text to the recovered texts without saying so`)
    if (says && !request.silent && request.page.alive) {
      if (request.store !== null) expectEditorNotice.add(request.store)
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
    const shownDrafts = this.tabs.flatMap(({ page }) => {
      const base = (page.composer as unknown as { base: { id: string } | null }).base
      return base === null ? [] : [base.id]
    })
    for (const draft of this.all<{ id: string; content: string }>(
      `SELECT d.id, d.content FROM drafts d WHERE
      (d.target_kind = 'composer' AND EXISTS (SELECT 1 FROM chats c WHERE c.id = d.target_id) AND
        (d.id IN (SELECT value FROM json_each(?)) OR
          EXISTS (SELECT 1 FROM forks f WHERE f.id = d.field AND f.chat_id = d.target_id))) OR
      (d.target_kind = 'entity_field' AND EXISTS (SELECT 1 FROM entity_refs f WHERE f.id = d.target_id))`,
      JSON.stringify(shownDrafts)
    )) {
      let text = draft.content
      texts.push(text)
      for (const entry of history.filter((h) => h.draft === draft.id)) {
        text = applyPatch(text, invertPatch(entry))
        texts.push(text)
      }
    }
    for (const row of this.all<{ t: string | null }>(`SELECT content AS t FROM recovered_texts`))
      texts.push(row.t ?? "")
    for (const row of this.all<{ c: string; d: string | null }>(
      `SELECT content AS c, direction AS d FROM version_records`
    ))
      texts.push(row.c, row.d ?? "")
    for (const row of this.all<{ c: string; d: string | null }>(
      `SELECT content AS c, direction AS d FROM queued_messages`
    ))
      texts.push(row.c, row.d ?? "")
    const strings = (value: unknown): Array<string> =>
      typeof value === "string"
        ? [value]
        : value !== null && typeof value === "object"
          ? Object.values(value).flatMap(strings)
          : []
    for (const row of this.all<{ d: string }>(
      `SELECT doc_json AS d FROM entity_revisions r WHERE EXISTS (SELECT 1 FROM entity_refs f WHERE f.entity_id = r.entity_id)`
    ))
      texts.push(...strings(JSON.parse(row.d)))
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
        `    tab ${id} composer ${JSON.stringify(page.composer.snapshot().text)} on ${base?.id.slice(-6)}@${base?.rowVersion}/${base?.session} fork ${page.fork?.slice(-6)}`
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
    ]
    const missing = [...this.live].filter(
      (text) => !haystack.some((reachable) => reachable === text || reachable.includes(text))
    )
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

  /** The complete base of the text, apart from its target (checked by ancestry). */
  private copyBase(kind: string, payload: Record<string, unknown>) {
    return canonical(
      kind === "editor"
        ? {
            draftId: payload.draftId,
            rowVersion: payload.expectedRowVersion,
            session: payload.expectedSession,
            revision: payload.baseRevisionId
          }
        : { draftId: payload.draftId, rowVersion: payload.rowVersion, session: payload.session }
    )
  }

  /** I4: a copy goes only once acknowledged, or replaced by a newer copy of the same draft typed from it. */
  completed({ put, deleted }: Completed) {
    for (const copy of put) {
      const save = copy.save as { kind: string; payload: Record<string, unknown> }
      const base = this.copyBase(save.kind, save.payload)
      const parents = [...this.copyHistory.values(), ...idb.values()].filter(
        (parent) =>
          (copy.ancestors as ReadonlyArray<string>).includes(parent.key as string) &&
          parent.refId === copy.refId &&
          parent.field === copy.field
      )
      if (
        parents.length > 0 &&
        !parents.some((parent) => {
          const before = parent.save as { kind: string; payload: Record<string, unknown> }
          return (
            before.kind === save.kind &&
            (this.copyBase(before.kind, before.payload) === base ||
              this.confirmedBases.get(parent.key as string) === base ||
              (before.kind === "composer" &&
                before.payload.next === true &&
                this.sentBases.get(`${before.payload.draftId as string}/${before.payload.session as number}`) === base))
          )
        })
      )
        this.fail(
          `I3: a copy's base changed without acknowledging an ancestor's exact text: ${canonical(save.payload)}`
        )
      this.copyHistory.set(copy.key, copy)
    }
    for (const copy of deleted) {
      const save = copy.save as { kind: string; payload: Record<string, unknown> }
      if (this.acknowledgedCopies.has(copy.key)) continue
      const descendant = [...this.copyHistory.values(), ...idb.values()].some((other) => {
        const ancestry = other.ancestors as ReadonlyArray<string>
        const pending = other.save as { kind: string; payload: Record<string, unknown> }
        return (
          ancestry.includes(copy.key) &&
          other.refId === copy.refId &&
          other.field === copy.field &&
          pending.kind === save.kind &&
          (this.acknowledgedCopies.has(other.key as string) || idb.values().some((value) => value.key === other.key))
        )
      })
      if (!descendant) {
        this.log(
          `copy deletion ${canonical(copy)}; successors ${canonical([...this.copyHistory.values()].filter((other) => (other.ancestors as ReadonlyArray<string>).includes(copy.key)).map((other) => ({ key: other.key, refId: other.refId, field: other.field, kept: idb.values().some((value) => value.key === other.key), acknowledged: this.acknowledgedCopies.has(other.key as string) })))}`
        )
        this.fail(
          `I4: a copy was deleted without an acknowledged or retained descendant: ${JSON.stringify(copy.content)}`
        )
      }
    }
  }
}

type Draft = { id: string; content: string; session: number; status: string; targetId: string; targetKind: string }
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
    name: "refresh the editor, including while saves are in flight",
    weight: 4,
    run: (_, { page }) => {
      void page.editor.refresh()
      return null
    }
  },
  {
    name: "send with another chat's composer identity",
    weight: 2,
    run: (w, { page }) => {
      const draft = w.drafts().find((d) => d.targetId === w.chatId && d.status === "active" && d.content.trim() !== "")
      if (!draft) return null
      void page.call((c: never) =>
        (c as (tag: string, p: unknown) => unknown)("SendMessage", {
          chatId: w.otherChatId,
          parentSlotId: null,
          branch: true,
          content: draft.content,
          composer: { draftId: draft.id, session: draft.session }
        })
      )
      return draft.id
    }
  },
  {
    name: "another account retains a browser copy",
    weight: 2,
    run: (w) => {
      const text = `Other account ${w.newToken()}`
      w.live.add(text)
      const copy = makeCopy(
        OTHER_USER,
        w.otherRef,
        textField(FIELDS[0]),
        {
          kind: "editor",
          payload: {
            refId: w.otherRef,
            field: textField(FIELDS[0]),
            draftId: null,
            expectedRowVersion: null,
            expectedSession: null,
            baseRevisionId: null,
            content: text
          }
        },
        w.now()
      )
      w.background.push(keepCopy(copy))
      return text
    }
  },
  {
    name: "logout or recovery retries only this account's copies",
    weight: 2,
    run: (w) => {
      w.recoveryOwner = w.rng() < 0.5 ? USER : OTHER_USER
      return null
    }
  },
  {
    name: "type in the composer",
    weight: 14,
    run: (w, { page }) => {
      const { text, ready } = page.composer.snapshot()
      if (!ready) return null
      const after = edit(w, text)
      w.removed(text, after)
      if (after !== "") w.live.add(after)
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
      if (after !== "") w.live.add(after)
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
        // The view went to another fork since: Composer.tsx doesn't send.
        if (from.fork !== page.fork) return { sent: false }
        const composer = { draftId: from.draftId, session: from.session }
        // At the tip the view shows, as it has it from the chat's events.
        const tip = w.tipOf(from.fork)
        const result = generate
          ? await page.call((c: never) =>
              (c as (tag: string, p: unknown) => unknown)("Generate", {
                chatId: w.chatId,
                forkId: from.fork,
                parentSlotId: tip,
                branch: false,
                ...(from.text.trim() === "" ? {} : { direction: from.text }),
                composer
              })
            )
          : await page.call((c: never) =>
              (c as (tag: string, p: unknown) => unknown)("SendMessage", {
                chatId: w.chatId,
                forkId: from.fork,
                parentSlotId: tip,
                branch: false,
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
        // Chatting in a fork makes it the current one.
        if (value._tag === "Posted" && page.fork === from.fork) page.follows = true
        return { sent: true, draft: value.draft, recovered: value.recovered }
      })
      return `${generate ? "generate" : "send"} ${JSON.stringify(text)}`
    }
  },
  {
    name: "go to another branch",
    weight: 4,
    run: (w, { page }) => {
      const fork = pick(w.rng, w.liveForks())
      if (fork === undefined) return null
      page.follows = fork.id === w.currentFork()
      page.go(fork.id, false)
      return fork.id
    }
  },
  {
    name: "start a branch",
    weight: 3,
    run: (w, { page }) => {
      // At a live message on the path of the fork shown, as Branch from here offers it.
      const parents = new Map(w.liveSlots().map((slot) => [slot.id, slot.parent]))
      const path: Array<SlotId> = []
      for (let at = w.tipOf(page.fork); at !== null && at !== undefined; at = parents.get(at) ?? null)
        if (parents.has(at)) path.push(at)
      const slot = pick(w.rng, path)
      if (slot === undefined) return null
      void page
        .call((c: never) =>
          (c as (tag: string, p: unknown) => unknown)("CreateFork", {
            chatId: w.chatId,
            fromForkId: page.fork,
            atSlotId: slot
          })
        )
        .then((made) => {
          if (!made.ok || !page.alive) return
          // The fork made is the current one, and its composer starts as a copy.
          page.follows = true
          page.go((made.value as { fork: { id: ForkId } }).fork.id, true)
        })
      return slot
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
          (c as (tag: string, p: unknown) => unknown)(
            store.snapshot!.ref.kind === "card" ? "ForkCard" : "ForkVariant",
            store.snapshot!.ref.kind === "card"
              ? {
                  refId: page.ref,
                  name: `Fork ${w.refs.length}`,
                  nickname: "",
                  characterVersion: ""
                }
              : { refId: page.ref, label: "Variant", subtitle: "", moveDrafts: true }
          )
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
      w.later(note ? w.api.DeleteNote({ noteRefId: w.noteRef }) : w.api.DeleteMessage({ slotId: slot!.id }))
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
      tab.page = new Page(w, tab, page.ref, page.fork, page.follows)
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
    name: "purge a chat with a queued direction",
    weight: 1,
    run: (w) => {
      w.background.push(purgeQueue(w, false))
      return null
    }
  },
  {
    name: "purge a branch with a queued direction",
    weight: 1,
    run: (w) => {
      w.background.push(purgeQueue(w, true))
      return null
    }
  },
  {
    name: "the server restarts",
    weight: 1,
    run: (w) => {
      w.background.push(w.restart())
      return null
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

/** Views that follow the chat's current fork go to it when it changes, as a session does on a reload. */
const follow = (w: World) => {
  const current = w.currentFork()
  for (const { page } of w.tabs) if (page.follows && page.fork !== current) page.go(current, false)
}

const runSteps = async (w: World, steps: ReadonlyArray<Step>) => {
  for (const step of steps) {
    w.rng = mulberry(step.seed)
    const tab = pick(w.rng, w.tabs)!
    let roll = w.rng() * total
    const op = OPS.find((candidate) => (roll -= candidate.weight) < 0)!
    w.log(`${step.index}: tab ${tab.id} ${op.name}`)
    const detail = op.run(w, tab)
    if (detail !== null) w.lines[w.lines.length - 1] += `: ${detail}`
    await settle(w)
    await w.copies(USER)
    await w.copies(OTHER_USER)
    if (w.recoveryOwner !== null) {
      const owner = w.recoveryOwner
      w.recoveryOwner = null
      const reliable = w.net.reliable
      w.net.reliable = true
      await w.recoverOwner(owner)
      w.net.reliable = reliable
      await settle(w)
    }
    follow(w)
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
    tab.page = new Page(w, tab, ref, tab.page.fork, tab.page.follows)
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
  await w.recoverOwner(OTHER_USER)
  await settle(w)
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
const runOnce = (steps: ReadonlyArray<Step>, directed?: (w: World) => Promise<void>) =>
  Effect.gen(function* () {
    gates.clear()
    idb.clear()
    expectComposerNotice.clear()
    expectEditorNotice.clear()
    const config = testConfig()
    let serverScope = yield* Scope.make()
    const clock = new SharedArrayBuffer(8)
    Atomics.store(new BigInt64Array(clock), 0, BigInt(Date.now()))
    const start = Effect.gen(function* () {
      const context = yield* Layer.buildWithScope(
        serverLayer(config, gated).pipe(Layer.provide(Layer.succeed(DraftClock)(clock))),
        serverScope
      )
      return yield* Effect.gen(function* () {
        return { api: yield* client(), port: yield* serverPort }
      }).pipe(Effect.provide(context), Scope.provide(serverScope))
    })
    yield* Effect.addFinalizer(() => Scope.close(serverScope, Exit.void))
    const { api, port } = yield* start
    return yield* Effect.gen(function* () {
      const db = new DatabaseSync(databaseFile(config.dataDir), { readOnly: true })
      const w = new World(api, port, db)
      Object.defineProperty(w, "writerClock", { value: new BigInt64Array(clock) })
      w.restart = () =>
        Effect.runPromise(
          Effect.gen(function* () {
            yield* Scope.close(serverScope, Exit.void)
            serverScope = yield* Scope.make()
            const next = yield* start
            w.api = next.api
            w.port = next.port
          })
        )
      idb.onComplete = (completed) => {
        try {
          w.completed(completed)
        } catch (error) {
          w.pending ??= error as Violation
        }
      }
      const chat = yield* api.CreateChat({ title: "Model" })
      w.chatId = chat.id
      w.otherChatId = (yield* api.CreateChat({ title: "Other model chat" })).id
      yield* api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "The first message." })
      const card = yield* api.CreateCard({ label: "Model card", name: "Model card" })
      w.noteRef = (yield* api.CreateCardNote({ cardRefId: card.id, title: "Model note" })).id
      w.refs = [w.noteRef]
      w.otherRef = (yield* api.CreateCardNote({ cardRefId: card.id, title: "Other account copy target" })).id
      // The tabs open the same way in every run.
      w.rng = mulberry(0)
      const fork = w.currentFork()
      for (let id = 0; id < TABS; id++) {
        const tab = { id, offline: false } as Tab
        tab.page = new Page(w, tab, w.noteRef, fork, true)
        w.tabs.push(tab)
      }
      const result = yield* Effect.promise(async () => {
        try {
          await settle(w)
          if (directed !== undefined) await directed(w)
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
    })
  }).pipe(Effect.scoped)

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

/** Directed operations complement sampling: each has an oracle check, so a short run
 * still exercises sessions, full whitespace, receipts across restart, movement, queue
 * cleanup, keepalive, and the writer's history-retention clock. */
const request = async (w: World, tag: string, payload: unknown, store: EditorStore | null = null) => {
  const page = w.tabs[0]!.page
  const result =
    store === null
      ? page.call((c: never) => (c as (tag: string, p: unknown) => unknown)(tag, payload))
      : page.callEditor((c: never) => (c as (tag: string, p: unknown) => unknown)(tag, payload), store)
  await settle(w)
  const answered = await result
  if (!answered.ok) throw new Violation(`directed ${tag} failed: ${answered.error.message}`)
  return answered.value
}

const purgeQueue = async (w: World, branch: boolean) => {
  const chat = await Effect.runPromise(w.api.CreateChat({ title: "Queue purge" }))
  const parent = await Effect.runPromise(w.api.Generate({ chatId: chat.id, parentSlotId: null, branch: false }))
  if (parent._tag !== "Posted") throw new Violation("directed parent did not post")
  const text = `  queued direction ${w.newToken()}\n\n`
  w.live.add(text)
  await Effect.runPromise(
    w.api.Generate({ chatId: chat.id, parentSlotId: parent.entry.slotId, branch: false, direction: text })
  )
  const item = await Effect.runPromise(
    branch ? deleteBranchBelow(w.api, chat.id, null) : w.api.DeleteChat({ chatId: chat.id })
  )
  await Effect.runPromise(w.api.PurgeBinItem({ itemId: item.id }))
  w.check(true)
}

// --- Insert drafts (spec/MESSAGE-INSERT.md §3.1): the insertion editor's text is a message
// editor's draft, the client's own MessageDraft, keyed by chat, fork and anchor.

type InsertTarget = {
  readonly _tag: "Insert"
  readonly chatId: ChatId
  readonly forkId: ForkId
  readonly anchor: SlotId | null
}

/**
 * What MessageDraft needs of a chat session: its id, and calls to the server as it, delivered at
 * once. A save the server answered acknowledges this browser's copies of exactly its payload (I4).
 */
const draftSession = (w: World) =>
  ({
    id: w.chatId,
    call: async (
      rpc: (
        client: (tag: string, payload: unknown) => Effect.Effect<unknown, unknown>
      ) => Effect.Effect<unknown, unknown>
    ) => {
      const sent: Array<{ readonly tag: string; readonly payload: unknown }> = []
      const exit = await Effect.runPromiseExit(
        rpc((tag, payload) => {
          sent.push({ tag, payload })
          return (w.api as unknown as AnyApi)[tag]!(payload)
        })
      )
      if (Exit.isSuccess(exit))
        for (const { tag, payload } of sent)
          if (tag === "SaveMessageDraft")
            for (const copy of [...w.copyHistory.values(), ...idb.values()]) {
              const save = copy.save as { kind?: string; payload?: unknown } | undefined
              if (save?.kind === "message" && canonical(save.payload) === canonical(payload))
                w.acknowledgedCopies.add(copy.key as string)
            }
      return Exit.isSuccess(exit) ? { ok: true, value: exit.value } : { ok: false, error: describeCause(exit.cause) }
    }
  }) as never

/** The chat's first message and its fork: where the insert drafts' editors insert below. */
const insertPlace = async (w: World) => {
  const window = await Effect.runPromise(
    w.api.ReadPath({ chatId: w.chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
  )
  return { forkId: window.forkId!, anchor: window.entries[0]!.slotId }
}

/** An editor of `target` as a tab opens it: with the server's draft for it, if there is one. */
const openInsertDraft = async (w: World, target: InsertTarget) => {
  const drafts = await Effect.runPromise(w.api.MessageDrafts({ chatId: w.chatId }))
  const draft =
    drafts.find((d) => d.key.targetKind === "insert" && d.key.field === `${target.forkId}:${target.anchor ?? ""}`) ??
    null
  return new MessageDraft(draftSession(w), USER, target, "", draft)
}

const insertedTexts = async (w: World) =>
  (
    await Effect.runPromise(
      w.api.ReadPath({ chatId: w.chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 200 })
    )
  ).entries.map((e) => e.version.content)

const INSERT_DIRECTED: ReadonlyArray<{ name: string; run: (w: World) => Promise<void> }> = [
  {
    name: "insert drafts keep every text over random typing, reloads, inserts and discards in two tabs",
    run: async (w) => {
      const { forkId, anchor } = await insertPlace(w)
      for (const seed of [1, 2, 3]) {
        const rng = mulberry(seed)
        const target: InsertTarget = { _tag: "Insert", chatId: w.chatId, forkId, anchor: seed === 3 ? null : anchor }
        const tabs = [await openInsertDraft(w, target), await openInsertDraft(w, target)]
        // Each tab's last typed text, until the user inserts or discards it there.
        const live = new Map<number, string>()
        let typed = 0
        for (let step = 0; step < 40; step++) {
          const at = Math.floor(rng() * tabs.length)
          const tab = tabs[at]!
          const roll = rng()
          if (roll < 0.45) {
            const text = `seed ${seed} text ${typed++}`
            tab.setText(text)
            live.set(at, text)
          } else if (roll < 0.6) await tab.save()
          else if (roll < 0.7) {
            await tab.save()
            tabs[at] = await openInsertDraft(w, target)
            // A reload shows the server's text; what this tab typed is on the server now.
            live.delete(at)
            const shown = tabs[at]!.snapshot().text
            if (shown !== "") live.set(at, shown)
          } else if (roll < 0.88) {
            const submitted = await tab.ready()
            if (submitted.text === "") continue
            const row = (id: string) =>
              w.db.prepare("SELECT status, session, content FROM drafts WHERE id = ?").get(id) as
                { status: string; session: number; content: string } | undefined
            const before = submitted.draft ? row(submitted.draft.draftId) : undefined
            const result = await Effect.runPromise(
              Effect.result(
                w.api.InsertMessage({
                  chatId: w.chatId,
                  forkId,
                  anchor: target.anchor,
                  expectedRowVersion: 0,
                  body: {
                    _tag: "Write",
                    speaker: null,
                    content: submitted.text,
                    ...(submitted.draft ? { draft: submitted.draft } : {})
                  }
                })
              )
            )
            if (result._tag === "Failure") return w.fail(`I2: an insertion failed: ${JSON.stringify(result.failure)}`)
            if (result.success.entry.version.content !== submitted.text)
              w.fail("I2: the inserted message isn't the text submitted")
            // I2: if this insertion ended the session it named, the draft held exactly its text.
            if (submitted.draft && before?.status === "active") {
              const after = row(submitted.draft.draftId)!
              const ended = after.status !== "active" || after.session !== before.session
              if (ended && before.content !== submitted.text) w.fail("I2: a commit ended a draft holding other text")
              if (ended && before.session !== submitted.draft.session)
                w.fail("I2: a commit ended a session it didn't name")
            }
            if (tab.committed(submitted)) {
              if (submitted.draft === null) await tab.discard()
              live.delete(at)
            }
          } else {
            const outcome = await tab.discard()
            if (outcome.ok) live.delete(at)
          }
        }
        for (const tab of tabs) await tab.save()
        const messages = await insertedTexts(w)
        const recovered = (await Effect.runPromise(w.api.ListRecoveredTexts({ limit: 500, before: null }))).map(
          (t) => t.content
        )
        const drafts = (await Effect.runPromise(w.api.MessageDrafts({ chatId: w.chatId }))).map((d) => d.content)
        const fields = tabs.map((tab) => tab.snapshot().text)
        for (const text of live.values())
          if (![messages, recovered, drafts, fields].some((place) => place.includes(text)))
            w.fail(`I1: "${text}" was typed and is nowhere`)
        // Cleared for the next seed. The tabs share one draft: once one discards it, the other's
        // discard is stale, and refused.
        for (const tab of tabs) await tab.discard()
      }
    }
  },
  {
    name: "an insert draft is the user's own: another chat's or fork's key is refused, and inserting commits it",
    run: async (w) => {
      const { forkId, anchor } = await insertPlace(w)
      const tab = await openInsertDraft(w, { _tag: "Insert", chatId: w.chatId, forkId, anchor })
      tab.setText("inserted from the editor")
      await tab.save()
      const submitted = await tab.ready()
      if (submitted.draft === null) w.fail("I3: the save named no draft")
      // The fork of this chat under another chat's id: no such draft target.
      const foreign = await Effect.runPromise(
        Effect.result(
          w.api.SaveMessageDraft({
            target: { _tag: "Insert", chatId: w.otherChatId, forkId, anchor },
            draftId: null,
            content: "planted",
            expectedRowVersion: null,
            expectedSession: null
          })
        )
      )
      if (foreign._tag !== "Failure") w.fail("an insert draft was saved for a fork of another chat")
      // Typed more after the insertion took its text: the draft isn't committed, and keeps it.
      tab.setText("inserted from the editor, and more")
      await tab.save()
      await Effect.runPromise(
        w.api.InsertMessage({
          chatId: w.chatId,
          forkId,
          anchor,
          expectedRowVersion: 0,
          body: { _tag: "Write", speaker: null, content: submitted.text, draft: submitted.draft! }
        })
      )
      const row = w.db.prepare("SELECT status, content FROM drafts WHERE id = ?").get(submitted.draft!.draftId) as {
        status: string
        content: string
      }
      if (row.status !== "active" || row.content !== "inserted from the editor, and more")
        w.fail("I2: an insertion committed a draft holding other text")
      if (tab.committed(submitted)) w.fail("the editor closed with text typed while it was inserted")
      // Inserted with exactly its text: committed.
      const again = await tab.ready()
      await Effect.runPromise(
        w.api.InsertMessage({
          chatId: w.chatId,
          forkId,
          anchor,
          expectedRowVersion: 0,
          body: { _tag: "Write", speaker: null, content: again.text, draft: again.draft! }
        })
      )
      const done = w.db.prepare("SELECT status FROM drafts WHERE id = ?").get(again.draft!.draftId) as {
        status: string
      }
      if (done.status !== "committed") w.fail("I2: inserting the draft's exact text didn't commit it")
      if (!tab.committed(again)) w.fail("the editor kept text it inserted")
    }
  }
]

const DIRECTED: ReadonlyArray<{ name: string; run: (w: World) => Promise<void> }> = [
  ...INSERT_DIRECTED,
  ...(["composer", "editor"] as const).flatMap((kind) =>
    (["acknowledged", "switched"] as const).map((choice) => ({
      name: `${kind} replay keeps a displaced-text notice until ${choice}`,
      run: async (w: World) => {
        const tab = w.tabs[0]!
        const old = tab.page
        const field = textField(FIELDS[0])
        if (kind === "composer") old.composer.type("saved elsewhere!")
        else old.editor.setText(FIELDS[0], "saved elsewhere!")
        await settle(w)
        old.alive = false
        const other = w.tabs[1]!.page
        if (kind === "composer") {
          other.composer.type("saved elsewhere")
          const saving = other.composer.flush()
          await settle(w)
          await saving
        } else {
          other.editor.setText(FIELDS[0], "saved elsewhere")
          const saving = other.editor.flush()
          await settle(w)
          await saving
        }
        tab.page = new Page(w, tab, old.ref, old.fork, old.follows)
        await settle(w)
        const page = tab.page
        const conflict = () => (kind === "composer" ? page.composer.snapshot().conflict : page.editor.conflict(field))
        assert.strictEqual(conflict()?.content, "saved elsewhere", "I5: replay must tell the user what it displaced")
        if (kind === "composer") page.composer.type("saved elsewhere!!")
        else page.editor.setText(FIELDS[0], "saved elsewhere!!")
        const saving = kind === "composer" ? page.composer.flush() : page.editor.flush()
        await settle(w)
        await saving
        assert.strictEqual(conflict()?.content, "saved elsewhere", "I5: typing must not dismiss the conflict")
        const refreshing = page.editor.refresh()
        await settle(w)
        await refreshing
        assert.strictEqual(conflict()?.content, "saved elsewhere", "I5: refresh must not dismiss the conflict")
        if (choice === "acknowledged") {
          if (kind === "composer") page.composer.acknowledgeConflict()
          else page.editor.acknowledgeConflict(field)
          assert.isNull(conflict())
          assert.strictEqual(
            kind === "composer" ? page.composer.snapshot().text : page.editor.text(FIELDS[0]),
            "saved elsewhere!!"
          )
          return
        }
        const switching = kind === "composer" ? page.composer.switchConflict() : page.editor.switchConflict(field)
        await settle(w)
        await switching
        assert.isNull(conflict())
        assert.strictEqual(
          kind === "composer" ? page.composer.snapshot().text : page.editor.text(FIELDS[0]),
          "saved elsewhere"
        )
        const states = kind === "composer" ? page.composer.history() : page.editor.history(field)
        await settle(w)
        const history = await states
        assert.isTrue(history.ok)
        if (!history.ok) return
        const undo = kind === "composer" ? page.composer.restore(history.value[1]!.seq) : page.editor.undo(field)
        await settle(w)
        await undo
        assert.strictEqual(
          kind === "composer" ? page.composer.snapshot().text : page.editor.text(FIELDS[0]),
          "saved elsewhere!!"
        )
      }
    }))
  ),
  {
    name: "a send in another chat leaves the source composer active",
    run: async (w) => {
      const opened = await Effect.runPromise(w.api.OpenComposer({ chatId: w.chatId, forkId: null }))
      const saved = await Effect.runPromise(
        w.api.SaveComposer({
          chatId: w.chatId,
          draftId: opened.id,
          rowVersion: opened.rowVersion,
          session: opened.session,
          operationId: crypto.randomUUID(),
          next: false,
          content: "Source chat text"
        })
      )
      const draft = saved.draft!
      await request(w, "SendMessage", {
        chatId: w.otherChatId,
        parentSlotId: null,
        branch: false,
        content: draft.content,
        composer: { draftId: draft.id, session: draft.session }
      })
      const after = await Effect.runPromise(w.api.OpenComposer({ chatId: w.chatId, forkId: null }))
      if (after.content !== draft.content || after.session !== draft.session)
        w.fail("I2: another chat committed the source draft")
    }
  },
  {
    name: "recovery and logout exclude another copy owner",
    run: async (w) => {
      const payload = {
        refId: w.otherRef,
        field: textField(FIELDS[0]),
        draftId: null,
        expectedRowVersion: null,
        expectedSession: null,
        baseRevisionId: null,
        content: "Other owner's only browser copy"
      }
      const copy = makeCopy(OTHER_USER, w.otherRef, payload.field, { kind: "editor", payload }, w.now())
      w.live.add(copy.content)
      await keepCopy(copy)
      if ((await w.copies(USER)).length !== 0) w.fail("I4: another owner's recovery text was visible")
      await w.recoverOwner(USER)
      if (!(await w.copies(OTHER_USER)).some((c) => c.key === copy.key))
        w.fail("I4: logout removed another owner's copy")
      await w.recoverOwner(OTHER_USER)
      if ((await w.copies(OTHER_USER)).length !== 0) w.fail("I4: acknowledged recovery copy stayed")
    }
  },
  {
    name: "refresh and an in-flight save keep later typing on its original field base",
    run: async (w) => {
      const page = w.tabs[0]!.page
      const store = page.editor
      const field = textField(FIELDS[0])
      const opened = store.snapshot!
      const draft = await Effect.runPromise(
        w.api.SaveEditorDraft({
          refId: page.ref,
          field,
          draftId: null,
          expectedRowVersion: null,
          expectedSession: null,
          baseRevisionId: opened.ref.headRevisionId,
          content: "original"
        })
      )
      const refreshing = store.refresh()
      await settle(w)
      await refreshing
      store.setText(FIELDS[0], "original typed")
      await Effect.runPromise(
        w.api.SaveEditorDraft({
          refId: page.ref,
          field,
          draftId: draft.id,
          expectedRowVersion: draft.rowVersion,
          expectedSession: draft.session,
          baseRevisionId: opened.ref.headRevisionId,
          content: "other tab unseen"
        })
      )
      const refresh = store.refresh()
      await settle(w)
      await refresh
      const saving = store.flush()
      // Hold the save before the network delivers it, then type further.
      const held = w.net.ready.splice(0)
      store.setText(FIELDS[0], "original typed more")
      const copies = await w.copies(USER)
      const later = copies.find((copy) => copy.content === "original typed more")
      if (later?.save.kind !== "editor" || later.save.payload.expectedRowVersion !== draft.rowVersion)
        w.fail("I3: refresh rebased unsaved typing on unseen text")
      w.net.ready.push(...held)
      await settle(w)
      await saving
      const flush = store.flush()
      await settle(w)
      await flush
    }
  },
  {
    name: "a next save spanning two completed sends cannot replace the third session",
    run: async (w) => {
      const chat = await Effect.runPromise(w.api.CreateChat({ title: "Two queued sessions" }))
      const parent = await Effect.runPromise(w.api.Generate({ chatId: chat.id, parentSlotId: null, branch: false }))
      if (parent._tag !== "Posted") return w.fail("I2: queued-send parent did not post")
      const tip = parent.entry.slotId
      const save = async (content: string) => {
        const d = await Effect.runPromise(w.api.OpenComposer({ chatId: chat.id, forkId: null }))
        return (
          await Effect.runPromise(
            w.api.SaveComposer({
              chatId: chat.id,
              draftId: d.id,
              rowVersion: d.rowVersion,
              session: d.session,
              operationId: crypto.randomUUID(),
              next: false,
              content
            })
          )
        ).draft!
      }
      const first = await save("first queued text")
      const a = await Effect.runPromise(
        w.api.SendMessage({
          chatId: chat.id,
          parentSlotId: tip,
          branch: false,
          content: first.content,
          composer: { draftId: first.id, session: first.session }
        })
      )
      const second = await save("second queued direction")
      const b = await Effect.runPromise(
        w.api.Generate({
          chatId: chat.id,
          parentSlotId: tip,
          branch: false,
          direction: second.content,
          composer: { draftId: second.id, session: second.session }
        })
      )
      if (a._tag !== "Queued" || b._tag !== "Queued") w.fail("I2: the two sends did not queue")
      const third = await save("third session typing")
      const content = "next text from the first queued send"
      const result = await Effect.runPromise(
        w.api.SaveComposer({
          chatId: chat.id,
          draftId: first.id,
          rowVersion: first.rowVersion,
          session: first.session,
          operationId: crypto.randomUUID(),
          next: true,
          content
        })
      )
      if (result.draft?.content !== third.content || result.draft.session !== third.session)
        w.fail("I3: a late next save crossed two ended sessions")
      if (!result.recovered || result.draft?.recovered !== 1) w.fail("I5: late next recovery was not reported")
      const recovered = await Effect.runPromise(w.api.ListRecoveredTexts({ limit: 100, before: null }))
      if (!recovered.some((t) => t.content === content)) w.fail("I1: late next text was not recovered")
      const queue = await Effect.runPromise(w.api.ListQueued({ chatId: chat.id }))
      if (
        !queue.some((entry) => entry.content === first.content) ||
        !queue.some((entry) => entry.direction === second.content)
      )
        w.fail("I2: queued send text changed")
    }
  },
  {
    name: "an older save cannot rebase text typed after Send cleared the box",
    run: async (w) => {
      const page = w.tabs[0]!.page
      const first = `First ${w.newToken()}`
      page.composer.type(first)
      w.live.add(first)
      const saving = page.composer.flush()
      for (let tries = 0; tries < 100 && w.net.ready.length === 0; tries++)
        await new Promise((resolve) => setImmediate(resolve))
      const oldSave = w.net.ready.shift()!
      if (oldSave?.tag !== "SaveComposer") w.fail("directed old save was not captured")
      page.composer.type(`${first} plus`)
      w.live.add(`${first} plus`)
      const sending = page.composer.submit(async (from) => {
        const result = await page.call((c: never) =>
          (c as (tag: string, payload: unknown) => unknown)("SendMessage", {
            chatId: w.chatId,
            forkId: from.fork,
            parentSlotId: w.tipOf(from.fork),
            branch: false,
            content: from.text,
            composer: { draftId: from.draftId, session: from.session }
          })
        )
        if (!result.ok) return { sent: false }
        const value = result.value as { _tag: string; entry: { slotId: SlotId }; draft: never; recovered: number }
        if (value._tag !== "Posted") w.fail("directed send did not post")
        return { sent: true, draft: value.draft, recovered: value.recovered }
      })
      const next = `Next ${w.newToken()}`
      page.composer.type(next)
      w.live.add(next)
      w.net.ready.push(oldSave)
      await settle(w)
      await saving
      await sending
      const keeping = page.composer.flush()
      await settle(w)
      await keeping
      w.check(false)
    }
  },
  {
    name: "copy replacements survive overlapping completion callbacks",
    run: async (w) => {
      const opened = await Effect.runPromise(w.api.OpenEditor({ refId: w.noteRef }))
      const payload = {
        refId: w.noteRef,
        field: textField(FIELDS[0]),
        draftId: null,
        expectedRowVersion: null,
        expectedSession: null,
        baseRevisionId: opened.ref.headRevisionId,
        content: "first"
      }
      const first = makeCopy(USER, w.noteRef, payload.field, { kind: "editor", payload }, w.now())
      const second = makeCopy(
        USER,
        w.noteRef,
        payload.field,
        { kind: "editor", payload: { ...payload, content: "second" } },
        w.now(),
        [first]
      )
      const third = makeCopy(
        USER,
        w.noteRef,
        payload.field,
        { kind: "editor", payload: { ...payload, content: "third" } },
        w.now(),
        [second]
      )
      await keepCopy(first)
      await Promise.all([keepCopy(second, first), keepCopy(third, second)])
      await request(w, "SaveEditorDraft", third.save.payload, w.tabs[0]!.page.editor)
      await dropCopy(third)
      w.check(true)
      const orphan = makeCopy(
        USER,
        w.noteRef,
        payload.field,
        { kind: "editor", payload: { ...payload, content: "orphan" } },
        w.now()
      )
      const unrelated = makeCopy(
        USER,
        w.noteRef,
        textField(FIELDS[1]),
        { kind: "editor", payload: { ...payload, field: textField(FIELDS[1]) } },
        w.now(),
        [orphan]
      )
      assert.throws(
        () =>
          w.completed({
            put: [unrelated as unknown as Record<string, unknown> & { key: string }],
            deleted: [orphan as unknown as Record<string, unknown> & { key: string }]
          }),
        "I4:"
      )
    }
  },
  {
    name: "an acknowledged successor remains proof after its copy is removed",
    run: async (w) => {
      const opened = await Effect.runPromise(w.api.OpenEditor({ refId: w.noteRef }))
      const payload = {
        refId: w.noteRef,
        field: textField(FIELDS[0]),
        draftId: null,
        expectedRowVersion: null,
        expectedSession: null,
        baseRevisionId: opened.ref.headRevisionId,
        content: "unacknowledged predecessor"
      }
      const before = makeCopy(USER, w.noteRef, payload.field, { kind: "editor", payload }, w.now())
      const successor = makeCopy(
        USER,
        w.noteRef,
        payload.field,
        { kind: "editor", payload: { ...payload, content: "unacknowledged predecessor plus live changes" } },
        w.now(),
        [before]
      )
      await keepCopy(before)
      await keepCopy(successor)
      await request(w, "SaveEditorDraft", successor.save.payload, w.tabs[0]!.page.editor)
      await dropCopy(successor)
      await dropCopy(before)
      w.check(true)
    }
  },
  {
    name: "exact whitespace through keepalive and reload",
    run: async (w) => {
      const tab = w.tabs[0]!
      const text = `  full text ${w.newToken()}\n\n`
      w.live.add(text)
      tab.page.composer.type(text)
      tab.page.composer.beacon()
      await settle(w)
      const old = tab.page
      old.alive = false
      tab.page = new Page(w, tab, old.ref, old.fork, old.follows)
      await settle(w)
      w.check(false)
    }
  },
  {
    name: "commit session and stored destination",
    run: async (w) => {
      const leaf = w.leaf()
      const draft = await Effect.runPromise(w.api.OpenComposer({ chatId: w.chatId, forkId: null }))
      const text = "identical across sessions"
      await request(w, "SaveComposer", {
        chatId: w.chatId,
        draftId: draft.id,
        rowVersion: draft.rowVersion,
        session: draft.session,
        next: false,
        operationId: crypto.randomUUID(),
        content: text
      })
      await request(w, "SendMessage", {
        chatId: w.chatId,
        parentSlotId: leaf,
        branch: false,
        content: text,
        composer: { draftId: draft.id, session: draft.session }
      })
      const next = await Effect.runPromise(w.api.OpenComposer({ chatId: w.chatId, forkId: null }))
      await request(w, "SaveComposer", {
        chatId: w.chatId,
        draftId: next.id,
        rowVersion: next.rowVersion,
        session: next.session,
        next: false,
        operationId: crypto.randomUUID(),
        content: text
      })
      await request(w, "SendMessage", {
        chatId: w.chatId,
        parentSlotId: leaf,
        branch: true,
        content: text,
        composer: { draftId: draft.id, session: draft.session }
      })
    }
  },
  {
    name: "receipts replay exactly once across server restart",
    run: async (w) => {
      const draft = await Effect.runPromise(w.api.OpenComposer({ chatId: w.chatId, forkId: null }))
      const payload = {
        chatId: w.chatId,
        draftId: draft.id,
        rowVersion: draft.rowVersion,
        session: draft.session,
        next: true,
        operationId: "directed-restart",
        content: "saved once"
      }
      await request(w, "SaveComposer", payload)
      await request(w, "SendMessage", {
        chatId: w.chatId,
        parentSlotId: w.leaf(),
        branch: false,
        content: payload.content,
        composer: { draftId: draft.id, session: draft.session }
      })
      await w.restart()
      await request(w, "SaveComposer", payload)
    }
  },
  {
    name: "background append keeps full text reachable at the leaf",
    run: async (w) => {
      const draft = await Effect.runPromise(w.api.OpenComposer({ chatId: w.chatId, forkId: null }))
      const text = "  unfinished paragraph\n"
      w.live.add(text)
      await request(w, "SaveComposer", {
        chatId: w.chatId,
        draftId: draft.id,
        rowVersion: draft.rowVersion,
        session: draft.session,
        next: false,
        operationId: crypto.randomUUID(),
        content: text
      })
      const before = w.leaf()
      await request(w, "SendMessage", { chatId: w.chatId, parentSlotId: before, branch: false, content: "background" })
      follow(w)
      await settle(w)
      w.check(false)
    }
  },
  { name: "chat purge recovers queued directions", run: (w) => purgeQueue(w, false) },
  { name: "branch purge recovers queued directions", run: (w) => purgeQueue(w, true) },
  {
    name: "history retention reports recovery with the writer clock advanced",
    run: async (w) => {
      const draft = await Effect.runPromise(w.api.OpenComposer({ chatId: w.chatId, forkId: null }))
      for (let index = 0; index < 1003; index++) {
        w.wait(61_000)
        await request(w, "SaveComposer", {
          chatId: w.chatId,
          draftId: draft.id,
          rowVersion: draft.rowVersion,
          session: draft.session,
          next: false,
          operationId: crypto.randomUUID(),
          content: `retained ${index}`
        })
      }
      if (w.recoveredCount() === 0) w.fail("I5: directed retention never recovered an earlier state")
    }
  }
]

for (const scenario of DIRECTED) {
  it.live(
    `directed draft protocol: ${scenario.name}`,
    () =>
      Effect.gen(function* () {
        const run = yield* runOnce([], async (w) => {
          w.net.reliable = true
          await scenario.run(w)
        })
        if (run.violation !== null) assert.fail(`${run.violation.message}\n${run.lines.join("\n")}`)
      }),
    { timeout: 120_000 }
  )
}

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
