# REPLY-CONTRACT: send_message by default, nudges and how a reply ends

**Status: Built through milestone 4; obsolete as an implementation proposal for M1 to M4. Not built: milestone 5 (the workshop contract, §3.7), which the owner has not asked for ("if the owner wants it", §4). Also not built and not proposed: §3.6's "revise at a send".** Proposed (sendmsg1, 2026-11-17); **milestone 1 (§4.1) and `no_reply` for stories (§3.1) built** (replycontract2, 2026-11-18): those parts are obsolete here, documented in ARCHITECTURE §16 "The reply contract". **Milestone 2 (the mechanical records, §3.6) built** (replycontract6, 2026-11-19): obsolete here, ARCHITECTURE §16 "Contract records". **Milestone 3 (the ending check) built** (replycontract6): obsolete here, ARCHITECTURE §16 "The ending check". **Milestone 4 (per-model metrics) built** (replycontract6; stopped, failed and capped runs recorded as their own outcomes, replycontract7): obsolete here, ARCHITECTURE §16 "Reply behaviour per model". Milestone 5 remains a proposal. The design makes `send_message` the default story reply contract and specifies how sessions end. DESIGN §7.2 records the owner's decisions it follows.

## 0. Why

The owner (2026-11-17) chose an explicit `send_message` contract because models write progress updates between tool calls and sometimes copy XML context tags into their output. The owner also required a reminder when a model writes text instead of sending, backed by rules for ending the session.

Before this work, Dreamspan defaulted to `both`: a turn that ends in plain text is the reply, so progress text written before tools, or a reply wrapped in copied context tags, becomes the message. With the earlier `send_message` contract, the harness nudged once ("Send your reply with send_message.") and then accepted plain text (ARCHITECTURE §16 "Output contracts").

## 1. Send and session-end mechanisms considered

This section describes a multi-send session design considered alongside Dreamspan's existing behavior (§2). The story contract proposed in §3 uses one post per rollout.

### 1.1 Text is scratchpad; only a tool posts

A session's text output is never shown. The only way to post is a tool: `send_message` (plus `send_dm`, `send_to_channel`, `edit_message`, `create_poll`, none of which end the turn). The standing workspace prompt and the per-turn tail both tell the model to call `send_message` to post or `no_reply` to pass.

**Why:** nothing unvetted reaches the chat, and the model's chatter between tool calls (which it's trained to produce) is harmless. Because the reply is a tool argument, the model never wraps it in the `<message sender=… time=…>` markup it sees in its context.

### 1.2 How a turn ends

- `send_message` has a required `final` boolean (no default). `final: true` makes the tool result carry `terminate: true`, which ends the pi-agent-core loop after that batch; `final: false` posts a progress message and keeps the turn open. Required on purpose: a default of `true` silently ends multi-step work after a "let me look…" message; a default of `false` makes forgotten ends post spurious extra messages. A missing `final` is a validation error the model fixes.
- `no_reply` (no parameters, `terminate: true`): silence is an explicit, judgeable action. The literal text `NO_REPLY` is still accepted for older prompts and models, no longer taught.
- Error returns never terminate: an empty send ("If you have nothing to say, call no_reply…"), a reply to a message another session claimed, a bad reply target. The model gets another turn to fix the call.
- When the loop goes idle, `isTerminallyValid` reads **only the last assistant message**: valid if it holds a `send_message` call, a `no_reply` call, or exactly `NO_REPLY`. That's enough because a non-final or failed send keeps the loop running, so a later turn becomes the last.

### 1.3 The run loop's order

After each idle, in this order:

