// The isolation matrix (spec/WORKFLOW.md §3, DESIGN §11): every RPC in AppApi has an
// entry, and the suite fails on an RPC without one or an entry without its RPC. A probe
// runs through a real server over real sockets: one user reads, changes or references
// the other's data and is refused or sees nothing, and the owner's data is unchanged
// afterwards. Probes run both ways, so an admin doesn't get into a user's data either,
// except for admin-only RPCs, where admins may.
import { readFileSync } from "node:fs"
import { assert, describe, it, layer } from "@effect/vitest"
import { AppApi } from "@rp/shared/api.ts"
import type { User } from "@rp/shared/domain.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import type { ConnectionSettings, ConnectionId, CredentialId, ModelId } from "@rp/shared/providers.ts"
import type { RefId } from "@rp/shared/library.ts"
import type { LlmRequestId } from "@rp/shared/usage.ts"
import { Context, Effect, Layer } from "effect"
import type { Rpc, RpcGroup } from "effect/rpc"
import { Writer } from "../src/db/Database.ts"
import { client, login, outcome, serverLayer, testConfig } from "./support/config.ts"

type Api = Effect.Success<ReturnType<typeof client>>

/** One user and what they own. */
interface Party {
  readonly api: Api
  readonly user: User
  readonly connectionId: ConnectionId
  readonly credentialId: CredentialId
  readonly modelId: ModelId
  readonly refId: RefId
  readonly requestId: LlmRequestId
  readonly password: string
  /** The session cookie, for the HTTP routes. */
  readonly cookie: string
}

class Parties extends Context.Service<Parties, { readonly alice: Party; readonly bob: Party }>()(
  "test/isolation/Parties"
) {}

type Probe = (actor: Party, owner: Party) => Effect.Effect<void, unknown>

type Entry =
  /** Run both ways: bob on alice's (an admin's) data, and alice on bob's. */
  | { readonly probe: Probe }
  /** Only an admin may call it, so the probe is a non-admin on an admin's data. */
  | { readonly adminOnly: Probe }
  /** Instance-wide, with no user's data in it. */
  | { readonly global: string }
  /** Makes something new for the caller and names nothing that exists. */
  | { readonly createOnly: string }

// Connections point at a port nothing listens on: if a probe gets through, nothing leaves the host.
const settings = (name: string, presetOverrideRefId: RefId | null = null): ConnectionSettings => ({
  name,
  baseUrl: "http://127.0.0.1:9/v1",
  compat: {},
  cacheTtlS: null,
  maxConcurrent: null,
  presetOverrideRefId
})

const credentialKey = (handle: string) => `sk-${handle}-credential-key`

const refused = <A, E>(attempt: Effect.Effect<A, E>, expected: string) =>
  Effect.map(
    outcome(attempt, () => "allowed"),
    (result) => assert.strictEqual(result, expected)
  )

/** The owner's connection as they see it now, for a current row version. */
const ownConnection = (party: Party) =>
  Effect.map(party.api.ListConnections(), (list) => list.find((c) => c.id === party.connectionId)!)

const ownModel = (party: Party) =>
  Effect.map(party.api.ListModels({ connectionId: party.connectionId, includeHidden: true }), (list) =>
    list.find((m) => m.id === party.modelId)!
  )

