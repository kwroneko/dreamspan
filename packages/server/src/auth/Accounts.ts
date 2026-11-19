// Who a request is, built-in login, and account management (DESIGN §10.1).
// - Proxy mode: whoever the reverse proxy names; passwords don't apply.
// - Otherwise, until an enabled user has a password, loopback and ALLOWED_IPS are the
//   implicit local admin. After that, a session is required, except on loopback when
//   LOOPBACK_REQUIRES_LOGIN is off, which acts as the oldest enabled admin.
import { createHash, randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { Authentication, CurrentUser, type Session, Unauthorized } from "@dreamspan/shared/api.ts"
import type { User, UserAccount, UserId, UserRole } from "@dreamspan/shared/domain.ts"
import { AccountRejected, Forbidden, NotFound, ServerError } from "@dreamspan/shared/errors.ts"
import { Context, Data, Effect, Layer, Option, Predicate, Redacted, Semaphore } from "effect"
import { Cookies } from "effect/http"
import type { RpcClientError } from "effect/rpc"
import { AppConfig } from "../config.ts"
import { Reader, Writer } from "../db/Database.ts"
import type { StorageError } from "../db/ops.ts"
import { isLoopback, TrustedAddresses } from "../net/exposure.ts"
import {
  dummyHash,
  hashPassword,
  MAX_PASSWORD_LENGTH,
  PasswordCost,
  passwordProblem,
  verifyPassword
} from "./passwords.ts"

export const SESSION_COOKIE = "rp_session"
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** Set by the server from the socket's address (server.ts); any copy a client sends is replaced. */
export const PEER_HEADER = "x-rp-peer"

const LOCAL_HANDLE = "local"
const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,62}$/
const THROTTLE_WINDOW_MS = 15 * 60 * 1000

/** Too many login attempts, or too many password checks running at once. */
export class LoginThrottled extends Data.TaggedError("LoginThrottled")<{ readonly retryAfterMs: number }> {}

/** The environment's admin password can't be used. */
class BootstrapFailed extends Data.TaggedError("BootstrapFailed")<{ readonly message: string }> {}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex")

/**
 * Attempts per key: at most `limit` in the window. Kept in memory, which is enough for one
 * process; a restart forgives. Past MAX_KEYS, stale keys go, then the oldest, so many
 * addresses can't grow it without bound.
 */
const MAX_KEYS = 10_000
const makeThrottle = (limit: number) => {
  const attempts = new Map<string, Array<number>>()
  const recent = (key: string, now: number) => (attempts.get(key) ?? []).filter((at) => at > now - THROTTLE_WINDOW_MS)
  return {
    retryAfter: (key: string, now: number) => {
      const times = recent(key, now)
      return times.length < limit ? 0 : times[0]! + THROTTLE_WINDOW_MS - now
    },
    record: (key: string, now: number) => {
      if (attempts.size >= MAX_KEYS) {
        for (const [stale, times] of attempts) {
          if (times.every((at) => at <= now - THROTTLE_WINDOW_MS)) attempts.delete(stale)
        }
        // Down to 90%, so the scan isn't repeated on every attempt.
        for (const oldest of attempts.keys()) {
          if (attempts.size < MAX_KEYS * 0.9) break
          attempts.delete(oldest)
        }
      }
      attempts.set(key, [...recent(key, now), now])
    },
    forgive: (key: string) => attempts.delete(key)
  }
}

type StorageFailure = StorageError | RpcClientError.RpcClientError
const isStorageFailure = (error: unknown): error is StorageFailure =>
  Predicate.isTagged(error, "StorageError") || Predicate.isTagged(error, "RpcClientError")

/** Storage failures are logged, and reach the caller as `toError(operation)` without internals. */
const storage =
  <F>(operation: string, toError: (message: string) => F) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, Exclude<E, StorageFailure> | F, R> =>
    Effect.catch(effect, (error): Effect.Effect<never, Exclude<E, StorageFailure> | F> =>
      isStorageFailure(error)
        ? Effect.logError(`${operation} failed`, error).pipe(
            Effect.andThen(Effect.fail(toError(`${operation} failed`)))
          )
        : Effect.fail(error as Exclude<E, StorageFailure>)
    )

