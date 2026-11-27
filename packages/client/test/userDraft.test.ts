import type { UserId } from "@dreamspan/shared/domain.ts"
import { Draft, DraftKey, DraftState, deletedSince } from "@dreamspan/shared/drafts.ts"
import type { UserDraftSave } from "@dreamspan/shared/editorApi.ts"
import { Effect } from "effect"
import { beforeEach, expect, it, vi } from "vitest"
import type { useAction } from "../src/actions.tsx"
import { copiesOf, keepCopy, makeCopy, type Copy } from "../src/features/editor/backup.ts"

vi.hoisted(() => vi.stubGlobal("location", { protocol: "http:", host: "localhost" }))
const memory = vi.hoisted(() => new Map<string, Copy>())
vi.mock("../src/features/editor/backup.ts", async (original) => ({
  ...(await original<typeof import("../src/features/editor/backup.ts")>()),
  keepCopy: async (copy: Copy, previous?: Copy | null) => {
    memory.set(copy.key, copy)
    if (previous) memory.delete(previous.key)
  },
  dropCopy: async (copy: Copy) => {
    memory.delete(copy.key)
  },
  copiesOf: async () => [...memory.values()]
}))
const { UserDraftStore, newerText } = await import("../src/features/editor/userDraft.tsx")
const ownerId = "author" as UserId
const key = new DraftKey({ targetKind: "user_field", targetId: "Settings → Chats", field: "Summarization instruction" })
const draft = (content: string, rowVersion = 1) =>
  new Draft({
    id: "draft",
    key,
    content,
    rowVersion,
    session: 1,
    status: "active",
    baseRevision: null,
    createdAt: 1,
    updatedAt: rowVersion,
    historyLength: rowVersion,
    recovered: 0,
    displaced: null
  })
