# Agentic rollouts (Phase 4)

**Built (chatsettings, 2026-11-06):** §6's user-facing modes are superseded and obsolete. This chat now has independent Context (shared), Tools and Cards settings and links to the existing reply picker and decision connections; `orchestration.mode` is removed. The internal `orchestrationModes` registry has one `default` planner. Implementation: ARCHITECTURE §16. Separate contexts remain unbuilt (CHARACTER-CONTEXT §1).

**Status**: Proposed, 2026-11-05 (job `phase4`). The design for PLAN Phase 4 and DESIGN §7.1–§7.6, with the Phase 4 parts of §4.1a and §4.2. Everything below is **[P]** unless it cites a **[D]** in DESIGN. It is a delta from two things: the build at master `12cf25b6` (ARCHITECTURE §3.7, §3.8, §6, §12, §15, §16), and reference-harness on branch `latest` (`9b385944`, 2026-10-29), whose agent core [the earlier reference notes](the earlier reference notes) describes. That reference was re-checked against `latest` on 2026-11-05. Its claims all still hold, the `factory.ts` line numbers have moved (the Agent is built at `src/agent/factory.ts:2495–2571`), and the mechanisms it leaves out are listed in §1.2. Built units are listed in §11; their sections become obsolete as they move to ARCHITECTURE.

**Built (2026-11-05):** U1, U3, U4, U5, U6, U9 and the server half of U2 (ARCHITECTURE §16, "Agent rollouts"): §2, §3, §4.2–§4.6 and §6 (but `per-character`) are obsolete as proposals, and §5.1's server side (steps, the `Steps` event, `GetRolloutSteps`) is built. The review added stop-mid-tool, interrupted-text, output-contract, cap and assembly-replay regressions and the in-memory path's scale coverage. Deltas from this text, as built: `search_chat` uses FTS only in forks without inserted messages (others read the path); `lookup_lore` reads the books the snapshot froze (`agentLore`) rather than resolving them at the position; `capture.ts` isn't its own module (the flush lives in `session.ts`); `ApplyRolloutEffects` is one call per tool call (`ApplyRolloutEffect`); `AddRolloutBranch` is part of `StartResumedVersion`; `NoteTargets` is plain functions (`agent/noteTargets.ts`) over the notes at the position, not a service; the effect sink is `ApplyRolloutEffect`'s `notes` writes plus state events (no `note.create`/`note.revise` keys: a new note is a library entity turned on by `note.activate`, a revision is bound by `note.binding`); `edit_card` covers card fields, not preset prompts. U10 (decision models: the engine, the `system-one` kind, the `lore` and `presence` points and their settings) is built too (ARCHITECTURE §16, "Decision models"): §7 is obsolete as a proposal, except the per-chat `decision.points` key, which isn't built. The permission controls are built too (phase4perm: a chat's "Model may change" in This chat, a card's in its Definition tab, `GetAgentPermissions`), and a note the agent wrote is listed (Notes, `list_notes`) only where its reply is shown, as §9's `note.create` intended, from the note's origin and the reply's own `note.activate` rather than a `note.create` key. Not yet: U1's Anthropic round trip, and `capture.ts` as its own module (the flush lives in `session.ts`).

**Built (phase4ui, 2026-11-05):** U7 without Resume (it waits for U6), and U8 without step edits and resume from a step (U6): the steps element, live and sticky, the header badge, the run inspector's tools and requests (`GetRunTranscript`), the Activity panel (`ListActivity`) and the Reply mode and Tools settings (`ListReplyModes`, `ReplyMode`/`AgentTools` cast changes) (ARCHITECTURE §16, "Agent rollouts", "In the client"). §5.1, §5.3 (but its step actions) and §5.4 are obsolete as proposals. Deltas from §5: the element is a `reasoningPanels` entry above the reasoning (not `messageVersions`, which is the version switcher); Activity reads the ledger by rollout and purpose rather than rollouts by kind, so judgments riding on a reply's rollout are listed; tools carry a user-facing `explanation` for the settings.

**Built (resumeui, 2026-11-12):** the rest of U7 and U8: Resume on a stopped, failed or interrupted agent reply, and §5.3's step actions (Edit and Resume from here in the run inspector, with the cut spans folded) (ARCHITECTURE §16, "Agent rollouts", "In the client"). §5.2 and §5.3 are obsolete as proposals. Deltas: Resume is a pinned message action beside Continue (`messageActions` entry `message.resume`), not an entry in `versionFailureActions`, so a stopped reply offers it as well as a failed one; the resumed version reads "resumed from #N" in the version picker; the version read gains `agent` (an agent reply, with or without steps), and `GetRunTranscript` gains each part's and result's `step` index and the `cut` spans, the fields the controls needed; an argument edit is checked against the frozen schema's type, required, properties, enum, const, items and anyOf before Resume is enabled; an unsent step edit is kept in the page only (the spec gives it no draft).

## 0. Summary

- **An agentic reply is still a reply.** It is a version made by a rollout, as every generation is (DATA-MODEL principle 7). The plain path stays as it is. An agentic mode swaps the registered `reply` strategy for one that runs a pi-agent-core loop. The loop's output goes through the same chunk pipeline, parsers, live rewrites and version persistence as a plain reply. That shared pipeline is the "one internal commit pipeline" of [D] §7.2.
- **The context is assembled once.** The registered assembler builds the request once, when the rollout starts, and the request is frozen into the rollout's snapshot, as it is today. Every request in the loop is that frozen prefix plus the rollout's own transcript. Notes and presence that a tool changes take effect from the next reply on, never mid-rollout. reference-harness works the same way.
- **The transcript is flushed** into `rollout_payloads.transcript_json` at each `turn_end` and `agent_end`, and on failure. The tool definitions are frozen into the snapshot, so the run inspector shows exactly what each request was, and a resume sends the same thing.
- **Resuming is invisible to the model** (§7.5 [D]). It strips the failed tail, applies the interruption policy, reseeds a fresh Agent and calls `continue()`. Because versions are frozen once they stop generating, a resume writes a **new version** of the same slot, with the stopped one as its source, as Continue does. The same mechanism resumes after a step has been edited in the run inspector.
- **Tools are a registered catalog**, each with an effect class: `read`, `chat_state` or `external` (§7.3). Chat-state tools write state events attached to the generating version (`origin: rollout`), so swiping reverses them. Each write is keyed by its tool call, so re-running a tool on resume never duplicates its effect.
- **Display:** steps stream live inside the version, expanded by default, and collapse when the message is complete, with a sticky per-user preference. Afterwards they sit inline as an "N steps" element. The header shows a step count and time badge. The existing request inspector becomes the run inspector, with the steps. An Activity panel lists the rollouts that produce no message.
- **Decision models** are an optional registered engine, off by default. Each decision point has a heuristic fallback (§7.6 [D]).
- **Orchestration modes** are a registry: `plain` (today's path, the default), `narrator` (one agent per turn with all cards) and `card-swap` (one agent; originally with the speaker's card at the tail, rotation only since 2026-11-06, DESIGN §5.2). `per-character` is sketched, not built (Phase 4 marks it optional). **Superseded as user-facing choices** (owner, 2026-11-06; DESIGN §7.1, CHARACTER-CONTEXT §1, proposed): the modes become four independent chat settings: context per speaker, tools, card layout, turn picking. `narrator` was tools on; `card-swap` was tools on plus a card layout, and card-swap becomes rotation of the speaker's card into the preset's definition positions, not the tail; `per-character` is separate contexts plus tools. The registry stays as the internal extension point; `orchestration.mode` is removed without a migration. **Built so far** (cardswap): card-swap rotation is the `cards.rotation` chat setting (with or without tools); the `card-swap` mode still sets it for its replies until the modes leave the UI.

