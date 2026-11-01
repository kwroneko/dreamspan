// The shell's fork summaries (db/forkSummaries.ts, ARCHITECTURE.md §12): every kind of write
// the walk reads makes its chat's summaries stale, and a read from what was stored equals one
// computed from scratch. Through the real workers.
import { assert, describe, it } from "@effect/vitest"
import { type ForkId, NewVersion, type SlotId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import * as Database from "../src/db/Database.ts"
import type { ShellLibraryRead } from "../src/db/ops.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { cardDoc } from "./support/docs.ts"
import { tempDir } from "./support/tempDir.ts"
import { testWorkers } from "./support/bundles.ts"

const database = () => Database.layer({ dataDir: tempDir("shell"), readers: 2, allowNetworkFs: false, ...testWorkers })

type Read = typeof ShellLibraryRead.Type

/** What the client gets: the read without the summaries it computed. */
const library = ({ fresh: _, ...rest }: Read) => rest

const setup = Effect.gen(function* () {
  const writer = yield* Database.Writer
  const reader = yield* Database.Reader
  const { id: userId } = yield* writer.EnsureUser({ handle: "ana", displayName: "ana" })
  const makeCard = (name: string) =>
    writer.CreateEntity({
      userId,
      kind: "card",
      label: name,
      subtitle: "",
      doc: cardDoc(name),
      schemaVersion: 1,
      origin: "user",
      sourcePath: null
    })
  const mira = yield* makeCard("Mira")
  const tam = yield* makeCard("Tam")
  const newChat = (title: string, participants: ReadonlyArray<typeof mira.entityId>) =>
    writer.CreateChat({ userId, kind: "rp", status: "active", title, participants, greeting: null })
  const harbor = yield* newChat("Harbor", [mira.entityId])
  const other = yield* newChat("Other", [tam.entityId])
  const version = (content: string, speaker: typeof mira.entityId | null) =>
    new NewVersion({
      speakerEntityId: speaker,
      writer: speaker === null ? "human" : "model",
      content,
      status: "complete",
      macroMode: "verbatim",
      origin: speaker === null ? "user_written" : "generated"
    })
  const append = (
    chatId: typeof harbor.id,
    parentSlotId: SlotId | null,
    content: string,
    speaker: typeof mira.entityId | null = mira.entityId,
    forkId?: ForkId
  ) =>
    writer.AppendMessage({
      userId,
      chatId,
      ...(forkId ? { forkId } : {}),
      parentSlotId,
      branch: false,
      version: version(content, speaker),
      commitDraft: null
    })

  /**
   * After a write: the chats named are stale (the read computes them), and once what it
   * computed is stored, a read from storage computes nothing and equals one from scratch.
   */
  const check = (label: string, stale: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const first = yield* reader.ShellLibrary({ userId })
      for (const id of stale)
        assert.isTrue(
          first.fresh.some((c) => c.chatId === id),
          `${label}: ${id} is recomputed`
        )
      yield* writer.StoreForkSummaries({ userId, chats: first.fresh })
      const cached = yield* reader.ShellLibrary({ userId })
      assert.deepStrictEqual(cached.fresh, [], `${label}: nothing left to compute`)
      const scratch = yield* reader.ShellLibrary({ userId, recompute: true })
      assert.deepStrictEqual(library(cached), library(scratch), label)
      assert.deepStrictEqual(library(first), library(scratch), label)
      return scratch
    })
  return { writer, reader, userId, mira, tam, harbor, other, append, version, check, makeCard, newChat }
})