const matrix: { readonly [Tag in Rpc.Tag<RpcGroup.Rpcs<typeof AppApi>>]: Entry } = {
  Health: { global: "liveness and event-loop numbers for the instance" },
  Whoami: {
    probe: (actor, owner) =>
      Effect.map(actor.api.Whoami(), (me) => {
        assert.strictEqual(me.id, actor.user.id)
        assert.notStrictEqual(me.id, owner.user.id)
      })
  },
  // Self-only: it describes the caller's own session, never anyone else's.
  GetSession: {
    probe: (actor, owner) =>
      Effect.map(actor.api.GetSession(), (session) => {
        assert.strictEqual(session.user.id, actor.user.id)
        assert.notStrictEqual(session.user.id, owner.user.id)
        assert.strictEqual(session.via, "session")
      })
  },
  ListUsers: { adminOnly: (actor) => refused(actor.api.ListUsers(), "Forbidden") },
  CreateUser: {
    adminOnly: (actor) =>
      refused(
        actor.api.CreateUser({ handle: "mallory", displayName: "", role: "admin", password: "mallory-password" }),
        "Forbidden"
      )
  },
  // An admin may set anyone's password by design.
  SetPassword: {
    adminOnly: (actor, owner) =>
      refused(
        actor.api.SetPassword({ userId: owner.user.id, currentPassword: owner.password, newPassword: "taken-over" }),
        "Forbidden"
      )
  },
  SetUserDisabled: {
    adminOnly: (actor, owner) =>
      refused(actor.api.SetUserDisabled({ userId: owner.user.id, disabled: true }), "Forbidden")
  },
  ListProviderKinds: { global: "the instance's provider registry, the same for every user" },
  ListConnections: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        assert.include(
          (yield* owner.api.ListConnections()).map((c) => c.id),
          owner.connectionId
        )
        assert.notInclude(
          (yield* actor.api.ListConnections()).map((c) => c.id),
          owner.connectionId
        )
      })
  },
  CreateConnection: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        yield* refused(
          actor.api.CreateConnection({
            kind: "openai-chat",
            settings: settings("x"),
            credentialId: owner.credentialId
          }),
          "ProviderError:unusable"
        )
        yield* refused(
          actor.api.CreateConnection({ kind: "openai-chat", settings: settings("x", owner.refId) }),
          "ProviderError:unusable"
        )
      })
  },
  UpdateConnection: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const theirs = yield* ownConnection(owner)
        yield* refused(
          actor.api.UpdateConnection({
            connectionId: owner.connectionId,
            settings: settings("taken"),
            expectedRowVersion: theirs.rowVersion
          }),
          "NotFound"
        )
        const mine = yield* ownConnection(actor)
        yield* refused(
          actor.api.UpdateConnection({
            connectionId: actor.connectionId,
            settings: settings("mine", owner.refId),
            expectedRowVersion: mine.rowVersion
          }),
          "NotFound"
        )
      })
  },
  SetConnectionKey: {
    probe: (actor, owner) =>
      Effect.flatMap(ownConnection(owner), (theirs) =>
        refused(
          actor.api.SetConnectionKey({
            connectionId: owner.connectionId,
            apiKey: "sk-replaced-key",
            expectedRowVersion: theirs.rowVersion
          }),
          "ProviderError:unusable"
        )
      )
  },
  SetConnectionCredential: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        yield* refused(
          actor.api.SetConnectionCredential({ connectionId: owner.connectionId, credentialId: null }),
          "NotFound"
        )
        yield* refused(
          actor.api.SetConnectionCredential({ connectionId: actor.connectionId, credentialId: owner.credentialId }),
          "NotFound"
        )
      })
  },
  ListCredentials: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        assert.include(
          (yield* owner.api.ListCredentials()).map((c) => c.id),
          owner.credentialId
        )
        assert.notInclude(
          (yield* actor.api.ListCredentials()).map((c) => c.id),
          owner.credentialId
        )
      })
  },
  CreateCredential: { createOnly: "stores a new key for the caller" },
  RenameCredential: {
    probe: (actor, owner) =>
      refused(actor.api.RenameCredential({ credentialId: owner.credentialId, name: "taken" }), "NotFound")
  },
  ReplaceCredentialKey: {
    probe: (actor, owner) =>
      refused(
        actor.api.ReplaceCredentialKey({ credentialId: owner.credentialId, apiKey: "sk-replaced-key", urls: [] }),
        "ProviderError:unusable"
      )
  },
  // With the right key typed: knowing a key still doesn't open someone else's credential.
  AllowCredentialHost: {
    probe: (actor, owner) =>
      refused(
        actor.api.AllowCredentialHost({
          credentialId: owner.credentialId,
          apiKey: credentialKey(owner.user.handle),
          url: "https://evil.example"
        }),
        "ProviderError:unusable"
      )
  },
  DeleteCredential: {
    probe: (actor, owner) => refused(actor.api.DeleteCredential({ credentialId: owner.credentialId }), "NotFound")
  },
  SetConnectionHeaders: {
    probe: (actor, owner) =>
      Effect.flatMap(ownConnection(owner), (theirs) =>
        refused(
          actor.api.SetConnectionHeaders({
            connectionId: owner.connectionId,
            headers: { "X-Exfiltrate": "1" },
            expectedRowVersion: theirs.rowVersion
          }),
          "ProviderError:unusable"
        )
      )
  },
  SetConnectionProxy: {
    probe: (actor, owner) =>
      refused(
        actor.api.SetConnectionProxy({
          connectionId: owner.connectionId,
          mode: "custom",
          url: "http://evil.example:8080"
        }),
        "ProviderError:unusable"
      )
  },
  DeleteConnection: {
    probe: (actor, owner) => refused(actor.api.DeleteConnection({ connectionId: owner.connectionId }), "NotFound")
  },
  TestConnection: {
    probe: (actor, owner) =>
      refused(actor.api.TestConnection({ connectionId: owner.connectionId }), "ProviderError:unusable")
  },
  RefreshModels: {
    probe: (actor, owner) =>
      refused(actor.api.RefreshModels({ connectionId: owner.connectionId }), "ProviderError:unusable")
  },
  ListModels: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        assert.strictEqual((yield* ownModel(owner)).id, owner.modelId)
        yield* refused(actor.api.ListModels({ connectionId: owner.connectionId, includeHidden: true }), "NotFound")
      })
  },
  AddUserModel: {
    probe: (actor, owner) =>
      refused(actor.api.AddUserModel({ connectionId: owner.connectionId, key: "planted", overrides: {} }), "NotFound")
  },
  EditModel: {
    probe: (actor, owner) =>
      Effect.flatMap(ownModel(owner), (theirs) =>
        refused(
          actor.api.EditModel({
            modelId: owner.modelId,
            overrides: { context: 1 },
            expectedRowVersion: theirs.rowVersion
          }),
          "NotFound"
        )
      )
  },
  SetModelHidden: {
    probe: (actor, owner) => refused(actor.api.SetModelHidden({ modelId: owner.modelId, hidden: true }), "NotFound")
  },
  GetNetworkSettings: { adminOnly: (actor) => refused(actor.api.GetNetworkSettings(), "Forbidden") },
  SetNetworkSettings: {
    adminOnly: (actor, owner) =>
      Effect.gen(function* () {
        yield* refused(
          actor.api.SetNetworkSettings({ proxyUrl: "http://evil.example:8080", bypass: [], forceProxy: false }),
          "Forbidden"
        )
        assert.isNull((yield* owner.api.GetNetworkSettings()).proxy)
      })
  },
  ListLlmRequests: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const page = { limit: 1000, before: null }
        assert.include(
          (yield* owner.api.ListLlmRequests(page)).map((r) => r.id),
          owner.requestId
        )
        assert.notInclude(
          (yield* actor.api.ListLlmRequests(page)).map((r) => r.id),
          owner.requestId
        )
      })
  },
  ListLibrary: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        assert.include(
          (yield* owner.api.ListLibrary({ kind: "preset" })).map((r) => r.id),
          owner.refId
        )
        assert.notInclude(
          (yield* actor.api.ListLibrary({ kind: "preset" })).map((r) => r.id),
          owner.refId
        )
      })
  }
}

