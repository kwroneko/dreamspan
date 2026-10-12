import { statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Option, Redacted } from "effect"
import { loadServerSecret, makeSecrets } from "../src/secrets.ts"
import { tempDir } from "./support/tempDir.ts"

const fresh = () => tempDir("secret")
const none = { secretKey: Option.none(), secretKeyFile: Option.none() }

describe("server secret", () => {
  it.effect("is generated once, private to the server's user", () =>
    Effect.gen(function* () {
      const dataDir = fresh()
      const first = yield* loadServerSecret({ dataDir, ...none })
      const second = yield* loadServerSecret({ dataDir, ...none })
      assert.strictEqual(first, second)
      assert.strictEqual(statSync(join(dataDir, "secret.key")).mode & 0o777, 0o600)
    })
  )

  it.effect("comes from SECRET_KEY or SECRET_KEY_FILE when set, and must not be trivially short", () =>
    Effect.gen(function* () {
      const dataDir = fresh()
      const fromEnv = yield* loadServerSecret({
        dataDir,
        secretKey: Option.some(Redacted.make("a configured secret value")),
        secretKeyFile: Option.none()
      })
      assert.strictEqual(fromEnv, "a configured secret value")
      const file = join(dataDir, "docker-secret")
      writeFileSync(file, "from a docker secret file\n")
      const fromFile = yield* loadServerSecret({ dataDir, secretKey: Option.none(), secretKeyFile: Option.some(file) })
      assert.strictEqual(fromFile, "from a docker secret file")
      const short = yield* loadServerSecret({
        dataDir,
        secretKey: Option.some(Redacted.make("short")),
        secretKeyFile: Option.none()
      }).pipe(Effect.exit)
      assert.isTrue(Exit.isFailure(short))
    })
  )
})

describe("secret encryption", () => {
  const secrets = makeSecrets("a server secret for tests")

  it.effect("round-trips, with a fresh nonce every time", () =>
    Effect.gen(function* () {
      const a = secrets.encrypt("sk-test-123", "connection:c1:api_key")
      const b = secrets.encrypt("sk-test-123", "connection:c1:api_key")
      assert.isFalse(Buffer.from(a).equals(Buffer.from(b)))
      assert.strictEqual(yield* secrets.decrypt(a, "connection:c1:api_key"), "sk-test-123")
      assert.isFalse(Buffer.from(a).toString("latin1").includes("sk-test-123"))
    })
  )

  it.effect("only decrypts under the same binding and the same server secret", () =>
    Effect.gen(function* () {
      const blob = secrets.encrypt("sk-test-123", "connection:c1:api_key")
      for (const attempt of [
        secrets.decrypt(blob, "connection:c2:api_key"),
        secrets.decrypt(blob, "connection:c1:proxy_url"),
        makeSecrets("another server secret").decrypt(blob, "connection:c1:api_key")
      ]) {
        const exit = yield* Effect.exit(attempt)
        assert.isTrue(Exit.isFailure(exit))
      }
      const tampered = new Uint8Array(blob)
      tampered[tampered.length - 1]! ^= 1
      assert.isTrue(Exit.isFailure(yield* Effect.exit(secrets.decrypt(tampered, "connection:c1:api_key"))))
    })
  )
})
