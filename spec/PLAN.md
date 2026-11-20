# Implementation plan

**Status**: Draft, 2026-10-09. The phases are ordered so the owner can **replace ST for daily use as early as possible**, then gain LCM, then agentic features. The data model is designed in full in phase 0, even where the UI comes later. Retrofitting the graph, versions, layers or state events would be far more expensive than building them in from the start.

## State at 2026-11-20 (plancleanup1; checked against ARCHITECTURE.md and the code)

Phases 0 to 6 are built, and so is most of phase 7 except the items listed under it. The phase sections below say what is built and what is not. The product is named **Dreamspan** (DESIGN §12 **[D]**, owner 2026-11-19): the in-repo rename is done; the GitHub repository rename is not. The next milestones are the owner's real data and then the first testers (see "Release readiness" under phase 7). Tonight's queue (2026-11-19) finished every spec unit that had been designed: stories' reply contract M1–M4, workshop subagents SA1–SA9, MCP M0–M6, the files track A and B, the HTML panel reads and the panel exfiltration block, prices, saved video, and schema safety. What tonight's work left unbuilt is listed under the phase it belongs to, and in each spec's status line.

## Standing notes

**Small follow-ups:**
- The Status page showed an event-loop p99 of 74 ms with the app idle (2026-10-14), at a host load average of 20–90, and the 10 ms timer can't tell CPU starvation from blocking. Measure again on a quiet host before looking for a cause in the app.
- The reader's first `PlanSummaries` on a 100,000-message chat takes about 1.5 s (in a reader worker; the writer is bounded). Perf fixtures still run with LCM off.
- `lcmReviewScale` (condensation enqueue scaling) times out in full runs under heavy host load and passes alone.
- `historyPerf`'s 100,000-message test no longer nears its 60 s (historyperf1, 2026-11-19): its fixture's bare connection lacked `temp_store = MEMORY`, so every trigger-firing insert spilled its statement journal to a temporary file; 72 s alone at load 42, now 22 s at load 35–50. Each assembly there now reads about 7,800 of the 100-character messages, since the default context became 128,000 tokens (2026-11-12): about 500 ms at load 40, against 200 ms at 4,095 tokens.
- The LCM rebase combined the summary cursor with the stepped history start (LCM on: the cursor governs; off: the stepped cut). It passed check, browser and the ST gate, but no reviewer has looked at that seam yet.
- Lorebook keys follow ST for now (`use_regex` ignored; owner, 2026-10-12). Revisit later; low priority.
- ST's global and persona-bound lorebooks have no representation yet, so the assembler doesn't use them (ARCHITECTURE §15).
- WebKit needs `libgtk-4`, `libgstcodecparsers` and `libavif` to launch. Firefox times out on one reload in `chatSetup.spec.ts` 2 runs in 10.
- `library.spec.ts:98` (export "canceled") still fails in some reviewers' environments. It's quarantined only when a plain download also fails.
- Migration 0014's recursive backfill may be quadratic on a long purged subtree. Not measured. Migrations get squashed before release anyway.
- The lorebook entry cap is 10,000. It can be raised if a real lorebook needs more.

**Decisions waiting on the owner:** none for phases 2–4.
- Not needed yet, only when plugins are built (phase 6): PLUGINS.md §10
  - applying plugin updates
  - declared surfaces
  - the sandboxed plugin type
  - how far client overrides go
  - git binary or library