const payload = (content: string, rowVersion = 1): typeof UserDraftSave.Type => ({
  ownerId,
  targetId: key.targetId,
  field: key.field,
  content,
  draftId: "draft",
  expectedRowVersion: rowVersion,
  expectedSession: 1
})
const deferred = <A>() => {
  let resolve!: (value: A) => void
  const promise = new Promise<A>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const until = async (check: () => boolean) => {
  await vi.waitFor(() => expect(check()).toBe(true))
}
const harness = (initial = draft("original"), field = key.field, targetId = key.targetId) => {
  let current = initial
  const saves: Array<typeof UserDraftSave.Type> = []
  const handlers = {
    GetUserDraft: async () => current,
    SaveUserDraft: async (save: typeof UserDraftSave.Type) => {
      saves.push(save)
      current = draft(save.content, current.rowVersion + 1)
      return current
    },
    EndUserDraft: async () => {
      current = { ...draft("", current.rowVersion + 1), status: "discarded" as const }
      return current
    },
    UserDraftHistory: async () => [
      new DraftState({ seq: 1, at: 2, length: 8, removed: "", inserted: "original", kind: "edit" }),
      new DraftState({ seq: 0, at: 1, length: 8, removed: "", inserted: "starting", kind: "initial" })
    ],
    RestoreUserDraft: async () => {
      current = draft("starting", current.rowVersion + 1)
      return current
    }
  }
  const run: ReturnType<typeof useAction>["run"] = async (call) => {
    try {
      const client = (tag: keyof typeof handlers, input: never) =>
        Effect.promise<Draft | Array<DraftState>>(() => handlers[tag](input))
      return { ok: true, value: await Effect.runPromise(call(client as never)) }
    } catch {
      return { ok: false, error: { tag: "ServerError", message: "Synthetic refusal", problems: [], reason: null } }
    }
  }
  const store = new UserDraftStore(ownerId, targetId, field, run)
  return { store, handlers, saves }
}
beforeEach(() => memory.clear())

it.each(["userDraft", "setting"] as const)(
  "a refused %s replay keeps the displayed copy's base when typing continues",
  async (kind) => {
    const old = makeCopy(
      ownerId,
      key.targetId,
      key.field,
      kind === "userDraft" ? { kind, payload: payload("offline") } : { kind, payload: { content: "offline" } },
      1
    )
    await keepCopy(old)
    const { store, handlers, saves } = harness(draft("unseen other device", 7))
    const save = handlers.SaveUserDraft
    handlers.SaveUserDraft = async () => {
      throw new Error("offline")
    }
    store.open()
    await until(() => store.snapshot().ready)
    expect(store.snapshot().text).toBe("offline")
    handlers.SaveUserDraft = save
    store.type("offline continued", "saved instruction")
    await until(() => saves.length === 1)
    expect(saves[0]?.expectedRowVersion).toBe(kind === "userDraft" ? 1 : null)
  }
)

it("an acknowledgement refiles text typed while the save was outstanding", async () => {
  const { store, handlers } = harness()
  store.open()
  await until(() => store.snapshot().ready)
  const held = deferred<Draft>()
  let calls = 0
  handlers.SaveUserDraft = async (input) => {
    if (++calls === 1) return held.promise
    throw new Error(`Leave ${input.content} in browser recovery`)
  }
  const history = deferred<Array<DraftState>>()
  let readingHistory = false
  handlers.UserDraftHistory = () => {
    readingHistory = true
    return history.promise
  }
  store.type("first", "original")
  await until(() => calls === 1)
  store.history()
  store.type("first continued", "original")
  held.resolve(draft("first", 2))
  await until(() => readingHistory)
  const copies = await copiesOf(ownerId, key.targetId)
  const latest = copies.find((copy) => copy.content === "first continued")!
  expect(latest.save.kind).toBe("userDraft")
  if (latest.save.kind === "userDraft") expect(latest.save.payload.expectedRowVersion).toBe(2)
  history.resolve([])
  await until(() => calls === 2)
})

it("typing during undo retains the base of the text actually displayed", async () => {
  const { store, handlers, saves } = harness()
  store.open()
  await until(() => store.snapshot().ready)
  const held = deferred<Draft>()
  let restoring = false
  handlers.RestoreUserDraft = async () => {
    restoring = true
    return held.promise
  }
  store.undo()
  await until(() => restoring)
  store.type("original continued", "original")
  held.resolve(draft("unseen restored text", 2))
  await until(() => saves.length === 1)
  expect(store.snapshot().text).toBe("original continued")
  expect(saves[0]?.expectedRowVersion).toBe(1)
})

it("typing before the opening read finishes never adopts unseen text as its base", async () => {
  const { store, handlers, saves } = harness(draft("unseen other device", 8))
  const held = deferred<Draft>()
  handlers.GetUserDraft = () => held.promise
  store.open()
  store.type("local instruction", "saved instruction")
  held.resolve(draft("unseen other device", 8))
  await until(() => saves.length > 0)
  expect(saves[0]?.expectedRowVersion).toBeNull()
})

it("keeps displacement visible through further typing until explicitly acknowledged", async () => {
  const { store, handlers, saves } = harness()
  store.open()
  await until(() => store.snapshot().ready)
  const save = handlers.SaveUserDraft
  handlers.SaveUserDraft = async (input) => ({
    ...(await save(input)),
    displaced: { content: "The other device's text", at: 3 }
  })
  store.type("local", "original")
  await until(() => saves.length === 1)
  await until(() => store.snapshot().displaced !== null)
  handlers.SaveUserDraft = save
  store.type("local continued", "original")
  await until(() => saves.length === 2)
  expect(store.snapshot().displaced?.content).toBe("The other device's text")
  store.acknowledge()
  expect(store.snapshot().displaced).toBeNull()
})

it("advances the form version in later typing and its browser copy after this form's Save", async () => {
  const initial = JSON.stringify({ name: "original", rowVersion: 4 })
  const { store, handlers } = harness(draft(initial))
  store.open()
  await until(() => store.snapshot().ready)
  const held = deferred<boolean>()
  let saving = false
  const operation = store.commit(
    initial,
    () => {
      saving = true
      return held.promise
    },
    "committed",
    (text) => JSON.stringify({ ...JSON.parse(text), rowVersion: 5 })
  )
  await until(() => saving)
  store.type(JSON.stringify({ name: "typed during Save", rowVersion: 4 }), initial)
  // Even an ending failure leaves the next edit on the settings version actually saved.
  handlers.SaveUserDraft = async () => {
    throw new Error("offline")
  }
  held.resolve(true)
  await operation
  await until(() => store.snapshot().error !== null)
  expect(JSON.parse(store.snapshot().text!).rowVersion).toBe(5)
  const copies = await copiesOf(ownerId, key.targetId)
  const next = copies.find((copy) => JSON.parse(copy.content).name === "typed during Save")!
  expect(JSON.parse(next.content).rowVersion).toBe(5)
})

it.each(["undo", "restore"] as const)("%s leaves a refused local save visible and recoverable", async (action) => {
  const { store, handlers } = harness()
  store.open()
  await until(() => store.snapshot().ready)
  handlers.SaveUserDraft = async () => {
    throw new Error("offline")
  }
  let restores = 0
  handlers.RestoreUserDraft = async () => {
    restores++
    return draft("restored", 2)
  }
  store.type("Only in this browser", "original")
  await until(() => store.snapshot().error !== null)
  if (action === "undo") store.undo()
  else store.restore(0)
  // Waiting on the same queue proves the action finished, rather than racing the assertion.
  store.history()
  await until(() => store.snapshot().history !== null)
  expect(restores).toBe(0)
  expect(store.snapshot().text).toBe("Only in this browser")
  expect((await copiesOf(ownerId, key.targetId)).some((copy) => copy.content === "Only in this browser")).toBe(true)
})

it("continuing a newer replay never deletes an unrelated older copy whose replay failed", async () => {
  const old = makeCopy(
    ownerId,
    key.targetId,
    key.field,
    { kind: "userDraft", payload: payload("Older failed copy") },
    1
  )
  const newer = makeCopy(
    ownerId,
    key.targetId,
    key.field,
    { kind: "setting", payload: { content: "Newer legacy copy" } },
    2
  )
  await keepCopy(old)
  await keepCopy(newer)
  const { store, handlers, saves } = harness()
  const save = handlers.SaveUserDraft
  handlers.SaveUserDraft = async (input) => {
    if (input.content === old.content) throw new Error("Older replay refused")
    return save(input)
  }
  store.open()
  await until(() => store.snapshot().ready)
  expect(store.snapshot().text).toBe(newer.content)
  store.type("Newer legacy copy continued", "original")
  await until(() => saves.length === 2)
  expect((await copiesOf(ownerId, key.targetId)).some((copy) => copy.key === old.key)).toBe(true)
})

it("a clean open editor learns a newer device draft and ignores old events", async () => {
  const { store } = harness()
  store.open()
  await until(() => store.snapshot().ready)
  store.receive(draft("another device", 3))
  await until(() => store.snapshot().text === "another device")
  expect(store.snapshot().remote).toBeNull()
  store.receive(draft("out of order", 2))
  store.history()
  await until(() => store.snapshot().history !== null)
  expect(store.snapshot().text).toBe("another device")
})

it.each([true, false])("a local unsaved draft offers an explicit remote choice (load=%s)", async (load) => {
  const { store, handlers, saves } = harness()
  store.open()
  await until(() => store.snapshot().ready)
  const save = handlers.SaveUserDraft
  handlers.SaveUserDraft = async () => {
    throw new Error("offline")
  }
  store.type("local unsaved", "original")
  await until(() => store.snapshot().error !== null)
  store.receive(draft("remote saved", 5))
  await until(() => store.snapshot().remote !== null)
  expect(store.snapshot().text).toBe("local unsaved")
  expect(store.snapshot().remote?.content).toBe("remote saved")
  handlers.SaveUserDraft = save
  store.resolveRemote(load)
  await until(() => store.snapshot().remote === null)
  expect(store.snapshot().text).toBe(load ? "remote saved" : "local unsaved")
  // Accepting remote first archives local text. Keeping local retains its original observed base.
  expect(saves[0]?.content).toBe("local unsaved")
  expect(saves[0]?.expectedRowVersion).toBe(1)
  if (load) {
    expect(saves[1]?.content).toBe("remote saved")
    expect(saves[1]?.expectedRowVersion).toBe(5)
  }
})

it("reconnect refresh retains text typed while its read was outstanding", async () => {
  const { store, handlers } = harness()
  store.open()
  await until(() => store.snapshot().ready)
  const held = deferred<Draft>()
  handlers.GetUserDraft = () => held.promise
  store.refresh()
  store.type("local during refresh", "original")
  held.resolve(draft("reconnected device", 4))
  await until(() => store.snapshot().remote !== null)
  expect(store.snapshot().text).toBe("local during refresh")
  expect(store.snapshot().remote?.content).toBe("reconnected device")
})

it.each(["committed", "discarded"] as const)(
  "a remote %s ending never replaces a form with empty draft storage",
  async (status) => {
    const original = JSON.stringify({ name: "Saved name" })
    const { store } = harness(draft(original))
    store.open()
    await until(() => store.snapshot().ready)
    store.receive({ ...draft("", 3), status })
    store.history()
    await until(() => store.snapshot().history !== null)
    expect(store.snapshot().text).toBe(original)
    expect(store.snapshot().remote?.status).toBe(status)
  }
)

it("loading an ended remote draft recovers local text before requesting the saved value", async () => {
  const { store, handlers, saves } = harness(draft('{"name":"Original"}'))
  const settleChoice = async () => {
    const history = handlers.UserDraftHistory
    let read = false
    handlers.UserDraftHistory = async () => {
      read = true
      return history()
    }
    store.history()
    await until(() => read)
    handlers.UserDraftHistory = history
  }
  store.open()
  await until(() => store.snapshot().ready)
  const save = handlers.SaveUserDraft
  handlers.SaveUserDraft = async () => {
    throw new Error("offline")
  }
  store.type('{"name":"Only in this browser"}', '{"name":"Original"}')
  await until(() => store.snapshot().error !== null)
  store.receive({ ...draft("", 5), status: "committed" })
  await until(() => store.snapshot().remote !== null)
  // A refused save leaves the form, the conflict and its browser copy in place.
  await store.resolveRemote(true)
  await settleChoice()
  expect(store.snapshot().text).toBe('{"name":"Only in this browser"}')
  expect((await copiesOf(ownerId, key.targetId)).some((copy) => copy.content.includes("Only in this browser"))).toBe(
    true
  )
  handlers.SaveUserDraft = save
  let ended = 0
  const end = handlers.EndUserDraft
  handlers.EndUserDraft = async () => {
    ended++
    return end()
  }
  await store.resolveRemote(true)
  await settleChoice()
  expect(() => JSON.parse(store.snapshot().text ?? '{"name":"Saved"}')).not.toThrow()
  expect(saves.map((save) => save.content)).toEqual(['{"name":"Only in this browser"}'])
  expect(ended).toBe(1)
  expect(store.snapshot().text).toBeNull()
  expect(await copiesOf(ownerId, key.targetId)).toEqual([])
})

it("typing during a remote-ending choice keeps the new text and its browser copy instead of reloading", async () => {
  const { store, handlers } = harness()
  store.open()
  await until(() => store.snapshot().ready)
  store.receive({ ...draft("", 5), status: "discarded" })
  await until(() => store.snapshot().remote !== null)
  const ending = deferred<Draft>()
  let endingStarted = false
  handlers.EndUserDraft = () => {
    endingStarted = true
    return ending.promise
  }
  const choice = store.resolveRemote(true)
  await until(() => endingStarted)
  handlers.SaveUserDraft = async () => {
    throw new Error("offline")
  }
  store.type("Typed while reloading", "original")
  ending.resolve({ ...draft("", 7), status: "discarded" })
  expect(await choice).toBe(false)
  await until(() => store.snapshot().error !== null)
  expect(store.snapshot().text).toBe("Typed while reloading")
  const copy = (await copiesOf(ownerId, key.targetId)).find((copy) => copy.content === "Typed while reloading")!
  expect(copy.save.kind === "userDraft" && copy.save.payload.expectedRowVersion).toBe(7)
})

it("closing a conflicted editor sends the refused local copy with the base it was typed on", async () => {
  const { store, handlers } = harness()
  store.open()
  await until(() => store.snapshot().ready)
  handlers.SaveUserDraft = async () => {
    throw new Error("offline")
  }
  store.type("Local text as the page closes", "original")
  await until(() => store.snapshot().error !== null)
  store.receive(draft("Other device text", 5))
  await until(() => store.snapshot().remote !== null)
  const fetch = vi.fn(async () => new Response(null, { status: 204 }))
  vi.stubGlobal("fetch", fetch)
  try {
    store.leave()
    const init = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(init[0]).toBe("/library/drafts")
    expect(init[1].keepalive).toBe(true)
    expect(JSON.parse(init[1].body as string).userDrafts).toEqual([
      { ...payload("Local text as the page closes"), editingFrom: "original" }
    ])
    expect(
      (await copiesOf(ownerId, key.targetId)).some((copy) => copy.content === "Local text as the page closes")
    ).toBe(true)
  } finally {
    vi.unstubAllGlobals()
    vi.stubGlobal("location", { protocol: "http:", host: "localhost" })
  }
})

it("newerText takes the text written last, the server's on a tie or with no browser copy", () => {
  expect(newerText(5, 10)).toBe("local")
  expect(newerText(null, 10)).toBe("local")
  expect(newerText(10, 5)).toBe("server")
  expect(newerText(10, 10)).toBe("server")
  expect(newerText(10, null)).toBe("server")
})

// A reload right after typing in a chat not made yet: the server's draft is read first and
// still has the text of a few keystrokes before; the page's own browser copy has the last ones.
it.each([
  ["a newer", 10, "First line\n\n\n\nSecond line"],
  ["an older", 3, "First line\n\n\n\nSecond"]
] as const)("a pending chat's draft opens with %s browser copy against the stale server draft", async (_, at, text) => {
  const pending = makeCopy(
    ownerId,
    key.targetId,
    "first message",
    { kind: "pendingChat", payload: { entityId: "card", name: "Group", content: "First line\n\n\n\nSecond line" } },
    at
  )
  await keepCopy(pending)
  const { store, saves } = harness(draft("First line\n\n\n\nSecond", 5), "First message")
  store.open()
  await until(() => store.snapshot().ready)
  expect(store.snapshot().text).toBe(text)
  // The newer copy goes to the server; the older one isn't sent over the server's text.
  expect(saves.map((save) => save.content)).toEqual(at > 5 ? ["First line\n\n\n\nSecond line"] : [])
})

// Device A's clock may be years ahead; a deletion still wins by server version.
it.each(["active", "discarded", "committed"] as const)(
  "a newer %s deletion blocks an older browser copy",
  async (status) => {
    const pending = makeCopy(
      ownerId,
      key.targetId,
      "First message",
      { kind: "userDraft", payload: payload("deleted text", 3) },
      9e15
    )
    await keepCopy(pending)
    const tombstone = new Draft({ ...draft("", 5), status, clearedVersion: 5 })
    const { store, saves } = harness(tombstone, "First message")
    store.open()
    await until(() => store.snapshot().ready)
    expect(store.snapshot().text).toBe(status === "active" ? "" : null)
    expect(store.snapshot().savedAt).toBe(5)
    expect(saves).toEqual([])
    // Explicit recovery stays possible; it never reappears in the composer automatically.
    expect(await copiesOf(ownerId, key.targetId)).toHaveLength(1)
  }
)

it("a keystroke based on an older tombstone survives reload, even with a slow browser clock", async () => {
  const pending = makeCopy(
    ownerId,
    key.targetId,
    "First message",
    { kind: "userDraft", payload: payload("new keystroke", 5) },
    -1000
  )
  await keepCopy(pending)
  const { store, saves } = harness(new Draft({ ...draft("", 5), clearedVersion: 5 }), "First message")
  store.open()
  await until(() => store.snapshot().ready)
  expect(store.snapshot().text).toBe("new keystroke")
  expect(saves.map((save) => save.content)).toEqual(["new keystroke"])
})

it("a deletion barrier remains after subsequent text and rejects legacy copies without a base", () => {
  const after = new Draft({ ...draft("replacement", 8), clearedVersion: 5 })
  expect(deletedSince(after, payload("deleted", 3))).toBe(true)
  expect(deletedSince(after, null)).toBe(true)
  expect(deletedSince(after, payload("new", 5))).toBe(false)
  expect(deletedSince(after, { ...payload("new", 3), observedDeletion: { draftId: "draft", rowVersion: 5 } })).toBe(
    false
  )
  expect(deletedSince(after, { ...payload("new", 3), observedDeletion: { draftId: "draft", rowVersion: 4 } })).toBe(
    true
  )
  expect(deletedSince(after, { ...payload("new", 3), observedDeletion: { draftId: "other", rowVersion: 100 } })).toBe(
    true
  )
})

it("the synchronous versioned backup alone keeps the final keystroke across an immediate reload", async () => {
  const storage = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key)
  })
  try {
    const tombstone = new Draft({ ...draft("", 5), clearedVersion: 5 })
    const { store, handlers } = harness(tombstone, "First message", "pending-chat:synthetic")
    store.open()
    await until(() => store.snapshot().ready)
    const held = deferred<Draft>()
    handlers.SaveUserDraft = () => held.promise
    store.type("Final keystroke", "")
    // Simulate IndexedDB not finishing before the page is destroyed.
    memory.clear()
    const reopened = harness(tombstone, "First message", "pending-chat:synthetic")
    reopened.store.open()
    await until(() => reopened.store.snapshot().ready)
    expect(reopened.store.snapshot().text).toBe("Final keystroke")
    expect(storage.size).toBe(0)
    held.resolve(draft("Final keystroke", 6))
  } finally {
    vi.unstubAllGlobals()
    vi.stubGlobal("location", { protocol: "http:", host: "localhost" })
  }
})

