# Client framework evaluation

**Status**: Proposal, revision 2 (2026-10-10: owner input in §6, with the recommendation revised; performance harness §7; design-system timing §8). **Framework: React [D]** (owner, 2026-10-10). The rest of the stack in §6.3 and the proposals in §5, §7 and §8 are still [P]. Items marked [D] in §6.1 are the owner's statements.
**Owner's framing [D]**: UI quality for real users is the most important thing, and the client framework is one of the main stack decisions. reference-harness's console stack (SvelteKit + bits-ui) was a minor choice for an admin monitoring UI, so it isn't the default here.

---

## 1. What the UI has to do

These requirements come from DESIGN.md, and they're what the candidates are judged on. Each is tagged with the hard part it raises.

| # | Requirement (DESIGN ref) | What makes it hard |
|---|---|---|
| R1 | Chats of unlimited length (§8), opened at any point via URL (§10.1) | Virtualized, bottom-anchored list with variable-height items; prepend older messages without scroll jumps; jump to a slot deep in the history |
| R2 | Any number of concurrent generations (§10.1), parallel swipes streaming under one slot (§3.1), live expanded rollout steps (§7.4) | Many token streams at once over one WebSocket; each must update only its own message, never re-render the list |
| R3 | Nothing locked during generation (§10.1) | Streaming must not block input, navigation or other editors; main-thread budget matters |
| R4 | Version picker built for dozens of versions, side-by-side comparison (§3.1) | Dense, fast UI; swipe gestures on phones |
| R5 | Composition scratchpad: select text in any version, assemble, commit (§3.1) | Cross-element text selection, a real editor, persisted drafts |
| R6 | Server-persisted drafts and field-level undo for every text field (§6.2) | The editor must expose a transaction or change model we can serialize and replay |
| R7 | Search and replace everywhere; diffs; three-way merge resolver (§4, §6.2, §10.3) | Editor search/replace, diff and merge views |
| R8 | Large structured editors: presets (reorderable prompt lists), cards, lorebooks (§1.2, §4) | Forms with drag reordering, long lists, keyboard use |
| R9 | Sanitized markdown; model HTML only in sandboxed iframes (§10.2, §11) | Fast incremental markdown rendering while streaming; iframe lifecycle inside a virtualized list |
| R10 | Every view has a URL; multiple tabs; back button (§10.1) | Client routing; state comes from the server, not tab-local stores |
| R11 | Server is the source of truth; WebSocket subscriptions; optimistic concurrency (§10.1, DATA-MODEL §10) | A client store fed by server pushes, with optimistic updates and rollback |
| R12 | Phones: must work well for a real release (§10.1), web push (§10.1) | Gestures, bottom sheets, safe areas, virtual keyboard handling; maybe a native shell later |
| R13 | Notifications: badges, tab title, favicon (§10.1) | Minor, framework-neutral |
| R14 | Plugins, eventually written by the agent itself, that extend the UI at runtime (§10.4, §12) | Loading UI code without rebuilding the app; isolating untrusted UI |
| R15 | Imported content never executes (§11) | Strict CSP; no `eval` paths in rendering |
| R16 | Code is mostly written by coding agents (OVERVIEW "Why") | How well current models know the framework and its current idioms; ecosystem churn |

Accessibility, keyboard navigation and theming apply throughout.

---

## 2. Research snapshot (2026-10-10)

Versions were checked against the npm registry and release notes on 2026-10-10. Claims marked *(unverified)* come from secondary sources only. Sources are in §7.