describe("shell fork summaries", () => {
  it.live("every write the walk reads makes its chat stale, and the stored read equals a fresh one", () =>
    Effect.gen(function* () {
      const t = yield* setup
      const { writer, userId, harbor, other, mira, tam, check } = t
      yield* check("first read", [harbor.id, other.id])
      const root = yield* t.append(harbor.id, null, "Hello.", null)
      const a = yield* t.append(harbor.id, root.slotId, "Mira answers.")
      yield* t.append(other.id, null, "Tam speaks.", tam.entityId)
      let shell = yield* check("append", [harbor.id, other.id])
      assert.strictEqual(shell.forks.find((f) => f.chat.id === harbor.id)!.preview, "Mira answers.")

      // Untouched chats stay stored.
      const b = yield* t.append(harbor.id, a.slotId, "b", null)
      const after = yield* t.reader.ShellLibrary({ userId })
      assert.deepStrictEqual(
        after.fresh.map((c) => c.chatId),
        [harbor.id]
      )
      yield* check("append to one", [harbor.id])

      const swipe = yield* writer.AddVersion({
        userId,
        slotId: a.slotId,
        version: t.version("Mira, second take.", mira.entityId),
        select: true,
        commitDraft: null
      })
      yield* check("swipe", [harbor.id])
      yield* writer.SelectVersion({
        userId,
        slotId: a.slotId,
        versionId: a.version.id,
        expectedVersionId: swipe.id
      })
      yield* check("select", [harbor.id])

      const item = yield* writer.DeleteMessage({ userId, slotId: b.slotId })
      shell = yield* check("delete", [harbor.id])
      assert.strictEqual(shell.forks.find((f) => f.chat.id === harbor.id)!.messages, 2)
      yield* writer.RestoreBinItem({ userId, itemId: item.id })
      shell = yield* check("restore", [harbor.id])
      assert.strictEqual(shell.forks.find((f) => f.chat.id === harbor.id)!.messages, 3)

      const main = shell.forks.find((f) => f.chat.id === harbor.id)!.forkId as ForkId
      const anchor = yield* t.reader.GetSlot({ userId, slotId: a.slotId, forkId: main })
      yield* writer.InsertMessage({
        userId,
        chatId: harbor.id,
        forkId: main,
        anchorSlotId: a.slotId,
        expectedRowVersion: anchor.entry.rowVersion,
        body: { _tag: "Write", speaker: tam.entityId, content: "Tam cuts in." }
      })
      shell = yield* check("insert", [harbor.id])
      assert.strictEqual(shell.forks.find((f) => f.chat.id === harbor.id)!.messages, 4)

      const written = yield* t.reader.GetSlot({ userId, slotId: b.slotId, forkId: main })
      yield* writer.AmendVersion({
        userId,
        versionId: written.entry.version.id,
        content: "b, amended",
        expectedRowVersion: written.entry.version.rowVersion
      })
      shell = yield* check("edit", [harbor.id])
      assert.strictEqual(shell.forks.find((f) => f.chat.id === harbor.id)!.preview, "b, amended")

      yield* writer.AddStateEvent({
        userId,
        chatId: harbor.id,
        forkId: main,
        slotId: b.slotId,
        versionId: null,
        scope: null,
        data: { key: "participant.join", value: { entity: tam.entityId } }
      })
      shell = yield* check("join", [harbor.id])
      assert.includeMembers([...shell.forks.find((f) => f.chat.id === harbor.id)!.joined], [tam.entityId])
      // A card swap goes to a fork of the card.
      const nell = yield* writer.ForkCard({
        userId,
        refId: mira.ref.id,
        name: "Nell",
        nickname: "Nell",
        characterVersion: "2",
        moveDrafts: false
      })
      yield* check("card made", [])
      yield* writer.AddStateEvent({
        userId,
        chatId: harbor.id,
        forkId: main,
        slotId: b.slotId,
        versionId: null,
        scope: null,
        data: { key: "card.swap", value: { entity: nell.entityId, replaces: mira.entityId } }
      })
      shell = yield* check("swap", [harbor.id])
      assert.includeMembers([...shell.forks.find((f) => f.chat.id === harbor.id)!.cast], [nell.entityId])

      const made = yield* writer.CreateFork({ userId, chatId: harbor.id, fromForkId: main, atSlotId: a.slotId })
      shell = yield* check("fork", [harbor.id])
      assert.strictEqual(shell.forks.filter((f) => f.chat.id === harbor.id).length, 2)
      yield* t.append(harbor.id, a.slotId, "On the new fork.", mira.entityId, made.fork.id)
      yield* check("append to a fork", [harbor.id])
      const forkItem = yield* writer.DeleteFork({ userId, forkId: made.fork.id })
      shell = yield* check("fork deleted", [harbor.id])
      assert.strictEqual(shell.forks.filter((f) => f.chat.id === harbor.id).length, 1)
      yield* writer.RestoreBinItem({ userId, itemId: forkItem.id })
      shell = yield* check("fork restored", [harbor.id])
      assert.strictEqual(shell.forks.filter((f) => f.chat.id === harbor.id).length, 2)

      const chatItem = yield* writer.DeleteChat({ userId, chatId: other.id })
      shell = yield* check("chat to the bin", [])
      assert.isUndefined(shell.forks.find((f) => f.chat.id === other.id))
      assert.strictEqual(shell.cards.find((c) => c.card.entityId === tam.entityId)!.card.chats, 1)
      yield* writer.RestoreBinItem({ userId, itemId: chatItem.id })
      shell = yield* check("chat restored", [])
      assert.isDefined(shell.forks.find((f) => f.chat.id === other.id))

      // The bin needs nothing recomputed (the read leaves out binned cards); a purge reaches
      // every chat of the owner's (`withoutPurged` drops what it names).
      const binned = yield* writer.DeleteEntity({ userId, entityId: nell.entityId })
      shell = yield* check("card to the bin", [])
      assert.notInclude([...shell.forks.find((f) => f.chat.id === harbor.id && f.current)!.cast], nell.entityId)
      yield* writer.PurgeBinItem({ userId, itemId: binned.id })
      yield* check("card purged", [harbor.id, other.id])
    }).pipe(Effect.provide(database()))
  )

  // Per-fork validity (db/summaryValidity.ts): main runs root, a, b; `atA` branches at a and
  // `atB` at b, each with a message of its own. A write keeps valid the summaries it can't
  // reach, and every summary a read takes from storage equals one computed from scratch.
  it.live("a write makes stale only the forks it reaches", () =>
    Effect.gen(function* () {
      const t = yield* setup
      const { writer, reader, userId, harbor, mira, tam } = t
      const root = yield* t.append(harbor.id, null, "Hello.", null)
      const a = yield* t.append(harbor.id, root.slotId, "Mira answers.")
      const b = yield* t.append(harbor.id, a.slotId, "b", null)
      yield* t.check("main", [harbor.id])
      const main = (yield* reader.ShellLibrary({ userId })).forks.find((f) => f.chat.id === harbor.id)!.forkId as ForkId
      const atA = (yield* writer.CreateFork({ userId, chatId: harbor.id, fromForkId: main, atSlotId: a.slotId })).fork
        .id
      const ownA = yield* t.append(harbor.id, a.slotId, "Only in atA.", null, atA)
      const atB = (yield* writer.CreateFork({ userId, chatId: harbor.id, fromForkId: main, atSlotId: b.slotId })).fork
        .id
      const ownB = yield* t.append(harbor.id, b.slotId, "Only in atB.", mira.entityId, atB)
      yield* t.check("forks", [harbor.id])
      const name = new Map<string, string>([
        [main, "main"],
        [atA, "atA"],
        [atB, "atB"]
      ])
      /** After a write: which of harbor's forks a read walks, then `check`'s equalities. */
      const walks = (label: string, expected: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const read = yield* reader.ShellLibrary({ userId })
          const walked = read.fresh
            .filter((c) => c.chatId === harbor.id)
            .flatMap((c) =>
              (JSON.parse(c.forks) as Array<{ forkId: string }>).map((f) => name.get(f.forkId) ?? f.forkId)
            )
          assert.deepStrictEqual(walked.sort(), [...expected].sort(), label)
          yield* t.check(label, [])
        })
      yield* walks("nothing written", [])
      yield* t.append(harbor.id, ownA.slotId, "atA goes on.", mira.entityId, atA)
      yield* walks("append in one fork", ["atA"])
      // A swipe on the shared prefix, chosen in main: main's own selection.
      const swipe = yield* writer.AddVersion({
        userId,
        slotId: a.slotId,
        forkId: main,
        version: t.version("Mira, second take.", mira.entityId),
        select: true,
        commitDraft: null
      })
      yield* walks("swipe on a shared slot", ["main"])
      yield* writer.SelectVersion({
        userId,
        slotId: a.slotId,
        forkId: main,
        versionId: a.version.id,
        expectedVersionId: swipe.id
      })
      yield* walks("select on a shared slot", ["main"])
      // Hiding isn't read by the summaries.
      yield* writer.SetSlotHidden({ userId, slotId: a.slotId, forkId: atB, hidden: true })
      yield* walks("hide", [])
      const written = yield* reader.GetSlot({ userId, slotId: b.slotId, forkId: atB })
      yield* writer.AmendVersion({
        userId,
        versionId: written.entry.version.id,
        forkId: atB,
        content: "b, amended.",
        expectedRowVersion: written.entry.version.rowVersion
      })
      yield* walks("edit on a shared slot", ["atB"])
      yield* writer.AddStateEvent({
        userId,
        chatId: harbor.id,
        forkId: atB,
        slotId: ownB.slotId,
        versionId: null,
        scope: null,
        data: { key: "participant.join", value: { entity: tam.entityId } }
      })
      yield* walks("state event in one fork", ["atB"])
      yield* writer.DeleteMessage({ userId, slotId: b.slotId, forkId: main })
      yield* walks("delete on a shared slot", ["main"])
      yield* writer.DeleteFork({ userId, forkId: atA })
      yield* walks("fork deleted", [])
    }).pipe(Effect.provide(database()))
  )

  it.live("a chat an ST import is still writing is never walked by a read", () =>
    Effect.gen(function* () {
      const t = yield* setup
      const { userId, mira } = t
      // The title the import gives a chat until it finishes (ARCHITECTURE.md §13).
      const inbound = yield* t.newChat("Inbound (import unfinished)", [mira.entityId])
      const root = yield* t.append(inbound.id, null, "Imported hello.", null)
      yield* t.append(inbound.id, root.slotId, "Imported answer.")
      const read = yield* t.reader.ShellLibrary({ userId })
      assert.isFalse(read.fresh.some((c) => c.chatId === inbound.id))
      const shown = read.forks.find((f) => f.chat.id === inbound.id)!
      assert.strictEqual(shown.messages, 0)
      assert.strictEqual(shown.preview, "")
      // The walk itself still knows it, for the import's finish to store.
      const scratch = yield* t.reader.ShellLibrary({ userId, recompute: true })
      assert.strictEqual(scratch.forks.find((f) => f.chat.id === inbound.id)!.messages, 2)
    }).pipe(Effect.provide(database()))
  )

  it.live("GetShellLibrary stores what it computed after answering", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const card = yield* api.CreateCard({ label: "Aria", name: "Aria" })
      yield* api.StartChat({
        cards: [card.entityId],
        persona: null,
        greeting: null,
        first: { _tag: "Send", content: "Start.", speakerEntityId: null }
      })
      const reader = yield* Database.Reader
      const { id: userId } = yield* api.Whoami()
      assert.lengthOf((yield* reader.ShellLibrary({ userId })).fresh, 1)
      const answer = yield* api.GetShellLibrary()
      let stored = false
      for (let n = 0; n < 200 && !stored; n++) {
        stored = (yield* reader.ShellLibrary({ userId })).fresh.length === 0
        if (!stored) yield* Effect.sleep("20 millis")
      }
      assert.isTrue(stored)
      const again = yield* api.GetShellLibrary()
      assert.deepStrictEqual(again, answer)
      assert.notProperty(again, "fresh")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )
})