it("a deletion that wins during a save does not let a stale form commit its text", async () => {
  const { store, handlers } = harness()
  store.open()
  await until(() => store.snapshot().ready)
  handlers.SaveUserDraft = async () =>
    new Draft({ ...draft("", 5), status: "discarded", clearedVersion: 5, recovered: 1 })
  const save = vi.fn(async () => true)
  expect(await store.commit("stale form text", save)).toBe(false)
  expect(save).not.toHaveBeenCalled()
  expect(store.snapshot().recovered).toBe(1)
})

it("a queued Save cannot commit a form snapshot its autosave refused", async () => {
  const initial = JSON.stringify({ temperature: 0.55, topP: 1 })
  const local = JSON.stringify({ temperature: 0.55, topP: 0.8 })
  const remote = JSON.stringify({ temperature: 0.65, topP: 1 })
  const { store, handlers, saves } = harness(draft(initial))
  store.open()
  await until(() => store.snapshot().ready)
  const held = deferred<Draft>()
  const persist = handlers.SaveUserDraft
  let started = false
  handlers.SaveUserDraft = () => {
    started = true
    handlers.SaveUserDraft = persist
    return held.promise
  }
  store.type(local, initial)
  await until(() => started)
  const save = vi.fn(async () => true)
  const queued = store.commit(local, save)
  held.resolve(new Draft({ ...draft(remote, 2), refused: { at: 2, content: local } }))

  expect(await queued).toBe(false)
  expect(save).not.toHaveBeenCalled()
  expect(saves).toEqual([])
  expect(store.snapshot().text).toBe(remote)
  expect(store.snapshot().refused?.content).toBe(local)

  store.type(local, remote)
  expect(await store.commit(local, save)).toBe(true)
  expect(saves[0]).toMatchObject({ content: local, expectedRowVersion: 2 })
  expect(save).toHaveBeenCalledOnce()
})

