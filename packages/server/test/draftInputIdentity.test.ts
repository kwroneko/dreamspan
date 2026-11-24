import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { editingOrigin } from "@dreamspan/shared/draftDeletions.ts"
import { Generator } from "../src/chat/Generator.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
it.live("a cleared array input stays deleted when an offline snapshot reordered its items", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const ownerId = (yield* api.Whoami()).id
    const address = { ownerId, targetId: "global-regex", field: "Global regex scripts" }
    const a = { id: "a", name: "Alpha", findRegex: "first" },
      b = { id: "b", name: "Bravo deleted on B", findRegex: "second" }
    const first = yield* api.SaveUserDraft({
      ...address,
      draftId: null,
      expectedRowVersion: null,
      expectedSession: null,
      content: JSON.stringify({ revision: 1, scripts: [a, b] })
    })
    const base = { ...address, draftId: first.id, expectedRowVersion: first.rowVersion, expectedSession: first.session }
    // A reorders the scripts while offline. B clears Bravo's name without that reorder.
    const deleted = yield* api.SaveUserDraft({
      ...base,
      content: JSON.stringify({ revision: 1, scripts: [a, { ...b, name: "" }] })
    })
    assert.strictEqual(JSON.parse(deleted.content).scripts[1].name, "")
    const replay = yield* api.SaveUserDraft({ ...base, content: JSON.stringify({ revision: 1, scripts: [b, a] }) })
    assert.strictEqual(
      (JSON.parse(replay.content) as { scripts: Array<{ id: string; name: string }> }).scripts.find((s) => s.id === "b")
        ?.name,
      ""
    )
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
)
it.live("an older-build initialization copy must not invent deletion over real keystrokes", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const ownerId = (yield* api.Whoami()).id
    const address = { ownerId, targetId: "connection:legacy-initialization", field: "Settings" }
    const empty = JSON.stringify({ name: "", baseUrl: "" }),
      typed = JSON.stringify({ name: "last keystroke", baseUrl: "" })
    const first = yield* api.SaveUserDraft({
      ...address,
      draftId: null,
      expectedRowVersion: null,
      expectedSession: null,
      content: empty
    })
    const base = { ...address, draftId: first.id, expectedRowVersion: first.rowVersion, expectedSession: first.session }
    yield* api.SaveUserDraft({ ...base, content: typed })
    // Old versions persisted this initialization payload without the new seed bit.
    yield* api.SaveUserDraft({ ...base, content: empty })
    const replay = yield* api.SaveUserDraft({ ...base, content: typed })
    assert.strictEqual(replay.content, typed)
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
)

it.live("typing in an unrelated stale input must not create a deletion of another device's keystroke", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const ownerId = (yield* api.Whoami()).id
    const address = { ownerId, targetId: "connection:two-tabs", field: "Settings" }
    const first = yield* api.SaveUserDraft({
      ...address,
      draftId: null,
      expectedRowVersion: null,
      expectedSession: null,
      content: JSON.stringify({ name: "", baseUrl: "" })
    })
    const base = { ...address, draftId: first.id, expectedRowVersion: first.rowVersion, expectedSession: first.session }
    const b = JSON.stringify({ name: "B final keystroke", baseUrl: "" })
    yield* api.SaveUserDraft({ ...base, content: b })
    yield* api.SaveUserDraft({ ...base, content: JSON.stringify({ name: "", baseUrl: "https://a.invalid" }) })
    const replay = yield* api.SaveUserDraft({ ...base, content: b })
    assert.strictEqual(JSON.parse(replay.content).name, "B final keystroke")
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
)