const config = testConfig()

/** A request to an HTTP route as `party`, from this site. */
const http = (party: Party, path: string, body: Uint8Array | string, contentType: string) =>
  Effect.promise(() =>
    fetch(`http://127.0.0.1:${config.port}${path}`, {
      method: "POST",
      headers: { cookie: party.cookie, "content-type": contentType },
      body
    })
  )

const presetFile = readFileSync(new URL("./fixtures/presets/default.json", import.meta.url))

/** The HTTP routes that act on a user's data (ARCHITECTURE.md §11.4), probed the same way. */
const routes: Record<string, Probe> = {
  "POST /library/import": (actor, owner) =>
    Effect.gen(function* () {
      const into = yield* http(
        actor,
        `/library/import?name=p.json&into=${owner.refId}`,
        presetFile,
        "application/octet-stream"
      )
      assert.strictEqual(into.status, 404)
      // A new import is the actor's own, and nothing of the owner's changes (run checks).
      const own = yield* http(actor, "/library/import?name=p.json", presetFile, "application/octet-stream")
      assert.strictEqual(own.status, 200)
    }),
  "POST /library/export": (actor, owner) =>
    Effect.gen(function* () {
      const response = yield* http(
        actor,
        "/library/export",
        JSON.stringify({ refId: owner.refId, format: "st-preset" }),
        "application/json"
      )
      assert.strictEqual(response.status, 404)
    })
}