const rejected = (reason: AccountRejected["reason"], message: string) => new AccountRejected({ reason, message })
const unauthorized = (message: string) => new Unauthorized({ message })
const serverError = (message: string) => new ServerError({ message })

export interface NewUser {
  readonly handle: string
  readonly displayName: string
  readonly role: UserRole
  readonly password: string
}

export interface PasswordChange {
  readonly userId: UserId
  readonly currentPassword: string | null
  readonly newPassword: string
}

export class Accounts extends Context.Service<
  Accounts,
  {
    /** Whether an enabled user has a password, which makes login required. */
    readonly configured: () => boolean
    readonly resolve: (
      headers: Readonly<Record<string, string | undefined>>
    ) => Effect.Effect<Pick<Session, "user" | "via">, Unauthorized>
    /** A new session's token. */
    readonly login: (
      handle: string,
      password: string,
      peer: string
    ) => Effect.Effect<string, AccountRejected | LoginThrottled | ServerError>
    readonly logout: (token: string) => Effect.Effect<void, ServerError>
    readonly listUsers: () => Effect.Effect<ReadonlyArray<UserAccount>, ServerError>
    /** Only an admin with a password of their own creates accounts, so nobody is locked out. */
    readonly createUser: (actor: User, input: NewUser) => Effect.Effect<UserAccount, AccountRejected | ServerError>
    /** Your own password needs the current one, if you have one; an admin can set anyone's. */
    readonly setPassword: (
      actor: User,
      input: PasswordChange
    ) => Effect.Effect<void, AccountRejected | Forbidden | LoginThrottled | NotFound | ServerError>
    readonly setDisabled: (
      userId: UserId,
      disabled: boolean
    ) => Effect.Effect<UserAccount, AccountRejected | NotFound | ServerError>
  }
