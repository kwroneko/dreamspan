# Overview

**Status**: Design draft, 2026-10-09. Distilled from the initial planning session. Details are in [DESIGN.md](DESIGN.md), phases in [PLAN.md](PLAN.md).

## Why

SillyTavern became the RP standard in 2023 because its card and preset formats became interoperability standards and it was "good enough". Its core design has not changed since:

- **It is a chat UI, not an agentic harness.** Current models are trained mainly for agentic work with tools, and ST can't take advantage of that.
- **It has no real context management.** Long chats either lose the story or let the context grow without limit.
- **It is a poor web app.** Views have no URLs, tabs conflict, only one generation can run at a time, and much of the state is hidden.
- **Its UX is hostile.** Save behavior is inconsistent, edits destroy previous text, a card is treated as the chat itself, personas are a special case, and state changes happen silently.

Coding agents now make it cheap to build and maintain a replacement, which wasn't true when ST became entrenched.

## Goals

1. **Unlimited-length chats with a fixed context budget.** LCM-style hierarchical summaries keep the original messages and every intermediate summary. The model sees the top-level summaries and can drill down into lower levels or search the originals.
2. **Agentic RP.** Rollouts are separate from the chat timeline, there are configurable orchestration modes, and the same chat representation supports both agentic and non-agentic use.
3. **Compatibility with what users already have.** ST cards, ST chat-completion presets (import and export, giving results similar to ST), lorebooks that work, and bulk import of an ST data folder.
4. **A real web app.** Everything runs on the server, every view has a URL, multiple tabs and devices work at once, generations run concurrently, the app is usable remotely, and it eventually works well on phones.
5. **A UX for directing stories.** Write as any character, have the model write any character (including "yours"), edit without destroying anything, keep versions everywhere, and see every state that affects the next generation before you send.
6. **KV-cache preservation as a near-top priority.** It is second only to security.
7. **Extensible, eventually by itself.** Plugins, and later a harness the agent can configure and extend.

## Non-goals

- Feature parity with ST beyond the compatibility scope in DESIGN.md §1.
- ST extensions or plugins (coding agents can write new ones).
- Text-completion APIs, instruct templates, or chat templating. That is the inference engine's or a proxy's job.
- ST's "connection profiles", or coupling presets to connections.
- Reproducing ST's lorebook activation and placement exactly.

## Principles

- **Nothing is ever lost.** Edits create versions. Drafts and field undo history are persisted on the server. Failed generations stay as visible versions. Bulk edits can be reverted. This means nothing gets lost *by accident*: edits are non-destructive, and you can trust any input box with your life without keeping a notepad on the side. It doesn't mean nothing can be deleted; deleting on purpose is allowed (owner, 2026-10-10).
- **Nothing changes silently.** Anything that affects the next generation is visible before sending: the speaker, who writes the turn, the active preset and its source, active notes, one-turn direction, and cache state.
- **One mechanism, many surfaces.** The same layering applies to cards, presets and lorebooks; the same choice of edit scope everywhere; the same state-on-the-graph model for all chat state.
- **The server is the source of truth.** Clients are views. The agent loop and all generations run on the server.
- **Cache-aware by construction.** Stable prefixes, anything that changes per turn goes at the tail, cache breakpoints are placed deliberately, and cache cost is shown to the user.
- **Imported content is untrusted.** It never executes code and never grants capabilities. HTML is rendered only in a sandbox.

## Stack (summary; reasoning in DESIGN.md §10)

| Layer | Choice | Status |
|---|---|---|
| Language | TypeScript, across server and client | Decided (Rust considered and deferred: no viable ecosystem today, and hot-loading agent-written plugins is much easier in TS) |
| LLM providers | `@earendil-works/pi-ai` 1.x | Decided (owner, 2026-10-10; also used by reference-harness and by DSH) |
| Agent loop | `@earendil-works/pi-agent-core` 1.x, with our own persistence, fork and resume, as in reference-harness | Proposed |
| Storage | SQLite (`node:sqlite` via Effect's driver) with FTS5; Turso evaluated and deferred ([STORAGE.md](STORAGE.md)) | Proposed |
| Plugin kernel | Not Cordis (owner, 2026-10-11). The core is built from its own registries, so plugins can extend, wrap or replace features ([PLUGINS.md](PLUGINS.md)) | Proposed |
| Client | React (Decided); Vite + TanStack Router and the rest of the stack Proposed in [CLIENT-FRAMEWORK.md](CLIENT-FRAMEWORK.md) | Decided |
| Effects, RPC, schemas | Effect 4 on the server and in the client data layer ([EFFECT.md](EFFECT.md)) | Proposed |
| Not built on | DSH as host (alpha, weekly breaking changes, and context assembly is not a plugin point); pi-coding-agent (coding TUI, no web server) | Decided |
