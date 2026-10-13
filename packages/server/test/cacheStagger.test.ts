// Actual generation RPCs, assembly, SDK HTTP, worker ledger and chat subscriptions.
import { assert, describe, it } from "@effect/vitest"
import type { ServerResponse } from "node:http"
import type { VersionId } from "@rp/shared/chat.ts"
import { Effect, Stream } from "effect"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { completionChunks, startMockProvider } from "./support/mockProvider.ts"

import { presetDoc } from "./support/docs.ts"

type Api = Effect.Success<ReturnType<typeof client>>
type Fixture = Effect.Success<ReturnType<typeof generateReply>>

const answer = (res: ServerResponse, read: boolean, kind: string, firstOnly = false) => {
  const events: ReadonlyArray<Record<string, unknown>> =
    kind === "openai-chat"
      ? completionChunks(["A synthetic reply."], {
          prompt_tokens: 120,
          completion_tokens: 4,
          prompt_tokens_details: { cached_tokens: read ? 100 : 0 }
        })
      : [
          {
            type: "message_start",
            message: {
              id: "msg_test",
              type: "message",
              role: "assistant",
              model: "mock-model",
              content: [],
              stop_reason: null,
              usage: {
                input_tokens: 20,
                cache_read_input_tokens: read ? 100 : 0,
                cache_creation_input_tokens: read ? 0 : 100,
                output_tokens: 1
              }
            }
          },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "A synthetic reply." } },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 4 }
          },
          { type: "message_stop" }
        ]
  res.writeHead(200, { "content-type": "text/event-stream" })
  const send = (event: Record<string, unknown>) =>
    res.write(`${kind === "anthropic" ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`)
  send(events[0]!)
  const finish = () => {
    for (const event of events.slice(1)) send(event)
    if (kind !== "anthropic") res.write("data: [DONE]\n\n")
    res.end()
  }
  if (!firstOnly) finish()
  return finish
}

const fixture = (api: Api, kind = "anthropic") =>
  Effect.gen(function* () {
    const cached = new Set<string>()
    const prefix = (body: Record<string, unknown> | null) => JSON.stringify([body?.system, body?.messages])
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startMockProvider((request, res) => {
          const key = prefix(request.body)
          const read = cached.has(key)
          cached.add(key)
          answer(res, read, kind)
        })
      ),
      (m) => Effect.promise(() => m.close())
    )
    const setup = yield* generateReply(api, {
      connection: {
        kind,
        baseUrl: kind === "anthropic" ? mock.url : `${mock.url}/v1`,
        apiKey: "synthetic-key",
        cacheTtlS: 300
      },
      model: { cacheBreakpoints: kind === "anthropic" ? "explicit" : "auto" }
    })
    const pending: Array<{ res: ServerResponse; read: boolean; key: string }> = []
    mock.setHandler((request, res) => {
      const key = prefix(request.body)
      pending.push({ res, read: cached.has(key), key })
    })
    return {
      ...setup,
      pending,
      emit: (index: number, firstOnly = false) => {
        const p = pending[index]!
        cached.add(p.key)
        return answer(p.res, p.read, kind, firstOnly)
      }
    }
  })

const makeCold = (api: Api, f: Fixture, preset = false) =>
  Effect.gen(function* () {
    if (preset) {
      const changed = yield* (yield* Writer).CreateEntity({
        userId: (yield* api.Whoami()).id,
        kind: "preset",
        label: "Changed synthetic prefix",
        subtitle: "",
        doc: presetDoc([{ identifier: "main", content: "Write a fictional harbor report." }]),
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: f.connection.id, model: f.model.id }, preset: changed.ref.id }
      })
      return
    }
    const path = yield* api.ReadPath({ chatId: f.chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
    const sent = path.entries[1]!
    yield* api.EditVersion({
      slotId: sent.slotId,
      sourceVersionId: sent.version.id,
      content: "A new synthetic cache prefix.",
      expectedRowVersion: sent.rowVersion
    })
  })

const swipe = (api: Api, f: Fixture) =>
  Effect.gen(function* () {
    const reader = yield* Reader
    const me = yield* api.Whoami()
    const { entry } = yield* reader.GetSlot({ userId: me.id, slotId: f.version.slotId })
    return yield* api.Regenerate({ slotId: entry.slotId, expectedRowVersion: entry.rowVersion })
  })

const waiting = (f: Fixture, id: VersionId) =>
  f.events.some((e) => e._tag === "WaitingCache" && e.versionId === id && e.waiting)
const ledger = (api: Api, ids: ReadonlyArray<VersionId>) =>
  api
    .ListLlmRequests({ limit: 100, before: null })
    .pipe(Effect.map((rows) => rows.filter((r) => r.versionId !== null && ids.includes(r.versionId))))

