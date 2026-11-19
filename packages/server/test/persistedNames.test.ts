// Names that persisted data and exported files carry. Each is pinned to its exact value: a
// change here is not a rename, it makes existing data unreadable or orphaned (the comment on
// each says what). Change one only with the owner's go-ahead and a migration or a fresh start.
import { createCipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { CARD_SKILLS_NAMESPACE } from "@dreamspan/shared/cardSkills.ts"
import { Effect } from "effect"
import { SESSION_COOKIE } from "../src/auth/Accounts.ts"
import { databaseFile } from "../src/db/connection.ts"
import { OUR_EXTENSION } from "../src/formats/lorebook.ts"
import { makeSecrets } from "../src/secrets.ts"

const SECRET = "a synthetic server secret"
/** The key-derivation label. Changing it makes every stored connection key and every signed token unreadable. */
const LABEL = "dreamspan"
const derive = (info: string) => Buffer.from(hkdfSync("sha256", Buffer.from(SECRET, "utf8"), LABEL, info, 32))

describe("persisted names", () => {
  it("signs under keys derived with the label dreamspan", () => {
    const expected = createHmac("sha256", derive("sign image-key v1")).update("card-1", "utf8").digest("base64url")
    assert.strictEqual(makeSecrets(SECRET).sign("card-1", "image-key"), expected)
  })

  it.effect("decrypts what was encrypted under the key derived with the label dreamspan", () =>
    Effect.gen(function* () {
      const nonce = randomBytes(12)
      const cipher = createCipheriv("aes-256-gcm", derive("connection-secrets v1"), nonce)
      cipher.setAAD(Buffer.from("connection:c1:api_key", "utf8"))
      const body = Buffer.concat([cipher.update("sk-synthetic", "utf8"), cipher.final()])
      const blob = new Uint8Array(Buffer.concat([Buffer.of(1), nonce, cipher.getAuthTag(), body]))
      assert.strictEqual(yield* makeSecrets(SECRET).decrypt(blob, "connection:c1:api_key"), "sk-synthetic")
    })
  )

  it("keeps the session cookie's name (a change signs everyone out)", () => {
    assert.strictEqual(SESSION_COOKIE, "dreamspan_session")
  })

  it("keeps the export namespace extensions.dreamspan (a change loses notes, skills, crops and entry fields of every exported card and lorebook)", () => {
    assert.strictEqual(OUR_EXTENSION, "dreamspan")
    assert.strictEqual(CARD_SKILLS_NAMESPACE, "dreamspan")
  })

  it("keeps the database file's name (a change opens an empty database beside the old one)", () => {
    assert.strictEqual(databaseFile("/data"), join("/data", "dreamspan.db"))
  })
})