>()("rp/Accounts") {
  static readonly layer = Layer.effect(
    Accounts,
    Effect.gen(function* () {
      const config = yield* AppConfig
      const writer = yield* Writer
      const reader = yield* Reader
      const proxyMode = config.authMode === "proxy"
      const cost = yield* PasswordCost
      const dummy = dummyHash(cost)

      yield* bootstrapAdmin
      let configured = yield* reader.AccountsConfigured()

      // Passwordless use is checked per call, not just when a connection opens: a socket
      // opened while everyone had to log in mustn't become the local admin if the last
      // password goes.
      const { allowedIps } = yield* TrustedAddresses
      const passwordlessPeer = (peer: string | undefined) =>
        config.allowInsecureExposure || (peer !== undefined && (isLoopback(peer) || allowedIps.has(peer)))

      // Users are cached per process; sessions aren't, so a revoked one stops at once.
      // A lookup that started before a change doesn't write its stale answer back.
      let generation = 0
      const users = new Map<string, User>()
      let admin: User | null = null
      const changed = Effect.gen(function* () {
        const current = ++generation
        users.clear()
        admin = null
        const value = yield* reader.AccountsConfigured()
        if (current === generation) configured = value
      })

      const userByHandle = (handle: string) => {
        const cached = users.get(handle)
        if (cached) return Effect.succeed(cached)
        const started = generation
        return writer.EnsureUser({ handle, displayName: handle }).pipe(
          Effect.tap((user) => Effect.sync(() => started === generation && users.set(handle, user))),
          Effect.catchTag("UserDisabled", () => Effect.fail(unauthorized(`${handle} is disabled`)))
        )
      }

      const firstAdmin = Effect.suspend(() => {
        if (admin) return Effect.succeed(admin)
        const started = generation
        return reader.FirstAdmin().pipe(
          Effect.tap((user) =>
            Effect.sync(() => {
              if (started === generation) admin = user
            })
          )
        )
      })

      const resolve = (headers: Readonly<Record<string, string | undefined>>) =>
        Effect.gen(function* () {
          if (proxyMode) {
            const handle = headers[config.authProxyHeader.toLowerCase()]
            if (!handle) return yield* unauthorized(`missing ${config.authProxyHeader} header`)
            // Node joins a repeated header with ", ": a proxy that added its header next to
            // the client's would otherwise produce a name made of both.
            if (/[,\p{Cc}]/u.test(handle)) return yield* unauthorized(`a malformed ${config.authProxyHeader} header`)
            return { user: yield* userByHandle(handle), via: "proxy" as const }
          }
          const token = headers.cookie ? Cookies.parseHeader(headers.cookie)[SESSION_COOKIE] : undefined
          if (token) {
            const user = yield* reader.GetSessionUser({ tokenHash: hashToken(token), now: Date.now() })
            if (user) return { user, via: "session" as const }
          }
          const peer = headers[PEER_HEADER]
          if (!configured) {
            if (passwordlessPeer(peer)) return { user: yield* userByHandle(LOCAL_HANDLE), via: "local" as const }
          } else if (!config.loopbackRequiresLogin && peer !== undefined && isLoopback(peer)) {
            const first = yield* firstAdmin
            if (first) return { user: first, via: "loopback" as const }
          }
          return yield* unauthorized("login required")
        }).pipe(storage("loading the user", unauthorized))

      // Every attempt counts before its password is checked, so a burst can't outrun the
      // count. Per address and handle, so nobody can lock someone else out by name, and
      // per address, more loosely. At most two checks run at once: scrypt takes ~0.25s on
      // libuv's pool, which DNS and file reads share. More are refused, not queued.
      const perPair = makeThrottle(10)
      const perAddress = makeThrottle(50)
      const checks = Semaphore.makeUnsafe(2)
      const checkPassword = (password: string, hash: string) =>
        // Uninterruptible: scrypt can't be cancelled, so a client that disconnects mustn't
        // free the permit while its hash still runs.
        verifyPassword(password, hash).pipe(
          Effect.uninterruptible,
          checks.withPermitsIfAvailable(1),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new LoginThrottled({ retryAfterMs: 1000 })),
              onSome: (matches) => Effect.succeed(matches)
            })
          )
        )

      const login = (handle: string, password: string, peer: string) =>
        Effect.gen(function* () {
          if (proxyMode) return yield* rejected("proxy_mode", "accounts are managed by the reverse proxy")
          const name = handle.trim().toLowerCase()
          const now = Date.now()
          const wait = perAddress.retryAfter(peer, now)
          if (wait > 0) return yield* new LoginThrottled({ retryAfterMs: wait })
          perAddress.record(peer, now)
          // Malformed input fails like a wrong password, before it costs a hash or a key.
          if (!HANDLE_PATTERN.test(name) || password.length > MAX_PASSWORD_LENGTH) {
            return yield* rejected("wrong_password", "wrong handle or password")
          }
          const pairKey = `${peer}\n${name}`
          const pairWait = perPair.retryAfter(pairKey, now)
          if (pairWait > 0) return yield* new LoginThrottled({ retryAfterMs: pairWait })
          perPair.record(pairKey, now)
          const found = yield* reader.GetPasswordHash({ handle: name })
          const matches = yield* checkPassword(password, found?.passwordHash ?? dummy)
          if (!found?.passwordHash || !matches) return yield* rejected("wrong_password", "wrong handle or password")
          perPair.forgive(pairKey)
          const token = randomBytes(32).toString("base64url")
          yield* writer.CreateSession({
            tokenHash: hashToken(token),
            userId: found.user.id,
            expiresAt: Date.now() + SESSION_TTL_MS
          })
          return token
        }).pipe(storage("login", serverError))

      const createUser = (actor: User, input: NewUser) =>
        Effect.gen(function* () {
          if (proxyMode) return yield* rejected("proxy_mode", "accounts are managed by the reverse proxy")
          const own = yield* reader.GetPasswordHash({ userId: actor.id })
          if (!own?.passwordHash) {
            return yield* rejected("own_password_first", "set your own password before creating accounts")
          }
          const handle = input.handle.trim().toLowerCase()
          if (!HANDLE_PATTERN.test(handle)) {
            return yield* rejected("invalid_handle", "a handle is 1–63 letters, digits, '.', '_' or '-'")
          }
          const problem = passwordProblem(input.password)
          if (problem) return yield* rejected("weak_password", problem)
          const account = yield* writer.CreateUser({
            handle,
            displayName: input.displayName.trim() || handle,
            role: input.role,
            passwordHash: yield* hashPassword(input.password, cost)
          })
          yield* changed
          return account
        }).pipe(storage("creating the user", serverError))

      const setPassword = (actor: User, input: PasswordChange) =>
        Effect.gen(function* () {
          if (proxyMode) return yield* rejected("proxy_mode", "passwords are managed by the reverse proxy")
          const own = input.userId === actor.id
          if (!own && actor.role !== "admin") {
            return yield* new Forbidden({ message: "only an admin can set another user's password" })
          }
          const problem = passwordProblem(input.newPassword)
          if (problem) return yield* rejected("weak_password", problem)
          if (own) {
            const current = yield* reader.GetPasswordHash({ userId: actor.id })
            if (current?.passwordHash) {
              // A stolen session mustn't be a way to guess the password at full speed.
              const key = `change\n${actor.id}`
              const wait = perPair.retryAfter(key, Date.now())
              if (wait > 0) return yield* new LoginThrottled({ retryAfterMs: wait })
              perPair.record(key, Date.now())
              if (!(yield* checkPassword(input.currentPassword ?? "", current.passwordHash))) {
                return yield* rejected("wrong_password", "the current password doesn't match")
              }
              perPair.forgive(key)
            }
          }
          yield* writer.SetPasswordHash({
            userId: input.userId,
            passwordHash: yield* hashPassword(input.newPassword, cost)
          })
          yield* changed
        }).pipe(storage("setting the password", serverError))

      return Accounts.of({
        configured: () => configured,
        resolve,
        login,
        logout: (token) => writer.DeleteSession({ tokenHash: hashToken(token) }).pipe(storage("logout", serverError)),
        listUsers: () => reader.ListUsers().pipe(storage("listing users", serverError)),
        createUser,
        setPassword,
        setDisabled: (userId, disabled) =>
          writer.SetUserDisabled({ userId, disabled }).pipe(
            Effect.tap(() => changed),
            storage("changing the user", serverError)
          )
      })
    })
  )
}

