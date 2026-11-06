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
import { fixtureSql } from "./support/lcmFixtures.ts"

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
  it.live("foreground shell reads defer broad recomputations and serve settled summaries", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, harbor, append, check, tam, version } = yield* setup
      const main = harbor.currentForkId!
      const root = yield* append(harbor.id, null, "Root", undefined, main)
      for (let n = 0; n < 2; n++)
        yield* writer.CreateFork({ userId, chatId: harbor.id, fromForkId: main, atSlotId: root.slotId })
      const payload = {
        userId,
        view: {
          entity: null,
          chat: null,
          search: "",
          sort: "recent" as const,
          sections: [{ id: "all" as const, limit: 100 }]
        }
      }
      assert.isNull(yield* reader.ShellCardsLive({ userId }))
      assert.isNull(yield* reader.ShellForksLive(payload))
      yield* check("settled", [harbor.id])
      assert.deepStrictEqual(yield* reader.ShellCardsLive({ userId }), yield* reader.ShellCards({ userId }))
      assert.deepStrictEqual(yield* reader.ShellForksLive(payload), yield* reader.ShellForks(payload))
      yield* writer.AddVersion({
        userId,
        slotId: root.slotId,
        forkId: main,
        select: false,
        commitDraft: null,
        version: version("A new participant", tam.entityId)
      })
      assert.isNull(yield* reader.ShellCardsLive({ userId }))
      assert.isNull(yield* reader.ShellForksLive(payload))
      yield* check("shared participation", [harbor.id])
    }).pipe(Effect.provide(database()))
  )
  it.live("an edit with existing participation preserves frozen forks and unrelated chats", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, harbor, append, check, version } = yield* setup
      const main = harbor.currentForkId!
      const root = yield* append(harbor.id, null, "Original", undefined, main)
      const { fork } = yield* writer.CreateFork({ userId, chatId: harbor.id, fromForkId: main, atSlotId: root.slotId })
      yield* check("initial", [harbor.id])
      yield* writer.AddVersion({
        userId,
        slotId: root.slotId,
        forkId: main,
        select: true,
        commitDraft: null,
        version: new NewVersion({
          ...version("Edited", root.version.speakerEntityId),
          writer: "human",
          origin: "edited",
          sourceVersionId: root.version.id
        })
      })
      const changed = yield* reader.ShellLibrary({ userId })
      assert.deepStrictEqual(
        changed.fresh.flatMap((chat) => JSON.parse(chat.forks).map((row: { forkId: string }) => row.forkId)),
        [main]
      )
      assert.strictEqual(changed.forks.find((row) => row.forkId === fork.id)!.preview, "Original")
      assert.strictEqual(changed.forks.find((row) => row.forkId === main)!.preview, "Edited")
      yield* check("local edit", [harbor.id])
      const current = yield* reader.GetSlot({ userId, slotId: root.slotId, forkId: main })
      yield* writer.AmendVersion({
        userId,
        versionId: current.entry.version.id,
        forkId: main,
        content: "Amended again",
        expectedRowVersion: current.entry.version.rowVersion
      })
      const amended = yield* reader.ShellLibrary({ userId })
      assert.deepStrictEqual(
        amended.fresh.flatMap((chat) => JSON.parse(chat.forks).map((row: { forkId: string }) => row.forkId)),
        [main]
      )
      yield* check("repeated local edit", [harbor.id])
    }).pipe(Effect.provide(database()))
  )
  for (const parentCount of [1, 17])
    it.live(`summarizes plain children of ${parentCount} overridden parents`, () =>
      Effect.gen(function* () {
        const { writer, reader, userId, harbor, append, version, check } = yield* setup
        const main = harbor.currentForkId!
        const root = yield* append(harbor.id, null, "Original", null, main)
        const parents: Array<ForkId> = []
        if (parentCount === 1) parents.push(main)
        else
          for (let n = 0; n < parentCount; n++)
            parents.push(
              (yield* writer.CreateFork({ userId, chatId: harbor.id, fromForkId: main, atSlotId: root.slotId })).fork.id
            )
        const children: Array<ForkId> = []
        // Frozen children share a tree with few changed parents; many changed
        // parents require path batches disjoint from the plain forks.
        for (let n = 0; n < 17; n++)
          children.push(
            (yield* writer.CreateFork({
              userId,
              chatId: harbor.id,
              fromForkId: parents[n % parentCount]!,
              atSlotId: root.slotId
            })).fork.id
          )
        for (const forkId of parents)
          yield* writer.AddVersion({
            userId,
            slotId: root.slotId,
            forkId,
            version: version("Parent alternative", null),
            select: true,
            commitDraft: null
          })
        const changed = new Set<string>(parents)
        const expected = children.length + parents.length + (changed.has(main) ? 0 : 1)
        const shell = yield* check("plain children and overridden parents", [harbor.id])
        const forks = shell.forks.filter((f) => f.chat.id === harbor.id)
        assert.lengthOf(forks, expected)
        assert.isTrue(forks.every((f) => f.preview === (changed.has(f.forkId) ? "Parent alternative" : "Original")))
        for (const id of children) {
          const child = forks.find((f) => f.forkId === id)!
          assert.strictEqual(child.preview, "Original")
          assert.strictEqual(child.messages, 1)
          assert.deepStrictEqual(child.split, { at: child.createdAt, after: 1 })
        }
        const listed = yield* reader.ListForks({ userId, chatId: harbor.id })
        assert.lengthOf(listed, expected)
        assert.isTrue(listed.every((f) => f.tipExcerpt === (changed.has(f.id) ? "Parent alternative" : "Original")))
      }).pipe(Effect.provide(database()))
    )

  it.live("fork exclusion and lineage compaction preserve every existing fork summary", () =>
    Effect.gen(function* () {
      const t = yield* setup
      const { writer, reader, userId, harbor, append, check } = t
      const main = harbor.currentForkId!
      const root = yield* append(harbor.id, null, "Root", null, main)
      const tip = yield* append(harbor.id, root.slotId, "Tip", null, main)
      // Inherited selection overrides also exercise batched dense summaries
      // once the chain grows, alongside the other chat's plain fork.
      yield* writer.AddVersion({
        userId,
        slotId: tip.slotId,
        forkId: main,
        version: t.version("A selected alternative", null),
        select: true,
        commitDraft: null
      })
      const anchor = yield* reader.GetSlot({ userId, slotId: root.slotId, forkId: main })
      yield* writer.InsertMessage({
        userId,
        chatId: harbor.id,
        forkId: main,
        anchorSlotId: root.slotId,
        expectedRowVersion: anchor.entry.rowVersion,
        body: { _tag: "Write", speaker: null, content: "Between root and tip" }
      })
      yield* check("before fork", [harbor.id])
      const onlyNew = (forkId: ForkId) =>
        Effect.gen(function* () {
          const read = yield* reader.ShellLibrary({ userId })
          assert.deepStrictEqual(
            read.fresh.flatMap((chat) => (JSON.parse(chat.forks) as Array<{ forkId: string }>).map((f) => f.forkId)),
            [forkId],
            "placing or excluding an insertion in a new fork must not invalidate existing forks"
          )
          yield* check("new fork only", [harbor.id])
        })
      // Forking at the anchor must write insert=0: the insertion follows the base.
      const early = yield* writer.CreateFork({ userId, chatId: harbor.id, fromForkId: main, atSlotId: root.slotId })
      yield* onlyNew(early.fork.id)
      let parent = main
      for (let n = 1; n < 64; n++)
        parent = (yield* writer.CreateFork({ userId, chatId: harbor.id, fromForkId: parent, atSlotId: tip.slotId }))
          .fork.id
      yield* check("before compaction", [harbor.id])
      // The 65th lineage entry copies the parent's effective insertion row.
      const compacted = yield* writer.CreateFork({
        userId,
        chatId: harbor.id,
        fromForkId: parent,
        atSlotId: tip.slotId
      })
      yield* onlyNew(compacted.fork.id)
      // Normal replies reach their forks by structural chain intervals even
      // when other messages in the chat have insertions.
      const reply = yield* append(harbor.id, tip.slotId, "A new reply", null, main)
      yield* onlyNew(main)
      yield* writer.AddVersion({
        userId,
        slotId: reply.slotId,
        forkId: main,
        version: t.version("Another take", null),
        select: true,
        commitDraft: null
      })
      yield* onlyNew(main)
    }).pipe(Effect.provide(database()))
  )

  it.live("previews skip empty and failed messages, with an empty fallback", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, harbor, append, version, check } = yield* setup
      const main = harbor.currentForkId!
      const root = yield* append(harbor.id, null, "Latest text", null, main)
      const empty = yield* append(harbor.id, root.slotId, " \n\t", null, main)
      yield* writer.AppendMessage({
        userId,
        chatId: harbor.id,
        forkId: main,
        parentSlotId: empty.slotId,
        branch: false,
        version: new NewVersion({
          ...version("Failed partial", null),
          status: "failed",
          error: { class: "test", message: "Failed generation" }
        }),
        commitDraft: null
      })
      const shell = yield* check("empty and failed", [harbor.id])
      assert.strictEqual(shell.forks.find((f) => f.forkId === main)!.preview, "Latest text")
      assert.strictEqual((yield* reader.ListForks({ userId, chatId: harbor.id }))[0]!.tipExcerpt, "Latest text")
      assert.strictEqual((yield* reader.ChatSummaries({ userId, chatIds: [harbor.id] }))[0]!.last!.text, "Latest text")
      const side = yield* writer.CreateFork({ userId, chatId: harbor.id, fromForkId: main, atSlotId: root.slotId })
      yield* append(harbor.id, root.slotId, "\r\n ", null, side.fork.id)
      assert.strictEqual((yield* reader.ChatSummaries({ userId, chatIds: [harbor.id] }))[0]!.last!.text, "Latest text")
      const blank = yield* writer.CreateFork({ userId, chatId: harbor.id, fromForkId: main, atSlotId: null })
      yield* append(harbor.id, null, "", null, blank.fork.id)
      const noText = yield* check("no text", [harbor.id])
      assert.strictEqual(noText.forks.find((f) => f.forkId === blank.fork.id)!.preview, "")
      assert.strictEqual((yield* reader.ChatSummaries({ userId, chatIds: [harbor.id] }))[0]!.last, null)
    }).pipe(Effect.provide(database()))
  )

  it.live("preview fallback tests the excerpt while last text tests the whole body", () =>
    Effect.gen(function* () {
      const { reader, userId, harbor, append, check } = yield* setup
      const main = harbor.currentForkId!
      const root = yield* append(harbor.id, null, "Earlier excerpt", null, main)
      const leading = " ".repeat(170) + "Visible after the excerpt"
      yield* append(harbor.id, root.slotId, leading, null, main)
      const shell = yield* check("whitespace prefix", [harbor.id])
      assert.strictEqual(shell.forks.find((f) => f.forkId === main)!.preview, "Earlier excerpt")
      assert.strictEqual((yield* reader.ChatSummaries({ userId, chatIds: [harbor.id] }))[0]!.last!.text, leading)
    }).pipe(Effect.provide(database()))
  )

  it.live("a failed reply invalidates its cached preview even when its partial text is unchanged", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, harbor, append, version } = yield* setup
      const main = harbor.currentForkId!
      const root = yield* append(harbor.id, null, "Earlier text", null, main)
      const reply = yield* writer.AppendMessage({
        userId,
        chatId: harbor.id,
        forkId: main,
        parentSlotId: root.slotId,
        branch: false,
        commitDraft: null,
        version: new NewVersion({
          ...version("Partial reply", null),
          writer: "model",
          status: "generating",
          origin: "generated"
        })
      })
      const cached = yield* reader.ShellLibrary({ userId })
      yield* writer.StoreForkSummaries({ userId, chats: cached.fresh })
      assert.strictEqual(cached.forks.find((f) => f.forkId === main)!.preview, "Partial reply")
      yield* writer.SaveGeneration({
        userId,
        versionId: reply.version.id,
        content: "Partial reply",
        status: "failed",
        error: { class: "test", message: "Synthetic failure" }
      })
      assert.strictEqual(
        (yield* reader.ShellLibrary({ userId })).forks.find((f) => f.forkId === main)!.preview,
        "Earlier text"
      )
    }).pipe(Effect.provide(database()))
  )

  it.live("records only participation added after each branch's own split", () =>
    Effect.gen(function* () {
      const t = yield* setup
      const { writer, userId, harbor, mira, tam, append, check, makeCard } = t
      const main = harbor.currentForkId!
      const late = yield* makeCard("Late")
      const silent = yield* makeCard("Silent")
      const swapped = yield* writer.ForkCard({
        userId,
        refId: mira.ref.id,
        name: "Swapped",
        nickname: "Swapped",
        characterVersion: "2"
      })
      const event = (forkId: ForkId, slotId: SlotId, data: Parameters<typeof writer.AddStateEvent>[0]["data"]) =>
        writer.AddStateEvent({ userId, chatId: harbor.id, forkId, slotId, versionId: null, scope: null, data })
      const root = yield* append(harbor.id, null, "Root", mira.entityId, main)
      yield* event(main, root.slotId, { key: "participant.join", value: { entity: tam.entityId } })
      const before = yield* append(harbor.id, root.slotId, "Before split", mira.entityId, main)
      const branch = (yield* writer.CreateFork({
        userId,
        chatId: harbor.id,
        fromForkId: main,
        atSlotId: before.slotId
      })).fork
      const additions = (shell: Read, id: string) => shell.forks.find((f) => f.forkId === id)!.added
      yield* event(branch.id, before.slotId, { key: "participant.join", value: { entity: silent.entityId } })
      assert.deepStrictEqual(additions(yield* check("no participation", [harbor.id]), branch.id), [])
      yield* event(branch.id, before.slotId, { key: "participant.leave", value: { entity: silent.entityId } })
      yield* event(branch.id, before.slotId, { key: "participant.join", value: { entity: late.entityId } })
      const own = yield* append(harbor.id, before.slotId, "After split", mira.entityId, branch.id)
      let shell = yield* check("join after split", [harbor.id])
      assert.deepStrictEqual(additions(shell, main), [])
      assert.deepStrictEqual(additions(shell, branch.id), [late.entityId])
      // A later parent join must not rewrite the branch's split-time cast.
      yield* event(main, before.slotId, { key: "participant.join", value: { entity: late.entityId } })
      shell = yield* check("parent changes after split", [harbor.id])
      assert.deepStrictEqual(additions(shell, branch.id), [late.entityId])
      const child = (yield* writer.CreateFork({
        userId,
        chatId: harbor.id,
        fromForkId: branch.id,
        atSlotId: own.slotId
      })).fork
      yield* event(child.id, own.slotId, { key: "participant.join", value: { entity: silent.entityId } })
      yield* append(harbor.id, own.slotId, "Nested participation", mira.entityId, child.id)
      shell = yield* check("branch of branch", [harbor.id])
      assert.deepStrictEqual(additions(shell, child.id), [silent.entityId])
      // A swap alone establishes no participation; its first swipe does, even unselected.
      yield* event(branch.id, own.slotId, {
        key: "card.swap",
        value: { replaces: mira.entityId, entity: swapped.entityId }
      })
      shell = yield* check("swap without writing", [harbor.id])
      assert.deepStrictEqual(additions(shell, branch.id), [late.entityId])
      yield* writer.AddVersion({
        userId,
        forkId: branch.id,
        slotId: own.slotId,
        version: t.version("Alternative", swapped.entityId),
        select: false,
        commitDraft: null
      })
      shell = yield* check("unselected participation", [harbor.id])
      assert.includeMembers([...additions(shell, branch.id)], [late.entityId, swapped.entityId])
      assert.deepStrictEqual(additions(shell, child.id), [silent.entityId])
      yield* event(branch.id, own.slotId, { key: "participant.leave", value: { entity: late.entityId } })
      shell = yield* check("departures retain additions", [harbor.id])
      assert.includeMembers([...additions(shell, branch.id)], [late.entityId, swapped.entityId])
    }).pipe(Effect.provide(database()))
  )

  it.live("orders characters by branch messages, preserves silent join order and follows swaps", () =>
    Effect.gen(function* () {
      const { writer, userId, mira, tam, makeCard, newChat, append, check } = yield* setup
      const silent = yield* makeCard("Silent")
      const persona = yield* makeCard("Persona")
      const chat = yield* newChat("Cast order", [mira.entityId, tam.entityId, silent.entityId, persona.entityId])
      const main = chat.currentForkId!
      yield* writer.AddStateEvent({
        userId,
        chatId: chat.id,
        forkId: main,
        slotId: null,
        versionId: null,
        scope: null,
        data: { key: "played_by_me.set", value: { entities: [persona.entityId] } }
      })
      const order = (shell: Read, forkId = main) => shell.forks.find((f) => f.forkId === forkId)!.cast
      assert.deepStrictEqual(order(yield* check("silent", [chat.id])), [mira.entityId, tam.entityId, silent.entityId])
      const first = yield* append(chat.id, null, "Tam speaks", tam.entityId, main)
      assert.deepStrictEqual(order(yield* check("Tam", [chat.id])), [tam.entityId, mira.entityId, silent.entityId])
      const second = yield* append(chat.id, first.slotId, "Mira speaks", mira.entityId, main)
      const third = yield* append(chat.id, second.slotId, "Tam again", tam.entityId, main)
      const fourth = yield* append(chat.id, third.slotId, "Persona speaks", persona.entityId, main)
      assert.deepStrictEqual(order(yield* check("distinct and persona", [chat.id])), [
        tam.entityId,
        mira.entityId,
        silent.entityId
      ])
      const { fork: branch } = yield* writer.CreateFork({
        userId,
        chatId: chat.id,
        fromForkId: main,
        atSlotId: second.slotId
      })
      const branchTurn = yield* append(chat.id, second.slotId, "Silent speaks on branch", silent.entityId, branch.id)
      let shell = yield* check("branch", [chat.id])
      assert.deepStrictEqual(order(shell), [tam.entityId, mira.entityId, silent.entityId])
      assert.deepStrictEqual(order(shell, branch.id), [silent.entityId, mira.entityId, tam.entityId])
      const replacement = yield* writer.ForkCard({
        userId,
        refId: tam.ref.id,
        name: "Tam variant",
        nickname: "Tam variant",
        characterVersion: "2"
      })
      yield* writer.AddStateEvent({
        userId,
        chatId: chat.id,
        forkId: main,
        slotId: fourth.slotId,
        versionId: null,
        scope: null,
        data: { key: "card.swap", value: { entity: replacement.entityId, replaces: tam.entityId } }
      })
      shell = yield* check("swap retains recency", [chat.id])
      assert.deepStrictEqual(order(shell), [replacement.entityId, mira.entityId, silent.entityId])
      assert.deepStrictEqual(order(shell, branch.id), [silent.entityId, mira.entityId, tam.entityId])
      // A newer turn advances only that fork; every check also verifies stored-summary reuse.
      yield* append(chat.id, branchTurn.slotId, "Tam replies on branch", tam.entityId, branch.id)
      shell = yield* check("branch reply", [chat.id])
      assert.deepStrictEqual(order(shell, branch.id), [tam.entityId, silent.entityId, mira.entityId])
    }).pipe(Effect.provide(database()))
  )

  it.live("recomputes persisted summaries from before retained-swipe invalidation", () => {
    const dataDir = tempDir("shell-old-summary")
    return Effect.gen(function* () {
      const t = yield* setup
      yield* t.append(t.harbor.id, null, "The current story.")
      const expected = yield* t.check("stored", [t.harbor.id, t.other.id])
      // Older builds could advance a stale summary's stamp after an unselected swipe.
      // Its stamps still match on startup, so only the format can invalidate it.
      yield* fixtureSql(dataDir, [
        {
          sql: "UPDATE fork_summaries SET format = 4, preview = 'Obsolete cached preview', joined_json = '[]' WHERE chat_id = ?",
          params: [t.harbor.id]
        }
      ])
      const read = yield* t.reader.ShellLibrary({ userId: t.userId })
      assert.deepStrictEqual(
        read.fresh.map((chat) => chat.chatId),
        [t.harbor.id]
      )
      assert.deepStrictEqual(library(read), library(expected))
      yield* t.check("repaired", [t.harbor.id])
    }).pipe(Effect.provide(Database.layer({ dataDir, readers: 2, allowNetworkFs: false, ...testWorkers })))
  })

  it.live("an unselected model swipe refreshes participation on every fork displaying its slot", () =>
    Effect.gen(function* () {
      const t = yield* setup
      const { writer, reader, userId, harbor, other, mira, tam } = t
      const root = yield* t.append(harbor.id, null, "Mira opens the story.", mira.entityId)
      yield* t.append(other.id, null, "Tam's other story.", tam.entityId)
      const main = harbor.currentForkId as ForkId
      const branch = (yield* writer.CreateFork({ userId, chatId: harbor.id, fromForkId: main, atSlotId: root.slotId }))
        .fork.id
      const before = yield* t.check("cache both forks", [harbor.id, other.id])
      assert.strictEqual(before.cards.find((card) => card.card.entityId === tam.entityId)!.card.chats, 1)
      yield* writer.AddVersion({
        userId,
        slotId: root.slotId,
        forkId: main,
        version: t.version("Tam's unselected reply.", tam.entityId),
        select: false,
        commitDraft: null
      })
      const read = yield* reader.ShellLibrary({ userId })
      assert.deepStrictEqual(
        read.fresh.map((chat) => chat.chatId),
        [harbor.id]
      )
      const refreshed = JSON.parse(read.fresh[0]!.forks) as Array<{ forkId: string }>
      assert.deepStrictEqual(refreshed.map((fork) => fork.forkId).sort(), [main, branch].sort())
      const after = yield* t.check("retained swipe", [harbor.id])
      assert.strictEqual(after.cards.find((card) => card.card.entityId === tam.entityId)!.card.chats, 3)
      for (const fork of after.forks.filter((fork) => fork.chat.id === harbor.id)) {
        assert.include(fork.joined, tam.entityId)
        assert.include(fork.departed, tam.entityId)
        assert.notInclude(fork.cast, tam.entityId)
      }
      const shown = yield* reader.GetSlot({ userId, slotId: root.slotId, forkId: main })
      assert.strictEqual(shown.entry.version.id, root.version.id)
    }).pipe(Effect.provide(database()))
  )

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
        characterVersion: "2"
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
      // Only the deleted fork changed; the surviving fork keeps its summary.
      shell = yield* check("fork deleted", [])
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
      // The same model speaker and cast add no historical participation.
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
      // An anonymous edit adds no human-author activity on the frozen forks.
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
      yield* walks("delete on a shared slot", ["atB", "main"])
      // main's tip moves on to a new slot, which neither branch's path holds.
      yield* t.append(harbor.id, a.slotId, "main goes on.", mira.entityId, main)
      yield* walks("append in a parent", ["main"])
      yield* writer.DeleteFork({ userId, forkId: atA })
      yield* walks("fork deleted", [])
      // atB now splits off at its base, b, rather than where main's path leaves it.
      yield* writer.DeleteFork({ userId, forkId: main })
      yield* walks("parent deleted", ["atB"])
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
