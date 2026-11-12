import { docHash } from "../src/db/documents.ts"
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
import { AppApi, type AppRpcs } from "@rp/shared/api.ts"
import { BUILTIN_PRESET_LABEL } from "@rp/shared/generation.ts"
import { type ChatId, type EntityId, type ForkId, NewVersion, type SlotId, type VersionId } from "@rp/shared/chat.ts"
import type { User } from "@rp/shared/domain.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import type { ConnectionSettings, ConnectionId, CredentialId, ModelId } from "@rp/shared/providers.ts"
import type { RefId, RevisionId } from "@rp/shared/library.ts"
import { textField, valueField } from "@rp/shared/editing.ts"
import type { LlmRequestId } from "@rp/shared/usage.ts"
import { Context, Effect, Fiber, Layer, Option, Stream } from "effect"
import type { Rpc } from "effect/rpc"
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

/** A global regex script of the owner's, which no one else's list may show. */
const ownerScript = {
  id: "owner-script",
  name: "Owner's script",
  find_regex: "/secret/g",
  replace_string: "",
  trim_strings: [],
  placement: [2],
  disabled: false,
  markdown_only: false,
  prompt_only: false,
  run_on_edit: false,
  substitute_regex: "none" as const,
  min_depth: null,
  max_depth: null
}

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
  readonly importRecordId: string
  readonly summaryJob: { readonly jobId: string; readonly rolloutId: string }
  readonly chat: OwnChat
  /** A chat with one message and nothing generating in it. */
  readonly quiet: { readonly chatId: ChatId; readonly slotId: SlotId }
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
  /** A shared named note, which the card's note links to. */
  readonly sharedRefId: RefId
  readonly sharedEntityId: EntityId
}

