// Card sources (spec/CARD-SOURCES.md, phase 1): the registry, the network consent rule (nothing
// reaches a source until the user asks for something from it, §5.1), the guards that keep the
// proxy from being an open one (§6.2), the self rate limit and coalescing (§5.5), the cache's
// lifetimes, pinning, cap and per-user namespace (§4.1), and updates (§3.8: version markers,
// Check for a newer version, the newer file, Add as a separate card), against the fake
// archive's synthetic cards. No real archive is contacted.
import { afterAll, assert, describe, it, layer } from "@effect/vitest"
import { emptySourceQuery, remoteEntityId, SourceFailed } from "@rp/shared/cardSources.ts"
import type { EntityId } from "@rp/shared/chat.ts"
import { textField } from "@rp/shared/editing.ts"
import type { RefId } from "@rp/shared/library.ts"
import { Effect, Exit, Fiber, Layer } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CardSourceAdapter } from "../src/sources/adapter.ts"
import { cardexAdapter } from "../src/sources/cardex.ts"
import { makeSourceCache } from "../src/sources/cache.ts"
import * as CardSources from "../src/sources/CardSources.ts"
import { isPrivateAddress, makeSourceHttp } from "../src/sources/guard.ts"
import { makeCoalescer, makeLimiter } from "../src/sources/limiter.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, outcome, serverLayer, serverPort, testConfig } from "./support/config.ts"
import { fakeCardexAdapter, startFakeArchive } from "./support/fakeArchive.ts"

const archive = await startFakeArchive({ cards: 120 })
afterAll(() => archive.close())

const alice = { "Remote-User": "src-alice" }
const bob = { "Remote-User": "src-bob" }
const config = testConfig({ authMode: "proxy" })
// The real cardex adapter against the fake, with a key it may take: cardex itself takes none,
// but this is where the key's write-only path is tested.
const sources = CardSources.layerWith({ adapters: [{ ...fakeCardexAdapter(archive), key: "optional" }] })
const testServer = serverLayer(config, undefined, undefined, sources)
const base = Effect.map(serverPort, (port) => `http://127.0.0.1:${port}`)

