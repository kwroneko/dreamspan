# Workshop, setup tools and plugins (Phase 6)

**Status**: Proposed, 2026-11-12 (job `phase6`). The design for PLAN Phase 6 and DESIGN §7.7, with the Phase 6 parts of §7.3 and §10.3, and the plugin loader as a delta to [PLUGINS.md](PLUGINS.md). Everything below is **[P]** unless it cites a **[D]** in DESIGN or PLUGINS. It is a delta from two things: the build at master `21c7fb3d` (ARCHITECTURE §2, §3.7, §3.13, §5, §16 "Agent rollouts"), and reference-harness on branch `latest` (`9b385944`, 2026-10-29): its tool set (`src/tools/`), effect classes (`tools/side-effects.ts`), workspace files and skills (its ARCHITECTURE §9a), sandbox (§11a) and MCP adapter (`src/mcp/tool-adapter.ts`). Build units are in §9; their sections become obsolete as they move to ARCHITECTURE.

**Built sidewrite1 (2026-11-13):** §3.4, §3.5, §3.6 and §4’s story targeting now use the side tab’s validated request position for writes as well as reads. This subset is obsolete as an implementation proposal; see ARCHITECTURE §16, “Side-chat write positions”. Positioned approvals refuse a moved answering tab. Standalone workshops keep current-branch behavior; no Proposed item is promoted to Decided. No baseline change.


**Built W1 (workshop1, 2026-11-12):** The server-only subset of §2.1–§2.2, §1.1's workshop rollout/purpose/Activity changes, §3.3's four library read tools and §8's `workshop.defaults` / `CreateWorkshop` are implemented and obsolete as implementation proposals; see ARCHITECTURE §16, “Workshop chats, server”. The remaining proposals retain their status. W1 deliberately uses contract `both` and fresh per-turn assembly; §2.3–§2.4 remain for W5.

**Built W3 (workshop3, 2026-11-12):** §3.1's effect classes and capability metadata; §3.3's `create_card`, library `edit_card`, `clone_card` and `start_chat`; §3.4's non-read restart rule and persistence of changes across reply versions; §3.6's server effects/undo/read operations and §8's `rollout_effects` are implemented and obsolete as implementation proposals. See ARCHITECTURE §16, “Workshop setup tools and undo”. Approval/grant policy, regenerate warnings and the Changes panel remain W4 proposals; several messages/continuity remain W5. §3.7 is exercised with W1's one final message. The provisional reversible-effects default follows §10 question 1's recommendation through one registered policy constant; that question remains Open. **BASELINE CHANGED.**

**Built deltas from code:** The existing agent instruction is appended inside `end-of-request`, not a separate `agent-instructions` stage; no `agentTurn` preset override exists. W1 adds a separate registered `workshop-instructions` stage after it and implements `workshopTurn` there without changing RP assembly. The loop previously had no external-effect check in `beforeToolCall`; W1 adds that check as well as the profile-based filters. `StartChat` always appends the first user/model turn, so `CreateWorkshop` instead shares graph helpers and the library's revision steps in `db/workshopWrites.ts`, creating only the greeting in one transaction. Existing owner-scoped `ListLibrary` / `OpenEditor` readers suffice for the read tools; no new reader operations were added. Workshop support also needs the generation-only resume/recovery, reply-metrics and model-use filters broadened. No baseline change.

**Built W2 (workshop2, 2026-11-12):** The client half of §2.1 (`ChatKindLook`), §2.2's "Where" and §2.5's accent, badge and capability chip (read-only rows) are implemented and obsolete as implementation proposals; see ARCHITECTURE §16, “Workshop chats, client”. The Changes tab (§2.5's last row, §3.6) and the chip's Off / Ask first / Allowed choices remain for W4.

**Built W5 (workshop5, 2026-11-12):** §2.3–§2.4, `output.contract = several` and `PostRolloutMessage` in §8, and W5's inspector lines are implemented and obsolete as implementation proposals. See ARCHITECTURE §16, “Workshop messages and continuity”. The brief authorizes §10 question 4's recommended initial policy behind `WORKSHOP_OVERFLOW_STEP_SUMMARIES`; the question and future workshop summaries retain their Proposed/Open status. W3 owns `rollout_effects`; the combined W3/W5 implementation keeps these records canonical on their originating run and copies only retained receipts. No baseline change relative to W3.

**Built W3/W5 integration (merge-workshop35, 2026-11-12):** The combined §2.3–§2.4/§3.4/§3.6 subset is implemented and obsolete as an implementation proposal; see ARCHITECTURE §16, “W3/W5 integration”. Regeneration and step editing keep all independent library/setup changes before and after the selected message, matching §3.4's keep-changes rule; receipts travel, canonical undo records do not duplicate. Continuity falls back with a reason after an effect in the carried chain is undone or its saved target changes. Registered effect policies supply read-only state proofs. Existing per-rollout resource limits apply independently to each new carried turn; historical calls never exempt new arguments from validation. The approval/warning UI remains W4. No proposal is promoted, and no baseline changes relative to W3.

**W2 built deltas from code:** The look registry is `chatKindLooks` in `features/chat/kindLooks.ts`, not `features/workshop/kinds.ts`, because the chat feature reads it; the workshop registers its look from `features/workshop/kinds.ts`. The look gains `shows` (ids of controls only some kinds offer, the capability chip), so the chip needs no kind check, and its `accent` names a token from which `<token>-contrast` is also read; the root gets `data-chat-accent` and `--chat-accent` beside `data-chat-kind`, and one `[data-chat-accent]` rule sets `--accent`, `--accent-contrast`, `--focus` and their Tailwind `--color-*` variables (the theme's variables resolve at `:root`, so setting `--accent` alone changes nothing). The side panel is portalled outside the chat root, so it applies the same attributes. `ChatBadges` is used by the chat header only; the Chats page's rows (`ChatList.tsx`) and the left panel's rows (`ForkRow`) render the badge themselves, after the name. `hides` also covers side-panel tabs and This chat's sections: the workshop hides This chat's Tools, Model may change, Cards and Who replies (the Tools list is the story planner's and would override the workshop's tools through `agent.tools`). Summaries (tab, switch, the header's "Enable summaries" line) and the merge menu entries follow the shared profile's `allowsSummaries` and `allowsMerge`, not the look. The capabilities are a client registry (`workshopCapabilities`) with `library.read` only, since no other capability's tools exist yet; W3 and W4 add theirs. The chip reads "Can: 1" until then.

**Built W4 (workshop4, 2026-11-12):** §3.4's per-workshop Off / Ask first / Allowed with approvals (Allow, Allow in this workshop, Decline), §3.6's step Undo and Open, the Changes tab and the regenerate warning, and §2.5's chip choices are implemented and obsolete as implementation proposals; see ARCHITECTURE §16, “Workshop approvals and undo”. §10 question 1 (the defaults) stays Open: the recommendation is one registered table, `capabilityDefaults`. **BASELINE CHANGED.**

**W4 built deltas from code:** Grants are a baseline table, `workshop_grants` (chat, capability, `target`, mode, `expires_at`), not the branch-owned `workshop.grants` state key through `ChangeCast`: permission belongs to the workshop, so a swipe or fork doesn't revert it, and outside chat state no tool-reachable operation can write it. `target` and `expires_at` are there for per-plugin and session trust (W6–W8, P3). Approvals are durable (`tool_approvals`, bound to the call's rollout, id and arguments' digest) because a waiting run can't survive a restart in memory: it is parked and carried on by the existing Resume, and the row says whether the call may already have run (then it asks again with a warning, even when allowed). The wait is in the tool's execute path, not `beforeToolCall`, so calls carried over by Resume ask too. Plain Resume of a stopped reply doesn't show the regenerate warning (its kept calls keep their receipts); Regenerate, a swipe past the last version and carrying on from a step do. The Changes tab was a plain newest-first list without per-turn grouping or "Undo all of this turn" (grouped by reply since workfix1 below). Capabilities without tools yet (chat reads and rewrites, settings, generation, network, plugins) are registered with their defaults but don't show until a tool offers them. Merged with W3/W5 (based on a81ec64d): regenerating one message of a several-message run keeps that message's own changes, so the warning lists only later messages' changes; a change to the workshop instructions (Off, Use the default) rebuilds a carried request instead of carrying it.

**Built W6 (workshop6, 2026-11-12):** §3.2's operations registry/factory, coverage classifications, first exposures, settings registry `agent` opt-in and settings tools, and §3.3's `generate_reply` are implemented and obsolete as implementation proposals. See ARCHITECTURE §16, “Workshop operations as tools”. The factory uses the existing handler and command workflows; the writer records each supported operation with its receipt and undo atomically. The first generic settings opt-ins are display preferences and collapsing pins; generation defaults retain their ownership-checked operation. A variant copy leaves drafts in place. AgentTools refused an implicit prior selection because it had no exact undo event (fixed by workfix1 below); a revision restore that would alter permissions/approvals is also refused with its reason. These are deliberate refusals under the undo/permission rules, not silent changes. The expanded definitions can exceed an inherited 4k context budget; the existing overflow fallback applies. A new production default is left for the owner (the unit’s continuity fixtures explicitly select 32k). No proposal is promoted to Decided. No baseline change.

**Built workfix1, undo (2026-11-12):** Two owner decisions (2026-11-12, **[D]**): the assistant can clear a chat's tool selection back to the app default as an ordinary change with Undo; and the Changes tab groups changes by the reply that made them, each reply with "Undo all of this reply", single-change Undo kept. Details are **[P]**: `agent.tools { tools: null }` means "follow the app default" (the event's `tools` is nullable; no new key), so Undo of any tool-selection change writes the exact prior value, null included; ChangeCast's `AgentTools` and `change_chat`'s `AgentTools` take `tools: null`. A reply is its run (`rollout_id`, where its changes are recorded; a resumed run's new calls are a new reply). `UndoRolloutEffects { chatId, rolloutId }` undoes that run's standing changes newest first in one writer transaction, each in its own savepoint, and stops at the first it can't undo (review-workshop4's recommendation): it reports what it undid, the refused change and its reason, and the older ones it left untried. Undo all shows while any change of the reply can still be undone. See ARCHITECTURE §16, “Workshop approvals and undo” and “Workshop operations as tools”. No baseline change.

**Built W7 (workshop7, 2026-11-12):** §3.3's `edit_preset` and `edit_lorebook`, and W7's preset/lorebook creation, archive and restore subset of §3.2–§3.4/§3.6 are implemented and obsolete as implementation proposals; see ARCHITECTURE §16, “Workshop presets and lorebooks”. Creation/archive/restore extend the existing W6 exposures; no duplicate tools or permission boundary. The terse edit shapes also offer typed add/remove, entry/prompt field sets and document-owned settings to cover the complete editors. Executable changes stay off/unapproved and the server's approval diff says so. Explicit user Undo restores the guarded previous document exactly without changing drafts. Assistant revision restores use saved edits, since the user's History restore also settles live drafts. The existing Changed meanwhile picker protects open drafts; no new editor UI. No proposal is promoted to Decided. No baseline change.

