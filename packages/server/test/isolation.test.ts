import type { Summary } from "@rp/shared/lcm.ts"
import { completeFixture, fixtureSql, summaryJob } from "./support/lcmFixtures.ts"
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
import { Context, Effect, Fiber, Layer, Option, Stream } from "effect"
import type { Rpc, RpcGroup } from "effect/rpc"
import { Reader, Writer } from "../src/db/Database.ts"
import type { Notice } from "@rp/shared/noticeApi.ts"
import { Notices } from "../src/chat/Notices.ts"
import * as FakeGenerator from "../src/dev/fakeGenerator.ts"
import { png, textChunk } from "./formats/support.ts"
import {
  client,
  login,
  outcome,
  posted,
  serverLayer,
  serverPort,
  testConfig,
  takenFrom,
  typeInto
} from "./support/config.ts"
import { cardDoc, docFor, presetDoc } from "./support/docs.ts"

type Api = Effect.Success<ReturnType<typeof client>>

/** One user and what they own. */
interface Party {
  readonly api: Api
  readonly user: User
  readonly connectionId: ConnectionId
  readonly credentialId: CredentialId
  readonly modelId: ModelId
  readonly refId: RefId
  readonly loreRefId: RefId
  readonly requestId: LlmRequestId
  readonly password: string
  /** The session cookie, for the HTTP routes. */
  readonly cookie: string
  /** The test server's port, for the HTTP routes. */
  readonly port: number
  readonly summary: Summary
  readonly summaryJob: { readonly jobId: string; readonly rolloutId: string }
  readonly chat: OwnChat
  /** A card, in the persona folder, with a greeting. */
  readonly cardId: EntityId
  /** A message queued behind the generating reply. */
  readonly queuedId: string
  readonly editor: OwnEditor
  // --- The recycle bin, the composer, notices
  /** A chat in the bin. */
  readonly binItemId: string
  /** Text recovered from a composer wiped and then sent. */
  readonly recoveredId: string
  /** The composer at the chat's reply, with text in it. */
  readonly composerId: string
  /** Publishes a notice to this party's subscribers, as a finished reply would. */
  readonly notify: (notice: Notice) => void
}

/** A card with an avatar, a note and an unsaved draft. */
interface OwnEditor {
  readonly cardRefId: RefId
  readonly cardEntityId: EntityId
  readonly revisionId: RevisionId
  readonly noteRefId: RefId
  readonly noteEntityId: EntityId
  readonly avatarMediaId: string
  readonly field: string
  readonly draftId: string
  /** A variant of the card, and one of the note, each with an update waiting to be resolved. */
  readonly pendingCardRefId: RefId
  readonly pendingNoteRefId: RefId
}

/** A chat with the user's message and a model reply still generating under it, and a note of its own. */
interface OwnChat {
  readonly chatId: ChatId
  readonly slotId: SlotId
  readonly versionId: VersionId
  readonly replySlotId: SlotId
  readonly rolloutId: string
  readonly generatingId: VersionId
  readonly noteRefId: RefId
  readonly noteEntityId: EntityId
}

class Parties extends Context.Service<
  Parties,
  { readonly alice: Party; readonly bob: Party; readonly reader: Reader["Service"]; readonly writer: Writer["Service"] }
