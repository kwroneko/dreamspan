// Built-in login (DESIGN §10.1), end to end: a real server, real workers, login and
// logout over HTTP, and RPCs over WebSockets carrying the session cookie.
import { writeFileSync } from "node:fs"
import { request } from "node:http"
import { networkInterfaces } from "node:os"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { AppApi, Authentication } from "@dreamspan/shared/api.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { Effect, Layer, Option, Redacted } from "effect"
import { AppConfig } from "../src/config.ts"
import { Reader } from "../src/db/Database.ts"
import { AddressResolver, type Resolve } from "../src/net/addressSet.ts"
import { TrustedAddresses } from "../src/net/exposure.ts"
import { ServerLive } from "../src/server.ts"
import { testBundles } from "./support/bundles.ts"
import { client, login, outcome, post, serverPort, testConfig, withServer } from "./support/config.ts"

/** A login sent from `from`, so it can come from an address other than loopback. */
const loginFrom = (from: string, handle: string, password: string) =>
  Effect.flatMap(serverPort, (port) =>
    Effect.callback<number>((resume) => {
      const body = JSON.stringify({ handle, password })
      const req = request(
        {
          host: from,
          port,
          path: "/auth/login",
          method: "POST",
          localAddress: from,
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }
        },
        (res) => {
          res.resume()
          resume(Effect.succeed(res.statusCode ?? 0))
        }
      )
      req.on("error", (error) => resume(Effect.die(error)))
      req.end(body)
    })
  )

