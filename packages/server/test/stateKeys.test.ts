// Every id in every state key's value, through the real writer (DESIGN §11). The oracle
// below says what a correct event is, independently of `stateKeyIds`: a valid value built
// from one user's things, whether a key may name things in the bin (it removes them), and
// which fields must belong to another field of the value. The ids are the fields whose
// value differs between two users' things. Every key that `stateKeyIds` gives ids must
// have an entry, so a new key gets these checks too.
import { assert, describe, it, layer } from "@effect/vitest"
import { newChatNote } from "@rp/shared/editing.ts"
import type { ChatId, EntityId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import type { EntityKind, RefId, RevisionId } from "@rp/shared/library.ts"
import type { ConnectionId, ModelId } from "@rp/shared/providers.ts"
import { type FoldableEvent, type StateEventData, stateKeyIds } from "@rp/shared/state.ts"
import { Context, Effect, Layer } from "effect"
import * as Database from "../src/db/Database.ts"
import { tempDir } from "./support/tempDir.ts"
import { docFor } from "./support/docs.ts"

interface Item {
  readonly entity: EntityId
  readonly ref: RefId
  readonly revision: RevisionId
}

/** One user's things: an entity of each kind, with its ref and head revision, and a model. */
type Things = { readonly [K in EntityKind]: Item } & { readonly connection: ConnectionId; readonly model: ModelId }

type Value = Readonly<Record<string, unknown>>

interface Expected {
  readonly value: (t: Things) => Value
  /** Takes something out of the state, so it may name things in the bin. */
  readonly removes?: true
  /** Fields that must belong to another field: a ref or revision of its entity, a model of its connection. */
  readonly belongs?: ReadonlyArray<string>
}

const oracle: { readonly [K in StateEventData["key"]]?: Expected } = {
  "participant.join": { value: (t) => ({ entity: t.card.entity }) },
  "participant.leave": { value: (t) => ({ entity: t.card.entity }), removes: true },
  "presence.set": { value: (t) => ({ entity: t.card.entity, present: false }), removes: true },
  "played_by_me.set": { value: (t) => ({ entities: [t.card.entity] }) },
  "card.swap": { value: (t) => ({ entity: t.card.entity, replaces: t.card.entity }) },
  "card.binding": {
    value: (t) => ({ entity: t.card.entity, ref: t.card.ref, revision: t.card.revision }),
    belongs: ["ref", "revision"]
  },
  "note.activate": { value: (t) => ({ note: t.note.entity }) },
  "note.deactivate": { value: (t) => ({ note: t.note.entity }), removes: true },
  "note.binding": { value: (t) => ({ note: t.note.entity, revision: t.note.revision }), belongs: ["revision"] },
  "preset.binding": { value: (t) => ({ ref: t.preset.ref, revision: t.preset.revision }), belongs: ["revision"] },
  "preset_overlay.binding": { value: (t) => ({ overlay: t.preset_overlay.entity, on: true }) },
  "model.binding": { value: (t) => ({ connection: t.connection, model: t.model }), belongs: ["model"] },
  "lorebook.binding": { value: (t) => ({ entity: t.card.entity, ref: t.lorebook.ref }) },
  "lorebook.attach": { value: (t) => ({ ref: t.lorebook.ref }) },
  "lorebook.detach": { value: (t) => ({ ref: t.lorebook.ref }), removes: true },
  "lorebook.embedded": { value: (t) => ({ entity: t.card.entity, on: false }) },
  "lorebook.global": { value: (t) => ({ ref: t.lorebook.ref, on: false }) },
  "author_note.set": { value: (t) => ({ note: t.note.entity }) }
}

const kinds: ReadonlyArray<EntityKind> = ["card", "preset", "lorebook", "note", "preset_overlay"]

class Fixture extends Context.Service<
  Fixture,
  {
    /** Adds the event as bob; "ok" or the error tag. */
    readonly add: (key: string, value: Value, scope?: string) => Effect.Effect<string>
    readonly own: Things
    /** bob's too, but other things than `own`: a link from an `own` field fails. */
    readonly second: Things
    /** bob's, in the bin. */
    readonly deleted: Things
    readonly foreignNote: Item
    readonly theirs: Things
  }
>()("test/stateKeys/Fixture") {}

const fixture = Layer.effect(
  Fixture,
  Effect.gen(function* () {
    const writer = yield* Database.Writer
    const things = (userId: UserId, chatId: ChatId) =>
      Effect.gen(function* () {
        const items = yield* Effect.forEach(kinds, (kind) =>
          writer
            .CreateEntity({
              userId,
              kind,
              label: kind,
              subtitle: "",
              doc: kind === "note" ? newChatNote(chatId, kind) : docFor(kind, kind),
              schemaVersion: 1,
              origin: "user",
              sourcePath: null
            })
            .pipe(
              Effect.map(({ entityId, ref }) => [kind, { entity: entityId, ref: ref.id, revision: ref.headRevisionId }])
            )
        )
        const connection = yield* writer.CreateConnection({
          userId,
          connectionId: uuidv7() as ConnectionId,
          kind: "openai-chat",
          api: "openai-completions",
          settings: {
            name: "Local",
            baseUrl: "http://127.0.0.1:9/v1",
            compat: {},
            cacheTtlS: null,
            maxConcurrent: null,
            presetOverrideRefId: null
          },
          credential: { existing: null }
        })
        const model = yield* writer.AddUserModel({ userId, connectionId: connection.id, key: "m", overrides: {} })
        return { ...Object.fromEntries(items), connection: connection.id, model: model.id } as Things
      })
    const bob = (yield* writer.EnsureUser({ handle: "bob", displayName: "Bob" })).id
    const ana = (yield* writer.EnsureUser({ handle: "ana", displayName: "Ana" })).id
    const chat = yield* writer.CreateChat({
      userId: bob,
      kind: "rp",
      status: "active",
      title: "",
      participants: [],
      greeting: null
    })
    const deleted = yield* things(bob, chat.id)
    for (const kind of kinds) yield* writer.DeleteEntity({ userId: bob, entityId: deleted[kind].entity })
    yield* writer.DeleteConnection({ userId: bob, connectionId: deleted.connection })
    const otherChat = yield* writer.CreateChat({
      userId: bob,
      kind: "rp",
      status: "active",
      title: "Other",
      participants: [],
      greeting: null
    })
    const foreign = yield* writer.CreateChatNote({ userId: bob, chatId: otherChat.id, title: "Foreign" })
    return {
      foreignNote: { entity: foreign.entityId, ref: foreign.id, revision: foreign.headRevisionId },
      add: (key: string, value: Value, scope?: string) =>
        writer
          .AddStateEvent({
            userId: bob,
            chatId: chat.id,
            slotId: null,
            versionId: null,
            scope: (scope ?? null) as FoldableEvent["scope"],
            data: { key, value } as StateEventData
          })
          .pipe(
            Effect.map(() => "ok"),
            Effect.catch((error) => Effect.succeed(error._tag))
          ),
      own: yield* things(bob, chat.id),
      second: yield* things(bob, chat.id),
      deleted,
      theirs: yield* things(ana, otherChat.id)
    }
  })
).pipe(
  Layer.provide(
    Database.layer({
      dataDir: tempDir("state-keys"),
      readers: 1,
      allowNetworkFs: false,
      workers: "source"
    })
  )
)

const withIds = Object.entries(stateKeyIds)
  .filter(([, declared]) => Object.keys(declared.ids).length > 0)
  .map(([key]) => key)

/** The kind and table of an id among `t`'s library things, if it's one. */
const libraryItem = (t: Things, id: unknown) => {
  for (const kind of kinds) {
    for (const table of ["entity", "ref", "revision"] as const) {
      if (t[kind][table] === id) return { kind, table }
    }
  }
  return undefined
}

describe("state key oracle", () => {
  it("covers every key that names ids", () => {
    assert.deepStrictEqual(
      withIds.filter((key) => !(key in oracle)),
      []
    )
  })
})

layer(fixture, { excludeTestServices: true, timeout: "60 seconds" })("state key ids", (it) => {
  for (const [key, expected] of Object.entries(oracle) as Array<[string, Expected]>) {
    const outcome = (value: (f: Fixture["Service"]) => Value, result: string) =>
      Effect.flatMap(Fixture, (f) => Effect.map(f.add(key, value(f)), (r) => assert.strictEqual(r, result)))
    // The fields that hold ids: they differ between two users' things.
    const fields = Object.keys(expected.value(placeholder("a"))).filter(
      (field) =>
        JSON.stringify(expected.value(placeholder("a"))[field]) !==
        JSON.stringify(expected.value(placeholder("b"))[field])
    )
    const swap = (f: Fixture["Service"], field: string, from: Things) => ({
      ...expected.value(f.own),
      [field]: expected.value(from)[field]
    })

    it.effect(`${key}: the user's own things`, () => outcome((f) => expected.value(f.own), "ok"))
    it.effect(`${key}: things in the bin ${expected.removes ? "can be taken out" : "are NotFound"}`, () =>
      outcome((f) => expected.value(f.deleted), expected.removes ? "ok" : "NotFound")
    )
    for (const field of fields) {
      it.effect(`${key}.${field}: another user's is NotFound`, () =>
        outcome((f) => swap(f, field, f.theirs), "NotFound")
      )
      const held = expected.value(placeholder("a"))[field]
      const item = libraryItem(placeholder("a"), Array.isArray(held) ? held[0] : held)
      if (item !== undefined) {
        const other = item.kind === "card" ? "note" : "card"
        it.effect(`${key}.${field}: a ${other} instead of a ${item.kind} is NotFound`, () =>
          outcome((f) => {
            const id = f.own[other][item.table]
            return { ...expected.value(f.own), [field]: Array.isArray(held) ? [id] : id }
          }, "NotFound")
        )
      }
      if (expected.belongs?.includes(field)) {
        it.effect(`${key}.${field}: one that doesn't belong to the value's other ids is NotFound`, () =>
          outcome((f) => swap(f, field, f.second), "NotFound")
        )
      }
    }
  }

  for (const key of ["note.activate", "note.deactivate", "note.binding", "author_note.set"] as const) {
    it.effect(`${key}: another chat's note is NotFound`, () =>
      Effect.gen(function* () {
        const f = yield* Fixture
        const value =
          key === "note.binding"
            ? { note: f.foreignNote.entity, revision: f.foreignNote.revision }
            : { note: f.foreignNote.entity }
        assert.strictEqual(yield* f.add(key, value), "NotFound")
      })
    )
  }

  // An event's scope, when it isn't a role, is a participant: a card of the user's.
  const scoped = (scope: (f: Fixture["Service"]) => string, result: string) =>
    Effect.flatMap(Fixture, (f) =>
      Effect.map(f.add("preset.binding", { ref: f.own.preset.ref }, scope(f)), (r) => assert.strictEqual(r, result))
    )
  it.effect("scope: a role", () => scoped(() => "narrator", "ok"))
  it.effect("scope: the user's own card", () => scoped((f) => f.own.card.entity, "ok"))
  it.effect("scope: another user's card is NotFound", () => scoped((f) => f.theirs.card.entity, "NotFound"))
  it.effect("scope: a note instead of a card is NotFound", () => scoped((f) => f.own.note.entity, "NotFound"))
  it.effect("scope: a card in the bin is NotFound", () => scoped((f) => f.deleted.card.entity, "NotFound"))
})

/** Things with made-up ids, only to tell id fields from the rest. */
function placeholder(prefix: string): Things {
  const item = (kind: string) =>
    ({ entity: `${prefix}-${kind}-e`, ref: `${prefix}-${kind}-r`, revision: `${prefix}-${kind}-v` }) as unknown as Item
  return {
    card: item("card"),
    preset: item("preset"),
    lorebook: item("lorebook"),
    note: item("note"),
    preset_overlay: item("preset_overlay"),
    connection: `${prefix}-c` as ConnectionId,
    model: `${prefix}-m` as ModelId
  }
}
