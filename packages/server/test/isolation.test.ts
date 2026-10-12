// The isolation matrix (spec/WORKFLOW.md §3, DESIGN §11): every RPC in AppApi has an
// entry, and the suite fails on an RPC without one or an entry without its RPC. A probe
// runs through a real server over real sockets: one user reads, changes or references
// the other's data and is refused or sees nothing, and the owner's data is unchanged
// afterwards. Probes run both ways, so an admin doesn't get into a user's data either,
// except for admin-only RPCs, where admins may.
import { readFileSync } from "node:fs"
import { assert, describe, it, layer } from "@effect/vitest"
import { AppApi } from "@rp/shared/api.ts"
import type { ChatId, EntityId, SlotId, VersionId } from "@rp/shared/chat.ts"
import type { User } from "@rp/shared/domain.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import type { ConnectionSettings, ConnectionId, CredentialId, ModelId } from "@rp/shared/providers.ts"
import type { RefId, RevisionId } from "@rp/shared/library.ts"
import { textField } from "@rp/shared/editing.ts"
import type { LlmRequestId } from "@rp/shared/usage.ts"
import { Context, Effect, Layer, Stream } from "effect"
import type { Rpc, RpcGroup } from "effect/rpc"
import { Writer } from "../src/db/Database.ts"
import * as FakeGenerator from "../src/dev/fakeGenerator.ts"
import { png, textChunk } from "./formats/support.ts"
import { client, login, outcome, posted, serverLayer, serverPort, testConfig } from "./support/config.ts"

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
  /** The test server's port, for the HTTP routes. */
  readonly port: number
  readonly chat: OwnChat
  /** A card, in the persona folder, with a greeting. */
  readonly cardId: EntityId
  /** A message queued behind the generating reply. */
  readonly queuedId: string
  readonly editor: OwnEditor
}

/** A card with an avatar, a note and an unsaved draft. */
interface OwnEditor {
  readonly cardRefId: RefId
  readonly revisionId: RevisionId
  readonly noteRefId: RefId
  readonly avatarMediaId: string
  readonly field: string
}

