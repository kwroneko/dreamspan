# Saved media: card media kept on this server

**Status: Proposed, 2026-11-12 (rehost1); built the same day, except saved video (§3.4).** Owner decisions are marked **[D]**; everything else is **[P]**. Built in the same job; ARCHITECTURE §12 "Saved card media" documents what is implemented. A delta from HTML-MESSAGES.md step 5 (`/media/external` and scoped consent), which stays as it is for every address that isn't saved.

## 1. The problem

A card's HTML and CSS can name media on other sites: `<img src="https://…">`, a CSS `background: url(https://…)`, a font, a Markdown image. With media from other sites allowed (HTML-MESSAGES §3.2), viewing a message makes requests to those sites. Two things leak:
- **That you are reading**, and from where (your server's address, when, how often): "IP grabbing".
- **What you do**, if a rule only loaded its image in some state: `.custom-door:checked ~ .custom-room { background: url(https://tracker.example/opened) }` would tell the site you opened the door. The existing download queue already prevents this (§3.4).

## 2. Owner decisions

- **[D]** "I actually think we should just download and rehost everything when we save a card, or at least try." (owner, 2026-11-12)
- **[D]** Transparent: "we can't change the card contents. We just save the files and fetch them from local storage instead of opening the links. The links internally stay as they are." (owner, 2026-11-12). Card text, exports and what the model sees never change.
- **[D]** "The main risk is IP grabbing and such. So the user should be asked with a dialog to approve specific domains he's not seen before. cardex can be pre-approved on the whitelist (but removable as any other)." (owner, 2026-11-12). No download ever goes to a site the user hasn't approved.

## 3. The proposal

### 3.1 What is found

- **[P] Where:** every revision of every library entry (cards, personas, lorebooks, presets, notes): every string in its document, whatever the field (greetings, description, examples, lorebook entries, regex replacements, extensions).
- **[P] What counts as media:** only places that load something:
  - HTML `src`, `srcset`, `poster`, `background`, SVG `<image href>`/`xlink:href`, read with the HTML tokenizer the renderer uses (parse5), so entities decode as the browser decodes them;
  - CSS `url()` in `<style>` elements and `style` attributes, read with the renderer's CSS tokenizer; inside `@font-face` it's a font;
  - Markdown images `![alt](url)`.
  A plain link (`<a href>`), a bare address in prose and the card's `avatar` field are not media and are never fetched.
- **[P] Not fetched:** addresses with a macro or a regex capture in them (`{{user}}`, `$1`), since they're only known when shown; anything not `http(s)`; at most 200 addresses per revision (the rest aren't listed, so they follow the consent rules when shown).
- **[P] Kind:** image, audio, video or font, from where it was found (`<audio>`, `@font-face`, …). The approval dialog shows these.

### 3.2 Which sites: the approved list

- **[D]** Only sites on the user's list are contacted. **[P]** The list belongs to the account, on its own settings page, **Settings → Media sites**: add a site, remove one, each with an explanation on hover. It starts with `cardex.zip`, where the card archive's mirrored downloads point their images (checked against its public API on 2026-11-12: a mirrored card's images are `https://cardex.zip/i/<hash>.<ext>`); it can be removed like any other.
- **[P] Matching:** a site is an exact host name (`i.imgur.com` matches only `i.imgur.com`). An entry can include subdomains (`imgur.com` and subdomains matches `i.imgur.com` and `imgur.com`). Host names are compared lowercased, without a trailing dot; IP literals can be listed but are still refused by the fetcher when they aren't public.
- **[P] When a saved entry names sites not on the list,** their files wait for approval. One dialog lists each new site with how many files and what kinds, and offers per site:
  - **Approve**: the site goes on the list (with a second choice, **Approve with subdomains**), and every waiting file from it, in any entry, is fetched;
  - **This time only**: these files are fetched; the site isn't added;
  - **Don't download**: these files stay on the other site.
  Closing the dialog decides nothing: the files keep waiting.
- **[P] When the dialog shows:** after importing files on the Import page (one dialog for the whole batch), after adding a card from a card source, and at the end of a folder import (every waiting site of the account). An edit saved in the editor doesn't open a dialog; the entry's **Saved media** section shows the marker and a **Review** button that opens it.
- **[P] Without a user present** (a card updated from its source, an import run by the server): approved sites are fetched, the rest wait, and the entry shows "N media files need approval".
- **[P] Redirects:** followed only to a site that's approved too (for "This time only", only within the same host), at most five, each checked as the first request. A redirect elsewhere fails the file ("Moved to a site you haven't approved").

### 3.3 Fetching

- **[P] When:** a database trigger queues every new revision; a server task lists its media (in a reader worker), records them (one writer transaction, no network), then downloads (no transaction open) and records each result (another transaction). An approval request first lists the media of the entries it asks about, so the dialog is complete.
- **[P] Safety,** for every address, approved or not (this is a server fetching addresses written by untrusted card text):
  - http and https only, ports 80 and 443, no credentials in the address, at most 8192 characters;
  - each host resolved through c-ares (never the shared libuv pool); every answer must be public: private, loopback, link-local, metadata, CGNAT, multicast, documentation, reserved and the server's own interface addresses are refused; the connection goes to the checked address (pinned, so a second DNS answer can't rebind it), keeping the Host and TLS name; checked again on every redirect;
  - fixed request headers only (`accept`, `accept-encoding: identity`): no cookies, credentials, referrer or user-identifying headers;
  - at most 16 MiB a file (fonts 4 MiB), 15 s a file, 128 MiB and 3 minutes of downloads per entry revision, four downloads at once on the server and two per account;
  - the type comes from the bytes (`file-type` on a bounded sample, archives refused before it): PNG, JPEG, GIF, WebP, AVIF; MP3, Ogg, WAV, FLAC, AAC, M4A, WebM audio; MP4 and WebM video; WOFF, WOFF2, TTF and OTF fonts. The response's own type header isn't trusted. **SVG is refused**, as are HTML, scripts and anything else.
