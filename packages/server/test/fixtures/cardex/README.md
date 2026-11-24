# cardex API captures

Responses from the public API v1 of cardex, a third-party public card archive. Each file is one
request: its path and parameters, the status, the response headers that describe the API (not
the CDN's), and the body (or, for a picture or a card PNG, its size and first bytes). The fake
cardex (`test/support/fakeCardex.ts`) builds every response from these files, and
`test/cardexContract.test.ts` checks that it still matches them.

They cover every endpoint the cardex adapter (`src/sources/cardex.ts`) calls: the capabilities
description, a search with each filter, mode, sort and kind, text paging by cursor and page,
semantic paging, unknown tags, the count, tag and creator suggestions with their cursors, batch
lookups (canonical, with a missing id, and the 308 for a non-canonical one), card pages for a
character, a character with a lorebook, a standalone lorebook, a forked card, a fork and an
earlier version, each origin's page, versions and forks, a creator's page, downloads in every
mode, pictures, a conditional request, and each refusal (bad limit, page, mode, sort, site,
cursor, Chub flags, too many tags, unknown download mode, and every kind of 404).

## Card content is synthetic

What the archive's cards say is never kept. `synthesize.ts` replaces every card's text, names,
creators, handles, tags, slugs, external ids, hashes, cursors and URLs with our own SFW words of
a similar shape and length. The same value becomes the same replacement everywhere, so a slug
still matches its path and a cursor the request that used it. A card's safety flags are set to
false. Every time is moved back by the same amount (order and spacing kept, fractions of a
second mapped), and ETags and `?v=` tokens are mapped like hashes. The API's structure stays
exactly as captured: every key, status, header, null, number and boolean; the enum values and the API's own labels and error messages; and the whole
capabilities description. Absolute URLs on the archive become `https://archive.example`, other
hosts `siteN.example`. Synthesizing fails, and writes nothing, if any word of the original card
content (or any non-ASCII letter) would remain.

## Refreshing

```sh
npm run capture:cardex -w @dreamspan/server -- <api-origin>
```

This fetches about 115 read-only GETs, one at a time and about a second apart, keeps the
untouched responses in a new temporary directory outside the repository (`--raw <dir>` names
one; never commit it), and replaces the files here with synthetic ones. Then run the contract
test, and change the fake wherever it fails.

```sh
npm run capture:cardex -w @dreamspan/server -- <api-origin> --verify
```

This fetches the same and writes nothing. It lists every field, header or kind of value the live
API sends that the files here lack, and any change in the capabilities description, and exits 1
if there is one. `--from-raw <dir>` re-synthesizes an earlier capture without fetching anything.
Tests never call the network.

## What the contract test compares

Captures are grouped by kind of response (every search, every card page, every version list;
each refusal, redirect, picture and download mode is a kind of its own). For each kind, the fake
must send every field the captures have, with each kind of value they had besides null, and no
field or kind of value they never had. A whole number and a fraction count as one kind; a field
the captures only ever had as null may hold anything; a downloaded file is the card's own, so
only the `extensions.cardex` block cardex adds to it counts. Status, header names, and the
`content-type`, `cache-control` and CORS values must match each capture.

## What the captures can't show

The fake also answers a few cases that a polite capture can't provoke. It uses the same
`{error, message}` envelope and headers as the captured errors for these:

- a 429 with `Retry-After`;
- a 451 for a region;
- a 403 for a card whose downloads are refused;
- `/__fake/fail` failures.

The captured cards had no `earlier_origins`, so the fake builds those entries from the captured
listing (`origins[]`) and origin reference shapes, nested as `listing`, `origin`,
`active_from` and `active_to`. A lorebook's `mode=original`
download wasn't captured; the fake serves the lorebook's own file for it, as for a card. The
fake's `omitDownloadModes` imitates a response cached from before cardex listed
`download_modes`.
