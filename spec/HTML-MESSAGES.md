# HTML in messages

**Status: Proposed, 2026-11-07 (htmlmsg); steps 1 (inline HTML) and 2 (frames with scripts off) built 2026-11-07 (htmlbuild), documented in ARCHITECTURE §1 and §12 "HTML in messages, inline" and "document blocks in frames". Built as a delta from §3.3: frames are `sandbox="allow-scripts"` with the frame page's CSP running only the bootstrap, not `sandbox=""`, which would stop the bootstrap and with it delivery and height. Step 3 (script approval, bridge Tier A, `/frame/lib/`, the internet switch) built 2026-11-07 (htmlbuild), ARCHITECTURE §12 "panel scripts and the bridge", with two deltas: a panel's scripts follow its character's card, plus the preset only when its display scripts write scripts, and both must allow them; and merges, restores and a replaced card keep the head's permissions rather than dropping them. Step 3 also closed the security review's two lows: the frame page without scripts names its bootstrap by a nonce rather than by path or `'self'`, and the sanitizer reads link addresses as the browser does (padded fragments, `xlink:href`-only SVG links). Step 4 (`context.htmlDepth` and its setting, default As written) built 2026-11-07 (htmlbuild), ARCHITECTURE §12 "HTML in older messages sent to the model" and §15's stage list, with two deltas: a summary request is left as the prompt scripts leave it, and only HTML's own elements lose their tags, so a model's `<status>` markers and reply-section tags stay. Steps 5 and 6 are not built.** Owner decisions are in DESIGN §10.2 and §6 below (**[D]**). Everything below is **[P]** unless it cites one. The proposal is a delta from SillyTavern 1.19.0 (`7e8663cd`) plus the JS-Slash-Runner extension, and from rp-harness master `60d95d2b` (ARCHITECTURE §1 CSP, §10 display transforms, §12 rewrites and message rendering, §15 prompt scripts). reference-harness has nothing to reuse here: its replies go to chat platforms and are never rendered as HTML. Its compact/rich tiers (§4.3) are the only precedent.

Scope: HTML that cards, regex scripts and models put into message text, which existing cards need. Model-driven UI (widgets and stages whose state the model updates through tools, DESIGN §10.2 [L]) is a separate, later discussion and is not covered here.