## 1. Deltas from reference-harness and from the build

### 1.1 What the build already has

| Need | Already built | Delta |
|---|---|---|
| Rollout rows | `rollouts` (kind, status, parent, usage rollups, `fork_id`), `rollout_payloads` (snapshot frozen by trigger, `transcript_json`, `sent_context_json`), `rollout_branches` (`branch_no`, `fork_index`, `reason`, `messages_json`) in `db/baseline.ts` | Two columns on `rollouts` (§9). Transcript writes and branch rows get writer operations |
| One rollout per version | `ContextGenerator` → `StartRollout`/`FinishRollout`, ledger rows attributed to the rollout and version | Reused unchanged. The agent strategy runs inside the same acquire/release |
| Version-attached state | `state_events.version_id`; events count only while the fork shows their version (ARCHITECTURE §3.8 `StateEventsAt`) | Rollout effects use it, with `origin = 'rollout'` and `origin_ref = <rollout>:<toolCallId>` |
| Mode keys | `orchestration.mode`, `output.contract`, `rollout.continuity` in `@rp/shared/state.ts` (folded, unread) | Read by the mode resolver (§6) |
| Execution seams | `ExecutionRegistry`: `replyStrategies`, `replies`, `replyParsers`, `liveRewrites` (ARCHITECTURE §15 "Execution registries") | New registries: `rolloutTools`, `orchestrationModes`, `decisionPoints` |
| Tool loop precedent | The summarizer's eight-call loop, with its Chat Completions suffix conversion (`lcm/Summarizer.ts`) | That conversion is extracted into `agent/wire.ts` and shared |
| Exact inspection | `GetRunContext` reads the frozen snapshot, the sent capture and the per-attempt usage | Gains steps (§5.3) |

### 1.2 What reference-harness does, and what changes here

| reference-harness (`latest`) | Here | Why |
|---|---|---|
| pi-agent-core/pi-ai **0.84.2**, a fresh `Agent` per session, with hooks `transformContext` (frozen base plus live messages), `convertToLlm`, `streamFn`, `onPayload`, `beforeToolCall`, `shouldStopAfterTurn` and `prepareNextTurnWithContext`; turn caps by `subscribe('turn_end')` + `abort()` | pi-agent-core **1.0.3**, matching our pi-ai 1.0.3, pinned exactly. In 1.x, the prompt and tools travel in transcript system messages, and `finishTurn` and `prepareRequest` replace `shouldStopAfterTurn`. Our `streamFn` ignores pi's transcript prefix and sends the frozen assembled request (§3.2) | We assemble with ST-compatible exactness (names, roles, breakpoints, Chat Completions `payload`). pi's own conversion would lose that |
| Contract: explicit `send_message(message, is_reply, final)` only. Bare text is never delivered; `no_reply`; forced-completion nudges; multiple sends per session | Both contracts (§7.2 [D]): **final text** (the last assistant turn without tool calls) and **`send_message(message, present?)`**, which ends the rollout. No `final`, `is_reply` or `no_reply`: RP makes exactly one message a turn ([D]). No delivery step, since the timeline is our own graph | |
| Snapshot written once (an upsert); transcript is all of `agent.state.messages`, flushed on `turn_end`/`agent_end`/`flushNow` | Same flush points and the same "whole state, not the event payload" rule. The snapshot is frozen by the existing trigger, and **tool definitions are part of it** | reference-harness recomputes tool definitions for the inspector and on resume, so neither is exact (reference §3) |
| Recovery: strip trailing `error`/`aborted` assistant messages, accept a user/toolResult tail, `continue()`. A clean tool-call tail is rejected. Partial text is dropped | Same strip, plus DESIGN §7.5's three interruption policies (§4.2): a dangling tool call is **re-run** (each tool is idempotent per call, §4.3), a partial tool call is resampled, and partial text **continues through prefill** where the model supports it | DESIGN §7.5 [P]; per-call receipts close reference-harness's crash gap (reference §10) |
| Resume reuses the same session row; startup parks sessions as `interrupted`; console Resume | The resume is a new rollout (`parent_rollout_id`) and a new version. Startup's `InterruptRollouts` already parks rollouts | Versions freeze when they stop (ARCHITECTURE §3.7) |
| Step editing: none. Sibling edit and late-input redo are automatic forks only | **Edit a step, then resume** (§4.4). The discarded tail goes to `rollout_branches` (reason `edit`) | DESIGN §7.5 [P] |
| Effect classes `redo_safe`/`repeatable`/`undoable`/`irreversible`; memory and card writes mutate files (irreversible) | `read` / `chat_state` / `external`. Chat state is version-attached state events, so it needs no compensation and no undo | DESIGN §7.3 [P] |
| Request retry buffers whole attempts and resamples mid-stream failures; repetition guard; stale-thinking drop; tool-result budget; truncated tool calls rewritten to `length` | The provider layer keeps its retry before the first token (PROVIDERS §7.2). A mid-turn failure fails the rollout, and Resume continues it invisibly. We port the **tool-result budget** (per-result and per-turn caps, with markers) and **truncated tool calls → length**. Repetition guard and stale-thinking stay out | Automatic mid-stream resampling would need a reset event on streamed body text. Left for later (§10) |
| Decision models: System-One `{model, state, questions}`, points routing/records/checks/audit/late_addition/implicit_reply/memory, `DecisionEngine.evaluate(point, input, ctx)`, a heuristic fallback per point, every billed attempt accounted | The same engine shape and the same wire body, with RP points `presence` and `lore` (§7) and the existing refusal judge kept as it is. Every call is opt-in per connection | Provider-send consent (owner rule) |
| Console: `LiveRollout`/`Rollout` views, SSE `rollout_seed`, tentative deltas | Steps inline in the version (§7.4 [D]), live over the chat's existing subscription, with a `Steps` seed on subscribe | |