it("typing into the empty field before its tombstone read finishes starts from that deletion", async () => {
  const tombstone = new Draft({ ...draft("", 5), clearedVersion: 5 })
  const { store, handlers, saves } = harness(tombstone, "First message")
  const opening = deferred<Draft>()
  handlers.GetUserDraft = () => opening.promise
  const save = handlers.SaveUserDraft
  handlers.SaveUserDraft = async (payload) =>
    Math.max(payload.expectedRowVersion ?? 0, payload.observedDeletion?.rowVersion ?? 0) < 5 ? tombstone : save(payload)
  store.open()
  store.type("new text typed in the empty box", "")
  opening.resolve(tombstone)
  await until(() => saves.some((save) => save.content === "new text typed in the empty box"))
  expect(store.snapshot().text).toBe("new text typed in the empty box")
  expect(store.snapshot().error).toBeNull()
})

it("a refused compound replay protects cleared inputs while retaining other last keystrokes", async () => {
  const raw = JSON.stringify({ name: "deleted name", baseUrl: "https://example.invalid/last-keystroke" })
  const address = { targetId: "connection:synthetic", field: "Settings" }
  const old = makeCopy(
    ownerId,
    address.targetId,
    address.field,
    { kind: "userDraft", payload: { ...payload(raw), ...address } },
    1
  )
  await keepCopy(old)
  const cleared = new Draft({
    ...draft(JSON.stringify({ name: "", baseUrl: "https://example.invalid" }), 5),
    deletions: { '["name"]': { draftId: "draft", rowVersion: 5, value: "" } }
  })
  const { store, handlers, saves } = harness(cleared, address.field, address.targetId)
  const save = handlers.SaveUserDraft
  handlers.SaveUserDraft = async () => {
    throw new Error("offline during replay")
  }
  store.open()
  await until(() => store.snapshot().ready)
  expect(JSON.parse(store.snapshot().text!)).toEqual({ name: "", baseUrl: "https://example.invalid/last-keystroke" })
  expect(memory.has(old.key)).toBe(true)
  handlers.SaveUserDraft = save
  const fresh = JSON.stringify({ name: "new deliberate name", baseUrl: "https://example.invalid/last-keystroke" })
  store.type(fresh, cleared.content)
  await until(() => saves.length > 0)
  expect(saves.at(-1)).toMatchObject({
    content: fresh,
    expectedRowVersion: 1,
    observedDeletion: { draftId: "draft", rowVersion: 5 }
  })
  expect(memory.has(old.key)).toBe(true)
})