layer(testServer, { timeout: 60_000 })("through the server", (it) => {
  it.effect("nothing reaches the source until the user asks it for something (§5.1)", () =>
    Effect.gen(function* () {
      archive.reset()
      const api = yield* client(alice)
      // Visiting home, opening the sidebar, settings: lists, switches and the recent row are local.
      yield* api.Whoami()
      yield* api.ListCardUsage()
      yield* api.ListLibrary({ kind: "card" })
      const listed = yield* api.ListCardSources()
      assert.deepStrictEqual(
        listed.sources.map((s) => [s.id, s.name, s.enabled]),
        [["cardex", "cardex", true]]
      )
      yield* api.ListRecentRemote({ sourceId: "cardex" })
      yield* api.SetCardSourceRating({ sourceId: "cardex", rating: "include" })
      assert.strictEqual(archive.hits(), 0)
      // Turned off, a search is refused here and sends nothing.
      yield* api.SetCardSourceEnabled({ sourceId: "cardex", enabled: false })
      const off = yield* outcome(api.SourceSearch({ sourceId: "cardex", query: emptySourceQuery, page: null }))
      assert.strictEqual(off, "SourceFailed:disabled")
      assert.strictEqual(archive.hits(), 0)
      yield* api.SetCardSourceEnabled({ sourceId: "cardex", enabled: true })
      // Opening the option: the first requests.
      const caps = yield* api.SourceCapabilities({ sourceId: "cardex" })
      assert.isTrue(caps.filters.some((f) => f.id === "nsfw"))
      const page = yield* api.SourceSearch({ sourceId: "cardex", query: emptySourceQuery, page: null })
      assert.lengthOf(page.items, 48)
      assert.isAbove(archive.hits(), 0)
      // The same page again comes from the cache.
      const before = archive.hits()
      yield* api.SourceSearch({ sourceId: "cardex", query: emptySourceQuery, page: null })
      assert.strictEqual(archive.hits(), before)
    })
  )

  it.effect("results carry image keys, not URLs, and a key works only for whom it was issued", () =>
    Effect.gen(function* () {
      const api = yield* client(alice)
      const page = yield* api.SourceSearch({
        sourceId: "cardex",
        query: { ...emptySourceQuery, text: "Amber" },
        page: null
      })
      const item = page.items[0]!
      assert.isDefined(item.thumb)
      assert.notInclude(item.thumb!, "http")
      // Only the card's own page on the source is a link; no picture is.
      assert.notInclude(JSON.stringify(page.items.map(({ url: _url, ...rest }) => rest)), archive.origin)
      const url = yield* base
      const own = yield* Effect.promise(() =>
        fetch(`${url}/sources/cardex/image?k=${item.thumb}&w=96`, { headers: alice })
      )
      assert.strictEqual(own.status, 200, own.status === 200 ? "" : yield* Effect.promise(() => own.text()))
      assert.strictEqual(own.headers.get("content-type"), "image/webp")
      assert.strictEqual(own.headers.get("cache-control"), "private, max-age=86400")
      const theirs = yield* Effect.promise(() =>
        fetch(`${url}/sources/cardex/image?k=${item.thumb}&w=96`, { headers: bob })
      )
      assert.strictEqual(theirs.status, 404)
      // A key made up by the client names no URL the server will fetch.
      const forged = Buffer.from(`${archive.origin}/i/x.png`).toString("base64url")
      const made = yield* Effect.promise(() => fetch(`${url}/sources/cardex/image?k=${forged}.abc`, { headers: alice }))
      assert.strictEqual(made.status, 404)
      const anonymous = yield* Effect.promise(() => fetch(`${url}/sources/cardex/image?k=${item.thumb}`))
      assert.strictEqual(anonymous.status, 401)
    })
  )

  it.effect("pages follow cardex v1: a cursor in fts mode, page numbers in semantic mode", () =>
    Effect.gen(function* () {
      const api = yield* client(alice)
      const all = { ...emptySourceQuery, filters: { nsfw: "include" } }
      for (const query of [all, { ...all, filters: { ...all.filters, mode: "semantic" } }]) {
        const seen = new Set<string>()
        let page: string | null = null
        let total = 0
        do {
          const result: { items: ReadonlyArray<{ remoteId: string }>; next: string | null; total?: number } =
            yield* api.SourceSearch({ sourceId: "cardex", query, page })
          for (const item of result.items) seen.add(item.remoteId)
          total = result.total ?? 0
          page = result.next
        } while (page !== null)
        assert.strictEqual(total, archive.cards.length)
        assert.strictEqual(seen.size, archive.cards.length)
      }
      const paths = archive.paths().filter((p) => p.startsWith("/api/v1/search"))
      assert.isTrue(paths.some((p) => p.includes("mode=semantic") && p.includes("page=2") && !p.includes("cursor")))
      assert.isTrue(paths.some((p) => p.includes("cursor=") && !p.includes("page=") && !p.includes("mode=semantic")))
    })
  )
  it.effect("each user's switches, recent list and cache are their own", () =>
    Effect.gen(function* () {
      const a = yield* client(alice)
      const b = yield* client(bob)
      const remoteId = archive.cards[3]!.slug
      const opened = yield* a.SourceCard({ sourceId: "cardex", remoteId })
      assert.isNotNull(opened.docJson)
      assert.strictEqual((JSON.parse(opened.docJson!) as { name: string }).name, archive.cards[3]!.name)
      assert.deepStrictEqual(
        (yield* a.ListRecentRemote({ sourceId: "cardex" })).map((r) => r.remoteId),
        [remoteId]
      )
      assert.lengthOf(yield* b.ListRecentRemote({ sourceId: "cardex" }), 0)
      yield* b.SetCardSourceEnabled({ sourceId: "cardex", enabled: false })
      assert.isTrue((yield* a.ListCardSources()).sources[0]!.enabled)
      yield* b.SetCardSourceEnabled({ sourceId: "cardex", enabled: true })
      // Opened again, the card comes from the cache: no new request.
      const before = archive.hits()
      yield* a.SourceCard({ sourceId: "cardex", remoteId })
      assert.strictEqual(archive.hits(), before)
      // Clearing the cache empties the recent list and makes the next open ask again.
      yield* a.ClearSourceCache({ sourceId: "cardex" })
      assert.lengthOf(yield* a.ListRecentRemote({ sourceId: "cardex" }), 0)
      yield* a.SourceCard({ sourceId: "cardex", remoteId })
      assert.isAbove(archive.hits(), before)
    })
  )

  it.effect("the key is write-only, and only admins see or set the cap", () =>
    Effect.gen(function* () {
      const b = yield* client(bob)
      const list = yield* b.SetCardSourceKey({ sourceId: "cardex", key: "sk-cardex-test" })
      assert.isTrue(list.sources[0]!.hasKey)
      assert.notInclude(JSON.stringify(list), "sk-cardex-test")
      assert.isFalse((yield* (yield* client(alice)).ListCardSources()).sources[0]!.hasKey)
      assert.isFalse((yield* b.SetCardSourceKey({ sourceId: "cardex", key: null })).sources[0]!.hasKey)
      assert.isUndefined(list.cache)
      assert.strictEqual(yield* outcome(b.SetSourceCacheCap({ bytes: 64 * 1024 * 1024 })), "Forbidden")
      assert.strictEqual(yield* outcome(b.SourceCard({ sourceId: "nowhere", remoteId: "x" })), "NotFound")
    })
  )

  it.effect("suggestion cursors stay behind consent, guards, the per-user cache and retry", () =>
    Effect.gen(function* () {
      const api = yield* client({ "Remote-User": "suggestion-reader" })
      yield* api.SetCardSourceEnabled({ sourceId: "cardex", enabled: false })
      const before = archive.hits()
      assert.strictEqual(
        yield* outcome(api.SourceSuggestions({ sourceId: "cardex", kind: "creators", prefix: "", page: null })),
        "SourceFailed:disabled"
      )
      assert.strictEqual(archive.hits(), before)
      yield* api.SetCardSourceEnabled({ sourceId: "cardex", enabled: true })
      const first = yield* api.SourceSuggestions({ sourceId: "cardex", kind: "creators", prefix: "", page: null })
      assert.isString(first.next)
      const second = yield* api.SourceSuggestions({
        sourceId: "cardex",
        kind: "creators",
        prefix: "",
        page: first.next
      })
      assert.isFalse(second.items.some((item) => first.items.some((old) => old.value === item.value)))
      const hits = archive.hits()
      yield* api.SourceSuggestions({ sourceId: "cardex", kind: "creators", prefix: "", page: first.next })
      assert.strictEqual(archive.hits(), hits)
      archive.failNext(503)
      assert.strictEqual(
        yield* outcome(api.SourceSuggestions({ sourceId: "cardex", kind: "tags", prefix: "f", page: null })),
        "SourceFailed:unreachable"
      )
      const retried = yield* api.SourceSuggestions({ sourceId: "cardex", kind: "tags", prefix: "f", page: null })
      assert.isAbove(retried.items.length, 0)
    })
  )

  it.effect("a regional file restriction is a plain regional state and can be retried", () =>
    Effect.gen(function* () {
      const api = yield* client({ "Remote-User": "regional-reader" })
      // Only the card file fails; the batch lookup still works.
      yield* Effect.promise(() =>
        fetch(`${archive.origin}/__fake/fail?status=451&path=/api/v1/download/${archive.cards[0]!.sha256}`)
      )
      assert.strictEqual(
        yield* outcome(api.SourceCard({ sourceId: "cardex", remoteId: archive.cards[0]!.slug })),
        "SourceFailed:region_unavailable"
      )
      const retried = yield* api.SourceCard({ sourceId: "cardex", remoteId: archive.cards[0]!.slug })
      assert.isString(retried.docJson)
    })
  )

  it.effect("a JSON-only card keeps its full portrait when added, including with the archive now offline", () =>
    Effect.gen(function* () {
      const api = yield* client(alice)
      const card = archive.cards.find((c) => c.originalOnly)!
      yield* api.SourceCard({ sourceId: "cardex", remoteId: card.slug })
      const hits = archive.hits()
      archive.failNext(503, 10)
      try {
        const added = yield* api.AdoptRemoteCard({ sourceId: "cardex", remoteId: card.slug })
        const opened = yield* api.OpenEditor({ refId: added.refId as RefId })
        assert.isString((opened.doc as { avatar_media_id?: string }).avatar_media_id)
        assert.strictEqual(archive.hits(), hits)
      } finally {
        archive.reset()
      }
    })
  )

  it.effect("Add to my cards stores the card as an import with its origin, once; results show it as held", () =>
    Effect.gen(function* () {
      const api = yield* client(alice)
      const card = archive.cards[8]!
      const before = yield* api.ListLibrary({ kind: "card" })
      const added = yield* api.AdoptRemoteCard({ sourceId: "cardex", remoteId: card.slug })
      assert.isFalse(added.existing)
      assert.strictEqual(added.name, card.name)
      const after = yield* api.ListLibrary({ kind: "card" })
      assert.lengthOf(after, before.length + 1)
      const ref = after.find((r) => r.id === added.refId)!
      assert.strictEqual(ref.entityId, added.entityId)
      assert.strictEqual(ref.label, card.name)
      // The document as the importer makes it, the card's page appended to `source`, its portrait stored.
      const opened = yield* api.OpenEditor({ refId: ref.id })
      const doc = opened.doc as { source?: ReadonlyArray<string>; avatar_media_id?: string | null; first_mes?: string }
      assert.include(doc.source ?? [], `${archive.origin}/c/${card.slug}`)
      assert.isString(doc.avatar_media_id)
      assert.include(doc.first_mes ?? "", card.name)
      assert.strictEqual(opened.revisionNumber, 1)
      // Again, from anywhere: the same card, nothing new.
      const again = yield* api.AdoptRemoteCard({ sourceId: "cardex", remoteId: card.slug })
      assert.deepStrictEqual([again.existing, again.entityId], [true, added.entityId])
      assert.lengthOf(yield* api.ListLibrary({ kind: "card" }), after.length)
      // Results and the card's page mark it as the user's; nobody else's.
      const page = yield* api.SourceSearch({
        sourceId: "cardex",
        query: { ...emptySourceQuery, text: card.name },
        page: null
      })
      const shown = page.items.find((item) => item.remoteId === card.slug)!
      assert.deepStrictEqual(shown.held, {
        entityId: added.entityId,
        refId: added.refId,
        archived: false,
        update: false
      })
      assert.deepStrictEqual(
        (yield* api.SourceCard({ sourceId: "cardex", remoteId: card.slug })).summary.held?.refId,
        added.refId
      )
      const theirs = yield* (yield* client(bob)).SourceSearch({
        sourceId: "cardex",
        query: { ...emptySourceQuery, text: card.name },
        page: null
      })
      assert.isUndefined(theirs.items.find((item) => item.remoteId === card.slug)?.held)
    })
  )

  it.effect("an adoption that fails stores nothing", () =>
    Effect.gen(function* () {
      const api = yield* client(alice)
      const before = yield* api.ListLibrary({ kind: "card" })
      // The source can't be reached for a card not cached yet: nothing is added.
      archive.failNext(503)
      const unreachable = yield* outcome(api.AdoptRemoteCard({ sourceId: "cardex", remoteId: archive.cards[11]!.slug }))
      assert.strictEqual(unreachable, "SourceFailed:unreachable")
      // A write that fails inside the transaction leaves neither the card nor its origin.
      const writer = yield* Writer
      const reader = yield* Reader
      const me = yield* api.Whoami()
      const failed = yield* Effect.exit(
        writer.AdoptRemoteCard({
          userId: me.id,
          sourceId: "cardex",
          remoteId: archive.cards[12]!.slug,
          remoteVersion: archive.cards[12]!.sha256,
          file: {
            label: "Broken",
            docJson: "{not json",
            docHash: "x",
            searchText: "",
            schemaVersion: 1,
            sourceName: "broken.json",
            sourceHash: "a".repeat(64) as never,
            media: [],
            noteDocJson: null
          }
        })
      )
      assert.isTrue(Exit.isFailure(failed))
      assert.lengthOf(yield* api.ListLibrary({ kind: "card" }), before.length)
      const held = yield* reader.HeldRemoteCards({
        userId: me.id,
        sourceId: "cardex",
        items: [{ remoteId: archive.cards[12]!.slug, sha256: null }]
      })
      assert.lengthOf(held, 0)
    })
  )

  it.effect("a first send with a source's card adds the card and makes its chat together (§4.5)", () =>
    Effect.gen(function* () {
      const api = yield* client(alice)
      const card = archive.cards[9]!
      const before = yield* api.ListLibrary({ kind: "card" })
      // The draft chat's card: under its placeholder id, its picture through the source's route.
      const { card: shown, summary } = yield* api.SourceCardForChat({ sourceId: "cardex", remoteId: card.slug })
      const placeholder = remoteEntityId("cardex", card.slug)
      assert.strictEqual(shown.card.entityId, placeholder)
      assert.strictEqual(shown.card.name, card.name)
      assert.isAbove(shown.greetings.length, 0)
      assert.match(shown.card.avatarMediaId ?? "", /^srcimg:cardex:/)
      assert.isUndefined(shown.regex)
      assert.isUndefined(summary.held)
      // Opening it adds nothing.
      assert.lengthOf(yield* api.ListLibrary({ kind: "card" }), before.length)
      const first = {
        cards: [placeholder],
        persona: null,
        greeting: null,
        greeters: [{ entityId: placeholder, greeting: 0 }],
        first: { _tag: "Send", content: "Hello there", speakerEntityId: null }
      } as const
      const started = yield* api.StartChat(first)
      const adopted = started.adopted?.[0]
      assert.deepStrictEqual([adopted?.placeholder, adopted?.existing, adopted?.name], [placeholder, false, card.name])
      const after = yield* api.ListLibrary({ kind: "card" })
      assert.lengthOf(after, before.length + 1)
      assert.isDefined(after.find((ref) => ref.entityId === adopted!.entityId))
      // The chat has the card in it, never the placeholder.
      const cast = yield* api.GetCast({ chatId: started.chat.id, slotId: started.entry.slotId })
      assert.include(cast.participants, adopted!.entityId)
      assert.notInclude(cast.participants as ReadonlyArray<string>, placeholder)
      // It's the user's from now on.
      const reopened = yield* api.SourceCardForChat({ sourceId: "cardex", remoteId: card.slug })
      assert.strictEqual(reopened.summary.held?.entityId, adopted!.entityId)
      // A draft chat opened before it was added, sent after: the same card, in a second chat.
      const again = yield* api.StartChat(first)
      assert.deepStrictEqual([again.adopted?.[0]?.entityId, again.adopted?.[0]?.existing], [adopted!.entityId, true])
      assert.notStrictEqual(again.chat.id, started.chat.id)
      assert.lengthOf(yield* api.ListLibrary({ kind: "card" }), after.length)
    })
  )

  it.effect("a first send that fails stores neither the card nor the chat", () =>
    Effect.gen(function* () {
      const api = yield* client(alice)
      const me = yield* api.Whoami()
      const before = yield* api.ListLibrary({ kind: "card" })
      // The source can't be reached for a card not cached yet: the message isn't sent.
      archive.failNext(503)
      const placeholder = remoteEntityId("cardex", archive.cards[13]!.slug)
      const unreachable = yield* Effect.flip(
        api.StartChat({
          cards: [placeholder],
          persona: null,
          greeting: null,
          first: { _tag: "Send", content: "Hello", speakerEntityId: null }
        })
      )
      assert.strictEqual(unreachable._tag, "ServerError")
      assert.include((unreachable as { message: string }).message, "wasn't sent")
      // The chat's write fails after the card's, in one transaction: neither stays.
      const card = archive.cards[10]!
      const sources = yield* CardSources.CardSources
      const prepared = yield* sources.prepareAdoption(me, "cardex", card.slug)
      const failed = yield* Effect.exit(
        (yield* Writer).AdoptAndStartChat({
          adopt: [{ placeholder: remoteEntityId("cardex", card.slug), ...prepared.payload }],
          start: {
            userId: me.id,
            cards: [remoteEntityId("cardex", card.slug)],
            persona: "no-such-persona" as EntityId,
            greeters: [],
            first: { _tag: "Send", content: "Hello", speakerEntityId: null },
            title: null
          }
        })
      )
      assert.isTrue(Exit.isFailure(failed))
      assert.lengthOf(yield* api.ListLibrary({ kind: "card" }), before.length)
      const held = yield* (yield* Reader).HeldRemoteCards({
        userId: me.id,
        sourceId: "cardex",
        items: [{ remoteId: card.slug, sha256: null }]
      })
      assert.lengthOf(held, 0)
    })
  )

  it.effect("a source's card's edits are drafts until Save adds the card with them as its revision 2 (§4.3)", () =>
    Effect.gen(function* () {
      const api = yield* client(alice)
      const me = yield* api.Whoami()
      const card = archive.cards[14]!
      const refId = remoteEntityId("cardex", card.slug) as unknown as RefId
      const field = textField(["description"])
      const before = yield* api.ListLibrary({ kind: "card" })
      // The editor opens on the cached card under its placeholder, and adds nothing.
      const opened = yield* api.OpenEditor({ refId })
      assert.strictEqual(opened.ref.id, refId)
      assert.strictEqual(opened.revisionNumber, 0)
      assert.strictEqual((opened.doc as { name?: string }).name, card.name)
      assert.lengthOf(opened.drafts, 0)
      assert.deepStrictEqual(yield* api.ListRevisions({ refId, limit: 10 }), [])
      const saved = yield* api.SaveEditorDraft({
        refId,
        field,
        draftId: null,
        content: "Edited before adding.",
        expectedRowVersion: null,
        expectedSession: null,
        baseRevisionId: opened.ref.headRevisionId
      })
      const again = yield* api.OpenEditor({ refId })
      assert.deepStrictEqual(
        again.drafts.map((d) => [d.key.targetKind, d.key.field, d.content]),
        [["remote_card", field, "Edited before adding."]]
      )
      assert.lengthOf(yield* api.ListLibrary({ kind: "card" }), before.length)
      // Nobody else sees it.
      assert.lengthOf((yield* (yield* client(bob)).OpenEditor({ refId })).drafts, 0)
      // Save: the card is the user's, the edit its revision 2.
      yield* api.CommitEditorDrafts({
        refId,
        expectedRowVersion: again.ref.rowVersion,
        fields: [{ field, draftId: saved.id, expectedRowVersion: saved.rowVersion }],
        message: null
      })
      const after = yield* api.ListLibrary({ kind: "card" })
      assert.lengthOf(after, before.length + 1)
      const [held] = yield* (yield* Reader).HeldRemoteCards({
        userId: me.id,
        sourceId: "cardex",
        items: [{ remoteId: card.slug, sha256: null }]
      })
      assert.isDefined(held)
      const own = yield* api.OpenEditor({ refId: held!.refId })
      assert.strictEqual(own.revisionNumber, 2)
      assert.strictEqual((own.doc as { description?: string }).description, "Edited before adding.")
      assert.lengthOf(
        own.drafts.filter((d) => d.status === "active"),
        0
      )
      assert.lengthOf(yield* api.ListRevisions({ refId: held!.refId, limit: 10 }), 2)
      // An editor still open on the placeholder carries on with the user's card.
      const carried = yield* api.OpenEditor({ refId })
      assert.deepStrictEqual([carried.ref.id, carried.revisionNumber], [held!.refId, 2])
    })
  )

  it.effect("Add to my cards after an edit keeps it as the card's unsaved edit; Revert drops edits first", () =>
    Effect.gen(function* () {
      const api = yield* client(alice)
      const card = archive.cards[15]!
      const refId = remoteEntityId("cardex", card.slug) as unknown as RefId
      const field = textField(["personality"])
      const write = (content: string) =>
        Effect.gen(function* () {
          const opened = yield* api.OpenEditor({ refId })
          // As the editor does: carrying on from the field's draft, ended or not.
          const existing = opened.drafts.find((d) => d.key.field === field)
          return yield* api.SaveEditorDraft({
            refId,
            field,
            draftId: null,
            content,
            expectedRowVersion: existing?.rowVersion ?? null,
            expectedSession: existing?.session ?? null,
            baseRevisionId: null
          })
        })
      yield* write("Dropped.")
      assert.strictEqual((yield* api.RevertEditorDrafts({ refId })).reverted, 1)
      const reverted = yield* api.OpenEditor({ refId })
      assert.lengthOf(
        reverted.drafts.filter((d) => d.status === "active"),
        0
      )
      yield* write("Kept.")
      const added = yield* api.AdoptRemoteCard({ sourceId: "cardex", remoteId: card.slug })
      const addedRef = added.refId as RefId
      const own = yield* api.OpenEditor({ refId: addedRef })
      assert.strictEqual(own.revisionNumber, 1)
      const kept = own.drafts.find((d) => d.status === "active" && d.key.field === field)
      assert.deepStrictEqual([kept?.key.targetKind, kept?.content], ["entity_field", "Kept."])
      // Saved as any edit is.
      yield* api.CommitEditorDrafts({
        refId: addedRef,
        expectedRowVersion: own.ref.rowVersion,
        fields: [{ field, draftId: kept!.id, expectedRowVersion: kept!.rowVersion }],
        message: null
      })
      assert.strictEqual((yield* api.OpenEditor({ refId: addedRef })).revisionNumber, 2)
    })
  )

  it.effect("a Save on a source's card that fails stores no card and keeps the edit", () =>
    Effect.gen(function* () {
      const api = yield* client(alice)
      const me = yield* api.Whoami()
      const card = archive.cards[16]!
      const refId = remoteEntityId("cardex", card.slug) as unknown as RefId
      const field = textField(["scenario"])
      const before = yield* api.ListLibrary({ kind: "card" })
      const saved = yield* api.SaveEditorDraft({
        refId,
        field,
        draftId: null,
        content: "Not lost.",
        expectedRowVersion: null,
        expectedSession: null,
        baseRevisionId: null
      })
      // The edit changed meanwhile (another tab): the commit fails after the card's write.
      const failed = yield* outcome(
        api.CommitEditorDrafts({
          refId,
          expectedRowVersion: 0,
          fields: [{ field, draftId: saved.id, expectedRowVersion: saved.rowVersion + 5 }],
          message: null
        })
      )
      assert.notStrictEqual(failed, "ok")
      assert.lengthOf(yield* api.ListLibrary({ kind: "card" }), before.length)
      const held = yield* (yield* Reader).HeldRemoteCards({
        userId: me.id,
        sourceId: "cardex",
        items: [{ remoteId: card.slug, sha256: null }]
      })
      assert.lengthOf(held, 0)
      const still = yield* api.OpenEditor({ refId })
      assert.deepStrictEqual(
        still.drafts.map((d) => [d.key.targetKind, d.status, d.content]),
        [["remote_card", "active", "Not lost."]]
      )
    })
  )

  it.effect("a valid card larger than the cache cap can still be opened and adopted", () =>
    Effect.gen(function* () {
      const api = yield* client(alice)
      const service = yield* CardSources.CardSources
      const adapter = fakeCardexAdapter(archive)
      yield* service.registry.register({
        ...adapter,
        card: (http, id) =>
          adapter
            .card(http, id)
            .pipe(
              Effect.map((file) => ({ ...file, bytes: Buffer.concat([file.bytes, new Uint8Array(17 * 1024 * 1024)]) }))
            )
      })
      yield* api.SetSourceCacheCap({ bytes: 16 * 1024 * 1024 })
      const card = archive.cards[45]!
      const opened = yield* api.SourceCard({ sourceId: "cardex", remoteId: card.slug })
      assert.strictEqual((JSON.parse(opened.docJson!) as { name: string }).name, card.name)
      const added = yield* api.AdoptRemoteCard({ sourceId: "cardex", remoteId: card.slug })
      assert.isFalse(added.existing)
      assert.strictEqual((yield* api.OpenEditor({ refId: added.refId as RefId })).revisionNumber, 1)
    }).pipe(
      Effect.ensuring(
        Effect.flatMap(client(alice), (api) => api.SetSourceCacheCap({ bytes: 1024 ** 3 })).pipe(Effect.orDie)
      ),
      Effect.scoped
    )
  )

  it.effect("archive errors are worded by kind", () =>
    Effect.gen(function* () {
      const api = yield* client(alice)
      archive.failNext(404)
      assert.strictEqual(
        yield* outcome(api.SourceCard({ sourceId: "cardex", remoteId: "gone-card" })),
        "SourceFailed:not_found"
      )
      archive.failNext(500)
      const query = { ...emptySourceQuery, text: "server-error" }
      assert.strictEqual(
        yield* outcome(api.SourceSearch({ sourceId: "cardex", query, page: null })),
        "SourceFailed:unreachable"
      )
    })
  )

  // --- Updates (§3.8, §11 phase 5).
  const newerFile = (entityId: string, headers: Record<string, string>) =>
    Effect.flatMap(base, (url) => Effect.promise(() => fetch(`${url}/sources/held/${entityId}/file`, { headers })))
  const importFile = (bytes: Uint8Array, query: Record<string, string>) =>
    Effect.flatMap(base, (url) =>
      Effect.promise(() =>
        fetch(`${url}/library/import?${new URLSearchParams(query)}`, {
          method: "POST",
          headers: { ...alice, "content-type": "application/octet-stream" },
          body: bytes
        })
      )
    )

  it.effect("a newer version: Check records it; its file stages for merging; taking it ends the notice", () =>
    Effect.gen(function* () {
      const api = yield* client(alice)
      const card = archive.cards[20]!
      const added = yield* api.AdoptRemoteCard({ sourceId: "cardex", remoteId: card.slug })
      const entityId = added.entityId
      // The origin is local: reading it sends nothing.
      archive.reset()
      assert.deepStrictEqual(yield* api.CardOrigin({ entityId }), {
        entityId,
        sourceId: "cardex",
        sourceName: "cardex",
        remoteId: card.slug,
        remoteVersion: card.sha256,
        newerVersion: null
      })
      assert.strictEqual(archive.hits(), 0)
      // Nothing newer yet; then the author publishes one.
      assert.isNull((yield* api.CheckRemoteVersion({ entityId })).newerVersion)
      const next = archive.publish(card.slug)
      const checked = yield* api.CheckRemoteVersion({ entityId })
      assert.strictEqual(checked.newerVersion, next.sha256)
      assert.isTrue(archive.paths().every((path) => path.startsWith("/api/v1/cards/batch")))
      assert.isTrue((yield* api.ListLibrary({ kind: "card" })).find((r) => r.id === added.refId)!.updateAvailable)
      // The newer file, fetched when the update is opened, goes on the import line like a file from disk.
      const response = yield* newerFile(entityId, alice)
      assert.strictEqual(response.status, 200)
      assert.strictEqual(response.headers.get("x-remote-version"), next.sha256)
      const bytes = new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()))
      const staged = yield* importFile(bytes, { name: `${card.slug}.png`, into: added.refId, mode: "merge" })
      assert.strictEqual(staged.status, 200, yield* Effect.promise(() => staged.clone().text()))
      const stagedRevision = (
        (yield* Effect.promise(() => staged.json())) as {
          library?: { stagedRevisionId?: string }
        }
      ).library?.stagedRevisionId
      assert.isString(stagedRevision)
      const status = yield* api.ForkMergeStatus({ refId: added.refId as RefId })
      assert.isTrue(status.versions.some((revision) => revision.id === stagedRevision))
      const taken = yield* api.TakeRemoteVersion({ entityId, version: next.sha256 })
      assert.deepStrictEqual([taken.remoteVersion, taken.newerVersion], [next.sha256, null])
      // Nobody else sees or changes it.
      const theirs = yield* client(bob)
      assert.isNull(yield* theirs.CardOrigin({ entityId }))
      assert.strictEqual(yield* outcome(theirs.CheckRemoteVersion({ entityId })), "NotFound")
      assert.strictEqual(yield* outcome(theirs.TakeRemoteVersion({ entityId, version: "x" })), "NotFound")
      assert.strictEqual(yield* outcome(theirs.AddRemoteVersionAsCard({ entityId })), "NotFound")
      assert.strictEqual((yield* newerFile(entityId, bob)).status, 404)
      // Turned off, the card shows no origin and nothing is sent.
      yield* api.SetCardSourceEnabled({ sourceId: "cardex", enabled: false })
      archive.reset()
      assert.isNull(yield* api.CardOrigin({ entityId }))
      assert.strictEqual(yield* outcome(api.CheckRemoteVersion({ entityId })), "SourceFailed:disabled")
      assert.strictEqual(archive.hits(), 0)
      yield* api.SetCardSourceEnabled({ sourceId: "cardex", enabled: true })
    })
  )

  it.effect("Add as a separate card: the newer file as a card of its own, the first card takes that version", () =>
    Effect.gen(function* () {
      const api = yield* client(alice)
      const card = archive.cards[21]!
      const added = yield* api.AdoptRemoteCard({ sourceId: "cardex", remoteId: card.slug })
      const next = archive.publish(card.slug)
      yield* api.CheckRemoteVersion({ entityId: added.entityId })
      const before = (yield* api.ListLibrary({ kind: "card" })).length
      const separate = yield* api.AddRemoteVersionAsCard({ entityId: added.entityId })
      assert.notStrictEqual(separate.entityId, added.entityId)
      assert.strictEqual(separate.name, card.name)
      assert.lengthOf(yield* api.ListLibrary({ kind: "card" }), before + 1)
      const doc = (yield* api.OpenEditor({ refId: separate.refId as RefId })).doc as {
        description?: string
        source?: ReadonlyArray<string>
      }
      assert.include(doc.description ?? "", "now keeps a garden")
      assert.include(doc.source ?? [], `${archive.origin}/c/${card.slug}`)
      // The first card keeps its text and its origin, now at that version; the new one has none.
      const first = (yield* api.OpenEditor({ refId: added.refId as RefId })).doc as { description?: string }
      assert.notInclude(first.description ?? "", "now keeps a garden")
      const origin = yield* api.CardOrigin({ entityId: added.entityId })
      assert.deepStrictEqual([origin?.remoteVersion, origin?.newerVersion], [next.sha256, null])
      assert.isNull(yield* api.CardOrigin({ entityId: separate.entityId }))
    })
  )

  it.effect("a newer version keeps the card's link back to its page on the source", () =>
    Effect.gen(function* () {
      const api = yield* client(alice)
      const card = archive.cards[23]!
      const page = `${archive.origin}/c/${card.slug}`
      const added = yield* api.AdoptRemoteCard({ sourceId: "cardex", remoteId: card.slug })
      const sourcesOf = Effect.map(
        api.OpenEditor({ refId: added.refId as RefId }),
        (opened) => (opened.doc as { source?: ReadonlyArray<string> }).source ?? []
      )
      assert.include(yield* sourcesOf, page)
      archive.publish(card.slug)
      yield* api.CheckRemoteVersion({ entityId: added.entityId })
      const response = yield* newerFile(added.entityId, alice)
      assert.strictEqual(response.status, 200)
      assert.strictEqual(decodeURIComponent(response.headers.get("x-source-link") ?? ""), page)
      const bytes = new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()))
      const preview = (query: Record<string, string>) =>
        Effect.flatMap(
          importFile(bytes, { name: `${card.slug}.png`, into: added.refId, mode: "preview", ...query }),
          (r) => Effect.promise(() => r.json() as Promise<{ docJson: string; card: { headRevisionId: string } }>)
        )
      // The source's file doesn't name its own page: as it is, taking it would drop the link.
      assert.notInclude(JSON.parse((yield* preview({})).docJson).source ?? [], page)
      const shown = yield* preview({ link: page })
      assert.include(JSON.parse(shown.docJson).source, page)
      // Merge stages it with the link; Replace keeps it.
      const staged = yield* importFile(bytes, {
        name: `${card.slug}.png`,
        into: added.refId,
        mode: "merge",
        link: page
      })
      assert.strictEqual(staged.status, 200)
      const replaced = yield* importFile(bytes, {
        name: `${card.slug}.png`,
        into: added.refId,
        mode: "replace",
        head: shown.card.headRevisionId,
        link: page
      })
      assert.strictEqual(replaced.status, 200, yield* Effect.promise(() => replaced.clone().text()))
      const after = yield* api.OpenEditor({ refId: added.refId as RefId })
      assert.include((after.doc as { description?: string }).description ?? "", "now keeps a garden")
      assert.deepStrictEqual(
        ((after.doc as { source?: ReadonlyArray<string> }).source ?? []).filter((entry) => entry === page),
        [page]
      )
      // `link` is only for a new version of a card.
      const misuse = yield* importFile(bytes, { name: `${card.slug}.png`, link: page })
      assert.strictEqual(misuse.status, 400)
    })
  )

  it.effect("fresh results record a newer version; a page from the cache records nothing", () =>
    Effect.gen(function* () {
      const api = yield* client(alice)
      const card = archive.cards[22]!
      const added = yield* api.AdoptRemoteCard({ sourceId: "cardex", remoteId: card.slug })
      const query = { ...emptySourceQuery, text: card.name }
      const held = (page: { items: ReadonlyArray<{ remoteId: string; held?: { update: boolean } }> }) =>
        page.items.find((item) => item.remoteId === card.slug)?.held
      assert.isFalse(held(yield* api.SourceSearch({ sourceId: "cardex", query, page: null }))!.update)
      const next = archive.publish(card.slug)
      // The same query again is the cached page, from before: it reports nothing new.
      assert.isFalse(held(yield* api.SourceSearch({ sourceId: "cardex", query, page: null }))!.update)
      assert.isNull((yield* api.CardOrigin({ entityId: added.entityId }))!.newerVersion)
      // Another query asks the archive: its page reports the newer version, recorded.
      const fresh = yield* api.SourceSearch({ sourceId: "cardex", query: { ...query, sort: "name" }, page: null })
      assert.isTrue(held(fresh)!.update)
      assert.strictEqual((yield* api.CardOrigin({ entityId: added.entityId }))!.newerVersion, next.sha256)
      // The cached page now shows it too, from what was recorded, and doesn't undo it.
      assert.isTrue(held(yield* api.SourceSearch({ sourceId: "cardex", query, page: null }))!.update)
      assert.strictEqual((yield* api.CardOrigin({ entityId: added.entityId }))!.newerVersion, next.sha256)
    })
  )
})

