// GetSession: who the caller is and how they're signed in. It only ever describes the
// caller's own connection, never another user's.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import type { AppConfigShape } from "../src/config.ts"
import { client, testConfig, withServer } from "./support/config.ts"

const login = (config: AppConfigShape, handle: string, password: string) =>
  Effect.promise(() =>
    fetch(`http://127.0.0.1:${config.port}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle, password })
    })
  ).pipe(Effect.map((response) => ({ cookie: (response.headers.get("set-cookie") ?? "").split(";")[0]! })))

const via = <E>(effect: Effect.Effect<{ readonly user: { readonly handle: string }; readonly via: string }, E>) =>
  effect.pipe(
    Effect.map((session) => `${session.user.handle}:${session.via}`),
    Effect.catch((error: E) => Effect.succeed((error as { _tag: string })._tag))
  )

describe("GetSession", () => {
  it.live("passwordless, then logged in: each caller sees only their own session", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const local = yield* client(config)
      assert.strictEqual(yield* via(local.GetSession()), "local:local")

      const me = yield* local.Whoami()
      yield* local.SetPassword({ userId: me.id, currentPassword: null, newPassword: "local-password-1" })
      // A password makes login required, so the passwordless connection is now nobody.
      assert.strictEqual(yield* via(local.GetSession()), "Unauthorized")

      const admin = yield* client(config, yield* login(config, "local", "local-password-1"))
      assert.strictEqual(yield* via(admin.GetSession()), "local:session")
      yield* admin.CreateUser({ handle: "bob", displayName: "Bob", role: "user", password: "bob-password-1" })

      const bob = yield* client(config, yield* login(config, "bob", "bob-password-1"))
      assert.strictEqual(yield* via(bob.GetSession()), "bob:session")
      assert.strictEqual(yield* via(admin.GetSession()), "local:session")
    }).pipe(Effect.scoped, withServer(config))
  })

  it.live("LOOPBACK_REQUIRES_LOGIN=false: loopback is the first admin, without a session", () => {
    const config = testConfig({ loopbackRequiresLogin: false })
    return Effect.gen(function* () {
      const local = yield* client(config)
      const me = yield* local.Whoami()
      yield* local.SetPassword({ userId: me.id, currentPassword: null, newPassword: "local-password-1" })
      assert.strictEqual(yield* via(local.GetSession()), "local:loopback")
    }).pipe(Effect.scoped, withServer(config))
  })

  it.live("proxy mode: the header names the user, and each sees only themselves", () => {
    const config = testConfig({ authMode: "proxy" })
    return Effect.gen(function* () {
      const alice = yield* client(config, { "Remote-User": "alice" })
      const bob = yield* client(config, { "Remote-User": "bob" })
      assert.strictEqual(yield* via(alice.GetSession()), "alice:proxy")
      assert.strictEqual(yield* via(bob.GetSession()), "bob:proxy")
      assert.strictEqual(yield* via((yield* client(config)).GetSession()), "Unauthorized")
    }).pipe(Effect.scoped, withServer(config))
  })
})