/** A chat with the user's message and a model reply still generating under it. */
interface OwnChat {
  readonly chatId: ChatId
  readonly slotId: SlotId
  readonly versionId: VersionId
  readonly replySlotId: SlotId
  readonly generatingId: VersionId
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

/** The owner's message as they see it now, for a current row version. */
const ownSlot = (party: Party) =>
  Effect.map(
    party.api.ReadPath({ chatId: party.chat.chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 }),
    (window) => window.entries.find((e) => e.slotId === party.chat.slotId)!
  )

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
  },
  // --- Chats
  ListChats: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const page = { limit: 500, before: null }
        assert.include(
          (yield* owner.api.ListChats(page)).map((c) => c.id),
          owner.chat.chatId
        )
        assert.notInclude(
          (yield* actor.api.ListChats(page)).map((c) => c.id),
          owner.chat.chatId
        )
      })
  },
  CreateChat: { createOnly: "starts an empty chat for the caller" },
  GetChat: { probe: (actor, owner) => refused(actor.api.GetChat({ chatId: owner.chat.chatId }), "NotFound") },
  ReadPath: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const bottom = { _tag: "Bottom" } as const
        yield* refused(
          actor.api.ReadPath({ chatId: owner.chat.chatId, leafSlotId: null, range: bottom, limit: 10 }),
          "NotFound"
        )
        // Someone else's slot as the leaf, or as where to read from, in one's own chat.
        const mine = actor.chat.chatId
        yield* refused(
          actor.api.ReadPath({ chatId: mine, leafSlotId: owner.chat.slotId, range: bottom, limit: 10 }),
          "NotFound"
        )
        for (const range of [
          { _tag: "Around", slot: owner.chat.slotId },
          { _tag: "Older", from: owner.chat.slotId },
          { _tag: "Newer", after: owner.chat.slotId }
        ] as const) {
          yield* refused(actor.api.ReadPath({ chatId: mine, leafSlotId: null, range, limit: 10 }), "NotFound")
        }
      })
  },
  ListVersions: {
    probe: (actor, owner) => refused(actor.api.ListVersions({ slotId: owner.chat.slotId }), "NotFound")
  },
  SendMessage: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        yield* refused(
          actor.api.SendMessage({
            chatId: owner.chat.chatId,
            parentSlotId: owner.chat.replySlotId,
            branch: false,
            content: "planted"
          }),
          "NotFound"
        )
        yield* refused(
          actor.api.SendMessage({
            chatId: actor.chat.chatId,
            parentSlotId: owner.chat.slotId,
            branch: true,
            content: "planted"
          }),
          "NotFound"
        )
        // As their card, posted or queued (the actor's reply is still generating).
        for (const parentSlotId of [actor.chat.slotId, actor.chat.replySlotId]) {
          yield* refused(
            actor.api.SendMessage({
              chatId: actor.chat.chatId,
              parentSlotId,
              branch: true,
              content: "planted",
              speakerEntityId: owner.cardId
            }),
            "NotFound"
          )
        }
      })
  },
  Generate: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        yield* refused(
          actor.api.Generate({ chatId: owner.chat.chatId, parentSlotId: owner.chat.replySlotId, branch: false }),
          "NotFound"
        )
        yield* refused(
          actor.api.Generate({ chatId: actor.chat.chatId, parentSlotId: owner.chat.slotId, branch: true }),
          "NotFound"
        )
        yield* refused(
          actor.api.Generate({
            chatId: actor.chat.chatId,
            parentSlotId: actor.chat.replySlotId,
            branch: true,
            speakerEntityId: owner.cardId
          }),
          "NotFound"
        )
      })
  },
  Regenerate: {
    probe: (actor, owner) =>
      Effect.flatMap(ownSlot(owner), (theirs) =>
        refused(actor.api.Regenerate({ slotId: owner.chat.slotId, expectedRowVersion: theirs.rowVersion }), "NotFound")
      )
  },
  StopGeneration: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        yield* refused(actor.api.StopGeneration({ versionId: owner.chat.generatingId }), "NotFound")
        // A finished version, which a Stop that lost the race with the finish returns.
        yield* refused(actor.api.StopGeneration({ versionId: owner.chat.versionId }), "NotFound")
      })
  },
  SelectVersion: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const theirs = yield* ownSlot(owner)
        yield* refused(
          actor.api.SelectVersion({
            slotId: owner.chat.slotId,
            versionId: owner.chat.versionId,
            expectedRowVersion: theirs.rowVersion
          }),
          "NotFound"
        )
        const mine = yield* ownSlot(actor)
        yield* refused(
          actor.api.SelectVersion({
            slotId: actor.chat.slotId,
            versionId: owner.chat.versionId,
            expectedRowVersion: mine.rowVersion
          }),
          "NotFound"
        )
      })
  },
  EditVersion: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const theirs = yield* ownSlot(owner)
        yield* refused(
          actor.api.EditVersion({
            slotId: owner.chat.slotId,
            sourceVersionId: owner.chat.versionId,
            content: "planted",
            expectedRowVersion: theirs.rowVersion
          }),
          "NotFound"
        )
        const mine = yield* ownSlot(actor)
        yield* refused(
          actor.api.EditVersion({
            slotId: actor.chat.slotId,
            sourceVersionId: owner.chat.versionId,
            content: "planted",
            expectedRowVersion: mine.rowVersion
          }),
          "NotFound"
        )
      })
  },
  WriteVersion: {
    probe: (actor, owner) =>
      Effect.flatMap(ownSlot(owner), (theirs) =>
        refused(
          actor.api.WriteVersion({
            slotId: owner.chat.slotId,
            content: "planted",
            expectedRowVersion: theirs.rowVersion
          }),
          "NotFound"
        )
      )
  },
  AmendVersion: {
    probe: (actor, owner) =>
      refused(
        actor.api.AmendVersion({ versionId: owner.chat.versionId, content: "planted", expectedRowVersion: 1 }),
        "NotFound"
      )
  },
  DeleteChat: { probe: (actor, owner) => refused(actor.api.DeleteChat({ chatId: owner.chat.chatId }), "NotFound") },
  DeleteMessage: {
    probe: (actor, owner) => refused(actor.api.DeleteMessage({ slotId: owner.chat.slotId }), "NotFound")
  },
  DeleteBranch: {
    probe: (actor, owner) => refused(actor.api.DeleteBranch({ slotId: owner.chat.slotId }), "NotFound")
  },
  DeleteVersion: {
    probe: (actor, owner) => refused(actor.api.DeleteVersion({ versionId: owner.chat.versionId }), "NotFound")
  },
  SubscribeChat: {
    probe: (actor, owner) =>
      refused(actor.api.SubscribeChat({ chatId: owner.chat.chatId }).pipe(Stream.runHead), "NotFound")
  },
  // --- Chat setup, speakers and the send queue (chatSetupApi.ts).
  ListCards: {
    probe: (actor, owner) =>
      Effect.map(actor.api.ListCards(), (cards) => {
        assert.isTrue(cards.some((c) => c.entityId === actor.cardId))
        assert.isFalse(cards.some((c) => c.entityId === owner.cardId))
      })
  },
  SetPersona: {
    probe: (actor, owner) => refused(actor.api.SetPersona({ entityId: owner.cardId, persona: false }), "NotFound")
  },
  GetCardForChat: {
    probe: (actor, owner) => refused(actor.api.GetCardForChat({ entityId: owner.cardId }), "NotFound")
  },
  StartChat: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const send = (speakerEntityId: EntityId | null) => ({ _tag: "Send" as const, content: "hi", speakerEntityId })
        // Their card as the chat's card, as the persona, or as the first message's speaker.
        yield* refused(
          actor.api.StartChat({ cards: [owner.cardId], persona: null, greeting: null, first: send(null) }),
          "NotFound"
        )
        yield* refused(
          actor.api.StartChat({ cards: [actor.cardId], persona: owner.cardId, greeting: null, first: send(null) }),
          "NotFound"
        )
        yield* refused(
          actor.api.StartChat({ cards: [actor.cardId], persona: null, greeting: null, first: send(owner.cardId) }),
          "NotFound"
        )
      })
  },
  GetCast: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        yield* refused(actor.api.GetCast({ chatId: owner.chat.chatId, slotId: null }), "NotFound")
        yield* refused(actor.api.GetCast({ chatId: actor.chat.chatId, slotId: owner.chat.slotId }), "NotFound")
      })
  },
  ChangeCast: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const join = (entityId: EntityId) => ({ _tag: "Join" as const, entityId })
        yield* refused(
          actor.api.ChangeCast({ chatId: owner.chat.chatId, slotId: null, change: join(actor.cardId) }),
          "NotFound"
        )
        // Their card, connection or preset into the actor's own chat.
        yield* refused(
          actor.api.ChangeCast({ chatId: actor.chat.chatId, slotId: null, change: join(owner.cardId) }),
          "NotFound"
        )
        yield* refused(
          actor.api.ChangeCast({
            chatId: actor.chat.chatId,
            slotId: null,
            change: { _tag: "Model", connection: owner.connectionId, model: owner.modelId }
          }),
          "NotFound"
        )
        yield* refused(
          actor.api.ChangeCast({
            chatId: actor.chat.chatId,
            slotId: null,
            change: { _tag: "Preset", ref: owner.refId }
          }),
          "NotFound"
        )
      })
  },
  ListQueued: {
    probe: (actor, owner) => refused(actor.api.ListQueued({ chatId: owner.chat.chatId }), "NotFound")
  },
  EditQueued: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        yield* refused(
          actor.api.EditQueued({
            queuedId: owner.queuedId,
            content: "planted",
            speakerEntityId: null,
            expectedRowVersion: 1
          }),
          "NotFound"
        )
        // Their card as the speaker of the actor's own queued message.
        yield* refused(
          actor.api.EditQueued({
            queuedId: actor.queuedId,
            content: "waiting",
            speakerEntityId: owner.cardId,
            expectedRowVersion: 1
          }),
          "NotFound"
        )
      })
  },
  WithdrawQueued: {
    probe: (actor, owner) =>
      refused(actor.api.WithdrawQueued({ queuedId: owner.queuedId, expectedRowVersion: 1 }), "NotFound")
  },
  // --- ST data folder import
  StartStImport: { createOnly: "starts an import for the caller, ending only the caller's earlier one" },
  GetStImportReport: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const { importId } = yield* owner.api.StartStImport({ unsupported: [] })
        yield* refused(actor.api.GetStImportReport({ importId }), "NotFound")
        // The owner's import is still theirs.
        yield* owner.api.GetStImportReport({ importId })
      })
  },
  UnhideImportedRun: {
    probe: (actor, owner) =>
      refused(actor.api.UnhideImportedRun({ chatId: owner.chat.chatId, throughSlotId: owner.chat.slotId }), "NotFound")
  },
  // --- The card and preset editors
  OpenEditor: {
    probe: (actor, owner) => refused(actor.api.OpenEditor({ refId: owner.editor.cardRefId }), "NotFound")
  },
  CreateCard: { createOnly: "makes a new card for the caller" },
  SaveEditorDraft: {
    probe: (actor, owner) =>
      refused(
        actor.api.SaveEditorDraft({
          refId: owner.editor.cardRefId,
          field: owner.editor.field,
          content: "planted",
          expectedRowVersion: null,
          baseRevisionId: null
        }),
        "NotFound"
      )
  },
  EditorDraftHistory: {
    probe: (actor, owner) =>
      refused(
        actor.api.EditorDraftHistory({ refId: owner.editor.cardRefId, field: owner.editor.field, limit: 10 }),
        "NotFound"
      )
  },
  RestoreEditorDraft: {
    probe: (actor, owner) =>
      refused(
        actor.api.RestoreEditorDraft({
          refId: owner.editor.cardRefId,
          field: owner.editor.field,
          seq: 0,
          expectedRowVersion: 1
        }),
        "NotFound"
      )
  },
  DiscardEditorDraft: {
    probe: (actor, owner) =>
      refused(
        actor.api.DiscardEditorDraft({
          refId: owner.editor.cardRefId,
          field: owner.editor.field,
          expectedRowVersion: 1
        }),
        "NotFound"
      )
  },
  CommitEditorDrafts: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const theirs = yield* owner.api.OpenEditor({ refId: owner.editor.cardRefId })
        yield* refused(
          actor.api.CommitEditorDrafts({
            refId: owner.editor.cardRefId,
            expectedRowVersion: theirs.ref.rowVersion,
            fields: theirs.drafts.map((d) => ({ field: d.key.field, expectedRowVersion: d.rowVersion })),
            message: "taken"
          }),
          "NotFound"
        )
      })
  },
  ListRevisions: {
    probe: (actor, owner) => refused(actor.api.ListRevisions({ refId: owner.editor.cardRefId, limit: 10 }), "NotFound")
  },
  GetRevision: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const revisionId = owner.editor.revisionId
        yield* refused(actor.api.GetRevision({ refId: owner.editor.cardRefId, revisionId }), "NotFound")
        // Someone else's revision through one's own card.
        yield* refused(actor.api.GetRevision({ refId: actor.editor.cardRefId, revisionId }), "NotFound")
      })
  },
  RestoreRevision: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const revisionId = owner.editor.revisionId
        const theirs = yield* owner.api.OpenEditor({ refId: owner.editor.cardRefId })
        yield* refused(
          actor.api.RestoreRevision({
            refId: owner.editor.cardRefId,
            revisionId,
            expectedRowVersion: theirs.ref.rowVersion
          }),
          "NotFound"
        )
        const mine = yield* actor.api.OpenEditor({ refId: actor.editor.cardRefId })
        yield* refused(
          actor.api.RestoreRevision({
            refId: actor.editor.cardRefId,
            revisionId,
            expectedRowVersion: mine.ref.rowVersion
          }),
          "NotFound"
        )
      })
  },
  ForkVariant: {
    probe: (actor, owner) =>
      refused(
        actor.api.ForkVariant({ refId: owner.editor.cardRefId, label: "Taken", subtitle: "", moveDrafts: true }),
        "NotFound"
      )
  },
  RenameRef: {
    probe: (actor, owner) =>
      Effect.flatMap(owner.api.OpenEditor({ refId: owner.editor.cardRefId }), (theirs) =>
        refused(
          actor.api.RenameRef({
            refId: owner.editor.cardRefId,
            label: "Taken",
            subtitle: "",
            expectedRowVersion: theirs.ref.rowVersion
          }),
          "NotFound"
        )
      )
  },
  SetRegexApproval: {
    probe: (actor, owner) =>
      refused(actor.api.SetRegexApproval({ refId: owner.refId, approved: true, expectedRowVersion: 1 }), "NotFound")
  },
  PreviewUpdate: {
    probe: (actor, owner) => refused(actor.api.PreviewUpdate({ refId: owner.editor.cardRefId }), "NotFound")
  },
  ApplyUpdate: {
    probe: (actor, owner) => refused(actor.api.ApplyUpdate({ refId: owner.editor.cardRefId }), "NotFound")
  },
  ResolveUpdate: {
    probe: (actor, owner) =>
      refused(
        actor.api.ResolveUpdate({
          refId: owner.editor.cardRefId,
          doc: {},
          theirsRevisionId: owner.editor.revisionId,
          expectedRowVersion: 1
        }),
        "NotFound"
      )
  },
  ListCardNotes: {
    probe: (actor, owner) => refused(actor.api.ListCardNotes({ cardRefId: owner.editor.cardRefId }), "NotFound")
  },
  CreateCardNote: {
    probe: (actor, owner) =>
      refused(actor.api.CreateCardNote({ cardRefId: owner.editor.cardRefId, title: "Planted" }), "NotFound")
  },
  DeleteCardNote: {
    probe: (actor, owner) => refused(actor.api.DeleteCardNote({ noteRefId: owner.editor.noteRefId }), "NotFound")
  }
}