describe("the fake archive keeps cardex v1's rules", () => {
  const get = (path: string) => fetch(`${archive.origin}${path}`, { redirect: "manual" })

  it.effect("limit 1–100, a cursor only for its own query, 308 for a non-canonical batch, WebP thumbnails", () =>
    Effect.gen(function* () {
      const status = (path: string) => Effect.promise(() => get(path).then((r) => r.status))
      assert.strictEqual(yield* status("/api/v1/search?limit=0"), 400)
      assert.strictEqual(yield* status("/api/v1/search?limit=101"), 400)
      assert.strictEqual(yield* status("/api/v1/search?nsfw=sfw"), 400)
      assert.strictEqual(yield* status("/api/v1/search?mode=fts&page=2"), 200)
      const first = (yield* Effect.promise(() => get("/api/v1/search?limit=10").then((r) => r.json()))) as {
        next_cursor: string
        page_size: number
      }
      assert.strictEqual(first.page_size, 10)
      assert.strictEqual(yield* status(`/api/v1/search?limit=10&cursor=${first.next_cursor}`), 200)
      assert.strictEqual(yield* status(`/api/v1/search?limit=10&q=amber&cursor=${first.next_cursor}`), 400)
      assert.strictEqual(yield* status(`/api/v1/search?limit=20&cursor=${first.next_cursor}`), 400)
      assert.strictEqual(yield* status(`/api/v1/search?mode=semantic&cursor=${first.next_cursor}`), 400)
      const semantic = (yield* Effect.promise(() =>
        get("/api/v1/search?mode=semantic&q=quiet&limit=100&page=2").then((r) => r.json())
      )) as { next_cursor: string | null; items: ReadonlyArray<unknown> }
      assert.isNull(semantic.next_cursor)
      assert.lengthOf(semantic.items, 20)
      const [a, b] = [archive.cards[5]!.slug, archive.cards[2]!.slug].sort()
      for (const raw of [`${b}%2C${a}%2C${b}`, `${a},${b}`]) {
        const redirected = yield* Effect.promise(() => get(`/api/v1/cards/batch?ids=${raw}`))
        assert.strictEqual(redirected.status, 308)
        assert.strictEqual(redirected.headers.get("location"), `/api/v1/cards/batch?ids=${a}%2C${b}`)
      }
      assert.strictEqual(yield* status(`/api/v1/cards/batch?ids=${a}%2C${b}`), 200)
      // A card's page is an envelope, not a summary; tags come in one too.
      const detail = (yield* Effect.promise(() => get(`/api/v1/cards/${a}`).then((r) => r.json()))) as {
        card: Record<string, unknown>
      }
      assert.isUndefined(detail.card.name)
      assert.strictEqual(yield* status("/api/v1/cards/no-such-card"), 404)
      const tags = (yield* Effect.promise(() => get("/api/v1/tags?q=s").then((r) => r.json()))) as {
        tags: ReadonlyArray<{ slug: string }>
      }
      assert.isTrue(tags.tags.length > 0 && tags.tags.every((t) => t.slug.startsWith("s")))
      const thumb = yield* Effect.promise(() => get(`/t/${archive.cards[0]!.sha256}.512.webp?v=1`))
      assert.strictEqual(thumb.headers.get("content-type"), "image/webp")
      const bytes = new Uint8Array(yield* Effect.promise(() => thumb.arrayBuffer()))
      assert.strictEqual(Buffer.from(bytes.subarray(8, 12)).toString("latin1"), "WEBP")
    })
  )

  it.effect("the adapter asks for versions in the canonical order, so nothing is redirected", () =>
    Effect.gen(function* () {
      archive.reset()
      const http = {
        apiKey: null,
        get: (url: URL) =>
          Effect.promise(async () => {
            const response = await fetch(url, { redirect: "manual" })
            const bytes = new Uint8Array(await response.arrayBuffer())
            return {
              status: response.status,
              headers: response.headers,
              bytes,
              json: () => JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown
            }
          })
      }
      const adapter = fakeCardexAdapter(archive)
      const ids = [archive.cards[9]!.slug, archive.cards[1]!.slug, archive.cards[9]!.slug, "no-such-card"]
      const versions = yield* adapter.versions!(http as never, ids)
      assert.deepStrictEqual(
        versions.map((v) => v.remoteId).sort(),
        [archive.cards[1]!.slug, archive.cards[9]!.slug].sort()
      )
      assert.strictEqual(
        versions.find((v) => v.remoteId === archive.cards[1]!.slug)!.version.id,
        archive.cards[1]!.sha256
      )
      assert.lengthOf(archive.paths(), 1)
    })
  )
})