**Built W9 (workshop9, 2026-11-12):** §4's "In Phase 6" paragraph is implemented and obsolete as an implementation proposal; see ARCHITECTURE §16, “Workshop side chat”. §4's Later items stay proposals. **BASELINE CHANGED** (one index).

**W9 built deltas from code:** The attachment list is read through a new partial index on `state_events` (`state_events_workshop_attached`), not by scanning; `IdField` gains a `chat` table so the event's `chat` is checked as an owned chat. `CreateWorkshop { attachTo }` accepts only a kind whose shared profile has the new `allowsSideChat` (`rp`), and titles the workshop `About <story>`. "`chats.read` is Allowed for the attached chat" is a `workshop_grants` row written when the workshop is made, not a different default: `capabilityDefaults` stays one table (§10 question 1 stays Open), and "Use the default" returns the workshop to Ask first. The RP read tools aren't offered under their own names: four wrappers, `search_story`, `read_story`, `open_story_summary` and `search_story_summaries`, run them against the story, so the story planner's frozen definitions and its tool list are unchanged (`RolloutTool.replyTool: false`). "The story's current fork and shown leaf" is the story's `currentForkId` (the branch last written in or made) and that fork's tip at each call; a branch only viewed in a browser tab isn't followed (§4's Later item, the panel following the story's branch switches live). The tab body uses a new `PanelDescriptor.fill`, the shared message list with `embedded`, `ChatSurfaceProviders`' new `except`, and `chatPlace.ts`'s `side.` URL scope for the side chat's branch, message dialogs and step edits. "Talk about this chat" opens the newest workshop beside the chat, creating one only when there is none; the tab also offers Start a workshop and New workshop. The Workshop start card's "No other place creates a workshop" (W2) no longer holds: a side chat is created from its story.

**Built W8 (workshop8, 2026-11-12):** §3.5, §3.3's `read_chat` / `search_chats` and §8's `StartEditRollout` / `ApplyAgentChangeset` are implemented and obsolete as implementation proposals. See ARCHITECTURE §16, “Workshop chat rewrites”. Rewrites retain the existing changeset and fork model, adding completed target-chat edit rollouts and workshop-message provenance without provider requests. Reads and writes use separate registered capabilities and transaction-time consent checks. Instruction changes cover existing chat notes and preset/lorebook bindings. New notes, card overrides, alternate target branches and rewriting as a new chat remain outside W8. The limits and paging follow the brief's bounded-call/run requirement; default capability choices remain the registered W4 recommendation, not a newly Decided item. No baseline change.

