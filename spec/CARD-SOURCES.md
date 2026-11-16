# Card sources: browsing a card archive as part of your cards

**Status**: Proposed, 2026-11-06 (job `cardsource`, design only, no code). Phases 1 to 6 of §11 (adding a card, held cards, `card_origins` and the source-hash index, Inspect, the draft chat, its first send and its card editor; updates; Only tried) are built (cardsrc1 and cardsrc2, 2026-11-07; ARCHITECTURE §11.5, with the deviations in DESIGN's cardsrc1 and cardsrc2 entries): this spec is obsolete for them, and the rest stays proposed. Everything here is **[P]** unless it cites a **[D]** or is marked **Open**. It is a delta from master `267f4c4f`: ARCHITECTURE §5 ("Characters", "Library", the workbench), §11 (Importing), §12 ("Chats from cards", "The pending chat is the chat page"), §14.5b (thumbnail workers), §14.6 (the editors), DESIGN §4 (card metadata, forks and imports), §11 (security) and §12 (the card archive entries). reference-harness has no card archive or card library, so there's nothing to take from it. No chat logs or card definitions were read, and no real archive card is used in tests or on a development server.

**Built schemafinal (owner decisions, 2026-11-16):** a card whose source link names an archive entry counts as the user's without a byte match (a `linked` origin; updates still go through Review and merge); after Add as a separate card both cards track the source; each card has Ignore future updates. This supersedes §3.7–3.8 and the cardsrc2 choices where they differ; ARCHITECTURE §11.5 "Source tracking" records it (BASELINE CHANGED).

**Built and verified 2026-11-12 (cardexlive):** §0's every-criterion requirement is implemented for character results using §2.3/§3.2's existing generic panel, including the live v1 additions and all sort directions. That subset is obsolete as an implementation proposal; ARCHITECTURE §11.5 records it. Standalone lorebook/all-kind results still need an owner-approved opening/layout choice. Manual live verification found the advertised docs URL unavailable and name-with-text sorting failing upstream; no real card became a fixture.

**Built 2026-11-12 (cardex2):** long choice lists use the existing picker and date criteria are date fields (ARCHITECTURE §11.5, "Long choices and dates"); creator pages (ARCHITECTURE §11.5, "Creators"); §3.7's recognition by a card's Sources, the newest live fork holding a binned card's origin, and each card's versions and forks on the source (ARCHITECTURE §11.5, "Families and recognition"). Built deltas: the creator view is the browsing view with the creator filter set and their profile above it, not a page of its own, so every filter and sort still applies (the archive's own list of a creator's cards is not used); a recognized card has no version recorded, so it offers no update check; cards imported before this change are recognized only when imported again. §4.1's pinning is built for edits (ARCHITECTURE §11.5, "Edited cards stay cached"); a card is not yet pinned while only an open tab shows it, and §4.2's context estimate and inspector before the first send are not built (no pending chat has them yet).

**Built 2026-11-12 (cardex3):** §3.9's standalone lorebooks, as written (ARCHITECTURE §11.5, "Standalone lorebooks"); this spec is obsolete for them. Review follow-up (review-cardex3, 2026-11-13): the direct Update delta is superseded by Review and merge, staging the file on the import line without changing the active book until the user approves its changes. This section remains obsolete as an implementation proposal; ARCHITECTURE §11.5 records the result.

**cardex** is a public card archive run by a third party. We use only its public API, as any client would ([D] owner, 2026-10-26). Its public API documentation wasn't found (§10), so our side is designed against an adapter interface (§2.2), and §10 lists exactly what we need from any archive's API.

## 0. The owner's decisions this builds on

- **[D]** (owner, 2026-11-06) "Cardex integration. We need to start designing this, especially our end of things, and it's going to become a major selling point of the UI. It seems to both be seamless, and also not invasive. The basic idea is that the archive becomes another tab on the homepage for cards, and another select option for cards in the sidebar, the filter bar directly searches the archive (plus tags and every other criterion cardex supports also need to be filterable here), and we show results in our UI like they're local cards (but only when the cardex tab/option is the one open). Clicking them, and this is important, doesn't add anything to your collection, and yet they open like any other card you've never used, with defs and such in the sidebar and a prompt to start a new chat. Certain actions, like sending the first message, would lock them in, adding them to your collection. Modifying the card too. We'd have to decide the exact UX for this, and how not to make it confusing. Moreover, we'd want additional actions to actually intentionally add them to your collection, not having to do anything like editing or sending a message."
- **[D]** (owner, 2026-11-06, "Ok", via the coordinator) The source's tab is labelled with the source's name, **"cardex"**, never "Archive": "Archived" is now the view of cards the user has archived. A second source would get a tab with its own name.
- **[D]** (owner, 2026-10-26; DESIGN §12) An archive card opens with the same UI as a local card without being added. It becomes the user's card only when they edit it and save, add it with an explicit action, or (the main way) send the first message. The two are never mixed.
- **[D]** (owner, 2026-11-02; DESIGN §11) Nothing goes to a provider the user didn't choose. An archive isn't a model provider, but the same principle applies to it here (§5).
- **[D]** (owner, standing) Every feature is a registered, replaceable part. The end goal is a harness that the in-app agent can rewrite through plugins.

## 1. Words used here

- **Source**: a place cards can be browsed from that isn't the user's library. cardex is the first one and the only built-in one.
- **Remote card**: a card as the source shows it. It isn't in the user's library.
- **Adopting** a remote card: making it one of the user's cards (an entity, a ref and a revision, as an import does). The UI says "Add to my cards" and "added to your cards". "Adopt" is never used in the UI.
- **Held**: a remote card the user already has a card for (§3.7).

## 2. Card sources as a registry

### 2.1 Two registries, one per side

Each side of the app has its own registry, as with panels, importers and recognizers today. Both use the scoped registry of PLUGINS §6: entries by id, which a plugin can add, override or disable for the length of a scope.

- **Server: `cardSources`** (`packages/server/src/sources/`). Each entry is an adapter (§2.2) that knows how to talk to one archive. Every archive request goes through it. The built-in entry is `cardex`. A plugin can add another archive, replace `cardex` (to follow an API change, say) or disable it.
- **Client: `cardSourceViews`** (`packages/client/src/features/cardSources/`, beside the existing `sourceRecognizers`). It holds optional presentation per source: tile lines, a custom filter control, an icon. A source with no client entry still works, because the generic UI is built from the capabilities the server describes (§2.3). So a plugin source can be server-only.
- **The existing `sourceRecognizers`** (the Sources list in a card's Metadata, DESIGN §4) stays as it is. A source's adapter also contributes a recognizer for its own card URLs and ids, so an added card links back to its page on the archive. This fills the "cardex has no recognizer yet" gap, once the URL shape is known (§10).

### 2.2 The adapter interface

The adapter runs on the server (§6), as Effect services. Sketch:

```ts
interface CardSourceAdapter {
  readonly id: string                     // "cardex"; namespaced in URLs and keys
  readonly name: string                   // "cardex": the tab's label (owner, 2026-11-06)
  readonly hosts: ReadonlyArray<string>   // the only hosts it may contact (§6.2)
  capabilities(): Effect<SourceCapabilities>   // filters, sorts, ratings, paging (§2.3); cached a day
  search(q: SourceQuery, page: PageToken | null): Effect<SourcePage, SourceError>
  tags?(prefix: string): Effect<ReadonlyArray<{ tag: string; count?: number }>, SourceError>
  card(remoteId: string): Effect<RemoteCardFile, SourceError>  // the card as a file, or as V2/V3 JSON
  image(ref: RemoteImageRef): Effect<Uint8Array, SourceError> // thumbnails and full portraits
  versions?(ids: ReadonlyArray<string>): Effect<ReadonlyArray<RemoteVersion>, SourceError> // batch
  recognize(doc: SourceInput): RemoteKey | undefined  // "is this card one of mine?", from `source`/extensions
  random?(q: SourceQuery): Effect<RemoteSummary, SourceError>  // blind roleplay (§7)
}

interface SourcePage {
  readonly items: ReadonlyArray<RemoteSummary>
  readonly next: PageToken | null
  readonly total?: number                 // when the archive reports it
}
interface RemoteSummary {
  readonly remoteId: string
  readonly name: string
  readonly creator?: string
  readonly tagline?: string               // the archive's short description, if any
  readonly tags: ReadonlyArray<string>
  readonly rating?: string                // the archive's content rating, as it names it
  readonly thumb?: RemoteImageRef
  readonly version: RemoteVersion         // { remoteId, version id or updated time, content hash? }
  readonly url?: string                   // the card's public page
  readonly stats?: Record<string, number> // downloads, favourites…, labelled by capabilities
}
```

`SourceError` is one of `Unreachable`, `RateLimited { retryAfter }`, `Unauthorized`, `NotFound`, `BadResponse` and `Disabled`, so the UI can word each case (§5.4).

### 2.3 Capabilities drive the filter bar

`capabilities()` describes what the archive can filter and sort by. The filter bar (§3.2) is generated from it:

```ts
interface SourceCapabilities {
  readonly text: boolean                   // free-text query
  readonly tags: { include: boolean; exclude: boolean; suggest: boolean }
  readonly filters: ReadonlyArray<          // every other criterion the API supports
    | { id: string; label: string; kind: "choice"; options: ReadonlyArray<{ value: string; label: string }>; multi: boolean }
    | { id: string; label: string; kind: "range"; unit?: string; min?: number; max?: number }  // token count, date…
    | { id: string; label: string; kind: "toggle" }                                            // "has a lorebook"
    | { id: string; label: string; kind: "text" }                                              // creator name
  >
  readonly sorts: ReadonlyArray<{ id: string; label: string; reversible: boolean }>
  readonly ratings?: { filterId: string }  // which filter is the content rating, for its default (§5.3)
  readonly paging: "cursor" | "page"
}
```

So when cardex adds a criterion, the adapter declares it and the UI offers it, with no client change. A source that wants a better control for one filter registers it in `cardSourceViews`.

## 3. Where it shows, and how

### 3.1 The real places (checked in code at `267f4c4f`)

- **Home** (`CharactersPage.tsx` → `CardGridControls.tsx`). From top to bottom: the pinned chats, then the controls, then the grid. The controls are a **Show** segmented row (All · With chats · Never used · Favourites · Personas · Groups, each with its count). Beside it, or under it when narrow, is the sort with its direction button and **Include personas** (the icon toggle). Then the **Search by name** field. The layout uses container queries over those three parts.
- **Sidebar** (`ShellBrowser.tsx`). At the top: the **Left panel** segmented control (Chats · Characters) and the **Find by name** field on one row. With Characters chosen, `CardBrowseBar` follows: a compact **Show** select (the same filters, with counts), the sort, and Include personas. Then the tile grid. The URL holds it all (`side=characters`, `sideShow`, `sideSort`, `sideQ`…).

So the owner's "another tab on the homepage" is a **Show** option on home, and "another select option for cards in the sidebar" is an option in the sidebar's **Show** select. No new tab strip.

### 3.2 The cardex option

- **[P] Placement.** "cardex" is the last option of **Show**, after Groups, separated by a divider: it's a different place, not a filter of the user's cards. In the sidebar it's the last item of the compact select, after a separator, labelled "cardex". Each further source adds its own option after it, ordered by the registry. The option's explanation: "Shows cards on cardex, which you can try without adding them to your cards."
- **Count.** Local options count the user's cards. The cardex option shows no count until it's opened, because counting would mean asking cardex. Once opened, it shows the reported total for the current search, when the archive gives one. It never shows a spinner.
- **What the shared controls do while cardex is shown:**
  - **The search field** searches cardex (debounced 300 ms; each new query cancels the one in flight). Its placeholder becomes "Search cardex".
  - **The sort** lists the source's sorts (`capabilities.sorts`). The direction button stays where it is, disabled with a reason when the sort can't be reversed.
  - **Include personas** stays where it is, disabled and greyed, with the hover "Personas are your own cards; cardex lists characters." This follows the stable-controls rule: nothing vanishes from between other elements.
  - **Filters** is a new button at the very end of the sort row, present only while a source is shown. The rule allows this, since it's the last control and nothing else moves. It shows the number of filters set. It opens a panel **below** the controls, so the layout shifts downward. The panel has a corner ×, and the button shows a pressed state while the panel is open (owner's opener rules). The panel holds every criterion from `capabilities`: a tag field with suggestions; choices as segmented or checkbox rows; ranges as two number fields; toggles as switches; text fields with their "?" help. Each criterion's explanation is a "?" beside its label (field rule).
  - **Active filters** show as chips on one line under the search field, only while any are set: `+fantasy`, `−gore`, "Has a lorebook", "Tokens ≤ 2,000". Each chip has its own × ("Removes this filter."), and **Clear filters** comes last. The line takes room only when it has chips, and it pushes the grid down, never the controls.
  - **Tags: include and exclude.** In the tag field, a suggestion is added as an include. Clicking an include chip makes it an exclude, and clicking again removes it (hover: "Click to exclude fantasy" / "Click to remove the fantasy filter"). An exclude chip carries a slash icon (toggle rule: the off state looks like a denial). A tag on a result tile can also be clicked to include it.
- **The URL.** Home: `show=src.cardex`, and the source's query as `sq` (text), `stags` and `sxtags` (included and excluded tags), `sf` (the other filters, compact JSON) and `ssort`/`sreverse`. These are separate from the local `q`/`sort`, so switching back to All finds the local search untouched. The sidebar uses the same keys with its `side` prefix (`sideShow=src.cardex`, `sideSq`, …), through the existing helpers in `homeSearch.ts`/`useSidebarBrowse.ts`. Filters and sorts replace the history entry and switching the option pushes one, as for local filters. The URL means a search can be linked and survives a reload. A reload makes a request, which is fine: the option is open (§5.1).
- **Never mixed.** Results show only while the cardex option is chosen. The user's cards never appear among them, and remote cards never appear under any other option, in the Library, in pickers, in Add characters or in the chat list. A held card (§3.7) does appear among cardex results, because it's on cardex, but as yours (§3.7).

### 3.3 Result tiles

- **The same tile component** as home and the sidebar (`CharacterGrid`'s tile, same size and portrait crop), so results look like local cards. The DESIGN [D] lets only the source's tab show different card content on its tiles. Lines, in the space a local tile uses:
  - the name (two lines at most, as now)
  - "by <creator>" (where a local tile shows the version)
  - one muted line where a local tile has "N chats · <ago>": the source's main stat and the card's token count when the API gives them, else its first tags
  - a small rating badge on the portrait's corner, when the archive rates the card and the rating isn't the most permissive default
- **Hover and focus actions** (always shown on touch), in the positions a local tile's **New chat** and **Inspect** take:
  - **Add to my cards** (icon `bookmark-plus`; hover: "Adds <name> to your cards without starting a chat.")
  - **Inspect** (hover: "Shows <name>'s definitions without starting a chat.")
- **A click** opens the card's draft chat (§4.2), as a click on a never-used local card opens its pending chat. A tile is a link, so it opens in a new tab or beside, like local tiles.
- **Context menu** (tiles are chrome, so they get the app's menu): Add to my cards, Inspect, Open in a new browser tab, **Open on cardex** (the card's public page, when the API gives a URL), and "Search cardex for cards by <creator>".
- **No favourite star.** Starring is for your own cards. The star's slot stays empty rather than holding another control.

### 3.4 Paging, scrolling, images

- **Infinite scroll.** When the last row comes within 800 px of the viewport, the next page is requested (a sentinel row observed with `IntersectionObserver`). A cursor source uses its token; a page source uses page n+1. Only one page is in flight at a time. If a page fails, a row "Couldn't load more · Retry" replaces the sentinel, and nothing retries by itself. The grid keeps at most 600 tiles mounted (`content-visibility: auto`, as the library does). Past that, earlier pages are dropped from memory, and scrolling back reads them from the result cache (§5.5).
- **End of results:** a muted "That's every card for this search." For no results: "No cards on cardex match this search", with **Clear filters** when any are set.
- **Back and Forward** return to the same scroll position, as home already does. The result pages come from the cache, with no new requests within the result cache's lifetime (§5.5).
- **Thumbnails** go through the server (§6): `GET /sources/<id>/image/<key>?w=<px>` (authenticated, same-origin, so `img-src 'self'` holds). The server fetches the archive's thumbnail, checks the magic bytes, resizes it in the thumbnail lane (§14.5b) to the requested width class, caches it (§5.5) and serves it with `Cache-Control: private, max-age=86400`. Tiles use the same width classes as local tiles. A picture that fails shows the initials fallback, as a local card without one does.

### 3.5 Inspect: the remote card's page

`/sources/<id>/cards/<remoteId>` mirrors a local card's page (`CardPage.tsx`): portrait, name, creator, tags (clickable), the archive's stats, the definition fields folded to four lines with Show more, the greetings, and the embedded lorebook's entry count. Above them is the same "not yet yours" line as in §4.4, then **Start a chat** (the draft chat, §4.2), **Add to my cards**, and **Open on cardex**. There's no Edit or Continue, since there's nothing to continue.

### 3.6 Phones

On phones, home holds the same Show row (it scrolls sideways, as now). The cardex option, Filters and the chips work the same way. The filter panel opens as a full-width sheet with its × (the existing `Sheet`), and Apply isn't needed, since filters apply as they change.

### 3.7 Cards you already have

- **Recognized by**, in order:
  1. the card-origin record a previous adoption wrote (§8);
  2. the adapter's `recognize()` over the user's imported cards' `source` entries and extensions: a card downloaded from cardex earlier and imported as a file;
  3. the SHA-256 of the archive's card file against the import lines' `source_hash`: the same file imported from disk.

  All three are indexed lookups for the up to ~50 ids of a page, in one reader request per page.
- **Shown as yours.** A held tile has a small check badge on the portrait's corner ("You have this card"), and its lines are those of the user's own tile: version, "N chats · <ago>". A click does what a click on that card does at home: it continues the latest chat, or opens its pending chat. The hover actions are the local tile's (New chat, Inspect). If the family has several live cards (the original and forks), the click goes to the one adopted or imported from this source. A family whose original is in the bin goes to its newest live fork. A family with no live card isn't held. An **archived** card still counts as held: its tile shows the check badge with "Archived" in its hover, and a click opens your copy, whose header offers Unarchive as usual. So a tried and archived card is never added a second time.
- **Update available.** A held card whose recorded remote version differs from the one this result reports also gets the "update available" badge the library uses (§3.8).

### 3.8 When the archive's version changes

The existing model for imported cards applies unchanged. An adopted card has an **import line** (ARCHITECTURE §11.1), and the archive's version is the revision on it. A newer archive version is "a newer imported version", the same as a newer file:

- **Detecting it** sends nothing extra. A results page carries each held card's current version, so a held card that shows up in results is checked for free. A card's Metadata → Sources row for cardex has **Check for a newer version** (hover: "Asks cardex whether <name> has changed since you added it."). There are no automatic background checks (§9, D4 [D]).
- **Offering it:** the existing notice under the editor's actions ("A newer imported version is waiting" → here "A newer version is on cardex") with **Review and merge**, which stages the archive's new file on the import line (`mode=merge` staging) and opens the existing merge review. The card's import dialog's **Replace** works on it too, and a third choice, **Add as a separate card**, adopts the new version as a card of its own ([D] owner, 2026-11-06; §9).
- **Nothing is applied without that review.** Forks of the card aren't touched. They see only their parent's later revisions, as now, once the user has merged into the parent.

### 3.9 Standalone lorebooks (cardex3, 2026-11-12)

The archive also lists standalone lorebooks (cardex v1 `kind=lorebook`: a summary with `kind: "lorebook"`, the card URL shape `/c/<slug>`, often no picture; its file is ST World Info JSON in every download mode; `/versions` and `/origins` answer for its listing as for a card). Checked live, shapes only, 2026-11-12.

- **[D]** (owner, 2026-11-12, asked where an archive lorebook opens and whether lorebooks show beside characters or separately) "In the lorebook editor, I guess. They can be returned with characters. You can filter them."
- **[D]** (same) Lorebooks come back in the same result list as characters, and a type filter chooses characters, lorebooks or both.
- **[D]** (same) A lorebook opens in the existing lorebook editor (the side panel's has full parity and is the phone's editor); no second form is built.
- **[P]** The type filter is the existing **Kind** choice in the Filters panel, with four options: Characters, Characters with a lorebook, Lorebooks, Characters and lorebooks. Unchosen, it's **Characters and lorebooks** (cardex's own default, and the owner's "returned with characters"); a chip shows any other choice. The chip and the filter count follow the panel's existing rules.
- **[P]** A lorebook result is the same tile, with a **Lorebook** badge on its picture's corner (hover: "A lorebook, not a character. Opening it adds it to your lorebooks."), the initials fallback when it has no picture, and "by <creator>" as for a card. No rating badge rule changes.
- **[P]** **Opening is adding.** A lorebook has no draft state: there's no chat to try it in, and the editor works on library entries. A click (or Open, or Open in a new browser tab) adds it to the user's lorebooks and opens it in the editor; **Add to my lorebooks** in the tile's menu adds it without opening. Its route `/sources/<id>/lorebooks/<remoteId>` adds it (or finds the user's copy) and then replaces itself with the editor's URL, so a reload or a second tab never adds a second copy. A held lorebook's tile links straight to the user's lorebook and carries the "You have this lorebook" badge.
- **[P]** **What adding stores**: what importing the downloaded World Info file stores (`ImportFile`: entity `kind = lorebook`, upstream ref, revision 1 `origin = import`, `source_hash`), plus the same `card_origins` row a card gets (the table names no kind, so lorebooks share it; no baseline change). Twice is refused by the origin row as for cards.
- **[P]** **Updates** (built; direct-update wording below superseded by review-cardex3’s explicit merge review in ARCHITECTURE §11.5) work as for cards, through the same origin row: results record a newer version, and the lorebook editor's header area shows **A newer version is on cardex** with **Update** (hover: "Merges the newer file from cardex into this lorebook, as Update from file… does.") and **Check for a newer version**. Update fetches the newer file (successor slugs included, through the origin's stable listing) and imports it into the lorebook as Update from file… does (a merge on its import line); the version is then recorded as taken. Replace and Add as a separate card aren't offered for lorebooks, since a lorebook has neither today.
- **[P]** Inspect, Start a chat and the draft-chat panel are character flows and aren't offered on a lorebook tile.