describe("cold-cache stagger at the generation boundary", () => {
  for (const kind of ["anthropic", "openai-chat"]) {
    it.live(
      `${kind}: cold parallel swipes write once and followers read after the first chunk`,
      () =>
        Effect.gen(function* () {
          const api = yield* client()
          const f = yield* fixture(api, kind)
          yield* makeCold(api, f, kind === "openai-chat")
          const leader = yield* swipe(api, f)
          yield* eventually(() => f.pending.length === 1)
          const followers = [yield* swipe(api, f), yield* swipe(api, f), yield* swipe(api, f)]
          yield* eventually(() => followers.every((e) => waiting(f, e.version.id)))
          assert.strictEqual(f.pending.length, 1, "only the leader reached HTTP")
          const hello = yield* api.SubscribeChat({ chatId: f.chat.id }).pipe(Stream.take(1), Stream.runCollect)
          assert.isTrue(
            hello
              .flat()
              .some(
                (event) =>
                  event._tag === "Hello" &&
                  event.live.some((v) => v.versionId === followers[0]!.version.id && v.waitingCache)
              )
          )
          // Held versions already exist and remain stoppable.
          const live = (yield* (yield* Reader).GetSlot({ userId: (yield* api.Whoami()).id, slotId: leader.slotId }))
            .entry
          assert.strictEqual(live.version.status, "generating")
          const finishLeader = f.emit(0, true)
          yield* eventually(() => f.pending.length === 4)
          assert.isUndefined(finished(f.events, leader.version.id), "followers start before the leader finishes")
          finishLeader()
          for (let i = 1; i < 4; i++) f.emit(i)
          const ids = [leader, ...followers].map((e) => e.version.id)
          yield* eventually(() => ids.every((id) => finished(f.events, id) !== undefined))
          const rows = yield* ledger(api, ids)
          assert.deepStrictEqual(
            rows
              .filter((r) => r.cacheStagger)
              .map((r) => [r.cacheStagger!.release, r.cacheStagger!.hit, r.counts.cacheRead]),
            Array.from({ length: 3 }, () => ["first-chunk" as const, true, 100])
          )
          if (kind === "anthropic") {
            assert.strictEqual(
              rows.reduce((n, r) => n + (r.counts.cacheWrite ?? 0), 0),
              100
            )
          }
          assert.strictEqual(
            rows.reduce((n, r) => n + (r.counts.cacheRead ?? 0), 0),
            300
          )
        }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig()))),
      60_000
    )
  }

  it.live("a warm prefix starts every swipe before any response chunk", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const f = yield* fixture(api)
      const swipes = [yield* swipe(api, f), yield* swipe(api, f), yield* swipe(api, f)]
      yield* eventually(() => f.pending.length === 3)
      assert.isFalse(swipes.some((e) => waiting(f, e.version.id)))
      for (let i = 0; i < 3; i++) f.emit(i)
      yield* eventually(() => swipes.every((e) => finished(f.events, e.version.id) !== undefined))
      assert.isTrue(
        (yield* ledger(
          api,
          swipes.map((e) => e.version.id)
        )).every((r) => r.cacheStagger === null && r.counts.cacheRead === 100)
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("the timeout releases a follower even without a leader chunk", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const f = yield* fixture(api)
      yield* makeCold(api, f)
      const leader = yield* swipe(api, f)
      yield* eventually(() => f.pending.length === 1)
      const follower = yield* swipe(api, f)
      yield* eventually(() => waiting(f, follower.version.id))
      yield* eventually(() => f.pending.length === 2, 15_000)
      f.emit(1)
      f.emit(0)
      yield* eventually(
        () =>
          finished(f.events, follower.version.id) !== undefined && finished(f.events, leader.version.id) !== undefined
      )
      const row = (yield* ledger(api, [follower.version.id]))[0]!
      assert.deepStrictEqual([row.cacheStagger?.release, row.cacheStagger?.hit], ["timeout", false])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("stopping the leader releases followers; a stopped follower never reaches HTTP", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const f = yield* fixture(api)
      yield* makeCold(api, f)
      const leader = yield* swipe(api, f)
      yield* eventually(() => f.pending.length === 1)
      const stopped = yield* swipe(api, f)
      const follower = yield* swipe(api, f)
      yield* eventually(() => waiting(f, stopped.version.id) && waiting(f, follower.version.id))
      assert.strictEqual((yield* api.StopGeneration({ versionId: stopped.version.id })).status, "stopped")
      assert.strictEqual((yield* api.StopGeneration({ versionId: leader.version.id })).status, "stopped")
      yield* eventually(() => f.pending.length === 2)
      f.emit(1)
      yield* eventually(() => finished(f.events, follower.version.id) !== undefined)
      assert.strictEqual((yield* ledger(api, [follower.version.id]))[0]!.cacheStagger?.release, "leader-ended")
      assert.strictEqual(f.pending.length, 2)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("one user's leader never holds another user's matching prefix", () =>
    Effect.gen(function* () {
      const alice = yield* client({ "Remote-User": "alice" })
      const bob = yield* client({ "Remote-User": "bob" })
      const a = yield* fixture(alice)
      const b = yield* fixture(bob)
      yield* makeCold(alice, a)
      yield* makeCold(bob, b)
      const leaderA = yield* swipe(alice, a)
      yield* eventually(() => a.pending.length === 1)
      const followerA = yield* swipe(alice, a)
      yield* eventually(() => waiting(a, followerA.version.id))
      const leaderB = yield* swipe(bob, b)
      yield* eventually(() => b.pending.length === 1)
      assert.isFalse(waiting(b, leaderB.version.id))
      b.emit(0)
      yield* eventually(() => finished(b.events, leaderB.version.id) !== undefined)
      assert.strictEqual(a.pending.length, 1)
      yield* alice.StopGeneration({ versionId: leaderA.version.id })
      yield* eventually(() => a.pending.length === 2)
      a.emit(1)
      yield* eventually(() => finished(a.events, followerA.version.id) !== undefined)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig({ authMode: "proxy" }))))
  )
})