it("a refused form initialization copy remains distinguishable from deliberate typing", async () => {
  const initial = JSON.stringify({ name: "", baseUrl: "" })
  const { store, handlers } = harness(new Draft({ ...draft("", 4), status: "committed" }))
  store.open()
  await until(() => store.snapshot().ready)
  handlers.SaveUserDraft = async () => {
    throw new Error("refused initialization")
  }
  store.type(JSON.stringify({ name: "last keystroke", baseUrl: "" }), initial)
  await until(() => [...memory.values()].some((copy) => copy.content === initial))
  expect([...memory.values()].find((copy) => copy.content === initial)?.save).toMatchObject({
    kind: "userDraft",
    payload: { seed: true }
  })
  expect([...memory.values()].some((copy) => copy.content.includes("last keystroke"))).toBe(true)
})

it("compound copies and closing saves retain the actual form edited, not a later server read", async () => {
  const initial = JSON.stringify({ name: "", baseUrl: "" })
  const { store, handlers, saves } = harness(draft(initial))
  store.open()
  await until(() => store.snapshot().ready)
  handlers.SaveUserDraft = async (save) => {
    saves.push(save)
    throw new Error("offline")
  }
  const typed = JSON.stringify({ name: "", baseUrl: "https://a.invalid" })
  store.type(typed, initial)
  await until(() => saves.length > 0)
  expect(saves[0]).toMatchObject({ content: typed, editingFrom: initial, expectedRowVersion: 1 })
  expect([...memory.values()].find((copy) => copy.content === typed)?.save).toMatchObject({
    kind: "userDraft",
    payload: { editingFrom: initial }
  })
})