reference-harness mechanisms not taken, and why: dynamic tool loading (`load_skill`, `tool_search`) for RP, since RP toolsets are small and stable, which keeps the cache intact (workshops take it: [TOOL-LOADING.md](TOOL-LOADING.md)); session records, follow-up folding and session claims, which are chat-platform concerns; image cap, since the provider boundary already caps images (ARCHITECTURE §16 "Images").

## 2. Timeline and rollouts; the commit pipeline

**[D] §7.1:** the timeline is independent of rollouts. Here the timeline is the message graph. A rollout forks from it at the generating slot, reads the assembled view at that position in that fork (`GenerationRequest.forkId`), produces one version, and ends.

- **Fork per turn** is the RP default (`rollout.continuity = fork`). Each generation, swipe or regenerate is a new rollout and so a new version (§7.3 [D]). `resume_previous` is Workshop's (§7.7, Phase 6). This design reserves it: the resolver treats it as `fork` in RP chats.
- **Strategy selection.** `ContextGenerator` asks the chat's mode (§6), resolved at the generating slot from `orchestration.mode` (absent: `plain`), for its reply strategy id. `plain` keeps `reply`, and `narrator` and `card-swap` use `agent`. A mode's chosen strategy that isn't registered fails the generation as `unavailable`, as a missing `reply` does today.
- **Continue stays plain.** Continue extends text through a prefill and has no turn to run tools in, so in an agentic chat it uses `reply` with the agent mode's assembly (§6). Impersonation (Write for) is plain too.
- **The commit pipeline (both contracts).** The `agent` strategy turns the loop into the same `Stream<GenerationChunk>` the plain strategy yields: the message text (from the final turn, or `send_message`'s complete, validated `message` argument when the tool executes) and its reasoning, plus a new **step** chunk (§5.1). The chunks then go through the registered `replyParsers` (reply sections, continue-join), `liveRewrites`, `Generations` (text, reasoning, sections, the refusal mark) and the finish rewrites, exactly as a plain reply's do. Hooks and checks therefore apply to both contracts identically, and to plain replies (§7.2 [D]). A check that refuses fails the version, as today.
- **One message per turn** (§7.2 [D]). `send_message` ends the loop through the tool result's `terminate` flag. A second `send_message` in the same batch gets a tool error and is ignored. Under `final_text`, a turn without tool calls ends the loop, and its text is the message. Under `both` (the default for agent modes), whichever comes first. Text the model writes in a turn that also calls tools is **intermediate output**: a step, never the message (§7.2 [D]: intermediate blocks aren't real messages).
- **Turn cap.** A mode sets a cap (default 12 requests). At the cap, the request omits the tools and adds an `rpHarness` user message, "Write the reply now." The local tool hook also blocks execution at the cap, including calls a provider returns anyway. This instruction takes precedence over the send nudge; a cap of one includes it in the first request. An empty final message fails the version as `empty`, like a plain empty reply.

## 3. pi-agent-core sessions

### 3.1 Construction (`agent/session.ts`)

Each agentic generation builds one `Agent` (pi-agent-core 1.0.3) inside the generation's scope:

- `initialState`: `model` is a pi `Model` built from the generation's `ModelInput`. pi needs it only for identity, since our `streamFn` sends the request. `thinkingLevel` comes from the model settings (`reasoning_effort`, as `providerRequest` maps it). `tools` are the mode's toolset as `AgentTool`s (§4.1). The system prompt is empty: the frozen prefix carries the system text.
- `messages`: `[kickoff]`, a custom message (`role: "rpRequest"`, declared through `CustomAgentMessages` augmentation) that stands for the frozen request. On resume it is the stored transcript instead (§4.2).
- `convertToLlm` maps `rpRequest` to a placeholder user message and passes the standard messages through. `harness` messages become user messages.
- `streamFn` (§3.2) is the only path to a provider.
- `beforeToolCall` enforces the effect-class gate (§4.1), the per-call receipt lookup (§4.3) and the turn cap. `afterToolCall` applies the tool-result budget.
- `finishTurn` returns `end` once a `send_message` succeeded, or when a final-text turn ended without tool calls.
- `toolExecution: "sequential"`, so effects apply in the model's order and receipts are simple.
- `subscribe`: `turn_end` and `agent_end` flush the transcript (§3.3). `message_update`, `tool_execution_*` and `message_end` drive the step chunks (§5.1).
- The generation's fiber interruption (Stop, a server stop) calls `agent.abort()` and waits for `waitForIdle()` before the release closes the rollout.

### 3.2 The request: frozen prefix plus suffix (`agent/wire.ts`)

The assembler output for the version (`Generation.request`) maps through the existing `providerRequest` once, giving `{context, payload, breakpoints, …}`. That is the frozen prefix. For each loop request, `streamFn(model, transcript)`:

1. Takes the live suffix: the transcript messages after the `rpRequest` kickoff (assistant turns with their tool calls, tool results, harness messages), dropping pi's leading system message.
2. Builds the provider context: for pi-converted APIs (Anthropic, Google, Responses), `context.messages = [...prefix.context.messages, ...suffix]` with `context.tools` from the frozen tool definitions. For Chat Completions, the exact `payload.messages` gains the suffix in the wire's JSON form (assistant `tool_calls`, `role: "tool"` results). This is the summarizer's conversion, moved here and shared by both. DeepSeek thinking models get `reasoning_content` on assistant tool-call turns, which their API requires.
3. Calls `Providers.stream` with the generation's attribution (`purpose: generation`, chat, rollout, version), so the ledger, the retry before the first token, proxies, `onPayload` transforms, image hydration and the inspector capture (`RecordSentContext`, now the latest request of the rollout) all apply.
4. **Breakpoints:** the prefix's breakpoints are kept. One more, the last suffix message, is added when the model's breakpoints are `explicit` and a slot is free, so each loop request reads the previous one's cache. This is reference-harness's "tail checkpoint". The Anthropic limit of four counts the existing ones first.
5. Adapts `ProviderEvent`s to pi-ai's `AssistantMessageEventStream`: `start`, `text_*`, `thinking_*`, `toolcall_*` as they arrive, then `done` with the provider's final message. A `ProviderError` becomes a final message with `stopReason: "error"` and the error text, as the `StreamFn` contract requires. The typed error is kept beside it for the version's failure class.