Sources, all public and cloned read-only under `<work>/ref/`: `SillyTavern-1.19.0`, `DOMPurify-3.4.2` (the version ST's `package.json:48` asks for), `JS-Slash-Runner` (Tavern Helper 4.12.0, `6897ed6c`), `LittleWhiteBox` (`707e03f2`) and `MagVarUpdate` (`d03b7dc8`). Every example below is synthetic.

## 0. Summary

- **ST renders message HTML inline, sanitized, by default.** It drops scripts and iframes, keeps `style` attributes, scopes `<style>` to message bodies and blocks external media. Cards that need JavaScript depend on an extension (Tavern Helper, LittleWhiteBox), which runs it in **same-origin, unsandboxed** iframes that can reach the whole ST page.
- **The model gets the stored text, HTML included.** Cards trim it with their own regex scripts: "Alter Outgoing Prompt" with a minimum depth, so only the last few messages keep their status panels.
- **The proposal:**
  1. Render inline HTML about as ST does, sanitized by a schema derived from DOMPurify's defaults, with five fixes.
  2. Run full-document HTML blocks (Tavern Helper's "frontend" blocks) in frames with an opaque origin and their own CSP. Their scripts stay off until the user approves them for the card.
  3. The model side stays as it is: ST's regex depths, already built.
- **Nothing stored in messages changes.** The only additions are an optional approval flag on cards and presets and two account display preferences. All can be added later without migrating anything (§5).

## 1. What SillyTavern does

### 1.1 Rendering a message (`public/script.js` `messageFormatting`, 1800–1970)

The steps run in this order:

1. **Display regex.** Scripts with "Alter Chat Display" (`markdownOnly`) run with the message's depth among non-system messages (1851–1864). Depth is counted when the message renders: 0 is the last message. This is usually where status-panel HTML is *made*: a script replaces `<status>…</status>` or a placeholder tag with markup.
2. **Fix Markdown.** `fixMarkdown` runs when `auto_fix_generated_markdown` is on, which is the default (1871; `power-user.js:185`).
3. **"Show \<tags\> in responses"** (`encode_tags`, default **off**, `power-user.js:301`; label at `index.html:5451–5453`). When on, every `<` and every non-blockquote `>` becomes an entity (1875–1879), so HTML shows as text. When off, which is the default, HTML goes through.
4. **Quote colouring skips markup.** Double quotes inside tags are masked (1894–1898, restored at 1929–1931), so attribute values aren't coloured as dialogue. `<style>…</style>` and code are skipped (1900–1926).
5. **Showdown.** The options are `simpleLineBreaks`, `tables`, `underline`, `strikethrough`, `parseImgDimensions`, `literalMidWordUnderscores` and emoji (521–539). Raw HTML passes through Markdown as it normally does.
6. **`<style>` handling** (`public/scripts/chats.js`, code from RisuAI):
   - `encodeStyleTags` (536–541) hides each bare `<style>` (no attributes) from the sanitizer as `<custom-style>` with URI-encoded text.
   - After sanitizing, `decodeStyleTags` (551–624) parses the CSS. It prefixes every selector with `.mes_text ` (560), renames classes to `.custom-…`, drops `@import` (605), and drops every declaration whose value contains `://` when external media is blocked (564–566).
   - The prefix is the class of **every** message body. A style in one message therefore applies to the matching elements in all rendered messages, but never to ST's own UI.
7. **DOMPurify** with `MESSAGE_SANITIZE` (1957–1967) and ST's hooks (`chats.js:1901–2050`):
   - **Tags:** DOMPurify 3.4's default HTML list (`src/tags.ts:3–123`), plus SVG and MathML. It includes `style`, `details`/`summary`, `form`, `input`, `button`, `select`, `textarea`, `audio`, `video`, `img` and `canvas`. `script`, `iframe`, `object`, `embed`, `link`, `meta` and `base` are not on it.
   - **Attributes:** `on*` attributes and `javascript:` URLs are removed. `style` and `data-*` attributes are kept (`ALLOW_DATA_ATTR` default true, `purify.ts:299`).
   - **Unknown tags** such as `<Status>` or `<UpdateVariable>` are removed but their text is kept (`KEEP_CONTENT`). Line breaks inside them become `<br>` first (1943–1972). A model's `<UpdateVariable>` block therefore shows as loose text unless a display script hides it.
   - **Classes** are prefixed `custom-`, except `fa-*` (Font Awesome, which ST ships), `note-*` and `monospace` (1910–1935).
   - **Links:** every element with a `target` gets `target="_blank" rel="noopener"` (1903–1908).
8. **External media.** "Forbid External Media" is **on** by default (`power-user.js:336`; `index.html:5439`).
   - The hook removes `img`, `audio`, `video`, `source`, `track`, `embed` and `object` elements whose `src`, `data` or `srcset` points to another origin (1975–2030).
   - The first block shows a toast pointing to the "Ext. Media" button (2036–2047).
   - That button sets a per-character or per-group override, allow or forbid (`chats.js:852–867`, `index.html:6169`).
9. **Scripts and iframes.** ST itself never runs message JavaScript and never makes a frame. A message can also carry `extra.display_text`, which is shown instead of `mes` while `mes` is still what's sent (2522–2536). The translate extension uses it.

### 1.2 What reaches the prompt

- **The stored text, raw.** Prompt building takes `chatItem.mes` (never `display_text`) and runs only the "Alter Outgoing Prompt" (`promptOnly`) scripts, each with the message's depth (`script.js:4501–4506`, `engine.js:334–381`). `encode_tags` and the sanitizer don't touch the prompt. HTML the model wrote, or a greeting carried, goes back to the model as written.
- **Scripts with neither flag rewrite the stored text** when it's received (6481) or sent (5875), and they run without a depth. Their editor warns: "By default, regex scripts alter the chat file directly and irreversibly" (`regex/editor.html:149–159`).
- **Min/max depth** (`engine.js:361–372`; help text at `editor.html:112`): "only affect messages that are at least N levels deep. 0 = last message".
- **The common pattern, from MagVarUpdate's tutorial** (`doc/tutorial.md:21–40`):
  - The model writes `<UpdateVariable>…</UpdateVariable>` in every reply. A card script with both flags removes it from both the display and the prompt.
  - The reply also ends with a placeholder (`<StatusPlaceHolderImpl/>`). A prompt-only script removes it from the prompt, and a display script turns it into the status bar's HTML.
  - Cards that keep the panel in recent turns add a minimum depth to the prompt-side removal, so the last N messages still show the model its own format.

### 1.3 The extensions that run card HTML and JavaScript

- **Tavern Helper (JS-Slash-Runner, "酒馆助手").** Its README opens with a warning that scripts can steal API keys and chat history. How it works:
  - **Detection:** a fenced code block whose text contains `html>`, `<head>` or `<body` is a "frontend" (`src/util/is_frontend.ts:1–3`).
  - **Rendering:** the block is swapped for an `<iframe srcdoc>` that has **no `sandbox` attribute** (`src/panel/render/Iframe.vue:2–11`), so it's same-origin with ST.
  - **What's in the frame:** the wrapper (`src/panel/render/iframe.ts:78–103`) loads jQuery, jQuery UI, Vue, Vue Router, Tailwind and Font Awesome, mostly from jsDelivr (`src/iframe/third_party_message.html`). `predefine.js:1–34` copies `window.parent`'s lodash and the `TavernHelper` API into the frame and exposes `SillyTavern.getContext()`.
  - **The API** covers chat messages (`getChatMessages`, `setChatMessages`, …, `src/function/chat_message.ts`), variables at chat, message, character, preset and global scope (`variables.ts`), `triggerSlash`, generation, lorebooks and presets. That is everything ST can do.
  - **Settings** (`src/type/settings.ts:61–72`): rendering is **on by default** (`render.enabled: true`). `render.depth` 0 means every message gets a live frame; `calcToRender` limits frames to the last N otherwise (`src/store/iframe_runtimes/message.ts:42–56`). Frames aren't made while a reply streams (`allow_streaming: false`).
  - **Approval:** message frames need **no approval**. Only card- and preset-embedded *scripts*, background code in hidden frames stored in `data.extensions.tavern_helper` (`settings.ts:3`), are listed per card or preset in `script.enabled` and prompted once (`src/panel/script/use_check_enablement_popup.ts`).
  - **Macros:** it adds macros such as `{{get_message_variable::path}}` (`src/function/macro_like.ts:98`).
- **LittleWhiteBox ("小白X")** does the same with its own detection: `<!doctype`, `<html`, `<script`, or a bare HTML fragment (`modules/iframe-renderer.js:77–90`). Its message frames are unsandboxed too (`createRenderIframe`, 264–273) and talk to ST over `postMessage`. Only its draw-tool host uses `sandbox="allow-scripts"`.
- **MagVarUpdate (MVU)** is a Tavern Helper script that cards import **from a CDN at run time** (`import 'https://gcore.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate@master/artifact/bundle.js'`, tutorial line 22). It keeps `stat_data` and `display_data` in message variables. A card's status-bar frame reads them with `getChatMessages(getCurrentMessageId())` (tutorial 185–198).

### 1.4 How cards depend on all this

There are three shapes. All three exist in public cards, and the third depends on an extension.

1. **Inline HTML and CSS in a greeting or reply:** coloured boxes, `<details>` spoilers, tables, CSS-only "games" built on `:checked` and `<details>`. This needs ST alone.
2. **A display script that turns the model's tagged output into HTML,** with captures: `<hp>(\d+)/(\d+)</hp>` becomes `<div class="bar" style="width:calc($1/$2*100%)">`. The data is inline. This needs ST alone.
3. **A full HTML document in a fenced block, with JavaScript,** often built by a display script from a placeholder, reading variables through the Tavern Helper API or doing its own work (dice, a map, a phone UI). This needs Tavern Helper, its CDN libraries, and often MVU.

## 2. What rp-harness has now

- **Rendering** (ARCHITECTURE §12, "Message rendering"):
  - Streamdown with rehype-sanitize and rehype-harden. **Raw HTML stays literal text** (rehype-raw is stubbed), which is ST with "Show \<tags\>" on.
  - Images can't load. Links open in a new tab without a referrer.
  - Quote colouring already skips quotes inside literal HTML attributes (PLAN, w3r).
- **CSP** (ARCHITECTURE §1): `script-src 'self'`, `style-src 'self'`, `img-src 'self' blob:`, `connect-src 'self'` plus the instance's WebSocket, `object-src 'none'`, `form-action 'self'`, `frame-ancestors 'none'`.
  - Inline `<style>` elements and `style="…"` attributes in parsed HTML can't apply under `style-src 'self'`. Styles React sets through the DOM can.
  - `RequestGuard` refuses `Origin: null` (`net/exposure.ts`, `crossSiteProblem`: `URL.parse("null")` is null).
- **Display regex** (ARCHITECTURE §10, "Opt-in display transformations"):
  - `markdown_only` scripts from the global, preset and card lists, each gated by its approval.
  - Depth is counted from the viewed fork's tip, as are reasoning panels and streaming.
  - Their output goes through the same sanitizer.
- **Prompt regex** (§15): `prompt_only` scripts with min/max depth in assembly, and the cache layout already knows about them. A message a depth-bounded script will change as it gets deeper is marked `volatile` (`Stability`).
- **Stored-text rewrites** (§12, "Rewrites"): scripts with neither flag rewrite the text, and the raw text stays on the version (`version_texts.raw_content`).
- **DESIGN §10.2 [P] ideas:** a sandboxed iframe ("no same-origin access, ideally a separate origin, a strict CSP, and a narrow `postMessage` bridge", after AIRI's CVE-2025-59053), and a display form and context form per version (reference-harness's rich/compact split). CLIENT-FRAMEWORK R9 and §5 add a capped number of live iframes in the virtualized list. PLUGINS §6.3 says browser code may send only to our server.

## 3. The proposal

### 3.1 Three kinds of HTML

The client classifies each message's display text: the stored text after the display transforms (macros, display regex). Each kind gets its own treatment:

| Kind | Example | What renders | Where |
|---|---|---|---|
| **Inline markup** | `<div class="hp">HP <b>12</b>/20</div>` | Sanitized elements inside the message body | The app's DOM, under the message (§3.2) |
| **Unknown tags** | `<Status>HP 12/20</Status>`, `<UpdateVariable>…</UpdateVariable>` | The tag goes and the text stays, as in ST | Same as above |
| **Document blocks** | a ```` ```html ```` block containing `<body>`, `<head>` or `html>` (Tavern Helper's test) | A frame (§3.3) | A frame in the message |

- **When:** at render, after the display transforms, on the text as shown. The stored text never changes.
- **Streaming:** inline markup renders as it streams, since the parser closes open tags. A document block shows as a collapsed "Panel loading" box until the reply finishes, then its frame starts (Tavern Helper's default).
- **The switch:** a viewer preference **"Show HTML as formatting"**, on by default (ST's default). Off, everything shows as text, as today.
- **Copying** (fcopy, DESIGN §10.2 [D]): a selection across rendered HTML copies its source text, as it does for Markdown. A frame copies as its whole source block.
- **Registry:** the classifier, the inline schema and the frame renderer are registered `messageRenderers` parts that a plugin can replace or disable (memory: self-customizable harness).

### 3.2 Inline markup: ST's sanitizing, with five fixes

The **schema** is a `hast-util-sanitize` schema generated from DOMPurify 3.4's default HTML and SVG tags and attributes. It is checked against DOMPurify on a fixed corpus, so whatever survives in ST survives here. It is rehype-raw and then sanitize, never `innerHTML`, so React still renders the tree and the sanitizer stays in one place.

**Kept, as in ST:**
- `style` attributes, which React applies through the DOM, so the CSP allows them.
- `class`, prefixed `custom-`, and the card's CSS rewritten to match.
- `<details>`, `<summary>`, tables, `<svg>`, form controls and `data-*`.

**Removed, as in ST:**
- `script`, `iframe`, `object`, `embed`, `link`, `meta` and `base`.
- `on*` attributes and `javascript:` URLs.

**`<style>`**, as ST (§1.1 step 6):
- The CSS is parsed. Selectors are prefixed with the message-body scope, classes renamed to `custom-`, `@import` dropped, and remote `url()` dropped while external media is blocked.
- Under our CSP it can't be a `<style>` element. It goes into one **constructed stylesheet** for the chat view (`document.adoptedStyleSheets`), which `style-src 'self'` doesn't govern. An e2e check under `e2e/csp.spec.ts` proves it.
- **Scope, default:** as ST, every message body. The styles come from every message in the loaded window, not only the rows on screen, so a style defined in a greeting keeps applying while the greeting is scrolled away.
- **Scope, alternative:** each message's styles apply only to that message. That is safer and simpler, but it breaks cards that style later replies from their greeting.

**Five fixes against ST.** Each one closes something ST leaves open.
1. **Contain the message.** The message body gets `contain: layout paint` and `isolation: isolate`. A `position: fixed` element is then positioned and clipped inside its own message and can't cover the app. In ST, `.mes_text .custom-x { position: fixed; inset: 0 }` covers the whole UI, which is a phishing surface.
2. **Forms become `div`s,** and `action`, `formaction` and `method` are dropped. In ST a submit would navigate the page. Here a GET submit would reload the app. Inputs stay, so CSS-only games still work.
3. **`id` and `name` get a `user-content-` prefix** (hast-util-sanitize's `clobberPrefix`), so message markup can't clobber globals or the app's own ids. In-message `href="#…"` links are rewritten to match.
4. **Links** open in a new tab with `noopener noreferrer`, as now. Only `http:`, `https:` and `mailto:` are allowed.
5. **Font Awesome classes** (`fa-*`) are kept unprefixed as in ST, but they show nothing, because we don't ship Font Awesome. Vendoring its free set is a later option.

**Media:**
- **`data:` images** are allowed: they make no request. The CSP's `img-src` gains `data:`.
- **External media** (`http(s):` sources, CSS `url()`) is **blocked by default** (ST's default). The message shows a small "Images from other sites are blocked" note with a button: **Allow for this card / Allow for this chat**, the counterpart of ST's per-character override.
- **When allowed:** images load through an authenticated route, `GET /media/external?url=…`. The server answers only for a card or chat the user allowed it for, only for image and audio types, size-capped, public addresses only, and no redirects to private ones. The app's `img-src` stays `'self' data: blob:`, so a sanitizer bug still can't beacon chat text to another site (PLUGINS §6.3). It is not an open proxy (DESIGN §11, ST's 2026 CVEs).
- **Alternative:** widen the app's CSP to `img-src https:` and rely on the sanitizer alone. It's simpler, but it removes the second wall.

### 3.3 Document blocks: frames

- **What:** each document block becomes an `<iframe sandbox="allow-scripts">` (or `sandbox=""` while its scripts are off, §3.4). It **never** gets `allow-same-origin`, `allow-top-navigation`, `allow-popups`, `allow-forms` or `allow-modals`.
  - The frame's origin is opaque. It can't read the app's DOM, storage or cookies, and its requests carry `Origin: null`, which `RequestGuard` refuses.
  - A `srcdoc` or `blob:` frame would inherit the app's CSP and couldn't run inline script at all. Instead the frame loads a fixed URL, `/frame/panel`, served by our server with its own CSP:
    `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' <origin>/frame/lib/; style-src 'unsafe-inline' <origin>/frame/lib/; img-src data: blob:; font-src data: <origin>/frame/lib/; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors <app origin>`.
  - The app's own CSP already allows `frame-src 'self'` through `default-src`.
- **Delivery:** the frame loads our bootstrap. The parent posts the block's text once the bootstrap says it's ready, and the bootstrap writes it as the frame's document. The HTML never goes in the URL.
- **What the frame gets:** only its own block's text after the display transforms. It gets more only through the bridge (§3.4).
- **Vendored libraries:** `/frame/lib/` serves the set Tavern Helper injects, at pinned versions from our own server: jQuery, jQuery UI, lodash, Vue, Vue Router and the Tailwind runtime. Blocks that expect them work without network access.
- **Network:** none by default (`connect-src 'none'`, no remote scripts).
  - An approved card can also get **"Let this card's panels use the internet"**. Its frames are then served with `https:` added to `script-src`, `style-src`, `img-src` and `connect-src`.
  - The explanation says plainly that the panels can then send what they're shown to other sites. That needs this switch in addition to script approval.
- **Size:**
  - The bootstrap reports the document's height. The parent sizes the frame to it, at most twice the viewport height, scrolling beyond that.
  - The frame's `vh` is the chat column's height, passed as a CSS variable. Tavern Helper does the same (`iframe.ts:5–75`).
- **Virtualized list** (CLIENT-FRAMEWORK §5):
  - A frame mounts while its row is on screen or near it. Offscreen it keeps its last height as a placeholder.
  - At most 8 live frames per chat view. The oldest offscreen frame unloads first.
  - A frame that unloads loses its script state, as a reloaded ST chat does.
  - **Panel depth:** "Run panels in the last N messages", default all. Older document blocks show collapsed with a **Run panel** button. This is Tavern Helper's `render.depth`, relative to the viewed fork's tip.
- **Theme:** the frame gets the theme's text, background and accent colours as CSS variables. Cards that ignore them look as they do in ST.

### 3.4 Scripts: yes, sandboxed, off until approved

**[D] Card JavaScript is supported, sandboxed, and runs only once the card or preset is approved** (owner, 2026-11-07: "Okay.", to the default below). DESIGN §11 [D] says content must never become code. A card's panel script is content that runs as code, so the rule is read as "never code that can reach the three lines of attack":
- **Credentials:** the frame has no origin, no cookies and no RPC.
- **The user's system:** the browser sandbox.
- **Exfiltrated chats:** no network unless the user allows it, and it sees only its own block and what the bridge answers.

The alternative that wasn't chosen: never run card JavaScript. Document blocks would then render in `sandbox=""` frames with scripts off, and shapes 1 and 2 (§1.4) would work fully.

**Approval:**
- **What:** scripts in a document block run only when the source that made the block is approved for scripts, as display-regex approval follows its source:
  - the speaker's card, for blocks in the stored reply or made by its card scripts;
  - the preset, for blocks its scripts make;
  - the user, for global scripts.
- **Stored as:** a new optional `html_scripts_approved` on cards and presets, set like `regex_approved`. Import never sets it and export never writes it (DESIGN §11: a file never grants itself capabilities).
- **Unapproved blocks:** they render with scripts off. Static HTML and CSS still show, under a strip: "This panel has scripts. **Run scripts from Lantern Inn**". It's a visible button with an explanation popover (memory: visible affordances, explain on hover).
- **ST comparison:** Tavern Helper asks nothing for message frames. Ours asks once per card.

**The bridge**, the frame's only capability. It's `postMessage` with a fixed message schema, validated in the parent. It comes in two tiers.
- **Tier A (built first):** no data API. The frame can report its height, ask to open an `http(s)` link (the parent opens it in a new tab after the frame's click), and copy text to the clipboard on a click.
  - Shape 3 blocks whose data is inline work with this alone: the display script put the captures into the HTML.
- **Tier B (a later plugin, `frames.tavernHelper`):** a read-only subset of the Tavern Helper API. It's enough for status bars that read variables (MVU):
  - `getCurrentMessageId`;
  - `getChatMessages` for the frame's own message and **earlier ones only** on the viewed path (memory: causal order);
  - `getVariables` for chat and message scope;
  - a small `SillyTavern.getContext()` with the names;
  - events for "this message changed".
  - Message variables map onto positional state keys a plugin registers (ARCHITECTURE §3, `registerStateKey`). That needs no baseline change.
  - **Writes** (`setChatMessages`, `triggerSlash`, generation) are **not** offered. A panel that needs them would go through the agentic tool path (DESIGN §7) with its approvals, which belongs to the model-driven UI discussion.
- **Card background scripts** (Tavern Helper's `data.extensions.tavern_helper` scripts, MVU's CDN import) aren't run. They keep their place in `extensions` and export unchanged (PLUGINS §3.3).

### 3.5 Settings

| Setting | Where | Default | What it does |
|---|---|---|---|
| Show HTML as formatting | Interface chat panel (account display prefs, beside display regex) | **On** (ST: "Show \<tags\>" off) | Off shows every message's HTML as text, as today |
| Images from other sites | Account default plus a card or chat override, from the note in the message | **Blocked** (ST: Forbid External Media on) | Allow loads them through `/media/external` for that card or chat |
| Run panels in the last N messages | Interface chat panel | **All** (Tavern Helper: 0, which means all) | Older panels show collapsed with Run panel |
| Run scripts from \<card\> | Card (and preset) approval, beside regex approval | **Off** (Tavern Helper: on, no prompt) | Panels from that source run with scripts |
| Let this card's panels use the internet | Card approval, only once scripts are approved | **Off** | Its frames may load and send to `https:` |
| HTML in older messages sent to the model | Chat settings, Context | **As written** (ST) | §3.6 |

### 3.6 What the model sees

- **As in ST, and already built:** the model gets the stored text after its `prompt_only` scripts, with each script's depth (§15). A synthetic card with a status panel ships:
  - a display script, `<status>(.*?)</status>`, rendering `<div class="custom-status">$1</div>`;
  - a prompt script with minimum depth 3, `\n?<status>[\s\S]*?</status>`, replacing it with nothing.

  For the last three messages the model sees `Mira pours the tea. <status>HP 12/20 · Day 3</status>`. From depth 3 on it sees `Mira pours the tea.` The cache cost: each turn one message crosses depth 3, so the prompt changes from there on and about three messages are recomputed per turn. Assembly already marks them `volatile`. This is enough for existing cards. **Nothing changes in assembly for them.**
- **One addition, for HTML no card script trims:** a built-in prompt stage, `context.htmlDepth`, a registered assembler stage that can be replaced or disabled. It covers models told by a preset to draw panels, and greetings full of markup. The setting "HTML in older messages sent to the model" offers:
  - **As written** (default, ST)
  - **Text only after N messages:** tags removed, text kept: `<div class="hp">HP <b>12</b>/20</div>` becomes `HP 12/20`.
  - **Leave out panels after N messages:** document blocks are dropped whole and inline markup is reduced to its text.

  N defaults to 4. The stage runs after the card's prompt scripts and keeps the cache layout as they do: a message that changes at depth N is `volatile`.
- **[D] Default: As written** (owner, 2026-11-07: "Okay."): HTML is not trimmed from older turns by default, as in ST. The [D] that "per-turn HTML makes the context explode" is met by the cards' own scripts, which already do this. A second built-in rule would trim what the card author meant to keep.
- **Alternative not chosen as default:** "Text only after 4", still offered as a setting. It saves tokens on cards that don't trim, but it changes ST-compatible prompts silently, against ST-DRIFT's "nothing changes silently".
- **Stored forms are not needed.** DESIGN §10.2's display/context forms and reference-harness's compact tier are both computed:
  - reference-harness renders the compact form from the stored timeline when it builds a session (`src/context/renderer.ts:193`, `renderCompactMessage`; tier sizes in `src/context/compaction.ts:100–120`). It freezes the prefix for the session (reference-harness ARCHITECTURE "Frozen context (built once)"), so the rich/compact boundary doesn't move every turn.
  - The delta here is the same idea per request: the "context form" of an older message is the stored text through its prompt scripts and `context.htmlDepth`, never a second stored text.
  - A form only a model could write, a one-line summary of a panel, is LCM's job (§16), which already keeps its own summaries.
- **If cache cost from moving depths matters later:** a "depth step" option (scripts and `context.htmlDepth` change messages in batches of K) would move the boundary every K turns instead of every turn, like reference-harness's frozen prefix. That's an assembler change, not a storage change.

### 3.7 The AIRI lesson, as checks

In AIRI (CVE-2025-59053), card text rendered as HTML in the app's own realm, and that realm could call Tauri IPC, which gave RCE. The lesson has three parts, and each becomes a check.
1. **Markup in the app's realm never executes.** The sanitizer schema has no script, no `on*` and no `javascript:`. Behind it, the app's CSP `script-src 'self'` is a second wall. Test: a corpus of known DOMPurify bypass strings, run as message text, executes nothing under `e2e/csp.spec.ts`.
2. **Whatever executes can reach nothing.** Frames never get `allow-same-origin`. `Origin: null` is refused on every route and on the WebSocket. Frames get no tokens and no RPC. Tests: a frame that tries `fetch('/rpc')`, `new WebSocket`, `parent.document`, `top.location=` and `window.open` gets an error or nothing, with its scripts on.
3. **The bridge is the only capability, and it's an allowlist.** Every message type has a schema. Unknown types are dropped. Nothing writes. Reads follow causal order and the chat's owner.

**Later, for a Capacitor build (CLIENT-FRAMEWORK):** the native bridge must not be injected into frames, so the same check runs in that build.

**A separate frame origin** is optional hardening (DESIGN §10.2's "ideally"): a `FRAME_ORIGIN` deploy setting serves `/frame/` from another host or port, under the same exposure rules (DESIGN §11). The opaque-origin sandbox is the boundary either way. The separate origin also lets the browser put frames in their own process.

## 4. What changes, step by step

1. **Inline HTML:**
   - turn on rehype-raw with the generated schema;
   - the CSS scoper and its constructed stylesheet;
   - the containment CSS;
   - the "Show HTML as formatting" preference;
   - the external-media note.

   This covers shapes 1 and 2.
2. **Frames with scripts off:**
   - `/frame/panel` and its CSP;
   - the bootstrap, height and virtualization;
   - the panel depth.
3. **Script approval and bridge Tier A; vendored libraries; the internet switch.**
4. **`context.htmlDepth`.**
5. **`/media/external`.**
6. **Later:** the Tier B plugin.

Each step lands with its e2e at 1440/390 in both themes and the layout audit.

## 5. Storage

**Nothing stored in messages changes.** Versions keep their text as written or rewritten, exactly as today. Display and context forms are computed, never stored (§3.6). The additions are all optional or new keys that need no migration and no re-import:
- an optional `html_scripts_approved` and `html_network_approved` on the card and preset documents (absent means off);
- the external-media allowances per card and chat (settings rows);
- two display preferences and one chat setting (settings);
- Tier B's message variables as a plugin's state key (later).

None has to land before daily use: absent means off, and a message stored today renders the same under every step.

## 6. The owner's decisions

Both decisions put to the owner were accepted as proposed (owner, 2026-11-07: "Okay.").
- **[D] Card JavaScript is supported** (§3.4): in opaque-origin frames, off until approved per card or preset, with no network unless allowed.
- **[D] HTML is not trimmed from older turns by default** (§3.6): as written, as in ST, with the setting available.