/** A chat with the user's message and a model reply still generating under it, and a note of its own. */
interface OwnChat {
  readonly chatId: ChatId
  /** Its current fork, the one its messages are in. */
  readonly forkId: ForkId
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

/** A search for the lorebook every party has, named "Lore". */
const LORE_SEARCH = {
  find: "Lore",
  replace: "",
  matchCase: true,
  wholeWord: true,
  regex: false,
  preserveCase: false,
  kinds: ["lorebook"] as const
}

/** A replace of the owner's own, in a lorebook of its own: its id. */
const ownerLibraryEdit = (owner: Party) =>
  Effect.gen(function* () {
    const book = yield* owner.api.CreateLorebook({ label: "Isolation tides" })
    const search = { ...LORE_SEARCH, find: "Isolation tides", replace: "Isolation ebb" }
    const preview = yield* owner.api.PreviewLibraryReplace({ search })
    const entry = preview.entries.find((e) => e.refId === book.id)!
    const result = yield* owner.api.ApplyLibraryReplace({
      search,
      choices: [{ refId: entry.refId, stamp: entry.stamp, fields: entry.fields.map((f) => f.field) }]
    })
    return result.editId!
  })

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

const userDraftOf = (owner: Party) =>
  owner.api.SaveUserDraft({
    ownerId: owner.user.id,
    targetId: owner.cardId,
    field: "Instruction",
    content: "Private instruction",
    draftId: null,
    expectedRowVersion: null,
    expectedSession: null
  })

const matrix: { readonly [Tag in Rpc.Tag<AppRpcs>]: Entry } = {
  GetUserDraft: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        yield* userDraftOf(owner)
        yield* refused(
          actor.api.GetUserDraft({ ownerId: owner.user.id, targetId: owner.cardId, field: "Instruction" }),
          "NotFound"
        )
        assert.isNull(
          yield* actor.api.GetUserDraft({ ownerId: actor.user.id, targetId: owner.cardId, field: "Instruction" })
        )
      })
  },
  SaveUserDraft: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const draft = yield* userDraftOf(owner)
        // A queued first save still names the old account even after login switches.
        yield* refused(
          actor.api.SaveUserDraft({
            ownerId: owner.user.id,
            targetId: draft.key.targetId,
            field: draft.key.field,
            content: "Old account's delayed text",
            draftId: null,
            expectedRowVersion: null,
            expectedSession: null
          }),
          "NotFound"
        )
        assert.isNull(
          yield* actor.api.GetUserDraft({
            ownerId: actor.user.id,
            targetId: draft.key.targetId,
            field: draft.key.field
          })
        )

        yield* refused(
          actor.api.SaveUserDraft({
            ownerId: actor.user.id,
            targetId: draft.key.targetId,
            field: draft.key.field,
            content: "Intrusion",
            draftId: draft.id,
            expectedRowVersion: draft.rowVersion,
            expectedSession: draft.session
          }),
          "NotFound"
        )
        assert.strictEqual(
          (yield* owner.api.GetUserDraft({
            ownerId: owner.user.id,
            targetId: draft.key.targetId,
            field: draft.key.field
          }))?.content,
          "Private instruction"
        )
      })
  },
  UserDraftHistory: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        yield* userDraftOf(owner)
        yield* refused(
          actor.api.UserDraftHistory({ ownerId: actor.user.id, targetId: owner.cardId, field: "Instruction" }),
          "NotFound"
        )
      })
  },
  RestoreUserDraft: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const draft = yield* userDraftOf(owner)
        yield* refused(
          actor.api.RestoreUserDraft({
            ownerId: actor.user.id,
            targetId: draft.key.targetId,
            field: draft.key.field,
            draftId: draft.id,
            expectedRowVersion: draft.rowVersion,
            seq: 0
          }),
          "NotFound"
        )
      })
  },
  EndUserDraft: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const draft = yield* userDraftOf(owner)
        yield* refused(
          actor.api.EndUserDraft({
            ownerId: actor.user.id,
            targetId: draft.key.targetId,
            field: draft.key.field,
            draftId: draft.id,
            expectedRowVersion: draft.rowVersion,
            outcome: "committed"
          }),
          "NotFound"
        )
      })
  },
  RenameHistory: {
    probe: (actor, owner) =>
      refused(
        actor.api.RenameHistory({
          entityId: owner.cardId,
          oldName: "Aria",
          newName: "Ari",
          scope: "all",
          chatId: owner.chat.chatId,
          forkId: owner.chat.forkId
        }),
        "NotFound"
      )
  },
  HistoryEditCost: {
    probe: (actor, owner) =>
      refused(
        actor.api.HistoryEditCost({
          chatId: owner.chat.chatId,
          forkId: owner.chat.forkId,
          fromDepth: 0,
          retainedDepth: 0,
          summaryIds: []
        }),
        "NotFound"
      )
  },
  PreviewHistory: {
    probe: (actor, owner) =>
      refused(
        actor.api.PreviewHistory({
          chatId: owner.chat.chatId,
          forkId: owner.chat.forkId,
          search: {
            pairs: [{ find: "hello", replace: "bye" }],
            matchCase: false,
            wholeWord: false,
            regex: false,
            preserveCase: false,
            messages: true,
            swipes: true,
            summaries: true
          }
        }),
        "NotFound"
      )
  },
  ListHistoryEdits: {
    probe: (actor, owner) =>
      refused(actor.api.ListHistoryEdits({ chatId: owner.chat.chatId, forkId: owner.chat.forkId }), "NotFound")
  },
  RenameHistoryTargets: {
    probe: (actor, owner) => refused(actor.api.RenameHistoryTargets({ entityId: owner.cardId }), "NotFound")
  },
  ApplyHistoryEdits: {
    probe: (actor, owner) =>
      refused(
        actor.api.ApplyHistoryEdits({
          title: "Forbidden",
          applications: [{ chatId: owner.chat.chatId, forkId: owner.chat.forkId, edits: [] }]
        }),
        "NotFound"
      )
  },
  UndoHistoryEdit: {
    probe: (actor, owner) =>
      refused(
        actor.api.UndoHistoryEdit({ chatId: owner.chat.chatId, forkId: owner.chat.forkId, changesetId: "missing" }),
        "NotFound"
      )
  },
  GetShellLibrary: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const data = yield* actor.api.GetShellLibrary()
        assert.isFalse(data.forks.some((f) => f.chat.id === owner.chat.chatId))
        assert.isFalse(data.cards.some((c) => c.card.refId === owner.refId))
      })
  },
  GetShellCards: {
    probe: (actor, owner) =>
      Effect.map(actor.api.GetShellCards(), (data) =>
        assert.isFalse([...data.cards, ...data.personas].some((c) => c.card.refId === owner.refId))
      )
  },
  GetShellForks: {
    probe: (actor, owner) =>
      Effect.map(
        actor.api.GetShellForks({
          entity: null,
          chat: owner.chat.chatId,
          chats: [owner.chat.chatId],
          search: "",
          sort: "recent",
          sections: [
            { id: "all", limit: 100 },
            { id: "chats", limit: 100 }
          ]
        }),
        (data) => {
          for (const section of data.sections) assert.strictEqual(section.total, 0)
          assert.deepStrictEqual(data.people, [])
          assert.deepStrictEqual(data.filterCounts, { all: 0, pinned: 0, groups: 0, solo: 0, branches: 0 })
        }
      )
  },
  WatchShellCards: {
    probe: (actor, owner) =>
      actor.api.WatchShellCards().pipe(
        Stream.take(1),
        Stream.runForEach((data) =>
          Effect.sync(() => assert.isFalse([...data.cards, ...data.personas].some((c) => c.card.refId === owner.refId)))
        )
      )
  },
  WatchShellForks: {
    probe: (actor, owner) =>
      actor.api
        .WatchShellForks({
          entity: null,
          chat: owner.chat.chatId,
          search: "",
          sort: "recent",
          sections: [{ id: "all", limit: 100 }]
        })
        .pipe(
          Stream.take(1),
          Stream.runForEach((data) =>
            Effect.sync(() => {
              assert.deepStrictEqual(data.sections[0]!.rows, [])
              assert.deepStrictEqual(data.sections[0]!.order, [])
              assert.strictEqual(data.sections[0]!.total, 0)
              assert.deepStrictEqual(data.people, [])
            })
          )
        )
  },
  SetChatPin: {
    probe: (actor, owner) =>
      refused(actor.api.SetChatPin({ chatId: owner.chat.chatId, leaf: owner.chat.slotId, pinned: true }), "NotFound")
  },
  SetHomePinsCollapsed: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const before = yield* owner.api.GetShellLibrary()
        yield* actor.api.SetHomePinsCollapsed({ collapsed: !before.pinsCollapsed })
        assert.strictEqual((yield* owner.api.GetShellLibrary()).pinsCollapsed, before.pinsCollapsed)
      })
  },
  SetCardFavourite: {
    probe: (actor, owner) =>
      refused(actor.api.SetCardFavourite({ entityId: owner.editor.cardEntityId, favourite: true }), "NotFound")
  },
  GetSummaryRevisionRequest: {
    probe: (actor, owner) =>
      refused(actor.api.GetSummaryRevisionRequest({ revisionId: owner.summary.revisionId }), "NotFound")
  },
  GetSummaryDetails: {
    probe: (actor, owner) => refused(actor.api.GetSummaryDetails({ summaryId: owner.summary.id }), "NotFound")
  },
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
  ChangeLcmSettings: {
    probe: (actor, owner) =>
      Effect.all([
        refused(actor.api.ChangeLcmSettings({ chatId: owner.chat.chatId, change: { recentMax: 30_000 } }), "NotFound"),
        refused(actor.api.ChangeLcmSettings({ chatId: owner.chat.chatId, change: { enabled: false } }), "NotFound")
      ]).pipe(Effect.asVoid)
  },
  GetLcmSettings: {
    probe: (actor, owner) =>
      Effect.all([
        refused(actor.api.GetLcmSettings({ chatId: owner.chat.chatId, leafSlotId: owner.chat.slotId }), "NotFound"),
        refused(actor.api.GetLcmSettings({ chatId: owner.chat.chatId, leafSlotId: null }), "NotFound")
      ]).pipe(Effect.asVoid)
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
  PreviewStSettings: { global: "pure preview of the supplied file; no stored user data is read or changed" },
  ListExportFormats: { global: "the instance's worker exporter registry, with no user documents" },
  ListProviderKinds: { global: "the instance's provider registry, the same for every user" },
  ListProviders: { global: "the instance's provider definitions, the same for every user" },
  GetCostSettings: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const before = yield* actor.api.GetCostSettings()
        const own = yield* owner.api.GetCostSettings()
        yield* owner.api.SetCostSettings({ expectedRevision: own.revision, rules: [] })
        assert.deepStrictEqual(yield* actor.api.GetCostSettings(), before)
      })
  },
  SetCostSettings: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const before = yield* owner.api.GetCostSettings()
        const own = yield* actor.api.GetCostSettings()
        yield* actor.api.SetCostSettings({ expectedRevision: own.revision, rules: [] })
        yield* refused(
          actor.api.SetCostSettings({
            expectedRevision: own.revision + 1,
            rules: [
              {
                id: "foreign",
                name: "Foreign",
                kind: null,
                connectionId: owner.connectionId,
                model: "m",
                upstream: null,
                currency: "USD",
                rates: { input: 1, read: 1, write: 1, writeLong: 1, output: 1 },
                tiers: []
              }
            ]
          }),
          "NotFound"
        )
        assert.deepStrictEqual(yield* owner.api.GetCostSettings(), before)
      })
  },
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
  ListModelUse: {
    probe: (actor, owner) =>
      Effect.map(actor.api.ListModelUse(), (used) =>
        assert.isFalse(used.some((row) => row.modelId === owner.modelId || row.connectionId === owner.connectionId))
      )
  },
  AddUserModel: {
    probe: (actor, owner) =>
      refused(actor.api.AddUserModel({ connectionId: owner.connectionId, key: "planted", overrides: {} }), "NotFound")
  },
  SaveLearnedContext: {
    probe: (actor, owner) =>
      Effect.flatMap(ownModel(owner), () =>
        refused(actor.api.SaveLearnedContext({ modelId: owner.modelId, context: 1 }), "NotFound")
      )
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
  RefreshModelEndpoints: {
    probe: (actor, owner) =>
      refused(actor.api.RefreshModelEndpoints({ modelId: owner.modelId }), "ProviderError:unusable")
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
        assert.notInclude(
          (yield* actor.api.ListLibrary({ kind: "card", withFilterData: true })).map((r) => r.entityId),
          owner.cardId
        )
      })
  },
  // --- Generation
  CountTokens: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        // The owner's chat model never counts another user's text: the caller's own default does.
        yield* owner.api.SetGenerationDefaults({
          defaults: { model: { connection: owner.connectionId, model: owner.modelId }, preset: null }
        })
        const theirs = yield* actor.api.GetGenerationDefaults()
        yield* actor.api.SetGenerationDefaults({ defaults: { ...theirs, model: null } })
        const counted = yield* actor.api.CountTokens({ texts: ["A lamp by the window."] })
        assert.strictEqual(counted.tokenizer.exact, false)
        assert.include(counted.tokenizer.note ?? "", "No model is chosen")
      })
  },
  GetTokenCounting: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        yield* owner.api.SetTokenCounting({ connectionId: owner.connectionId, via: owner.connectionId })
        const mine = (yield* owner.api.GetTokenCounting()).map((choice) => choice.connectionId)
        assert.include(mine, owner.connectionId)
        const theirs = (yield* actor.api.GetTokenCounting()).flatMap((choice) => [choice.connectionId, choice.via])
        assert.notInclude(theirs, owner.connectionId)
      })
  },
  SetTokenCounting: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        yield* refused(
          actor.api.SetTokenCounting({ connectionId: owner.connectionId, via: owner.connectionId }),
          "NotFound"
        )
        // Nor can another user's connection count for one's own: it would send to their provider.
        yield* refused(
          actor.api.SetTokenCounting({ connectionId: actor.connectionId, via: owner.connectionId }),
          "NotFound"
        )
        const theirs = (yield* actor.api.GetTokenCounting()).flatMap((choice) => [choice.connectionId, choice.via])
        assert.notInclude(theirs, owner.connectionId)
      })
  },
  ListDecisionPoints: {
    probe: (actor) =>
      Effect.gen(function* () {
        const points = (yield* actor.api.ListDecisionPoints()).map((point) => point.id)
        assert.deepStrictEqual(points, ["lore", "presence", "next"])
      })
  },
  GetDecisionSettings: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        yield* owner.api.SetDecisionSettings({
          connectionId: owner.connectionId,
          model: owner.modelId,
          points: { lore: { on: true, threshold: 0.7 } }
        })
        assert.include(
          (yield* owner.api.GetDecisionSettings()).map((s) => s.connectionId),
          owner.connectionId
        )
        assert.notInclude(
          (yield* actor.api.GetDecisionSettings()).map((s) => s.connectionId),
          owner.connectionId
        )
      })
  },
  SetDecisionSettings: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        yield* refused(
          actor.api.SetDecisionSettings({ connectionId: owner.connectionId, model: null, points: {} }),
          "NotFound"
        )
        // Nor another user's model on one's own connection.
        yield* refused(
          actor.api.SetDecisionSettings({ connectionId: actor.connectionId, model: owner.modelId, points: {} }),
          "NotFound"
        )
        assert.notInclude(
          (yield* actor.api.GetDecisionSettings()).map((s) => s.connectionId),
          owner.connectionId
        )
      })
  },
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
  ChangeGenerationDefaults: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const before = yield* owner.api.GetGenerationDefaults()
        const theirs = { connection: owner.connectionId, model: owner.modelId }
        yield* refused(actor.api.ChangeGenerationDefaults({ change: { model: theirs } }), "NotFound")
        yield* refused(actor.api.ChangeGenerationDefaults({ change: { preset: owner.refId } }), "NotFound")
        yield* refused(actor.api.ChangeGenerationDefaults({ change: { judge: theirs } }), "NotFound")
        yield* refused(actor.api.ChangeGenerationDefaults({ change: { fallback: theirs } }), "NotFound")
        // Another user's model on the caller's own connection is no better.
        yield* refused(
          actor.api.ChangeGenerationDefaults({
            change: { model: { connection: actor.connectionId, model: owner.modelId } }
          }),
          "NotFound"
        )
        // The caller's own instruction is theirs alone.
        yield* actor.api.ChangeGenerationDefaults({ change: { tail: "Actor's instruction." } })
        assert.deepStrictEqual(yield* owner.api.GetGenerationDefaults(), before)
      })
  },
  LorebookPresets: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        // The owner's preset lists the owner's book; asked by another user, no preset of theirs shows.
        const listed = (presets: ReadonlyArray<{ readonly refId: string }>) => presets.map((p) => p.refId)
        assert.include(listed(yield* owner.api.LorebookPresets({ ref: owner.loreRefId })), owner.refId)
        assert.deepStrictEqual(yield* actor.api.LorebookPresets({ ref: owner.loreRefId }), [])
        assert.notInclude(listed(yield* actor.api.LorebookPresets({ ref: actor.loreRefId })), owner.refId)
      })
  },
  GetGlobalRegex: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        // Probes run each way round, so each run plants a script of its own.
        const planted = { ...ownerScript, id: crypto.randomUUID() }
        const read = yield* owner.api.GetGlobalRegex()
        yield* owner.api.SetGlobalRegex({ scripts: [planted], expectedRevision: read.revision })
        assert.notInclude(
          (yield* actor.api.GetGlobalRegex()).scripts.map((script) => script.id),
          planted.id
        )
      })
  },
  SetGlobalRegex: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const before = yield* owner.api.GetGlobalRegex()
        const mine = yield* actor.api.GetGlobalRegex()
        yield* actor.api.SetGlobalRegex({ scripts: [], expectedRevision: mine.revision })
        assert.deepStrictEqual(yield* owner.api.GetGlobalRegex(), before)
      })
  },
  GetCardPromptUse: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        // The owner's preset, which the owner's chats use, is never what the caller's read names.
        const kept = yield* actor.api.GetGenerationDefaults()
        yield* actor.api.SetGenerationDefaults({ defaults: { model: kept.model, preset: null } })
        yield* owner.api.SetGenerationDefaults({ defaults: { model: null, preset: owner.refId } })
        assert.notStrictEqual((yield* owner.api.GetCardPromptUse()).preset, BUILTIN_PRESET_LABEL)
        assert.strictEqual((yield* actor.api.GetCardPromptUse()).preset, BUILTIN_PRESET_LABEL)
        yield* actor.api.SetGenerationDefaults({ defaults: { model: kept.model, preset: kept.preset } })
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
        // A card's chats: another user's card is as unknown as a missing one, and the
        // owner's own card lists.
        const card = owner.editor.cardEntityId
        yield* refused(actor.api.ListChats({ ...page, entityId: card }), "NotFound")
        yield* refused(actor.api.ListChats({ ...page, entityId: "no-such-card" as EntityId }), "NotFound")
        yield* owner.api.ListChats({ ...page, entityId: card })
        // Searching by the title or a card's name finds only the caller's chats.
        const [chat] = (yield* owner.api.ListChats(page)).filter((c) => c.id === owner.chat.chatId)
        for (const search of [chat!.title, ...(yield* owner.api.ListCards()).map((c) => c.name)].filter(Boolean)) {
          assert.notInclude(
            (yield* actor.api.ListChats({ ...page, search })).map((c) => c.id),
            owner.chat.chatId
          )
        }
      })
  },
  ListChatSummaries: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const chatIds = [owner.chat.chatId]
        assert.lengthOf(yield* owner.api.ListChatSummaries({ chatIds }), 1)
        assert.lengthOf(yield* actor.api.ListChatSummaries({ chatIds }), 0)
      })
  },
  ListRolloutEffects: {
    probe: (actor, owner) => refused(actor.api.ListRolloutEffects({ chatId: owner.chat.chatId }), "NotFound")
  },
  ListWorkshopCapabilities: {
    probe: (actor, owner) => refused(actor.api.ListWorkshopCapabilities({ chatId: owner.chat.chatId }), "NotFound")
  },
  UndoRolloutEffect: {
    probe: (actor, owner) =>
      refused(
        actor.api.UndoRolloutEffect({ rolloutId: owner.chat.rolloutId, toolCallId: "call_1", seq: 0 }),
        "NotFound"
      )
  },
  CreateWorkshop: { createOnly: "creates a workshop and its private defaults for the caller" },
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
        // Someone else's fork, in their chat or one's own.
        for (const chatId of [owner.chat.chatId, mine]) {
          yield* refused(
            actor.api.ReadPath({ chatId, forkId: owner.chat.forkId, leafSlotId: null, range: bottom, limit: 10 }),
            "NotFound"
          )
        }
      })
  },
  ListVersions: {
    probe: (actor, owner) =>
      Effect.all([
        refused(actor.api.ListVersions({ slotId: owner.chat.slotId }), "NotFound"),
        // One's own message as another user's fork shows it.
        refused(actor.api.ListVersions({ slotId: actor.chat.slotId, forkId: owner.chat.forkId }), "NotFound")
      ]).pipe(Effect.asVoid)
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
        // In their fork, from one's own chat, posted or queued.
        for (const parentSlotId of [actor.chat.slotId, actor.chat.replySlotId]) {
          yield* refused(
            actor.api.SendMessage({
              chatId: actor.chat.chatId,
              forkId: owner.chat.forkId,
              parentSlotId,
              branch: true,
              content: "planted"
            }),
            "NotFound"
          )
        }
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
            forkId: owner.chat.forkId,
            parentSlotId: actor.chat.slotId,
            branch: true
          }),
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
      Effect.gen(function* () {
        const theirs = yield* ownSlot(owner)
        yield* refused(
          actor.api.Regenerate({ slotId: owner.chat.slotId, expectedRowVersion: theirs.rowVersion }),
          "NotFound"
        )
        // "Regenerate with…" the other's model, on a message of one's own.
        const mine = yield* ownSlot(actor)
        yield* refused(
          actor.api.Regenerate({
            slotId: actor.chat.slotId,
            expectedRowVersion: mine.rowVersion,
            model: { connection: owner.connectionId, model: owner.modelId }
          }),
          "NotFound"
        )
        // A swipe of one's own message in the other's fork.
        yield* refused(
          actor.api.Regenerate({
            slotId: actor.chat.slotId,
            forkId: owner.chat.forkId,
            expectedRowVersion: mine.rowVersion
          }),
          "NotFound"
        )
      })
  },
  SetVersionFlags: {
    probe: (actor, owner) =>
      Effect.all([
        refused(
          actor.api.SetVersionFlags({ versionId: owner.chat.versionId, starred: true, hidden: true }),
          "NotFound"
        ),
        refused(
          actor.api.SetVersionFlags({ versionId: actor.chat.versionId, forkId: owner.chat.forkId, starred: true }),
          "NotFound"
        )
      ]).pipe(Effect.asVoid)
  },
  ContinueVersion: {
    probe: (actor, owner) =>
      Effect.flatMap(ownSlot(owner), (theirs) =>
        refused(
          actor.api.ContinueVersion({ versionId: owner.chat.versionId, expectedRowVersion: theirs.rowVersion }),
          "NotFound"
        )
      )
  },
  GetExternalMediaPrefs: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const before = yield* actor.api.GetExternalMediaPrefs({})
        yield* owner.api.SetExternalMedia({ target: { _tag: "Default" }, allow: !before.default })
        assert.deepStrictEqual(yield* actor.api.GetExternalMediaPrefs({}), before)
      })
  },
  SetExternalMedia: {
    probe: (actor, owner) =>
      Effect.all([
        refused(actor.api.SetExternalMedia({ target: { _tag: "Card", id: owner.cardId }, allow: true }), "NotFound"),
        refused(
          actor.api.SetExternalMedia({ target: { _tag: "Chat", id: owner.chat.chatId }, allow: true }),
          "NotFound"
        )
      ])
  },
  GetDisplayPrefs: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const before = yield* actor.api.GetDisplayPrefs({})
        const flipped = before.reasoning === "expanded" ? "collapsed" : "expanded"
        yield* owner.api.SetDisplayPrefs({ prefs: { reasoning: flipped, quoteTextColor: "#123456" } })
        assert.deepStrictEqual(yield* actor.api.GetDisplayPrefs({}), before)
      })
  },
  ImpersonationNotice: {
    // It reads only the caller's own current preset, and marks only the caller's notices.
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const theirs = (yield* owner.api.GetGenerationDefaults()).preset
        const answer = yield* actor.api.ImpersonationNotice({})
        if (theirs !== null) assert.notStrictEqual(answer.preset, theirs)
      })
  },
  SetDisplayPrefs: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const before = yield* owner.api.GetDisplayPrefs({})
        const flipped = before.reasoning === "expanded" ? "collapsed" : "expanded"
        yield* actor.api.SetDisplayPrefs({ prefs: { reasoning: flipped, mainTextColor: "#654321" } })
        assert.deepStrictEqual(yield* owner.api.GetDisplayPrefs({}), before)
      })
  },
  Round: {
    probe: (actor, owner) =>
      Effect.all([
        refused(actor.api.Round({ chatId: owner.chat.chatId, forkId: null, action: "continue" }), "NotFound"),
        refused(actor.api.Round({ chatId: owner.chat.chatId, forkId: null, action: "end" }), "NotFound")
      ])
  },
  StopGeneration: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        yield* refused(actor.api.StopGeneration({ versionId: owner.chat.generatingId }), "NotFound")
        // A finished version, which a Stop that lost the race with the finish returns.
        yield* refused(actor.api.StopGeneration({ versionId: owner.chat.versionId }), "NotFound")
      })
  },
  SetImageExcluded: {
    probe: (actor, owner) =>
      Effect.all([
        refused(
          actor.api.SetImageExcluded({ versionId: owner.chat.versionId, mediaId: "m", excluded: true }),
          "NotFound"
        ),
        refused(
          actor.api.SetImageExcluded({
            versionId: actor.chat.versionId,
            mediaId: "m",
            forkId: owner.chat.forkId,
            excluded: true
          }),
          "NotFound"
        )
      ]).pipe(Effect.asVoid)
  },
  SetMessageHidden: {
    probe: (actor, owner) =>
      refused(actor.api.SetMessageHidden({ slotId: owner.chat.slotId, hidden: true }), "NotFound")
  },
  SelectVersion: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const theirs = yield* ownSlot(owner)
        yield* refused(
          actor.api.SelectVersion({
            slotId: owner.chat.slotId,
            versionId: owner.chat.versionId,
            expectedVersionId: theirs.version.id
          }),
          "NotFound"
        )
        const mine = yield* ownSlot(actor)
        yield* refused(
          actor.api.SelectVersion({
            slotId: actor.chat.slotId,
            versionId: owner.chat.versionId,
            expectedVersionId: mine.version.id
          }),
          "NotFound"
        )
        // One's own message, selected in the other's fork.
        yield* refused(
          actor.api.SelectVersion({
            slotId: actor.chat.slotId,
            versionId: mine.version.id,
            forkId: owner.chat.forkId,
            expectedVersionId: mine.version.id
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
  ShowSectionsAsText: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const theirs = yield* ownSlot(owner)
        yield* refused(
          actor.api.ShowSectionsAsText({ versionId: owner.chat.versionId, expectedRowVersion: theirs.rowVersion }),
          "NotFound"
        )
        const mine = yield* ownSlot(actor)
        yield* refused(
          actor.api.ShowSectionsAsText({
            versionId: actor.chat.versionId,
            forkId: owner.chat.forkId,
            expectedRowVersion: mine.rowVersion
          }),
          "NotFound"
        )
      })
  },
  WriteVersion: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const theirs = yield* ownSlot(owner)
        yield* refused(
          actor.api.WriteVersion({
            slotId: owner.chat.slotId,
            content: "planted",
            expectedRowVersion: theirs.rowVersion
          }),
          "NotFound"
        )
        const mine = yield* ownSlot(actor)
        yield* refused(
          actor.api.WriteVersion({
            slotId: actor.chat.slotId,
            forkId: owner.chat.forkId,
            content: "planted",
            expectedRowVersion: mine.rowVersion
          }),
          "NotFound"
        )
      })
  },
  AmendVersion: {
    probe: (actor, owner) =>
      Effect.all([
        refused(
          actor.api.AmendVersion({ versionId: owner.chat.versionId, content: "planted", expectedRowVersion: 1 }),
          "NotFound"
        ),
        refused(
          actor.api.AmendVersion({
            versionId: actor.chat.versionId,
            forkId: owner.chat.forkId,
            content: "planted",
            expectedRowVersion: 1
          }),
          "NotFound"
        )
      ]).pipe(Effect.asVoid)
  },
  ReadMessageVersion: {
    probe: (actor, owner) =>
      Effect.all([
        refused(
          actor.api.ReadMessageVersion({
            chatId: owner.chat.chatId,
            forkId: owner.chat.forkId,
            versionId: owner.chat.versionId
          }),
          "NotFound"
        ),
        refused(
          actor.api.ReadMessageVersion({
            chatId: actor.chat.chatId,
            forkId: actor.chat.forkId,
            versionId: owner.chat.versionId
          }),
          "NotFound"
        ),
        refused(
          actor.api.ReadMessageVersion({
            chatId: actor.chat.chatId,
            forkId: owner.chat.forkId,
            versionId: actor.chat.versionId
          }),
          "NotFound"
        )
      ]).pipe(Effect.asVoid)
  },
  VersionAmendments: {
    probe: (actor, owner) => refused(actor.api.VersionAmendments({ versionId: owner.chat.versionId }), "NotFound")
  },
  RawVersionText: {
    probe: (actor, owner) => refused(actor.api.RawVersionText({ versionId: owner.chat.versionId }), "NotFound")
  },
  RestoreRawText: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const theirs = yield* ownSlot(owner)
        yield* refused(
          actor.api.RestoreRawText({
            slotId: owner.chat.slotId,
            versionId: owner.chat.versionId,
            forkId: owner.chat.forkId,
            expectedRowVersion: theirs.rowVersion
          }),
          "NotFound"
        )
        const mine = yield* ownSlot(actor)
        yield* refused(
          actor.api.RestoreRawText({
            slotId: actor.chat.slotId,
            versionId: owner.chat.versionId,
            expectedRowVersion: mine.rowVersion
          }),
          "NotFound"
        )
      })
  },
  RestoreVersionAmendment: {
    probe: (actor, owner) =>
      refused(
        actor.api.RestoreVersionAmendment({
          versionId: owner.chat.versionId,
          amendmentId: 1,
          forkId: owner.chat.forkId,
          expectedRowVersion: 1
        }),
        "NotFound"
      )
  },
  MessageDraftHistory: {
    probe: (actor, owner) =>
      Effect.all([
        refused(
          actor.api.MessageDraftHistory({ target: { _tag: "Edit", versionId: owner.chat.versionId }, limit: 1000 }),
          "NotFound"
        ),
        refused(
          actor.api.MessageDraftHistory({ target: { _tag: "Write", slotId: owner.chat.slotId }, limit: 1000 }),
          "NotFound"
        )
      ]).pipe(Effect.asVoid)
  },
  GetMessageDraft: {
    probe: (actor, owner) =>
      Effect.all([
        refused(actor.api.GetMessageDraft({ target: { _tag: "Edit", versionId: owner.chat.versionId } }), "NotFound"),
        refused(actor.api.GetMessageDraft({ target: { _tag: "Write", slotId: owner.chat.slotId } }), "NotFound")
      ]).pipe(Effect.asVoid)
  },
  RestoreMessageDraft: {
    probe: (actor, owner) =>
      Effect.all([
        refused(
          actor.api.RestoreMessageDraft({
            target: { _tag: "Edit", versionId: owner.chat.versionId },
            draftId: "none",
            seq: 0,
            expectedRowVersion: 1
          }),
          "NotFound"
        ),
        refused(
          actor.api.RestoreMessageDraft({
            target: { _tag: "Write", slotId: owner.chat.slotId },
            draftId: "none",
            seq: 0,
            expectedRowVersion: 1
          }),
          "NotFound"
        )
      ]).pipe(Effect.asVoid)
  },
  MessageDrafts: {
    probe: (actor, owner) => refused(actor.api.MessageDrafts({ chatId: owner.chat.chatId }), "NotFound")
  },
  SaveMessageDraft: {
    probe: (actor, owner) =>
      Effect.all([
        // The text of a message being inserted in the other's chat, at their message or above
        // the first, and in the actor's own fork of another chat.
        ...[owner.chat.slotId, null].map((anchor) =>
          refused(
            actor.api.SaveMessageDraft({
              target: { _tag: "Insert", chatId: owner.chat.chatId, forkId: owner.chat.forkId, anchor },
              draftId: null,
              content: "planted",
              expectedRowVersion: null,
              expectedSession: null
            }),
            "NotFound"
          )
        ),
        refused(
          actor.api.SaveMessageDraft({
            target: { _tag: "Insert", chatId: owner.chat.chatId, forkId: actor.chat.forkId, anchor: null },
            draftId: null,
            content: "planted",
            expectedRowVersion: null,
            expectedSession: null
          }),
          "NotFound"
        ),
        refused(
          actor.api.SaveMessageDraft({
            target: { _tag: "Queue", chatId: owner.chat.chatId, queuedId: owner.queuedId, rowVersion: 1 },
            draftId: null,
            content: "planted",
            expectedRowVersion: null,
            expectedSession: null
          }),
          "NotFound"
        ),
        refused(
          actor.api.SaveMessageDraft({
            target: { _tag: "Edit", versionId: owner.chat.versionId },
            draftId: null,
            content: "planted",
            expectedRowVersion: null,
            expectedSession: null
          }),
          "NotFound"
        ),
        refused(
          actor.api.SaveMessageDraft({
            target: { _tag: "Write", slotId: owner.chat.slotId },
            draftId: null,
            content: "planted",
            expectedRowVersion: null,
            expectedSession: null
          }),
          "NotFound"
        )
      ]).pipe(Effect.asVoid)
  },
  QueueDraftHistory: {
    probe: (actor, owner) =>
      refused(actor.api.QueueDraftHistory({ chatId: owner.chat.chatId, queuedId: owner.queuedId }), "NotFound")
  },
  RestoreQueueDraft: {
    probe: (actor, owner) =>
      refused(
        actor.api.RestoreQueueDraft({
          chatId: owner.chat.chatId,
          queuedId: owner.queuedId,
          draftId: "none",
          seq: 0,
          expectedRowVersion: 1
        }),
        "NotFound"
      )
  },
  DiscardMessageDraft: {
    probe: (actor, owner) =>
      refused(
        actor.api.DiscardMessageDraft({
          target: { _tag: "Write", slotId: owner.chat.slotId },
          draftId: "none",
          expectedRowVersion: 1
        }),
        "NotFound"
      )
  },
  DeleteChat: { probe: (actor, owner) => refused(actor.api.DeleteChat({ chatId: owner.chat.chatId }), "NotFound") },
  DeleteMessage: {
    probe: (actor, owner) => refused(actor.api.DeleteMessage({ slotId: owner.chat.slotId }), "NotFound")
  },
  InsertMessage: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const theirs = yield* ownSlot(owner)
        for (const body of [
          { _tag: "Write" as const, speaker: null, content: "planted" },
          { _tag: "Generate" as const, speaker: null },
          { _tag: "Duplicate" as const, versionId: theirs.version.id }
        ])
          yield* refused(
            actor.api.InsertMessage({
              chatId: owner.chat.chatId,
              forkId: owner.chat.forkId,
              anchor: owner.chat.slotId,
              expectedRowVersion: theirs.rowVersion,
              body
            }),
            "NotFound"
          )
        // Into the actor's own chat: the other's anchor, the other's version to copy, the other's card.
        const mine = yield* ownSlot(actor)
        const own = { chatId: actor.chat.chatId, forkId: actor.chat.forkId, expectedRowVersion: mine.rowVersion }
        yield* refused(
          actor.api.InsertMessage({
            ...own,
            anchor: owner.chat.slotId,
            body: { _tag: "Write", speaker: null, content: "x" }
          }),
          "NotFound"
        )
        yield* refused(
          actor.api.InsertMessage({
            ...own,
            anchor: actor.chat.slotId,
            body: { _tag: "Duplicate", versionId: owner.chat.versionId }
          }),
          "NotFound"
        )
        yield* refused(
          actor.api.InsertMessage({
            ...own,
            anchor: actor.chat.slotId,
            body: { _tag: "Write", speaker: owner.cardId, content: "x" }
          }),
          "NotFound"
        )
        // Nothing was inserted in the other's chat.
        const after = yield* owner.api.ReadPath({
          chatId: owner.chat.chatId,
          leafSlotId: null,
          range: { _tag: "Bottom" },
          limit: 50
        })
        assert.isFalse(after.entries.some((e) => e.version.content === "planted"))
      })
  },
  RenameChat: {
    probe: (actor, owner) => refused(actor.api.RenameChat({ chatId: owner.chat.chatId, name: "x" }), "NotFound")
  },
  ListBranches: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        yield* refused(actor.api.ListBranches({ slotId: owner.chat.slotId }), "NotFound")
        yield* refused(actor.api.ListBranches({ slotId: actor.chat.slotId, forkId: owner.chat.forkId }), "NotFound")
      })
  },
  PreviewForkNotes: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        yield* refused(
          actor.api.PreviewForkNotes({ chatId: owner.chat.chatId, fromForkId: null, atSlotId: null }),
          "NotFound"
        )
        yield* refused(
          actor.api.PreviewForkNotes({ chatId: actor.chat.chatId, fromForkId: owner.chat.forkId, atSlotId: null }),
          "NotFound"
        )
        yield* refused(
          actor.api.PreviewForkNotes({ chatId: actor.chat.chatId, fromForkId: null, atSlotId: owner.chat.slotId }),
          "NotFound"
        )
      })
  },
  DeleteChatGroup: {
    probe: (actor, owner) =>
      refused(
        actor.api.DeleteChatGroup({
          chatId: owner.chat.chatId,
          forkId: owner.chat.forkId,
          expectedForkIds: [owner.chat.forkId]
        }),
        "NotFound"
      )
  },
  GetSplitChats: {
    probe: (actor, owner) =>
      refused(actor.api.GetSplitChats({ chatId: owner.chat.chatId, forkId: owner.chat.forkId }), "NotFound")
  },
  // Separate contexts' away rows and their Undo (contextsApi.ts).
  GetAwayMarks: {
    probe: (actor, owner) =>
      refused(
        actor.api.GetAwayMarks({ chatId: owner.chat.chatId, forkId: owner.chat.forkId, slotId: owner.chat.slotId }),
        "NotFound"
      )
  },
  UndoAwayMark: {
    probe: (actor, owner) =>
      refused(
        actor.api.UndoAwayMark({ chatId: owner.chat.chatId, forkId: owner.chat.forkId, eventId: "an-event" }),
        "NotFound"
      )
  },
  // Parallel threads (spec/THREADS.md): another user's chat, branch or split is NotFound.
  StartThreads: {
    probe: (actor, owner) =>
      refused(
        actor.api.StartThreads({
          chatId: owner.chat.chatId,
          forkId: owner.chat.forkId,
          slotId: owner.chat.slotId,
          expectedRowVersion: 1,
          threads: [
            { name: null, cast: [], writesAs: null },
            { name: null, cast: [], writesAs: null }
          ]
        }),
        "NotFound"
      )
  },
  ThreadsOf: {
    probe: (actor, owner) =>
      refused(actor.api.ThreadsOf({ chatId: owner.chat.chatId, forkId: owner.chat.forkId }), "NotFound")
  },
  RenameThread: {
    probe: (actor, owner) =>
      refused(
        actor.api.RenameThread({ chatId: owner.chat.chatId, splitId: "a-split", ordinal: 0, name: "x", rowVersion: 1 }),
        "NotFound"
      )
  },
  UndoThreads: {
    probe: (actor, owner) =>
      refused(actor.api.UndoThreads({ chatId: owner.chat.chatId, splitId: "a-split" }), "NotFound")
  },
  // Merging another chat in (spec/CHAT-MERGE.md): neither side may be someone else's chat.
  PreviewChatMerge: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const mine = { chatId: actor.chat.chatId, forkId: actor.chat.forkId }
        const theirs = { chatId: owner.chat.chatId, forkId: owner.chat.forkId }
        for (const [into, source] of [
          [mine, theirs],
          [theirs, mine]
        ] as const)
          yield* refused(actor.api.PreviewChatMerge({ ...into, at: null, source, includeLeftOut: false }), "NotFound")
      })
  },
  MergeChat: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const mine = { chatId: actor.chat.chatId, forkId: actor.chat.forkId }
        const theirs = { chatId: owner.chat.chatId, forkId: owner.chat.forkId }
        for (const [into, source] of [
          [mine, theirs],
          [theirs, mine]
        ] as const)
          yield* refused(
            actor.api.MergeChat({
              ...into,
              at: null,
              source,
              includeLeftOut: false,
              title: "planted",
              framing: null,
              digest: ""
            }),
            "NotFound"
          )
      })
  },
  GetMerge: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const theirs = yield* ownSlot(owner)
        yield* refused(actor.api.GetMerge({ chatId: owner.chat.chatId, slotId: theirs.slotId }), "NotFound")
      })
  },
  MergeMessages: {
    probe: (actor, owner) =>
      refused(actor.api.MergeMessages({ chatId: owner.chat.chatId, mergeId: "none", offset: 0, limit: 10 }), "NotFound")
  },
  SetSplitChat: {
    probe: (actor, owner) => refused(actor.api.SetSplitChat({ forkId: owner.chat.forkId, split: true }), "NotFound")
  },
  ListForks: {
    probe: (actor, owner) => refused(actor.api.ListForks({ chatId: owner.chat.chatId }), "NotFound")
  },
  CreateFork: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        yield* refused(
          actor.api.CreateFork({ chatId: owner.chat.chatId, fromForkId: null, atSlotId: owner.chat.slotId }),
          "NotFound"
        )
        // From their fork, or at their message, in one's own chat.
        yield* refused(
          actor.api.CreateFork({ chatId: actor.chat.chatId, fromForkId: owner.chat.forkId, atSlotId: null }),
          "NotFound"
        )
        yield* refused(
          actor.api.CreateFork({ chatId: actor.chat.chatId, fromForkId: null, atSlotId: owner.chat.slotId }),
          "NotFound"
        )
      })
  },
  NameFork: {
    probe: (actor, owner) => refused(actor.api.NameFork({ forkId: owner.chat.forkId, name: "x" }), "NotFound")
  },
  PinFork: {
    probe: (actor, owner) => refused(actor.api.PinFork({ forkId: owner.chat.forkId, pinned: true }), "NotFound")
  },
  DeleteFork: {
    probe: (actor, owner) => refused(actor.api.DeleteFork({ forkId: owner.chat.forkId }), "NotFound")
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
        yield* refused(
          actor.api.GetNextContext({
            chatId: actor.chat.chatId,
            leafSlotId: actor.chat.slotId,
            forkId: owner.chat.forkId
          }),
          "NotFound"
        )
        // The owner's own read isn't refused: it waits while their reply is written.
        const held = yield* owner.api
          .GetNextContext({ chatId: owner.chat.chatId, leafSlotId: owner.chat.slotId })
          .pipe(Effect.timeoutOption("1 second"))
        assert.isTrue(Option.isNone(held))
        const own = yield* owner.api.GetNextContext({ chatId: owner.quiet.chatId, leafSlotId: owner.quiet.slotId })
        assert.strictEqual(own.leafSlotId, owner.quiet.slotId)
        assert.deepStrictEqual(Object.keys(own).sort(), [
          "assemblyError",
          "assemblyErrorReason",
          "budget",
          "forkId",
          "historyStart",
          "images",
          "leafSlotId",
          "model",
          "preset",
          "presetContext",
          "summarizedThrough",
          "warmth"
        ])
        if (own.presetContext) {
          assert.deepStrictEqual(Object.keys(own.presetContext).sort(), [
            "blocks",
            "cacheAfter",
            "notes",
            "overrides",
            "summary"
          ])
          for (const block of own.presetContext.blocks)
            assert.deepStrictEqual(Object.keys(block).sort(), ["identifier", "labels", "tokens"])
          for (const boundary of own.presetContext.cacheAfter)
            assert.deepStrictEqual(Object.keys(boundary).sort(), ["identifier", "reason"])
        }
        if (own.historyStart) assert.deepStrictEqual(Object.keys(own.historyStart).sort(), ["depth", "slotId"])
        if (own.preset) assert.deepStrictEqual(Object.keys(own.preset).sort(), ["name", "ref", "scope"])
        // The model is the owner's own, named from the owner's connection.
        if (own.model) assert.strictEqual(own.model.connection, owner.connectionId)
      })
  },
  SubscribeChat: {
    probe: (actor, owner) =>
      refused(actor.api.SubscribeChat({ chatId: owner.chat.chatId }).pipe(Stream.runHead), "NotFound")
  },
  // --- The request inspector (inspectorApi.ts).
  GetRolloutSteps: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        yield* refused(actor.api.GetRolloutSteps({ versionId: owner.chat.generatingId }), "NotFound")
        assert.deepStrictEqual(yield* owner.api.GetRolloutSteps({ versionId: owner.chat.generatingId }), [])
      })
  },
  // Resuming another user's reply is refused as if it weren't there; the owner's, which
  // isn't an agent reply, as not resumable.
  ResumeVersion: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const versionId = owner.chat.generatingId
        yield* refused(actor.api.ResumeVersion({ versionId, expectedRowVersion: 0 }), "NotFound")
        yield* refused(owner.api.ResumeVersion({ versionId, expectedRowVersion: 0 }), "NotResumable")
      })
  },
  ResumeFromStep: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const versionId = owner.chat.generatingId
        yield* refused(actor.api.ResumeFromStep({ versionId, step: 0, expectedRowVersion: 0 }), "NotFound")
      })
  },
  GetRunTranscript: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        yield* refused(actor.api.GetRunTranscript({ versionId: owner.chat.generatingId }), "NotFound")
        assert.deepStrictEqual(yield* owner.api.GetRunTranscript({ versionId: owner.chat.generatingId }), {
          tools: [],
          entries: [],
          cut: []
        })
      })
  },
  // The registered modes and tools: the same for everyone, nobody's data.
  ListReplyTools: {
    probe: (actor) =>
      Effect.gen(function* () {
        const modes = yield* actor.api.ListReplyTools({})
        assert.isArray(modes.tools)
        assert.isArray(modes.defaultTools)
      })
  },
  GetAgentPermissions: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        yield* refused(actor.api.GetAgentPermissions({ chatId: owner.chat.chatId, slotId: null }), "NotFound")
        assert.isArray((yield* owner.api.GetAgentPermissions({ chatId: owner.chat.chatId, slotId: null })).cards)
      })
  },
  ListActivity: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        yield* refused(actor.api.ListActivity({ chatId: owner.chat.chatId }), "NotFound")
        assert.isArray((yield* owner.api.ListActivity({ chatId: owner.chat.chatId })).rows)
      })
  },
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
          assert.deepStrictEqual(
            Object.keys(request).sort(),
            [
              "id",
              "estimatedInput",
              "status",
              "startedAt",
              "firstTokenAt",
              "endedAt",
              "counts",
              "usageSource",
              "cost"
            ].sort()
          )
        }
      })
  },
  GetVersionMetrics: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        // Another user's version is left out, as if it had no metrics.
        assert.deepStrictEqual(yield* actor.api.GetVersionMetrics({ versionIds: [owner.chat.generatingId] }), [])
        const own = yield* owner.api.GetVersionMetrics({ versionIds: [owner.chat.generatingId] })
        assert.strictEqual(own.length, 1)
        assert.strictEqual(own[0]!.versionId, owner.chat.generatingId)
        assert.strictEqual(own[0]!.requests, 1)
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
  ListCardUsage: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const own = (yield* owner.api.ListCardUsage()).map((card) => card.entityId)
        assert.include(own, owner.editor.cardEntityId)
        // Personas aren't characters on the grid.
        assert.notInclude(own, owner.cardId)
        const seen = (yield* actor.api.ListCardUsage()).map((card) => card.entityId)
        assert.notInclude(seen, owner.editor.cardEntityId)
        assert.include(seen, actor.editor.cardEntityId)
      })
  },
  ListChatGroups: {
    // The read is scoped by the caller in its query; its rules are in chatGroups.test.ts.
    probe: (actor, owner) =>
      Effect.map(actor.api.ListChatGroups(), (groups) =>
        assert.notInclude(
          groups.map((group) => group.latestChatId),
          owner.chat.chatId
        )
      )
  },
  ListGroupChats: {
    probe: (actor, owner) => refused(actor.api.ListGroupChats({ chatId: owner.chat.chatId }), "NotFound")
  },
  RenameGroup: {
    probe: (actor, owner) => refused(actor.api.RenameGroup({ chatId: owner.chat.chatId, name: "x" }), "NotFound")
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
        // Their card as a greeter.
        yield* refused(
          actor.api.StartChat({
            cards: [actor.cardId],
            persona: null,
            greeting: null,
            greeters: [{ entityId: owner.cardId, greeting: 0 }],
            first: send(null)
          }),
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
  GetCasts: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        yield* refused(actor.api.GetCasts({ chatId: owner.chat.chatId, slotIds: [null] }), "NotFound")
        yield* refused(
          actor.api.GetCasts({ chatId: actor.chat.chatId, slotIds: [null, owner.chat.slotId] }),
          "NotFound"
        )
      })
  },
  ListChatCards: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        yield* refused(
          actor.api.ListChatCards({ chatId: owner.chat.chatId, slotId: null, entityIds: [actor.cardId] }),
          "NotFound"
        )
        yield* refused(
          actor.api.ListChatCards({ chatId: actor.chat.chatId, slotId: owner.chat.slotId, entityIds: [actor.cardId] }),
          "NotFound"
        )
        // Their card named in the actor's own chat is NotFound, as a missing one is.
        yield* refused(
          actor.api.ListChatCards({ chatId: actor.chat.chatId, slotId: null, entityIds: [owner.cardId, actor.cardId] }),
          "NotFound"
        )
        const cards = yield* actor.api.ListChatCards({
          chatId: actor.chat.chatId,
          slotId: null,
          entityIds: [actor.cardId]
        })
        assert.deepStrictEqual(
          cards.map((card) => card.entityId),
          [actor.cardId]
        )
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
        yield* refused(
          actor.api.ChangeCast({
            chatId: actor.chat.chatId,
            slotId: null,
            change: { _tag: "RemoveLorebook", ref: owner.loreRefId }
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
      Effect.gen(function* () {
        yield* refused(actor.api.CreateChatNote({ chatId: owner.chat.chatId, title: "Planted" }), "NotFound")
        // A slot of one's own chat linked to the owner's shared note.
        yield* refused(
          actor.api.CreateChatNote({ chatId: actor.chat.chatId, title: "Planted", link: owner.editor.sharedEntityId }),
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
  ListFolder: { adminOnly: (actor) => refused(actor.api.ListFolder({ path: null }), "Forbidden") },
  ScanStFolder: { adminOnly: (actor) => refused(actor.api.ScanStFolder({ path: "/" }), "Forbidden") },
  StImportPreview: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const paths = [`characters/${owner.user.handle}.png`]
        assert.deepStrictEqual((yield* owner.api.StImportPreview({ paths })).known, paths)
        assert.deepStrictEqual((yield* actor.api.StImportPreview({ paths })).known, [])
        // Naming a folder reads its files: an admin's alone, as ScanStFolder.
        if (actor.user.role !== "admin")
          yield* refused(actor.api.StImportPreview({ paths, folder: { root: "/", prefix: "" } }), "Forbidden")
      })
  },
  StartStPathImport: {
    adminOnly: (actor) => refused(actor.api.StartStPathImport({ path: "/", prefix: "" }), "Forbidden")
  },
  LinkStImportChat: {
    adminOnly: (actor, owner) =>
      Effect.gen(function* () {
        const { importId } = yield* owner.api.StartStImport({ unsupported: [] })
        yield* refused(actor.api.LinkStImportChat({ importId, path: "chats/A/A.jsonl", card: "none" }), "Forbidden")
      })
  },
  FinishStImport: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const { importId } = yield* owner.api.StartStImport({ unsupported: [] })
        yield* refused(actor.api.FinishStImport({ importId, notSent: [] }), "NotFound")
        assert.strictEqual((yield* owner.api.GetStImport({ importId })).job.status, "running")
      })
  },
  ListStImports: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const { importId } = yield* owner.api.StartStImport({ unsupported: [] })
        assert.isFalse((yield* actor.api.ListStImports()).some((job) => job.id === importId))
        assert.isTrue((yield* owner.api.ListStImports()).some((job) => job.id === importId))
      })
  },
  GetStImport: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const { importId } = yield* owner.api.StartStImport({ unsupported: [] })
        yield* refused(actor.api.GetStImport({ importId }), "NotFound")
      })
  },
  SeenStImport: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const { importId } = yield* owner.api.StartStImport({ unsupported: [] })
        yield* owner.api.FinishStImport({ importId, notSent: [] })
        yield* refused(actor.api.SeenStImport({ importId }), "NotFound")
        assert.isFalse((yield* owner.api.GetStImport({ importId })).job.seen)
      })
  },
  CancelStImport: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const { importId } = yield* owner.api.StartStImport({ unsupported: [] })
        yield* refused(actor.api.CancelStImport({ importId }), "NotFound")
        assert.strictEqual((yield* owner.api.GetStImport({ importId })).job.status, "running")
      })
  },
  ClearStImports: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const { importId } = yield* owner.api.StartStImport({ unsupported: [] })
        yield* owner.api.FinishStImport({ importId, notSent: [] })
        assert.strictEqual((yield* actor.api.ClearStImports({ importId })).cleared, 0)
        yield* actor.api.ClearStImports({ importId: null })
        yield* owner.api.GetStImport({ importId })
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
  CreatePreset: { createOnly: "makes a new prompt preset for the caller" },
  CreateLorebook: { createOnly: "makes a new lorebook for the caller" },
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
  EditorDraftState: {
    probe: (actor, owner) =>
      refused(
        actor.api.EditorDraftState({ refId: owner.editor.cardRefId, field: owner.editor.field, seq: 0 }),
        "NotFound"
      )
  },
  RevertEditorDrafts: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        // Another's ref is not found, and its typing stays as it was.
        const before = (yield* owner.api.OpenEditor({ refId: owner.editor.cardRefId })).drafts
        yield* refused(actor.api.RevertEditorDrafts({ refId: owner.editor.cardRefId }), "NotFound")
        const after = (yield* owner.api.OpenEditor({ refId: owner.editor.cardRefId })).drafts
        assert.deepStrictEqual(
          after.map((d) => [d.id, d.rowVersion, d.content]),
          before.map((d) => [d.id, d.rowVersion, d.content])
        )
      })
  },
  SetRevisionMessage: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        // Another's ref, and another's revision through one's own ref, are both not found.
        yield* refused(
          actor.api.SetRevisionMessage({
            refId: owner.editor.cardRefId,
            revisionId: owner.editor.revisionId,
            message: "mine"
          }),
          "NotFound"
        )
        yield* refused(
          actor.api.SetRevisionMessage({
            refId: actor.editor.cardRefId,
            revisionId: owner.editor.revisionId,
            message: "mine"
          }),
          "NotFound"
        )
      })
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
        // A note of one's own whose condition names the owner's card.
        const note = yield* actor.api.OpenEditor({ refId: actor.editor.noteRefId })
        const draft = yield* actor.api.SaveEditorDraft({
          draftId: null,
          expectedSession: null,
          refId: actor.editor.noteRefId,
          field: valueField(["condition"]),
          content: JSON.stringify({ when: "turn", card: owner.editor.cardEntityId }),
          expectedRowVersion: null,
          baseRevisionId: null
        })
        yield* refused(
          actor.api.CommitEditorDrafts({
            refId: actor.editor.noteRefId,
            expectedRowVersion: note.ref.rowVersion,
            fields: [{ field: draft.key.field, draftId: draft.id, expectedRowVersion: draft.rowVersion }],
            message: "planted"
          }),
          "NotFound"
        )
        yield* actor.api.DiscardEditorDraft({
          refId: actor.editor.noteRefId,
          field: draft.key.field,
          draftId: draft.id,
          expectedRowVersion: draft.rowVersion
        })
      })
  },

  ListRevisions: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        yield* refused(actor.api.ListRevisions({ refId: owner.editor.cardRefId, limit: 10 }), "NotFound")
        yield* refused(
          actor.api.ListRevisions({ refId: actor.editor.cardRefId, limit: 10, before: owner.editor.revisionId }),
          "NotFound"
        )
      })
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
  ForkCard: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const before = yield* owner.api.CardFamily({ entityId: owner.editor.cardEntityId })
        yield* refused(
          actor.api.ForkCard({
            refId: owner.editor.cardRefId,
            name: "Taken",
            nickname: "",
            characterVersion: ""
          }),
          "NotFound"
        )
        assert.deepStrictEqual(yield* owner.api.CardFamily({ entityId: owner.editor.cardEntityId }), before)
        const opened = yield* owner.api.OpenEditor({ refId: owner.editor.cardRefId })
        assert.isTrue(opened.drafts.some((d) => d.id === owner.editor.draftId && d.status === "active"))
      })
  },
  ForkCardForChat: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const names = { name: "Taken for chat", nickname: "", characterVersion: "" }
        yield* refused(
          actor.api.ForkCardForChat({
            ...names,
            chatId: owner.chat.chatId,
            slotId: owner.chat.slotId,
            entityId: owner.editor.cardEntityId
          }),
          "NotFound"
        )
        yield* refused(
          actor.api.ForkCardForChat({
            ...names,
            chatId: actor.chat.chatId,
            slotId: actor.chat.slotId,
            entityId: owner.editor.cardEntityId
          }),
          "NotFound"
        )
        yield* refused(
          actor.api.ForkCardForChat({
            ...names,
            chatId: actor.chat.chatId,
            slotId: owner.chat.slotId,
            entityId: actor.editor.cardEntityId
          }),
          "NotFound"
        )
      })
  },
  CardFamily: {
    probe: (actor, owner) => refused(actor.api.CardFamily({ entityId: owner.editor.cardEntityId }), "NotFound")
  },
  CardFamilyIndex: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        // A family of the actor's own: listed for the actor, never for the owner, and the
        // owner's cards never in the actor's list.
        const fork = yield* actor.api.CreateCard({ label: "Index fork", name: "Index fork" })
        yield* actor.api.SetCardParent({ entityId: fork.entityId, parentEntityId: actor.editor.cardEntityId })
        const mine = yield* actor.api.CardFamilyIndex()
        assert.strictEqual(mine.find((card) => card.entityId === actor.editor.cardEntityId)?.forks, 1)
        assert.strictEqual(mine.find((card) => card.entityId === fork.entityId)?.forks, 0)
        assert.isFalse(mine.some((card) => card.entityId === owner.editor.cardEntityId))
        const theirs = new Set<string>([fork.entityId, actor.editor.cardEntityId])
        assert.isFalse((yield* owner.api.CardFamilyIndex()).some((card) => theirs.has(card.entityId)))
        yield* actor.api.SetCardParent({ entityId: fork.entityId, parentEntityId: null })
      })
  },
  SetCardParent: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const before = yield* owner.api.CardFamily({ entityId: owner.editor.cardEntityId })
        const mine = actor.editor.cardEntityId
        const theirs = owner.editor.cardEntityId
        // Their card as my card's parent, mine as theirs', and unlinking theirs.
        yield* refused(actor.api.SetCardParent({ entityId: mine, parentEntityId: theirs }), "NotFound")
        yield* refused(actor.api.SetCardParent({ entityId: theirs, parentEntityId: mine }), "NotFound")
        yield* refused(actor.api.SetCardParent({ entityId: theirs, parentEntityId: null }), "NotFound")
        assert.deepStrictEqual(yield* owner.api.CardFamily({ entityId: theirs }), before)
        assert.strictEqual((yield* actor.api.CardFamily({ entityId: mine })).members.length, 1)
      })
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
  // Card sources: this server registers none, so each names a source no one has. Their
  // per-user namespace (keys, switches, cache, recently viewed) is cardSources.test.ts's,
  // against the fake archive.
  ListCardSources: {
    probe: (actor) => Effect.map(actor.api.ListCardSources(), (list) => assert.lengthOf(list.sources, 0))
  },
  SetCardSourceEnabled: {
    probe: (actor) => refused(actor.api.SetCardSourceEnabled({ sourceId: "cardex", enabled: false }), "NotFound")
  },
  SetCardSourceAdminDisabled: {
    adminOnly: (actor) =>
      refused(actor.api.SetCardSourceAdminDisabled({ sourceId: "cardex", disabled: true }), "Forbidden")
  },
  SetSourceCacheCap: {
    adminOnly: (actor) => refused(actor.api.SetSourceCacheCap({ bytes: 1024 ** 3 }), "Forbidden")
  },
  SetCardSourceKey: {
    probe: (actor) => refused(actor.api.SetCardSourceKey({ sourceId: "cardex", key: "k" }), "NotFound")
  },
  SetCardSourceRating: {
    probe: (actor) => refused(actor.api.SetCardSourceRating({ sourceId: "cardex", rating: null }), "NotFound")
  },
  ClearSourceCache: { probe: (actor) => Effect.asVoid(actor.api.ClearSourceCache({ sourceId: null })) },
  SourceCapabilities: {
    probe: (actor) => refused(actor.api.SourceCapabilities({ sourceId: "cardex" }), "NotFound")
  },
  SourceSearch: {
    probe: (actor) =>
      refused(
        actor.api.SourceSearch({
          sourceId: "cardex",
          query: { text: "", tags: [], excludeTags: [], filters: {}, sort: null, reverse: false },
          page: null
        }),
        "NotFound"
      )
  },
  SourceSuggestions: {
    probe: (actor) =>
      refused(
        actor.api.SourceSuggestions({ sourceId: "cardex", kind: "creators", prefix: "f", page: null }),
        "NotFound"
      )
  },
  SourceTags: { probe: (actor) => refused(actor.api.SourceTags({ sourceId: "cardex", prefix: "f" }), "NotFound") },
  SourceCard: { probe: (actor) => refused(actor.api.SourceCard({ sourceId: "cardex", remoteId: "x" }), "NotFound") },
  SourceCardForChat: {
    probe: (actor) => refused(actor.api.SourceCardForChat({ sourceId: "cardex", remoteId: "x" }), "NotFound")
  },
  AdoptRemoteCard: {
    probe: (actor) => refused(actor.api.AdoptRemoteCard({ sourceId: "cardex", remoteId: "x" }), "NotFound")
  },
  // A card source's origin of another user's card is never shown or changed (cardSources.test.ts
  // checks it with a card added from the fake archive).
  CardOrigin: {
    probe: (actor, owner) =>
      Effect.map(actor.api.CardOrigin({ entityId: owner.cardId }), (origin) => assert.isNull(origin))
  },
  CheckRemoteVersion: {
    probe: (actor, owner) => refused(actor.api.CheckRemoteVersion({ entityId: owner.cardId }), "NotFound")
  },
  TakeRemoteVersion: {
    probe: (actor, owner) => refused(actor.api.TakeRemoteVersion({ entityId: owner.cardId, version: "v" }), "NotFound")
  },
  AddRemoteVersionAsCard: {
    probe: (actor, owner) => refused(actor.api.AddRemoteVersionAsCard({ entityId: owner.cardId }), "NotFound")
  },
  ListRecentRemote: {
    probe: (actor) => Effect.map(actor.api.ListRecentRemote({ sourceId: "cardex" }), (list) => assert.lengthOf(list, 0))
  },
  ClearRecentRemote: { probe: (actor) => Effect.asVoid(actor.api.ClearRecentRemote({ sourceId: "cardex" })) },
  SearchMessages: {
    // Both quiet chats say "hi": each finds its own message, never the other's.
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const own = yield* owner.api.SearchMessages({ text: "hi", cursor: null })
        assert.isTrue(own.hits.some((h) => h.chatId === owner.quiet.chatId))
        const page = yield* actor.api.SearchMessages({ text: "hi", cursor: null })
        assert.isTrue(page.hits.some((h) => h.chatId === actor.quiet.chatId))
        assert.isFalse(page.hits.some((h) => h.chatId === owner.quiet.chatId || h.chatId === owner.chat.chatId))
      })
  },
  PreviewLibraryReplace: {
    // Both have a lorebook named "Lore": each finds its own, never the other's.
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const search = { ...LORE_SEARCH, replace: "Lore" }
        const own = yield* owner.api.PreviewLibraryReplace({ search })
        assert.isTrue(own.entries.some((e) => e.refId === owner.loreRefId))
        const theirs = yield* actor.api.PreviewLibraryReplace({ search })
        assert.isTrue(theirs.entries.some((e) => e.refId === actor.loreRefId))
        assert.isFalse(theirs.entries.some((e) => e.refId === owner.loreRefId))
      })
  },
  ApplyLibraryReplace: {
    // The owner's lorebook, with the owner's own stamp: left as it is.
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const search = { ...LORE_SEARCH, replace: "Taken" }
        const own = yield* owner.api.PreviewLibraryReplace({ search })
        const entry = own.entries.find((e) => e.refId === owner.loreRefId)!
        const result = yield* actor.api.ApplyLibraryReplace({
          search,
          choices: [{ refId: entry.refId, stamp: entry.stamp, fields: entry.fields.map((f) => f.field) }]
        })
        assert.strictEqual(result.entries, 0)
        assert.isNull(result.editId)
        const after = yield* owner.api.PreviewLibraryReplace({ search })
        assert.strictEqual(after.entries.find((e) => e.refId === owner.loreRefId)?.stamp, entry.stamp)
      })
  },
  ListLibraryEdits: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const editId = yield* ownerLibraryEdit(owner)
        assert.isTrue((yield* owner.api.ListLibraryEdits()).some((e) => e.id === editId))
        assert.isFalse((yield* actor.api.ListLibraryEdits()).some((e) => e.id === editId))
      })
  },
  UndoLibraryEdit: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const editId = yield* ownerLibraryEdit(owner)
        yield* refused(actor.api.UndoLibraryEdit({ editId }), "NotFound")
        const listed = (yield* owner.api.ListLibraryEdits()).find((e) => e.id === editId)
        assert.strictEqual(listed?.undone, 0)
      })
  },
  ListArchiveCandidates: {
    probe: (actor, owner) =>
      Effect.map(actor.api.ListArchiveCandidates({ criteria: { never: 1, inactive: 1 } }), (cards) =>
        assert.isFalse(cards.some((c) => c.entityId === owner.cardId))
      )
  },
  ArchiveUnusedCards: {
    probe: (actor, owner) =>
      Effect.map(actor.api.ArchiveUnusedCards({ criteria: { never: 1 }, entityIds: [owner.cardId] }), (receipt) =>
        assert.lengthOf(receipt.entityIds, 0)
      )
  },
  UndoCardArchive: {
    probe: (actor, owner) =>
      Effect.map(actor.api.UndoCardArchive({ entityIds: [owner.cardId], archivedAt: 1 }), (count) =>
        assert.strictEqual(count, 0)
      )
  },
  SetRefArchived: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        yield* refused(actor.api.SetRefArchived({ refId: owner.refId, archived: true }), "NotFound")
        const archived = yield* owner.api.ListLibrary({ kind: "preset", archived: true })
        assert.isFalse(archived.some((ref) => ref.id === owner.refId))
      })
  },
  SetRegexApproval: {
    probe: (actor, owner) =>
      refused(actor.api.SetRegexApproval({ refId: owner.refId, approved: true, expectedRowVersion: 1 }), "NotFound")
  },
  SetHtmlApproval: {
    probe: (actor, owner) =>
      refused(actor.api.SetHtmlApproval({ refId: owner.editor.cardRefId, scripts: true, network: true }), "NotFound")
  },
  GetCardGallery: {
    probe: (actor, owner) => refused(actor.api.GetCardGallery({ refId: owner.editor.cardRefId }), "NotFound")
  },
  ChangeCardAsset: {
    probe: (actor, owner) =>
      refused(
        actor.api.ChangeCardAsset({
          refId: owner.editor.cardRefId,
          uri: "embeded://foreign.png",
          expectedRowVersion: 1,
          change: { action: "remove" }
        }),
        "NotFound"
      )
  },
  SetCardAvatarCrop: {
    probe: (actor, owner) =>
      refused(
        actor.api.SetCardAvatarCrop({
          refId: owner.editor.cardRefId,
          crop: { x: 0, y: 0, width: 0.5, height: 0.5 },
          expectedRowVersion: 1
        }),
        "NotFound"
      )
  },
  ForkMergeStatus: {
    probe: (actor, owner) => refused(actor.api.ForkMergeStatus({ refId: owner.editor.cardRefId }), "NotFound")
  },
  PreviewForkMerge: {
    probe: (actor, owner) => refused(actor.api.PreviewForkMerge({ refId: owner.editor.cardRefId }), "NotFound")
  },
  LibraryGenealogy: {
    probe: (actor, owner) => refused(actor.api.LibraryGenealogy({ refId: owner.editor.cardRefId }), "NotFound")
  },
  CommitForkMerge: {
    probe: (actor, owner) =>
      refused(
        actor.api.CommitForkMerge({
          refId: owner.editor.cardRefId,
          theirsRevisionId: owner.editor.revisionId,
          baseRevisionId: null,
          expectedRowVersion: 1,
          selection: { excluded: [], resolutions: [] },
          message: null
        }),
        "NotFound"
      )
  },
  UndoForkMerge: {
    probe: (actor, owner) =>
      refused(
        actor.api.UndoForkMerge({
          refId: owner.editor.cardRefId,
          mergeRevisionId: owner.editor.revisionId,
          expectedRowVersion: 1
        }),
        "NotFound"
      )
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
        yield* resolveOwn(actor.editor.pendingNoteRefId, (merged) => ({
          ...merged,
          condition: { when: "not_muted", card: owner.editor.cardEntityId }
        }))
        yield* resolveOwn(actor.editor.pendingNoteRefId, (merged) => ({ ...merged, link: owner.editor.sharedEntityId }))
      })
  },
  ListCardNotes: {
    probe: (actor, owner) => refused(actor.api.ListCardNotes({ cardRefId: owner.editor.cardRefId }), "NotFound")
  },
  CreateCardNote: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        yield* refused(
          actor.api.CreateCardNote({
            cardRefId: actor.editor.cardRefId,
            title: "Planted",
            chatNote: { chatId: owner.chat.chatId, forkId: owner.chat.forkId, slotId: owner.chat.slotId }
          }),
          "NotFound"
        )
        yield* refused(actor.api.CreateCardNote({ cardRefId: owner.editor.cardRefId, title: "Planted" }), "NotFound")
        yield* refused(
          actor.api.CreateCardNote({
            cardRefId: actor.editor.cardRefId,
            title: "Planted",
            link: owner.editor.sharedEntityId
          }),
          "NotFound"
        )
      })
  },
  ListSnippets: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        yield* refused(actor.api.ListSnippets({ chatId: owner.chat.chatId }), "NotFound")
        const mine = yield* actor.api.ListSnippets({ chatId: null })
        assert.isFalse(mine.some((n) => n.ref.id === owner.editor.sharedRefId))
      })
  },
  CreateSnippet: {
    probe: (actor, owner) =>
      refused(actor.api.CreateSnippet({ chatId: owner.chat.chatId, title: "Taken", content: "Planted" }), "NotFound")
  },
  SetSnippetScope: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        yield* refused(
          actor.api.SetSnippetScope({ chatId: null, refId: owner.editor.sharedRefId, global: true }),
          "NotFound"
        )
        yield* refused(
          actor.api.SetSnippetScope({ chatId: owner.chat.chatId, refId: owner.editor.sharedRefId, global: false }),
          "NotFound"
        )
      })
  },
  ListSharedNotes: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* actor.api.ListSharedNotes({ refId: owner.editor.sharedRefId }), [])
        const mine = yield* actor.api.ListSharedNotes({})
        assert.isFalse(mine.some((note) => note.ref.id === owner.editor.sharedRefId))
      })
  },
  CreateSharedNote: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        // From the owner's card note, and from the owner's chat note at a position in their chat.
        yield* refused(
          actor.api.CreateSharedNote({ title: "Taken", content: "", fromNoteRefId: owner.editor.noteRefId }),
          "NotFound"
        )
        yield* refused(
          actor.api.CreateSharedNote({
            title: "Taken",
            content: "",
            fromNoteRefId: owner.chat.noteRefId,
            chatNote: { chatId: owner.chat.chatId, slotId: owner.chat.slotId }
          }),
          "NotFound"
        )
        // One's own chat note, at a position in the owner's chat.
        yield* refused(
          actor.api.CreateSharedNote({
            title: "Taken",
            content: "",
            fromNoteRefId: actor.chat.noteRefId,
            chatNote: { chatId: owner.chat.chatId, slotId: owner.chat.slotId }
          }),
          "NotFound"
        )
      })
  },
  UnlinkNote: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        yield* refused(actor.api.UnlinkNote({ noteRefId: owner.editor.noteRefId }), "NotFound")
        yield* refused(
          actor.api.UnlinkNote({
            noteRefId: owner.chat.noteRefId,
            chatNote: { chatId: owner.chat.chatId, slotId: owner.chat.slotId }
          }),
          "NotFound"
        )
      })
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
        // Their slot, or their fork as the one shown, from the actor's own chat.
        yield* refused(
          actor.api.SwitchBranch({ chatId: actor.chat.chatId, slotId: owner.chat.slotId, index: 0 }),
          "NotFound"
        )
        yield* refused(
          actor.api.SwitchBranch({
            chatId: actor.chat.chatId,
            slotId: actor.chat.slotId,
            index: 0,
            forkId: owner.chat.forkId
          }),
          "NotFound"
        )
      })
  },
  // Another user's items name no forks, even ones that show them.
  BinItemForks: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* actor.api.BinItemForks({ itemIds: [owner.binItemId] }), [])
      })
  },
  // Nor any branches.
  BinItemBranches: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* actor.api.BinItemBranches({ itemIds: [owner.binItemId] }), [])
      })
  },
  GetBinLimits: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const original = yield* owner.api.GetBinLimits()
        yield* actor.api.ChangeBinLimit({ key: "deletedItems", value: 17 })
        assert.strictEqual((yield* actor.api.GetBinLimits()).deletedItems, 17)
        assert.deepStrictEqual(yield* owner.api.GetBinLimits(), original)
      })
  },
  ChangeBinLimit: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        const original = yield* owner.api.GetBinLimits()
        yield* actor.api.ChangeBinLimit({ key: "recoveredBytes", value: 12345 })
        assert.strictEqual((yield* actor.api.GetBinLimits()).recoveredBytes, 12345)
        assert.deepStrictEqual(yield* owner.api.GetBinLimits(), original)
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
        yield* refused(actor.api.OpenComposer({ chatId: owner.chat.chatId, forkId: null }), "NotFound")
        for (const chatId of [owner.chat.chatId, actor.chat.chatId]) {
          yield* refused(actor.api.OpenComposer({ chatId, forkId: owner.chat.forkId }), "NotFound")
        }
        yield* refused(
          actor.api.OpenComposer({
            chatId: actor.chat.chatId,
            forkId: actor.chat.forkId,
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
  GetComposerImages: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        for (const chatId of [owner.chat.chatId, actor.chat.chatId])
          yield* refused(actor.api.GetComposerImages({ chatId, draftId: owner.composerId, ids: [] }), "NotFound")
      })
  },
  SetComposerImage: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        for (const chatId of [owner.chat.chatId, actor.chat.chatId])
          yield* refused(
            actor.api.SetComposerImage({
              chatId,
              draftId: owner.composerId,
              id: "foreign-image-draft",
              mediaId: null,
              altText: ""
            }),
            "NotFound"
          )
      })
  },
  GetComposerChoice: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        for (const chatId of [owner.chat.chatId, actor.chat.chatId]) {
          yield* refused(actor.api.GetComposerChoice({ chatId, draftId: owner.composerId }), "NotFound")
        }
      })
  },
  SetComposerChoice: {
    probe: (actor, owner) =>
      Effect.gen(function* () {
        for (const chatId of [owner.chat.chatId, actor.chat.chatId]) {
          yield* refused(
            actor.api.SetComposerChoice({ chatId, draftId: owner.composerId, speakerEntityId: actor.cardId }),
            "NotFound"
          )
        }
        // Their own composer can't name the owner's card.
        for (const field of ["speakerEntityId", "replyFromEntityId", "consumeReplyFromEntityId"] as const) {
          yield* refused(
            actor.api.SetComposerChoice({
              chatId: actor.chat.chatId,
              draftId: actor.composerId,
              [field]: owner.cardId
            }),
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
            Stream.runForEach((batch) =>
              Effect.sync(() => mine.push(...batch.filter((notice) => notice._tag !== "UserDraftSync")))
            ),
            Effect.forkScoped
          )
          const theirs = yield* owner.api.SubscribeNotices().pipe(
            Stream.filter((batch) => batch.some((notice) => notice._tag !== "UserDraftSync")),
            Stream.runHead,
            Effect.forkScoped
          )
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
  "GET /media/external": (actor, owner) =>
    Effect.gen(function* () {
      const port = actor.port
      for (const scope of [{ chat: owner.chat.chatId }, { card: owner.cardId }]) {
        const response = yield* Effect.promise(() =>
          fetch(
            `http://127.0.0.1:${port}/media/external?${new URLSearchParams({ url: "https://media.invalid/a.png", ...scope })}`,
            { headers: { cookie: actor.cookie, "sec-fetch-site": "same-origin" } }
          )
        )
        assert.strictEqual(response.status, 404)
      }
    }),
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
  "POST /library/drafts, with user drafts": (actor, owner) =>
    Effect.gen(function* () {
      const response = yield* http(
        actor,
        "/library/drafts",
        JSON.stringify({
          drafts: [],
          userDrafts: [
            {
              ownerId: owner.user.id,
              targetId: "connection:new",
              field: "Settings",
              content: "Old account's closing text",
              draftId: null,
              expectedRowVersion: null,
              expectedSession: null
            }
          ]
        }),
        "application/json"
      )
      assert.strictEqual(response.status, 404)
      assert.isNull(
        yield* actor.api.GetUserDraft({ ownerId: actor.user.id, targetId: "connection:new", field: "Settings" })
      )
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
  "POST /library/drafts, with summaries": (actor, owner) =>
    Effect.gen(function* () {
      const before = yield* owner.api.GetSummaryDraft({ summaryId: owner.summary.id })
      const response = yield* http(
        actor,
        "/library/drafts",
        JSON.stringify({
          drafts: [],
          summaries: [
            {
              summaryId: owner.summary.id,
              draftId: null,
              content: "planted",
              expectedRowVersion: null,
              expectedSession: null,
              baseRevisionId: owner.summary.revisionId
            }
          ]
        }),
        "application/json"
      )
      assert.strictEqual(response.status, 404)
      assert.deepStrictEqual(yield* owner.api.GetSummaryDraft({ summaryId: owner.summary.id }), before)
    }),
  "POST /library/drafts, with messages": (actor, owner) =>
    Effect.gen(function* () {
      const before = yield* owner.api.MessageDrafts({ chatId: owner.chat.chatId })
      for (const target of [
        { _tag: "Edit", versionId: owner.chat.versionId },
        { _tag: "Write", slotId: owner.chat.slotId },
        { _tag: "Queue", chatId: owner.chat.chatId, queuedId: owner.queuedId, rowVersion: 1 }
      ]) {
        const response = yield* http(
          actor,
          "/library/drafts",
          JSON.stringify({
            drafts: [],
            messages: [{ target, draftId: null, content: "planted", expectedRowVersion: null, expectedSession: null }]
          }),
          "application/json"
        )
        assert.strictEqual(response.status, 404)
      }
      assert.deepStrictEqual(yield* owner.api.MessageDrafts({ chatId: owner.chat.chatId }), before)
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
  "POST /library/gallery": (actor, owner) =>
    Effect.gen(function* () {
      const response = yield* http(
        actor,
        `/library/gallery?ref=${owner.editor.cardRefId}&rowVersion=1&name=Foreign`,
        avatarFile(actor.user.handle),
        "application/octet-stream"
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
      // The preset lists the user's lorebook (`LorebookPresets`).
      const { ref } = yield* writer.CreateEntity({
        userId: user.id,
        kind: "preset",
        label: "Preset",
        subtitle: "",
        doc: { ...presetDoc(), lorebooks: [{ id: lore.ref.id, enabled: true }] },
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
      const quiet = yield* api.CreateChat({ title: `${user.handle}'s quiet chat` })
      const quietSent = yield* posted(
        api.SendMessage({ chatId: quiet.id, parentSlotId: null, branch: false, content: "hi", reply: false })
      )
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
        // As an ST import records its file, for StImportPreview's probe.
        sourcePath: `characters/${user.handle}.png`
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
      const shared = yield* api.CreateSharedNote({ title: "Rain", content: "It is raining." })
      yield* api.CreateCardNote({ cardRefId: editorCard.id, title: "Weather", link: shared.entityId })
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
      // Cards merge only their own import line; notes still exercise ref following.
      const pendingCard = yield* api.CreateCard({ label: "Pending import", name: "Pending import" })
      const cardSource = (yield* api.OpenEditor({ refId: pendingCard.id })).doc
      const importCard = (personality: string) =>
        writer.ImportFile({
          userId: user.id,
          intoRefId: pendingCard.id,
          kind: "card",
          label: "",
          schemaVersion: 1,
          docJson: JSON.stringify({ ...cardSource, personality }),
          docHash: docHash({ ...cardSource, personality }),
          searchText: "",
          sourceName: "synthetic.json",
          sourceHash: "0".repeat(64),
          media: [],
          noteDocJson: null
        })
      yield* importCard("")
      const cardDraft = yield* api.SaveEditorDraft({
        refId: pendingCard.id,
        field: textField(["personality"]),
        draftId: null,
        expectedSession: null,
        content: "Mine.",
        expectedRowVersion: null,
        baseRevisionId: null
      })
      const cardRef = (yield* api.OpenEditor({ refId: pendingCard.id })).ref
      yield* api.CommitEditorDrafts({
        refId: pendingCard.id,
        expectedRowVersion: cardRef.rowVersion,
        fields: [{ field: cardDraft.key.field, draftId: cardDraft.id, expectedRowVersion: cardDraft.rowVersion }],
        message: null
      })
      yield* importCard("Theirs.")
      const pendingCardRefId = pendingCard.id
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
      const composer = yield* typeInto(api, chat.id, null, "half typed")
      // Import records create forks; seed them before the probes' no-mutation snapshots.
      const { importId } = yield* api.StartStImport({ unsupported: [] })
      const importRecord = yield* writer.StImportStartChat({
        userId: user.id,
        source: `chats/Isolation/${user.id}.jsonl`,
        title: "Synthetic import",
        createdAt: 1730000000000,
        chatId: chat.id,
        lease: importId
      })
      const notices = yield* Notices
      return {
        importRecordId: importRecord.recordId,
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
          forkId: reply.chat.currentForkId!,
          slotId: sent.entry.slotId,
          versionId: sent.entry.version.id,
          replySlotId: reply.entry.slotId,
          generatingId: reply.entry.version.id,
          noteRefId: chatNote.id,
          noteEntityId: chatNote.entityId,
          rolloutId: inspectorRollout
        },
        quiet: { chatId: quiet.id, slotId: quietSent.entry.slotId },
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
          sharedRefId: shared.id,
          sharedEntityId: shared.entityId,
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
  CheckExternalMedia: (reader, actor, owner) =>
    Effect.all([
      refused(
        reader.CheckExternalMedia({ userId: actor.user.id, chatId: owner.chat.chatId, cardId: null }),
        "NotFound"
      ),
      refused(reader.CheckExternalMedia({ userId: actor.user.id, chatId: null, cardId: owner.cardId }), "NotFound")
    ]).pipe(Effect.asVoid),
  AddCardAsset: (_reader, actor, owner, writer) =>
    refused(
      writer.AddCardAsset({
        userId: actor.user.id,
        refId: owner.editor.cardRefId,
        expectedRowVersion: 1,
        name: "Foreign",
        media: { role: "asset", uri: "", sha256: "0".repeat(64), mime: "image/png", byteSize: 10, width: 1, height: 1 }
      }),
      "NotFound"
    ),
  RenameChats: (_reader, actor, owner, writer) =>
    refused(
      writer.RenameChats({
        userId: actor.user.id,
        chats: [{ chatId: owner.chat.chatId, from: null }],
        name: "foreign"
      }),
      "NotFound"
    ),
  SetForkName: (_reader, actor, owner, writer) =>
    refused(writer.SetForkName({ userId: actor.user.id, forkId: owner.chat.forkId, name: "foreign" }), "NotFound"),
  SetForkPinned: (_reader, actor, owner, writer) =>
    refused(writer.SetForkPinned({ userId: actor.user.id, forkId: owner.chat.forkId, pinned: true }), "NotFound"),
  PreviewForkNotes: (reader, actor, owner) =>
    Effect.gen(function* () {
      yield* refused(
        reader.PreviewForkNotes({ userId: actor.user.id, chatId: owner.chat.chatId, fromForkId: null, atSlotId: null }),
        "NotFound"
      )
      yield* refused(
        reader.PreviewForkNotes({
          userId: actor.user.id,
          chatId: actor.chat.chatId,
          fromForkId: owner.chat.forkId,
          atSlotId: null
        }),
        "NotFound"
      )
      yield* refused(
        reader.PreviewForkNotes({
          userId: actor.user.id,
          chatId: actor.chat.chatId,
          fromForkId: null,
          atSlotId: owner.chat.slotId
        }),
        "NotFound"
      )
    }),
  DeleteChatGroup: (_reader, actor, owner, writer) =>
    refused(
      writer.DeleteChatGroup({
        userId: actor.user.id,
        chatId: owner.chat.chatId,
        forkId: owner.chat.forkId,
        expectedForkIds: [owner.chat.forkId],
        title: "Foreign"
      }),
      "NotFound"
    ),
  AwayMarks: (reader, actor, owner) =>
    refused(
      reader.AwayMarks({
        userId: actor.user.id,
        chatId: owner.chat.chatId,
        forkId: owner.chat.forkId,
        slotId: owner.chat.slotId
      }),
      "NotFound"
    ),
  GetSplitChats: (reader, actor, owner) =>
    refused(
      reader.GetSplitChats({ userId: actor.user.id, chatId: owner.chat.chatId, forkId: owner.chat.forkId }),
      "NotFound"
    ),
  ListForks: (reader, actor, owner) =>
    refused(reader.ListForks({ userId: actor.user.id, chatId: owner.chat.chatId }), "NotFound"),
  GetPath: (reader, actor, owner) =>
    Effect.gen(function* () {
      for (const chatId of [owner.chat.chatId, actor.chat.chatId])
        yield* refused(
          reader.GetPath({ userId: actor.user.id, chatId, forkId: owner.chat.forkId, leafSlotId: null, limit: 10 }),
          "NotFound"
        )
    }),
  CreateFork: (_reader, actor, owner, writer) =>
    Effect.gen(function* () {
      yield* refused(
        writer.CreateFork({ userId: actor.user.id, chatId: owner.chat.chatId, fromForkId: null, atSlotId: null }),
        "NotFound"
      )
      yield* refused(
        writer.CreateFork({
          userId: actor.user.id,
          chatId: actor.chat.chatId,
          fromForkId: owner.chat.forkId,
          atSlotId: null
        }),
        "NotFound"
      )
    }),
  SwitchBranch: (_reader, actor, owner, writer) =>
    refused(
      writer.SwitchBranch({
        userId: actor.user.id,
        chatId: actor.chat.chatId,
        slotId: actor.chat.slotId,
        index: 0,
        forkId: owner.chat.forkId
      }),
      "NotFound"
    ),
  AppendMessage: (_reader, actor, owner, writer) =>
    refused(
      writer.AppendMessage({
        userId: actor.user.id,
        chatId: actor.chat.chatId,
        forkId: owner.chat.forkId,
        parentSlotId: null,
        branch: true,
        version: new NewVersion({
          speakerEntityId: null,
          writer: "human",
          content: "planted",
          status: "complete",
          macroMode: "verbatim",
          origin: "user_written"
        }),
        commitDraft: null
      }),
      "NotFound"
    ),
  ListBranches: (reader, actor, owner) =>
    refused(reader.ListBranches({ userId: actor.user.id, slotId: owner.chat.slotId }), "NotFound"),
  // A fork named for a read or a write of one's own chat must be one of its forks.
  GetSlot: (reader, actor, owner) =>
    Effect.gen(function* () {
      yield* refused(reader.GetSlot({ userId: actor.user.id, slotId: owner.chat.slotId }), "NotFound")
      yield* refused(
        reader.GetSlot({ userId: actor.user.id, slotId: actor.chat.slotId, forkId: owner.chat.forkId }),
        "NotFound"
      )
    }),
  StateEventsAt: (reader, actor, owner) =>
    refused(
      reader.StateEventsAt({
        userId: actor.user.id,
        chatId: actor.chat.chatId,
        slotId: actor.chat.slotId,
        forkId: owner.chat.forkId
      }),
      "NotFound"
    ),
  AddVersion: (_reader, actor, owner, writer) =>
    refused(
      writer.AddVersion({
        userId: actor.user.id,
        slotId: actor.chat.slotId,
        forkId: owner.chat.forkId,
        version: new NewVersion({
          speakerEntityId: null,
          writer: "human",
          content: "planted",
          status: "complete",
          macroMode: "verbatim",
          origin: "user_written"
        }),
        select: true,
        commitDraft: null
      }),
      "NotFound"
    ),
  AssembleContext: (reader, actor, owner) =>
    refused(
      reader.AssembleContext({
        userId: actor.user.id,
        chatId: actor.chat.chatId,
        slotId: actor.chat.slotId,
        versionId: actor.chat.versionId,
        forkId: owner.chat.forkId,
        now: 0,
        timeZone: "UTC",
        frozen: null
      }),
      "NotFound"
    ),
  StImportDefaultPersona: (_reader, actor, owner, writer) =>
    Effect.gen(function* () {
      const { importId } = yield* owner.api.StartStImport({ unsupported: [] })
      yield* refused(
        writer.StImportDefaultPersona({ userId: actor.user.id, importId, entityId: owner.cardId }),
        "ImportLeaseLost"
      )
      const mine = yield* actor.api.StartStImport({ unsupported: [] })
      yield* refused(
        writer.StImportDefaultPersona({ userId: actor.user.id, importId: mine.importId, entityId: owner.cardId }),
        "NotFound"
      )
    }),
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
  StImportClaim: (_reader, actor, owner, writer) =>
    Effect.gen(function* () {
      const mine = yield* actor.api.StartStImport({ unsupported: [] })
      yield* refused(
        writer.StImportClaim({
          userId: actor.user.id,
          recordId: actor.importRecordId,
          lease: mine.importId,
          parentRecordId: owner.importRecordId
        }),
        "NotFound"
      )
      yield* refused(
        writer.StImportClaim({
          userId: actor.user.id,
          recordId: owner.importRecordId,
          lease: mine.importId
        }),
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
  GetSummaryRevisionRequest: (reader, actor, owner) =>
    refused(
      reader.GetSummaryRevisionRequest({ userId: actor.user.id, revisionId: owner.summary.revisionId }),
      "NotFound"
    ),
  GetSummaryDetails: (reader, actor, owner) =>
    refused(reader.GetSummaryDetails({ userId: actor.user.id, summaryId: owner.summary.id }), "NotFound"),
  GetCardImportNote: (reader, actor, owner) =>
    refused(reader.GetCardImportNote({ userId: actor.user.id, cardRefId: owner.editor.cardRefId }), "NotFound"),
  GetSummary: (reader, actor, owner) =>
    refused(reader.GetSummary({ userId: actor.user.id, summaryId: owner.summary.id }), "NotFound"),
  ChangeLcmSettings: (_reader, actor, owner, writer) =>
    refused(
      writer.ChangeLcmSettings({ userId: actor.user.id, chatId: owner.chat.chatId, change: { when: "next-reply" } }),
      "NotFound"
    ),
  LcmSettingsAt: (reader, actor, owner) =>
    Effect.all([
      refused(
        reader.LcmSettingsAt({ userId: actor.user.id, chatId: owner.chat.chatId, leafSlotId: owner.chat.slotId }),
        "NotFound"
      ),
      // The actor's own chat with the owner's leaf reads nothing of the owner's either.
      refused(
        reader.LcmSettingsAt({ userId: actor.user.id, chatId: actor.chat.chatId, leafSlotId: owner.chat.slotId }),
        "NotFound"
      )
    ]).pipe(Effect.asVoid),
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
  ListRolloutEffects: (reader, actor, owner) =>
    refused(reader.ListRolloutEffects({ userId: actor.user.id, chatId: owner.chat.chatId }), "NotFound"),
  RolloutToolReceipt: (reader, actor, owner) =>
    refused(
      reader.RolloutToolReceipt({ userId: actor.user.id, rolloutId: owner.chat.rolloutId, toolCallId: "call_1" }),
      "NotFound"
    ),
  RolloutReceipt: (reader, actor, owner) =>
    Effect.gen(function* () {
      yield* refused(
        reader.RolloutReceipt({ userId: actor.user.id, rolloutId: owner.chat.rolloutId, toolCallId: "call_1" }),
        "NotFound"
      )
      assert.isNull(
        yield* reader.RolloutReceipt({ userId: owner.user.id, rolloutId: owner.chat.rolloutId, toolCallId: "missing" })
      )
    }),
  ApplyRolloutEffect: (_reader, actor, owner, writer) =>
    refused(
      writer.ApplyRolloutEffect({
        userId: actor.user.id,
        rolloutId: owner.chat.rolloutId,
        toolCallId: "call_1",
        events: [],
        result: "Done."
      }),
      "NotFound"
    ),
  PostRolloutMessage: (_reader, actor, owner, writer) =>
    refused(
      writer.PostRolloutMessage({
        userId: actor.user.id,
        rolloutId: owner.chat.rolloutId,
        versionId: owner.chat.generatingId,
        toolCallId: "foreign-send",
        content: "Must not post."
      }),
      "NotFound"
    ),
  SaveRolloutTranscript: (_reader, actor, owner, writer) =>
    refused(
      writer.SaveRolloutTranscript({
        userId: actor.user.id,
        rolloutId: owner.chat.rolloutId,
        transcript: "[]",
        steps: 0
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
      yield* refused(
        reader.CacheWarmth({ userId: actor.user.id, chatId: actor.chat.chatId, forkId: owner.chat.forkId }),
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
    outcome(owner.api.ListSharedNotes({}), JSON.stringify),
    outcome(owner.api.ListLibrary({ kind: "card" }), JSON.stringify),
    outcome(owner.api.GetBinLimits(), JSON.stringify),
    outcome(owner.api.ListBin({ limit: 500, before: null }), JSON.stringify),
    outcome(owner.api.ListRecoveredTexts({ limit: 500, before: null }), JSON.stringify),
    outcome(owner.api.OpenComposer({ chatId: owner.chat.chatId, forkId: owner.chat.forkId }), JSON.stringify),
    // Without the tip's text, which the owner's reply is still streaming into.
    outcome(
      Effect.map(owner.api.ListForks({ chatId: owner.chat.chatId }), (forks) =>
        forks.map(({ tipExcerpt: _, ...fork }) => fork)
      ),
      JSON.stringify
    ),
    outcome(owner.api.GetComposerChoice({ chatId: owner.chat.chatId, draftId: owner.composerId }), JSON.stringify)
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
