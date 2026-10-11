// GetSession: how the caller is signed in, in each mode. That it only ever describes the
// caller is in the isolation matrix.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { client, login, outcome, testConfig, withServer } from "./support/config.ts"

const via = <E>(effect: Effect.Effect<{ readonly user: { readonly handle: string }; readonly via: string }, E>) =>
  outcome(effect, (session) => `${session.user.handle}:${session.via}`)

describe("GetSession", () => {
  it.live("passwordless, then logged in", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const local = yield* client()
      assert.strictEqual(yield* via(local.GetSession()), "local:local")

      const me = yield* local.Whoami()
      yield* local.SetPassword({ userId: me.id, currentPassword: null, newPassword: "local-password-1" })
      // A password makes login required, so the passwordless connection is now nobody.
      assert.strictEqual(yield* via(local.GetSession()), "Unauthorized")

      const admin = yield* client({ cookie: (yield* login("local", "local-password-1")).cookie })
      assert.strictEqual(yield* via(admin.GetSession()), "local:session")
    }).pipe(Effect.scoped, withServer(config))
  })

  it.live("LOOPBACK_REQUIRES_LOGIN=false: loopback is the first admin, without a session", () => {
    const config = testConfig({ loopbackRequiresLogin: false })
    return Effect.gen(function* () {
      const local = yield* client()
      const me = yield* local.Whoami()
      yield* local.SetPassword({ userId: me.id, currentPassword: null, newPassword: "local-password-1" })
      assert.strictEqual(yield* via(local.GetSession()), "local:loopback")
    }).pipe(Effect.scoped, withServer(config))
  })

  it.live("proxy mode: the header names the user", () => {
    const config = testConfig({ authMode: "proxy" })
    return Effect.gen(function* () {
      assert.strictEqual(yield* via((yield* client({ "Remote-User": "alice" })).GetSession()), "alice:proxy")
      assert.strictEqual(yield* via((yield* client()).GetSession()), "Unauthorized")
    }).pipe(Effect.scoped, withServer(config))
  })
})
