// A chat session's window against events that arrive while a read is in flight: the
// server may answer the read from before them, and the reply mustn't undo them.
import type {
  Chat,
  ChatId,
  ForkId,
  PathEntry,
  QueuedMessage,
  SlotId,
  Version,
  VersionId
} from "@dreamspan/shared/chat.ts"
import type { LcmState } from "@dreamspan/shared/lcm.ts"
import type { ChatEvent, PathWindow } from "@dreamspan/shared/chatApi.ts"
import { Cast } from "@dreamspan/shared/chatSetupApi.ts"
import { NotFound } from "@dreamspan/shared/errors.ts"
import { Effect } from "effect"
import { AtomRegistry } from "effect/reactivity"
import { describe, expect, it, vi } from "vitest"
import { onAttachRequest, requestAttach } from "../src/features/chat/fileAttachments.ts"
import { AUTO_POLICY, planReply, replyPolicies } from "../src/features/chat/replyPolicy.ts"
import type { AppClient } from "../src/rpc.ts"

// rpc.ts reads the page's location when imported.
vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1" })
const { ChatSession, liveReasoning, liveSections, liveSteps, liveText } =
  await import("../src/features/chat/session.ts")

const chatId = "chat-1" as ChatId
const chat = {
  id: chatId,
  kind: "rp",
  status: "active",
  title: "Harbor",
  activeLeafSlotId: "s2",
  rowVersion: 3,
  createdAt: 0,
  lastMessageAt: 0
} as unknown as Chat

const version = (id: string, slotId: string, status: Version["status"], content: string) =>
  ({
    id: id as VersionId,
    slotId: slotId as SlotId,
    ordinal: 0,
    status,
    speakerEntityId: null,
    writer: "model",
    content,
    macroMode: "verbatim",
    origin: "generated",
    sourceVersionId: null,
    direction: null,
    hidden: false,
    starred: false,
    createdAt: 0,
    error: null,
    mark: null,
    rowVersion: 1
  }) as unknown as Version

const entry = (slot: string, parent: string | null, v: Version, rowVersion = 1) =>
  ({
    slotId: slot as SlotId,
    parentSlotId: parent as SlotId | null,
    depth: parent === null ? 0 : 1,
    rowVersion,
    contextExcluded: false,
    hiddenByUser: false,
    version: v,
    versionCount: 1,
    inContext: v.content.length > 0
  }) as unknown as PathEntry

const window = (entries: Array<PathEntry>) =>
  ({ leafSlotId: entries.at(-1)!.slotId, entries, older: null, newer: null }) as unknown as PathWindow

/** A session whose reads wait until the test answers them. */
const session = (notice?: (title: string) => void, stubRead = true) => {
  const registry = AtomRegistry.make()
  const s = new ChatSession(chatId, null, registry, "user", notice)
  const answers: Array<(window: PathWindow) => void> = []
  const internals = s as unknown as {
    read: () => Promise<PathWindow>
    refreshContext: () => Promise<void>
    refreshEditors: () => Promise<void>
    call: () => Promise<unknown>
    receive: (batch: ReadonlyArray<ChatEvent>, anchor: SlotId | null) => void
    flush: () => void
  }
  internals.refreshContext = async () => {}
  // The message editors' drafts are read with their own call, which the stub doesn't answer.
  internals.refreshEditors = async () => {}
  if (stubRead) internals.read = () => new Promise((answer) => answers.push(answer))
  internals.call = () => Promise.resolve({ ok: true, value: chat })
  return {
    s,
    registry,
    answers,
    receive: (event: ChatEvent) => internals.receive([event], null),
    flush: () => internals.flush()
  }
}

const first = entry("s1", null, version("v1", "s1", "complete", "Hello."))
const reply = version("v2", "s2", "generating", "The tide")
const second = entry("s2", "s1", reply)

const boundCast = (macroBindings: Record<string, string> = {}) =>
  new Cast({
    slotId: null,
    participants: [],
    absent: [],
    playedByMe: [],
    model: null,
    preset: null,
    lorebooks: [],
    cardLorebooksOff: [],
    listedLorebooks: [],
    loreBelowHistory: true,
    macroBindings,
    macroNames: { user: macroBindings.user ?? "User", char: macroBindings.char ?? "Mira" },
    rolesProjection: null,
    roleProjections: [],
    cards: []
  })