/** A generator so slow that the seeded replies are still generating when the probes run. */
const config = testConfig()
const slowGenerator = FakeGenerator.layer({ tokensPerSecond: 5, tokens: 20_000 })

/** A request to an HTTP route as `party`, from this site. */
const http = (party: Party, path: string, body: Uint8Array | string, contentType: string) =>
  Effect.promise(() =>
    fetch(`http://127.0.0.1:${party.port}${path}`, {
      method: "POST",
      headers: { cookie: party.cookie, "content-type": contentType },
      body
    })
  )

const presetFile = readFileSync(new URL("./fixtures/presets/default.json", import.meta.url))

/** A 1×1 PNG of one's own: the same bytes would be one stored file, referenced by both users. */
const avatarFile = (handle: string) => png(textChunk("owner", handle))

const httpGet = (party: Party, path: string) =>
  Effect.promise(() => fetch(`http://127.0.0.1:${party.port}${path}`, { headers: { cookie: party.cookie } }))

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
  "POST /st-import/file": (actor, owner) =>
    Effect.gen(function* () {
      const { importId } = yield* owner.api.StartStImport({ unsupported: [] })
      const path = (query: Record<string, string>) => `/st-import/file?${new URLSearchParams(query)}`
      const chat = new TextEncoder().encode(
        [{ chat_metadata: {} }, { name: "A", mes: "hi" }, { name: "B", is_user: true, mes: "hello" }]
          .map((line) => JSON.stringify(line))
          .join("\n")
      )
      // The owner's import takes nothing from anyone else.
      const into = yield* http(
        actor,
        path({ import: importId, path: "chats/A/a.jsonl" }),
        chat,
        "application/octet-stream"
      )
      assert.strictEqual(into.status, 404)
      // The actor's own import can't name the owner's card as a chat's.
      const own = yield* actor.api.StartStImport({ unsupported: [] })
      const linked = yield* http(
        actor,
        path({ import: own.importId, path: "chats/A/a.jsonl", card: owner.cardId }),
        chat,
        "application/octet-stream"
      )
      assert.strictEqual(linked.status, 200)
      assert.strictEqual(((yield* Effect.promise(() => linked.json())) as { outcome: string }).outcome, "failed")
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
    }),
  "POST /library/avatar": (actor, owner) =>
    Effect.gen(function* () {
      const theirs = yield* owner.api.OpenEditor({ refId: owner.editor.cardRefId })
      const response = yield* http(
        actor,
        `/library/avatar?ref=${owner.editor.cardRefId}&rowVersion=${theirs.ref.rowVersion}`,
        avatarFile(actor.user.handle),
        "application/octet-stream"
      )
      assert.strictEqual(response.status, 404)
    }),
  "GET /library/media": (actor, owner) =>
    Effect.gen(function* () {
      const path = `/library/media?id=${owner.editor.avatarMediaId}`
      assert.strictEqual((yield* httpGet(owner, path)).status, 200)
      assert.strictEqual((yield* httpGet(actor, path)).status, 404)
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
      const chat = yield* api.CreateChat({ title: `${user.handle}'s chat` })
      const sent = yield* posted(
        api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "hello" })
      )
      const reply = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false }))
      const card = yield* writer.CreateEntity({
        userId: user.id,
        kind: "card",
        label: `${user.handle}'s card`,
        subtitle: "",
        doc: { name: `${user.handle} card`, first_mes: "Hello, {{user}}." },
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
      yield* writer.SetEntityTags({ userId: user.id, entityId: card.entityId, tags: ["persona"] })
      // A card with an avatar, a note and a draft, for the editors' probes.
      const editorCard = yield* api.CreateCard({ label: `${user.handle}'s card`, name: "Wren" })
      const port = yield* serverPort
      const uploaded = yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${port}/library/avatar?ref=${editorCard.id}&rowVersion=${editorCard.rowVersion}`, {
          method: "POST",
          headers: { cookie, "content-type": "application/octet-stream" },
          body: avatarFile(user.handle)
        })
      )
      assert.strictEqual(uploaded.status, 200)
      const note = yield* api.CreateCardNote({ cardRefId: editorCard.id, title: "Outfit" })
      const field = textField(["description"])
      yield* api.SaveEditorDraft({
        refId: editorCard.id,
        field,
        content: "A lighthouse keeper.",
        expectedRowVersion: null,
        baseRevisionId: null
      })
      const opened = yield* api.OpenEditor({ refId: editorCard.id })
      const queued = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: reply.entry.slotId,
        branch: false,
        content: "waiting"
      })
      if (queued._tag !== "Queued") return yield* Effect.die(new Error("the seed message didn't queue"))
      return {
        cardId: card.entityId,
        queuedId: queued.queued.id,
        api,
        user,
        password,
        chat: {
          chatId: chat.id,
          slotId: sent.entry.slotId,
          versionId: sent.entry.version.id,
          replySlotId: reply.entry.slotId,
          generatingId: reply.entry.version.id
        },
        connectionId: connection.id,
        credentialId: credential.id,
        modelId: model.id,
        refId: ref.id,
        requestId,
        cookie,
        port,
        editor: {
          cardRefId: editorCard.id,
          revisionId: opened.ref.headRevisionId,
          noteRefId: note.id,
          avatarMediaId: opened.doc.avatar_media_id as string,
          field
        }
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
    outcome(owner.api.GetNetworkSettings(), JSON.stringify),
    outcome(owner.api.ListChats({ limit: 500, before: null }), JSON.stringify),
    // A generating version's saved text grows on its own, so only which one it is counts.
    outcome(
      owner.api.ReadPath({ chatId: owner.chat.chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 100 }),
      (window) =>
        JSON.stringify(
          window.entries.map((e) =>
            e.version.status === "generating"
              ? { slotId: e.slotId, rowVersion: e.rowVersion, versionCount: e.versionCount, version: e.version.id }
              : e
          )
        )
    ),
    outcome(owner.api.ListVersions({ slotId: owner.chat.slotId }), JSON.stringify),
    outcome(owner.api.ListQueued({ chatId: owner.chat.chatId }), JSON.stringify),
    outcome(owner.api.GetCast({ chatId: owner.chat.chatId, slotId: null }), JSON.stringify),
    outcome(owner.api.ListCards(), JSON.stringify),
    outcome(owner.api.OpenEditor({ refId: owner.editor.cardRefId }), JSON.stringify),
    outcome(owner.api.ListRevisions({ refId: owner.editor.cardRefId, limit: 100 }), JSON.stringify),
    outcome(owner.api.ListCardNotes({ cardRefId: owner.editor.cardRefId }), JSON.stringify),
    outcome(owner.api.ListLibrary({ kind: "card" }), JSON.stringify)
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

layer(Layer.effect(Parties, seed).pipe(Layer.provide(serverLayer(config, slowGenerator))), {
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