**Built workfix1, story position (2026-11-12):** Two owner decisions replace W9's "the branch last written in": the side chat reads the branch shown in the tab it's used from ("Why wouldn't it be whatever pane/tab is selected? Last wrote in would be completely unexpected."), and which branch that is must be unambiguous ("It should be unambiguous what branch the user opened this with."). **[D]** for those two; how it's done is **[P]**: each request that starts a side-chat reply (Send, Generate, Regenerate, Continue, Resume, carrying on from a step) carries `storyAt { chatId, forkId, leafSlotId }`, the story's branch and newest shown message in that browser tab at the moment of the request, and the story tools read there and never past it (review-workfix1 below additionally requires retained Resume transcripts to match their original position and unchanged story); the panel shows "Reads “<branch>”, up to message N" above the side chat. A request without it (the workshop in its own tab) doesn't read the story and the tool says so; a position in another chat, a deleted branch or a message not in the story is refused. A queued message keeps the position it was sent with. The owner's third question ("How do we know it doesn't just continue in-character? We need to figure out exactly how the context is built for this.") is answered in ARCHITECTURE §16 "What a side chat sends", a worked request from a test: the workshop's own preset and Assistant card, none of the story's preset, cards, persona or lorebooks (a workshop made beside a story no longer joins the account persona, which was a story character's card in its context), and story text only inside `<story_excerpt>` tool results that say they are quoted for discussion. Whether a live model stays out of character with that context is not tested.

The owner's stated end goal (phase6 brief, 2026-11-12): the app becomes a self-customizable agentic harness, where the in-app agent rewrites the harness through plugins and every feature is a registered, replaceable part. The chain this spec designs is: workshop chats (§2), setup tools (§3), the out-of-character side chat (§4), the plugin loader (§5), the agent writing plugins (§6).

**Built review-workfix1 (2026-11-13):** The §4 read-boundary and §3.6 ordering hardening are implemented and obsolete as proposals: loaded-window limits, strict fork membership, escaped excerpts, encoded-size paging, invalidation of carried story reads after position/content changes, fresh Regenerate at the current position, and refusal of Resume at a changed position/story. Receipt times strictly increase per run so bulk Undo follows call order; exact recorded restoration snapshots let Undo follow earlier setting changes while preserving stale-write checks. ARCHITECTURE §16 records the implementation and conservative cache invalidation; no Open/Proposed policy is promoted to Decided.

## 0. Summary

- **A workshop is a chat of kind `workshop`**, chosen when it's made and fixed for life (§7.7 [P]; the stored value exists today and nothing reads it). It runs on the built agent machinery unchanged: one rollout per turn, the registered `agent` strategy, frozen snapshots and transcripts, receipts, Resume, the steps element and the run inspector (ARCHITECTURE §16). What differs is chosen by a registered **chat kind profile**: the planner, the output contract, the continuity, the toolset and the look.
- **It looks different** (§7.7 [D]: a clear distinction, hard to slip into by accident): its own accent colour on the whole chat, a "Workshop" badge wherever the chat is named, and a capability chip in the composer's strip saying what the assistant may do. It ships with a **Workshop** preset and an **Assistant** card ([D]), ordinary library items the user can edit or swap.
- **Several messages a turn**: `send_message` posts a message and the run goes on; a turn ends with a plain-text answer. Each message is its own slot, all from one rollout (§2.3).
- **It carries on its previous run** (`rollout.continuity = resume_previous`, [D]): the next turn's request is the last turn's request plus its whole transcript plus the new message, so the assistant remembers every tool result and the provider cache holds (§2.4). The timeline stays separate ([D]).
- **Setup tools** come from two sources: a few hand-written ones where the operation needs shaping for a model (editing a card's fields, rewriting a chat), and a **generic exposure** that turns registered operations (the server's typed RPCs and `Commands`) into tools through a registry, each with an effect class, a capability and an undo recipe (§3.2). A coverage test makes every RPC either exposed or excluded with a reason, so "eventually every app action is a tool" (§7.7 [P]) is tracked, not hoped for.
- **Effects are recorded and undoable**: every non-read tool call writes a receipt (built) and `rollout_effects` rows with an undo recipe, listed in a **Changes** panel and on the step itself. Regenerating a reply that made such changes warns first (§7.3 [P]).
- **Permissions are per capability, per workshop**: Off, Ask first or Allowed, set from the strip or from an approval ("Allow in this workshop"). Outside effects (sending to a provider for another chat, the network, turning plugins on) ask first; reversible library and chat changes are allowed by default (open question 1). The agent can never change its own permissions.
- **The out-of-character side chat** is a workshop attached to a story chat, docked as a panel, reading the story through the RP read tools; the rest is Later (§4).
- **Plugins** are git repositories under `DATA_DIR/plugins/`, enabled at a pinned commit ([D]), checked and bundled at enable and at startup, and switched off with a report when they break. Server code loads in the main thread by `import()` of a bundle and in the database workers through the built `StateModules`/`AssemblyModules` module lists; client code loads as same-origin ES modules against one host module, before the router is built (§5).
- **The agent writes plugins** with file, check, commit, enable and roll-back tools. The user approves only enabling (and, unless allowed for the session, each new commit), and can recover without the agent from Settings → Plugins or a plugin-free start (§6).

## 1. Deltas from the build and from reference-harness

### 1.1 What the build already has

| Need | Already built | Delta |
|---|---|---|
| Chat kind | `chats.kind` (`rp`, `workshop`, registered in `storageKinds`), `ChatKind` in `@rp/shared/chat.ts`; every creation path writes `rp` (`api/chats.ts`, `db/chatSetupWrites.ts`, `db/stImportWrites.ts`) | `CreateWorkshop` writes `workshop`; a `chatKinds` profile registry reads it (§2.1) |
| Rollout kinds and purposes | `rollouts.kind` and `llm_requests.purpose` include `workshop`; `requestWords.ts` already says "Writing a workshop reply" | Workshop turns use them; `ListActivity` leaves `workshop` out as it leaves `generation` out (`agentReads.ts:113`), since both make messages |
| Agent loop | `agent` strategy, `orchestrationModes` with one `default` planner, `rolloutTools` with `read`/`chat_state`/`external`, frozen tools, transcript flushes, receipts, Resume, step edits, steps UI, run inspector | The planner gets the chat kind; a `workshop` planner; `external` tools stop being filtered where the kind profile allows them (`ContextGenerator.ts:147,259` filters them today) |
| Continuity and contract keys | `rollout.continuity` (`fork`, `resume_previous`) and `output.contract` (`final_text`, `send_message`, `both`) in `@rp/shared/state.ts`; continuity is folded and unread | `output.contract` gains `several`; continuity is read for workshops (§2.4) |
| Approvals | None | Approval waits in the loop, `AnswerToolApproval`, `workshop.grants` (§3.4) |
| Operations | About 280 typed RPCs (`AppApi`); the `Commands` registry (`commands.ts`: `history.search`, `history.rename`, `message.insert`) with input and output schemas, "a trusted command seam for a future agent runtime" | The `operationTools` exposure registry over both (§3.2) |
| Library writes by the agent | `entity_revisions.origin` has `agent`, with `origin_ref`; History shows "Agent edit" (DESIGN §14.6 [P]) | Agent revisions are written with `origin_ref = <rollout>:<call>` |
| Changesets | Message, swipe, summary and `state_event` items in one atomic application, undo per item or all, `changeset_groups.origin` `agent`, `changesets.rollout_id` (same chat only, by trigger), rollout kind `edit` (DATA-MODEL §7.1: agentic chat editing) | `ApplyAgentChangeset` for text the agent wrote (search and replace is preview-bound today), recorded under an `edit` rollout in the edited chat (§3.5) |
| Plugin groundwork | `@rp/shared/registry.ts` scoped registries; about 70 server and 45 client registries and 60 client slots; `StateModules` and `AssemblyModules` load module URLs in the workers per request (`db/stateModules.ts`, `assembler/modules.ts`); storage kinds and settings are registries; namespaced state keys; `extensions` in library documents; client features register before the router is built (`main.tsx`) | Loader, manifest, consent, checks, per-plugin storage, a host API package (§5) |

Verified in code on 2026-11-12: every registry named above exists (`makeRegistry`, `defineSlot`). The production image runs the server's main thread from source and ships `packages/server/src` and `packages/shared/src`, but not `packages/client/src`; `rolldown` and `typescript` are dev dependencies, so neither is in the image; `node:24-slim` has no `git` binary.

### 1.2 What reference-harness does, and what changes here

| reference-harness (`latest`) | Here | Why |
|---|---|---|
| Session types (`agent.session_types.<name>`): workspace files, a tools allowlist, model and skills per type | **Chat kind profiles** (§2.1): planner, contract, continuity, toolset and look per kind, registered | Per chat, not per platform; a plugin adds a kind |
| Workspace files (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `TAIL.md`) assembled into the system prompt | The **Assistant card** and the **Workshop preset**, ordinary library items assembled by the registered assembler | DESIGN §7.7 [D]: an agent preset and a default assistant card the user can swap |
| Skills (`skills/<name>/SKILL.md`, `load_skill`, `tool_search`, dynamic tool loading) | Taken, superseded by [TOOL-LOADING.md](TOOL-LOADING.md): skills are registry entries and card extensions, not files; loads keep the cache on the measured wires | The owner asked for tool search that keeps the cache, and for skills (TOOL-LOADING §1) |
| `str_replace_based_edit_tool` and `search_files` (ripgrep) on a workspace confined by path resolution | The same edit semantics (`old_str`/`new_str`, all-or-nothing `edits`) for the files of one plugin repository (§6.1) | Models are trained on that editor |
| `bash` in a Docker sandbox container (`docker exec`), off by default | **No shell.** Checks are fixed commands the app runs (type check, bundle, a load probe, the plugin's own `node:test` tests) in child processes (§5.2) | Our deployment is one container without Docker access, and a fixed check set is enough to write plugins |
| `character_card_*` tools writing card PNGs into the workspace | Library tools writing card revisions (§3.3) | Cards are library entities here |
| Effect classes `redo_safe`/`repeatable`/`undoable`/`irreversible`; MCP tools take the class from the server's annotations; unknown names are irreversible | `read` and `chat_state` (built), plus `library`, `setup` and `outside` refining `external` (§3.1); every exposed operation declares its class; an operation without an exposure isn't offered | The same safe direction: nothing unclassified runs |
| Console resume of parked sessions | Built Resume (ARCHITECTURE §16), plus: a dangling non-read call is never re-run silently; it asks (§3.4) | An outside effect may already have happened |
| No approvals: the operator configures what's allowed | Approvals inside the steps, and per-workshop grants (§3.4) | DESIGN §7.7 [P]: tools with external effects need approval |

## 2. Workshop chats

### 2.1 The chat kind profile (registry `chatKinds`, server and client)

```ts
interface ChatKindProfile {            // server: agent/chatKinds.ts
  readonly id: string                   // "rp" | "workshop" | a plugin's
  readonly planner: string              // an orchestrationModes id: "default" | "workshop"
  readonly allowsOutside: boolean       // offer outside-class tools (rp: false)
}
interface ChatKindLook {               // client: features/workshop/kinds.ts
  readonly id: string
  readonly badge?: string               // "Workshop"
  readonly accent?: string              // a token: "--accent-workshop" (the name CLIENT-FRAMEWORK §5 gave it)
  readonly hides: ReadonlyArray<string> // composer controls it doesn't use: "composer.next", "composer.reply-now"
}
```

- `ContextGenerator` reads the chat's kind with the chat (it reads the chat row already) and asks the profile for its planner. `OrchestrationMode.plan` gains `kind` beside `state`. RP keeps `default`, byte for byte.
- The **`workshop` planner** (`agent/workshop.ts`): strategy `agent`, contract `several` (the chat's `output.contract` overrides it), a turn cap of 40, continuity from `rollout.continuity` (default `resume_previous`), tools = the workshop toolset of the capabilities not turned off (§3.4), and an assembly with the `workshop-instructions` piece (§2.2).
- `allowsOutside` replaces the hard filter at `ContextGenerator.ts:147,259`. An RP chat still never offers an outside-class tool, and `beforeToolCall` still blocks one that slips through (AGENTIC §4.1).

### 2.2 Making one, and what the model sees

**Where.** The Chats page (`/chats`, `ChatsPage.tsx`) has one card today, "A chat without characters". It becomes the first entry of a new slot, `chats.start-sections`, and the workshop registers a second card, **Workshop** ("Work with an assistant on your cards, chats and settings, outside any story."), with a title field and **New workshop** (hover: "Opens a workshop chat. It can change your library and settings; you choose what it may do."). No other place creates one, so nobody slips into one from a story (§7.7 [D]).

**`CreateWorkshop { title? }`** (an RPC in a new `WorkshopApi` group; one writer transaction):
1. If the user has no default assistant yet (user setting `workshop.defaults { card, preset }`, settings registry), it creates the **Assistant** card and the **Workshop** preset as ordinary library entities (revision origin `import`, `origin_ref` `builtin:workshop-assistant@1` and `builtin:workshop-preset@1`) and writes the setting. They show in the library like any card and preset; editing or replacing them is the user's business ([D]: "a default assistant card the user can swap for any of their own"). A user who deletes them gets fresh ones with the next workshop.
2. Inserts the chat with `kind = 'workshop'`, then the chat-wide events `StartChat` writes (`lcm.settings` with LCM off, `participant.join` for the card, the account persona as `played_by_me.set`), plus `preset.binding` to the Workshop preset. The model is the account default, as for a new RP chat; the chat's Model tab changes it.
3. The Assistant's first message is its greeting, an ordinary greeting version.

**What the model sees** on the first turn, in order (the Workshop preset's prompts through the built assembler, with one new stage):
- *Main prompt* (the preset): "You are the workshop assistant in a roleplay app. You help {{user}} with the app itself: characters, chats, prompt presets, lorebooks, settings, and plugins that change how the app works. You don't roleplay here."
- *Definitions* (the card): the Assistant's Description, "Practical and brief. You say what you're about to change, change it, then say what you changed. You don't describe changes you haven't made."
- *Chat history*: the greeting and the user's message.
- *Workshop instructions* (the `workshop-instructions` stage, after `end-of-request`, as `agent-instructions` works, AGENTIC §3.2; the inspector names the piece "Workshop instructions"): "Use the tools to look things up and to make changes. Before a long piece of work, tell {{user}} in a short message (send_message) what you'll do. Everything you change can be undone by {{user}}. Some tools ask {{user}} first: call them anyway; if {{user}} declines, say so and carry on. Turned off in this workshop: <the capabilities turned off, or nothing>." The preset can override it through a `workshopTurn` prompt identifier outside the order, as `agentTurn` works.
- The frozen tool definitions (§3).

### 2.3 Several messages a turn (contract `several`)

- `send_message { message }` posts the message at once and **doesn't** end the loop. A turn whose last request returns text without tool calls ends the loop, and that text, if not empty, is the turn's last message. The cap's last request ("Write the reply now.") is unchanged. DESIGN §7.2 [D] (one message a turn) binds RP; the workshop contract is §7.7 [P] ("an output contract that allows several messages").
- **Storage.** The rollout starts as today, with one generating version in a new slot (the "working" message). A `send_message` runs a new writer operation, **`PostRolloutMessage { rolloutId, versionId, text, reasoning }`**, in one transaction: it completes the working version with the message (its text through the registered parsers and rewrites, as `send_message` text goes today) and inserts the next slot under it, with a new generating version of the same rollout, selected, as the fork's tip. When the loop ends, `FinishRollout` completes the working version with the final text. If that is empty, the working slot is removed in the same transaction: it was only ever shown as "Working…" and has no other version, no child, no state event and no bin item. No schema change: versions already reference their rollout (`versions_rollout` index), and a slot may follow a slot of the same speaker.
- **Steps per message.** The tool result of each `send_message` carries `details: { versionId }` in the transcript. `stepsOf` (`agent/steps.ts`) cuts the transcript at those results: a message's steps are the ones between the run's previous message and its own. Steps after the last message show on the last message. `GetRolloutSteps { versionId }` and the header badge read the segment; the run inspector shows the whole run from any of its messages.
- **Regenerating one of them.** Regenerate (or a swipe) on the k-th message of a run is a step resume (the built `ResumeFromStep`) from the step just before that message's `send_message`: a new version in that slot, with a child rollout holding the transcript up to there, which may post further messages on its own branch. The earlier messages are unchanged.
- **Sending while it works** queues, as in RP (DESIGN §2.2, resolved: queue).

### 2.4 Carrying on the previous run (`rollout.continuity = resume_previous`)

**[D] §7.7:** rollout continuity can resume the previous rollout; the timeline stays separate either way.

- **What it is.** A new turn's rollout gets `parent_rollout_id` = the rollout of the last message on the path, a copy of that rollout's frozen request as its prefix, and a transcript seeded with that rollout's whole transcript plus one user message: the text of the user's messages after it on the path (images go as they would in a plain context, or as "[image]" for a model without image input). Every request of the new turn is the previous turn's last request plus what followed, so the provider reads it from cache, and the assistant still sees every tool result it got (a card it read three turns ago is still there).
- **When it applies.** Only while the path since that rollout is exactly what the run produced and what the user sent, checked at the generating slot. It falls back to a **fresh assembly** (the built `fork` behaviour: the preset, the card, the timeline's text as history, the tools) when:
  - a message on the path after the chain's start was edited, inserted, hidden or replaced by a changeset (the transcript no longer matches what the user sees; "Nothing changes that the user doesn't see", §10.3 [D]);
  - the parent rollout has no transcript, or its snapshot's assembler version is fenced;
  - the prefix and transcript would pass the model's context budget less the reply reserve (open question 4 asks what the fallback keeps).
- **What the user sees.** Nothing new in the chat. The inspector's request says "Carried on from the previous turn's run" with a link to it, or the fallback's reason ("The chat was edited after the previous run, so this request was put together again").
- **Tools changed between turns** (a capability turned off): the new definitions replace the old ones in the copied request, and the cache breaks once.

### 2.5 The look

All on existing surfaces, checked in the client code:

| Element | Where (existing surface) | What |
|---|---|---|
| Accent | The chat page root (`ChatPage.tsx`) | `data-chat-kind="workshop"` on the root; `styles.css` sets `--accent: var(--accent-workshop)` under it, with light and dark values (semantic tokens only) |
| Badge | `ChatBadges` (`ChatsPage.tsx`, used by the chat header's title and by the Chats list) | "Workshop" (`Badge`, neutral), hover "A workshop: the assistant works on your app, not in a story". `ChatBadges` takes the chat's `kind` (`Chat.kind` is in the shared type already) and reads `ChatKindLook.badge` |
| Capability chip | The composer's next-reply strip (`composerControls`, placement `strip`; `nextReplyStrip.tsx`'s `chipClass` and popover) | `workshop.capabilities`, available only in workshop chats: "Can: 6 · Asks: 2", opening a popover of full-width rows, one per capability (§3.4), each with its Off / Ask first / Allowed choice (`ui/Segmented`) and a one-line explanation. The kind's `hides` makes `composer.next` and `composer.reply-now` unavailable there |
| Changes | A chat panel tab (`chatPanels`, registered by the workshop, shown in workshop chats) | §3.6 |

Every control gets its hover explanation, nothing is reachable only by key, and the panel tab is in the URL as panel tabs already are.

## 3. Setup tools

### 3.1 Effect classes and capabilities

The built `external` class (AGENTIC §4.1) splits by what it touches. Each tool has one class and one capability.

| Class | What it touches | Undo | Asks by default |
|---|---|---|---|
| `read` (built) | Nothing | — | No |
| `chat_state` (built) | The workshop's own notes and state, attached to the version | A swipe | No |
| `library` | Library items: a new card, preset, lorebook or note, or a new revision of one | Restore the previous revision; a new item goes to the bin | No (open question 1) |
| `setup` | Chats and account settings: a new chat, a chat's cast or settings, a rename, an account default | Bin the chat, or write the previous value | No (open question 1) |
| `outside` | What leaves the app or that the app can't undo: a reply generated in another chat (a provider send the user didn't make in that chat, DESIGN §11 [D]), a network fetch, turning a plugin on, a deletion past the bin | Partial (a plugin can be turned off; a sent request can't be unsent) | Yes, unless allowed in this workshop; turning a plugin on always asks (§6.3) |

**Capabilities** (registry `workshopCapabilities`, each `{ id, label, explanation, defaultMode, adminOnly? }`):

| Capability | Tools (§3.3, §3.5, §6.1) | Default |
|---|---|---|
| `library.read` "Read your library" | `list_library`, `read_card`, `read_preset`, `read_lorebook`, `read_note` | Allowed; can't be turned off (the assistant is useless without it) |
| `chats.read` "Read your chats" | `list_chats`, `read_chat`, `search_chats` | Ask first (a story kept on a local model would otherwise go to the workshop's provider; open question 1) |
| `library.write` "Create and edit library items" | `create_card`, `edit_card`, `clone_card`, `create_preset`, `edit_preset`, `create_lorebook`, `edit_lorebook`, archive and restore | Allowed |
| `chats.setup` "Set up chats" | `start_chat`, `change_chat`, `rename_chat` | Allowed |
| `chats.rewrite` "Rewrite chats" | `rewrite_chat`, `rewrite_messages`, `rewrite_instructions` | Allowed (DESIGN §10.3 [D]: applied directly, no review gate, since everything is reversible) |
| `settings` "Change your settings" | `read_settings`, `change_setting` | Allowed |
| `generate` "Get replies in other chats" | `generate_reply` | Ask first |
| `plugins.write` "Write plugins" | `plugin_create`, `plugin_list`, `plugin_read`, `plugin_write`, `plugin_edit`, `plugin_search`, `plugin_diff`, `plugin_log`, `plugin_commit`, `plugin_check`, `plugin_api`, `plugin_copy_builtin` | Allowed (PLUGINS §1 [D]: the agent does all the work; the final application is gated) |
| `plugins.apply` "Turn plugins on" | `plugin_enable`, `plugin_rollback`, `plugin_disable` | Ask first; enabling always asks (§6.3) |

### 3.2 Operations become tools (registry `operationTools`)

**§7.7 [P]:** every UI action is a typed server operation, so that it can become an agent tool. The mechanism, so that no tool is written twice:

```ts
interface OperationExposure<Args, Payload, Result> {   // server: agent/operations.ts
  readonly id: string                    // the tool name the model sees: "rename_chat"
  readonly operation:                    // what it runs
    | { readonly rpc: string }           // an AppApi tag: "RenameChat"
    | { readonly command: string }       // a Commands id: "history.rename"
  readonly capability: string            // a workshopCapabilities id
  readonly effect: "read" | "library" | "setup" | "outside"
  readonly label: string; readonly explanation: string   // user-facing, as RolloutTool's
  readonly description: string           // model-facing: when to use it and when not
  readonly parameters?: Schema.Top       // what the model fills in; default: the payload schema
  readonly adapt?: (args: Args, ctx: ToolContext) => Effect<Payload, ToolFailure>  // names → ids, current row versions
  readonly render?: (result: Result, args: Args) => string    // the text result; default: compact JSON, budgeted
  readonly effects?: (result: Result, args: Args) => ReadonlyArray<EffectRecord>  // what it changed, with undo (§3.6)
  readonly summarize?: (args: Args) => string
}
```

- **The tool factory.** At plan time each exposure of an offered capability becomes a `RolloutTool` (the built interface). Its `parameters` are the exposure's schema as JSON Schema (`Schema.toJsonSchemaDocument`, Effect 4), frozen into the snapshot as every tool is. `execute` validates, runs `adapt`, then the operation **as the chat's owner**: an RPC through the server's own handler (`AppApi.accessHandler(tag)` in the handler context `server.ts` builds, with `CurrentUser` provided, so ownership checks, invalidation and hub events are exactly a UI call's), a command through `runCommand`. The result goes through `render` and the built result budget. A typed failure (`NotFound`, `StaleWrite`, `EditRefused` …) becomes a tool error with its message, so the model can correct itself.
- **Names, not ids.** Models refer to "Mara Quill" or "The Skerry Light". `adapt` resolves names through reader operations (`ListLibrary`, `ListChats`) and fails with the candidates when a name is ambiguous ("Two cards are called Mara Quill: … Name one by its id."). Read tools return ids beside names.
- **Coverage.** `test/operationCoverage.test.ts` walks `AppApi.requests` and the `Commands` registry: each tag is exposed, or listed in `operationExclusions` with a reason, so a new RPC fails the test until someone decides. Excluded by design, and asserted never exposed: everything that grants or changes permissions (`workshop.grants`, `AgentPermission`, `SetRegexApproval`, `SetHtmlApproval`, plugin consent), keys and credentials, network settings, users and passwords, sessions, the bin's purge, `SubscribeChat` and the other streams. **The agent can't give itself anything.**
- **First exposures** (W6): `RenameChat`; `ChangeCast`'s `Persona`, `Model`, `Preset`, `Lorebook`, `CardLorebook`, `AgentEnabled`, `AgentTools`, `CardsRotation`, `ReplyOrder`, `Join`, `Leave` and `Swap` (never `AgentPermission`); `CreatePreset`, `CreateLorebook`, `ForkVariant`, `RenameRef`, `SetRefArchived`, `RestoreRevision`, `SetCardFavourite`, `SetChatPin`, `ChangeGenerationDefaults`, `ListLibrary`, `ListChats`, `GetCast`, `ListRevisions`, `history.search`, `history.rename`.
- **Settings** go through one exposure, `change_setting { key, value }`, over the settings registry: an entry opts in with `agent: { description }`; the tool validates against the entry's schema and writes with the common revision check. `read_settings` lists the opted-in keys with their values.
- A plugin adds, replaces or disables exposures like any registry entry, and its own RPCs or commands become tools the same way.

### 3.3 Hand-written setup tools

Where the operation's shape doesn't suit a model:

| Tool | Class | Arguments → result | Over |
|---|---|---|---|
| `list_library` | read | `kind` (card, preset, lorebook, note), `query?`, `limit?` (20) → names, ids, subtitles, tags | `ListLibrary` |
| `read_card` | read | `card` (name or id), `fields?` → the card's fields as the library head has them, its alternate greetings, embedded lorebook names, `agent_editable_fields` | The `OpenEditor` snapshot, read only |
| `create_card` | library | `name`, `nickname?`, `description?`, `personality?`, `scenario?`, `first_message?`, `alternate_greetings?`, `example_messages?`, `system_prompt?`, `tags?`, `persona?` → the card's id | New writer op `AgentCreateEntity` (§3.6): the entity and one revision, origin `agent` |
| `edit_card` | library | `card`, `changes: [{ field, find, replace } \| { field, text }]` (each `find` once in the field, as `edit_note`) → the new revision | New writer op `AgentReviseEntity`: one revision on the head the tool read (a moved head is a tool error asking to read again); `withoutGrantedAgentEdits` keeps `agent_editable_fields` and approvals out of it (ARCHITECTURE §14.3) |
| `clone_card` | library | `card`, `name`, `nickname?`, `version?` → the new card | `ForkCard` (a variant: a card of its own) |
| `edit_preset` | library | `preset`, `changes: [{ prompt, find, replace } \| { prompt, text } \| { prompt, enabled } \| { prompt, before }]` | `AgentReviseEntity` on the preset document |
| `edit_lorebook` | library | `lorebook`, `changes: [{ entry, … } \| { add: {…} } \| { remove }]` | The same |
| `start_chat` | setup | `cards`, `persona?`, `greeting?`, `title?`, `preset?`, `model?` → the chat | `StartChat` (no provider request: the first message is the card's greeting), then `ChangeCast` for the preset and model |
| `change_chat` | setup | `chat`, one of the exposed `ChangeCast` changes by name | §3.2 |
| `read_chat`, `search_chats` | read | `chat`, `from?`, `count?` / `query` → messages as `read_messages` gives them, at the chat's current shown path | The built read tools (`agent/tools/history.ts`), with the other chat's chat, fork and leaf as their position |
| `generate_reply` | outside | `chat`, `speaker?` → the reply's text | `Generate` in that chat. It asks first: it sends that chat to its provider without the user's submit there (DESIGN §11 [D]) |

A user's unsaved editor drafts on a card the agent changes behave as when another tab saves: the editor shows the newer revision and offers Load the latest (the built stale handling).

### 3.4 Asking first, grants, and regenerating

- **The grant.** A branch-owned state key **`workshop.grants { capability, mode: "off" | "ask" | "allow" | null }`** in the workshop chat (registered in `@rp/shared/state.ts`, folded into `ChatState.workshopGrants`; `null` goes back to the default), written by the strip's chip and by "Allow in this workshop" through `ChangeCast`'s new `WorkshopGrant` change, and never by a tool (§3.2). Off removes the capability's tools from the next turn's definitions (the cache breaks once). Ask first and Allowed change nothing the model is sent, only execution, so the definitions stay byte-stable (reference-harness's record-turn gate works the same way).
- **The ask.** `beforeToolCall`, for a tool whose capability is Ask first (or an `outside` tool not allowed), flushes the transcript (built), then waits on an in-memory deferred keyed by `(rolloutId, toolCallId)`. The rollout stays `running`, with no provider request open. The `Steps` event shows the call with the status `waiting`, and the client renders inside the tool's row in the steps element what it will do (`summarize`, with the arguments folded under it), then **Allow** ("Lets the assistant do this once"), **Allow in this workshop** ("Lets it do this kind of thing here without asking again") and **Decline** ("Tells the assistant not to"). The header badge reads "Waiting for you". `AnswerToolApproval { rolloutId, toolCallId, answer: "allow" | "allow_chat" | "deny", note? }` (WorkshopApi) resolves it; `allow_chat` also writes the grant at the leaf. Declined, the tool result is an error the model sees: "{{user}} declined this." with the note, if any. Stop ends the wait like any running tool.
- **Restarts.** A restart parks the rollout as `interrupted` (built). Resume re-runs a dangling call (the built policy), except a `library`, `setup` or `outside` call without a receipt, which asks again: "The app stopped while this was running. It may already have happened: check before allowing it again." A call with a receipt answers from it (built).
- **Regenerating warns** (§7.3 [P]). Regenerate, a swipe, Resume and Resume from a step, on a version whose rollout has effects not yet undone, first show a `ConfirmDialog` (through a new client `replyGuards` registry beside `replyHooks`, whose entries may cancel; `replyHooks.beforeReply` can't): "This reply created the card Mara Quill and started the chat The Skerry Light. A new version won't remove them, and the assistant may make them again." **Undo them, then make a new version** · **Keep them and make a new version** · **Cancel**. Read and `chat_state` effects need no warning: a swipe reverses `chat_state` (built).

### 3.5 Rewriting a chat or its instructions (changesets)

Built (ARCHITECTURE §3.13): search-and-replace changesets over a fork's messages, swipes and summaries, `state_event` items, one atomic application, undo per item or all, and the History edits list. Not built: changesets over notes, card overrides (overtaken by fork-and-swap), chosen threads, and rewrites applied as a new chat.

- **`rewrite_chat { chat, pairs: [{ find, replace, regex?, wholeWord?, matchCase?, preserveCase?, in: ["messages", "swipes", "summaries"] }], title }`** (`chats.rewrite`): `PreviewHistory`, then `ApplyHistoryEdits`, exactly as the Search and replace panel, in the chat's current fork. The result gives the counts ("42 in 17 messages, 2 in summaries").
- **`rewrite_messages { chat, messages: [{ message, text }], title }`**: text the agent wrote, for "make the narration past tense" or "tidy the first ten replies". A new writer operation, **`ApplyAgentChangeset`**, takes explicit items (`{ version, text }`, `{ summary, text }`, state items), checks that each is on the fork's path as the fork shows it (`historyCurrent`), and writes them as `ApplyHistoryEdits` does (new versions with origin `changeset`, `replace` overrides, summary revisions, items with before and after), so the built undo, diffs and History edits list work unchanged. It's refused while that chat generates ("That chat is writing a reply; try again when it's done").
- **`rewrite_instructions { chat, changes }`**: the chat's notes (a new note revision bound by `note.binding` from the current position, the built mechanism) and its preset and lorebook bindings, as `state_event` items in the same changeset, so one Undo takes the whole rewrite back.
- **Provenance.** `changesets.rollout_id` must be in the changeset's chat (a baseline trigger), and the workshop's rollout isn't. So each application first writes an **`edit` rollout in the edited chat** (the kind exists, DATA-MODEL §7.1; `StartEditRollout`, completed in the same transaction, no ledger rows), whose snapshot records `{ workshop: { chat, rollout, toolCall } }`. The changeset's group has origin `agent` and the tool's `title`. History edits in the story shows the entry with "Made in the workshop *Setup*", linking to the step, and the story's Activity lists the edit, so nothing changes there that the user can't find (§10.3 [D]).

### 3.6 Effects, undo and the Changes panel

- **`rollout_effects`** (a new table, §8): one row per thing a call changed: `kind` (registered in `storageKinds`: `library.create`, `library.revise`, `chat.create`, `chat.change`, `setting.set`, `changeset.apply`, `plugin.create`, `plugin.commit`, `plugin.enable`, `reply.generate`), the target, a user-facing title ("Created the card Mara Quill"), the undo recipe as JSON, and `undone_at`. Written in the same writer transaction as the change wherever the change is one writer operation: `AgentCreateEntity`, `AgentReviseEntity` and `ApplyAgentChangeset` take `receipt: { rolloutId, toolCallId, effects }` and write the receipt and the rows with it. For an exposure that runs an RPC, the rows and the receipt follow in one `RecordRolloutEffects` transaction right after; a crash between the two is the restart case of §3.4, which asks.
- **Undo** (`UndoRolloutEffect { rolloutId, toolCallId, seq }`, WorkshopApi): a registered undoer per kind runs the existing operation (`RestoreRevision` to the revision before, if the head is still the agent's, else "Changed since; open its history"; the bin for a new card or chat; the previous setting value with the revision check; `UndoHistoryEdit` for a changeset; turning a plugin off) and marks the row undone in the same transaction where it can. Undo never deletes past the bin.
- **Where.** The tool's row in the steps element gets **Undo** ("Takes this change back") and, for a new chat or card, **Open**, through a new client `stepActions` registry the row renders (`Steps.tsx` has no extension point today). The **Changes** panel (§2.5) lists the workshop's effects newest first, grouped by turn, each with Undo and Open, and "Undo all of this turn" (built as "Undo all of this reply", workfix1). `ListRolloutEffects { chatId, before?, limit }` (reader op, owner-scoped) reads it.

### 3.7 Worked example: "make a card for a lighthouse keeper and start a chat with her"

With the defaults, `library.write` and `chats.setup` are Allowed. The turn is rollout R (kind `workshop`), carrying on the previous turn's run.

| # | The model | The user sees | Rows written |
|---|---|---|---|
| 1 | `list_library { kind: "card", query: "lighthouse" }` → "No cards match." | Step "Looked in your library: “lighthouse”" ✓ | — |
| 2 | `send_message { message: "I'll make her: Mara Quill, 52, keeper of the Skerry Light…" }` | That text as message 1, then "Working…" under it | `PostRolloutMessage`: message 1 completed; slot 2 with a generating version |
| 3 | `create_card { name: "Mara Quill", description: "…", personality: "…", scenario: "…", first_message: "The lamp's lit early tonight…" }` | Step "Created the card Mara Quill" ✓, with Undo and Open | `entities` (card), `entity_revisions` (origin `agent`, `origin_ref` `R:call_3`), the card summary row, the ref; `rollout_receipts (R, call_3)`; `rollout_effects (R, call_3, 0, library.create, "Created the card Mara Quill", undo: bin)` |
| 4 | `start_chat { cards: ["Mara Quill"], title: "The Skerry Light" }` | Step "Started the chat The Skerry Light" ✓, with Undo and Open | `chats` (kind `rp`), its chat-wide events and greeting (as `StartChat`), the receipt, `rollout_effects (… chat.create …)`. No provider request |
| 5 | Final text: "Done. Mara is in your library, and The Skerry Light opens with her greeting." | Message 2; the steps fold into "2 steps · 9 s" on message 2 and "1 step" on message 1 | `FinishRollout`: message 2 completed |

Undo: each step's Undo, or Changes → "Undo all of this turn" (Mara and the chat go to the bin). A swipe of message 2 warns first (§3.4). With `library.write` on Ask first, step 3 would wait in its row ("Create the card Mara Quill", the fields folded) with Allow, Allow in this workshop and Decline.

## 4. The out-of-character side chat (sharing the machinery only)

**§7.7 [P]:** a small workshop docked in a panel of an RP chat, reading the story and writing to its own timeline.

- **In Phase 6:** a workshop chat with a chat-wide **`workshop.attached { chat }`** event (written by `CreateWorkshop { attachTo }`), opened from the story's chat ⋯ menu ("Talk about this chat", hover "Opens a workshop beside this chat to talk about it out of character") and shown as a **Workshop** tab in the story's side panel (`chatPanels`, order 96), which renders that workshop's timeline and composer at the panel's width (Opus: a chat view inside a panel is new UI). `chats.read` is Allowed for the attached chat, and the RP read tools run against the story at the branch and message the request was sent from (workfix1 above; W9 used the branch last written in). The story's messages are never in the side chat's history: the assistant reads them through tools, so the side chat stays cheap, and nothing of it reaches the story's context.
- **Later:** the side chat proposing story notes the user applies with one click; pausing the story while it's open; the panel following the story's branch switches live; one side chat per branch; a "director" side chat whose notes the story's turns read.

## 5. The plugin loader (a delta to PLUGINS.md)

PLUGINS' **[D]**s bind: plugins can change almost anything; running one is the user's conscious choice; content never becomes code; a plugin the user's agent wrote is the user's; every plugin that isn't built in is a git repository; consent only for infrequent, important actions, with the agent doing the work; browser-only plugins aren't a trust category; a sandboxed type comes later. Its §8 groundwork is built (verified, §1.1).

### 5.1 Folders, manifest, enabled state

- **Repositories.** Instance plugins: `DATA_DIR/plugins/instance/<id>/`. A user's plugins: `DATA_DIR/plugins/users/<userId>/<id>/`. Each is a git repository (PLUGINS §4 [D]); a registry install, a folder or a zip becomes one with an initial commit (PLUGINS §4). Builds: `DATA_DIR/plugins/.builds/<scope>/<id>/<commit>/`, holding the checked-out tree, `server.mjs`, `worker.mjs`, `client.mjs` and `check.json`.
- **The manifest**, `rp-plugin.json` at the root:

  ```json
  { "id": "dice-roller", "name": "Dice roller", "api": 1,
    "client": "src/client.tsx", "server": null, "worker": null,
    "surfaces": ["client:composerControls"], "overrides": [], "network": false,
    "replaces": [], "base": null }
  ```

  `api` is the stable plugin API version (§5.3); `surfaces` the registries it uses (PLUGINS §5 [P]: handles are given only for these); `overrides` the Effect services it wraps (§5.4); `replaces` the built-in registrations it replaces, with `base` for an editable copy (§5.7).
- **Enabled state** is settings, not a new table (ARCHITECTURE §3.7: new settings go into `settings` through the registry): app scope `plugins.instance` and user scope `plugins.user`, each `{ [id]: { commit, enabledAt, enabledBy, sessionTrust?: { workshop, until }, suspended?: { reason, at, appStamp } } }`.
- **Git** is the binary or a library (PLUGINS §10 Q5, open; open question 5 here). The loader needs init, add, commit, log, diff and checking out a commit into a build folder; registry installs will need fetch and merge.

### 5.2 Checks: at enable and at startup

One function, `checkPlugin(scope, id, commit)`, runs in a **child process**, so the main thread never runs TypeScript's checker or the bundler (CLIENT-FRAMEWORK §7's event-loop budget):
1. Check out the commit into its build folder.
2. Validate the manifest. Refuse `server`, `worker` or `overrides` in a user's plugin unless the user is an admin (§5.6).
3. **Type-check** against the plugin API's declaration files for the running app (`typescript` becomes a production dependency).
4. **Bundle** each entry with `rolldown` (a production dependency), with the plugin API and React marked external (§5.3, §5.5). Plugins import only the API and their own files: there's no package install, so no install script runs (a dependency, if needed, is vendored into the repository).
5. **Load probe**, for server and worker entries and only for admins: import the bundle in a second child process under Node's permission model (`--permission`; file reads limited to the build folder and the API package, no writes, no child processes, no workers) and call `activate` against a recording host. It lists what the plugin registers and compares it with the declared surfaces ("declares client only, but registers a provider kind" fails). Node 24's permission model doesn't cover the network: it's a seat belt (PLUGINS §6.2), not a sandbox.
6. **Tests:** the plugin's `test/*.test.ts`, if any, with `node:test` in the same restricted child. A client-only plugin's tests run there too, against the API's test doubles.

`check.json` records each step. Results are cached by `(commit, appStamp)` (the API version and the build stamp, `workerStamp.ts`' hash), so a restart without an app update checks nothing again.

**At startup**, before the server listens, every enabled plugin whose cached check isn't for this `appStamp` is checked again (60 s each, in parallel up to the core count less two). A plugin that fails a step, fails to load or throws in `activate` is **switched off for this run** (`suspended` written with the first error), the app goes on without it, and a notice goes to its owner (a user plugin) or to every admin (an instance plugin) through the built notice system: "Dice roller was turned off when the app started: src/client.tsx(14): Property 'insertText' does not exist. Ask a workshop to fix it, or go back to an earlier version." with **Go back** and **Open plugins**. Enabling a new commit clears `suspended`, and so does re-enabling the same commit after the app changed again. `PLUGINS=off` in the environment (set outside the app, like the security settings, ARCHITECTURE §2) starts with no plugins.

### 5.3 The plugin API (`packages/plugin-api`, the stable tier)

A new workspace package, versioned (`api: 1`), with three entry points, each the **only** import a plugin needs for its side:
- `@rp/plugin-api/server`: `activate(host)` receives handles to the declared registries (`rolloutTools`, `operationTools`, `workshopCapabilities`, `orchestrationModes`, `replyStrategies`, `replyParsers`, `liveRewrites`, provider kinds, transforms, observers and costs, `commands`, `decisionPoints`, `chatKinds`, macros), `storage` (§5.6), `notices`, `log` and `network.fetch` (the built `Network.fetchFor`, logged with the plugin's id). Each handle's `register` and `disable` are the built scoped ones, in the plugin's scope.
- `@rp/plugin-api/worker`: what `StateModules` already passes (`stateKeys`, `storageKinds`, `settingsRegistry`) and the assembler's registries (stages, projections, transforms, planners), plus `storage`.
- `@rp/plugin-api/client`: `activate(host)` receives the declared client registries and slots (`composerControls`, `chatPanels`, `messageActions`, `routes`, `settingsGroups`, the `message.*`, `chat.*` and `editor.*` slots …) and `rpc` (the `AtomRpc` client and `useAction`). The module also exports the `ui/` components, the hooks a feature needs, and React.

The core already registers through these registries, so the API is a re-export with a version, not a second implementation. A breaking change bumps `api`; an app on `api: 2` refuses a plugin built for `api: 1` at its check, with the changelog's entry in the report.

### 5.4 Server: main thread and workers

- **Main thread.** `activate` runs inside a `Scope` per plugin: `import(pathToFileURL(".../<commit>/server.mjs"))`, then `activate(host)` provided with that scope. Turning the plugin off closes the scope, which undoes every registration (the registries' built stacks). A new commit is a new path, so it loads fresh; Node can't unload an ES module, so the old one stays in memory until a restart (the plugins page says "Restart to free the memory of older versions" after ten loads).
- **Workers.** A `worker` entry is registered with the built `StateModules.register({ id, module, exportName })` and `AssemblyModules`, which send the module list with each worker request; source and bundled workers import it and install it in the request's scope (built). Worker entries use only their arguments, never the app's modules: each worker bundle has its own copy of the shared registries, which is why `StateModules` passes them in. The format and thumbnail workers have no plugin hooks yet (Later).
- **Overrides** (PLUGINS §3.4, the internal tier): Effect layers wrapping a named service. Services are built at launch, so an override applies at the next restart, and the enable prompt says "Applies when the app restarts". Registrations apply at once.
- **The internal tier on the server.** The main thread runs from source, so a server entry may import app modules (`@rp/app/server/...`, rewritten by the bundler to the app's file URLs). These may change in any release (PLUGINS §3.4), and the startup check is what catches it.

### 5.5 Client: loading in the browser

- **One host module.** The client build gets a second entry, `src/pluginHost.ts`, which re-exports the client API and which the app itself imports, so there is one instance of React, of every registry and of every slot. Vite writes its hashed file name into the build manifest, and the server serves `/plugin-host.mjs` as `export * from "/assets/pluginHost-<hash>.js"`. Plugin client bundles import `/plugin-host.mjs` for the API and React (the bundler rewrites `@rp/plugin-api/client`, `react` and `react/jsx-runtime` to it). Everything is same-origin, so the CSP stays `script-src 'self'` and `connect-src 'self'` (PLUGINS §8, built).
- **Serving.** `GET /plugins/<scope>/<id>/<commit>/client.mjs`, cached as immutable, served only to sessions for which the plugin is enabled (an instance plugin: every user; a user plugin: its owner).
- **Order.** `main.tsx` asks `ListClientPlugins` (session-scoped) before `buildRouter()`, `import()`s each module and calls `activate(host)` with that plugin's handles, so plugin routes exist when the router is built. A module that fails to load or throws is skipped, its partial registrations disposed, and the tab shows a banner (`appBanners`): "Dice roller didn't load and is off in this tab." with **Turn it off** and **Details**.
- **Rendering errors.** Registrations made through a plugin's handles carry its id. `SlotOutlet` and the registry renderers wrap such entries in an error boundary that renders nothing and reports once ("Dice roller's composer button failed: …"). Built-in entries are unchanged.
- **Live changes.** Enabling or turning off applies at once in that tab (registries notify their subscribers), routes excepted, which need a reload. Other tabs get a `Plugins` notice and the banner "Plugins changed. Reload to apply." with **Reload**, as the new-version notice works (ARCHITECTURE §5).
- **Safe start.** `?plugins=off` on any URL loads the page without client plugins, offered by the banner and by Settings → Plugins ("Open without plugins").

### 5.6 Permissions, consent and the shared server

- **Consent moments** (PLUGINS §1 [D]: infrequent and important): turning a plugin on; applying a new commit of an enabled plugin, unless "apply its updates without asking while we work on it" was chosen (PLUGINS §5 [P] "allow for this session"; the trust names the workshop and lasts until it has been left for 30 minutes or the server restarts; open question 3); a plugin's declared surfaces growing (always asks, trusted or not). Going back to a commit that was enabled before, with the same or fewer surfaces, doesn't ask.
- **What the prompt says** (no code review in it, PLUGINS §5): the name and the commit message; where it runs ("Runs only in your browser. It can do anything you can do in the app." or, for server code, "Runs on the server with full access, including stored keys and every user's chats."); what it adds, from `surfaces`, in words ("Adds a button to the composer"); "Can send data to other sites" when `network` is set (server code only; browser code can't, by the CSP); and, for an instance plugin, "Applies to every user of this app."
- **The shared server** (PLUGINS §6.1 [P]: server plugins are instance-wide and admin-only). An instance plugin, and any plugin with `server`, `worker` or `overrides`, is created, enabled and checked only by admins, and the load probe and tests, which run plugin code on the server, run only for admins. A non-admin's workshop can write plugins in that user's own folder; they run only in that user's pages and as that user, so they can't reach another user's data (ownership, ARCHITECTURE §4). "Server code needs an admin" is the check's message for a non-admin's server entry.
- **Per-plugin storage** (PLUGINS §3.3): a new table `plugin_data (plugin_id, owner_user_id, key, value_json, revision, updated_at, PRIMARY KEY (plugin_id, owner_user_id, key)) STRICT`, reached only through `host.storage` (`get`, `set` with the revision check, `list`, `delete`) and scoped to the plugin and the acting user (an instance plugin uses `owner_user_id = ''` for instance data). Writer operations `SetPluginData` and `DeletePluginData`; reader operations `GetPluginData` and `ListPluginData`. Removing a plugin keeps its data until "Delete its data" on the plugins page. Plugin data on items keeps the built forms: `extensions.<id>` in documents, `<id>/<key>` state keys.

### 5.7 Making a built-in feature an editable plugin

PLUGINS §4: a built-in feature can be forked into a repository that replaces the built-in id.
- Built-in registrations gain an optional `source: import.meta.url` (in the server and client registries' entry types); a test checks that every built-in entry plugins can replace has one.
- **`plugin_copy_builtin { registry, id }`** (also "Make an editable copy" in the plugins page's Built-in list, read by `ListBuiltinParts`) copies the source file, and the files of its folder that only it imports, into a new repository; rewrites imports of `ui/`, `slots.tsx`, `registry.ts`, `rpc.ts`, `actions.tsx` and the registry modules to the plugin API; writes `replaces: ["<registry>:<id>"]` and `base: { app, path, sha256 }`; commits; and runs the check. An import the API doesn't cover fails the check with a list ("features/chat/session.ts isn't part of the plugin API"), which the agent resolves by reimplementing it, or which shows that the API should grow.
- The image ships `packages/client/src` for this (the server's sources are in it already).
- After an app update, a copy whose base file's hash changed shows "The original changed in this update" with **Compare** (the base against the current source), and the agent merges it on request.

## 6. The agent writing plugins

### 6.1 The tools (`plugins.write`, `plugins.apply`)

All are confined to one repository by path resolution (no `..`, no symlinks leading out, at most 1 MB a file and 2,000 files a repository):

| Tool | Class | Arguments → result |
|---|---|---|
| `plugin_list` | read | → the user's plugins (and the instance's, for admins): id, enabled commit, latest commit, status |
| `plugin_api` | read | `topic?` → the plugin API's documentation for a registry or slot (generated from the API package's doc comments), with an example; without a topic, the index |
| `plugin_create` | library | `id`, `name`, `runs: "browser" \| "server"` → a repository from the template (manifest, `src/client.tsx` or `src/server.ts`, a test) and its first commit |
| `plugin_read`, `plugin_search` | read | `plugin`, `path`, `range?` / `query` → the file with line numbers / the matches |
| `plugin_write` | library | `plugin`, `path`, `content` → creates or overwrites, uncommitted |
| `plugin_edit` | library | `plugin`, `path`, `old_str`, `new_str`, or `edits: [...]` (all or nothing, reference-harness's semantics) |
| `plugin_diff`, `plugin_log` | read | uncommitted changes / commits with their messages |
| `plugin_check` | read | `plugin`, `commit?` (default: the working tree) → the report of §5.2 |
| `plugin_commit` | library | `plugin`, `message` → the commit id. Effect `plugin.commit`; undo: a revert commit |
| `plugin_enable` | outside | `plugin`, `commit` → asks (§6.3); on yes, the setting and an effect `plugin.enable` (undo: turn off, or go back to the commit enabled before) |
| `plugin_rollback` | outside | `plugin`, `to` (a commit enabled before) → re-pins without asking |
| `plugin_disable` | setup | `plugin` → off |
| `plugin_copy_builtin` | library | §5.7 |

Admins' workshops also get `app_source { path } | { query }`, a read-only view of the shipped `packages/*/src`, so the agent can learn how a built-in does something.

### 6.2 What runs where

Writing, diffing and committing touch only files. `plugin_check` runs the child processes of §5.2: the type check and bundle for everyone, the load probe and tests only for admins. Nothing the agent writes runs in the app's process or pages before `plugin_enable` is approved.

### 6.3 The safety loop

1. The agent writes, checks and commits freely (PLUGINS §1 [D]: prompts gate application, never the work).
2. `plugin_enable` needs a passing check for that commit. Then it waits in its step row with the consent text of §5.6 and **Turn on** ("Runs this plugin from now on"), **Turn on, and apply its updates without asking while we work on it**, and **Not now**. It always asks, whatever the workshop's grants (DESIGN §11 [P]: plugin installation is always confirmed).
3. On yes, it applies at once (§5.4, §5.5), and the assistant asks the user to try it.
4. If it's wrong, the user says so; the agent fixes, checks, commits and enables again (asking again unless step 2's trust holds).
5. **Recovery without the agent:**
   - a plugin that fails its check or load at startup is off, with a notice offering Go back (§5.2);
   - a client plugin that fails to load or render is contained to nothing, with a banner (§5.5);
   - **Settings → Plugins** (a `settingsGroups` group, `/settings/plugins` and `/settings/plugins/<id>`, part of the plugin host, so no plugin can disable it: PLUGINS §3.2 makes the plugin host kernel) lists every plugin with its status and commits: **Turn off**, **Go back to <commit>** (any commit enabled before), **Delete its data**, the last check's report, and **Open without plugins**;
   - a plugin that breaks the page itself: `?plugins=off`; one that breaks the server: `PLUGINS=off`.

### 6.4 Worked example: "add a dice-roll button to the composer"

A single-user instance whose user is the admin, with `plugins.write` Allowed and `plugins.apply` Ask first.

| # | The model | The user sees | Written |
|---|---|---|---|
| 1 | `plugin_api { topic: "composerControls" }` → the placements (`tools`: icon buttons after the speaker), the context's fields, an example | Step "Read the plugin docs: composerControls" | — |
| 2 | `send_message { message: "I'll make a small browser plugin that adds a d20 button beside the composer's tools." }` | Message 1 | — |
| 3 | `plugin_create { id: "dice-roller", name: "Dice roller", runs: "browser" }` | Step ✓ | `DATA_DIR/plugins/users/<uid>/dice-roller/`, commit `a1c0…` "Start Dice roller"; effect `plugin.create` |
| 4 | `plugin_write { plugin: "dice-roller", path: "src/client.tsx", content }` (below, first with `ctx.insertText`) | Step ✓, the file folded | The file, uncommitted |
| 5 | `plugin_check` → "Type check: Property 'insertText' does not exist on ComposerControlContext." | Step ✗ | — |
| 6 | `plugin_api { topic: "composerControls" }`, then `plugin_edit` to use `draft.append` | Steps | — |
| 7 | `plugin_check` → "Passed. client.mjs 1.1 kB. Registers composerControls `dice-roller.roll` (tools). Declares: browser, composerControls." | Step ✓ | `check.json` |
| 8 | `plugin_commit { message: "Add a d20 button" }` | Step ✓ | Commit `3f2a…`; effect `plugin.commit` |
| 9 | `plugin_enable { plugin: "dice-roller", commit: "3f2a" }` | The row waits: "Turn on Dice roller (Add a d20 button)? Runs only in your browser. It can do anything you can do in the app. Adds a button to the composer." The user picks **Turn on** | `settings` user `plugins.user["dice-roller"] = { commit: "3f2a…", … }`; effect `plugin.enable` |
| 10 | Final text: "It's on: the die is beside the composer's tools. Want a d6 as well?" | The composer shows 🎲 ("Rolls a d20 and adds the result to your message") | — |

```tsx
// src/client.tsx
import { type ClientHost, ui } from "@rp/plugin-api/client"
export const activate = (host: ClientHost) => [
  host.composerControls.register({
    id: "dice-roller.roll", order: 60, placement: "tools",
    component: ({ draft }) => (
      <ui.IconButton hint="Rolls a d20 and adds the result to your message"
        onClick={() => draft.append(`🎲 ${1 + Math.floor(Math.random() * 20)}`)}>🎲</ui.IconButton>)
  })
]
```

The gap in step 5 is real: `ComposerControlContext` has no way to add text to the draft today. P2 adds `draft: { append }` to it, since the core is the API's first client and the dice button its first non-core one. Undo: Turn off (step 9's Undo, or Settings → Plugins), Go back to an earlier commit, or revert the commit. "Make it a d6" later is steps 4–9 again with a new commit, and step 9 asks again unless "apply its updates without asking" was chosen.

## 7. Left for later

- The sandboxed ("safe") plugin type (PLUGINS §5 [D], future): hooks reached through `postMessage` or RPC from an iframe or a worker that never holds the server secret.
- The public registry, admission review and the GitHub integration (PLUGINS §9 [D]); fetching and merging upstream updates.
- Importing presets, cards or lorebooks from a file attached to a workshop message (attachments are images only; `version_attachments.kind` would gain `file`).
- Plugin hooks in the format and thumbnail workers.
- The side chat's Later items (§4), a workshop over several chats at once, and rewrites applied as a new chat (DESIGN §10.3 [P]).
- Summaries for long workshops (LCM over a workshop timeline; open question 4).

## 8. Stored data

`db/baseline.ts` (baseline only, no migration; **BASELINE CHANGED** when W3 and P1 land):

- `rollout_effects (rollout_id TEXT NOT NULL REFERENCES rollouts(id) ON DELETE CASCADE, tool_call_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, target_kind TEXT NOT NULL, target_id TEXT NOT NULL, title TEXT NOT NULL, undo_json TEXT CHECK (undo_json IS NULL OR json_valid(undo_json)), undone_at INTEGER, created_at INTEGER NOT NULL, PRIMARY KEY (rollout_id, tool_call_id, seq)) STRICT, WITHOUT ROWID`, with an index on `(target_kind, target_id)`; `kind` registered in `storageKinds` (`rollout_effects.kind`).
- `plugin_data` (§5.6), with an index on `(owner_user_id)`.

Nothing else in the schema changes, and **nothing reshapes existing chat data**. Workshop chats are ordinary `chats` rows with `kind = 'workshop'` (a value the baseline and the registry already have); their messages are ordinary slots and versions, and their turns ordinary rollouts of kind `workshop`. Several messages a turn reuse `versions.rollout_id`; continuity reuses `parent_rollout_id`; edit rollouts reuse the kind `edit`; agent revisions reuse the origin `agent` and `origin_ref`.

State keys (`@rp/shared/state.ts`, registered with their id declarations): `workshop.grants { capability, mode }` (branch-owned); `workshop.attached { chat }` (chat-wide; `chat` declared as a chat id, so the writer checks ownership); `output.contract` gains `several`.

Settings (the registry and the `settings` table): user `workshop.defaults { card, preset }`, app `plugins.instance`, user `plugins.user`, and an optional `agent` field on settings registry entries.

Operations (`db/ops.ts`): writer `CreateWorkshop`, `PostRolloutMessage`, `AgentCreateEntity`, `AgentReviseEntity`, `RecordRolloutEffects`, the marks of `UndoRolloutEffect`, `StartEditRollout`, `ApplyAgentChangeset`, `SetPluginData`, `DeletePluginData`; reader `ListRolloutEffects`, `RolloutEffectsFor { versionIds }` (the regenerate warning), `GetPluginData`, `ListPluginData`. RPC groups: `WorkshopApi` (`CreateWorkshop`, `AnswerToolApproval`, `ListRolloutEffects`, `UndoRolloutEffect`, `ListWorkshopCapabilities`) and `PluginApi` (`ListPlugins`, `GetPlugin`, `CheckPlugin`, `EnablePlugin`, `DisablePlugin`, `PinPluginCommit`, `DeletePluginData`, `ListClientPlugins`, `ListBuiltinParts`); `ChangeCast` gains `WorkshopGrant`. HTTP: `/plugin-host.mjs` and `/plugins/<scope>/<id>/<commit>/client.mjs`.

## 9. Build units

Each unit is sized for one agent session, ships with its tests, moves its text into ARCHITECTURE and marks its sections here obsolete. **Opus**: new UI or design judgement. **Sol**: precisely specified here.

| # | Unit | Model | Depends on | Files | Tests |
|---|---|---|---|---|---|
| W1 | **Workshop chat, server**: `chatKinds` profiles, the planner's `kind`, the `workshop` planner (contract `both` until W5), `allowsOutside` in place of the external filter, `CreateWorkshop` with the seeded Assistant card and Workshop preset and `workshop.defaults`, the `workshop-instructions` stage, rollouts of kind `workshop` (purpose `workshop`), `ListActivity` leaving them out; read tools `list_library`, `read_card`, `read_preset`, `read_lorebook` | Sol | — | `agent/{chatKinds,workshop,modes}.ts`, `agent/tools/library.ts`, `chat/ContextGenerator.ts`, `assembler/stages.ts`, `db/{chatSetupWrites,agentReads,settings}.ts`, `api/workshop.ts`, `@rp/shared/workshopApi.ts` | `test/workshop.test.ts`: a scripted provider reads a card and answers; the chat's kind; the seeded items made once per user and reused; the request's pieces in order and frozen; RP requests byte-identical (the existing generation tests); an outside test tool offered in a workshop and refused in RP; Activity without workshop turns; `isolation.test.ts` for the new RPCs |
| W2 | **Workshop chat, client**: the `chats.start-sections` slot with both cards, the badge, `--accent-workshop` (light and dark) on the chat root, the capability chip (read-only rows until W4), `hides` for the RP-only chips, "Workshop instructions" in the inspector | Opus | W1 | `features/workshop/*`, `features/chat/{ChatsPage,ChatPage}.tsx`, `styles.css`, `registerComposerControls.tsx` | e2e `workshop.spec.ts` at 1440 and 390, light and dark: create, badge, accent, the chip's popover, a scripted reply with steps; layout audit on the Chats page, the chat and the popover |
| W3 | **Setup tools I and effects**: the `library`/`setup`/`outside` classes, receipts for every non-read call, `rollout_effects` and its kinds, `AgentCreateEntity`, `AgentReviseEntity`, `create_card`, `edit_card`, `clone_card`, `start_chat`, the undoers, `UndoRolloutEffect`, `ListRolloutEffects`, and the restart rule for unreceipted calls (until W4 it fails the call with "may already have happened") | Sol | W1 | `agent/{tools,effects}.ts`, `agent/tools/setup.ts`, `db/{baseline,ops,rolloutEffects,libraryWrites}.ts`, `api/workshop.ts` | The lighthouse example end to end (§3.7): the rows, origin and `origin_ref`; receipts make a resumed call a no-op; undo of each kind; undo refused when the head moved; a moved head is a tool error; `withoutGrantedAgentEdits` holds |
| W4 | **Asking first**: `workshopCapabilities`, `workshop.grants` and `WorkshopGrant`, the approval wait and `AnswerToolApproval`, the `waiting` step status and the row's buttons, the strip's Off / Ask first / Allowed, the `stepActions` registry (Undo, Open), the Changes panel, `replyGuards` and the regenerate warning | Opus | W2, W3 | `agent/{approvals,capabilities}.ts`, `features/workshop/*`, `features/chat/agent/Steps.tsx`, `features/chat/replyHooks.ts`, `@rp/shared/state.ts` | Server: a waiting call holds no provider request; a decline reaches the model as an error; `allow_chat` writes the grant at the leaf; Off removes the tools while Ask and Allow leave the definitions unchanged; a restart asks again. e2e at 1440 and 390, light and dark: allow, decline, allow in this workshop, undo from the row and the panel, the regenerate dialog; layout audit on the row, the panel and the dialog |
| W5 | **Several messages and continuity**: the `several` contract, `PostRolloutMessage`, the empty working slot removed at the finish, steps cut by `details.versionId`, regenerating the k-th message as a step resume, `resume_previous` with its fallbacks and the inspector's lines | Sol | W1 (W3 for effects on resumed runs) | `agent/{strategy,session,steps,continuity}.ts`, `db/{generationWrites,agentReads}.ts`, `chat/ContextGenerator.ts`, `ContextPage.tsx` | Two sends and a final text make three messages with their steps; a run ending with a send leaves no empty message; a second turn's first request is the first turn's last request plus its tail plus the user's message (exact Chat Completions and Anthropic bodies); an edit, an insertion and the budget each fall back with their reason; a swipe of message 2 of 3 keeps message 1 |
| W6 | **Operations as tools**: `operationTools`, the tool factory over `accessHandler` and `runCommand`, name resolution, `operationExclusions` and the coverage test, the first exposures (§3.2), `change_setting` and `read_settings` with the settings registry's `agent` field, `generate_reply` | Sol | W3 (W4 for `generate_reply`'s ask) | `agent/operations.ts`, `agent/exposures/*.ts`, `server.ts`, `db/settings.ts` | Coverage fails on a new unclassified RPC; an RPC through its tool writes the same rows and hub events as from a client; ambiguous names; excluded RPCs never offered; a plugin's exposure registered and removed with its scope |
| W7 | **Presets and lorebooks**: `edit_preset`, `create_preset` (an exposure), `edit_lorebook`, `create_lorebook`, archive and restore | Sol | W3, W6 | `agent/tools/setup.ts`, `db/libraryWrites.ts` | Each change kind on preset and lorebook documents; the editor's stale handling with an open draft (e2e, one profile) |
| W8 | **Rewriting chats**: `rewrite_chat`, `rewrite_messages`, `rewrite_instructions`, `ApplyAgentChangeset`, `StartEditRollout`, History edits' "Made in the workshop" line and link, `read_chat` and `search_chats` | Sol | W3, W6 | `agent/tools/rewrite.ts`, `db/{historyWrites,historyReads}.ts`, `features/chat/HistoryPanel.tsx` | A rename across messages and summaries undone in one step; agent text for ten messages, one of them undone; refused while the chat generates; a fork made earlier unaffected; the edit rollout in the story's Activity; isolation for every target |
| W9 | **The side chat**: `workshop.attached`, `CreateWorkshop { attachTo }`, the ⋯ menu entry, the Workshop panel rendering a chat in the side panel, the read tools at the story's position | Opus | W2, W5 | `features/workshop/SidePanel.tsx`, `registerPanels.tsx`, `agent/tools/history.ts` | Server: reads see only the story's shown path, and nothing of the side chat is in the story's context (inspector); e2e at 1440 and 390, light and dark, and the layout audit on the panel |
| P1 | **Plugin host, server**: `packages/plugin-api` (server and worker entries), the manifest, the folders, git (per open question 5), the settings keys, `checkPlugin` and its child processes, `typescript` and `rolldown` as production dependencies, activation in scopes with the declared handles, worker entries through `StateModules` and `AssemblyModules`, the startup check and its notices, `PLUGINS=off`, `plugin_data` and its operations, `network.fetch` logging | Opus | — | `server/src/plugins/*`, `packages/plugin-api/*`, `db/{baseline,ops,pluginData}.ts`, `config.ts`, `Dockerfile` | A test plugin registering a tool and a state key, in source and bundled workers; turning it off restores the built-ins; a type error, a throw in `activate` and an undeclared registry each suspend it with a report while the app runs; the probe can't write outside its folder; a non-admin's server entry refused; storage scoped by plugin and user (`isolation.test.ts`) |
| P2 | **Plugin host, client**: `pluginHost.ts` and the manifest mapping, `/plugin-host.mjs` and the plugin route, loading before the router, per-entry error boundaries, the banners, live enable and disable, `?plugins=off`, `ComposerControlContext.draft` | Opus | P1 | `client/src/{main.tsx,pluginHost.ts,slots.tsx}`, `vite.config.ts`, `server/src/plugins/serve.ts` | e2e: a fixture plugin adds a composer button and a panel under the CSP (`csp.spec.ts`); a throwing component renders nothing and reports once; `?plugins=off`; another tab gets the banner; the layout audit with the plugin's button at 1440 and 390 |
| P3 | **Settings → Plugins and consent**: the group and its routes, the list and detail (commits, check report, data), Turn off, Go back, Delete its data, the consent texts per surface, session trust, the admin rules | Opus | P1, P2 | `features/plugins/*`, `api/plugins.ts` | e2e at 1440 and 390, light and dark: enable with consent, go back, turn off, the suspended notice's Go back; trust expiry; a non-admin sees no controls for server plugins; layout audit |
| P4 | **The agent's plugin tools**: §6.1's tools, confinement, `plugin_api` docs generated from the API package, `app_source`, enabling through W4's ask with the consent text | Sol | P1, P3, W4 | `agent/tools/plugins.ts`, `server/src/plugins/repo.ts` | The dice example end to end with a scripted provider (§6.4), the failed check included; path escapes and size limits refused; enabling without a passing check refused; rollback without asking; a non-admin's probe skipped |
| P5 | **Editable copies of built-ins**: `source` on built-in registrations and its test, `ListBuiltinParts`, `plugin_copy_builtin` with import rewriting, `base` tracking and "The original changed", the client sources in the image | Opus | P4 | the registries' entry types, `server/src/plugins/copy.ts`, `features/plugins/*`, `Dockerfile` | Copy the completion sound and the `set_presence` tool, change them, and see the replacements run; an unsupported import listed by the check; a changed base flagged after a simulated update |

Order: W1, then W2 and W3 in parallel; after W1–W3 a workshop can make cards and start chats. Then W4 and W5 in parallel, W6, then W7 and W8 in parallel, and W9 last of the W units. P1 can start any time after W1 (it doesn't need the workshop); P2 and P3 follow it; P4 waits for P3 and W4; P5 comes last.

## 10. Open questions

1. **Should reversible changes ask first by default?** DESIGN §7.3 and §7.7 (proposed) put library edits and settings among the "external" tools that need approval. PLUGINS' decided rule is that prompts are only for rare, important actions, and DESIGN §10.3's decided rule is that changesets apply without review because everything is reversible. Example: "make a card for a lighthouse keeper and start a chat with her" either just happens, with Undo on each step, or stops twice for Allow. Reading other chats is the same kind of choice, for privacy: a story you keep on a local model would be sent to the workshop's cloud model when the assistant reads it. **Recommendation:** creating and editing library items, setting up chats, rewriting chats and changing settings are allowed by default, each with Undo; reading other chats' messages, getting replies in other chats, network access and turning plugins on ask first; every capability can be switched per workshop from the strip.
2. **How does a client plugin load?** As separate modules against one host module (§5.5): enabling is instant and needs no build tools at enable time, but a plugin can use only what the API exports, so an editable copy of a built-in client feature that imports app internals fails its check until the API grows. The alternative rebuilds the whole client bundle with the plugins in it: any internal import works, but each enable takes about a minute, and the image must ship Vite, the client source and its dev dependencies (a few hundred MB). Example: copying the message toolbar to change one button works at once with a rebuild, and may need two or three API additions without one. **Recommendation:** separate modules, growing the API as copies hit gaps.
3. **When the agent iterates on a plugin, does each new commit ask?** PLUGINS §10 Q1 is open. Example: tweaking the dice button five times means five "Turn on Dice roller?" prompts, or one prompt with "apply its updates without asking while we work on it". **Recommendation:** ask at the first enable and offer that trust there, limited to that workshop and lasting until it has been left for 30 minutes or the server restarts; a growth in declared surfaces always asks; a per-plugin "always trusted" setting later, if wanted.
4. **What does a long workshop keep when it outgrows the model's context?** Carrying on the previous run keeps every tool result, so a long session eventually doesn't fit. Example: after two hours of card work the request no longer fits a 200k window. Either the next request is put together again from the messages alone, so earlier tool results are gone but each message's steps are summed up in one line ("Created the card Mara Quill"), or workshops get the summaries RP chats use. **Recommendation:** the first now (simple and predictable); workshop summaries later, if it proves too forgetful. *Followed up in [WORKSHOP-CONTEXT.md](WORKSHOP-CONTEXT.md) §2 (proposed, built by workctx1): older tool results are left out first, then the fresh build, with workshop summaries allowed.*
5. **Git: the `git` binary in the image, or a JavaScript library (PLUGINS §10 Q5)?** The image has no git. Example: committing, logging, checking out a commit and diffing work with either; fetching and merging an upstream plugin is solid with the binary and weaker with isomorphic-git (no rename detection, slower on large repositories). **Recommendation:** isomorphic-git, pinned, for P1–P5 (nothing to install, the same outside Docker); revisit when registry installs with upstream merges are built.