**Prefill and agents.** A turn that may call tools can't be prefilled. In agent modes the assembler drops the preset prefill and records the existing `prefill_dropped` issue ("not sent: the reply mode uses tools"). The interrupted-text continuation of §4.2 is the one exception.

**Agent instructions** (DESIGN §7.1 [D]: prompting for tool use is designed as carefully as the tool). Each tool's `description` holds its own usage guidance. A mode adds one text, `agentTurn` (default in §4.5), appended to the end-of-request instruction by a registered assembler stage, `agent-instructions`, after `end-of-request`. It stays out of the cached prefix: tools change no cached bytes beyond their definitions, which are stable per chat and mode. The inspector names its piece "Agent instructions".

### 3.3 Persistence (`agent/capture.ts`)

- **Snapshot.** `StartRollout` already writes the frozen snapshot. Agent rollouts add `snapshot.agent = { mode, contract, turnCap, tools: [{name, description, parameters, effect}], instructions }` before freezing. The frozen-snapshot trigger makes it immutable.
- **Transcript.** A new writer operation, `SaveRolloutTranscript { userId, rolloutId, transcript, steps }`, sets `rollout_payloads.transcript_json` and `rollouts.step_count`. Image bytes become media references (`{type: "image", mediaId}`), as the snapshot stores them. Writes go through one promise chain per rollout, after `StartRollout`, so a later flush never overtakes an earlier one (reference-harness's ordering). A failed write is logged and never fails the generation.
- **When.** At `turn_end`, at `agent_end`, and in the release before `FinishRollout`, so a stop or handled failure flushes too. **Built review correction (2026-11-05):** also await a flush before executing any allowed tool, blocking the tool if saving fails. A process kill during an incomplete provider request can lose that turn, but an executed effect always has a durable pending call ID for receipt replay. The source is always `agent.state.messages` as a whole, never the event's run-scoped payload (reference-harness `session-capture.test.ts:602–689`).
- **Discarded spans.** `AddRolloutBranch { rolloutId, forkIndex, reason, messages }` (reason `edit`, `resume` or `interrupted`) writes a `rollout_branches` row with the next `branch_no`. Used by §4.2 and §4.4.

## 4. Tools, effects, resume and step edits

### 4.1 The tool catalog (`agent/tools.ts`, registry `rolloutTools`)

A tool entry:

```ts
interface RolloutTool<A> {
  readonly id: string                 // the tool name the model sees
  readonly label: string              // short, user-facing: "Searched the chat"
  readonly effect: "read" | "chat_state" | "external"
  readonly description: string        // model-facing, with its usage guidance
  readonly parameters: TSchema        // TypeBox, as pi-agent-core validates
  readonly summarize?: (args: A) => string   // the step's one-line title: "“lighthouse”"
  readonly execute: (ctx: ToolContext, args: A) => Effect<ToolOutput, ToolFailure>
}
interface ToolContext {
  readonly userId; chatId; forkId; slotId; versionId; rolloutId; toolCallId
  readonly position: { leafSlotId: SlotId | null }  // the generating slot's parent: nothing at or after it is visible
  readonly reader: Reader["Service"]
  readonly effects: EffectSink        // chat_state only; §4.3
  readonly noteTargets: NoteTargets   // §4.6
}
```

- Tools run on the main thread and reach storage only through reader and writer operations (CLAUDE.md: no SQLite on the main thread). Every read is owner-scoped and **causal**: nothing at or after the generating slot (owner rule: a generated message sees only what precedes it).
- **Effect classes (§7.3 [P]).** `read` tools are freely re-run. `chat_state` tools write version-attached state events. `external` tools (library edits, settings, plugins) are never offered in RP turns: the mode resolver filters them out, and `beforeToolCall` blocks one that slips through anyway. In Phase 6 they get approval prompts and a warning before regenerating.
- **Toolset.** A mode lists tool ids. The user narrows the list per chat (`agent.tools` state key, §9). The snapshot freezes the definitions actually offered.
- **Results.** Text only, budgeted: 4,000 tokens a result and 12,000 a turn by default, each with a marker telling the model how to narrow the call (reference-harness `tool-result-budget.ts`). A thrown or `isError` result is a tool error the model can correct. It never ends the rollout.

### 4.2 Resume (DESIGN §7.5)

`ResumeVersion { versionId }` (RPC and command) is offered on a generated version whose agent rollout ended `stopped`, `failed` or `interrupted` with a transcript:

1. Loads the rollout's snapshot and transcript (reader `RolloutMaterial`).
2. **Strips** trailing assistant messages whose `stopReason` is `error` or `aborted` (reference-harness `stripFailedTail`). It keeps the stripped partial turn aside.
3. **Applies the interruption policy** to the tail (§7.5 [P]):
   - *A tool call without its result* (a crash after the call was recorded): the call is kept and **re-run**. Its receipt (§4.3) returns the stored result if the effect was already written, so it is never applied twice.
   - *Cut off inside a tool call* (the stripped turn's last block is a partial `toolCall`): discarded, and the model resamples from the previous tail.
   - *Cut off inside text*, with no tool call in the stripped turn: the partial text is kept as a **continuation prefill** if the model's prefill capability is `assistant` (ARCHITECTURE §15 "Continue"). The first resumed request has no tools, ends with that text as a trailing assistant message, and its output is appended. Otherwise the text is discarded and resampled.
   - Anything else (an empty or corrupt transcript): a **fresh** run from the same snapshot (reference-harness's `fresh`).
4. Creates the new version (`StartResumedVersion`, one writer transaction): a generated version in the same slot, selected in the fork, with `source_version_id` = the stopped one, the same speaker, the source's direction, and the new origin `resumed`. It also creates its rollout with `parent_rollout_id`, a copy of the snapshot (frozen again), the kept transcript, and the source version's rollout state events copied onto the new version for every kept tool call, keeping their `origin_ref`. It records the stripped tail as a `rollout_branches` row (reason `resume`) on the new rollout.
5. Reseeds a fresh `Agent` with the kept transcript and calls `continue()`. No user turn is added: the model sees the same prefix and the same transcript, so it can't tell (§7.5 [D]).

The source version is unchanged and stays selectable, like Continue's. Its effects apply only while it is shown (§3.4). Concurrent resumes of one version are refused (`AlreadyResuming`), as Continue refuses a version still generating.

### 4.3 Chat-state effects and receipts (`agent/effects.ts`)

- An `EffectSink` gives tools typed effects: `note.create`, `note.revise`, `note.switch`, `presence.set`, `card.replace` (§4.6). Each `chat_state` tool call commits its effects in **one writer transaction**, `ApplyRolloutEffects { rolloutId, versionId, toolCallId, effects, result }`. That transaction writes any new note entities and revisions (`origin: generation`, `origin_ref` = rollout) and the state events attached to the version (`origin: rollout`, `origin_ref: <rolloutId>:<toolCallId>`), and stores the tool's result text in a receipt row (`rollout_receipts`, §9). Nothing outside the database happens inside it.
- **Idempotence.** Before executing a `chat_state` call, the tool context reads the receipt for `(rolloutId, toolCallId)`. If one exists, the stored result is returned without running the tool again. A resume copies the source rollout's receipts to the new rollout.
- **Visibility.** The effects are written while the version generates. The version is selected, so the Notes panel and cast reflect them live, through the existing `State` notice. Their events apply only while their version is shown, so a swipe, a failed version left unselected, or an earlier branch never sees them (§4.1a [D]: changes belong to the swipe).
- **Mid-rollout reads.** Tools read state at the generating position, so a note the agent made earlier in the same rollout shows to `list_notes` (the read includes the version's own events). The **context** doesn't change mid-rollout (§0). The new text reaches the model on the next reply.
- **Permission (§4.1a [D]: the user decides what the LLM may change).** The agent may edit notes with `agent_editable` on, card fields named in the card's `agent_editable_fields` (§9), and notes it created itself in this chat. A chat overrides any of these with `agent.permission { target, on }` (§9). Everything is off by default ([P] §4.1a). A refused edit is a tool error naming what isn't editable, so the model can carry on.

### 4.4 Editing a step, then resuming

From the run inspector (§5.3), each step offers **Edit** (the user's text replaces it) and **Resume from here**:

- *Editing an intermediate text or thinking step:* that assistant message's block gets the new text. The transcript is cut after that message's tool results, if any, and resumes. A tool call in the same message is kept with its result.
- *Editing a tool call's arguments:* the call's result and everything after it is cut. The call is re-run with the new arguments, as a dangling call is (§4.2), under a **new tool call id**, so the receipt can't return the old result.
- *Editing a tool result:* the result text is replaced and the transcript is cut after it.
- *Resume from here* on an unedited step cuts after it and resumes, the way "swipe from here" would.

Each produces a new version exactly as §4.2 does, with the cut tail in `rollout_branches` (reason `edit`). Effects of tool calls in the cut tail are not copied (§4.2 step 4), so they vanish with the tail. Editing the final message itself is the existing message edit, not a step edit.

### 4.5 The RP tools

All of these are causal (§4.1) and registered. Each description below is the guidance the model sees, abbreviated here. It names when to use the tool and when not to.

| Tool | Class | Arguments → result | Delta |
|---|---|---|---|
| `expand_summary` | read | `messages` ("120–180", the range a summary covers), `depth?` (1), `max_tokens?` (2,000) → the summary's children in order (level 1: its messages, as `Message N, <speaker>: …`). It stops at the token cap and reports how many were left out | reference-harness's, over our lineage in the viewed fork (`db/lcmFork.ts`): revisions and replacements as the fork shows them. Each summary in the context already names its range (`<summary level from to>`), so no labels are added [P, 2026-11-05: `summaryLabels` dropped] |
| `search_summaries` | read | `query`, `level?`, `limit?` (5) → `[messages covered, level, excerpt]` | FTS on `summary_revisions_fts`, limited to summaries live in the fork that cover only slots before the position |
| `search_chat` | read | `query`, `speaker?`, `limit?` (8), `before_message?` → `[Message N, speaker, excerpt]`, newest first | FTS on `versions_fts`, joined to the fork's **display path** above the position (only the shown version of each slot). reference-harness's `search_messages` without its platform filters |
| `read_messages` | read | `from` (Message N), `count?` (5, max 20) → the messages verbatim | Pairs with search: an excerpt, then the passage |
| `lookup_lore` | read | `query` or `entry` → matching entries of the lorebooks active at the position (attached, embedded, global) by key, title or text, with content | It reads only. Admitted entries and their timing are still the assembler's (`lore_activations`). reference-harness has no lorebook engine |
| `list_notes` | read | → the chat's notes and the cast's card notes at the position: title, owner, placement, on/off, editable | |
| `write_note` | chat_state | `title`, `content`, `placement?` (tail), `for?` (a character) → a new chat note, on from this message | A new chat-owned note entity, plus `note.create` and `note.activate` attached to the version |
| `edit_note` | chat_state | `note`, `find`, `replace` (one exact match) or `content` → a new revision bound from this message | `note.binding` attached to the version. Surgical by default |
| `switch_note` | chat_state | `note`, `on` | `note.activate`/`note.deactivate` attached |
| `set_presence` | chat_state | `character`, `present` → `presence.set` attached | The same event Mute writes (DESIGN §3.5: muting and presence are one thing) |
| `edit_card` | chat_state | `character`, `field` (`description`, `personality`, `scenario`, …), `find`, `replace`, `wrap?` → the owner's surgical edit (§4.6) | |
| `send_message` | (contract) | `message`, `present?` (names) → ends the rollout | Offered when the contract is `send_message` or `both`. `present` writes presence events; a mode can make it required (§3.5 [D]) |

The `agentTurn` default text: "You may use the tools before writing. Look things up only when the story needs a detail you don't have. Record lasting changes (an outfit, an injury, where someone is) with the note tools when they happen. Then write {{speaker}}'s next message." The mode's config can replace it, and the preset can override it through the `agentTurn` prompt identifier outside the order, as `groupNudge` works (ARCHITECTURE §15 "End of request").

### 4.6 Card changes become notes (§4.2 [D], owner 2026-11-03)

`edit_card(character, field, find, replace, wrap?)` never edits the card. Per §4.2's agent rule, through the **note-overrides mechanism** (owned by job `noteoverrides`, §8):

1. The field must be agent-editable (§4.3). `find` must occur once in the field's current text in this chat (the card's text, or an existing replacement note's, if one already targets the field here).
2. **The replacement note.** One chat note replaces the field (target: that character's field in this chat, §4.2 [P]). Its text is the field with the `find` passage removed. If such a note already exists on the path, it gets a new revision instead. The text stays where the field was, so the top of the context changes once per newly modified field, and the cache breaks once (§4.2 [D]).
3. **The tail note.** One chat note at the tail (placement `tail`, role system) holds the edited passage, `replace`. `wrap` (default "[{{char}}'s current {{field}}: {{text}}]") gives it context. Later edits of the same passage revise this note, which is cheap at the tail.
4. Both notes' creation, revisions and activation are effects of this tool call (§4.3), attached to the version, so a swipe undoes the costume change.

The tool reaches the mechanism only through a `NoteTargets` service:

```ts
interface NoteTargets {
  /** The note on the fork's path that replaces this target at the position, if any. */
  readonly replacing: (at: Position, target: NoteTarget) => Effect<NoteRef | null>
  /** The target's current text at the position (the card's, or its replacing note's). */
  readonly currentText: (at: Position, target: NoteTarget) => Effect<string>
  /** Effects that create or revise a note that replaces the target. */
  readonly replaceEffects: (target: NoteTarget, text: string) => ReadonlyArray<RolloutEffect>
}
type NoteTarget = { card: { place: EntityId; field: string } } | { prompt: { identifier: string } }
```

Until `noteoverrides` merges, the phase4 build registers an unavailable `NoteTargets`: `edit_card` reports "Card changes aren't available yet" and isn't offered. `noteoverrides` supplies the implementation (§8).

## 5. Display

### 5.1 Steps while generating

- **Data.** A step is `{ kind: "thinking" | "text", text } | { kind: "tool", id, tool, label, title, args, status: "running" | "done" | "error", result?, effect }` (`@rp/shared/agentApi.ts`, `RolloutStep`). The `agent` strategy emits `{ step: { index, step } }` chunks. `Generations` keeps the list on the running entry and publishes `Step { versionId, index, step }` events on the chat hub, coalesced as text deltas are. A subscriber that joins mid-run gets `Steps { versionId, steps }` with the version (reference-harness's `rollout_seed`).
- **What goes where.** The final turn's reasoning goes to the version's existing Reasoning panel, and its text to the body. Earlier turns' thinking and text are steps. Text streams into the body as it arrives. When the same turn then emits a tool call, that text moves into a `text` step and the body empties. In RP, models rarely write before calling a tool, so the move is rare.
- **The element** (`features/chat/agent/Steps.tsx`, registered in the `messageVersions` slot above the body, below Reasoning): while generating, a box titled "Working…" listing the steps in order. A tool step is one row (icon by effect class, the label, the title, then a spinner, a check or a cross), with its result folded under it. A text or thinking step is a short folded excerpt. **[D] §7.4:** open by default while streaming, folded when the message is complete. Folding or unfolding during a run becomes the sticky preference: user pref `steps` (`expanded` | `collapsed`), as `reasoning` works (`Reasoning.tsx`).
- **After the run:** the same element, folded, labelled **"N steps"** (N = tool calls) with the time ("3 steps · 14 s"), inline in the version (§7.4 [D]). Opening it fetches the steps (`GetRolloutSteps { versionId }`, which projects the transcript). A version with no tool calls shows no element.
- **Header badge** (§7.4 [P]): the same "3 steps · 14 s" as a small badge in the message header's meta row, only for versions whose rollout has `step_count > 0`. It comes from the version read (`Version.steps: { count, ms }`, a join already made for `context`). Clicking it opens the element.
- **Owner UI rules.** Every control gets a hover explanation: "Click to show the steps behind this reply" / "Click to hide the steps", "Open this reply's run in the inspector". The step rows are text, so the browser's own context menu stays. Nothing is reachable only by key.

### 5.2 Resume and failures

A failed or stopped agentic version keeps its steps (folded, with a cross on the failing one) and gains **Resume** in the existing failure actions slot (`versionFailureActions`), with the hover "Carries on this reply from where it stopped". Beside Regenerate, it stays in place, disabled with a reason when there is no transcript ("This reply stopped before its first step"). The resumed version appears as a new version, selected, with "Resumed from version N" in its details. That is how Continue's source shows (DESIGN §3.1).

### 5.3 The run inspector

The request inspector (`ContextPage.tsx`, `GetRunContext`) is the run inspector (§7.4 [D]). For an agent rollout it adds:

- **Tools offered:** after the context's blocks, one titled box per frozen tool definition: name, description, parameters as JSON.
- **Steps:** after the context, one block per loop request, numbered "Request 2", "Request 3" and so on, each with the model's turn (thinking, text, tool calls with arguments) and the tool results, verbatim, using the inspector's existing labelled boxes. Under each request: its usage from its ledger attempt. Harness messages are labelled "Added by the app". Discarded spans (`rollout_branches`) show folded, labelled by reason ("Cut when this step was edited").
- **Step actions:** each step has **Edit** and **Resume from here** (§4.4), with hovers "Change this step, then carry on from it as a new version" and "Carry on from this step as a new version". Editing opens the step's text in the shared code editor. Arguments are JSON, checked against the tool's frozen schema before **Resume** is enabled.

### 5.4 The Activity panel

**[P] §7.4:** a chat panel, **Activity** (registered in the chat panels registry beside History), lists the chat's rollouts that produced no message: summaries, condensations, decision calls, refusal judgments. It reads `ListActivity { chatId, before?, limit }` (rollouts by `rollouts_chat`, kind ≠ `generation`, 50 a page). Each row shows kind, status, model, time, tokens (input, cached, output) and cost, and links to its inspector. Agentic generations are reached from their message, not listed. The LCM panel's job rows stay; Activity links to them.

## 6. Orchestration modes (`agent/modes.ts`, registry `orchestrationModes`)

**[D] §7.1:** modes are configurable, there will be more than two, and agentic and plain chatting share one representation.

```ts
interface OrchestrationMode {
  readonly id: string
  readonly label: string; readonly description: string   // user-facing
  /** Who runs this turn. Built-ins: the planned speaker, one agent. */
  readonly agents: (turn: TurnInput) => ReadonlyArray<AgentPlan>
}
interface AgentPlan {
  readonly strategy: string                   // a replyStrategies id: "reply" | "agent"
  readonly assembly: AssemblyOptions          // what it sees: card layout, presence-limited view, extra stages
  readonly tools: ReadonlyArray<string>       // rolloutTools ids
  readonly contract: "final_text" | "send_message" | "both"
  readonly turnCap: number
  readonly instructions?: string              // agentTurn text
}
```

- `ContextGenerator` resolves the mode at the generating slot (`orchestration.mode`, its `config`, and `output.contract` overriding the plan's contract), then passes `AgentPlan.assembly` into `AssembleContext` and runs the plan's strategy. RP plans exactly one agent a turn (one message a turn, [D]). A plan list longer than one is reserved for later modes, and the resolver refuses it with `unavailable` until a mode needs it.
- **Built-ins:**
  - `plain` (default): strategy `reply`, no tools. Today's behaviour, byte for byte.
  - `narrator`: strategy `agent`, every card loaded in the chat's card layout (`concat`), tools `expand_summary`, `search_summaries`, `search_chat`, `read_messages`, `lookup_lore`, `list_notes`, `write_note`, `edit_note`, `switch_note`, `set_presence`, `edit_card`, contract `both`. "One agent per turn with all cards loaded (reference-harness's way, the most cache-friendly)" (§7.1 [D]).
  - `card-swap`: as `narrator`, with only the speaker's card sent, where the preset puts cards (DESIGN §5.2 [D] 2026-11-06; it was the speaker's card at the tail before).
  - `per-character` (optional this phase, **not built**): each character its own agent, with its own system prompt and only its own card, seeing history only where it was present. That needs presence-cut summaries (§7.1 [P]) and a presence-limited path read, and reuses everything else here. When built, `agents()` returns the speaker's agent with `assembly.view = { presentFor: speaker }`.
- **Superseded (2026-11-06, see the note at the top):** the built-ins below are no longer user-facing; This chat shows the four settings of CHARACTER-CONTEXT §1, and one internal `default` entry plans replies from them.
- **Where it's chosen:** chat settings (`chatSettingSections` slot), a **Reply mode** select with each mode's description beside it, written as a branch-owned `orchestration.mode` event. A mode is per chat and follows the branch. Switching it changes the next reply only. The Tools list under it (checkboxes, each tool's label and a one-line explanation) writes `agent.tools`.
- A plugin registers a mode the same way: a new id, or a replacement for a built-in.

## 7. Decision models (`decision/engine.ts`, registry `decisionPoints`)

**[D] §7.6:** integrated as in reference-harness, never mandatory, with a heuristic fallback at each point.

- **Engine.** `DecisionEngine.evaluate(point, input, ctx) → { value, source: "model" | "heuristic", reason? }`, as reference-harness's `registry.ts:282`. A point declares `questions(input)`, `state(input)` (a token budget), `resolve(answers)`, `fallback(input)` and a user-facing `description`. A disabled point, a timeout (10 s), a failed or malformed answer, or confidence below the point's threshold returns `fallback(input)`.
- **The model.** A provider kind `system-one` (registered in the provider registry) with reference-harness's wire body `{ model, state, questions }` and typed answers `choice` / `score` / `noul`. A user adds it as a connection like any other. **Nothing is sent unless the user enables a point on that connection** (owner rule: provider sends are opt-in per connection). Each call is a rollout of kind `decision` with its ledger row, so cost shows in Activity (§5.4).
- **RP points:**
  - `presence`: after a reply completes, "is each cast character still in the scene?" over the last two messages and the cast. The result writes `presence.set` events attached to the reply's version (origin `rollout`). Fallback: no change. Manual Mute and the tool are unaffected.
  - `next` ("Who replies next", DESIGN §2.3): before a reply whose speaker Auto picked is written, one `choice` over the present characters but the latest speaker, over the last 6 messages; the pick replaces the generating version's speaker (`PickSpeaker`) and is recorded on it. Fallback: Auto's pick. Built (nextspeaker; ARCHITECTURE §12).
  - `lore`: before assembly, for each lorebook entry the keywords left out but whose `decision_hint` is set, "does this entry matter for the next message?" over the recent messages. Admitted ids go into `AssembleContext` as `decisions.lore` and are frozen into the snapshot, so a rebuild is exact. Fallback: the keyword activation alone (today's behaviour).
- **Settings:** under the connection, a Decisions section with a switch per point and its threshold. Per chat, `decision.points` (§9) can turn points off.
- The existing refusal judge (`decision/RefusalJudge.ts`) keeps its own model choice. It is a judge model, not a System-One point.

## 8. Interfaces with parallel jobs

- **`noteoverrides`** (owns the assembler's note-replacement stage, the note document's target field, and the editor UI). Phase 4 depends on three things from it: a note can name a target (`NoteTarget`, §4.6) and replaces that prompt or card field in assembly; replacement is resolved per fork at a position; and only one note per target, enforced on write. Phase 4 supplies `NoteTargets` (§4.6) as a service interface with an unavailable default. `noteoverrides` provides the implementation, or the integrating unit (U9) writes it against `noteoverrides`' schema. Agent-written notes are ordinary chat notes, so the editors show and link them like any other.
- **`chatmerge`** (merged sections in context). Agents read context only through `AssembleContext`, so merged sections reach agents with no agent-side change. The read tools (`search_chat`, `read_messages`) use the fork's display path read (`db/displayPath.ts`). If `chatmerge` adds merged slots to that path, the tools see them. If it adds them only in assembly, `search_chat` misses them until it reads the same source. That is a follow-up for whichever unit merges second.
- **`workbench`** (client frames and tabs). The run inspector stays a route (`/chat/:id/context/:version`), so it opens as a frame tab like any link.

## 9. Schema and operations

`db/baseline.ts` (SCHEMA RULE: baseline only, no migration; **BASELINE CHANGED** when U1 lands):

- `rollouts`: `+ step_count INTEGER NOT NULL DEFAULT 0` (tool calls so far, for the badge), `+ mode TEXT` (the orchestration mode id, null for plain and non-generation rollouts).
- `rollout_receipts (rollout_id TEXT REFERENCES rollouts(id) ON DELETE CASCADE, tool_call_id TEXT, result_json TEXT CHECK (json_valid(result_json)), created_at INTEGER, PRIMARY KEY (rollout_id, tool_call_id)) STRICT, WITHOUT ROWID`.
- `rollout_branches.reason` stays free text: `edit`, `resume`, `interrupted`.
- The version origins (`VersionOrigin`) gain `resumed`.

State keys (`@rp/shared/state.ts`, registered as built-ins with their id declarations):
- `note.create { note }`: marks a chat note as created at this version. A chat note with a creation event is listed only where that event applies, so a note made on an unselected swipe isn't shown.
- `agent.tools { tools: string[] }` (branch-owned).
- `agent.permission { target: { note } | { card, field }, on }`.
- `decision.points { off: string[] }` (branch-owned).

Card document: `agent_editable_fields?: string[]`, protected like `agent_editable` (`withoutGrantedAgentEdits`): set only by the user, never by import or merge.

Operations (`db/ops.ts`):
- Writer: `SaveRolloutTranscript`, `AddRolloutBranch`, `ApplyRolloutEffects`, `StartResumedVersion`. `StartRollout` gains `mode`.
- Reader: `RolloutMaterial`, `RolloutSteps` (transcript → steps), `ToolReceipt`, `SearchChat`, `ReadMessages`, `SearchSummaries`, `ExpandSummary`, `LookupLore`, `ListActivity`.

## 10. Left for later

- Automatic mid-stream resampling of a broken turn (reference-harness Layer 1), which needs a body-reset chunk. Until then, a broken turn fails and Resume continues it.
- The `per-character` mode, with presence-cut summaries (§6).
- Per-agent private state (notes, memories) hidden from other agents (§7.1 [D], marked later).
- Workshop's `resume_previous` continuity and external tools with approval (Phase 6).

## 11. Build units

Each unit is sized for one agent session, ships with its tests, moves its text into ARCHITECTURE and marks its sections here obsolete.

| # | Unit | Depends on | Files | Tests |
|---|---|---|---|---|
| U1 | **Agent core**: pi-agent-core 1.0.3, `agent/session.ts`, `agent/wire.ts` (the summarizer's suffix conversion moved and shared), `agent/capture.ts`, the `agent` reply strategy with the final-text contract, the `rolloutTools` registry with effect classes, schema (`step_count`, `mode`, `rollout_receipts`), `SaveRolloutTranscript` | — | `server/src/agent/*`, `execution.ts`, `chat/ContextGenerator.ts`, `db/{baseline,ops,generationWrites}.ts`, `lcm/Summarizer.ts` | `test/agentRollout.test.ts`: an OpenAI-compatible mock that calls a test tool and then answers. The version text is the final turn, two ledger rows, the transcript flushed with both turns, the snapshot frozen with its tools, a stop mid-tool leaves the rollout `stopped` with a flushed transcript, the exact Chat Completions suffix. Anthropic mock: tool round trip plus the tail breakpoint |
| U2 | **Contracts and steps**: `send_message` and `both`, the turn cap, intermediate text as steps, `{step}` chunks, `Step`/`Steps` hub events, `Version.steps`, `GetRolloutSteps` | U1 | `agent/*`, `chat/Generations.ts`, `@rp/shared/agentApi.ts`, `chat.ts`, `db/rows.ts` | `send_message` ends the loop with its text as the message; a second send is refused; the cap removes tools; text before a tool call becomes a step; live step events; reply parsers apply to `send_message` text (reply sections test) |
| U3 | **Modes**: the `orchestrationModes` registry, `plain`/`narrator`/`card-swap`, resolution from state, `agent-instructions` stage, prefill dropped in agent modes, `agent.tools` key | U1 | `agent/modes.ts`, `assembler/stages.ts`, `chat/ContextGenerator.ts`, `@rp/shared/state.ts` | `plain` is byte-identical to today (existing generation tests); `narrator` uses `agent`; `card-swap` forces `swap_tail`; a plugin mode replaces a built-in; the instructions piece shows in the inspector |
| U4 | **Read tools**: `expand_summary`, `search_summaries`, `search_chat`, `read_messages`, `lookup_lore`, `list_notes` with their reader ops | U1 (parallel with U2, U3) | `agent/tools/*.ts`, `db/agentReads.ts`, `db/ops.ts` | Causality (nothing at or after the slot, in another fork, or on an unselected version), the token cap, an inserted message in the path, a fork-overridden summary revision. Scale: `search_chat` on a 5,000-message chat with 300 forks under 50 ms (slow) |
| U5 | **Chat-state tools**: the effect sink, `ApplyRolloutEffects`, receipts, `write_note`/`edit_note`/`switch_note`/`set_presence`, permissions (`agent.permission`, `agent_editable_fields`), `note.create` listing | U1, U4 (for `list_notes`) | `agent/effects.ts`, `agent/tools/notes.ts`, `db/rolloutWrites.ts`, `db/baseline.ts`, `@rp/shared/state.ts`, `docs/card.ts`, `editing.ts`, `db/notes*.ts` | Effects attached to the version: a swipe reverses them, another branch doesn't see them; receipts make a re-run a no-op; refused edits; the note shows only where created |
| U6 | **Resume and step edits**: `RolloutMaterial`, strip and policies, `StartResumedVersion`, `ResumeVersion` and `ResumeFromStep` RPCs and commands, the continuation prefill, `AddRolloutBranch` | U2, U5 | `agent/resume.ts`, `db/*`, `api/*`, `@rp/shared/agentApi.ts` | Each policy row of §4.2; the resumed request's prefix byte-identical to the original's; effects copied for kept calls only; an edited tool call re-run under a new id; concurrent resume refused; startup-interrupted resume |
| U7 | **Client: steps** (element, live events, sticky pref, header badge, Resume action) | U2 (U6 for Resume) | `client/src/features/chat/agent/*`, `registerPresentation.tsx`, `session.ts` | Vitest for the step reducer; e2e `agentSteps.spec.ts` at 1440 and 390, light and dark, with a scripted mock provider; layout audit on the message surface |
| U8 | **Client: run inspector steps and the Activity panel**, mode and tools settings | U6, U3 | `ContextPage.tsx` (+ `features/chat/agent/RunSteps.tsx`), `registerPanels.tsx`, `ChatDefinition.tsx` or the settings section | e2e: edit a tool result and resume; Activity lists a summary with cost; the mode select writes the event; layout audit |
| U9 | **Card edits as notes**: `edit_card` over `NoteTargets`; the implementation against `noteoverrides` | U5 and `noteoverrides` merged | `agent/tools/cardEdit.ts`, `agent/noteTargets.ts` | The owner's costume example end to end: Description replaced without the paragraph, a tail note with the costume, the cache prefix changing once, a swipe restoring both |
| U10 | **Decision models**: engine, `system-one` provider kind, `presence` and `lore` points, settings | U1 (independent of U2–U9) | `decision/*`, `providers/builtins.ts`, `assembler/loreStages.ts`, client connection settings | reference-harness's decision tests ported (parsing, malformed billing, timeout fallback, disabled points send nothing); lore admission frozen in the snapshot; presence events attached |

Order: U1, then U2, U3 and U4 in parallel, then U5, then U6. U7 can start after U2. U8 comes after U6. U9 waits for `noteoverrides`. U10 is independent after U1.