1. **Late input**: an edit or addition to the triggering message arrived; redo from scratch while nothing irreversible happened, else interject. Resets the nudge budget.
2. **A pending redo** the output gate filed during the run (a judged refusal at a send). Resets the nudge budget.
3. **`throwIfLlmFailure`**: any provider failure throws before the terminal check, so API errors never become nudges. Before this existed, a bad API key burned the retries on doomed paid re-prompts and settled as a silent no-reply with no error recorded. The session parks as `failed-resumable` with a failure notice.
4. **Terminal check**: valid, or the operator stopped it (authoritative: never a nudge after Stop), or the run aborted. A `NO_REPLY` text ending is reported to the gate's ending hook; then the loop breaks.
5. **Nudge**, while the budget lasts.
6. **Exhaustion**: report to the gate; a refusal redo it files wins; else an optional contract redo; else give up.

### 1.4 The nudge ("forced completion")

- **Trigger:** a clean turn (no provider failure, not stopped, not aborted, no pending redo or late input) whose last assistant message isn't terminally valid.
- **Text.** No send in the transcript yet (`not_sent`):

  ```
  Your turn ended without sending a message. You must end every turn by either:
  - Calling send_message with your response, OR
  - Calling no_reply if you have nothing to say.

  Text you write outside of send_message is not visible to users.
  ```

  A send earlier in the transcript (`sent_not_final`, stops `final: false` loops):

  ```
  You already sent a message but your turn did not end cleanly. Either:
  - Call send_message again with your follow-up and final=true to end your turn, OR
  - Call no_reply if you have nothing more to say.

  Text you write outside of send_message is not visible to users.
  ```

  Earlier wording is kept in `historical` so transcripts written before the reminders were tagged can still be backfilled.
