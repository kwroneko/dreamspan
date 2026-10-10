# Implementation plan

**Status**: Draft, 2026-10-09. The phases are ordered so the owner can **replace ST for daily use as early as possible**, then gain LCM, then agentic features. The data model is designed in full in phase 0, even where the UI comes later. Retrofitting the graph, versions, layers or state events would be far more expensive than building them in from the start.

## Phase 0: Foundations
- Repo, tooling, CI, Docker image. Node LTS, TypeScript ESM.
- Settle the open stack questions: client framework, server framework, a time-boxed Cordis evaluation.
- **Data model and schema** (drafted in [DATA-MODEL.md](DATA-MODEL.md); DESIGN §3, §4, §6.2): message graph (slots with parents, threads, path selection), versions with provenance and status, state events, layered entities (base, variant, override, revisions), notes, connections and models, rollouts, summaries over path segments, changesets, drafts with undo history.
- Server skeleton: typed operations (every UI action is an operation), WebSocket subscriptions, per-entity optimistic concurrency, single-writer SQLite queue (as in reference-harness).
- Users and auth: separate users with per-user ownership in every query; a trusted reverse-proxy header (Authelia `Remote-User`) mapped to a user, plus built-in login.
- Provider layer: pi-ai 1.x, connections with overridable base URLs, model-list fetching, user-defined models with capability fields, write-only keys.

## Phase 1: Import and compatibility core
- Card parsing and export: V1, V2 and V3 as JSON, PNG and CHARX (reference-harness already uses `character-card-utils` and the PNG chunk libraries).
- Preset import: chat-completion presets, the prompt manager model, markers, injections, regex, sampler mapping, plus the import report.
- Macro engine with expansion based on where text came from.
- Lorebook import (activation and placement come in phase 2).
- ST data folder importer:
  - chats, group chats, branch files rebuilt into one graph, swipes as versions
  - personas as cards in the persona folder
  - lorebooks, presets
  - greeting-only chats skipped
  - an import report
- **Differential test harness**: stock ST in a container plus a mock endpoint that records requests, and synthetic fixtures. This is the fidelity gate for the assembler.

## Phase 2: Non-agentic chat that can replace ST (first milestone)
- The context assembler in ST-compatible mode, passing the differential tests. Card layout modes. Role projection strategies. Cache breakpoints.
- Chat UI:
  - chat list, library, lazy chat creation
  - URL routing, multiple tabs
  - streaming
- Versions:
  - swipe anywhere, in place
  - edit creates a new version, "write your own version"
  - stop on the version
  - failed generations as versions
  - version picker
  - branches
- Composer: always-visible speaker, the switcher panel (Members / Personas / All cards), Send as / Generate, one-turn direction.
- Notes, minimal version: chat notes and per-character notes with placement and per-chat activation, as state events.
- Basic lorebook activation (keywords, cache-friendly placement).
- Presets: scope chain, overlay layer with three-way merge on re-import, search and replace in the editors.
- Concurrency: several chats generating at once, staggered parallel swipes, notifications (badges, title, favicon).
- Request inspector (context view) and cache-warmth indicator.
- Server-persisted drafts and field undo history.
- **Exit criterion:** the owner moves their daily RP from ST to this.

## Phase 3: LCM
- Port the reference-harness §9b design: tiers, eager thresholds, worker pool, condensation, lineage, failure placeholders. Summaries over path segments.
- Summarization with the preset loaded and a summarization tail prompt. Idle-time jobs while the cache is warm.
- Stale handling on edits. Editable summaries with versions.
- UI: boundary divider, coverage rail, summaries in the context view.
- Backfill for imported chats (lazy, with a cost estimate).

## Phase 4: Agentic rollouts
- Timeline/rollout separation: fork per turn, a commit pipeline for both output contracts.
- pi-agent-core with reference-harness-style persistence: context snapshot, flushed transcript, invisible mid-rollout resume, editing a step and then resuming.
- RP tools: `expand_summary`, summary and chat search, lorebook lookup, notes, presence. Tool effect classes; chat-state effects attached to versions.
- Live display of steps (expanded, then collapsed, with a sticky preference), the inline "N steps" element, the run inspector, and the activity panel.
- Optional decision models (Jev) for lorebook inclusion and presence.
- Orchestration modes: single narrator with all cards, and card-swap. The per-character agent mode is optional in this phase.

## Phase 5: Layered entities and editing at scale
- Card variants, chat-local overrides, promotion, edit-scope UI, the library grouped by variant, diffs. Card modules with private/exportable flags.
- Changesets: search and replace across chats and summaries, revert, diff view.
- Composition scratchpad.

## Phase 6: Workshop and meta tools
- Workshop chat kind, with its template, permissions and capability strip.
- Meta tools: create, edit and clone cards; settings; chat setup. Agentic chat editing through changesets.
- The out-of-character side channel docked in RP chats.
- Plugin system (on Cordis if the evaluation goes well). Plugins written by the agent itself.

## Phase 7: Advanced RP and release readiness
- Parallel threads, sending to several threads, merges.
- Per-character agents with presence-limited views and private state.
- HTML rendering in a sandbox, rich and compact forms, then template-bound UI.
- Mobile polish, web push, internal side-by-side panels.
- Public release: docs, installation (Docker, possibly a single binary), built-in auth hardening, a security review.

## Open questions
1. "Start over" with a card: a new peer chat (proposed) or a new root in the same chat? (DESIGN §2.1)
2. Sending into a chat that's still generating: queue or cancel? (§2.2)
3. How merged threads become one sequence (§3.3). Deferred: not needed until threads are built.
4. Note identity for "apply to all branches" edits (§3.4).
5. ~~Client framework~~ **Resolved: React** (owner, 2026-10-10; [CLIENT-FRAMEWORK.md](CLIENT-FRAMEWORK.md)). Server HTTP framework: deferred by the owner (2026-10-10); [EFFECT.md](EFFECT.md) proposes Effect's own HTTP server.
6. Cordis as the plugin kernel: evaluate standalone maturity (§10.4).
7. Whether intermediate output blocks are real messages (shelved, §7.2).
8. The project's name.