it("clearing locally typed but unacknowledged text retains deletion intent in the next copy", async () => {
  const initial = JSON.stringify({ name: "", baseUrl: "" })
  const typed = JSON.stringify({ name: "locally typed name", baseUrl: "" })
  const cleared = JSON.stringify({ name: "", baseUrl: "" })
  const { store, handlers } = harness(draft(initial))
  store.open()
  await until(() => store.snapshot().ready)
  handlers.SaveUserDraft = async () => {
    throw new Error("lost acknowledgement")
  }
  store.type(typed, initial)
  store.type(cleared, initial)
  store.type(JSON.stringify({ name: "", baseUrl: "https://last.invalid" }), initial)
  const copy = [...memory.values()].find((copy) => copy.content.includes("https://last.invalid"))
  expect(copy?.save).toMatchObject({ kind: "userDraft", payload: { editingFrom: typed } })
})

it("an earlier acknowledgement cannot erase a later local clear before a failed intermediate save", async () => {
  const initial = JSON.stringify({ name: "", baseUrl: "" })
  const url = JSON.stringify({ name: "", baseUrl: "https://a.invalid" })
  const typed = JSON.stringify({ name: "Typed then removed", baseUrl: "https://a.invalid" })
  const { store, handlers, saves } = harness(draft(initial))
  store.open()
  await until(() => store.snapshot().ready)
  const first = deferred<Draft>()
  handlers.SaveUserDraft = async (input) => {
    saves.push(input)
    if (saves.length === 1) return first.promise
    if (input.content === typed) throw new Error("lost intermediate acknowledgement")
    return draft(input.content, 4)
  }
  store.type(url, initial)
  await until(() => saves.length === 1)
  store.type(typed, initial)
  store.type(url, initial)
  first.resolve(draft(url, 2))
  await until(() => saves.length === 3)
  expect(saves[2]).toMatchObject({ content: url, editingFrom: typed })
})