- **Role and position:** a plain `user` turn appended after the failed assistant turn, carrying a `harness: { kind: "forced_completion", attempt, variant }` field that exists only in the stored transcript (pi passes the message through and ignores the field). If the last message isn't an assistant turn, the runner calls `agent.continue()` instead of nudging.
- **Budget:** `forced_completion_retries = 3`. It resets on a redo or a late-input step, not after a successful send (so it's per run, not per message).
- **Harness rule**: anything carrying a `harness` marker never counts as the model's work.
- **The stray text** and the nudges stay in the transcript, so the model sees what it wrote and what it was told. They are never posted.

### 1.5 When the nudges run out

1. The ending is judged by the output gate (kind `exhausted`); a judged refusal with a matching rule redoes the turn on the rule's model.
2. Else, if `forced_completion_redo` is on (off by default), one **contract redo** per failure point (the index after the last delivered message): fork back there, move the failed attempts and nudges into a discarded branch, continue on the same model with a fresh budget. The prefix is unchanged, so it reads from cache. A redo removes the failed attempts from the next request. It keeps the model and is limited to one per point to bound retries.
3. Else the session settles as no reply, **with no notice**. Stray text stays private to the run.

### 1.6 The output gate and checks

- A **check** has a kind (`refusal`, `style`, `contract`, `duplicate`), a remedy (`redo`: discard and redo, possibly on another model; `revise`: block the call with a tool error so the same agent rewrites; `observe`: record only) and checkpoints: `send` (every posting call, evaluated from `toolcall_end` before the tool runs) and `ending` (a `no_reply` call, a `NO_REPLY` text, nudge exhaustion). An ending check also sees turns that decline to send.
- **Evaluation**: patterns and words first (decide with no model call), then questions to the `checks` decision point, a verdict being the highest probability among its questions against each one's calibrated threshold. Deadlines are timeouts, fail-open: 5 s at a send, 15 s at an ending.
- **Nudge history feeds the judge**: `nudgeHistory` gives `nudges` and `first_attempt` (the text written before the first nudge). The built-in contract checks use them: `no_reply_intent` (observe, asked only after a nudge: "did it abandon a written reply?") and `no_reply_contradiction` (revise, off by default: "your reasoning said to reply; send it").
- **Revise** is bounded (2 in a row, 6 a session) and has an `override_checks` escape for deliberate uses. A refusal redo can't rewind from inside a tool, so the gate files a `RedoRequest` and the agent's `shouldStopAfterTurn` ends the loop; the runner applies it.
- **Default posture**: judged checks need decisions turned on; out of the box only the nudges, the silent give-up and the mechanical records are active.

### 1.7 Records, metrics and audit

- `deriveContractEvents` (pure, over the transcript and its discarded branches) rebuilds per-attempt rows and a per-session outcome (`clean`, `recovered`, `redo_recovered`, `gave_up_no_reply`, `exhausted`). Failure types, in precedence: `invalid_tool_call`, `textual_tool_call` (tool-call markup written as text), `context_mimicry` (the ending text holds a tag of the rendered context, `RENDERED_MESSAGE_TAGS`, kept in step with the renderer by a test), `sent_not_final`, `self_talk` (audit only), `text_only`, `empty`. Stored in `contract_attempts` and `agent_sessions.contract_*`, backfilled at startup.
- **Behaviour metrics**: hourly per-model rollups ("Sessions nudged", "Recovered after nudges", "Gave up after nudges", exhaustions and redos per session), with the retry settings snapshotted so a change shows on the charts.
- **Offline audit**: one judged call per nudged run, billed to an `audit` class: `had_user_message` (adds `self_talk`), `after_correction` (was the sent message the first attempt, reworded, or something else?). A calibration script labels samples through a forced tool so nobody reads the messages.

These records measure how often each model writes a reply as plain text and how often a reminder recovers it.

### 1.8 Resume

The `harness` markers persist. A console resume strips the failed tail and restarts the budget at 0 (the stored nudges stay). A tail ending at a nudge re-issues the request that answers it. Reply-resume replays the whole transcript, stray text and nudges included; a `NO_REPLY` session can't be reached that way. Revise counts are re-seeded from stored decisions.

### 1.9 Loose ends found

The budget is per run, not per message; `noReply` is reported after a delivered `final: false` message that then exhausted; the "sent before" test scans the whole transcript, earlier runs included; the judge's "since the last inbound message" floor may never move (trigger turns have no `role`). Mimicry inside a `send_message` argument isn't checked at all.

## 2. What we already have

| Design option considered | Existing design at the time |
|---|---|
| `send_message` tool | `sendMessageDefinition` (`agent/tools.ts`): one `message` argument, ends the loop (`finishTurn`); a second call gets an error. `present` added by send presence. No `final`: an RP reply is one message ("[D] RP produces one message per turn"). |
| `no_reply` | none yet. **[D]** Stories get it (§3.1): a pass shows as the line "<Name> stays silent", swipeable. A workshop's `several` contract ends on plain text. |
| Nudge | one nudge under `send_message` (`SEND_NUDGE`, an `rpApp` message sent as a user turn), then plain text is taken as the reply. |
| `throwIfLlmFailure` | a failed provider turn fails the version (`failure` in `session.ts`) before `finishTurn` can nudge (`failed` check). |
| Stop authoritative | `signal.aborted` ends the loop in `finishTurn`. |
| Turn caps | `turnCap` (now `agent.request_cap`, default 12): the last request has no tools and asks "Write the reply now." |
| Output gate | the refusal judge (`decision/RefusalJudge.ts`) reads a finished reply and marks the version; observe-only, after the fact. Summaries have `SummaryChecks`. |
| Decision models | `decisionPoints` (`presence`, `next`, `lore`), opt-in per connection, heuristic fallbacks (DESIGN §7.6). |
| Harness marker | `rpApp` messages (`agent/messages.ts`) are the app's, labelled so in Steps and the inspector. |
| Records | the transcript, `rollouts.step_count`, `rollout_branches` (resume and edit cuts), the usage ledger. No per-attempt contract rows. |
| Resume | `planResume` (`agent/resume.ts`): strip the failed tail, rerun, resample, carry on, or fresh; the frozen snapshot holds contract and cap. |
| Steps | `stepsOf`: text from turns that went on to call tools is a step; a plain turn that was then sent is a step. |

## 3. Delta design

Everything below is **[P]** unless DESIGN marks it decided.

### 3.1 Default contract

`send_message` becomes the default contract for agentic story replies (the default planner's `chosen` when `output.contract` isn't set). `final_text` and `both` stay as choices, in This chat → Tools as a radio group ("Send tool", "Plain answer", "Either"), with the same hover explanation pattern. Send presence is unchanged: `required` already forces `send_message`.

**[D]** (owner, 2026-11-17, "ok" to the coordinator's proposal, after the owner's point "Why would the automated reply order know better than the actual LLM? It's the same with the decision model") **Stories get `no_reply`: the replying character may pass.** *(Built, replycontract2: offered beside `send_message` under the send contract only; stored as a complete, empty version marked `silent`.)*
- A pass is never a failure and never invisible: the chat shows a small line "<Name> stays silent", which is swipeable like a message, so the user can get an actual reply from it.
- In a group or round, the next character in the round then replies; with no round, the turn returns to the user.
- In 1:1 the same line appears and the turn returns to the user.
- **Progress messages (`final: false`) are not used in stories** (today's rule): one reply is one message, so a successful send ends the run, as now, with no `final` flag. Anything written along the way shows in Steps. Workshops keep their progress messages (`several`, §3.7). **[D]** (owner, 2026-11-17, on why they aren't needed) "The user can literally expand the agentic rollout and read it. Just like you can do it in this harness." Visibility doesn't need them. The one legitimate use of several messages in a turn is the open item below.
- **Open design item: multi-speaker turns. Needs its own spec (after 2026-11-19).** **[D]** (owner, 2026-11-17) "The only legitimate usage is allowing an agent to write as multiple characters. This is perfectly sensible - however it requires a different conception of what a 'turn' is since the rollout is *internal* to a turn-message currently (also this doesn't work when context varies per character, obviously) So this would need some design work and we have to decide when it's allowed. I think it actually solves a problem, which is that models tend to combine different character reactions in the same message when they're happening close by, not respecting who the speaker is. But so far, everything assumes there is ONE speaker per turn." Everything here, and today's code, assumes one speaker per turn.
- A model that neither sends nor passes after 3 nudges still fails visibly (§3.4).

### 3.2 Text outside a send is never the reply

Under `send_message`, a turn's text never streams into the body (today it streams and the body restarts). It shows in Steps once its turn ends, as text before a tool call does now. Only the validated, executed `send_message` call writes the body (as today). The final request at the cap is the exception (§3.5).

### 3.3 The send reminder

- **Trigger:** `finishTurn` sees a clean turn (not `error`, not `aborted`, not stopped) with no tool call, before the cap's last request.
- **Text:** A reminder to send the reply, with a `no_reply` option when the character may pass (§3.1), as a preset utility prompt **"When the reply wasn't sent"** (identifier `sendNudge`) with a built-in default, under the same fallback rule as the Agent instructions: a preset without it sends the default.

  ```
  Your turn ended without sending a message. You must end every turn by calling send_message with your reply.

  Text you write outside of send_message is not visible to users.
  ```

  There's no `sent_not_final` variant: a send ends our run.
- **Role and position:** an `rpApp` message (a user turn on the wire) appended after the failed turn, with `nudge: n` (1-based) on the stored message; Steps label it "The app asked for the reply to be sent". It appends, so the cached prefix is unchanged (the existing cache-marker tests cover a tail append).
- **Budget:** 3 per run, counted from the transcript (`rpApp` messages with `nudge`), so a resumed run continues the count. Nudges are model requests and count toward the request cap.
- **No LLM-failure nudges:** a failed or stopped turn fails or stops the version, as now.

### 3.4 When the nudges run out

The version fails visibly: **"The model didn't send a reply: it wrote text 4 times without calling send_message."** (class `contract`), with Resume and Regenerate. Its steps keep the stray text, so the user can read it. Taking it as the reply would be a separate action the user chooses (Open: whether to offer one); never automatic. Resume lets the user carry on when a reply still needs to be sent.

**[D]** (owner, 2026-11-17, on whether failure after the nudges should be visible or silent) "It has to fail visibly. Not sure what staying silent would even mean here." The design above already does this; the question is answered.

**Resume after exhaustion:** `planResume` cuts the last plain turn and resamples the answer to the last nudge, with the budget counted from the kept transcript: one more attempt. A contract redo (fork back to the reply's start, same model, fresh budget) is proposed as part of Regenerate, which already discards the run.

### 3.5 The request cap

The last request at the cap has no tools and asks "Write the reply now." Its plain text is the reply, as today: the app asked for text, so it isn't stray. A nudge never happens on that request.

### 3.6 Checks and records (later milestones)

- *(Built, replycontract6; obsolete here, ARCHITECTURE §16 "Contract records".)* **Mechanical records:** a pure `contractAttempts(transcript, cuts)` over the stored transcript and `rollout_branches`, with these failure types: `invalid_tool_call` (a send refused, e.g. by send presence), `textual_tool_call` (markup patterns), `context_mimicry` (our own context's tags: the history's speaker labels and `<Name>` card blocks, from one constant the assembler also uses, with a test keeping them in step), `text_only`, `empty`. Shown in the inspector's run view and summed per model in Settings → Models later. No backfill needed: nothing real is stored yet.
- **Rejected [D]: no redo on another model** (owner, 2026-11-17, on the checks gate redoing a turn on a different model): "This is not an autonomous agent. The user can switch a model and swipe themselves. Moreover, we don't have the affordance for choosing a secondary model" The output gate's model-switching redo (§1.5, §1.6: a judged refusal redoing the turn on a rule's model) is not part of the delta design, and is rejected, not deferred. A failed ending stays visible (§3.4) and the user switches the model and swipes. Any ending check is observe-only.
- *(Built, replycontract6; obsolete here, ARCHITECTURE §16 "The ending check".)* **Ending checks:** our refusal judge already judges finished replies. Extending it to an exhausted ending ("was the stray text a reply?") is the only ending check we'd need, since a deliberate pass is `no_reply`, never stray text. Opt-in, like every decision send.
- **Revise at a send:** A revision tool for style or duplicate checks. Not proposed now.

### 3.7 Workshops

The owner's reasoning (progress text between tool calls; copying context markup) applies to workshops too: a workshop run calls many tools and writes progress text all the time. Under the workshop's `several` contract, `send_message` posts an intermediate message. A plain answer posts the final message and ends the run. **Proposed:** leave workshops as they are for now; a later milestone gives them an explicit end-of-run contract (`send_message` with a required `final`, a `no_reply`-like "done" with nothing to add, the `sent_not_final` nudge) once the story contract has run for a while. The workshop has no request cap (DESIGN §7.2).

## 4. Milestones

1. **Contract and nudge** (server). *Built (replycontract2, 2026-11-18); obsolete here, see ARCHITECTURE §16 "The reply contract".* default `send_message`; no text into the body under it; nudge text as the `sendNudge` utility prompt with fallback; 3 nudges counted from the transcript; exhaustion fails the version with Resume; Steps label nudges; This chat's contract choice. Tests: text then send (only the send is the reply, the text a step); text, nudge, send; three nudges then the visible failure; Resume after a nudge never re-nudges a resolved turn and continues the count; the cache-marker tests for the appended nudge; byte-identical requests for chats that set `both`.
2. **Mechanical records**: `contractAttempts` and the inspector's view of attempts and failure types. *Built (replycontract6, 2026-11-19); obsolete here, see ARCHITECTURE §16 "Contract records".*
3. **Ending check**: the refusal judge at an exhausted ending, opt-in. *Built (replycontract6, 2026-11-19); obsolete here, see ARCHITECTURE §16 "The ending check".*
4. **Per-model metrics**: nudged, recovered, exhausted per model in Settings → Models. *Built (replycontract6, 2026-11-19); obsolete here, see ARCHITECTURE §16 "Reply behaviour per model".*
5. **Workshop contract** (§3.7), if the owner wants it.