/** alice is the instance's admin, bob a user she created; each owns one of everything. */
const seed = Effect.gen(function* () {
  const writer = yield* Writer
  const party = (api: Api, user: User, password: string, cookie: string) =>
    Effect.gen(function* () {
      const credential = yield* api.CreateCredential({
        name: "Mine",
        apiKey: credentialKey(user.handle),
        urls: ["http://127.0.0.1:9/v1"]
      })
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: settings(`${user.handle}'s`),
        apiKey: `sk-${user.handle}-connection-key`
      })
      const model = yield* api.AddUserModel({ connectionId: connection.id, key: "m", overrides: {} })
      // No RPC writes these yet.
      const { ref } = yield* writer.CreateEntity({
        userId: user.id,
        kind: "preset",
        label: "Preset",
        subtitle: "",
        doc: {},
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
      const requestId = uuidv7() as LlmRequestId
      yield* writer.OpenLlmRequest({
        userId: user.id,
        request: {
          id: requestId,
          connectionId: connection.id,
          modelId: model.id,
          chatId: null,
          rolloutId: null,
          versionId: null,
          purpose: "generation",
          api: "openai-completions",
          provider: "openai",
          modelKey: "m",
          startedAt: Date.now()
        }
      })
      return {
        api,
        user,
        password,
        connectionId: connection.id,
        credentialId: credential.id,
        modelId: model.id,
        refId: ref.id,
        requestId,
        cookie
      } satisfies Party
    })

  const local = yield* client()
  const aliceUser = yield* local.Whoami()
  yield* local.SetPassword({ userId: aliceUser.id, currentPassword: null, newPassword: "alice-password" })
  const aliceCookie = (yield* login(aliceUser.handle, "alice-password")).cookie
  const aliceApi = yield* client({ cookie: aliceCookie })
  yield* aliceApi.CreateUser({ handle: "bob", displayName: "Bob", role: "user", password: "bob-password" })
  const bobCookie = (yield* login("bob", "bob-password")).cookie
  const bobApi = yield* client({ cookie: bobCookie })
  return {
    alice: yield* party(aliceApi, aliceUser, "alice-password", aliceCookie),
    bob: yield* party(bobApi, yield* bobApi.Whoami(), "bob-password", bobCookie)
  }
})

describe("isolation matrix", () => {
  it("has exactly one entry per RPC in AppApi", () => {
    assert.deepStrictEqual(Object.keys(matrix).sort(), [...AppApi.requests.keys()].sort())
  })
})

/** Everything the owner can see of their own data and the instance's, as text. */
const snapshot = (owner: Party) =>
  Effect.all([
    outcome(owner.api.ListConnections(), JSON.stringify),
    outcome(owner.api.ListCredentials(), JSON.stringify),
    outcome(owner.api.ListModels({ connectionId: owner.connectionId, includeHidden: true }), JSON.stringify),
    outcome(owner.api.ListLlmRequests({ limit: 1000, before: null }), JSON.stringify),
    outcome(owner.api.ListUsers(), JSON.stringify),
    outcome(owner.api.ListLibrary({ kind: "preset" }), JSON.stringify),
    outcome(owner.api.GetNetworkSettings(), JSON.stringify)
  ])

/** Runs a probe, then checks that it changed nothing of the owner's, whatever it returned. */
const run = (probe: Probe, actor: (p: Parties["Service"]) => Party, owner: (p: Parties["Service"]) => Party) =>
  Effect.flatMap(Parties, (p) =>
    Effect.gen(function* () {
      const before = yield* snapshot(owner(p))
      yield* probe(actor(p), owner(p))
      assert.deepStrictEqual(yield* snapshot(owner(p)), before)
    })
  )

layer(Layer.effect(Parties, seed).pipe(Layer.provide(serverLayer(config))), {
  excludeTestServices: true,
  timeout: "60 seconds"
})("isolation probes", (it) => {
  for (const [tag, entry] of Object.entries(matrix) as Array<[string, Entry]>) {
    if ("probe" in entry) {
      it.effect(`${tag}: bob on alice's (an admin's)`, () =>
        run(
          entry.probe,
          (p) => p.bob,
          (p) => p.alice
        )
      )
      it.effect(`${tag}: alice (an admin) on bob's`, () =>
        run(
          entry.probe,
          (p) => p.alice,
          (p) => p.bob
        )
      )
    } else if ("adminOnly" in entry) {
      it.effect(`${tag}: bob, not an admin`, () =>
        run(
          entry.adminOnly,
          (p) => p.bob,
          (p) => p.alice
        )
      )
    }
  }
  for (const [route, probe] of Object.entries(routes)) {
    it.effect(`${route}: bob on alice's (an admin's)`, () =>
      run(
        probe,
        (p) => p.bob,
        (p) => p.alice
      )
    )
    it.effect(`${route}: alice (an admin) on bob's`, () =>
      run(
        probe,
        (p) => p.alice,
        (p) => p.bob
      )
    )
  }
})