/**
 * The `Authentication` RPC middleware: the user for every call. Over the WebSocket, the
 * headers are those of the upgrade request, but the session is still checked on each
 * call, so a logout reaches connections that are already open.
 */
export const AuthenticationLive = Layer.effect(
  Authentication,
  Effect.map(Accounts, (accounts) =>
    Authentication.of((effect, { headers }) =>
      accounts.resolve(headers).pipe(Effect.flatMap(({ user }) => Effect.provideService(effect, CurrentUser, user)))
    )
  )
)

/**
 * The first admin's password from the environment (DESIGN §10.1), for servers where no
 * browser can reach loopback. Applies while no enabled admin has a password, so it also
 * recovers an instance whose admins can't log in.
 */
const bootstrapAdmin = Effect.gen(function* () {
  const config = yield* AppConfig
  const writer = yield* Writer
  const file = Option.getOrUndefined(config.adminPasswordFile)
  const password =
    file !== undefined
      ? yield* Effect.try({
          try: () => readFileSync(file, "utf8").replace(/\r?\n$/, ""),
          catch: (error) => new BootstrapFailed({ message: `can't read ADMIN_PASSWORD_FILE: ${String(error)}` })
        })
      : Option.getOrUndefined(Option.map(config.adminPassword, Redacted.value))
  if (password === undefined) return
  if (config.authMode === "proxy") {
    return yield* Effect.logWarning("The admin password in the environment is ignored in proxy mode")
  }
  const problem = passwordProblem(password)
  if (problem) return yield* new BootstrapFailed({ message: `the admin password from the environment: ${problem}` })
  const handle = Option.getOrNull(Option.map(config.adminUser, (name) => name.trim().toLowerCase()))
  if (handle !== null && !HANDLE_PATTERN.test(handle)) {
    return yield* new BootstrapFailed({ message: `ADMIN_USER isn't a valid handle: ${handle}` })
  }
  const user = yield* writer.BootstrapAdmin({
    handle,
    passwordHash: yield* hashPassword(password, yield* PasswordCost)
  })
  yield* user
    ? Effect.logInfo(`Set the password of ${user.handle} from the environment`)
    : Effect.logInfo("The admin password in the environment is ignored: an admin already has a password")
})