describe("the registry", () => {
  it.effect("a plugin adds, replaces or disables a source for the length of its scope", () =>
    Effect.gen(function* () {
      const service = yield* CardSources.CardSources
      const replacement: CardSourceAdapter = {
        ...fakeCardexAdapter(archive),
        name: "cardex (plugin)"
      }
      const user = { id: "u", handle: "u", displayName: "u", role: "user" } as never
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* service.registry.register(replacement)
          yield* service.registry.register({ ...fakeCardexAdapter(archive), id: "second", name: "second" })
          const listed = yield* service.list(user)
          assert.deepStrictEqual(
            listed.sources.map((s) => s.name),
            ["cardex (plugin)", "second"]
          )
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* service.registry.disable("cardex")
              assert.deepStrictEqual(
                (yield* service.list(user)).sources.map((s) => s.id),
                ["second"]
              )
            })
          )
        })
      )
      assert.deepStrictEqual(
        (yield* service.list(user)).sources.map((s) => s.name),
        ["cardex"]
      )
    }).pipe(Effect.provide(Layer.fresh(serverLayer(testConfig(), undefined, undefined, sources))))
  )
})

describe("the guards (§6.2)", () => {
  const network = (seen: Array<string>) => ({
    fetchFor: () =>
      (async (input: string) => {
        seen.push(input)
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
      }) as unknown as typeof fetch
  })
  const remote: CardSourceAdapter = {
    ...cardexAdapter({ origin: "https://archive.example" }),
    local: false
  }

  it("private and loopback addresses are recognized, IPv4-mapped too", () => {
    for (const ip of [
      "0.0.0.0",
      "::",
      "::ffff:0.0.0.0",
      "127.0.0.1",
      "10.1.2.3",
      "192.168.7.40",
      "172.20.0.1",
      "169.254.1.1",
      "::1",
      "fd00::1",
      "::ffff:10.0.0.1"
    ])
      assert.isTrue(isPrivateAddress(ip), ip)
    for (const ip of ["93.184.216.34", "2606:4700::1111"]) assert.isFalse(isPrivateAddress(ip), ip)
  })

  it.effect("only the adapter's own hosts, and never a private address unless the admin named the host", () =>
    Effect.gen(function* () {
      const seen: Array<string> = []
      let resolved = ["10.0.0.5"]
      let listed: ReadonlyArray<string> = []
      const http = makeSourceHttp(remote, null, {
        network: network(seen),
        limiter: makeLimiter(),
        bypassEntries: () => listed,
        resolve: async () => resolved
      })
      const elsewhere = yield* Effect.exit(http.get(new URL("https://evil.example/x"), "json"))
      assert.isTrue(Exit.isFailure(elsewhere))
      const plain = yield* Effect.exit(http.get(new URL("http://archive.example/x"), "json"))
      assert.isTrue(Exit.isFailure(plain))
      const rebound = yield* Effect.flip(http.get(new URL("https://archive.example/api"), "json"))
      assert.strictEqual(rebound.reason, "unreachable")
      assert.lengthOf(seen, 0)
      listed = ["archive.example"]
      yield* http.get(new URL("https://archive.example/api"), "json")
      listed = []
      resolved = ["93.184.216.34"]
      yield* http.get(new URL("https://archive.example/api"), "json")
      assert.lengthOf(seen, 2)
    })
  )

  it.effect("a refusal carries the error code its body named", () =>
    Effect.gen(function* () {
      let body: string = JSON.stringify({ error: "invalid_cursor", message: "the cursor expired" })
      let status = 400
      const refusing = {
        fetchFor: () => (async () => new Response(body, { status })) as unknown as typeof fetch
      }
      const http = makeSourceHttp(remote, null, {
        network: refusing,
        limiter: makeLimiter(),
        bypassEntries: () => [],
        resolve: async () => ["93.184.216.34"]
      })
      const named = yield* Effect.flip(http.get(new URL("https://archive.example/api"), "json"))
      assert.strictEqual(named.reason, "bad_response")
      assert.strictEqual(named.code, "invalid_cursor")
      body = "not json"
      const plain = yield* Effect.flip(http.get(new URL("https://archive.example/api"), "json"))
      assert.strictEqual(plain.reason, "bad_response")
      assert.isUndefined(plain.code)
      // A source with no key that answers 403 refused the request, not a key.
      status = 451
      const regional = yield* Effect.flip(http.get(new URL("https://archive.example/api"), "card"))
      assert.strictEqual(regional.reason, "region_unavailable")
      status = 403
      const refused = yield* Effect.flip(http.get(new URL("https://archive.example/api"), "json"))
      assert.strictEqual(refused.reason, "refused")
    })
  )

  it.effect("responses past their cap are refused", () =>
    Effect.gen(function* () {
      const big = {
        fetchFor: () =>
          (async () => new Response(new Uint8Array(3 * 1024 * 1024), { status: 200 })) as unknown as typeof fetch
      }
      const http = makeSourceHttp(remote, null, {
        network: big,
        limiter: makeLimiter(),
        bypassEntries: () => [],
        resolve: async () => ["93.184.216.34"]
      })
      const json = yield* Effect.flip(http.get(new URL("https://archive.example/api"), "json"))
      assert.strictEqual(json.reason, "bad_response")
      const image = yield* http.get(new URL("https://archive.example/i/x.png"), "image")
      assert.strictEqual(image.bytes.byteLength, 3 * 1024 * 1024)
    })
  )

  it.effect("a 429 honours Retry-After: requests fail at once until it passes", () =>
    Effect.gen(function* () {
      let now = 1_000_000
      const limiter = makeLimiter(() => now)
      let calls = 0
      const limited = {
        fetchFor: () =>
          (async () => {
            calls++
            return new Response(null, { status: 429, headers: { "retry-after": "20" } })
          }) as unknown as typeof fetch
      }
      const http = makeSourceHttp(remote, null, {
        network: limited,
        limiter,
        bypassEntries: () => [],
        resolve: async () => ["93.184.216.34"]
      })
      const first = yield* Effect.flip(http.get(new URL("https://archive.example/api"), "json"))
      assert.strictEqual(first.reason, "rate_limited")
      assert.strictEqual(first.retryAfterMs, 20_000)
      const second = yield* Effect.flip(http.get(new URL("https://archive.example/api"), "json"))
      assert.strictEqual(second.retryAfterMs, 20_000)
      assert.strictEqual(calls, 1)
      now += 21_000
      yield* Effect.flip(http.get(new URL("https://archive.example/api"), "json"))
      assert.strictEqual(calls, 2)
    })
  )
})