>()("test/isolation/Parties") {}

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
  GetSummary: { probe: (actor, owner) => refused(actor.api.GetSummary({ summaryId: owner.summary.id }), "NotFound") },
  EditSummary: {
    probe: (actor, owner) =>
      refused(
        actor.api.EditSummary({
          summaryId: owner.summary.id,
          content: "planted",
          expectedRowVersion: 1,
          commitDraft: null
        }),
        "NotFound"
      )
  },
  SelectSummaryRevision: {
    probe: (actor, owner) =>
      refused(
        actor.api.SelectSummaryRevision({
          summaryId: owner.summary.id,
          revisionId: owner.summary.revisionId,
          expectedRowVersion: 1
        }),
        "NotFound"
      )
  },
  GetLcmState: {
    probe: (actor, owner) =>
      refused(actor.api.GetLcmState({ chatId: owner.chat.chatId, leafSlotId: owner.chat.slotId }), "NotFound")
  },
  GetLcmCoverage: {
    probe: (actor, owner) =>
      refused(
        actor.api.GetLcmCoverage({
          chatId: owner.chat.chatId,
          leafSlotId: owner.chat.slotId,
          fromDepth: 0,
          toDepth: 10
        }),
        "NotFound"
      )
  },
  ListSummaryRevisions: {
    probe: (actor, owner) => refused(actor.api.ListSummaryRevisions({ summaryId: owner.summary.id }), "NotFound")
  },
  SetSummaryRerun: {
    probe: (actor, owner) =>
      Effect.all([
        refused(
          actor.api.SetSummaryRerun({
            chatId: owner.chat.chatId,
            target: { _tag: "Summary", summaryId: owner.summary.id },
            requested: true
          }),
          "NotFound"
        ),
        refused(
          actor.api.SetSummaryRerun({
            chatId: owner.chat.chatId,
            target: { _tag: "Job", jobId: owner.summaryJob.jobId },
            requested: true
          }),
          "NotFound"
        ),
        // Their own chat with the other's summary: still nothing.
        refused(
          actor.api.SetSummaryRerun({
            chatId: actor.chat.chatId,
            target: { _tag: "Summary", summaryId: owner.summary.id },
            requested: true
          }),
          "NotFound"
        )
      ]).pipe(Effect.asVoid)
  },
  SetLcmEnabled: {
    probe: (actor, owner) => refused(actor.api.SetLcmEnabled({ chatId: owner.chat.chatId, enabled: false }), "NotFound")
  },
  GetLcmEnableOffer: {
    probe: (actor, owner) =>
      refused(actor.api.GetLcmEnableOffer({ chatId: owner.chat.chatId, leafSlotId: owner.chat.slotId }), "NotFound")
  },
  EnableLcm: {
    probe: (actor, owner) =>
      Effect.all([
        refused(
          actor.api.EnableLcm({ chatId: owner.chat.chatId, leafSlotId: owner.chat.slotId, choice: "scratch" }),
          "NotFound"
        ),
        refused(
          actor.api.EnableLcm({ chatId: owner.chat.chatId, leafSlotId: owner.chat.slotId, choice: "adopt" }),
          "NotFound"
        ),
        // Their own chat with the other's leaf: still nothing.
        refused(
          actor.api.EnableLcm({ chatId: actor.chat.chatId, leafSlotId: owner.chat.slotId, choice: "scratch" }),
          "NotFound"
        )
      ]).pipe(Effect.asVoid)
  },
  GetLcmBackfill: {
    probe: (actor, owner) =>
      refused(actor.api.GetLcmBackfill({ chatId: owner.chat.chatId, leafSlotId: owner.chat.slotId }), "NotFound")
  },
  SetLcmBackfill: {
    probe: (actor, owner) =>
      Effect.all(
        (["pause", "continue", "summarizeNow"] as const).map((action) =>
          refused(
            actor.api.SetLcmBackfill({ chatId: owner.chat.chatId, leafSlotId: owner.chat.slotId, action }),
            "NotFound"
          )
        )
      ).pipe(Effect.asVoid)
  },
  GetSummaryDraft: {
    probe: (actor, owner) => refused(actor.api.GetSummaryDraft({ summaryId: owner.summary.id }), "NotFound")
  },
  SaveSummaryDraft: {
    probe: (actor, owner) =>
      refused(
        actor.api.SaveSummaryDraft({
          summaryId: owner.summary.id,
          draftId: null,
          content: "planted",
          expectedRowVersion: null,
          expectedSession: null,
          baseRevisionId: null
        }),
        "NotFound"
      )
  },
  SummaryDraftHistory: {
    probe: (actor, owner) =>
      refused(actor.api.SummaryDraftHistory({ summaryId: owner.summary.id, limit: 10 }), "NotFound")
  },
  RestoreSummaryDraft: {
    probe: (actor, owner) =>
      refused(
        actor.api.RestoreSummaryDraft({
          summaryId: owner.summary.id,
          draftId: "none",
          seq: 0,
          expectedRowVersion: 1
        }),
        "NotFound"
      )
  },
  DiscardSummaryDraft: {
    probe: (actor, owner) =>
      refused(
        actor.api.DiscardSummaryDraft({ summaryId: owner.summary.id, draftId: "none", expectedRowVersion: 1 }),
        "NotFound"
      )
  },
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
  // --- Generation
  GetGenerationDefaults: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const mine = { model: { connection: owner.connectionId, model: owner.modelId }, preset: owner.refId }
        const set = yield* owner.api.SetGenerationDefaults({ defaults: mine })
        assert.deepStrictEqual({ model: set.model, preset: set.preset }, mine)
        const theirs = yield* actor.api.GetGenerationDefaults()
        assert.notStrictEqual(theirs.model?.model, owner.modelId)
        assert.notStrictEqual(theirs.preset, owner.refId)
      })
  },
  SetGenerationDefaults: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const before = yield* owner.api.GetGenerationDefaults()
        yield* refused(
          actor.api.SetGenerationDefaults({
            defaults: { model: { connection: owner.connectionId, model: owner.modelId }, preset: null }
          }),
          "NotFound"
        )
        yield* refused(actor.api.SetGenerationDefaults({ defaults: { model: null, preset: owner.refId } }), "NotFound")
        // Another user's model on the caller's own connection is no better.
        yield* refused(
          actor.api.SetGenerationDefaults({
            defaults: { model: { connection: actor.connectionId, model: owner.modelId }, preset: null }
          }),
          "NotFound"
        )
        assert.deepStrictEqual(yield* owner.api.GetGenerationDefaults(), before)
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
  GetNextContext: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        yield* refused(
          actor.api.GetNextContext({ chatId: owner.chat.chatId, leafSlotId: owner.chat.slotId }),
          "NotFound"
        )
        yield* refused(
          actor.api.GetNextContext({ chatId: actor.chat.chatId, leafSlotId: owner.chat.slotId }),
          "NotFound"
        )
        const own = yield* owner.api.GetNextContext({ chatId: owner.chat.chatId, leafSlotId: owner.chat.slotId })
        assert.strictEqual(own.leafSlotId, owner.chat.slotId)
        assert.deepStrictEqual(Object.keys(own).sort(), [
          "budget",
          "historyStart",
          "leafSlotId",
          "summarizedThrough",
          "warmth"
        ])
        if (own.historyStart) assert.deepStrictEqual(Object.keys(own.historyStart).sort(), ["depth", "slotId"])
      })
  },
  SubscribeChat: {
    probe: (actor, owner) =>
      refused(actor.api.SubscribeChat({ chatId: owner.chat.chatId }).pipe(Stream.runHead), "NotFound")
  },
  // --- The request inspector (inspectorApi.ts).
  GetRunContext: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        yield* refused(actor.api.GetRunContext({ versionId: owner.chat.generatingId }), "NotFound")
        const own = yield* owner.api.GetRunContext({ versionId: owner.chat.generatingId })
        assert.strictEqual(own.chatId, owner.chat.chatId)
        assert.strictEqual(own.messages[0]?.role, "developer")
        assert.strictEqual(own.messages[0]?.content, "Synthetic SDK instruction")
        assert.notInclude(JSON.stringify(own), "server-only-digest")
        assert.notInclude(JSON.stringify(own), '"digest"')
        assert.strictEqual(own.requests.length, 1)
        for (const request of own.requests) {
          assert.deepStrictEqual(Object.keys(request).sort(), ["id", "status", "counts", "usageSource", "cost"].sort())
        }
      })
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
        for (const active of [true, false])
          yield* refused(
            actor.api.ChangeCast({
              chatId: actor.chat.chatId,
              slotId: null,
              change: { _tag: "Lorebook", ref: owner.loreRefId, active }
            }),
            "NotFound"
          )
        // Their chat's note, or their card's, turned on in the actor's own chat.
        for (const note of [owner.chat.noteEntityId, owner.editor.noteEntityId]) {
          yield* refused(
            actor.api.ChangeCast({
              chatId: actor.chat.chatId,
              slotId: null,
              change: { _tag: "Note", entityId: note, active: true }
            }),
            "NotFound"
          )
        }
      })
  },
  ListChatNotes: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        yield* refused(actor.api.ListChatNotes({ chatId: owner.chat.chatId, slotId: null }), "NotFound")
        yield* refused(
          actor.api.ListChatNotes({ chatId: actor.chat.chatId, slotId: owner.chat.replySlotId }),
          "NotFound"
        )
      })
  },
  CreateChatNote: {
    probe: (actor, owner) =>
      refused(actor.api.CreateChatNote({ chatId: owner.chat.chatId, title: "Planted" }), "NotFound")
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
  ListFolder: { adminOnly: (actor) => refused(actor.api.ListFolder({ path: null }), "Forbidden") },
  ScanStFolder: { adminOnly: (actor) => refused(actor.api.ScanStFolder({ path: "/" }), "Forbidden") },
  ImportStFolderFile: {
    adminOnly: (actor, owner) =>
      Effect.gen(function* () {
        const { importId } = yield* owner.api.StartStImport({ unsupported: [] })
        yield* refused(
          actor.api.ImportStFolderFile({
            importId,
            root: "/",
            path: "settings.json",
            size: 0,
            modifiedMs: 0,
            start: 0,
            part: 0,
            card: null,
            orphan: false
          }),
          "Forbidden"
        )
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
      Effect.gen(function* () {
        yield* refused(
          actor.api.SaveEditorDraft({
            draftId: null,
            expectedSession: null,
            refId: owner.editor.cardRefId,
            field: owner.editor.field,
            content: "planted",
            expectedRowVersion: null,
            baseRevisionId: null
          }),
          "NotFound"
        )
        for (const foreign of [
          { draftId: owner.editor.draftId, expectedRowVersion: 1, expectedSession: 1, baseRevisionId: null },
          {
            draftId: null,
            expectedRowVersion: null,
            expectedSession: null,
            baseRevisionId: (yield* owner.api.OpenEditor({ refId: owner.editor.cardRefId })).ref.headRevisionId
          }
        ])
          yield* refused(
            actor.api.SaveEditorDraft({
              refId: actor.editor.cardRefId,
              field: actor.editor.field,
              content: "planted",
              ...foreign
            }),
            "NotFound"
          )
      })
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
      Effect.gen(function* () {
        const mine = yield* actor.api.OpenEditor({ refId: actor.editor.cardRefId })
        for (const refId of [owner.editor.cardRefId, actor.editor.cardRefId])
          yield* refused(
            actor.api.RestoreEditorDraft({
              refId,
              field: owner.editor.field,
              draftId: owner.editor.draftId,
              seq: 0,
              expectedRowVersion: mine.drafts.find((d) => d.key.field === actor.editor.field)!.rowVersion
            }),
            "NotFound"
          )
      })
  },
  DiscardEditorDraft: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const mine = yield* actor.api.OpenEditor({ refId: actor.editor.cardRefId })
        for (const refId of [owner.editor.cardRefId, actor.editor.cardRefId])
          yield* refused(
            actor.api.DiscardEditorDraft({
              refId,
              field: owner.editor.field,
              draftId: owner.editor.draftId,
              expectedRowVersion: mine.drafts.find((d) => d.key.field === actor.editor.field)!.rowVersion
            }),
            "NotFound"
          )
      })
  },
  CommitEditorDrafts: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const theirs = yield* owner.api.OpenEditor({ refId: owner.editor.cardRefId })
        const mine = yield* actor.api.OpenEditor({ refId: actor.editor.cardRefId })
        for (const target of [theirs, mine])
          yield* refused(
            actor.api.CommitEditorDrafts({
              refId: target.ref.id,
              expectedRowVersion: target.ref.rowVersion,
              fields: [
                {
                  field: actor.editor.field,
                  draftId: owner.editor.draftId,
                  expectedRowVersion: mine.drafts.find((d) => d.key.field === actor.editor.field)!.rowVersion
                }
              ],
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
      Effect.gen(function* () {
        yield* refused(
          actor.api.ResolveUpdate({
            refId: owner.editor.cardRefId,
            doc: {},
            theirsRevisionId: owner.editor.revisionId,
            expectedRowVersion: 1
          }),
          "NotFound"
        )
        // The owner's file or card named in the actor's own resolution.
        const resolveOwn = (refId: RefId, change: (merged: Record<string, unknown>) => Record<string, unknown>) =>
          Effect.gen(function* () {
            const preview = yield* actor.api.PreviewUpdate({ refId })
            const opened = yield* actor.api.OpenEditor({ refId })
            return yield* refused(
              actor.api.ResolveUpdate({
                refId,
                doc: change(preview.merged),
                theirsRevisionId: preview.theirsRevisionId,
                expectedRowVersion: opened.ref.rowVersion
              }),
              "NotFound"
            )
          })
        const media = owner.editor.avatarMediaId
        yield* resolveOwn(actor.editor.pendingCardRefId, (merged) => ({ ...merged, avatar_media_id: media }))
        yield* resolveOwn(actor.editor.pendingCardRefId, (merged) => ({ ...merged, asset_media_ids: { x: media } }))
        yield* resolveOwn(actor.editor.pendingNoteRefId, (merged) => ({
          ...merged,
          owner: { card: owner.editor.cardEntityId }
        }))
      })
  },
  ListCardNotes: {
    probe: (actor, owner) => refused(actor.api.ListCardNotes({ cardRefId: owner.editor.cardRefId }), "NotFound")
  },
  CreateCardNote: {
    probe: (actor, owner) =>
      refused(actor.api.CreateCardNote({ cardRefId: owner.editor.cardRefId, title: "Planted" }), "NotFound")
  },
  DeleteNote: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        yield* refused(actor.api.DeleteNote({ noteRefId: owner.editor.noteRefId }), "NotFound")
        yield* refused(actor.api.DeleteNote({ noteRefId: owner.chat.noteRefId }), "NotFound")
      })
  },
  // --- Branches, the recycle bin, the composer, notices
  SwitchBranch: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        yield* refused(
          actor.api.SwitchBranch({ chatId: owner.chat.chatId, slotId: owner.chat.slotId, index: 0 }),
          "NotFound"
        )
        // Their slot, from the actor's own chat.
        yield* refused(
          actor.api.SwitchBranch({ chatId: actor.chat.chatId, slotId: owner.chat.slotId, index: 0 }),
          "NotFound"
        )
      })
  },
  ListBin: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const page = { limit: 500, before: null }
        assert.include(
          (yield* owner.api.ListBin(page)).map((i) => i.id),
          owner.binItemId
        )
        assert.notInclude(
          (yield* actor.api.ListBin(page)).map((i) => i.id),
          owner.binItemId
        )
      })
  },
  RestoreBinItem: {
    probe: (actor, owner) => refused(actor.api.RestoreBinItem({ itemId: owner.binItemId }), "NotFound")
  },
  PurgeBinItem: {
    probe: (actor, owner) => refused(actor.api.PurgeBinItem({ itemId: owner.binItemId }), "NotFound")
  },
  ListRecoveredTexts: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const page = { limit: 500, before: null }
        assert.include(
          (yield* owner.api.ListRecoveredTexts(page)).map((t) => t.id),
          owner.recoveredId
        )
        assert.notInclude(
          (yield* actor.api.ListRecoveredTexts(page)).map((t) => t.id),
          owner.recoveredId
        )
      })
  },
  GetRecoveredText: {
    probe: (actor, owner) => refused(actor.api.GetRecoveredText({ id: owner.recoveredId }), "NotFound")
  },
  DeleteRecoveredText: {
    probe: (actor, owner) => refused(actor.api.DeleteRecoveredText({ id: owner.recoveredId }), "NotFound")
  },
  // Last of the bin's: it empties the actor's own bin, which later probes don't need.
  EmptyBin: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const items = yield* actor.api.ListBin({ limit: 500, before: null })
        yield* refused(
          actor.api.EmptyBin({ itemIds: [...items.map((item) => item.id), owner.binItemId] }),
          "BinChanged"
        )
        assert.isAtMost((yield* actor.api.EmptyBin({ itemIds: items.map((item) => item.id) })).purged, 1)
      })
  },
  OpenComposer: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        for (const chatId of [owner.chat.chatId, actor.chat.chatId]) {
          yield* refused(actor.api.OpenComposer({ chatId, tipSlotId: owner.chat.replySlotId }), "NotFound")
        }
        yield* refused(
          actor.api.OpenComposer({
            chatId: actor.chat.chatId,
            tipSlotId: actor.chat.slotId,
            copyFrom: owner.composerId
          }),
          "NotFound"
        )
      })
  },
  SaveComposer: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const planted = {
          next: false,
          operationId: crypto.randomUUID(),
          draftId: owner.composerId,
          rowVersion: 1,
          session: 1,
          content: "planted"
        }
        yield* refused(actor.api.SaveComposer({ chatId: owner.chat.chatId, ...planted }), "NotFound")
        yield* refused(actor.api.SaveComposer({ chatId: actor.chat.chatId, ...planted }), "NotFound")
      })
  },
  ComposerHistory: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        for (const chatId of [owner.chat.chatId, actor.chat.chatId]) {
          yield* refused(actor.api.ComposerHistory({ chatId, draftId: owner.composerId, limit: 10 }), "NotFound")
        }
      })
  },
  RestoreComposer: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        for (const chatId of [owner.chat.chatId, actor.chat.chatId]) {
          yield* refused(
            actor.api.RestoreComposer({ chatId, draftId: owner.composerId, seq: 0, expectedRowVersion: 1 }),
            "NotFound"
          )
        }
      })
  },
  SubscribeNotices: {
    probe: (actor, owner) =>
      Effect.scoped(
        Effect.gen(function* () {
          const mine: Array<Notice> = []
          yield* actor.api.SubscribeNotices().pipe(
            Stream.runForEach((batch) => Effect.sync(() => mine.push(...batch))),
            Effect.forkScoped
          )
          const theirs = yield* owner.api.SubscribeNotices().pipe(Stream.runHead, Effect.forkScoped)
          // Both are registered once a later call on the same socket has its answer.
          yield* Effect.all([actor.api.Whoami(), owner.api.Whoami()])
          owner.notify({
            _tag: "ReplyFinished",
            chatId: owner.chat.chatId,
            slotId: owner.chat.replySlotId,
            versionId: owner.chat.generatingId,
            status: "complete"
          })
          assert.isTrue(Option.isSome(yield* Fiber.join(theirs)))
          // Anything for the actor would have reached their socket before this answer.
          yield* actor.api.Whoami()
          assert.deepStrictEqual(mine, [])
        })
      )
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
  "POST /library/drafts, with composers": (actor, owner) =>
    Effect.gen(function* () {
      const leaving = (chatId: string) =>
        http(
          actor,
          "/library/drafts",
          JSON.stringify({
            drafts: [],
            composers: [
              {
                next: false,
                operationId: crypto.randomUUID(),
                chatId,
                draftId: owner.composerId,
                rowVersion: 1,
                session: 1,
                content: "planted"
              }
            ]
          }),
          "application/json"
        )
      assert.strictEqual((yield* leaving(owner.chat.chatId)).status, 404)
      // Enclosing ownership does not authorize an independently supplied foreign draft id.
      assert.strictEqual((yield* leaving(actor.chat.chatId)).status, 404)
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
  "POST /library/drafts": (actor, owner) =>
    Effect.gen(function* () {
      const draft = {
        draftId: owner.editor.draftId,
        expectedSession: 1,
        refId: owner.editor.cardRefId,
        field: owner.editor.field,
        content: "planted",
        baseRevisionId: null
      }
      for (const expectedRowVersion of [null, 1]) {
        const response = yield* http(
          actor,
          "/library/drafts",
          JSON.stringify({ drafts: [{ ...draft, expectedRowVersion }] }),
          "application/json"
        )
        assert.strictEqual(response.status, 404)
      }
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
      const model = yield* api.AddUserModel({ connectionId: connection.id, key: "m", overrides: { cacheTtlS: 300 } })
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: null }
      })
      // No RPC writes these yet.
      const { ref } = yield* writer.CreateEntity({
        userId: user.id,
        kind: "preset",
        label: "Preset",
        subtitle: "",
        doc: presetDoc(),
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
      const lore = yield* writer.CreateEntity({
        userId: user.id,
        kind: "lorebook",
        label: "Lore",
        subtitle: "",
        doc: docFor("lorebook", "Lore"),
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
      // The reply's context, recorded as generating records it, for the request inspector.
      const { snapshot } = yield* (yield* Reader).AssembleContext({
        userId: user.id,
        chatId: chat.id,
        slotId: reply.entry.slotId,
        versionId: reply.entry.version.id,
        now: Date.now(),
        timeZone: "UTC",
        frozen: null
      })
      const inspectorRollout = uuidv7()
      yield* writer.StartRollout({
        userId: user.id,
        chatId: chat.id,
        slotId: reply.entry.slotId,
        versionId: reply.entry.version.id,
        rolloutId: inspectorRollout,
        leafSlotId: sent.entry.slotId,
        connectionId: connection.id,
        modelId: model.id,
        snapshot,
        issues: [],
        variables: [],
        frozenMessages: []
      })
      yield* writer.RecordSentContext({
        userId: user.id,
        rolloutId: inspectorRollout,
        wire: JSON.stringify({
          display: { model: null, preset: { label: null, scope: "builtin" }, issues: [] },
          messages: [
            {
              role: "developer",
              content: "Synthetic SDK instruction",
              digest: "server-only-digest",
              inputs: [0],
              sources: [],
              breakpoint: null
            }
          ],
          samplers: {}
        })
      })
      yield* writer.OpenLlmRequest({
        userId: user.id,
        request: {
          id: uuidv7() as LlmRequestId,
          connectionId: connection.id,
          modelId: model.id,
          chatId: chat.id,
          rolloutId: inspectorRollout,
          versionId: reply.entry.version.id,
          purpose: "generation",
          api: "openai-completions",
          provider: "openai",
          modelKey: "m",
          startedAt: Date.now()
        }
      })
      const chatNote = yield* api.CreateChatNote({ chatId: chat.id, title: "Scene" })
      const card = yield* writer.CreateEntity({
        userId: user.id,
        kind: "card",
        label: `${user.handle}'s card`,
        subtitle: "",
        doc: cardDoc(`${user.handle} card`, { first_mes: "Hello, {{user}}." }),
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
      const fieldDraft = yield* api.SaveEditorDraft({
        draftId: null,
        expectedSession: null,
        refId: editorCard.id,
        field,
        content: "A lighthouse keeper.",
        expectedRowVersion: null,
        baseRevisionId: null
      })
      const opened = yield* api.OpenEditor({ refId: editorCard.id })
      // Variants with an update to resolve: both sides changed the same field.
      const pending = (refId: RefId, path: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const variant = yield* api.ForkVariant({ refId, label: "Pending", subtitle: "", moveDrafts: false })
          for (const [target, text] of [
            [variant.id, "Mine."],
            [refId, "Theirs."]
          ] as const) {
            const draft = yield* api.SaveEditorDraft({
              draftId: null,
              expectedSession: null,
              refId: target,
              field: textField(path),
              content: text,
              expectedRowVersion: null,
              baseRevisionId: null
            })
            const ref = (yield* api.OpenEditor({ refId: target })).ref
            yield* api.CommitEditorDrafts({
              refId: target,
              expectedRowVersion: ref.rowVersion,
              fields: [{ field: draft.key.field, draftId: draft.id, expectedRowVersion: draft.rowVersion }],
              message: null
            })
          }
          return variant.id
        })
      const pendingCardRefId = yield* pending(editorCard.id, ["personality"])
      const pendingNoteRefId = yield* pending(note.id, ["content"])
      const queued = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: reply.entry.slotId,
        branch: false,
        content: "waiting"
      })
      if (queued._tag !== "Queued") return yield* Effect.die(new Error("the seed message didn't queue"))
      // --- Something in the bin, text recovered from a composer wiped and sent, a composer
      // with text in it.
      const binned = yield* api.CreateChat({ title: "binned" })
      const binItem = yield* api.DeleteChat({ chatId: binned.id })
      const scratch = yield* api.CreateChat({ title: "scratch" })
      const typed = yield* typeInto(api, scratch.id, null, "lost words ".repeat(30))
      const wiped = yield* typeInto(api, scratch.id, null, "x", typed)
      yield* posted(
        api.SendMessage({
          chatId: scratch.id,
          parentSlotId: null,
          branch: false,
          content: "x",
          composer: takenFrom(wiped)
        })
      )
      const [recovered] = yield* api.ListRecoveredTexts({ limit: 1, before: null })
      const composer = yield* typeInto(api, chat.id, reply.entry.slotId, "half typed")
      const notices = yield* Notices
      return {
        binItemId: binItem.id,
        recoveredId: recovered!.id,
        composerId: composer.id,
        notify: (notice: Notice) => notices.publish(user.id, notice),
        cardId: card.entityId,
        queuedId: queued.queued.id,
        api,
        user,
        password,
        summary: yield* completeFixture(config.dataDir, writer, user.id, chat.id, [
          { slotId: sent.entry.slotId, versionId: sent.entry.version.id, amendCount: 0 }
        ]),
        summaryJob: yield* summaryJob(config.dataDir, chat.id, sent.entry.slotId, sent.entry.slotId),
        chat: {
          chatId: chat.id,
          slotId: sent.entry.slotId,
          versionId: sent.entry.version.id,
          replySlotId: reply.entry.slotId,
          generatingId: reply.entry.version.id,
          noteRefId: chatNote.id,
          noteEntityId: chatNote.entityId,
          rolloutId: inspectorRollout
        },
        connectionId: connection.id,
        credentialId: credential.id,
        modelId: model.id,
        refId: ref.id,
        loreRefId: lore.ref.id,
        requestId,
        cookie,
        port,
        editor: {
          cardRefId: editorCard.id,
          cardEntityId: editorCard.entityId,
          pendingCardRefId,
          pendingNoteRefId,
          revisionId: opened.ref.headRevisionId,
          noteRefId: note.id,
          noteEntityId: note.entityId,
          avatarMediaId: opened.doc.avatar_media_id as string,
          field,
          draftId: fieldDraft.id
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
    bob: yield* party(bobApi, yield* bobApi.Whoami(), "bob-password", bobCookie),
    reader: yield* Reader,
    writer
  }
})

/**
 * Storage operations no RPC reaches yet, but that act for a user: the matrix covers AppApi
 * only, so its completeness check can't see them. Each is probed here the same way, until an
 * RPC exposes it and it moves into the matrix.
 */
const storage: Record<
  string,
  (reader: Reader["Service"], actor: Party, owner: Party, writer: Writer["Service"]) => Effect.Effect<void, unknown>
> = {
  StImportDefaultPreset: (_reader, actor, owner, writer) =>
    Effect.gen(function* () {
      const { importId } = yield* owner.api.StartStImport({ unsupported: [] })
      yield* refused(
        writer.StImportDefaultPreset({ userId: actor.user.id, importId, refId: owner.refId }),
        "ImportLeaseLost"
      )
      const mine = yield* actor.api.StartStImport({ unsupported: [] })
      yield* refused(
        writer.StImportDefaultPreset({ userId: actor.user.id, importId: mine.importId, refId: owner.refId }),
        "NotFound"
      )
    }),
  StImportSummarySettings: (_reader, actor, owner, writer) =>
    Effect.gen(function* () {
      const { importId } = yield* owner.api.StartStImport({ unsupported: [] })
      yield* refused(
        writer.StImportSummarySettings({ userId: actor.user.id, importId, prompt: "foreign", settings: "{}" }),
        "ImportLeaseLost"
      )
    }),
  SaveLcmMaintenance: (_reader, actor, owner, writer) =>
    refused(
      writer.SaveLcmMaintenance({
        userId: actor.user.id,
        chatId: owner.chat.chatId,
        leafSlotId: owner.chat.slotId,
        pins: JSON.stringify({ signatures: {}, asks: [], explicit: [] })
      }),
      "NotFound"
    ),
  EnqueueSummaries: (_reader, actor, owner, writer) =>
    refused(
      writer.EnqueueSummaries({
        userId: actor.user.id,
        chatId: owner.chat.chatId,
        leafSlotId: owner.chat.slotId,
        chunks: [],
        requestClass: "idle"
      }),
      "NotFound"
    ),
  EnqueueCondensations: (_reader, actor, owner, writer) =>
    refused(
      writer.EnqueueCondensations({
        userId: actor.user.id,
        chatId: owner.chat.chatId,
        leafSlotId: owner.chat.slotId,
        jobs: [],
        requestClass: "idle"
      }),
      "NotFound"
    ),
  MarkVersion: (_reader, actor, owner, writer) =>
    refused(
      writer.MarkVersion({ userId: actor.user.id, versionId: owner.chat.versionId, mark: "refused" }),
      "NotFound"
    ),
  PlanSummaries: (reader, actor, owner) =>
    refused(
      reader.PlanSummaries({ userId: actor.user.id, chatId: owner.chat.chatId, leafSlotId: owner.chat.slotId }),
      "NotFound"
    ),
  AssembleSummary: (reader, actor, owner) =>
    refused(reader.AssembleSummary({ userId: actor.user.id, jobId: owner.summaryJob.jobId, attempt: 0 }), "NotFound"),
  StartSummaryRollout: (_reader, actor, owner, writer) =>
    refused(
      writer.StartSummaryRollout({
        userId: actor.user.id,
        jobId: owner.summaryJob.jobId,
        attempt: 0,
        rolloutId: owner.summaryJob.rolloutId,
        snapshot: "{}"
      }),
      "NotFound"
    ),
  FailSummaryAttempt: (_reader, actor, owner, writer) =>
    refused(
      writer.FailSummaryAttempt({
        userId: actor.user.id,
        jobId: owner.summaryJob.jobId,
        attempt: 0,
        rolloutId: owner.summaryJob.rolloutId,
        error: "planted"
      }),
      "NotFound"
    ),
  ReleaseSummaryJob: (_reader, actor, owner, writer) =>
    refused(writer.ReleaseSummaryJob({ userId: actor.user.id, jobId: owner.summaryJob.jobId, attempt: 0 }), "NotFound"),
  EscalateSummaryJob: (_reader, actor, owner, writer) =>
    refused(writer.EscalateSummaryJob({ userId: actor.user.id, jobId: owner.summaryJob.jobId }), "NotFound"),
  ReconcileSummaryJobs: (_reader, actor, owner, writer) =>
    Effect.gen(function* () {
      const inspect = () =>
        fixtureSql(config.dataDir, [
          { sql: "SELECT * FROM summarization_jobs WHERE id=?", params: [owner.summaryJob.jobId] }
        ])
      const before = yield* inspect()
      assert.strictEqual(before[0]![0]!.status, "processing")
      yield* writer.ReconcileSummaryJobs({ userId: actor.user.id, running: [{ id: actor.summaryJob.jobId, epoch: 0 }] })
      assert.deepStrictEqual(yield* inspect(), before)
    }),
  ClaimSummaryJob: (_reader, actor, _owner, writer) =>
    Effect.gen(function* () {
      const job = yield* writer.ClaimSummaryJob({ userId: actor.user.id })
      assert.isTrue(job === null || job.userId === actor.user.id)
    }),
  CompleteSummary: (_reader, actor, owner, writer) =>
    refused(
      writer.CompleteSummary({
        userId: actor.user.id,
        ...owner.summaryJob,
        content: "planted",
        status: "complete",
        inputs: [{ slotId: owner.chat.slotId, versionId: owner.chat.versionId, amendCount: 0 }],
        children: []
      }),
      "NotFound"
    ),
  GetSummary: (reader, actor, owner) =>
    refused(reader.GetSummary({ userId: actor.user.id, summaryId: owner.summary.id }), "NotFound"),
  EstimateBackfill: (reader, actor, owner) =>
    refused(
      reader.EstimateBackfill({ userId: actor.user.id, chatId: owner.chat.chatId, leafSlotId: owner.chat.slotId }),
      "NotFound"
    ),
  GetBackfill: (reader, actor, owner) =>
    refused(reader.GetBackfill({ userId: actor.user.id, chatId: owner.chat.chatId }), "NotFound"),
  ReadLcmImported: (reader, actor, owner) =>
    refused(
      reader.ReadLcmImported({ userId: actor.user.id, chatId: owner.chat.chatId, leafSlotId: owner.chat.slotId }),
      "NotFound"
    ),
  StageLcmEnable: (_reader, actor, owner, writer) =>
    refused(
      writer.StageLcmEnable({
        userId: actor.user.id,
        chatId: owner.chat.chatId,
        leafSlotId: owner.chat.slotId,
        choice: "scratch",
        approved: { jobs: 1, tokens: 1, cost: null, currency: null },
        imported: null
      }),
      "NotFound"
    ),
  EnableLcm: (_reader, actor, owner, writer) =>
    refused(
      writer.EnableLcm({
        userId: actor.user.id,
        chatId: owner.chat.chatId,
        leafSlotId: owner.chat.slotId,
        choice: "scratch",
        approved: { jobs: 1, tokens: 1, cost: null, currency: null }
      }),
      "NotFound"
    ),
  SetBackfill: (_reader, actor, owner, writer) =>
    refused(writer.SetBackfill({ userId: actor.user.id, chatId: owner.chat.chatId, action: "pause" }), "NotFound"),
  EditSummary: (_reader, actor, owner, writer) =>
    refused(
      writer.EditSummary({
        userId: actor.user.id,
        summaryId: owner.summary.id,
        content: "planted",
        expectedRowVersion: 1,
        commitDraft: null
      }),
      "NotFound"
    ),
  SelectSummaryRevision: (_reader, actor, owner, writer) =>
    refused(
      writer.SelectSummaryRevision({
        userId: actor.user.id,
        summaryId: owner.summary.id,
        revisionId: owner.summary.revisionId,
        expectedRowVersion: 1
      }),
      "NotFound"
    ),
  RecordSentContext: (_reader, actor, owner, writer) =>
    Effect.gen(function* () {
      yield* refused(
        writer.RecordSentContext({
          userId: actor.user.id,
          rolloutId: owner.chat.rolloutId,
          wire: JSON.stringify({ messages: [], samplers: {} })
        }),
        "NotFound"
      )
      const run = yield* owner.api.GetRunContext({ versionId: owner.chat.generatingId })
      assert.strictEqual(run.messages[0]?.content, "Synthetic SDK instruction")
    }),
  // Rebuilding a context from its pins (ARCHITECTURE §15): another user's snapshot, as is, rebuilds nothing.
  RebuildContext: (reader, actor, owner) =>
    Effect.gen(function* () {
      const { snapshot } = yield* reader.AssembleContext({
        userId: owner.user.id,
        chatId: owner.chat.chatId,
        slotId: owner.chat.replySlotId,
        versionId: owner.chat.generatingId,
        now: Date.now(),
        timeZone: "UTC",
        frozen: null
      })
      yield* refused(reader.RebuildContext({ userId: actor.user.id, snapshot }), "NotFound")
      const rebuilt = yield* reader.RebuildContext({ userId: owner.user.id, snapshot })
      assert.ok(rebuilt._tag === "Rebuilt")
      assert.deepStrictEqual(JSON.parse(rebuilt.snapshot), JSON.parse(snapshot))
    }),
  // The cache-warmth estimate, which the chat's subscription pushes only to its owner.
  CacheWarmth: (reader, actor, owner) =>
    Effect.gen(function* () {
      yield* refused(reader.CacheWarmth({ userId: actor.user.id, chatId: owner.chat.chatId }), "NotFound")
      yield* refused(
        reader.CacheWarmth({ userId: actor.user.id, chatId: actor.chat.chatId, leafSlotId: owner.chat.slotId }),
        "NotFound"
      )
      const own = yield* reader.CacheWarmth({ userId: owner.user.id, chatId: owner.chat.chatId })
      assert.isNotNull(own.historyStart)
      assert.strictEqual(own.leafSlotId, owner.chat.replySlotId)
      assert.isNotNull(own.warmth)
      assert.strictEqual(own.warmth!.expiresAt, own.warmth!.lastRequestAt + 300_000)
    })
}

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
    outcome(owner.api.GetSummary({ summaryId: owner.summary.id }), JSON.stringify),
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
    outcome(owner.api.ListChatNotes({ chatId: owner.chat.chatId, slotId: null }), JSON.stringify),
    outcome(owner.api.ListCards(), JSON.stringify),
    outcome(owner.api.OpenEditor({ refId: owner.editor.cardRefId }), JSON.stringify),
    outcome(owner.api.ListRevisions({ refId: owner.editor.cardRefId, limit: 100 }), JSON.stringify),
    outcome(owner.api.ListCardNotes({ cardRefId: owner.editor.cardRefId }), JSON.stringify),
    outcome(owner.api.ListLibrary({ kind: "card" }), JSON.stringify),
    outcome(owner.api.ListBin({ limit: 500, before: null }), JSON.stringify),
    outcome(owner.api.ListRecoveredTexts({ limit: 500, before: null }), JSON.stringify),
    outcome(owner.api.OpenComposer({ chatId: owner.chat.chatId, tipSlotId: owner.chat.replySlotId }), JSON.stringify)
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
  for (const [tag, probe] of Object.entries(storage)) {
    const ways = [
      ["bob on alice's (an admin's)", (p: Parties["Service"]) => p.bob, (p: Parties["Service"]) => p.alice],
      ["alice (an admin) on bob's", (p: Parties["Service"]) => p.alice, (p: Parties["Service"]) => p.bob]
    ] as const
    for (const [way, actor, owner] of ways) {
      it.effect(`${tag} (storage): ${way}`, () =>
        Effect.flatMap(Parties, (p) => run((a, o) => probe(p.reader, a, o, p.writer), actor, owner))
      )
    }
  }
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
