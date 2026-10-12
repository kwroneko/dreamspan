// How uploads and exports share the server (ARCHITECTURE.md §11.4): a stalled upload is
// answered and dropped, holds no memory permit until its bytes flow, never holds up exports,
// and a user's own transfers wait their turn instead of failing.
import { readFileSync } from "node:fs"
import { request } from "node:http"
import { assert, layer } from "@effect/vitest"
import { ImportResult } from "@rp/shared/libraryImport.ts"
import { Effect, Schema } from "effect"
import { client, login, serverLayer, testConfig } from "./support/config.ts"

const config = testConfig()
const base = `http://127.0.0.1:${config.port}`
const presetFile = readFileSync(new URL("./fixtures/presets/default.json", import.meta.url))

const upload = (cookie: string) =>
  Effect.promise(() =>
    fetch(`${base}/library/import?name=p.json`, {
      method: "POST",
      headers: { cookie, "content-type": "application/octet-stream" },
      body: presetFile
    })
  )

const exportPreset = (cookie: string, refId: string) =>
  Effect.promise(() =>
    fetch(`${base}/library/export`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ refId, format: "st-preset" })
    }).then((response) => response.status)
  )

/**
 * An upload that declares 100 KB and sends `bytes` of it, then stalls. Resolves to the
 * status the server answers with, or "reset" if it cuts the connection without one.
 */
const stall = (cookie: string, bytes: number) => {
  const req = request(`${base}/library/import?name=slow.json`, {
    method: "POST",
    agent: false,
    headers: { cookie, "content-type": "application/octet-stream", "content-length": "100000" }
  })
  const answer = new Promise<number | "reset">((resolve) => {
    req.on("response", (response) => {
      response.resume()
      resolve(response.statusCode!)
    })
    req.on("error", () => resolve("reset"))
  })
  if (bytes > 0) req.write(Buffer.alloc(bytes))
  else req.flushHeaders()
  return { answer, stop: () => req.destroy() }
}

/** Milliseconds `effect` took, with its result. */
const timed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const start = Date.now()
    const result = yield* effect
    return { result, ms: Date.now() - start }
  })

type Parties = { alice: string; bob: string; carol: string; carolPreset: string }
let parties: Parties | undefined

/** Three users' session cookies and a preset of carol's, made once for the file. */
const setup = Effect.suspend(() => (parties ? Effect.succeed(parties) : makeParties))

const makeParties = Effect.gen(function* () {
  const local = yield* client(config)
  const admin = yield* local.Whoami()
  yield* local.SetPassword({ userId: admin.id, currentPassword: null, newPassword: "alice-password" })
  const alice = (yield* login(config, admin.handle, "alice-password")).cookie
  const aliceApi = yield* client(config, { cookie: alice })
  for (const handle of ["bob", "carol"]) {
    yield* aliceApi.CreateUser({ handle, displayName: handle, role: "user", password: `${handle}-password` })
  }
  const bob = (yield* login(config, "bob", "bob-password")).cookie
  const carol = (yield* login(config, "carol", "carol-password")).cookie
  const imported = yield* Effect.promise(() => Effect.runPromise(upload(carol)).then((r) => r.json()))
  const carolPreset = Schema.decodeUnknownSync(ImportResult)(imported).library!.ref.id
  parties = { alice, bob, carol, carolPreset }
  return parties
})

layer(serverLayer(config), { excludeTestServices: true, timeout: "120 seconds" })("transfers", (it) => {
  it.effect("a stalled upload is answered with 408 after a pause, then dropped", () =>
    Effect.gen(function* () {
      const { alice } = yield* setup
      const stalled = stall(alice, 10)
      const { result, ms } = yield* timed(Effect.promise(() => stalled.answer))
      stalled.stop()
      assert.strictEqual(result, 408)
      assert.isBelow(ms, 30_000)
    })
  )

  it.effect("others' stalled uploads hold up neither exports nor uploads that have nothing to send yet", () =>
    Effect.gen(function* () {
      const { alice, bob, carol, carolPreset } = yield* setup
      // Bytes sent: these two take both upload permits until they're dropped.
      const flowing = [stall(alice, 10), stall(bob, 10)]
      yield* Effect.sleep("500 millis")
      const { result: exported, ms } = yield* timed(exportPreset(carol, carolPreset))
      assert.strictEqual(exported, 200)
      assert.isBelow(ms, 5_000, "an export waited on others' uploads")
      flowing.forEach((s) => s.stop())
      yield* Effect.promise(() => Promise.all(flowing.map((s) => s.answer)))

      // Nothing sent: these hold no permit, so another user's upload goes straight through.
      const silent = [stall(alice, 0), stall(bob, 0)]
      yield* Effect.sleep("500 millis")
      const { result: uploaded, ms: uploadMs } = yield* timed(upload(carol))
      assert.strictEqual(uploaded.status, 200)
      assert.isBelow(uploadMs, 5_000, "an upload waited on others' silent ones")
      silent.forEach((s) => s.stop())
    })
  )

  it.effect("a user's export during their own upload waits for it instead of failing", () =>
    Effect.gen(function* () {
      const { carol, carolPreset } = yield* setup
      const stalled = stall(carol, 10)
      yield* Effect.sleep("500 millis")
      const exported = yield* exportPreset(carol, carolPreset)
      assert.strictEqual(exported, 200)
      assert.strictEqual(yield* Effect.promise(() => stalled.answer), 408)
    })
  )
})