describe("the rate limit and coalescing (§5.5)", () => {
  it.live("a burst, then requests wait for tokens; a long wait fails as rate limited", () =>
    Effect.gen(function* () {
      let now = 0
      const limiter = makeLimiter(() => now)
      const rate = { perSecond: 2, burst: 8 }
      for (let n = 0; n < 8; n++) yield* limiter.take("s", rate)
      // The next ten each reserve a token and wait for it, half a second apart, up to 5 s.
      const waiting = []
      for (let n = 0; n < 10; n++)
        waiting.push(yield* Effect.forkChild(limiter.take("s", rate), { startImmediately: true }))
      // The eleventh would wait past five seconds: refused at once, saying when to try again.
      const refused = yield* Effect.flip(limiter.take("s", rate))
      assert.strictEqual(refused.reason, "rate_limited")
      assert.isAtLeast(refused.retryAfterMs!, 5000)
      for (const fiber of waiting) yield* Fiber.interrupt(fiber)
      // Time passes and the bucket fills again.
      now += 10_000
      yield* limiter.take("s", rate)
    })
  )

  it.effect("backoff doubles on 429s in a row, to five minutes, and starts over after a success", () =>
    Effect.sync(() => {
      const limiter = makeLimiter(() => 0)
      const delays = Array.from({ length: 12 }, () => limiter.limited("s", undefined))
      assert.deepStrictEqual(delays.slice(0, 4), [1000, 2000, 4000, 8000])
      assert.strictEqual(delays.at(-1), 5 * 60_000)
      limiter.passed("s")
      assert.strictEqual(limiter.limited("s", undefined), 1000)
      assert.strictEqual(limiter.limited("s", 30_000), 30_000)
    })
  )

  it.live("identical concurrent requests share one run; the last to leave cancels it", () =>
    Effect.gen(function* () {
      const coalescer = makeCoalescer()
      let runs = 0
      let interrupted = false
      const slow = Effect.sync(() => runs++).pipe(
        Effect.andThen(Effect.sleep("50 millis")),
        Effect.as("page"),
        Effect.onInterrupt(() => Effect.sync(() => void (interrupted = true)))
      )
      const [a, b] = yield* Effect.all([coalescer.run("k", slow), coalescer.run("k", slow)], { concurrency: 2 })
      assert.deepStrictEqual([a, b, runs], ["page", "page", 1])
      const one = yield* Effect.forkChild(
        coalescer.run(
          "j",
          Effect.andThen(
            Effect.sync(() => runs++),
            Effect.never
          )
        )
      )
      const two = yield* Effect.forkChild(coalescer.run("j", Effect.never))
      yield* Effect.sleep("10 millis")
      yield* Fiber.interrupt(one)
      assert.isFalse(interrupted)
      assert.strictEqual(coalescer.size(), 1)
      yield* Fiber.interrupt(two)
      yield* Effect.sleep("10 millis")
      assert.strictEqual(coalescer.size(), 0)
      const cancelled = yield* Effect.forkChild(coalescer.run("i", slow))
      yield* Effect.sleep("5 millis")
      yield* Fiber.interrupt(cancelled)
      yield* Effect.sleep("10 millis")
      assert.isTrue(interrupted)
    })
  )
})