## 4. The "not yet yours" state

### 4.1 What's stored when a remote card is opened

- **Nothing in the library.** Opening a remote card writes no entity, ref, revision, media reference, chat or tag. Library lists, counts, the bin and usage don't change.
- **A temporary cache on the server** (§5.5) holds, under the user's namespace: the card's file or JSON as the archive gave it, its parsed document (parsed in a format worker, under the import caps of §8, as an import is), the full portrait and the thumbnails. The full file is fetched when the card is **opened**, not at the first send. So adding it later needs no network, and the definitions in the panel are the exact ones that will be added.
- **Recently viewed**: a per-user list of the last 50 remote cards opened (source, id, name, thumbnail key, when), in user `settings` (`sources.recent`). It's shown as one collapsible row, "Recently viewed on cardex", at the top of the cardex results, so a card passed by mistake can be found again (DESIGN §12 [O]). **Clear** empties it. It holds no definitions, so eviction doesn't touch it, and a card opened from it is fetched again if needed.
- **Eviction**, of the cache only:
  - Opened cards that weren't added expire **7 days after last opened**. Result pages expire after **10 minutes**, and thumbnails after **7 days**.
  - The instance cap is 1 GiB by default (admin setting). Past it, the least recently used entries go first.
  - **Pinned** while a draft exists for the card (an edit, typed composer text, §4.3) or while any open tab shows it. A pinned entry outlives its age, and only the cap can evict it, after unpinned ones. Then the draft is kept and the card is fetched again when its chat is next opened.
  - The cache lives on disk under `DATA_DIR/cache/sources/` with an in-memory index rebuilt by a scan at startup. It's never in SQLite: a search per keystroke must not queue behind the one writer (§3.1). Bytes are content-addressed (sha256), so identical files are stored once. The index is keyed per user, so one user's views never show in another's recent list or affect their results.

