// verifyPassword reads its parameters from the stored hash. Anything its sanity check
// accepts must also derive: Node throws on parameters it refuses, which would turn a
// login into a 500.
import { randomBytes } from "node:crypto"
import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Exit } from "effect"
import { hashPassword, verifyPassword } from "../src/auth/passwords.ts"

const stored = (n: number | string, r: number | string, p: number | string) =>
  `scrypt$${n}$${r}$${p}$${randomBytes(16).toString("base64url")}$${randomBytes(32).toString("base64url")}`

describe("verifyPassword", () => {
  it.live("matches only the password a hash was made from", () =>
    Effect.gen(function* () {
      const hash = yield* hashPassword("a-password", { n: 2 ** 10, r: 8, p: 1 })
      assert.isTrue(yield* verifyPassword("a-password", hash))
      assert.isFalse(yield* verifyPassword("another-one", hash))
    })
  )

  it.live("refuses parameters Node would throw on, instead of failing the check", () =>
    Effect.gen(function* () {
      // Node needs 128·r·(N + p + 2) bytes; each of these is just over the 64 MiB limit.
      for (const [n, r, p] of [
        [2 ** 16, 8, 1],
        [2 ** 19, 1, 1],
        [2 ** 18, 2, 16]
      ] as const) {
        assert.isFalse(yield* verifyPassword("a-password", stored(n, r, p)), `N=${n} r=${r} p=${p}`)
      }
      assert.isFalse(yield* verifyPassword("a-password", stored(2 ** 10, 1.5, 1)))
      assert.isFalse(yield* verifyPassword("a-password", stored(2 ** 10, 1, 1.5)))
    })
  )

  it.live("refuses N of 2^(16·r) or more, which Node also throws on", () =>
    Effect.gen(function* () {
      assert.isFalse(yield* verifyPassword("a-password", stored(2 ** 16, 1, 1)))
      assert.isFalse(yield* verifyPassword("a-password", stored(2 ** 15, 1, 1)))
    })
  )

  it.live("still dies on a throw that isn't about the parameters", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(verifyPassword(undefined as unknown as string, stored(2 ** 10, 8, 1)))
      assert.isTrue(Exit.isFailure(exit) && Cause.hasDies(exit.cause), String(exit))
    })
  )
})