- **[P] Storage:** the bytes go in the existing content-addressed media store (`DATA_DIR/media/<2 hex>/<sha256>`, `media_assets`), so the same file saved by two cards or two accounts is one file. Each account's saved addresses are rows of `saved_media` (address, host, kind, state, file, reason), shared by all its entries; `revision_media` says which revisions name which address. That is the per-revision map from address to file.
- **[P] Serving:** `GET /media/saved/<file id>`, for the account that saved it only, with the stored type, `nosniff`, `Content-Disposition: attachment`, `Cross-Origin-Resource-Policy: same-origin`, a `sandbox; default-src 'none'` CSP and a private immutable cache. None of the allowed types is a page, and the CSP sandboxes it if it were opened as one.

### 3.4 Showing a message

- **[D]** Card text isn't rewritten. **[P]** When a message renders, each remote address is looked up (batched, `LookupSavedMedia`) among the account's saved files. A saved one is shown from `/media/saved/…`, whatever entry or message it's in. One still downloading shows a blank placeholder and is asked about again. Any other address follows HTML-MESSAGES' consent rules unchanged: blocked by default, proxied when allowed.
- **[P]** Saved audio plays without the consent (it's this app's own file). Video stays out, saved or not, as before: showing saved video is a later step (the server already keeps MP4 and WebM).
- **[P] No state rule needed:** the existing download queue (HTML-MESSAGES step 5) fetches every address a message's stylesheet names when the message is shown, whatever selectors match, and swaps in local copies. So `.custom-door:checked ~ .custom-room { background: url(https://tracker.example/opened) }` makes its one request when the message shows (only with consent, and never if saved), not when the door is opened: it can't tell the site what you did. An earlier draft of this spec refused remote addresses in stateful rules; that would have dropped working card styling for no gain, so it wasn't built.

### 3.5 The entry's status

- **[P]** Card, preset and lorebook editors get a **Saved media** section: "12 media files saved here", "2 need approval" (**Review**), "1 couldn't be saved" with each address and why, and **Try again** (fetches the failed ones again, approved sites only). It counts the head revision's addresses.
- **[P]** A card's export is its document as stored, so it gives back the card unchanged.

### 3.6 Lifetime

- **[P] Forks and versions:** a fork, a merge, a restore and a new version are new revisions; their addresses join the account's rows, so nothing already saved is fetched again.
- **[P] Updates from a source:** the new revision's new addresses are fetched or wait for approval; old revisions keep theirs.
- **[P] Garbage collection:** purging an entry deletes its revisions, and their `revision_media` rows with them. The hourly media sweep then deletes the account's addresses no revision names any more, the files nothing else uses, and their bytes on disk.

## 4. The existing consent, compared

HTML-MESSAGES' "Images from other sites" is per card and per chat (and an account default), and it's about **viewing**: each time a message shows, its media is loaded from the other site through `/media/external`. The approved sites list is per **site** and about **saving**: a file is fetched once, when the entry is saved, and never again while viewing.
- Example: approving `i.imgur.com` and keeping "Images from other sites" blocked shows a card's saved imgur images (from this server) and blocks an imgur image a model writes into a reply, since that one was never saved.
- **[P] Recommendation:** keep both. They answer different questions (which sites may learn that you saved a card, against which messages may contact sites while you read). Merging them into "trusted media hosts" would make allowing a site for saving also allow it for every message, which the owner's IP-grabbing concern argues against.

## 5. Open

- **[O]** Media a model writes into a reply (an address not in any saved entry) keeps the consent rules. Recommendation: offer to save it from the message's blocked-media note, through the same approved sites and the same fetcher, rather than fetching while viewing.