### 4.2 How it opens: the draft chat

- **The pending chat, unchanged.** A remote card opens at `/sources/<id>/cards/<remoteId>/chat`, which is the existing pending chat page (`StartChatPage.tsx`, ARCHITECTURE §12) with a cast of one remote card. Since a chat is made only on the first turn (DESIGN §2.1 [D]), there's nothing new to invent here. The pending chat already looks and works like any chat:
  - the greeting is shown as a message, with its alternates as versions you can step through
  - the header has the card's face, the name the chat would be saved under, and the "new" badge
  - the composer is ready, with Playing as (the account's default persona), the preset and model pickers, the context estimate and the cost of the next message
- **The side panel's character tab** opens on **Definition** by default (the owner's "with defs and such in the sidebar"). It's the same `PendingCharacterTab` editor with every sub-tab: Definition, Greetings, Metadata, Lorebook (the embedded book, read and editable), Notes (the Character's Note, if the card has one), Extra (regex scripts, listed, never run: §4.6).
- **The prompt to start**: the composer, as on any never-used card, under the greeting. A card without greetings gets the pending chat's existing line, "<name> has no greeting. Your first message starts the chat." Nothing is added for remote cards beyond §4.4.
- **What works before anything is added**, all without adding the card:
  - stepping through the greetings and choosing one
  - choosing the persona, preset and model
  - adding local characters to the pending cast (it becomes a pending group)
  - reading and editing every field (§4.3)
  - the context inspector and the cost estimate, assembled from the cached document. The assembler's card read is a registered source, and a pending remote card gives it the cached document instead of a ref. **[D]** (owner, 2026-11-12, asked whether every new chat should show these before its first send) "Yes. Make sure this doesn't cause anything to be sent to inference providers." It applies to every pending chat, local cards too (DESIGN §2.1).