it("acknowledging a clear removes its old intent from a later unrelated input change", async () => {
  const original = JSON.stringify({ name: "Name actually cleared", baseUrl: "" })
  const cleared = JSON.stringify({ name: "", baseUrl: "" })
  const url = JSON.stringify({ name: "", baseUrl: "https://a.invalid" })
  const { store, handlers, saves } = harness(draft(original))
  store.open()
  await until(() => store.snapshot().ready)
  const first = deferred<Draft>()
  handlers.SaveUserDraft = async (input) => {
    saves.push(input)
    return saves.length === 1 ? first.promise : draft(input.content, 3)
  }
  store.type(cleared, original)
  await until(() => saves.length === 1)
  store.type(url, original)
  first.resolve(draft(cleared, 2))
  await until(() => saves.length === 2)
  expect(saves[1]).toMatchObject({ content: url, editingFrom: cleared })
})

it("anonymous clear evidence stays in durable copies and RPCs when the same text is reused offline", async () => {
  const original = JSON.stringify({ items: [{ name: "Deleted name", note: "" }] })
  const cleared = JSON.stringify({ items: [{ name: "", note: "" }] })
  const reused = JSON.stringify({ items: [{ name: "", note: "Deleted name" }] })
  const { store, handlers, saves } = harness(draft(original))
  store.open()
  await until(() => store.snapshot().ready)
  handlers.SaveUserDraft = async (input) => {
    saves.push(input)
    throw new Error("offline")
  }
  store.type(cleared, original)
  store.type(reused, original)
  const copy = [...memory.values()].find((copy) => copy.content === reused)
  expect(copy?.save).toMatchObject({
    kind: "userDraft",
    payload: { editingFrom: { content: original, clearedArrays: [["items"]] } }
  })
  await until(() => saves.length === 2)
  expect(saves[1]?.editingFrom).toEqual({ content: original, clearedArrays: [["items"]] })
})

