// Password hashing with scrypt (node:crypto). It runs on libuv's thread pool, so the event
// loop stays free; the parameters are OWASP's recommendation (N=2^15, r=8, p=3).
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto"
import { Effect } from "effect"

const N = 2 ** 15
const R = 8
const P = 3
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

const derive = (password: string, salt: Buffer, n: number, r: number, p: number) =>
  Effect.callback<Buffer>((resume) => {
    scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, { N: n, r, p, maxmem: MAX_MEM }, (error, key) =>
      resume(error ? Effect.die(error) : Effect.succeed(key))
    )
  })

/** `scrypt$N$r$p$salt$hash`, base64url, so the parameters can change without a migration. */
export const hashPassword = (password: string) =>
  Effect.gen(function* () {
    const salt = randomBytes(16)
    const key = yield* derive(password, salt, N, R, P)
    return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${key.toString("base64url")}`
  })

/** Whether `password` matches `encoded`. A malformed hash, parameters included, matches nothing. */
export const verifyPassword = (password: string, encoded: string) =>
  Effect.gen(function* () {
    const [scheme, n, r, p, salt, hash] = encoded.split("$")
    const [cost, blockSize, parallelism] = [Number(n), Number(r), Number(p)]
    const sane =
      Number.isInteger(Math.log2(cost)) &&
      cost > 1 &&
      blockSize >= 1 &&
      parallelism >= 1 &&
      parallelism <= 16 &&
      // Node throws, rather than failing, past its memory limit.
      128 * cost * blockSize <= MAX_MEM
    if (scheme !== "scrypt" || hash === undefined || salt === undefined || !sane) return false
    const expected = Buffer.from(hash, "base64url")
    const key = yield* derive(password, Buffer.from(salt, "base64url"), cost, blockSize, parallelism)
    return key.length === expected.length && timingSafeEqual(key, expected)
  })

/** Spends the same time as a real check, so a missing user can't be told from a wrong password. */
export const DUMMY_HASH = `scrypt$${N}$${R}$${P}$${randomBytes(16).toString("base64url")}$${randomBytes(KEY_LENGTH).toString("base64url")}`