- **What needs the card added**, as for any pending chat: Fork for this chat and Use another version (they need a saved chat anyway). Also, specific to remote cards:
  - **Export…** stays in place, disabled, with "Add <name> to your cards to export it."
  - **Use as persona** adds the card first, saying so in its hover ("Adds <name> to your cards and uses it as your persona.")

### 4.3 Edits before adding

- Typing in a field of a remote card is kept as a **draft**, server-side like every draft, so nothing typed is ever lost. The draft uses a registered draft target kind, `remote-card`, with `target_id` `<sourceId>:<remoteId>`; that's the existing `drafts` table, with no new columns. Field undo history works as it does in any editor.
- **Save** adds the card (§4.5, trigger 2). The save cluster keeps its usual labels. Save's hover becomes "Saves your changes and adds <name> to your cards." Revert works as usual and adds nothing.
- Leaving with unsaved edits works as for any card's drafts: the edits stay, the cache entry is pinned (§4.1), and the draft chat shows them on return.
- The composer's draft for the draft chat is the pending chat's own draft, keyed by the same remote target, so typed text survives a reload and goes along on the first send (`composerCarry.ts`).

### 4.4 Making the state unmistakable, but quiet

Three places, each one line or one badge. No banners, dialogs or interruptions while browsing:

1. **The draft chat's header**: beside the existing "new" badge, a source badge **"cardex"** (hover: "<name> is from cardex and isn't in your cards yet. Sending a message, saving an edit or Add to my cards adds it.").
2. **The character tab**, at the top of the card header block, one muted line: **"From cardex · not in your cards"**, with **Add to my cards** at its end (hover: "Adds <name> to your cards without starting a chat."). It sits in the header block's own flow as a row of the header, so nothing shifts when it later goes away: on adding, the row is replaced by the card's normal header rows.
3. **Send's and Generate's hover**, only for a remote card: "Sends your message and adds <name> to your cards." / "Has <name> write the first message and adds <name> to your cards."

