import type { UserId } from "@rp/shared/domain.ts"
import { Draft, DraftKey, DraftState } from "@rp/shared/drafts.ts"
import type { UserDraftSave } from "@rp/shared/editorApi.ts"
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
const { UserDraftStore } = await import("../src/features/editor/userDraft.tsx")
const ownerId = "author" as UserId
const key = new DraftKey({ targetKind: "user_field", targetId: "test", field: "Instruction" })
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
const harness = (initial = draft("original")) => {
  let current = initial
  const saves: Array<typeof UserDraftSave.Type> = []
  const handlers = {
    GetUserDraft: async () => current,
    SaveUserDraft: async (save: typeof UserDraftSave.Type) => {
      saves.push(save)
      current = draft(save.content, current.rowVersion + 1)
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
  const store = new UserDraftStore(ownerId, key.targetId, key.field, run)
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