describe("the cache (§4.1)", () => {
  const made: Array<string> = []
  afterAll(() => {
    for (const dir of made) rmSync(dir, { recursive: true, force: true })
  })
  const MINUTE = 60_000
  const DAY = 24 * 60 * MINUTE
  const fresh = (now: () => number, capBytes = () => 1024 ** 3) => {
    const dataDir = mkdtempSync(join(tmpdir(), "rp-source-cache-"))
    made.push(dataDir)
    return { dataDir, cache: makeSourceCache({ dataDir, now, capBytes }) }
  }
  const key = (user: string, kind: "page" | "card" | "image", id: string) => ({ user, source: "cardex", kind, id })

  it.effect("pages last 10 minutes from when fetched; cards 7 days from when last opened", () =>
    Effect.gen(function* () {
      let now = 0
      const { cache } = fresh(() => now)
      yield* cache.scan
      yield* cache.put(key("a", "page", "q"), { value: { items: [] } })
      yield* cache.put(key("a", "card", "c"), { bytes: new Uint8Array([1, 2, 3]) })
      now += 9 * MINUTE
      assert.isNotNull(yield* cache.get(key("a", "page", "q")))
      now += 2 * MINUTE
      assert.isNull(yield* cache.get(key("a", "page", "q")))
      now += 6 * DAY
      assert.isNotNull(yield* cache.get(key("a", "card", "c")))
      now += 6 * DAY
      // Opened a day ago, six days after it was fetched: still kept.
      assert.isNotNull(yield* cache.get(key("a", "card", "c")))
      now += 8 * DAY
      yield* cache.sweep
      assert.isFalse(cache.has(key("a", "card", "c")))
      assert.strictEqual(cache.usedBytes(), 0)
    })
  )

  it.effect("a pinned entry outlives its age; past the cap, unpinned entries go first, least recent first", () =>
    Effect.gen(function* () {
      let now = 0
      const { cache } = fresh(
        () => now,
        () => 2_000
      )
      yield* cache.scan
      const bytes = (fill: number) => new Uint8Array(600).fill(fill)
      yield* cache.put(key("a", "card", "pinned"), { bytes: bytes(1) })
      const release = cache.pin(key("a", "card", "pinned"))
      now += 1
      yield* cache.put(key("a", "card", "old"), { bytes: bytes(2) })
      now += 1
      yield* cache.put(key("a", "card", "new"), { bytes: bytes(3) })
      now += 1
      // A fourth past the cap: the oldest unpinned goes, not the pinned one opened before it.
      yield* cache.put(key("a", "card", "newest"), { bytes: bytes(4) })
      assert.isTrue(cache.has(key("a", "card", "pinned")))
      assert.isFalse(cache.has(key("a", "card", "old")))
      assert.isTrue(cache.has(key("a", "card", "newest")))
      now += 30 * DAY
      yield* cache.sweep
      assert.isTrue(cache.has(key("a", "card", "pinned")))
      assert.isFalse(cache.has(key("a", "card", "new")))
      yield* release
      yield* cache.sweep
      assert.isFalse(cache.has(key("a", "card", "pinned")))
    })
  )

  it.effect("identical bytes are stored once; a user's clearing leaves another's entries", () =>
    Effect.gen(function* () {
      const { cache, dataDir } = fresh(() => 0)
      yield* cache.scan
      const same = new Uint8Array(1000).fill(7)
      yield* cache.put(key("a", "image", "x"), { bytes: same })
      yield* cache.put(key("b", "image", "x"), { bytes: same })
      assert.isBelow(cache.usedBytes(), 1700)
      yield* cache.clearUser("a", null)
      assert.isFalse(cache.has(key("a", "image", "x")))
      const entry = yield* cache.get(key("b", "image", "x"))
      assert.deepStrictEqual([...(yield* cache.readBlob(entry!.blob!)).subarray(0, 3)], [7, 7, 7])
      // A restart rebuilds the index from the files.
      const again = makeSourceCache({ dataDir, now: () => 0 })
      yield* again.scan
      assert.isTrue(again.has(key("b", "image", "x")))
      assert.isFalse(again.has(key("a", "image", "x")))
    })
  )
})

// A failure the UI words by kind keeps its tag through the RPC.
it("SourceFailed carries its reason", () => {
  assert.strictEqual(new SourceFailed({ sourceId: "s", reason: "disabled", message: "off" }).reason, "disabled")
})