| | React | Svelte 5 | Vue 3 | Solid |
|---|---|---|---|---|
| Stable core | 19.3 (Sep 2026), Compiler 1.0 stable | 5.57; SvelteKit 3.0 stable on Oct 1, 2026 (breaking) | 3.5; 3.6 RC (alien-signals; Vapor opt-in, not stable) | 1.9; **2.0 is an RC** (API frozen, large break); SolidStart replaced by "Start mode" |
| Update model | VDOM. Fine-grained only with an external store and per-row selectors | Signals. Fine-grained by default | VDOM, re-rendering per component. Vapor makes it fine-grained (RC) | Signals. The most fine-grained |
| SPA on our own server | Vite + TanStack Router, or React Router 8 data mode | Vite + SvelteKit (`ssr=false`), or plain Svelte | Vite + Vue Router | Solid 2 Start mode (new) |
| A11y primitives | Base UI 1.x (shadcn's default since Jul 2026), React Aria (strongest a11y, touch/press/drag), Radix | bits-ui 2, shadcn-svelte; Melt UI stalled | Reka UI 2 (ex-Radix Vue), shadcn-vue | Kobalte 0.13 (its 2.0 port is alpha), Ark UI |
| Bottom sheet / drawer | vaul, Base UI | vaul-svelte stuck at a 2025 prerelease | vaul-vue (Mar 2025) | corvu drawer |
| Editors | Tiptap 3 official binding; Lexical (pre-1.0); CodeMirror 6 | Tiptap: community binding only; CodeMirror 6 | Tiptap 3 official binding; CodeMirror 6 | solid-tiptap is stale and has no 2.0 port; CodeMirror 6 |
| Chat virtualization | TanStack Virtual chat mode (May 2026; only React examples); virtua; Virtuoso message list (commercial) | TanStack Virtual core (chat mode should work, but there are no examples); virtua | same as Svelte | same as Svelte |
| Streaming markdown | Streamdown (handles incomplete markdown, hardened sanitize) | build our own | build our own | build our own |
| Runtime plugin UI in the same realm | Plain ESM + shared React through an import map | Must compile against the host's exact Svelte version (the compiled output imports private internals) | Officially supported: runtime template compiler, render functions | No compiler needed |
| Native escape hatch | React Native / Expo (would mean rewriting the DOM UI) | svelte-native alpha | NativeScript-Vue (maintained) | none |
| Agent familiarity | Best | Training data is mostly Svelte 4; official MCP and Claude Code plugin mitigate this | Good (Composition API stable since 2020) | Weak, and 2.0 differs from almost all training data |
| Churn, last two years | High around the edges (Router majors, Radix→Base UI, Jotai 3); core stable | Runes (2024), SvelteKit 3 (2026) | Lowest | Highest |
| AI chat apps on it | LobeHub (moved *off* Next to a Vite SPA), LibreChat | Open WebUI, HuggingFace chat-ui | MaxKB | opencode web |

Cross-cutting findings that hold whichever framework is chosen:
- **Open WebUI's well-known UI problems are architectural, not Svelte's fault:**
  - the whole message is re-sent and its markdown re-parsed on every token
  - no virtualization
  - long chats are slow on phones
  - scroll jumps

  Each one maps to R1/R2, and each one is avoidable in any framework. The framework matters less than the streaming and list architecture (§5).
- **The three-way merge resolver (R7) is custom work everywhere.** `@codemirror/merge` only does two-way diffs.
- **AI chat kits (assistant-ui, Vercel AI Elements) are a trap as foundations.** They're built around single assistant threads and model neither swipes, parallel versions, nor server-owned timelines.
- **Mobile is PWA plus, later, Capacitor in every case.** The UI is DOM-heavy (editors, iframes, diffs), so a React Native or NativeScript rewrite isn't realistic. That makes the native escape-hatch row nearly irrelevant.
- **Next.js, Nuxt, Qwik and Lynx don't fit.** Their value is SSR, RSC, resumability or embedding into native apps; ours is a long-lived WebSocket SPA.

---

## 3. Plugins change the question (R14, R15)

Security comes first (DESIGN §11), and plugin UI will eventually be written by an agent that card text can prompt-inject (DESIGN §7.7). So **agent-written UI must not run in the app's realm.** In the same realm it can read the DOM, the WebSocket and every store, whatever the framework.

**[P]** Two tiers:
- **Sandboxed plugins (the default, and all agent-written UI):** a sandboxed iframe on a separate origin, talking over a narrow `postMessage` bridge. It's the same machinery as model HTML (DESIGN §10.2). The plugin renders its own DOM (any framework, or none), or uses Remote DOM (`@remote-dom/core`) to describe a tree that the host renders with its own components, so it looks native.
- **Trusted in-realm plugins:** first-party, or explicitly installed by an admin. These share the host framework through an import map.

With that split, the framework's own runtime plugin story only matters for the trusted tier. **This removes most of Svelte's plugin disadvantage and most of Vue's advantage.**

---

## 4. Assessment

Ranked on how well each candidate lets us build the hardest parts of this particular UI, at the quality the owner wants:

1. **React: recommended, and chosen by the owner [D] (2026-10-10).**
   - **The hardest components exist and are maintained:**
     - TanStack Virtual's chat mode for R1 (bottom anchoring, prepend with a stable viewport, growth of a streaming last item)
     - React Aria for touch, press and drag behavior, and for a11y on R4/R8/R12
     - Base UI with shadcn for the visual layer
     - official Tiptap and CodeMirror bindings
     - Streamdown for R9
   - **Coding agents write React most reliably (R16)**, and React Router and TanStack ship agent docs.
   - **The weakness is real but contained:** fine-grained streaming (R2) isn't native. The fix is the architecture in §5, which we need in any framework anyway; Open WebUI shows what happens without it. Churn sits in libraries we can choose to avoid (Next, RSC, pre-1.0 state libraries).
2. **Svelte 5: a strong second.**
   - Its update model fits R2 best out of the box, components are concise, and the two largest open-source AI chat UIs prove it can carry this kind of app.
   - It loses on bindings for the hard components:
     - Tiptap is community-maintained
     - the drawer is unmaintained
     - TanStack's chat mode has no Svelte examples yet
     - no React Aria equivalent for touch and drag
   - SvelteKit 3 has just broken APIs, and agents still slip into Svelte 4 syntax.
   - If a prototype showed React struggling on R2/R3 on a mid-range phone, this is the fallback.
3. **Vue 3: viable, and the most stable.** It has official Tiptap, Reka UI and good agent familiarity. But its fine-grained path (Vapor) is still an RC with interop caveats, and its ecosystem for the hard components (chat virtualization examples, touch primitives, streaming markdown) is thinner than React's. It offers nothing that beats both React and Svelte on our hardest requirements.
4. **Solid: not now.** It has the best raw performance, but 2.0 is an RC, its component library for 2.0 is alpha, its meta-framework was just replaced, and agents know it worst. Too much risk for the project's most important layer.

---

## 5. Client architecture, whichever framework is chosen [P]

The research points to these as what decides UI quality more than the framework:
- **Streams don't flow through component state.** The WebSocket client writes token deltas into a normalized store keyed by version id. Rows subscribe to their own version only, and updates are coalesced per animation frame. The server sends **deltas**, never whole messages (Open WebUI #23733).
- **Incremental markdown.** Only the growing tail of a streaming message is re-parsed. Finished blocks are memoized.
- **Virtualized, bottom-anchored list from day one,** with stable keys (slot ids), measured heights, and prepend without jumps. Tested on iOS Safari early, since that's where both virtua and Open WebUI have trouble.
- **The server-state store is the only source of truth (R10/R11).** Optimistic writes carry `row_version`, and the server's reply confirms or rolls back. Tab-local state is limited to view state (scroll position, open panels), which can go in the URL.
- **Sandboxed iframes are virtualized too.** HTML messages render to a placeholder or snapshot when offscreen, with a capped number of live iframes.

---

## 6. Owner input (2026-10-10) and revised recommendation

### 6.1 What the owner said
- **[D]** **Performance on chats of any length is an absolute priority.** The project should show how good a chat frontend for this purpose can be. No corners are cut: it must not be buggy, and it must be very smooth and feel nice to use. Looking good ranks below those, but still matters a lot because of screenshots.
- **[D]** Use TanStack libraries, including Query where it applies (the owner doesn't expect heavy use of it).
- **[D]** Effect is to be strongly considered: see [EFFECT.md](EFFECT.md).
- **[D]** A native app is **later and low priority**. If it happens, it's a thin client that connects to the user's server (a native wrapper around the same frontend), not a standalone phone app. It must not constrain the design: this is primarily a desktop and server power-user tool. Web access from phones is a necessity for many users, but not the main priority.
- Background the owner gave:
  - They know React from work since 2021. They've written no code by hand this year, and they've used Svelte through agents because it has fewer footguns and so gives agents fewer chances to make small mistakes that slow the UI.
  - In their view, both React's training-data advantage and its footgun risk matter less with current frontier models, which can profile an app and remove unnecessary renders.

### 6.2 Revised recommendation: React (confirmed by the owner, 2026-10-10)
The owner's Svelte argument is sound, and it's the main thing React gives up. The decision comes down to two facts that came out of the Effect research:
- **TanStack Router and Start have no Svelte version** (React, Solid and Vue only), and TanStack Virtual's Svelte adapter lags behind React's.
- **Effect's client state (`effect/reactivity` atoms with `AtomRpc`) has official React, Solid and Vue bindings, but no Svelte binding.**

So "TanStack + Effect" points to React. T3 Code and Hazel Chat already ship exactly that combination: Effect RPC over a socket, `@effect/atom-react`, and TanStack Router.

React's footguns are handled by mechanism rather than by trusting agents:
- the React Compiler (stable 1.0) and its lint rules
- components read atoms or selectors, never raw streaming state (§5)
- the performance harness (§7) runs in CI with budgets, so a regression fails the build instead of waiting for someone to notice

The comparative spike React vs Svelte is therefore **no longer proposed**. It's replaced by building the performance harness first, in React.

### 6.3 Proposed stack [P]
| Concern | Choice |
|---|---|
| Build, routing | Vite, TanStack Router (SPA, served by our server) |
| Server state, streaming | Effect RPC client + `effect/reactivity` atoms (EFFECT.md §3). TanStack Query only for plain-HTTP fetches, if any. |
| List virtualization | TanStack Virtual (chat mode) |
| Forms | TanStack Form for the large structured editors (R8), to be confirmed when they're built |
| Primitives | Base UI underneath (behavior, a11y), React Aria where touch, drag and grid behavior matter |
| Styling | Tailwind with a semantic token layer (§8) |
| Editors | CodeMirror 6 for prompts, templates and search and replace; Tiptap only where rich text is needed |
| Markdown | Streamdown, or an equivalent that handles incomplete markdown and sanitizes (R9) |

---

## 7. Performance harness: the first client deliverable [P]

Because performance is an absolute priority **[D]**, the harness comes before the chat UI. Chat work then lands against it.
- **Synthetic fixtures:** a 100k-message chat with realistic markdown, long and short messages, versions and some HTML messages. Generated, never derived from real chats (CLAUDE.md "Privacy").
- **Mock server:** the real RPC protocol (EFFECT.md §5) with a fake provider that streams at configurable rates: 6+ concurrent streams, parallel swipes under one slot, bursty and slow streams.
- **Scenarios:**
  - open at the bottom and at a deep slot
  - scroll the full length
  - prepend while streaming
  - swipe through versions
  - type in the composer during 6 streams
  - switch chats mid-stream
- **Measurements:** frame times (long animation frames), input latency, scroll anchoring error in pixels, memory over time, render counts per streamed token (must be one row).
- **Where it runs:** Playwright in CI on desktop Chromium and WebKit, with budgets that fail the build. Real phones (iOS Safari, a mid-range Android) are checked before each milestone.

---

## 8. Design system timing [P]

The owner's question: build a full design system now (with Claude Design), or build with premade components until the app works, then design?

**Proposal: build first, but keep restyling mechanical from day one.** The owner's reasoning holds: the real surfaces and flows will only be known once they exist, and designing for imagined screens means designing twice. Integrating a design system later costs little **if** these rules hold from the first component:
1. **A semantic token layer.** All color, spacing, radius, typography and motion come from CSS variables named by role (`--surface-raised`, `--text-muted`, `--accent-workshop`, `--version-failed`…). Feature code never uses raw palette classes (`bg-zinc-800`), and a lint rule enforces this. A redesign then mostly means changing token values.
2. **Our own components.** shadcn is copied-in source, so we own it anyway. Feature code imports from our `ui/` package, never from Base UI directly, so restyling happens in one place.
3. **Behavior and look are separate.** Base UI and React Aria carry behavior and accessibility, and our components only style them. A redesign never touches focus, keyboard or gesture handling.
4. **The chat view is the exception.** Message layout (density, avatars, the version picker, inline rollout steps, the summary boundary) is the screenshot surface. It also interacts with virtualization and performance through message heights and how much content each row carries. Proposal: once phase 2's chat view works, do a design pass on it with Claude Design **before** polishing it, rather than waiting for the full design system.

The full design system follows once phase 2's surfaces exist (the chat list, library, composer, editors, inspectors).

---

## 9. Sources

- React releases and the Compiler: https://react.dev/blog · https://github.com/facebook/react/releases
- TanStack Virtual chat mode: https://tanstack.com/virtual/latest/docs/chat · https://tanstack.com/blog/tanstack-virtual-chat
- TanStack Start v1: https://tanstack.com/blog/announcing-tanstack-start-v1
- React Router v8: https://remix.run/blog/react-router-v8 · https://reactrouter.com/how-to/spa
- Next static export limits: https://nextjs.org/docs/app/guides/static-exports
- LobeHub leaving Next: https://innei.in/en/posts/experience/ai-era-refactoring-from-rfc-to-five-plans
- Base UI and shadcn: https://infoq.com/news/2026/02/baseui-v1-accessible/ · https://blog.openreplay.com/shadcn-ui-radix-base-ui-switch/
- virtua: https://github.com/inokawa/virtua
- Virtuoso message list licensing: https://virtuoso.dev/message-list/
- `@codemirror/merge`: https://github.com/codemirror/merge
- Streamdown: https://www.mintlify.com/vercel/streamdown
- Tiptap Svelte guide: https://tiptap.dev/docs/editor/getting-started/install/svelte
- Svelte: https://svelte.dev/blog/sveltekit-3-is-here · https://svelte.dev/docs/svelte/$state · https://svelte.dev/docs/ai/mcp
- Svelte runtime compile constraints: https://github.com/sveltejs/svelte/issues/604
- Open WebUI streaming issue: https://github.com/open-webui/open-webui/issues/23733 (also #5032, #23990, #29234)
- Solid 2.0 RC: https://github.com/solidjs/solid/releases/tag/v2.0.0-rc.0
- opencode web issues: https://github.com/anomalyco/opencode/issues/54147
- Vue 3.6 RC: https://github.com/vuejs/core/releases/tag/v3.6.0-rc.1 · Nuxt 4.6: https://nuxt.com/blog/v4-6
- Lynx: https://lynxjs.org/blog/lynx-open-source-roadmap-2026
- Module federation on Vite: https://nx.dev/docs/technologies/module-federation/vite-module-federation
- Capacitor 8 *(secondary)*: https://blogs.apievangelist.com/blogs/ionic-2025-12-09-announcing-capacitor-8/

**Unverified:**
- independent benchmarks of React under many concurrent streams
- whether TanStack Virtual's chat mode behaves the same in the non-React adapters
- the details of iOS PWA web push
- Radix's maintenance pace