it("a whole-field clear keeps its identity through closing saves and an earlier unrelated acknowledgement", async () => {
  const { store, handlers, saves } = harness()
  store.open()
  await until(() => store.snapshot().ready)
  const first = deferred<Draft>()
  handlers.SaveUserDraft = async (input) => {
    saves.push(input)
    if (saves.length === 1) return first.promise
    throw new Error("closed before later acknowledgements")
  }
  store.type("Intermediate text", "original")
  await until(() => saves.length === 1)
  store.type("", "original")
  store.type("Fresh after the clear", "original")
  const copy = [...memory.values()].find((copy) => copy.content === "Fresh after the clear")!
  expect(copy.save.kind).toBe("userDraft")
  if (copy.save.kind !== "userDraft") return
  const intent = copy.save.payload.editingFrom
  expect(intent).toMatchObject({ content: "", clearedArrays: [], clearId: expect.any(String) })
  const send = vi.fn(async () => new Response(null, { status: 204 }))
  vi.stubGlobal("fetch", send)
  try {
    store.leave()
    const init = send.mock.calls[0] as unknown as [string, RequestInit]
    expect(init[1].keepalive).toBe(true)
    expect(JSON.parse(init[1].body as string).userDrafts[0].editingFrom).toEqual(intent)
    first.resolve(draft("Intermediate text", 2))
    await until(() => saves.length === 3)
    expect(saves[1]?.editingFrom).toEqual(intent)
    expect(saves[2]?.editingFrom).toEqual(intent)
    expect(saves[2]?.expectedRowVersion).toBe(2)
  } finally {
    first.resolve(draft("Intermediate text", 2))
    vi.unstubAllGlobals()
    vi.stubGlobal("location", { protocol: "http:", host: "localhost" })
  }
})

it("a refused seed copy on a committed form keeps its blank starting snapshot when its base is current", async () => {
  const address = { targetId: "connection:new", field: "Settings" }
  const blank = JSON.stringify({ name: "", baseUrl: "" })
  const committed = new Draft({
    ...draft("", 5),
    key: new DraftKey({ targetKind: "user_field", ...address }),
    status: "committed",
    session: 2,
    deletions: { '["name"]': { draftId: "draft", rowVersion: 3, value: "Previous connection" } }
  })
  const seedCopy = makeCopy(
    ownerId,
    address.targetId,
    address.field,
    {
      kind: "userDraft",
      payload: {
        ownerId,
        ...address,
        content: blank,
        seed: true,
        draftId: committed.id,
        expectedRowVersion: committed.rowVersion,
        expectedSession: committed.session
      }
    },
    1
  )
  await keepCopy(seedCopy)
  const { store, handlers } = harness(committed, address.field, address.targetId)
  handlers.SaveUserDraft = async () => {
    throw new Error("offline during seed replay")
  }
  store.open()
  await until(() => store.snapshot().ready)
  expect(JSON.parse(store.snapshot().text!)).toEqual({ name: "", baseUrl: "" })
})
