// Password hashing with scrypt (node:crypto). It runs on libuv's thread pool, so the event
// loop stays free; the parameters are OWASP's recommendation (N=2^15, r=8, p=3).
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto"
import { Context, Effect } from "effect"

/** scrypt's cost parameters. */
interface PasswordCostShape {
  readonly n: number
  readonly r: number
  readonly p: number
}

/**
 * The cost new hashes are made with. Nothing outside the code sets it. Tests lower it: their
 * hashes protect nothing, and at full cost the dozen in one test took over 30 s at a load
 * average of 75.
 */
export const PasswordCost = Context.Reference<PasswordCostShape>("rp/PasswordCost", {
  defaultValue: () => ({ n: 2 ** 15, r: 8, p: 3 })
})

const KEY_LENGTH = 32
// scrypt needs 128 * N * r bytes, 32 MiB here, which is exactly Node's default limit.
const MAX_MEM = 64 * 1024 * 1024

const MIN_PASSWORD_LENGTH = 8
export const MAX_PASSWORD_LENGTH = 1024

/** Why a new password isn't acceptable, or undefined. Length only (NIST SP 800-63B). */
export const passwordProblem = (password: string) =>
  password.length < MIN_PASSWORD_LENGTH
    ? `a password needs at least ${MIN_PASSWORD_LENGTH} characters`
    : password.length > MAX_PASSWORD_LENGTH
      ? `a password can have at most ${MAX_PASSWORD_LENGTH} characters`
      : undefined

/**
 * Undefined when Node refuses the parameters, which it does by throwing: past `maxmem`
 * (it needs 128·r·(N + p + 2) bytes), with N ≥ 2^(16·r), or with a non-integer.
 */
const derive = (password: string, salt: Buffer, n: number, r: number, p: number) =>
  Effect.callback<Buffer | undefined>((resume) => {
    try {
      scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, { N: n, r, p, maxmem: MAX_MEM }, (error, key) =>
        resume(error ? Effect.die(error) : Effect.succeed(key))
      )
    } catch {
      resume(Effect.succeed(undefined))
    }
  })

/** `scrypt$N$r$p$salt$hash`, base64url, so the parameters can change without a migration. */
export const hashPassword = (password: string, { n, r, p }: PasswordCostShape) =>
  Effect.gen(function* () {
    const salt = randomBytes(16)
    const key = yield* derive(password, salt, n, r, p)
    if (key === undefined) return yield* Effect.die(new Error(`scrypt refuses N=${n} r=${r} p=${p}`))
    return `scrypt$${n}$${r}$${p}$${salt.toString("base64url")}$${key.toString("base64url")}`
  })

/** Whether `password` matches `encoded`. A malformed hash, parameters included, matches nothing. */
export const verifyPassword = (password: string, encoded: string) =>
  Effect.gen(function* () {
    const [scheme, n, r, p, salt, hash] = encoded.split("$")
    const [cost, blockSize, parallelism] = [Number(n), Number(r), Number(p)]
    const sane =
      Number.isInteger(Math.log2(cost)) && cost > 1 && blockSize >= 1 && parallelism >= 1 && parallelism <= 16
    if (scheme !== "scrypt" || hash === undefined || salt === undefined || !sane) return false
    const expected = Buffer.from(hash, "base64url")
    const key = yield* derive(password, Buffer.from(salt, "base64url"), cost, blockSize, parallelism)
    return key !== undefined && key.length === expected.length && timingSafeEqual(key, expected)
  })

/** Checking it spends as long as a real check, so a missing user can't be told from a wrong password. */
export const dummyHash = ({ n, r, p }: PasswordCostShape) =>
  `scrypt$${n}$${r}$${p}$${randomBytes(16).toString("base64url")}$${randomBytes(KEY_LENGTH).toString("base64url")}`