**Built on proposals.** The code follows these, and they stay marked [P] until the owner says otherwise. Nothing is needed unless the owner disagrees:
- the workflow (WORKFLOW.md §2–4), which is how work is done now
- the cross-site guard and `PUBLIC_ORIGINS` (DESIGN §11)
- how "a password on every user" is read (DESIGN §11)
- the env bootstrap for headless servers (DESIGN §10.1)
- in proxy mode with `TRUSTED_PROXIES`, the Docker health check needs `127.0.0.1` on that list (ARCHITECTURE.md §7)
- snapshots record an assembler semantics version, and rebuilding an older one returns the stored snapshot with a typed result (ARCHITECTURE §15)
- a chat note edited from the chat changes only that branch, from the message shown on (DESIGN §3.4's default edit scope)
- in our layouts, lorebook entries go in one block at the tail with a reserved allowance of at most 25% of the budget, sized from what could activate (ARCHITECTURE §15)
- a browser copy goes only once the server acknowledged it, with no automatic expiry; the user can delete one explicitly from Browser recovery (ARCHITECTURE §3.10, §14.6)
- every nonempty endpoint path segment and query value counts as a secret in captures, since routes have no sensitivity annotations (ARCHITECTURE §15)

**Rules that shape phase 1–2 code** (PLUGINS.md §8):
- Features register through registries with ids, never wired in directly: assembler stages, macros, importers, display rules, tools; on the client, slots.
- Chat state keys get a namespace scheme before the first extension needs one.
- Library documents keep `extensions.<plugin-id>`.
- The client's CSP allows `connect-src` to our origin only.
- Settings are configurable from inside the app (by the agent too), except security settings.

**Housekeeping before the first release:**
- ~~Squash migrations.~~ Done: the baseline was squashed and then frozen by `0002_files`; changes since are numbered migrations (`0002` to `0009`; ARCHITECTURE §3.7), recorded in release 0 (provisional).
- Drop the tests' `--no-wasm-code-gc` once Node 24 ships the V8 fix (nodejs/node#66366).

## Phase 0: Foundations
**Status (2026-10-30): built.** Foundations, schema and invariants, typed RPC and subscriptions, optimistic writes, isolated database workers, users with login and proxy auth, the provider layer and settings, user cost formulas, ledger rollups, host-bound keys and exposure password handling (ARCHITECTURE). Cache controls are provider-specific; card variants and overrides were superseded by independent forks.

**Progress (2026-10-10):** the scaffold is done (ARCHITECTURE.md): repo, tooling, CI, Docker image, server skeleton with typed RPC over a WebSocket, the database worker architecture, and proxy/single-user auth. Client framework decided (React), server framework implemented on Effect's HTTP server. The full schema with database-enforced invariants, the message-graph operations and the library operations (variants, chat overrides, three-way merge on re-import) drafts with server-side undo history, and the recycle bin followed. The provider layer followed (ARCHITECTURE.md §6): encrypted connection secrets, the outbound proxy with bypass list and per-connection routes, model lists merged with pi-ai's catalog, streaming with typed errors and retries before the first token, the usage ledger with normalized counts and cost, explicit Anthropic breakpoints, and the client RPCs. The Cordis evaluation is written ([CORDIS.md](CORDIS.md)). Then (2026-10-11) the review fixes, host-bound credentials and the provider registry.

- ~~Repo, tooling, CI, Docker image. Node LTS, TypeScript ESM.~~ Done.
- Settle the open stack questions: ~~client framework~~ (React), ~~server framework~~ (Effect HTTP), ~~a time-boxed Cordis evaluation~~ (not adopted).
- **Data model and schema** (drafted in [DATA-MODEL.md](DATA-MODEL.md); DESIGN §3, §4, §6.2): message graph (slots with parents, threads, path selection), versions with provenance and status, state events, layered entities (base, variant, override, revisions), notes, connections and models, rollouts, summaries over path segments, changesets, drafts with undo history.
- Server skeleton: typed operations (every UI action is an operation), WebSocket subscriptions, per-entity optimistic concurrency, single-writer SQLite queue (as in reference-harness).
- Users and auth: separate users with per-user ownership in every query; a trusted reverse-proxy header (Authelia `Remote-User`) mapped to a user, plus built-in login.
- ~~Provider layer~~: built (ARCHITECTURE.md §6, [PROVIDERS.md](PROVIDERS.md)). The settings UI, user cost formulas, per-API cache handling and ledger rollups followed (PROVIDERS.md status line).
- ~~Exposure safety~~ (DESIGN §11): built, except the password branch, which comes with built-in login.

## Phase 1: Import and compatibility core
**Status (2026-10-30): built.** Card formats and export, preset import (model settings imported separately and explicitly), macros, lorebook import, the full ST folder mapping with its report, and the stock-ST differential harness (`npm run test:st`). Folder import doesn't import keys or connection settings.

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
**Status (2026-10-30): built, awaiting the owner's daily-use trial (the exit criterion).** Everything listed below is built, except where owner decisions overtook it: the Members/Personas/All cards speaker panel became the cast speaker with a separate persona choice, and the preset scope chain and overlays became global model/preset selection with three-way re-import. Built since: inserting messages anywhere (spec/MESSAGE-INSERT.md units 1 to 9, 2026-10-30) and the composition scratchpad ("Write your own version", ARCHITECTURE §12). General library-text search, with replace, was built 2026-11-12 (ARCHITECTURE §14.6 "Across the library").

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
**Status (2026-10-30): built.** Summary storage and lineage, planning and worker execution, direct and tool output, refusal handling, condensation, stale repair, editable revisions, the boundary, rail and request views, and explicit enable/adopt/approved backfill with estimates. Built since: per-summary details (model, times, attempts, tokens, cost, request link), summaries kept per view for separate contexts, and workshop transcript summaries. Open: a dedicated summarizer model.

- Port the reference-harness §9b design: tiers, eager thresholds, worker pool, condensation, lineage, failure placeholders. Summaries over path segments.
- Summarization with the preset loaded and a summarization tail prompt. Idle-time jobs while the cache is warm.
- Stale handling on edits. Editable summaries with versions.
- UI: boundary divider, coverage rail, summaries in the context view.
- Backfill for imported chats (lazy, with a cost estimate).

## Phase 4: Agentic rollouts
**Status (2026-11-20): built.** AGENTIC.md units U1 to U10 and the resume requirement (its §12) are built (ARCHITECTURE §16 "Agent rollouts", "Decision models"). Not built, by decision (AGENTIC §10 "Left for later"): the per-character orchestration mode with presence-cut summaries, per-agent private state, and automatic mid-stream resampling of a broken turn. The orchestration mode registry has the one `default` planner; card swap is a card layout setting.

- Timeline/rollout separation: fork per turn, a commit pipeline for both output contracts.
- pi-agent-core with reference-harness-style persistence: context snapshot, flushed transcript, invisible mid-rollout resume, editing a step and then resuming.
- RP tools: `expand_summary`, summary and chat search, lorebook lookup, notes, presence. Tool effect classes; chat-state effects attached to versions.
- Live display of steps (expanded, then collapsed, with a sticky preference), the inline "N steps" element, the run inspector, and the activity panel.
- Optional decision models (Jev) for lorebook inclusion and presence.
- Orchestration modes: single narrator with all cards, and card-swap. The per-character agent mode is optional in this phase.

## Phase 5: Layered entities and editing at scale
**Status (2026-11-20): built, in the form the owner decided.** Card variants and chat-local overrides were replaced by independent forks, swaps and notes that replace prompts (DESIGN §4; ARCHITECTURE §3.8, §3.9, §12, §15). Changesets (search and replace across chats and summaries, revert, diff view) and the composition scratchpad are built (ARCHITECTURE §3.13, §12, §14.6). Open: the changes below that name variants and promotion describe the superseded design.
- Card variants, chat-local overrides, promotion, edit-scope UI, the library grouped by variant, diffs. Card modules with private/exportable flags.
- Changesets: search and replace across chats and summaries, revert, diff view.
- Composition scratchpad.

## Phase 6: Workshop and meta tools
**Status (2026-11-20): built.** WORKSHOP.md units W1 to W9 and P1 to P5 are built (ARCHITECTURE §16 "Workshop chats" and following, §17), with subagents SA1 to SA9 (SUBAGENTS.md), MCP servers M0 to M6 (MCP.md), files and commands in a sandbox, attachments of any type, the file manager with viewers, the editor and sharing (FILES-AND-ENVIRONMENT.md tracks A and B), workshop branches and story-position reads. Not built: a GitHub-repository plugin registry and remote plugin installation (PLUGINS.md), a real sandbox for plugin code before a non-admin can enable one, and the desktop-platform sandboxes (FILES-AND-ENVIRONMENT.md track D, which waits for a desktop package, DESKTOP.md).
- Workshop chat kind, with its template, permissions and capability strip.
- Meta tools: create, edit and clone cards; settings; chat setup. Agentic chat editing through changesets.
- The out-of-character side channel docked in RP chats.
- Plugin system ([PLUGINS.md](PLUGINS.md)): registries the core itself uses, overrides, plugins as git repositories, a GitHub-repo registry, consent prompts for enabling and applying. Plugins written by the agent itself.

## Phase 7: Advanced RP and release readiness
**Status (2026-11-20): mostly built.** Built: parallel threads, sending to several threads and merges (THREADS.md TH1 to TH8, CHAT-MERGE.md, including separate timelines), separate contexts per character with presence and away (CHARACTER-CONTEXT.md C1 to C9), HTML rendering in sandboxed frames with scripts, the bridge, external media consent, saved video, the Tavern Helper reads for approved panels and the block on ways out of a panel (HTML-MESSAGES.md steps 1 to 6, SAVED-MEDIA.md), internal side-by-side panels (the workbench). Not built: per-character agents (AGENTIC.md §10), message variables for panels (they wait for the ST importer to read Tavern Helper's per-swipe variables), template-bound UI (model-driven widgets, DESIGN §10.2 **[L]**), web push (not found in ARCHITECTURE or the code), a desktop package (DESKTOP.md, nothing built), and a public release: docs, installation as a single binary, the security review.

**Release readiness (two milestones: the owner's real data, then the first testers).** Built tonight (2026-11-19): the rename to Dreamspan with its stored identifiers (database file, cookie, key-derivation label pinned by a test, browser storage names, extension name, plugin API scope); the released-schema snapshot (`release-0`, still provisional) and the guard against editing a released migration (`npm run schema:record`, `scripts/check-released-migrations.ts`, a gate line); a reference check at every start that never bricks the server, refusal messages that never say to empty the data folder, and the admin "Database check" row; the table-rebuild helper with foreign keys off and owner-scale tests (ARCHITECTURE §3.7). Not built: an online backup inside the app and an automatic backup before pending migrations; an upgrade test that migrates a database built by the previous release's code; per-kind migrations for stored documents and settings; accounts for testers (admin account deletion, a temporary password, per-account storage view, a problems page); a separate tester instance; blocking private addresses for non-admin connections; a security review; versions, changelog and a rollback runbook; a tester guide. Release 0 stays provisional until the owner starts keeping data (`npm run schema:record -- --final`).
- Parallel threads, sending to several threads, merges.
- Per-character agents with presence-limited views and private state.
- HTML rendering in a sandbox, rich and compact forms, then template-bound UI.
- Mobile polish, web push, internal side-by-side panels.
- Public release: docs, installation (Docker, possibly a single binary), built-in auth hardening, a security review.

## Open questions
1. "Start over" with a card: a new peer chat (proposed) or a new root in the same chat? (DESIGN §2.1)
2. ~~Sending into a chat that's still generating: queue or cancel?~~ **Resolved: queue** (owner, 2026-10-12; DESIGN §2.2).
3. How merged threads become one sequence (§3.3). Deferred: not needed until threads are built.
4. Note identity for "apply to all branches" edits (§3.4).
5. ~~Client framework~~ **Resolved: React** (owner, 2026-10-10; [CLIENT-FRAMEWORK.md](CLIENT-FRAMEWORK.md)). Server HTTP framework: deferred by the owner (2026-10-10); [EFFECT.md](EFFECT.md) proposes Effect's own HTTP server.
6. ~~Cordis as the plugin kernel~~: not adopted (owner, 2026-10-11). Plugin structure and threat model proposed in [PLUGINS.md](PLUGINS.md), with its own open questions.
7. Whether intermediate output blocks are real messages (shelved, §7.2).
8. ~~The project's name.~~ **Resolved: Dreamspan** (owner, 2026-11-19; DESIGN §12).