describe("accounts", () => {
  it("every RPC requires authentication", () => {
    for (const [tag, rpc] of AppApi.requests) {
      assert.isTrue([...rpc.middlewares].includes(Authentication as never), `${tag} skips authentication`)
    }
  })

  it.live("a server not given a lower cost stores passwords hashed at full cost", () => {
    // The other tests' servers hash at a lower cost (support/config.ts); this one doesn't.
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const me = yield* api.Whoami()
      yield* api.SetPassword({ userId: me.id, currentPassword: null, newPassword: "a-password" })
      const stored = yield* (yield* Reader).GetPasswordHash({ userId: me.id })
      assert.match(stored?.passwordHash ?? "", /^scrypt\$32768\$8\$3\$/)
      assert.strictEqual((yield* login("local", "a-password")).status, 204)
    }).pipe(
      Effect.scoped,
      Effect.provide(ServerLive.pipe(Layer.provide([Layer.succeed(AppConfig)(config), testBundles])))
    )
  })

  it.live("from passwordless local use to login, sessions and logout", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      // No account has a password: loopback is the local admin, without logging in.
      const anonymous = yield* client()
      const local = yield* anonymous.Whoami()
      assert.strictEqual(local.handle, "local")
      assert.strictEqual(local.role, "admin")
      assert.strictEqual((yield* login("local", "anything-at-all")).status, 401)

      // Setting the first password makes login required, on loopback too (the default).
      assert.strictEqual(
        yield* outcome(anonymous.SetPassword({ userId: local.id, currentPassword: null, newPassword: "short" })),
        "AccountRejected:weak_password"
      )
      yield* anonymous.SetPassword({ userId: local.id, currentPassword: null, newPassword: "first-password" })
      assert.strictEqual(yield* outcome(anonymous.Whoami()), "Unauthorized")
      assert.strictEqual(yield* outcome((yield* client()).Whoami()), "Unauthorized")

      assert.strictEqual((yield* login("local", "wrong-password")).status, 401)
      assert.strictEqual((yield* login("nobody", "first-password")).status, 401)
      const session = yield* login("LOCAL", "first-password")
      assert.strictEqual(session.status, 204)
      assert.match(session.setCookie, /HttpOnly/i)
      assert.match(session.setCookie, /SameSite=Strict/i)
      const admin = yield* client({ cookie: session.cookie })
      assert.strictEqual((yield* admin.Whoami()).handle, "local")

      // An admin creates accounts; there's no sign-up.
      const bobAccount = yield* admin.CreateUser({
        handle: "Bob",
        displayName: "Bob",
        role: "user",
        password: "bob-password"
      })
      assert.strictEqual(bobAccount.handle, "bob")
      assert.strictEqual(
        yield* outcome(admin.CreateUser({ handle: "bob", displayName: "", role: "user", password: "another-one" })),
        "AccountRejected:handle_taken"
      )
      assert.strictEqual(
        yield* outcome(
          admin.CreateUser({ handle: "no spaces", displayName: "", role: "user", password: "pw-pw-pw-pw" })
        ),
        "AccountRejected:invalid_handle"
      )
      const bobSession = yield* login("bob", "bob-password")
      const bob = yield* client({ cookie: bobSession.cookie })
      assert.strictEqual((yield* bob.Whoami()).handle, "bob")

      // A user manages only their own password, and needs the current one.
      assert.strictEqual(yield* outcome(bob.ListUsers()), "Forbidden")
      assert.strictEqual(
        yield* outcome(bob.CreateUser({ handle: "eve", displayName: "", role: "admin", password: "eve-password" })),
        "Forbidden"
      )
      assert.strictEqual(
        yield* outcome(bob.SetPassword({ userId: local.id, currentPassword: null, newPassword: "taken-over" })),
        "Forbidden"
      )
      assert.strictEqual(yield* outcome(bob.SetUserDisabled({ userId: local.id, disabled: true })), "Forbidden")
      assert.strictEqual(
        yield* outcome(bob.SetPassword({ userId: bobAccount.id, currentPassword: "guess", newPassword: "bob-new-pw" })),
        "AccountRejected:wrong_password"
      )
      yield* bob.SetPassword({ userId: bobAccount.id, currentPassword: "bob-password", newPassword: "bob-new-pw" })
      // Changing a password ends every session of that user, on open connections too.
      assert.strictEqual(yield* outcome(bob.Whoami()), "Unauthorized")
      const bob2 = yield* client({ cookie: (yield* login("bob", "bob-new-pw")).cookie })
      assert.strictEqual((yield* bob2.Whoami()).handle, "bob")

      // Disabling ends sessions and stops logins; the last admin can't be disabled.
      yield* admin.SetUserDisabled({ userId: bobAccount.id, disabled: true })
      assert.strictEqual(yield* outcome(bob2.Whoami()), "Unauthorized")
      assert.strictEqual((yield* login("bob", "bob-new-pw")).status, 401)
      assert.strictEqual(
        yield* outcome(admin.SetUserDisabled({ userId: local.id, disabled: true })),
        "AccountRejected:last_admin"
      )
      assert.strictEqual(
        yield* outcome(admin.SetUserDisabled({ userId: "missing" as UserId, disabled: true })),
        "NotFound"
      )
      const users = yield* admin.ListUsers()
      assert.deepStrictEqual(
        users.map((user) => [user.handle, user.hasPassword, user.disabled]),
        [
          ["local", true, false],
          ["bob", true, true]
        ]
      )

      // Logout ends the session, on the connection that's still open too.
      const logout = yield* post("/auth/logout", {}, { cookie: session.cookie })
      assert.strictEqual(logout.status, 204)
      assert.strictEqual(yield* outcome(admin.Whoami()), "Unauthorized")
    }).pipe(Effect.scoped, withServer(config))
  })

  it.live("an admin without a password of their own can't create accounts", () => {
    // Creating bob first would make login required, and the passwordless admin could never log in.
    const config = testConfig()
    return Effect.gen(function* () {
      const local = yield* client()
      assert.strictEqual(
        yield* outcome(local.CreateUser({ handle: "bob", displayName: "", role: "user", password: "bob-password" })),
        "AccountRejected:own_password_first"
      )
      assert.strictEqual((yield* local.Whoami()).handle, "local")
    }).pipe(Effect.scoped, withServer(config))
  })

  it.live("counts concurrent guesses before checking them, and runs only two checks at once", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const local = yield* (yield* client()).Whoami()
      yield* (yield* client()).SetPassword({
        userId: local.id,
        currentPassword: null,
        newPassword: "first-password"
      })
      const statuses = yield* Effect.all(
        Array.from({ length: 30 }, (_, i) => login("local", `guess-${i}`).pipe(Effect.map((r) => r.status))),
        { concurrency: "unbounded" }
      )
      assert.isAtMost(statuses.filter((status) => status === 401).length, 10)
      assert.isAbove(statuses.filter((status) => status === 429).length, 0)
      // Every attempt counted, refused ones included, so even the right password now waits.
      assert.strictEqual((yield* login("local", "first-password")).status, 429)
    }).pipe(Effect.scoped, withServer(config))
  })

  it.live("refuses oversized and malformed logins before hashing", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      // The server answers before the upload ends, so the client may only see the connection close.
      const port = yield* serverPort
      const huge = yield* Effect.tryPromise(() =>
        fetch(`http://127.0.0.1:${port}/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ handle: "local", password: "x".repeat(100_000) })
        })
      ).pipe(
        Effect.map((response) => String(response.status)),
        Effect.orElseSucceed(() => "closed")
      )
      assert.oneOf(huge, ["400", "closed"])
      assert.strictEqual((yield* login("not a handle", "whatever-pw")).status, 401)
    }).pipe(Effect.scoped, withServer(config))
  })

  it.live("ADMIN_PASSWORD is ignored in proxy mode, so the first proxy user stays the admin", () => {
    const config = testConfig({ authMode: "proxy", adminPassword: Option.some(Redacted.make("from-the-env")) })
    return Effect.gen(function* () {
      const owner = yield* (yield* client({ "Remote-User": "owner" })).Whoami()
      assert.strictEqual(owner.role, "admin")
    }).pipe(Effect.scoped, withServer(config))
  })

  it.live("refuses cross-site and non-JSON logins, and throttles guessing", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const local = yield* (yield* client()).Whoami()
      yield* (yield* client()).SetPassword({
        userId: local.id,
        currentPassword: null,
        newPassword: "first-password"
      })
      const crossSite = yield* post(
        "/auth/login",
        { handle: "local", password: "first-password" },
        { origin: "https://evil.example" }
      )
      assert.strictEqual(crossSite.status, 403)
      const form = yield* post("/auth/login", {}, { "content-type": "text/plain" })
      assert.strictEqual(form.status, 415)

      for (let i = 0; i < 10; i++) assert.strictEqual((yield* login("local", `guess-${i}`)).status, 401)
      // Even the right password waits once the address is throttled.
      const throttled = yield* post("/auth/login", { handle: "local", password: "first-password" })
      assert.strictEqual(throttled.status, 429)
      assert.isAbove(Number(throttled.headers.get("retry-after")), 0)
    }).pipe(Effect.scoped, withServer(config))
  })

  it.live("LOOPBACK_REQUIRES_LOGIN=false: loopback is the first admin once accounts exist", () => {
    const config = testConfig({ loopbackRequiresLogin: false })
    return Effect.gen(function* () {
      const local = yield* (yield* client()).Whoami()
      yield* (yield* client()).SetPassword({
        userId: local.id,
        currentPassword: null,
        newPassword: "first-password"
      })
      assert.strictEqual((yield* (yield* client()).Whoami()).handle, "local")
    }).pipe(Effect.scoped, withServer(config))
  })

  it.live("an admin password from the environment protects a headless server from its first start", () => {
    const config = testConfig({ host: "0.0.0.0", adminPassword: Option.some(Redacted.make("from-the-env")) })
    return Effect.gen(function* () {
      // It starts beyond loopback without an allowlist, and nobody is logged in for free.
      assert.strictEqual(yield* outcome((yield* client()).Whoami()), "Unauthorized")
      const session = yield* login("admin", "from-the-env")
      assert.strictEqual(session.status, 204)
      const admin = yield* client({ cookie: session.cookie })
      const me = yield* admin.Whoami()
      assert.strictEqual(me.role, "admin")
      yield* admin.SetPassword({ userId: me.id, currentPassword: "from-the-env", newPassword: "changed-in-app" })
    }).pipe(
      Effect.scoped,
      withServer(config),
      // A restart with the same environment doesn't undo the change.
      Effect.andThen(
        Effect.gen(function* () {
          assert.strictEqual((yield* login("admin", "from-the-env")).status, 401)
          assert.strictEqual((yield* login("admin", "changed-in-app")).status, 204)
        }).pipe(withServer(config))
      )
    )
  })

  it.live("ADMIN_PASSWORD_FILE gives the existing local admin a password, keeping its data", () => {
    const config = testConfig()
    const file = join(config.dataDir, "admin-password")
    writeFileSync(file, "from-a-secret\n")
    return Effect.gen(function* () {
      const local = yield* (yield* client()).Whoami()
      return local.id
    }).pipe(
      Effect.scoped,
      withServer(config),
      Effect.flatMap((localId) =>
        Effect.gen(function* () {
          const session = yield* login("local", "from-a-secret")
          assert.strictEqual(session.status, 204)
          assert.strictEqual((yield* (yield* client({ cookie: session.cookie })).Whoami()).id, localId)
        }).pipe(Effect.scoped, withServer({ ...config, adminPasswordFile: Option.some(file) }))
      )
    )
  })

  it.live("proxy mode: no login, no passwords, and a doubled identity header is refused", () => {
    const config = testConfig({ authMode: "proxy" })
    return Effect.gen(function* () {
      assert.strictEqual((yield* login("alice", "whatever-pw")).status, 404)
      const alice = yield* client({ "Remote-User": "alice" })
      const me = yield* alice.Whoami()
      assert.strictEqual(
        yield* outcome(alice.SetPassword({ userId: me.id, currentPassword: null, newPassword: "a-password" })),
        "AccountRejected:proxy_mode"
      )
      // Node joins a repeated header with ", ".
      assert.strictEqual(yield* outcome((yield* client({ "Remote-User": "mallory, alice" })).Whoami()), "Unauthorized")
      const bob = yield* client({ "Remote-User": "bob" })
      const bobUser = yield* bob.Whoami()
      yield* alice.SetUserDisabled({ userId: bobUser.id, disabled: true })
      assert.strictEqual(yield* outcome(bob.Whoami()), "Unauthorized")
    }).pipe(Effect.scoped, withServer(config))
  })
})

// A second address of this machine, so a connection can come from somewhere other than loopback.
const lanIp = Object.values(networkInterfaces())
  .flat()
  .find((address) => address && address.family === "IPv4" && !address.internal)?.address

describe.skipIf(lanIp === undefined)("accounts beyond loopback", () => {
  it.live("guessing someone's password from one address doesn't lock them out elsewhere", () => {
    const config = testConfig({ host: "0.0.0.0", allowedIps: [lanIp!] })
    return Effect.gen(function* () {
      const local = yield* (yield* client()).Whoami()
      yield* (yield* client()).SetPassword({
        userId: local.id,
        currentPassword: null,
        newPassword: "first-password"
      })
      for (let i = 0; i < 10; i++) assert.strictEqual(yield* loginFrom(lanIp!, "local", `guess-${i}`), 401)
      assert.strictEqual(yield* loginFrom(lanIp!, "local", "first-password"), 429)
      assert.strictEqual(yield* loginFrom("127.0.0.1", "local", "first-password"), 204)
    }).pipe(Effect.scoped, withServer(config))
  })

  it.live("a socket opened while login was required doesn't become the local admin when the last password goes", () => {
    const config = testConfig({ host: "0.0.0.0" })
    const withAlice = {
      ...config,
      adminUser: Option.some("alice"),
      adminPassword: Option.some(Redacted.make("alice-password"))
    }
    return Effect.gen(function* () {
      // First run: local use, which creates the passwordless local admin.
      yield* (yield* client()).Whoami()
    }).pipe(
      Effect.scoped,
      withServer({ ...config, host: "127.0.0.1" }),
      Effect.andThen(
        Effect.gen(function* () {
          // Second run, headless: alice gets a password, so the LAN may connect, and must log in.
          const lan = yield* client({}, lanIp)
          assert.strictEqual(yield* outcome(lan.Whoami()), "Unauthorized")
          const alice = yield* client({
            cookie: (yield* login("alice", "alice-password")).cookie
          })
          const me = yield* alice.Whoami()
          // local is another enabled admin, so alice may disable herself: no password is left.
          yield* alice.SetUserDisabled({ userId: me.id, disabled: true })
          assert.strictEqual(yield* outcome(lan.Whoami()), "Unauthorized")
          assert.strictEqual((yield* (yield* client()).Whoami()).handle, "local")
        }).pipe(Effect.scoped, withServer(withAlice))
      )
    )
  })

  it.live(
    "an ALLOWED_IPS name grants passwordless use while it resolves to the peer, and only then",
    () => {
      const config = testConfig({ host: "0.0.0.0", allowedIps: ["lanbox"] })
      let lanbox: ReadonlyArray<string> = [lanIp!]
      const resolve: Resolve = async (name) => (name === "lanbox" ? lanbox : [])
      const status = Effect.flatMap(serverPort, (port) =>
        Effect.promise(() => fetch(`http://${lanIp}:${port}/healthz`).then((response) => response.status))
      )
      return Effect.gen(function* () {
        const lan = yield* client({}, lanIp)
        assert.strictEqual((yield* lan.Whoami()).handle, "local")
        assert.strictEqual(yield* status, 200)
        // The name stops resolving: the next resolution takes the address out. A refused
        // connection asks for one 5 s after the last, rather than the background's 30 s.
        lanbox = []
        ;(yield* TrustedAddresses).allowedIps.refreshSoon()
        assert.strictEqual((yield* lan.Whoami()).handle, "local")
        yield* Effect.sleep("5500 millis")
        // The socket opened while it was allowed stays open, but isn't the local admin any more.
        assert.strictEqual(yield* outcome(lan.Whoami()), "Unauthorized")
        assert.strictEqual(yield* status, 403)
        assert.strictEqual((yield* (yield* client()).Whoami()).handle, "local")
      }).pipe(Effect.scoped, withServer(config), Effect.provideService(AddressResolver, resolve))
    },
    60_000
  )

  it.live("a peer can't claim to be loopback by sending the peer header itself", () => {
    const config = testConfig({ host: "0.0.0.0", allowedIps: [lanIp!], loopbackRequiresLogin: false })
    return Effect.gen(function* () {
      const local = yield* (yield* client()).Whoami()
      yield* (yield* client()).SetPassword({
        userId: local.id,
        currentPassword: null,
        newPassword: "first-password"
      })
      const port = yield* serverPort
      const status = yield* Effect.promise(
        () =>
          new Promise<string>((resolve) => {
            const ws = new WebSocket(`ws://${lanIp}:${port}/rpc`, {
              headers: { "x-rp-peer": "127.0.0.1" }
            } as unknown as Array<string>)
            ws.onopen = () =>
              ws.send(JSON.stringify({ _tag: "Request", id: "1", tag: "Whoami", payload: null, headers: [] }))
            ws.onmessage = (event) => {
              ws.close()
              const exit = JSON.parse(String(event.data)).exit
              resolve(exit._tag === "Success" ? exit.value.handle : exit.cause[0].error._tag)
            }
          })
      )
      assert.strictEqual(status, "Unauthorized")
    }).pipe(Effect.scoped, withServer(config))
  })
})