for (const reverse of [false, true])
  for (const operation of ["reorder", "insert", "remove-other", "remove-target"] as const)
    it.live(`array clears follow identity through ${operation}, reversed=${reverse}`, () =>
      Effect.gen(function* () {
        const api = yield* client()
        const ownerId = (yield* api.Whoami()).id
        const address = { ownerId, targetId: `identity:${reverse}:${operation}`, field: "Scripts" }
        const a = { id: "a", name: "Alpha", findRegex: "first" },
          b = { id: "b", name: "Bravo deleted", findRegex: "second" },
          c = { id: "c", name: "Charlie newly typed", findRegex: "third" }
        const items = reverse ? [b, a] : [a, b]
        const content = JSON.stringify({ scripts: items })
        const first = yield* api.SaveUserDraft({
          ...address,
          content,
          draftId: null,
          expectedRowVersion: null,
          expectedSession: null
        })
        const base = {
          ...address,
          draftId: first.id,
          expectedRowVersion: first.rowVersion,
          expectedSession: first.session
        }
        const cleared = yield* api.SaveUserDraft({
          ...base,
          editingFrom: content,
          content: JSON.stringify({ scripts: items.map((item) => (item.id === "b" ? { ...item, name: "" } : item)) })
        })
        assert.isTrue(Object.keys(cleared.deletions!).some((key) => key.includes("id=b")))
        const offline =
          operation === "reorder"
            ? [...items].reverse()
            : operation === "insert"
              ? [c, ...items].reverse()
              : operation === "remove-other"
                ? [b]
                : [a]
        const replay = yield* api.SaveUserDraft({
          ...base,
          editingFrom: content,
          content: JSON.stringify({ scripts: offline })
        })
        // A stale form is refused whole (owner, 2026-11-24): the clear stands as it was saved,
        // nothing of the offline copy merged in, and the copy is offered back.
        assert.strictEqual(replay.content, cleared.content)
        assert.strictEqual(replay.refused?.content, JSON.stringify({ scripts: offline }))
        // The tab that cleared the name saves on as before.
        const next = JSON.stringify({ scripts: [...JSON.parse(cleared.content).scripts, c] })
        const later = yield* api.SaveUserDraft({ ...base, expectedRowVersion: cleared.rowVersion, content: next })
        assert.strictEqual(later.content, next)
      }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
    )

it.live("a stale clear is refused whole: no barrier, the other device's input kept, the clear offered back", () =>
  Effect.gen(function* () {
    const api = yield* client(),
      ownerId = (yield* api.Whoami()).id
    const address = { ownerId, targetId: "proved-input-clear", field: "Settings" }
    const initial = JSON.stringify({ name: "Original name", baseUrl: "" })
    const first = yield* api.SaveUserDraft({
      ...address,
      draftId: null,
      expectedRowVersion: null,
      expectedSession: null,
      content: initial
    })
    const base = { ...address, draftId: first.id, expectedRowVersion: first.rowVersion, expectedSession: first.session }
    const remote = yield* api.SaveUserDraft({
      ...base,
      editingFrom: initial,
      content: JSON.stringify({ name: "Remote name", baseUrl: "https://b.invalid" })
    })
    const clear = JSON.stringify({ name: "", baseUrl: "" })
    const cleared = yield* api.SaveUserDraft({ ...base, editingFrom: initial, content: clear })
    assert.strictEqual(cleared.content, remote.content)
    assert.strictEqual(cleared.refused?.content, clear)
    assert.deepStrictEqual(Object.keys(cleared.deletions ?? {}), [])
    // Chosen again on the current version ("Use this tab's version"), the clear is a clear.
    const used = yield* api.SaveUserDraft({
      ...base,
      expectedRowVersion: cleared.rowVersion,
      editingFrom: remote.content,
      content: clear
    })
    assert.strictEqual(used.content, clear)
    assert.deepStrictEqual(Object.keys(used.deletions!).sort(), ['["baseUrl"]', '["name"]'])
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
)

it.live("anonymous-array deletion conflicts retain the array instead of projecting positions", () =>
  Effect.gen(function* () {
    const api = yield* client(),
      ownerId = (yield* api.Whoami()).id
    const address = { ownerId, targetId: "anonymous-array", field: "Inputs" }
    const initial = JSON.stringify({ items: [{ name: "Alpha" }, { name: "Bravo deleted" }], other: "" })
    const first = yield* api.SaveUserDraft({
      ...address,
      draftId: null,
      expectedRowVersion: null,
      expectedSession: null,
      content: initial
    })
    const base = { ...address, draftId: first.id, expectedRowVersion: first.rowVersion, expectedSession: first.session }
    const cleared = yield* api.SaveUserDraft({
      ...base,
      editingFrom: initial,
      content: JSON.stringify({ items: [{ name: "Alpha" }, { name: "" }], other: "" })
    })
    const stale = JSON.stringify({
      items: [{ name: "Bravo deleted" }, { name: "Alpha" }],
      other: "unrelated last keystroke"
    })
    const replay = yield* api.SaveUserDraft({ ...base, editingFrom: initial, content: stale })
    // Refused whole (owner, 2026-11-24): nothing projected, the copy one step back in history.
    assert.strictEqual(replay.content, cleared.content)
    assert.strictEqual(replay.refused?.content, stale)
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
)

it.live("retrying an actual clear cannot create a new barrier while updating another input", () =>
  Effect.gen(function* () {
    const api = yield* client(),
      ownerId = (yield* api.Whoami()).id
    const address = { ownerId, targetId: "clear-acknowledgement", field: "Settings" }
    const initial = JSON.stringify({ name: "", baseUrl: "" })
    const typed = JSON.stringify({ name: "Name before clearing", baseUrl: "" })
    const first = yield* api.SaveUserDraft({
      ...address,
      draftId: null,
      expectedRowVersion: null,
      expectedSession: null,
      content: initial
    })
    const base = { ...address, draftId: first.id, expectedRowVersion: first.rowVersion, expectedSession: first.session }
    const named = yield* api.SaveUserDraft({ ...base, editingFrom: initial, content: typed })
    const onNamed = { ...base, expectedRowVersion: named.rowVersion }
    const cleared = yield* api.SaveUserDraft({ ...onNamed, editingFrom: typed, content: initial })
    assert.isNotEmpty(Object.keys(cleared.deletions!))
    // Retried on the version it cleared from, with another input changed: a stale form, refused,
    // so no new barrier either.
    const repeated = yield* api.SaveUserDraft({
      ...onNamed,
      editingFrom: typed,
      content: JSON.stringify({ name: "", baseUrl: "https://last.invalid" })
    })
    assert.deepStrictEqual(repeated.deletions, cleared.deletions)
    assert.strictEqual(repeated.content, cleared.content)
    const freshText = JSON.stringify({ name: "Fresh after the actual deletion", baseUrl: "" })
    const fresh = yield* api.SaveUserDraft({
      ...base,
      expectedRowVersion: cleared.rowVersion,
      editingFrom: initial,
      content: freshText
    })
    assert.strictEqual(fresh.content, freshText)
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
)

it.live("an offline anonymous clear remains protected when its text is reused before acknowledgement", () =>
  Effect.gen(function* () {
    const api = yield* client(),
      ownerId = (yield* api.Whoami()).id
    const address = { ownerId, targetId: "anonymous-reused-clear", field: "Inputs" }
    const original = JSON.stringify({ items: [{ name: "Deleted name", note: "", other: "" }] })
    const clear = JSON.stringify({ items: [{ name: "", note: "", other: "" }] })
    const moved = JSON.stringify({ items: [{ name: "", note: "Deleted name", other: "" }] })
    const origin = editingOrigin(editingOrigin(original, original, clear), clear, moved)
    const first = yield* api.SaveUserDraft({
      ...address,
      draftId: null,
      expectedRowVersion: null,
      expectedSession: null,
      content: original
    })
    const base = { ...address, draftId: first.id, expectedRowVersion: first.rowVersion, expectedSession: first.session }
    const saved = yield* api.SaveUserDraft({ ...base, content: moved, editingFrom: origin })
    assert.isNotEmpty(Object.keys(saved.deletions!))
    const stale = JSON.stringify({ items: [{ name: "Deleted name", note: "", other: "unrelated fresh key" }] })
    const replay = yield* api.SaveUserDraft({ ...base, editingFrom: original, content: stale })
    // Refused whole (owner, 2026-11-24): the clear stands, the copy offered back.
    assert.strictEqual(replay.content, moved)
    assert.strictEqual(replay.refused?.content, stale)
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
)