After the card is added, a notice "Added <name> to your cards." links to the card's library page. The badge and the line are gone, because it's now an ordinary card. The **Library** shows only added cards. They're ordinary cards, and their Metadata → Sources lists "cardex" with the card's page. Cards added only by trying them are cleared away by archiving, through a criterion in Archive unused cards… (§9, D3).

### 4.5 Lock-in triggers, and exactly what each creates

Every trigger runs the same server operation, `AdoptRemoteCard`. Its non-database work comes first: the cached file is parsed again in a format worker if its parsed form was evicted, and the media files are written to `DATA_DIR/media/<2 hex>/<sha256>` exactly as an import writes them (§11.1, with the import's in-progress hold against the sweep). Then **one writer transaction** stores what `ImportFile` stores for a new file, plus the origin record:

- **The card entity** (`kind = card`) and its **upstream ref**, labelled from the card's name, with `subtitle` from `character_version`. `source_path` holds the archive's file name when it gives one (else `<name>.<ext>`), and `source_hash` is the SHA-256 of the archive's bytes.
- **Revision 1**, `origin = import`, `origin_ref` = `{ source: "cardex", remoteId, version, url, sha256 }`. It's the start of the card's **import line**, so a later archive version merges against it (§3.8).
- **The document** as the importer produces it: names, every definition field, greetings, alternates and group-only greetings, tags in the card's `tags`, the **embedded lorebook** in `character_book` (it stays in the card document, as for every import), regex scripts and other extensions (inert until approved, §4.6), and `assets`.
- **CCv3 `source`**: the archive's canonical card URL is appended (or `cardex:<remoteId>` when there's none), unless it's already there. Existing entries are kept. `source` is only ever appended to (DESIGN §4).
- **Images**: the full portrait becomes `avatar_media_id`, and every embedded asset the file carries becomes `asset_media_ids` (gallery kinds kept, §4.0a). Each gets a `media_refs` row for the user. The portrait cutout is the file's own, or the default.
- **The Character's Note** (`depth_prompt`), if the card has one, becomes the card's first note, as on import.
- **The card-origin record** (§8): `(owner, source, remoteId) → entity`, with the version and hash adopted.

Then, by trigger:

1. **Sending the first message** (Send, Generate, or a reply with direction: any first turn). In the **same transaction**, after the card rows: `StartChat` as it is today, with the new entity in the cast, the chosen greeting and its alternates as versions, the persona, and the user's message or the reply's direction. So either the card and its chat both exist, or neither does. The client then asks for the reply as after any first send. The URL is replaced by the saved chat's, keeping the panel's tab (as now).
2. **Saving an edit**: in the same transaction, after revision 1, a **revision 2** with the drafted fields (origin `edit`, as a Save makes). The drafts are committed to it, and moved from the `remote-card` target to the new ref's fields in that transaction. History then shows "Added from cardex" and then the user's edit, so the archive's original is always one Restore away. The tab stays where it is and becomes the card's ordinary editor. The draft chat stays a draft chat, now of a local card.
3. **Add to my cards** (tile, Inspect page, character tab, context menu): the card rows alone. No chat is made. The tile at once shows as held (§3.7) with the check badge, and briefly flashes (owner's adding rule). The hover named what's added and where.

A **failed adoption** (a full disk, say) stores nothing. A first send that fails at this step keeps the typed text in the composer, and the error says the message wasn't sent.

**Adding twice** is refused by the origin record: a second Add to my cards, from another tab or device, answers with the existing card instead of making a duplicate. A remote draft chat opened in a tab before the card was added elsewhere offers "You have this card now" with **Open your card**, and its first send uses the existing card.

### 4.6 Untrusted content opened casually

Archive cards are untrusted, and they're opened with a single click, so (DESIGN §12 [O], §11):

- Greetings and fields render through the same sanitizing and sandbox rules as any card. HTML/CSS in a greeting is shown as the chat shows it for local cards, never with more privileges.
- **Nothing in a remote card turns itself on:** its regex scripts aren't run on its greetings or anywhere else, and the Extra tab lists them as "Not run until you add the card and turn them on." Once added, they need the same approval imported regex needs (DESIGN §11). Its embedded lorebook isn't attached to anything until the card is in a chat.
- **Nothing is sent to a model provider** before the user's first submit (DESIGN §11 [D]). Token counts on the panel follow the connection's Token counts choice, as for local cards.

## 5. Privacy and network

### 5.1 When requests go to the archive

Only:
- while the cardex option is open on home or in the sidebar, or a remote card's draft chat or Inspect page is open (including when a restored workbench tab shows one); or
- when the user acts on the archive: Add to my cards, Check for a newer version, "Open on cardex" (that one is the browser's own navigation).

Never on visiting home or opening the sidebar with another option chosen, on opening the user's own cards or chats, at startup, or in the background, unless the owner turns on background update checks (§9, D4). A test asserts this, as `test/providerSend.test.ts` does for providers: with default settings, nothing reaches a fake archive until its option is opened.

### 5.2 Turning it off

- **Settings → Card sources** (a new Settings section, registered): one switch per source, "Show cardex" (hover: "Adds cardex to the Show choices on the home page and in the side panel."). With it off, the option isn't offered (it's the last option, so its removal moves nothing), no request is ever made, and remote draft chats and Inspect pages say "cardex is turned off in Settings" with a link there. Cards already added are ordinary cards and stay.
- **An admin switch** (instance settings) turns a source off for every account and hides the per-user switch. Some instances have to make no outside requests at all (DESIGN's offline laptop case).
- It starts on for a new account, and nothing is sent until it is clicked (§9, D1 [D]).
- The same section holds the source's **API key**, if the API needs one: write-only, stored in `credentials` like provider keys. It also has **Clear cached cards** (the user's cache entries and recent list), and for admins the cache cap.

### 5.3 What's sent

- **Queries only**: the search text, tags, filters and sort the user chose; a card id the user opened; ids for a version check; image keys. Plus the API key when one is configured.
- **Never**: chats, messages, personas, the user's own cards or their contents, notes, presets, or which local cards the user has, beyond the ids in an explicit or result-borne version check (§3.8). An adoption reads from our cache and sends nothing.
- **Requests come from the server**, not the browser (§6). So the archive sees the instance's address (or its configured outbound proxy, ARCHITECTURE §2 "Outgoing requests"), a fixed `User-Agent` naming the app and its version, and no browser cookies or referrer.
- **Content rating default**: the archive's own anonymous default the first time. After that, the user's last choice is remembered per account (user settings), and the active rating is always visible as a chip when it isn't the default.

### 5.4 Offline and error states

Each state is worded for what the user can do:

- **Unreachable** (DNS, connect, timeout of 15 s): the cardex results area says "Can't reach cardex right now." with **Retry**. The rest of the page works. Cached result pages and recently viewed cards still open.
- **Rate limited** (429): "cardex is limiting requests. Trying again in 20 s." with a countdown, then one automatic retry. Typing in the search during the wait just replaces the pending query.
- **Unauthorized**: "cardex refused the API key." with a link to Settings → Card sources.
- **Not found** (a card removed from the archive): a draft chat or Inspect page whose card is still cached keeps working from the cache, and says "This card is no longer on cardex." The user can still add it. Without a cache it says the same, with nothing to show.
- **Bad response** (unparseable, over the caps): "cardex sent something this app can't read." That's logged for the admin, and nothing is stored.
- **An open draft chat never depends on the network after it loaded**: the first send adds the card from the cache.

### 5.5 Rate limits and caching

- **The server limits itself.** It uses a token bucket per source per instance at the archive's documented rate, or 2 requests/s with a burst of 8 when none is documented. The adapter can declare its own. `Retry-After` is honoured, with exponential backoff to 5 minutes.
- **Coalescing**: identical concurrent requests (two tabs, or the sidebar and home on the same search) share one upstream request.
- **The client keeps the load down**: a 300 ms debounce on typing, cancellation of superseded queries (the server drops the upstream request if nobody else waits on it), one page in flight, and no prefetch beyond the next page.
- **Lifetimes**: search pages 10 minutes; `capabilities` and tag suggestions 24 hours; opened cards 7 days after last opened (pinned while in use, §4.1); thumbnails 7 days. Everything sits under the instance cap.

## 6. Server or browser: the server proxies

**[P] Recommendation: the server talks to the archive, and the browser only talks to the server.** The reasons:

- **The CSP.** The app's policy is `connect-src 'self'` and `img-src 'self' blob:` (ARCHITECTURE §2), so that no page content can report to other servers. A browser calling the archive directly would need the archive's hosts in both. Archive thumbnails would then load straight from the archive, which would show the user's browsing to it with browser fingerprints and referrers.
- **Adding happens on the server anyway.** The file must be parsed in a format worker and its media written by the server. With the browser fetching, the file would make a round trip through it (64 MiB caps, slow phone uplinks).
- **The API key**, if any, is write-only on the server, like provider keys.
- **One cache and one rate limit** for every tab and device, and resized thumbnails for phones.
- **CORS** doesn't matter: whether the archive allows cross-origin calls has no effect on us.

**6.1 Shape.** The RPCs `SourceCapabilities`, `SourceSearch`, `SourceTags`, `SourceCard` (the parsed document, the greetings as `GetCardForChat` returns them, and the cache key) and `AdoptRemoteCard`. Plus the HTTP image route of §3.4. They're authenticated and owner-scoped like every RPC. The network calls run on the main thread through the `Network` service (no blocking work). Parsing runs in format workers, resizing in the thumbnail lane, and storage only in the writer and readers (CLAUDE.md).

**6.2 Not an open proxy** (DESIGN §11, the ST CVEs):
- The client never supplies a URL. It names a source id and an id, query or image key that the adapter turns into a request on the adapter's own `hosts`.
- Image keys are opaque handles the server issued from a result, so a client can't name an arbitrary URL.
- Redirects are followed only within `hosts`. Private and loopback addresses are refused unless the admin added the host to the bypass list.
- Response caps: 2 MiB for JSON, the import caps (64 MiB) for card files, 16 MiB for images.
- Timeouts: 15 s to the first byte, 60 s in total.

## 7. Blind roleplay, later, on the same source

Blind roleplay (DESIGN §12 [L]) needs nothing new from sources. It's a consumer:

- **The pick**: the adapter's `random(query)` when the archive has one, else a random item from a random page of `search(query)` within the reported total. The query is the user's chosen filters. Own cards only, the archive, or both is a choice of the feature, not of the source.
- **The chat**: the same draft chat of §4.2, with the UI hiding the name, portrait and definitions while the setting asks for it. **Reveal** shows them. **Pass** goes to the next pick and records the id in a per-user "passed" list, so passed cards don't come back; the recently viewed list doubles as the way back. **Start** is the ordinary first send, which adds the card (§4.5).
- **The cost** of the next message is shown as usual, assembled from the cached document (§4.2).

## 8. Schema impact

**This job: none.** It's design only, and the baseline is unchanged.

**When built** (straight into `baseline.ts`, a fresh database on deploy, no migration, per the schema rule):
- **`card_origins`**: `(entity_id PRIMARY KEY REFERENCES entities, owner_user_id, source_id, remote_id, remote_version, remote_sha256, recognized_by CHECK IN ('adopted','recognized'), created_at)`, with a `UNIQUE (owner_user_id, source_id, remote_id)` index. It's written by `AdoptRemoteCard`, and by `ImportFile` when a registered adapter's `recognize()` claims an imported card. The adapters' `recognize` functions run in the format worker with the parse, so the writer only inserts. It makes §3.7's checks one indexed lookup per page and stops double adoption.
- **An index** `entity_refs_source_hash ON entity_refs(source_hash) WHERE source_hash IS NOT NULL`, for §3.7's third check (the join to `entities` adds the owner).
- **No other change**: drafts use a registered target kind in the existing `drafts` table; the recent list, rating choice and switches are `settings` keys; keys go in `credentials`; the cache is files.

## 9. Decisions for the owner

D1–D4 were decided as their defaults below (owner, 2026-11-07: "okay", via the coordinator). Settled earlier: the tab's name ("cardex", owner 2026-11-06) and what an update offers.

- **[D] What an update offers** (owner, 2026-11-06: "Ignore that older design note.", via the coordinator). A newer archive version of a card you added offers **Review and merge**, **Replace**, or **Add as a separate card** (§3.8), the same as a newer file of an imported card, with Review and merge first. The October open item "take it as a separate card or a fork, never merged into the user's copy" (DESIGN §12) is superseded.

- **[D] D1. Is cardex on or off for a new account?** On: cardex is shown to new accounts, and nothing is sent until it's clicked (owner, 2026-11-07: "okay", via the coordinator).
  - *What:* whether "cardex" appears among the Show choices before the user has turned anything on.
  - *When:* first visit to home on a new account or a new instance.
  - *Example:* a new user opens home and sees "All · With chats · Never used · Favourites · Personas · Groups · cardex". Nothing has been sent to cardex; clicking "cardex" is the first request.
  - *Default:* **on**. The option is shown and nothing is sent until it's clicked, and it's meant to be a selling point.
  - *Otherwise:* the option is hidden until the user turns it on in Settings → Card sources. That's safer for instances that must make no outside requests (an admin can still turn it off for everyone either way), but most users would never find the feature.
- **[D] D2. Does the first message add the card without asking?** Yes: the first message adds the card without asking (owner, 2026-11-07: "okay", via the coordinator).
  - *What:* whether sending in a draft chat with a cardex card adds it at once, or first asks "Add <name> to your cards?".
  - *When:* the first Send or Generate in a chat with a card from cardex.
  - *Example:* you try a card, type "Hello" and press Send. With the default, the message goes and the card is now in your cards, with a notice "Added Mio to your cards". Asking would put a dialog between you and every tried card.
  - *Default:* **no question.** The header badge, the panel's line and Send's hover say beforehand that sending adds it (§4.4), and the notice says so after.
  - *Otherwise:* a dialog on each first send (with "Don't ask again"). It's safer for someone who didn't read the hover, but it slows the try-many-cards loop you described.
- **[D] D3. Cards added only by trying them: how they're cleared away.** Ordinary cards, plus the "Only tried" criterion in Archive unused cards… (owner, 2026-11-07: "okay", via the coordinator).
  - *What:* trying ten cards with one message each leaves ten cards in your cards, each with a one-message chat (DESIGN §12 [O]). The app avoids making users delete things, so clearing them means archiving them, not moving them to the bin.
  - *When:* after a session of trying cards.
  - *Example:* you try ten cards and like two. All ten are ordinary cards in All and in the Library. Later, **Archive unused cards…** (the dialog job cardarchive is building, reached from the Archived view) has a third criterion, **"Only tried: added from cardex, with at most N of your messages in all its chats"** (N = 1 by default). It lists the eight you didn't continue, each with its checkbox, beside that dialog's other criteria. **Archive 8 cards** archives them in one step, with Undo. They leave All and every listing, and stay in the Archived view.
  - *Why a criterion and not a view:* that dialog already does what's needed: it lists matching cards with checkboxes and a count, archives them as one reversible operation, and never includes favourites. Its "Never used" criterion can't catch tried cards, because sending a message counts as using a card. One clean-up place is better than a separate Tried view that would duplicate the dialog's selection and bulk action in the Library.
  - *Default:* **ordinary cards, plus the "Only tried" criterion** in Archive unused cards…, off by default like "Not used in the last N months". When the cardex option is enabled, it shows in the dialog with its count ("12 cards"), so it's discoverable without being preselected. The criterion is a registered part of the dialog, contributed by the sources feature, so another source extends it ("added from <source>") and a plugin can replace it.
  - *Otherwise:* a Library → Show → **Tried** view with its own "Archive all" button, or tried cards kept out of home's All until they have a second message of yours. The first duplicates the dialog. The second makes a card you just chatted with seem to vanish from home.
- **[D] D4. Checking for newer versions of cards you added from cardex.** Only from results and the Check for a newer version button; nothing in the background (owner, 2026-11-07: "okay", via the coordinator).
  - *What:* how the app learns that the author updated a card you added.
  - *When:* at any time after adding.
  - *Example:* you added Mio a month ago and the author fixed her greeting last week. With the default, you see "update available" when Mio appears in cardex results, or when you press **Check for a newer version** in Mio's Metadata.
  - *Default:* **only those two.** Nothing goes to cardex in the background, and cardex never learns which of your cards you open.
  - *Otherwise:* a switch "Check my cards from cardex for updates once a day" (off by default), or automatic checks when you open such a card. Both send the ids of cards you use to cardex without you looking at it.

## 10. The public API: what was found, and what we need

**Found:** no public documentation of cardex's API. Searches on 2026-11-06 ("cardex character card archive API", "cardex public API … openapi", "cardex SillyTavern cards archive search tags API") returned other card services and tools, nothing describing cardex's endpoints, card URLs, fields, rate limits or terms for third-party clients. The card editor's recognizer job found the same on 2026-11-01 (DESIGN §4). So nothing above depends on a cardex-specific detail. cardex's public API is being built on cardex's side (coordinator, 2026-11-07); the `cardex` adapter will follow its published documentation once it's out. Until then, development and tests use a **fake source** (an in-process HTTP server serving our own synthetic cards, `test/support/fakeArchive.ts`). It's registered on a development server too, so a development server's content stays entirely ours.

**What we need from any archive API**, in order of necessity:

1. **Search** with free text, paged (a cursor, or pages with a total), returning per card: a stable id, name, creator, tags, a thumbnail URL or key, and a version marker (version id or last-updated time). Optional but used: a short description, a content rating, token count, stats, and the card's public page URL.
2. **Tag filtering** with include and exclude, and **a tag list or suggestions** (prefix search, with counts if available).
3. **Every other filter and sort it supports**, ideally described by the API itself, so the adapter can declare them (§2.3) without hard-coding.
4. **The card itself**: the full definition as a standard file (PNG with `chara`/`ccv3`, CHARX, or V2/V3 JSON), including the embedded lorebook, alternate and group-only greetings, and assets.
5. **Images**: the full portrait, and thumbnails at one or more sizes.
6. **Versions**: a version marker per card and, ideally, a batch lookup for many ids, and a content hash of the file.
7. **Stable public card URLs** (for `source`, the Sources list's recognizer and Open on cardex), and whatever card-file fields identify a card as the archive's (for recognizing downloaded copies, §3.7).
8. **Limits and terms**: documented rate limits with `429` + `Retry-After`; whether anonymous use is allowed or an API key is needed; terms that allow a third-party client to search, show and download cards on a user's behalf.
9. **Optional, for later**: a random card for a query (blind roleplay), "similar cards", and fork/derived-from links between archive cards. For the last, a local copy keeps its own lineage and lists the archive relationship only in Sources: **[P]**, for the DESIGN §12 open item.

## 11. Phased plan

Each phase is shippable and tested on its own (synthetic fixtures only, at 1440 and 390 px, light and dark, with the layout audit).

1. **Sources foundation (server).** The `cardSources` registry and the adapter interface; the fake source; the proxy RPCs and image route with their guards (§6.2); the file cache and its eviction; self rate limiting and coalescing; Settings → Card sources (switches, admin switch, key, clear cache). Tests: nothing reaches the fake archive with default settings until the option opens (§5.1); the open-proxy refusals; eviction and pinning; the per-user cache namespace.
2. **Browsing.** The "cardex" Show option on home and in the sidebar; search; the generated Filters panel and chips; source sorts; URL keys; result tiles; infinite scroll; thumbnails; the error states. Results are never mixed (a test lists every local surface with the option open). Also the recently viewed row.
3. **Trying and adding.** Remote draft chats and Inspect pages; the panel's editors on the cached document; `remote-card` drafts; the assembler's cached-document source for the estimate; the three triggers through `AdoptRemoteCard` (one transaction each, the first send with `StartChat`); `card_origins` and the source-hash index (baseline); held cards in results; double-add refusal; the inert regex scripts. Tests: an adoption stores exactly §4.5's rows; a failed one stores none; the card-plus-chat atomicity.
4. **The cardex adapter**, once its API documentation is in hand: capabilities, mappings, rate limits, its Sources recognizer. It's checked against the live API by hand only, never in the test suite, and no real card ever lands in a fixture.
5. **Updates.** Version markers from results, Check for a newer version, the "A newer version is on cardex" notice wired to the existing merge staging, Replace and Add as a separate card.
6. **Tried cards** (once cardarchive has landed): the "Only tried" criterion registered into Archive unused cards…, backed by `card_origins` and one reader query that counts the user's own messages per card across its chats (the dialog's 5,000-card scale test covers it).
7. **Blind roleplay** (§7), when the owner schedules it.
