// Encryption for connection secrets at rest: API keys, header values, proxy URLs
// (spec/PROVIDERS.md §5). Secrets are encrypted and decrypted on the main thread; the
// database workers only ever see ciphertext.
//
// The server secret comes from SECRET_KEY or SECRET_KEY_FILE when set. Otherwise one is
// generated at first start into DATA_DIR/secret.key (owner, 2026-10-10: setup must be
// trivial). With the key file next to the database, encryption protects a leaked database
// or backup on its own, not a copy of the whole data directory.
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto"
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect"

import { prepareDataDirectory } from "./dataDirectory.ts"

const FORMAT_VERSION = 1
const NONCE_BYTES = 12
const TAG_BYTES = 16

class SecretUnreadable extends Schema.TaggedError<SecretUnreadable>()("SecretUnreadable", {
  /** What the secret was bound to, e.g. "credential:<id>:key". */
  binding: Schema.String
}) {
  override get message() {
    return `A stored secret (${this.binding}) can't be decrypted. The server secret has probably changed; enter it again.`
  }
}

class ServerSecretInvalid extends Schema.TaggedError<ServerSecretInvalid>()("ServerSecretInvalid", {
  source: Schema.String,
  reason: Schema.String
}) {
  override get message() {
    return `The server secret from ${this.source} can't be used: ${this.reason}`
  }
}

export interface SecretsShape {
  /**
   * Encrypts `plaintext` bound to `binding`: a ciphertext only decrypts under the same
   * binding, so a key can't be moved to another connection or field.
   */
  readonly encrypt: (plaintext: string, binding: string) => Uint8Array
  readonly decrypt: (blob: Uint8Array, binding: string) => Effect.Effect<string, SecretUnreadable>
  /**
   * A MAC of `data` (HMAC-SHA256 under a key derived for `purpose`, base64url): for handles the
   * server issues and must recognize later, such as card sources' image keys.
   */
  readonly sign: (data: string, purpose: string) => string
}

export class Secrets extends Context.Service<Secrets, SecretsShape>()("rp/Secrets") {}

/** The AES-256-GCM key, derived from the server secret so any string works as SECRET_KEY. */
const deriveKey = (secret: string) =>
  Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), "dreamspan", "connection-secrets v1", 32))

export const makeSecrets = (secret: string): SecretsShape => {
  const key = deriveKey(secret)
  const signingKeys = new Map<string, Buffer>()
  const signingKey = (purpose: string) => {
    let derived = signingKeys.get(purpose)
    if (!derived) {
      derived = Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), "dreamspan", `sign ${purpose} v1`, 32))
      signingKeys.set(purpose, derived)
    }
    return derived
  }
  return {
    sign: (data, purpose) => createHmac("sha256", signingKey(purpose)).update(data, "utf8").digest("base64url"),
    encrypt: (plaintext, binding) => {
      const nonce = randomBytes(NONCE_BYTES)
      const cipher = createCipheriv("aes-256-gcm", key, nonce)
      cipher.setAAD(Buffer.from(binding, "utf8"))
      const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
      return new Uint8Array(Buffer.concat([Buffer.of(FORMAT_VERSION), nonce, cipher.getAuthTag(), body]))
    },
    decrypt: (blob, binding) =>
      Effect.try({
        try: () => {
          const bytes = Buffer.from(blob)
          if (bytes[0] !== FORMAT_VERSION) throw new Error("unknown format")
          const nonce = bytes.subarray(1, 1 + NONCE_BYTES)
          const tag = bytes.subarray(1 + NONCE_BYTES, 1 + NONCE_BYTES + TAG_BYTES)
          const decipher = createDecipheriv("aes-256-gcm", key, nonce)
          decipher.setAAD(Buffer.from(binding, "utf8"))
          decipher.setAuthTag(tag)
          return Buffer.concat([
            decipher.update(bytes.subarray(1 + NONCE_BYTES + TAG_BYTES)),
            decipher.final()
          ]).toString("utf8")
        },
        catch: () => new SecretUnreadable({ binding })
      })
  }
}

export interface ServerSecretOptions {
  readonly dataDir: string
  readonly secretKey: Option.Option<Redacted.Redacted<string>>
  readonly secretKeyFile: Option.Option<string>
}

const MIN_SECRET_LENGTH = 16

/** Reads the configured secret, or the generated one, creating it on first start. */
export const loadServerSecret = (options: ServerSecretOptions) =>
  Effect.gen(function* () {
    const check = (secret: string, source: string) =>
      secret.length >= MIN_SECRET_LENGTH
        ? Effect.succeed(secret)
        : Effect.fail(new ServerSecretInvalid({ source, reason: `shorter than ${MIN_SECRET_LENGTH} characters` }))

    if (Option.isSome(options.secretKey)) return yield* check(Redacted.value(options.secretKey.value), "SECRET_KEY")
    if (Option.isSome(options.secretKeyFile)) {
      const path = options.secretKeyFile.value
      const secret = yield* Effect.try({
        try: () => readFileSync(path, "utf8").trim(),
        catch: (error) => new ServerSecretInvalid({ source: `SECRET_KEY_FILE ${path}`, reason: String(error) })
      })
      return yield* check(secret, `SECRET_KEY_FILE ${path}`)
    }

    yield* prepareDataDirectory(options.dataDir)
    const path = join(options.dataDir, "secret.key")
    return yield* Effect.try({
      try: () => {
        try {
          // `wx` fails if the file exists, so two starts can't overwrite each other's secret.
          writeFileSync(path, `${randomBytes(32).toString("base64")}\n`, { flag: "wx", mode: 0o600 })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        }
        // Windows uses ACLs. chmod there would only change the read-only attribute.
        if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600)
        return readFileSync(path, "utf8").trim()
      },
      catch: (error) => new ServerSecretInvalid({ source: path, reason: String(error) })
    }).pipe(Effect.flatMap((secret) => check(secret, path)))
  })

export const layer = (options: ServerSecretOptions) =>
  Layer.effect(Secrets, Effect.map(loadServerSecret(options), makeSecrets))