describe("ChatSession", () => {
  it("does not rename the physical chat when the split lookup fails", async () => {
    const { s, registry } = session()
    const error = { tag: "ServerError", message: "Split lookup failed", problems: [], reason: null } as const
    const call = vi.spyOn(s, "call").mockResolvedValueOnce({ ok: false, error })
    try {
      expect(await s.rename("A different split title")).toEqual({ ok: false, error })
      expect(call).toHaveBeenCalledOnce()
    } finally {
      s.dispose()
      registry.dispose()
    }
  })

  it("Stop during a reply hook sends no Generate request", async () => {
    const { replyHooks } = await import("../src/features/chat/replyHooks.ts")
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const remove = replyHooks.register({ id: "test.auto-consent", beforeReply: () => pending })
    const { s, registry } = session()
    const call = vi.spyOn(s, "call")
    let allowed = true
    try {
      const result = s.generate(null, null, "", undefined, [], false, { allowed: () => allowed, token: null })
      allowed = false
      release()
      expect(await result).toMatchObject({ ok: false, error: { tag: "Cancelled" } })
      expect(call).not.toHaveBeenCalled()
    } finally {
      remove()
      registry.dispose()
    }
  })

  it("ignores another branch's State, Reload and Lcm before refreshing positions or reads", () => {
    const { s, receive } = session()
    const internals = s as unknown as {
      view: ReturnType<typeof s.snapshot>
      refreshCast: () => void
      scheduleLcm: () => void
      reload: () => void
    }
    internals.view = { ...s.snapshot(), forkId: "here" as ForkId }
    internals.refreshCast = vi.fn()
    internals.scheduleLcm = vi.fn()
    internals.reload = vi.fn()
    const positions = vi.fn()
    s.subscribePositions(positions)
    for (const _tag of ["State", "Reload", "Lcm"] as const) receive({ _tag, forkId: "elsewhere" as ForkId })
    expect(positions).not.toHaveBeenCalled()
    expect(internals.refreshCast).not.toHaveBeenCalled()
    expect(internals.scheduleLcm).not.toHaveBeenCalled()
    expect(internals.reload).not.toHaveBeenCalled()
    receive({ _tag: "State", forkId: "here" as ForkId })
    expect(positions).toHaveBeenCalledOnce()
    expect(internals.refreshCast).toHaveBeenCalledOnce()
    expect(internals.scheduleLcm).toHaveBeenCalledOnce()
    s.dispose()
  })

  it("closing one view preserves another view's live text and reasoning", () => {
    const registry = AtomRegistry.make()
    const first = new ChatSession(chatId, null, registry, "user")
    const second = new ChatSession(chatId, null, registry, "user")
    const live = (s: InstanceType<typeof ChatSession>) => s as unknown as { track: (version: Version) => void }
    live(first).track(reply)
    live(second).track(reply)
    registry.set(liveText(reply.id), "The tide is rising")
    registry.set(liveReasoning(reply.id), "Keep writing")
    first.dispose()
    expect(registry.get(liveText(reply.id))).toBe("The tide is rising")
    expect(registry.get(liveReasoning(reply.id))).toBe("Keep writing")
    second.dispose()
    expect(registry.get(liveText(reply.id))).toBeNull()
    registry.dispose()
  })

  it("keeps shared live text ordered when a split view delivers an older rewrite or snapshot", () => {
    vi.stubGlobal("requestAnimationFrame", () => 1)
    vi.stubGlobal("cancelAnimationFrame", () => {})
    const registry = AtomRegistry.make()
    const first = new ChatSession(chatId, null, registry, "user")
    const second = new ChatSession(chatId, null, registry, "user")
    vi.spyOn(first, "open").mockResolvedValue(undefined)
    vi.spyOn(second, "open").mockResolvedValue(undefined)
    const receive = (view: InstanceType<typeof ChatSession>, ...events: Array<ChatEvent>) => {
      const session = view as unknown as { receive: (batch: Array<ChatEvent>, anchor: null) => void; flush: () => void }
      session.receive(events, null)
      session.flush()
    }
    const versionId = reply.id
    const original = { _tag: "Hello", live: [{ versionId, text: "The tide <cot>plan", sequence: 1 }] } as const
    const rewrite = { _tag: "Delta", versionId, offset: 8, text: "", replace: true, sequence: 2 } as const
    receive(first, original, rewrite, { _tag: "Delta", versionId, offset: 8, text: " turned.", sequence: 3 })
    receive(second, original, rewrite)
    expect(registry.get(liveText(versionId))).toBe("The tide turned.")

    // A newer snapshot can shorten the text. An earlier delta or snapshot must not restore it.
    receive(first, { _tag: "Hello", live: [{ versionId, text: "The tide", sequence: 4 }] })
    receive(second, { _tag: "Delta", versionId, offset: 8, text: " turned.", sequence: 3 })
    expect(registry.get(liveText(versionId))).toBe("The tide")
    first.dispose()
    second.dispose()
    registry.dispose()
  })

  it("reads a shared message's cast in the new fork when position subscribers recheck synchronously", async () => {
    vi.useFakeTimers()
    const { s } = session()
    const requests: Array<string | null> = []
    const current = boundCast({ user: "New fork" })
    const internals = s as unknown as {
      view: ReturnType<typeof s.snapshot>
      call: (
        request: (client: (method: string, payload: { forkId: string | null }) => unknown) => unknown
      ) => Promise<unknown>
    }
    internals.view = { ...s.snapshot(), forkId: "old" as ForkId }
    internals.call = async (request) => ({
      ok: true,
      value: request((method, payload) => {
        if (method !== "GetCasts") return chat
        requests.push(payload.forkId)
        return [current]
      })
    })
    // useSyncExternalStore checks its snapshot in the subscription callback, before a render.
    const unsubscribe = s.subscribePositions(() => s.castAfter(first.slotId))
    try {
      s.showFork("new" as ForkId, null)
      await vi.advanceTimersByTimeAsync(0)
      expect(requests).toEqual(["new"])
      expect(s.castAfter(first.slotId)).toBe(current)
    } finally {
      unsubscribe()
      s.dispose()
      vi.useRealTimers()
    }
  })

  it("bounds retained historical casts while keeping observed positions and their identities", async () => {
    vi.useFakeTimers()
    const { s } = session()
    const calls: Array<Array<SlotId | null>> = []
    const internals = s as unknown as {
      call: (
        rpc: (client: (name: string, input: { slotIds: Array<SlotId | null> }) => unknown) => unknown
      ) => Promise<unknown>
      positionCasts: Map<string, Cast | "loading">
    }
    const casts = new Map<string, Cast>()
    internals.call = async (rpc) => ({
      ok: true,
      value: rpc((_name, input) => {
        calls.push(input.slotIds)
        return input.slotIds.map((slot) => {
          const cast = boundCast({ user: `At ${slot}` })
          casts.set(slot ?? "", cast)
          return cast
        })
      })
    })
    const retain = (s as unknown as { subscribePosition?: (slot: SlotId, listener: () => void) => () => void })
      .subscribePosition
    const stops = Array.from({ length: 550 }, (_, n) =>
      retain ? retain(`p${n}` as SlotId, () => {}) : s.subscribePositions(() => {})
    )
    try {
      for (let n = 0; n < 2000; n++) {
        s.castAfter(`p${n}` as SlotId)
        if (n % 100 === 99) await vi.advanceTimersByTimeAsync(0)
      }
      expect(internals.positionCasts.size).toBe(550)
      const reads = calls.length
      for (let n = 0; n < 550; n++) expect(s.castAfter(`p${n}` as SlotId)).toBe(casts.get(`p${n}`))
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toHaveLength(reads)
      for (const stop of stops.splice(0)) stop()
      expect(internals.positionCasts.size).toBeLessThanOrEqual(500)
      expect(s.castAfter("p550" as SlotId)).toBeUndefined()
      await vi.advanceTimersByTimeAsync(0)
      expect(s.castAfter("p550" as SlotId)).toBe(casts.get("p550"))
    } finally {
      for (const stop of stops) stop()
      s.dispose()
      vi.useRealTimers()
    }
  })

  for (const stale of ["success", "failure"] as const)
    it(`ignores a positional cast batch's stale ${stale} after a state change`, async () => {
      vi.useFakeTimers()
      const { s, receive } = session()
      try {
        const answers: Array<(value: unknown) => void> = []
        const internals = s as unknown as {
          call: () => Promise<unknown>
          refreshCast: () => Promise<void>
          scheduleLcm: () => void
        }
        internals.call = () => new Promise((resolve) => answers.push(resolve))
        internals.refreshCast = async () => {}
        internals.scheduleLcm = () => {}
        const original = boundCast({ user: "Before" })
        const current = boundCast({ user: "After" })
        s.castAfter(first.slotId)
        await vi.advanceTimersByTimeAsync(0)
        receive({ _tag: "State" })
        s.castAfter(first.slotId)
        await vi.advanceTimersByTimeAsync(0)
        expect(answers).toHaveLength(2)
        answers[1]!({ ok: true, value: [current] })
        await Promise.resolve()
        expect(s.castAfter(first.slotId)).toBe(current)
        answers[0]!(stale === "success" ? { ok: true, value: [original] } : { ok: false })
        await Promise.resolve()
        expect(s.castAfter(first.slotId)).toBe(current)
      } finally {
        s.dispose()
        vi.useRealTimers()
      }
    })

  for (const change of ["state", "dispose"] as const)
    it(`drops a queued positional cast batch on ${change}`, async () => {
      vi.useFakeTimers()
      const { s, receive } = session()
      try {
        const call = vi.fn(async () => ({ ok: true, value: [] }))
        const internals = s as unknown as {
          call: () => Promise<unknown>
          refreshCast: () => Promise<void>
          scheduleLcm: () => void
        }
        internals.call = call
        internals.refreshCast = async () => {}
        internals.scheduleLcm = () => {}
        s.castAfter(first.slotId)
        if (change === "state") receive({ _tag: "State" })
        else s.dispose()
        await vi.advanceTimersByTimeAsync(0)
        expect(call).not.toHaveBeenCalled()
      } finally {
        s.dispose()
        vi.useRealTimers()
      }
    })

  for (const moved of ["fork", "leaf", "disposed"] as const) {
    it(`does not apply a prompt-name pin's old cast after the view is ${moved}`, async () => {
      const { s } = session()
      const internals = s as unknown as {
        view: ReturnType<typeof s.snapshot>
        call: () => Promise<unknown>
      }
      const original = boundCast()
      const changed = boundCast({ user: "Captain" })
      let answer!: (value: unknown) => void
      internals.call = () => new Promise((resolve) => (answer = resolve))
      internals.view = { ...s.snapshot(), forkId: "old" as ForkId, leafSlotId: first.slotId, cast: original }
      const saving = s.changeCast({ _tag: "MacroBinding", name: "user", value: "Captain" })
      if (moved === "disposed") s.dispose()
      else
        internals.view = {
          ...s.snapshot(),
          ...(moved === "fork" ? { forkId: "new" as ForkId } : { leafSlotId: second.slotId })
        }
      answer({ ok: true, value: changed })
      await saving
      expect(s.snapshot().cast).toBe(original)
      s.dispose()
    })
  }

  for (const state of ["visible", "hidden", "failed", "removed"] as const) {
    it(`keeps image-only context eligibility correct on a ${state} version event`, async () => {
      const { s, answers, receive } = session()
      const opening = s.open(null)
      const image = { mediaId: "synthetic-image" }
      const original = entry("s1", null, { ...first.version, content: "", images: [image] } as Version)
      answers[0]!(window([{ ...original, contextExcluded: state === "hidden", inContext: state !== "hidden" }]))
      await opening
      receive({
        _tag: "Version",
        version: {
          ...original.version,
          rowVersion: 2,
          status: state === "failed" ? "failed" : "complete",
          images: state === "removed" ? [] : [image]
        } as Version
      })
      expect(s.snapshot().entries[0]!.inContext).toBe(state === "visible")
      s.dispose()
    })
  }

  it("does not let an older prompt-name save overwrite the later pin", async () => {
    const { s } = session()
    const internals = s as unknown as { call: () => Promise<unknown> }
    const answers: Array<(value: unknown) => void> = []
    internals.call = () => new Promise((resolve) => answers.push(resolve))
    const user = s.changeCast({ _tag: "MacroBinding", name: "user", value: "Captain" })
    const char = s.changeCast({ _tag: "MacroBinding", name: "char", value: "Narrator" })
    const latest = boundCast({ user: "Captain", char: "Narrator" })
    answers[1]!({ ok: true, value: latest })
    await vi.waitFor(() => expect(answers).toHaveLength(3))
    answers[2]!({ ok: true, value: latest })
    await char
    answers[0]!({ ok: true, value: boundCast({ user: "Captain" }) })
    await vi.waitFor(() => expect(answers).toHaveLength(4))
    answers[3]!({ ok: true, value: latest })
    await user
    expect(s.snapshot().cast).toBe(latest)
    s.dispose()
  })

  it("drops a pin's refreshed cast after switching forks", async () => {
    const { s } = session()
    const internals = s as unknown as {
      view: ReturnType<typeof s.snapshot>
      call: () => Promise<unknown>
    }
    const answers: Array<(value: unknown) => void> = []
    internals.call = () => new Promise((resolve) => answers.push(resolve))
    const original = boundCast()
    const changed = boundCast({ user: "Captain" })
    internals.view = { ...s.snapshot(), forkId: "old" as ForkId, cast: original }
    const saving = s.changeCast({ _tag: "MacroBinding", name: "user", value: "Captain" })
    answers[0]!({ ok: true, value: changed })
    await vi.waitFor(() => expect(answers).toHaveLength(2))
    internals.view = { ...s.snapshot(), forkId: "new" as ForkId }
    answers[1]!({ ok: true, value: changed })
    await saving
    expect(s.snapshot().cast).toBe(original)
    s.dispose()
  })

  it("a failed prompt-name save leaves an in-flight cast read valid", async () => {
    const { s } = session()
    const internals = s as unknown as {
      call: () => Promise<unknown>
      refreshCast: () => Promise<void>
    }
    const answers: Array<(value: unknown) => void> = []
    internals.call = () => new Promise((resolve) => answers.push(resolve))
    const reading = internals.refreshCast()
    const saving = s.changeCast({ _tag: "MacroBinding", name: "user", value: "Captain" })
    answers[1]!({ ok: false, error: { message: "Synthetic save failure" } })
    await saving
    const latest = boundCast({ char: "Narrator" })
    answers[0]!({ ok: true, value: latest })
    await reading
    expect(s.snapshot().cast).toBe(latest)
    s.dispose()
  })

  for (const queued of [false, true]) {
    it(`a disabled reply policy sends reply=false for ${queued ? "queued" : "immediate"} messages`, async () => {
      const { s } = session()
      const requests: Array<{ method: string; payload: Record<string, unknown> }> = []
      type StubClient = (method: string, payload: Record<string, unknown>) => Promise<unknown>
      const internals = s as unknown as {
        call: (run: (client: StubClient) => Promise<unknown>) => Promise<unknown>
        appended: () => void
      }
      internals.appended = () => {}
      internals.call = async (run) => ({
        ok: true,
        value: await run(async (method, payload) => {
          requests.push({ method, payload })
          return { _tag: queued ? "Queued" : "Posted", queue: [], entry: first, chat, draft: null, recovered: 0 }
        })
      })
      const undo = replyPolicies.disable(AUTO_POLICY)
      try {
        const plan = planReply(null, [], null, null)
        const outcome = await s.send("Synthetic message.", null, plan.replier, undefined, plan.reply)
        expect(outcome.sent).toBe(true)
        expect(requests).toHaveLength(1)
        expect(requests[0]!.method).toBe("SendMessage")
        expect(requests[0]!.payload.reply).toBe(false)
      } finally {
        undo()
        s.dispose()
      }
    })
  }

  it("drops an LCM read from another fork sharing the same tip", async () => {
    const { s } = session()
    const internals = s as unknown as {
      view: ReturnType<typeof s.snapshot>
      refreshLcm: () => Promise<void>
      call: () => Promise<unknown>
    }
    const answers: Array<(value: unknown) => void> = []
    internals.call = () => new Promise((answer) => answers.push(answer))
    const leafSlotId = "shared-tip" as SlotId
    internals.view = { ...s.snapshot(), forkId: "old" as ForkId, leafSlotId }
    const old = internals.refreshLcm()
    internals.view = { ...s.snapshot(), forkId: "new" as ForkId, leafSlotId }
    const current = internals.refreshLcm()
    answers[0]!({ ok: true, value: { enabled: false, leafSlotId } as LcmState })
    await old
    expect(s.snapshot().lcm).toBeNull()
    answers[1]!({ ok: true, value: { enabled: true, leafSlotId } as LcmState })
    await current
    expect(s.snapshot().lcm?.enabled).toBe(true)
    s.dispose()
  })

  it("shares an in-flight next-context read with a Continue waiting for capability", async () => {
    const registry = AtomRegistry.make()
    const s = new ChatSession(chatId, null, registry, "user")
    const internals = s as unknown as {
      view: ReturnType<typeof s.snapshot>
      refreshContext: () => Promise<void>
      call: () => Promise<unknown>
    }
    let answer!: (value: unknown) => void
    const call = vi.fn(() => new Promise((done) => (answer = done)))
    internals.call = call
    internals.view = { ...s.snapshot(), loading: false }
    const reading = internals.refreshContext()
    const waiting = s.ensureNextContext()
    expect(call).toHaveBeenCalledOnce()
    answer({
      ok: true,
      value: { leafSlotId: null, warmth: null, historyStart: null, summarizedThrough: null, model: null }
    })
    await reading
    expect(await waiting).toBe(true)
    expect(s.snapshot().history?.model).toBeNull()
    // A completed read isn't reused after another request needs a fresh context.
    const next = s.ensureNextContext()
    expect(call).toHaveBeenCalledTimes(2)
    s.dispose()
    answer({ ok: false })
    expect(await next).toBe(false)
    registry.dispose()
  })

  it("reads its own context instead of applying another fork's Cache event at the same tip", () => {
    const { s, receive } = session()
    const internals = s as unknown as { view: ReturnType<typeof s.snapshot>; refreshContext: () => Promise<void> }
    const leafSlotId = "shared-tip" as SlotId
    internals.view = { ...s.snapshot(), forkId: "viewed" as ForkId, leafSlotId }
    const refresh = vi.fn(async () => {})
    internals.refreshContext = refresh
    receive({
      _tag: "Cache",
      forkId: "other" as ForkId,
      leafSlotId,
      warmth: null,
      historyStart: null,
      summarizedThrough: null
    })
    expect(s.snapshot().history).toBeNull()
    expect(refresh).toHaveBeenCalledOnce()
    s.dispose()
  })

  it("retains preset annotations from Cache events, including changed counts", () => {
    const { s, receive } = session()
    const base = { _tag: "Cache", leafSlotId: null, warmth: null, historyStart: null, summarizedThrough: null } as const
    const preview = {
      blocks: [{ identifier: "chatHistory", tokens: 3875, labels: [] }],
      cacheAfter: [{ identifier: "chatHistory", reason: "history" as const }],
      notes: []
    }
    receive({ ...base, presetContext: preview })
    expect(s.snapshot().history?.presetContext).toEqual(preview)
    const next = { ...preview, blocks: [{ identifier: "chatHistory", tokens: 4000, labels: [] }] }
    receive({ ...base, presetContext: next })
    expect(s.snapshot().history?.presetContext).toEqual(next)
  })

  it("shows a failed next assembly and clears its refusal after a successful estimate", () => {
    const { s, receive } = session()
    const base = { _tag: "Cache", leafSlotId: null, warmth: null, historyStart: null, summarizedThrough: null } as const
    receive({ ...base, assemblyError: "The newest message cannot fit." })
    expect(s.snapshot().history?.assemblyError).toBe("The newest message cannot fit.")
    receive({ ...base, assemblyError: null })
    expect(s.snapshot().history?.assemblyError).toBeNull()
    s.dispose()
  })

  it("appends reasoning to a continuation's saved reasoning independently of text", async () => {
    vi.stubGlobal("requestAnimationFrame", () => 1)
    vi.stubGlobal("cancelAnimationFrame", () => {})
    const { s, registry, answers, receive, flush } = session()
    const opening = s.open(null)
    answers[0]!(window([first, entry("s2", "s1", { ...reply, reasoning: "Plan one." } as Version)]))
    await opening
    receive({ _tag: "Reasoning", versionId: reply.id, offset: 9, text: " Plan two." })
    receive({ _tag: "Delta", versionId: reply.id, offset: 8, text: " turned." })
    flush()
    expect(registry.get(liveReasoning(reply.id))).toBe("Plan one. Plan two.")
    expect(registry.get(liveText(reply.id))).toBe("The tide turned.")
    // A repeated delta does not duplicate reasoning, and finishing removes both live atoms.
    receive({ _tag: "Reasoning", versionId: reply.id, offset: 9, text: " Plan two." })
    receive({ _tag: "Version", version: { ...reply, status: "complete", reasoning: "Plan one. Plan two." } as Version })
    expect(s.snapshot().entries[1]!.version.reasoning).toBe("Plan one. Plan two.")
    expect(registry.get(liveReasoning(reply.id))).toBeNull()
    expect(registry.get(liveText(reply.id))).toBeNull()
  })

  it("a replace delta sets the text from its offset on, even shorter; a plain one only adds", async () => {
    vi.stubGlobal("requestAnimationFrame", () => 1)
    vi.stubGlobal("cancelAnimationFrame", () => {})
    const { s, registry, answers, receive, flush } = session()
    const opening = s.open(null)
    answers[0]!(window([first, entry("s2", "s1", reply)]))
    await opening
    receive({ _tag: "Delta", versionId: reply.id, offset: 8, text: " <cot>plan" })
    flush()
    expect(registry.get(liveText(reply.id))).toBe("The tide <cot>plan")
    // Scripts rewrote the text so far: the chain of thought goes, the text gets shorter.
    receive({ _tag: "Delta", versionId: reply.id, offset: 8, text: "", replace: true })
    receive({ _tag: "Delta", versionId: reply.id, offset: 8, text: " turned." })
    receive({ _tag: "Section", versionId: reply.id, offset: 0, text: "Plan: PRIV" })
    receive({ _tag: "Section", versionId: reply.id, offset: 6, text: "[hidden]", replace: true })
    flush()
    expect(registry.get(liveText(reply.id))).toBe("The tide turned.")
    expect(registry.get(liveSections(reply.id))).toBe("Plan: [hidden]")
    // A plain delta that repeats what's shown changes nothing.
    receive({ _tag: "Delta", versionId: reply.id, offset: 8, text: " t" })
    flush()
    expect(registry.get(liveText(reply.id))).toBe("The tide turned.")
    s.dispose()
  })

  it("bounds reads of another fork's slot, including overlapping events and replay", async () => {
    // A new version of a message that another fork shows (a split): its slot events say so, and
    // this fork reads the slot again as it shows it. Events that arrive while those reads are in
    // flight are replayed when each lands; a replay that read again kept a read in flight
    // forever, each landing starting more (the tab ran out of memory).
    const { s, answers, receive } = session()
    const opening = s.open(null)
    answers[0]!(window([first, second]))
    await opening
    const internals = s as unknown as { view: ReturnType<typeof s.snapshot> }
    internals.view = { ...s.snapshot(), forkId: "root" as ForkId }
    const elsewhere = (rowVersion: number) =>
      ({
        _tag: "Slot",
        entry: { ...first, rowVersion, shownForkId: "split" as ForkId, versionCount: 2 }
      }) as ChatEvent
    receive(elsewhere(2))
    receive(elsewhere(3))
    const asShownHere = window([{ ...first, shownForkId: "root" as ForkId, versionCount: 2 } as PathEntry])
    // Answer every read made, up to a bound well past what a finite exchange needs.
    let answered = 1
    while (answered < answers.length && answered < 20) {
      answers[answered++]!(asShownHere)
      await new Promise((settle) => setTimeout(settle, 0))
    }
    // Opening, two event reads, and one replay for the event during the first read.
    expect(answers.length).toBe(4)
    expect(s.snapshot().entries[0]!.version.id).toBe(first.version.id)
    s.dispose()
  })

  it("repairs a stale window that lands after another fork's slot refresh", async () => {
    const { s, answers, receive } = session()
    const own = (entries: Array<PathEntry>) => ({ ...window(entries), forkId: "root" as ForkId })
    const opening = s.open(null)
    answers[0]!(own([first, second]))
    await opening
    const older = s.open(null)
    receive({ _tag: "Slot", entry: { ...first, shownForkId: "split" as ForkId, versionCount: 2 } })
    const fresh = { ...first, shownForkId: "root" as ForkId, versionCount: 2, rowVersion: 2 }
    answers[2]!(own([fresh]))
    await new Promise((settle) => setTimeout(settle, 0))
    expect(s.snapshot().entries[0]!.versionCount).toBe(2)
    answers[1]!(own([first, second]))
    await older
    for (let i = 3; i < answers.length && i < 12; i++) {
      answers[i]!(own([fresh]))
      await new Promise((settle) => setTimeout(settle, 0))
    }
    expect(answers.length).toBeLessThanOrEqual(4)
    expect(s.snapshot().entries[0]!.versionCount).toBe(2)
    s.dispose()
  })

  it("bounds reloads for an unknown insertion without a position, even when outside the returned window", async () => {
    const { s, answers, receive } = session()
    const opening = s.open(null)
    answers[0]!(window([first, second]))
    await opening
    const older = s.open(null)
    receive({ _tag: "Slot", entry: { ...entry("insert", "s1", first.version), inserted: true } })
    for (let i = 1; i < answers.length && i < 12; i++) {
      answers[i]!(window([first, second]))
      await new Promise((settle) => setTimeout(settle, 0))
    }
    await older
    expect(answers.length).toBeLessThanOrEqual(4)
    s.dispose()
  })

  for (const end of ["dispose", "switch"] as const)
    it(`ignores a slot refresh after ${end}`, async () => {
      const { s, answers, receive } = session()
      const opening = s.open(null)
      answers[0]!({ ...window([first, second]), forkId: "root" as ForkId })
      await opening
      receive({ _tag: "Slot", entry: { ...first, shownForkId: "split" as ForkId } })
      if (end === "dispose") s.dispose()
      else s.showFork("next" as ForkId, null)
      const before = s.snapshot()
      answers[1]!({ ...window([{ ...first, rowVersion: 100, versionCount: 100 }]), forkId: "root" as ForkId })
      await new Promise((settle) => setTimeout(settle, 0))
      expect(s.snapshot()).toBe(before)
      if (end === "switch") {
        answers[2]!({ ...window([first, second]), forkId: "next" as ForkId })
        await new Promise((settle) => setTimeout(settle, 0))
      }
      s.dispose()
    })

  for (const operation of ["slot refresh", "navigation"] as const)
    it(`keeps the new branch when a stale ${operation} encounters a deleted branch`, async () => {
      const notice = vi.fn()
      const { s, receive } = session(notice, false)
      const root = "root" as ForkId
      const next = "next" as ForkId
      const fallback = "current" as ForkId
      const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
      const missing = Effect.fail(new NotFound({ entity: "fork", id: root }))
      const around = Promise.withResolvers<void>()
      const current = Promise.withResolvers<void>()
      const fallbackStarted = Promise.withResolvers<void>()
      let deleted = false
      const readCurrent = vi.fn(() => {
        fallbackStarted.resolve()
        return Effect.promise(() => current.promise).pipe(Effect.as({ ...window([first]), forkId: fallback }))
      })
      const client = ((tag: string, input: { forkId: ForkId | null; range: { _tag: string } }) => {
        if (tag !== "ReadPath") return Effect.succeed(chat)
        if (input.forkId === null) return readCurrent()
        if (input.forkId === root && deleted)
          return input.range._tag === "Around"
            ? Effect.promise(() => around.promise).pipe(Effect.andThen(missing))
            : missing
        return Effect.succeed({ ...window([first, second]), forkId: input.forkId })
      }) as unknown as AppClient["Service"]
      s.call = (rpc) =>
        Effect.runPromise(
          Effect.match(rpc(client), {
            onFailure: () => ({
              ok: false as const,
              error: { tag: "NotFound", message: "Missing", reason: null, problems: [] }
            }),
            onSuccess: (value) => ({ ok: true as const, value })
          })
        )
      s.showFork(root, null)
      await settle()
      deleted = true
      if (operation === "slot refresh") receive({ _tag: "Slot", entry: { ...first, shownForkId: next } })
      else {
        void s.open(first.slotId)
        around.resolve()
        await fallbackStarted.promise
      }
      s.showFork(next, null)
      await settle()
      around.resolve()
      current.resolve()
      await settle()
      expect(s.snapshot().forkId).toBe(next)
      expect((s as unknown as { requestedFork: ForkId }).requestedFork).toBe(next)
      expect(notice).not.toHaveBeenCalled()
      expect(readCurrent).toHaveBeenCalledTimes(operation === "slot refresh" ? 0 : 1)
      s.dispose()
    })

  for (const when of ["before", "during", "after"] as const)
    for (const failed of [false, true])
      it(`settles several other-fork slots ${when} a ${failed ? "failed" : "successful"} read`, async () => {
        const { s, answers, receive } = session()
        const own = (entries: Array<PathEntry>) => ({ ...window(entries), forkId: "root" as ForkId })
        const opening = s.open(null)
        answers[0]!(own([first, second]))
        await opening
        const changed = [first, second].map((e) => ({
          ...e,
          shownForkId: "root" as ForkId,
          rowVersion: 2,
          versionCount: 3
        }))
        const events = () => {
          // A reconnect may repeat the same server event: it is a new delivery, not a
          // local replay. Neither repeated delivery nor multiple messages may spin.
          for (const e of [first, second, first])
            receive({ _tag: "Slot", entry: { ...e, shownForkId: "split" as ForkId, versionCount: 3 } })
        }
        if (when === "before") events()
        const index = answers.length
        const read = s.open(null)
        if (when === "during") events()
        // Failed reads don't update the window; their event buffers still have to end.
        answers[index]!(failed ? (null as unknown as PathWindow) : own(when === "before" ? changed : [first, second]))
        await read
        if (when === "after") events()
        let answered = 1
        while (answered < answers.length && answered < 30) {
          if (answered !== index) answers[answered]!(own(changed))
          answered++
          await new Promise((settle) => setTimeout(settle, 0))
        }
        expect(answers.length).toBeLessThanOrEqual(12)
        expect(s.snapshot().entries.map((e) => [e.version.id, e.versionCount])).toEqual([
          [first.version.id, 3],
          [second.version.id, 3]
        ])
        expect((s as unknown as { readEvents: Set<unknown> }).readEvents.size).toBe(0)
        s.dispose()
      })

  it("refreshes a slot first loaded by a window after its other-fork event arrived", async () => {
    const { s, answers, receive } = session()
    const own = (entries: Array<PathEntry>) => ({ ...window(entries), forkId: "root" as ForkId })
    const opening = s.open(null)
    answers[0]!(own([second]))
    await opening
    const read = s.open(first.slotId)
    receive({ _tag: "Slot", entry: { ...first, shownForkId: "split" as ForkId, versionCount: 2 } })
    expect(answers).toHaveLength(2)
    answers[1]!(own([first, second]))
    await read
    expect(answers).toHaveLength(3)
    answers[2]!(own([{ ...first, shownForkId: "root" as ForkId, rowVersion: 2, versionCount: 2 }]))
    await new Promise((settle) => setTimeout(settle, 0))
    expect(s.snapshot().entries[0]!.versionCount).toBe(2)
    s.dispose()
  })

  it("ends a failed slot refresh, then recovers on reconnect with repeated server events", async () => {
    const { s, answers, receive } = session()
    const own = (entries: Array<PathEntry>) => ({ ...window(entries), forkId: "root" as ForkId })
    const opening = s.open(null)
    answers[0]!(own([first, second]))
    await opening
    const event = { _tag: "Slot", entry: { ...first, shownForkId: "split" as ForkId } } as const
    receive(event)
    answers[1]!(null as unknown as PathWindow)
    await new Promise((settle) => setTimeout(settle, 0))
    expect(answers).toHaveLength(2)
    expect((s as unknown as { readEvents: Set<unknown> }).readEvents.size).toBe(0)
    // The real subscription calls reload on its second Hello.
    ;(s as unknown as { hellos: number }).hellos = 1
    receive({ _tag: "Hello", live: [] })
    receive(event)
    const fresh = { ...first, rowVersion: 2, versionCount: 2, shownForkId: "root" as ForkId }
    let answered = 2
    while (answered < answers.length && answered < 12) {
      answers[answered++]!(own([fresh, second]))
      await new Promise((settle) => setTimeout(settle, 0))
    }
    expect(answers.length).toBeLessThanOrEqual(5)
    expect(s.snapshot().entries[0]!.versionCount).toBe(2)
    s.dispose()
  })

  it("does not re-read a slot snapshot returned from a fallback fork", async () => {
    const { s, answers, receive } = session()
    const opening = s.open(null)
    answers[0]!({ ...window([first, second]), forkId: "root" as ForkId })
    await opening
    receive({ _tag: "Slot", entry: { ...first, shownForkId: "split" as ForkId } })
    let answered = 1
    while (answered < answers.length && answered < 12) {
      answers[answered++]!({ ...window([{ ...first, shownForkId: "split" as ForkId }]), forkId: "split" as ForkId })
      await new Promise((settle) => setTimeout(settle, 0))
    }
    expect(answers).toHaveLength(2)
    expect(s.snapshot().forkId).toBe("root")
    s.dispose()
  })

  it("keeps steps on their version across swipes and clears only the run that stops", async () => {
    const { s, registry, answers, receive } = session()
    const opening = s.open(null)
    answers[0]!(window([first, second]))
    await opening
    const steps = [{ kind: "thinking", text: "Check the bridge." }] as const
    receive({ _tag: "Steps", versionId: reply.id, steps })
    // Another tab selects a different version of the slot while the original keeps running.
    const swipe = version("v3", "s2", "complete", "Another reply.")
    receive({ _tag: "Slot", entry: { ...second, rowVersion: 2, version: swipe, versionCount: 2 } })
    const updated = [{ kind: "thinking", text: "Check the bridge and lantern." }] as const
    receive({ _tag: "Steps", versionId: reply.id, steps: updated })
    expect(s.snapshot().entries.at(-1)?.version.id).toBe(swipe.id)
    expect(registry.get(liveSteps(swipe.id))).toBeNull()
    expect(registry.get(liveSteps(reply.id))).toEqual(updated)
    receive({ _tag: "Version", version: { ...reply, status: "stopped" } as Version })
    expect(registry.get(liveSteps(reply.id))).toBeNull()
    expect(s.snapshot().entries.at(-1)?.version.id).toBe(swipe.id)
    s.dispose()
  })

  it("seeds steps on reload and replaces them on reconnect even when the transcript got shorter", async () => {
    const { s, registry, answers, receive } = session()
    const steps = [{ kind: "thinking", text: "Check the bridge." }] as const
    receive({ _tag: "Hello", live: [{ versionId: reply.id, text: "", steps }] })
    answers[0]!(window([first, second]))
    await vi.waitFor(() => expect(s.snapshot().entries).toHaveLength(2))
    expect(registry.get(liveSteps(reply.id))).toEqual(steps)
    receive({ _tag: "Hello", live: [{ versionId: reply.id, text: "", steps: [] }] })
    expect(registry.get(liveSteps(reply.id))).toEqual([])
    answers[1]!(window([first, second]))
    await Promise.resolve()
    receive({ _tag: "Hello", live: [] })
    expect(registry.get(liveSteps(reply.id))).toBeNull()
    answers[2]!(window([first, entry("s2", "s1", { ...reply, status: "stopped" } as Version)]))
    await Promise.resolve()
    s.dispose()
  })

  it("loads live reasoning from Hello before a window arrives", async () => {
    const { s, registry, answers, receive } = session()
    receive({
      _tag: "Hello",
      live: [{ versionId: reply.id, text: "The tide turned", reasoning: "Plan one. Plan two." }]
    })
    answers[0]!(window([first, entry("s2", "s1", { ...reply, reasoning: "Plan one." } as Version)]))
    await vi.waitFor(() => expect(s.snapshot().entries).toHaveLength(2))
    expect(registry.get(liveReasoning(reply.id))).toBe("Plan one. Plan two.")
    expect(s.snapshot().entries[1]!.version.id).toBe(reply.id)
  })

  it("invalidates history for changes outside the window and reloads, without token updates or read replay", async () => {
    vi.stubGlobal("requestAnimationFrame", () => 1)
    vi.stubGlobal("cancelAnimationFrame", () => {})
    const { s, answers, receive } = session()
    const opening = s.open(null)
    const revision = s.snapshot().pathRevision
    receive({ _tag: "Slot", entry: first })
    expect(s.snapshot().pathRevision).toBe(revision + 1)
    // Replaying that event after an in-flight read isn't another history change.
    answers[0]!(window([first, second]))
    await opening
    expect(s.snapshot().pathRevision).toBe(revision + 1)
    receive({ _tag: "Version", version: version("old-version", "old-slot", "complete", "Outside the window.") })
    expect(s.snapshot().pathRevision).toBe(revision + 2)
    receive({ _tag: "Delta", versionId: reply.id, offset: reply.content.length, text: " rises" })
    expect(s.snapshot().pathRevision).toBe(revision + 2)
    receive({ _tag: "Cache", leafSlotId: null, warmth: null, historyStart: null, summarizedThrough: null })
    expect(s.snapshot().pathRevision).toBe(revision + 2)
    // Deletion/restoration and reconnects reload even when the tip doesn't move.
    receive({ _tag: "Reload" })
    expect(s.snapshot().pathRevision).toBe(revision + 3)
    answers[1]!(window([first, second]))
    await Promise.resolve()
    s.dispose()
  })

  it("keeps a message that arrived while the window was being read", async () => {
    const { s, answers, receive } = session()
    const opening = s.open(null)
    // Sent from another tab after the server read the window, before the reply got here.
    receive({ _tag: "Slot", entry: entry("s3", "s2", version("v3", "s3", "complete", "Again.")) })
    answers[0]!(window([first, second]))
    await opening
    expect(s.snapshot().entries.map((e) => e.slotId)).toEqual(["s1", "s2", "s3"])
  })

  it("keeps a reply that finished while the window was being read", async () => {
    const { s, answers, receive } = session()
    const opening = s.open(null)
    receive({ _tag: "Version", version: version("v2", "s2", "complete", "The tide turned.") })
    answers[0]!(window([first, second]))
    await opening
    const shown = s.snapshot().entries[1]!.version
    expect(shown.status).toBe("complete")
    expect(shown.content).toBe("The tide turned.")
  })

  it("doesn't let an event older than the window undo it", async () => {
    const { s, answers, receive } = session()
    const opening = s.open(null)
    // The slot event that started the reply, arriving late; the window already has it finished.
    receive({ _tag: "Slot", entry: second })
    answers[0]!(window([first, entry("s2", "s1", version("v2", "s2", "complete", "The tide turned."))]))
    await opening
    expect(s.snapshot().entries[1]!.version.status).toBe("complete")
  })

  it("doesn't let a queue read older than a Queue event bring back what it removed", async () => {
    const s = new ChatSession(chatId, null, AtomRegistry.make(), "user")
    const internals = s as unknown as {
      call: () => Promise<unknown>
      refreshQueue: () => Promise<void>
      receive: (batch: ReadonlyArray<ChatEvent>, anchor: SlotId | null) => void
    }
    let answer!: (value: unknown) => void
    internals.call = () => new Promise((resolve) => (answer = resolve))
    const reading = internals.refreshQueue()
    // The server read the queue, then something queued; the event beats the read's reply.
    const queued = { id: "q1", content: "new", rowVersion: 1 } as unknown as QueuedMessage
    internals.receive([{ _tag: "Queue", queue: [queued] }], null)
    answer({ ok: true, value: [] })
    await reading
    expect(s.snapshot().queue.map((q) => q.content)).toEqual(["new"])
  })

  it("notifies prospective default readers even when a Cache event leaves effective context unchanged", () => {
    const { s, receive } = session()
    const changed = vi.fn()
    const unsubscribe = s.subscribeContext(changed)
    const event = {
      _tag: "Cache",
      leafSlotId: null,
      warmth: null,
      historyStart: null,
      summarizedThrough: null
    } as const
    receive(event)
    const history = s.snapshot().history
    receive(event)
    expect(s.snapshot().history).toBe(history)
    expect(changed).toHaveBeenCalledTimes(2)
    unsubscribe()
    receive(event)
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it("distinguishes the first local context snapshot from a server change", async () => {
    const registry = AtomRegistry.make()
    const s = new ChatSession(chatId, null, registry, "synthetic-user")
    const internals = s as unknown as {
      view: typeof s extends { snapshot: () => infer V } ? V : never
      call: () => Promise<unknown>
      refreshContext: () => Promise<void>
      apply: (event: ChatEvent, anchor: null) => void
      scheduleLcm: () => void
    }
    internals.view = { ...s.snapshot(), loading: false }
    internals.scheduleLcm = () => {}
    const context = { leafSlotId: null, warmth: null, historyStart: null, summarizedThrough: null }
    internals.call = async () => ({ ok: true, value: context })
    const changed = vi.fn()
    s.subscribeContext(changed)
    await internals.refreshContext()
    expect(changed).toHaveBeenLastCalledWith(true)
    internals.apply({ _tag: "Cache", ...context }, null)
    expect(changed).toHaveBeenLastCalledWith(false)
    await internals.refreshContext()
    expect(changed.mock.calls).toEqual([[true], [false], [false]])
    s.dispose()
    registry.dispose()
  })
})

it("dispatches a Files attachment only to the initiating chat view and fork", () => {
  const forkId = "fork" as ForkId
  const otherFork = "other" as ForkId
  const registry = AtomRegistry.make()
  const left = new ChatSession(chatId, forkId, registry, "user")
  const right = new ChatSession(chatId, forkId, registry, "user")
  const attachLeft = vi.fn()
  const attachRight = vi.fn()
  const unbindLeft = onAttachRequest(left, forkId, attachLeft)
  const unbindRight = onAttachRequest(right, forkId, attachRight)
  try {
    requestAttach(left, otherFork, "/files/wrong.txt")
    requestAttach(left, forkId, "/files/notes.txt")
    expect(attachLeft.mock.calls).toEqual([["/files/notes.txt"]])
    expect(attachRight).not.toHaveBeenCalled()
  } finally {
    unbindLeft()
    unbindRight()
    left.dispose()
    right.dispose()
  }
})
