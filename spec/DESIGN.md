# Design: requirements and decisions

**Status**: Draft, 2026-10-09. Each item is marked:
- **[D] Decided**: the owner stated it or explicitly confirmed it.
- **[P] Proposed**: suggested during planning, not yet confirmed.
- **[O] Open**: needs a decision.
- **[L] Later**: wanted, but deferred until the core works.

Where the owner corrected an earlier proposal, the corrected version is recorded and the rejected one is noted, so it doesn't come back.

---

## 1. Compatibility scope

**Contract [D]:** anything you do with a card or preset in ST works the same way here. Features only this harness has (e.g. summarization with the preset loaded) may need preset edits, and that's acceptable. Beyond this section, feature parity with ST is not a goal.

### 1.1 Cards
- **[D]** Import, create and distribute ST cards as easily as in ST.
- **[P]** Formats: V1, V2 and V3, as JSON, PNG (`chara` and `ccv3` text chunks) or CHARX. Embedded `character_book` lorebooks. Alternate greetings.
- **[P]** Export flattens a chosen variant plus its exportable modules (§4) into a standard V2 or V3 card.
- **[P]** A watched import folder: drop a card file in and it becomes available. Each imported card remembers its source file and hash, and offers an update when the file changes. Files are only import and export; the internal representation is the source of truth **[D]**.

### 1.2 Presets (chat completion only)
- **[D]** Import and export ST chat-completion presets so they give similar results.
- **[D]** No text-completion presets, instruct templates or context templates. The importer lists them as unsupported.
- **[D]** Connection and model data in presets is ignored. There's an optional one-way binding the other way: a connection can switch to a chosen preset (§9).
- **[P]** Supported semantics:
  - `prompts[]` and `prompt_order`, markers (main, worldInfoBefore/After, charDescription, charPersonality, scenario, personaDescription, dialogueExamples, chatHistory, …)
  - prompt roles, in-chat injection at a depth with a role, injection order
  - squashing and post-processing modes
  - assistant prefill and continue prefill
  - sampler values, mapped per provider
  - macros (§5.6)
  - prompt-only regex scripts, plus display regex as display rules
- **[P]** The importer never runs code from a preset. It writes an import report listing anything it couldn't represent (pi-forge's ST importer is a good reference).
- **[P]** Fidelity is tested by **differential testing against real ST**: a stock ST in a throwaway container, pointed at a mock endpoint that records its requests. Synthetic card, chat, preset and persona fixtures are fed to both, and the request bodies are diffed. This applies to the non-agentic assembler.
- **[D]** Prefill must work where the provider supports it. Most frontier models don't. reference-harness's tool-schema prefill for GPT (`spec/OPENAI-PREFILL.md`) is worth porting as a separate capability.
- **[P]** Where the provider doesn't support prefill, it's dropped and the request preview says so.

### 1.3 Lorebooks / World Info
- **[D]** Imported lorebooks must work. Matching ST's activation and placement exactly is **not** a goal; ST's implementation is considered poor.
- **[D]** Lorebooks usually wreck the KV cache, so they will work differently here.
- **[D]** Decision models (Jev and others) can decide whether an entry is included. This must stay optional.
- **[P]** Activation sources: keyword triggers as the fallback, an optional decision model asking whether each entry or group is relevant to the current scene, and an agent lookup tool for anything missed.
- **[P]** Placement is cache-friendly: entries are never inserted above the history. They go in a block near the tail, where they stay until the next compaction boundary.

### 1.4 ST data folder import
- **[D]** Point the importer at an ST data folder. It finds the chats and their cards and adds them seamlessly. Exporting chats back to ST is secondary.
- **[D]** ST has a single hidden flag. If a long consecutive run of hidden messages starts at message 0 (the manual-summary pattern), the importer offers to un-hide them so LCM can take over. Other hidden messages stay excluded from context.
- **[D]** Chats that have only the greeting and zero user turns are skipped (ST creates these just by opening a card). The import report gives the count.
- **[P]** Mapping:
  - single and group chats → chats with N participants
  - ST branch files (linked by metadata) → one message graph
  - swipes → versions
  - personas → cards in the persona folder, with their original images (ST's card-to-persona conversion blurs them)
  - global, chat-bound and embedded lorebooks → lorebooks
  - presets → presets
- **[P]** ST links chats to cards by folder name, so when a card was renamed the importer needs fallback matching.
- **[P]** An LCM backfill of a large imported chat runs lazily (for example when the chat is first opened, or in idle time), not as part of the import.

### 1.5 Out of scope
- **[D]** ST extensions and plugins, external ST integrations, text completion, connection profiles.

---

## 2. Chats and participants

### 2.1 A chat is its own object
- **[D]** In ST you *message a card*: the card is the chat target, usually a whole scenario, and effectively the only chat with that character (older chats are history travel). Group chats are a special case created by irreversibly promoting a chat. Here, **a chat is a first-class object with any number of cards**. A single-card chat is just the trivial case.
- **[D]** Keep the convenience of ST's one click from the grid into a conversation, with the card definitions and the other participants in a side panel.
- **[P]** A card's page offers **Continue** (its latest chat), **New chat**, and the list of all its chats as peers.
- **[D]** Opening a card must not create a chat.
- **[P]** Chats are created lazily: clicking a card with no chats opens a *pending* chat showing the greeting (alternate greetings selectable), saved only when the first message is sent.
- **[P]** Recents are sorted by last message, never by last opened. A separate *inspect* action shows a card without entering a chat.
- **[D]** Cards can be filtered by "never used".
- **[P]** Chats have editable titles (auto-generated by default, never just the first character's name). The thumbnail is an avatar collage by default, and can be overridden.
- **[P]** The main surfaces are a **chat list** (recent first, also the mobile home screen) and a **library** (cards, personas, presets, lorebooks).
- **[O]** Does "start over" with a card create a new peer chat (proposed), or a new root inside the same chat?
- **[D] Rejected:** per-participant roles (character vs. narrator) in each chat. They force a separation, and muting plus the card's own text already cover it. Per-card preset overlays replace them (§6.3).

### 2.2 Personas, speakers and writers
- **[D]** Personas aren't a special entity. **A persona is a card in the "persona folder"**, and any card can be added to that folder. Cards in it get special UI treatment.
- **[D]** You can switch to writing as any card, on any turn.
- **[D]** The model can write for "your" character, because you may not be playing it.
- **[P]** Each turn has a **speaker** (any participant) and a **writer** (human or model).
- **[P]** A per-chat "played by me" set (state on the graph, §3.4) drives:
  - the composer's default speaker
  - what `{{user}}` resolves to
  - which characters the "don't write for" instructions protect
- **[D] Speaker switcher:**
  - The current speaker is **always visible** next to the composer.
  - Clicking it opens a panel with tabs **Members / Personas / All cards**. The panel remembers the last tab used.
  - Switching to a card that isn't in the chat adds it as a participant from that point on **[P]**.
- **[P]** Up to three one-tap avatars next to the switcher for the speakers used most recently in this chat.
- **[P]** Composer actions:
  - **Send as X**: you wrote it.
  - **Generate X**: the model writes X's turn, as a real generation. Not a fake turn inserted into the history, and no command to remember.
- **[P]** **Composer text used with Generate becomes a one-turn direction**, stored on that generated turn. Swiping reuses it, going back restores it, and it never leaks into later turns. This replaces "put next-turn guidance in the author's note and remember to remove it".
- **[P]** Impersonation is just Generate for a character you play. The output lands as a real turn with versions. A "draft into composer" option is available.
- **[O]** When sending into a chat that's still generating: queue or cancel?

### 2.3 Group-chat orchestration (see §7)
- **[D]** The owner only uses group chats. Single-card chats are a special case of the general system.

---

## 3. The message graph: versions, branches, threads, state

### 3.1 Slots and versions
- **[D]** **Versions belong to a message slot, and the continuation belongs to the slot**, not to a version. Swapping, regenerating or editing a version at *any* depth replaces that message in place and keeps what follows. This is a version, not a branch.
- **[D]** Any message can get a new version, including the user's own messages and messages in the middle of the history.
- **[P]** Regenerating in the middle of the history can optionally show the model what follows ("write a replacement consistent with what comes after").
- **[P]** A non-intrusive mark on later messages that were generated against an older version of an earlier slot.
- **[D]** **"Write your own version"** on any message, without a sacrificial swipe.
- **[D]** **Saving an edit of a generated version creates a new version**, recording its source ("edited from #7"). Editing a version the user created **amends** it, with its earlier states kept in its undo history.
- **[D]** A **composition scratchpad**: the owner generates 10–50 versions of a turn and merges the best parts. Select text in any version, assemble it in the scratchpad, commit it as a new version. The scratchpad persists like a draft.
- **[P]** The version picker is built for dozens of versions: compact previews, star, hide, delete, side-by-side comparison.
- **[D]** Pressing swipe while a generation is running starts another one. You can move freely between versions that are still generating and finished ones. **The stop button belongs to the version**, not the composer. There's no dedicated "generate ×N" action.
- **[D]** **Failed generations are versions** with a clear failure style showing the cause: HTTP error, context length, classifier refusal (with its category), or a length cutoff. They never enter the context.
- **[P]** A stream that dies midway keeps its partial text and offers Continue (§7.5). Refusals offer Retry and "Retry with…" another model.
- **[D]** Generating with different models and upstreams at the same time is required. The model is chosen per generation and recorded on the version **[P]**.

### 3.2 Branches
- **[D]** A branch is an explicit fork of the path. It's what you choose when you want the continuation to differ, and it never happens as a side effect of swiping.

### 3.3 Threads and merges (the architecture must allow them now; the UX comes later)
- **[D]** Parallel threads in one conversation that fork and **merge**, with the ability to send one message to several threads at once (same or different speaker, and the speaker can be any card).
- **[D]** Concurrent threads and alternate branches are different concepts and must look different in the UI.
- **[P]** Messages form a **graph from day one**: slots point to their parents, and a merge is a slot with several parents. Threads are named lanes. **Every view is a selection of a path through the graph**, and context assembly always works on a path.
- **[P]** Sending to several threads creates one placement per thread, linked by a group ID. Editing one asks whether to edit the whole group.
- **[O]** How two merged threads become one sequence: interleave by time, or the merge node carries a summary of the other thread. A merge is an explicit event that sets the merged state **[P]**.

### 3.4 Chat state lives on the graph
- **[D] Problem:** in ST the author's note state is not tied to branch points, so the owner branches at the latest message as a checkpoint before every author's-note edit.
- **[P]** **Every change to chat state is an event at a position in the graph.** The state at any message is the result of replaying the events on the path to it. Chat state covers:
  - notes and which notes are active
  - card overrides
  - preset switches and toggles
  - presence
  - the "played by me" set
  - variables
- **[P]** As a result, branching restores state automatically, edits after a branch point don't leak into other branches, and the timeline can show small markers for state changes.
- **[P]** State events produced by a rollout are **attached to the version that produced them**, so switching versions switches their effects too.
- **[P]** Default edit scope is "from here on, on this branch", with "apply to all branches" as an option.
- **[O]** That option assumes the note has a stable, recognizable identity, which may not be clear to the user.

### 3.5 Presence
- **[D]** Characters can be marked present or absent per branch. Presence can be set:
  - manually (like muting in ST)
  - by a tool call
  - by a required `send_message` argument
  - by a decision model reading the message
- **[P]** All of these produce the same presence event.

---

## 4. Layered, versioned entities (cards, presets, lorebooks)

- **[D] Problems:**
  - Reusing a character for a different premise means changing the card without breaking existing chats, and ST forces duplication.
  - Duplicates can't be renamed during duplication, and the card name *is* the in-chat name.
  - Opening a card reorders the list, so you can't tell duplicates apart.
  - Users also expect editing a card to change it everywhere.

  The UI must make edit scope clear. The owner expects this design to be hard.
- **[P]** Three names, kept separate: **identity** (internal ID), **library label** (title plus a free-text subtitle), **in-chat name** (what `{{char}}` resolves to).
- **[P]** Three layers, the same mechanism for cards, presets and lorebooks:
  - **Base:** the imported or upstream version. Re-importing a new version adds a base revision.
  - **Variant:** a named fork, stored as changes on top of the base, so upstream updates flow through.
  - **Chat-local override:** changes for one chat only, with no library entry. It can be **promoted** to a variant.
- **[P]** Chats point to a variant and follow its latest version by default, or are pinned to a fixed revision.
- **[D]** Cards often need **non-additive changes as a story progresses**. You can't substitute a duplicate for the card in the current chat. Chat-local overrides cover this **[P]**.
- **[D]** **Preset re-import must keep user edits.** Concrete case: the owner added a `{{summary}}` prompt and a summarization instruction, and softened "do not impersonate the user". A new upstream version currently means redoing all of it in ST's poor editor.
- **[P]** Additions survive trivially. Edits to upstream prompt text are reapplied with a three-way merge, and you're only asked when upstream changed the same passage. Real conflicts get a side-by-side resolver.
- **[P]** Edit scope depends on where you edit from:
  - in the library, the variant changes everywhere, and the screen always shows "used by N chats"
  - from inside a chat, you choose "this chat only" or "the card everywhere", with the count visible
- **[P]** The UI shows two concepts, **variants** and **this chat's changes**. Revisions sit behind a History button, and modules appear as sections of the card.
- **[P]** Library: variants are grouped under one character entry. Sorting is explicit (last chatted or last edited, never "last viewed"). Any two variants can be diffed.

### 4.1 Card modules and character notes
- **[D] Wanted:**
  - something like author's notes, but **several, and per character**, placed at the tail or earlier
  - **only on that character's turn** in group chats
  - **stashable** (switched off without being lost)
  - **traveling with the character between chats, but not activated in other chats automatically**
  - example: outfits, which today must either live permanently in the card definition, be lorebook entries (which doesn't really work), or be described in chat
- **[D]** Extended prompts attached to a card, swapped per chat or situation, possibly **private** (excluded from export).
- **[P]** **Notes as a first-class object:**
  - owner: a character, a chat, a persona or global
  - placement: tail/D0, depth N, or a fixed section
  - condition: always, on this character's turn, while this character is present, or decided by a decision model
  - activation per chat (as state events)
  - an exportable or private flag

---

## 5. Context assembly

### 5.1 Pipeline [P]
1. Take the path (§3.3).
2. Replay state events along it (§3.4).
3. Resolve participants, and cards through their layers (§4).
4. Resolve the preset through its scope chain and overlays (§6).
5. Expand macros according to where each piece of text came from (§5.6).
6. Project LCM: summary layer, compact tier, rich tier (§8).
7. Project roles (§5.4).
8. Add tail content: notes, the speaker directive, one-turn direction.
9. Place cache breakpoints.
10. Hand off to the provider adapter (pi-ai).

### 5.2 Card layout
- **[D]** ST concatenates cards *by field* and has no default boundaries between cards. Here:
  - **default:** all cards concatenated one after another, each in a clearly labelled block
  - **card-swap mode:** the active card's definition goes at the **tail**, which helps both caching and instruction-following
  - the user picks the layout, per RP and per model, and it must be easy to change
- **[P]** A preset's `charDescription` and similar markers become the slot where the combined block goes.

### 5.3 `{{user}}`, `{{char}}` and the speaker
- **[D]** In ST these rebind every turn (to the current speaker and the current persona). That breaks the cache and fights instructions like "don't write for `{{user}}`". Users need to control and pin these bindings, and to edit presets and cards to stop relying on them, which requires search and replace.
- **[P]** The prefix uses stable bindings: by default, `{{char}}` resolves to the cast or narrator framing and `{{user}}` to the "played by me" set, both overridable per chat. A small **tail directive** names the speaker for this turn and who not to write for, overriding anti-impersonation rules when the model is meant to write one of your characters.

### 5.4 Role projection [P]
These are strategies for mapping history to user and assistant roles:
- **by writer:** human → user, model → assistant (ST's behavior)
- **strict alternation by position:** the owner's idea. It's stable as the chat grows (cache-friendly) and avoids long same-role runs that degrade models.
- **by perspective:** the speaker's own past turns become assistant, everyone else's user. It's natural for per-character agents.

### 5.5 Caching
- **[D]** Preserving the KV cache is a near-top priority, second only to avoiding RCEs.
- **[D]** Depth injections are cache-friendly when breakpoints are placed correctly. A depth-0 author's note is the ideal place for information that changes, like reference-harness's tail prompt. The real cache-killers are changes near the top of the prompt, which the assembler should flag **[P]**.
- **[P]** Breakpoints follow reference-harness's scheme (ARCHITECTURE.md "Cache control"): system/preset, summary layer, last verbatim timeline item.
- **[D]** **Cache-warmth indicator** near the composer, with an optional countdown (can be turned off).
  - The TTL comes from known provider defaults, or from a TTL the user sets on any model or connection. No TTL means no indicator.
  - **[P]** States: warm (verified from reported cache usage), warm (assumed), cold.
  - **[P]** It tracks the prefix of the *next* generation and warns when an edit changed it ("next send rewrites ~N tokens").
- **[D]** **Parallel requests with a cold cache can cause N cache writes.** Stagger them deliberately per provider: start one, and release the others once its cache write is readable. When that happens differs by provider, so it must be tested and measured (cache-read token counts on the follow-ups) **[P]**.

### 5.6 Macros
- **[D]** In ST, `{{user}}` in greetings gets fixed when a card is opened, so changing persona before the first message keeps the old name. Substitution must stay dynamic until a message is sent.
- **[P]** Card-sourced text keeps its macros unresolved in storage. They're resolved when rendered or assembled, against the state at that message's position.
- **[P]** Non-deterministic macros (`{{random}}`, `{{roll}}`, `{{time}}`) are evaluated once and frozen, for determinism and caching.
- **[D]** **Text the user types is not macro-expanded by default** either. **[P]** A per-message toggle can switch expansion on.
- **[D]** **Model output is not macro-substituted by default.** The model never sees macros, so a `{{user}}` it writes is literal. That's required when, say, it writes a card.
- **[P]** Expansion therefore depends on where text came from, and model text stays verbatim when it's sent back in later turns.
- **[D]** Substituting in output is still useful, as an opt-in display rule.

---

## 6. Presets: scope and overlays

### 6.1 Scope
- **[D]** A preset isn't global, but it isn't obvious what it belongs to.
- **[P]** Inheritance chain: app default → default for the chat kind (RP or workshop) → chat → per-role override (narrator, character agent, summarizer) → card overlays and per-turn conditions.
- **[P]** The composer strip shows the active preset and where it comes from. Changing it uses the same scope prompt as card edits. A preset switch is a state event.

### 6.2 Saving (ST's gripe #1)
- **[D]** In ST, some fields autosave, some have save buttons, and preset field edits lived in limbo: they survived restarts but vanished on a preset switch.
- **[D] Principle:** nothing is ever lost, and it's always clear which state you're in. (The earlier "autosave everything, no commits" proposal was rejected because it doesn't work for creating versions.)
- **[D]** That means **nothing is lost by accident**: edits are non-destructive, and input boxes can be trusted with your life, so nobody keeps a notepad on the side. It doesn't mean nothing can be deleted; deliberate deletion is allowed (owner, 2026-10-10).
- **[D] Recycle bin** (owner, 2026-10-10). Deletes go to a global per-user bin and disappear from where they were; they can be restored from there or deleted permanently. This makes deleting fundamentally non-destructive.
  - **Every delete shows a toast with a button that opens the bin,** so nobody has to search for it. Because of that, **deleting needs no confirmation anywhere except inside the bin**, which keeps deleting many things fast.
  - **The bin has two independent sections**, each with its own capacity, oldest evicted first. Overflow in one never evicts items from the other.
    - **Deleted items:** discrete things with an identity (chats, messages, swipes, branches, cards and other library entities), produced only by an explicit delete.
    - **Recovered text:** text from before a destructive change in a drafting session, saved when the draft is committed, and discarded drafts. It's produced passively during normal editing, so it **never shows a toast**.
  - **[D]** Deleting a single swipe (version), not the whole message, is the normal case, as in ST, and the most readily available delete in the UI. Deleting the whole message is the secondary action (owner, 2026-10-10). Deleting a message's only remaining version deletes the message.
  - **[D]** Messages, swipes and branches are restored in place: deleting marks them, so restoring puts them back exactly where they were, with their versions. The bin entry also records where an item came from and a preview, so its text can be copied out instead.
  - **[D]** Permanently deleting a chat or an entity removes it. Permanently deleting a message or branch erases its content but keeps an empty placeholder, so the conversation's structure and any summaries over it stay valid.
  - **[D]** Default capacities: 10,000 deleted items or 2 GB; 2,000 recovered texts or 200 MB. Large enough that most users never reach them; configurable. (These three confirmed by the owner, 2026-10-10.)
- **[D]** **The composer belongs to a branch** (owner, 2026-10-10):
  - Each chat, and each branch within it, has its own composer.
  - A half-typed message waits where it was left, even months later, while other chats and branches show their own.
  - Starting a branch copies the current composer into it.
  - Switching between existing branches doesn't carry text along: moving text to another branch or chat is copy and paste, which is simpler than a composer that follows you around.
- **[P]** Anything appended at a branch's tip, such as a model reply, carries that branch's composer forward to the new tip, so text typed meanwhile stays in view.
- **[D]** Drafts and field-level undo history are **persisted on the server** for every text field. That protects against Ctrl-A plus a stray key and survives refreshes, closing the tab and switching devices.
- **[D]** The undo history only lives while a draft is being written. A commit ends it: the committed text is preserved in a version or revision, and history tables must not grow indefinitely (owner, 2026-10-10).
- **[D]** A bad save can lose hours of typing in any field (a card, a preset), whatever happened to the previous version. So when a draft is committed, the text from before **each** destructive change in that session goes to the bin's recovered-text section, and a discarded draft goes there too (owner, 2026-10-10).
- **[P]** Creating versions or named revisions needs an explicit commit, and a commit is a clear action.
- **[P]** Every write carries the revision it was based on, so a stale tab can never silently overwrite newer state.
- **[D]** Search, and search and replace, everywhere: preset prompts, cards and chats.

### 6.3 Per-card preset overlays
- **[P]** Prompt toggles or replacements attached to a card (or a card within one chat), applied when the card is present or speaking. The owner's example: "you may impersonate" for a narrator card. Cache cost is shown when an overlay changes text above the tail.

---

## 7. Agents and rollouts

### 7.1 Timeline vs. rollouts
- **[D]** The chat timeline exists independently of agent rollouts. A rollout forks from the timeline, produces output, and ends. Different agents with separate contexts can contribute to the same chat, and agentic and non-agentic chatting share one representation.
- **[D]** Orchestration modes are configurable, and there will be more than two:
  - **a single agent per turn with all cards loaded** (reference-harness's way, the most cache-friendly)
  - **one agent per character**, with its own system prompt and only its own card. It speaks only for itself and sees history only for the periods it was present. This turns the model from a narrator into an agent acting for its character, and scales to many characters. It's not the owner's usual choice.
  - plain ST-like non-agentic generation
- **[P]** A mode decides three things: who runs on a turn, what each agent sees, and how output is committed.
- **[D]** Per-agent private state (notes, memories) hidden from other agents **[L]**. Getting agents to actually use such tools is the hard part. Follow reference-harness's rule that how an agent is prompted to use a tool is designed as carefully as the tool.
- **[P]** With presence-limited views, summary chunks are cut at presence boundaries so they can be shared wherever views overlap.

### 7.2 Output contracts
- **[D]** Support both: capturing the final assistant text, and an explicit `send_message` call. Agentic models produce intermediate blocks that aren't the final output, and weaker models don't use `send_message` reliably.
- **[D]** One internal commit pipeline, so hooks and checks apply the same way to both.
- **[D]** RP produces one message per turn, as a hard rule.
- **[D] Shelved:** treating intermediate output blocks as real messages.

### 7.3 Rollouts as versions
- **[D]** Because the rollout is separate from the timeline, regenerating creates a new rollout and therefore a new version.
- **[P]** Tool effect classes (reference-harness has a version of this in `tools/side-effects.ts`):
  - **read-only:** lore lookup, summary expansion, search. Freely regenerable.
  - **chat state:** notes, presence, private memory. State events attached to the version, so swiping reverses them.
  - **external or global:** card, settings, plugin edits. Regenerating warns first, and these tools aren't offered in RP turns.

### 7.4 Display
- **[D]** Reasoning, steps and intermediate output stream **live and expanded by default**, then collapse when the final message arrives. If the user collapses or expands them during a run, that becomes the sticky preference (stored per user **[P]**).
- **[D]** Rollout steps expand **inline**, as a collapsed "N steps" element inside the message version they belong to, the way coding harnesses do it. (A side-panel rollout timeline was rejected for space reasons.)
- **[D]** **Run inspector** (side panel or full view): the exact assembled context of *that specific run*, presented readably from system blocks through summaries to the chat, as in reference-harness's console.
- **[P]** A badge on the message header shows the step count and time, and nothing for plain generations. Rollouts attach to versions, not to positions between messages.
- **[P]** Rollouts that produce no message (summaries, jobs, decision calls) appear in an **activity panel** with cost and token use.

### 7.5 Resuming
- **[D]** Resume a stopped or broken rollout mid-way **without sending another turn and without the model being able to tell**. reference-harness does this; most coding harnesses don't.
- **[P]** As in reference-harness (`src/agent/recovery.ts`):
  - a frozen context snapshot is taken when the rollout starts
  - the transcript is flushed as each turn completes
  - on failure, synthetic error messages and partial turns are stripped and a fresh agent is reseeded
- **[P]** Interruption policies:
  - after a tool call but before its result: re-run the tool
  - midway through a tool call: discard it and resample
  - midway through text: continue it through prefill where supported, otherwise discard it
- **[P]** Any step of a rollout can be edited before resuming.

### 7.6 Decision models
- **[D]** Jev and similar decision models are integrated as in reference-harness (`spec/DECISION-MODEL.md`), but are **never mandatory**. Each decision point has a heuristic fallback.

### 7.7 Agent use ("workshop")
- **[D]** Agentic work outside the RP itself: creating cards with tools, editing and cloning them, changing settings, setting up chat modes, eventually writing plugins.
- **[D]** It needs a **clear UX distinction** within one shared UI, and it must be hard to slip into "Claude Code mode" from RP by accident. It ships preconfigured with an agent preset and a default assistant card the user can swap for any of their own.
- **[P]** Technically it's a chat configuration made of:
  - an output contract that allows several messages
  - **rollout continuity**: fork fresh per turn, or **resume the previous rollout** **[D]** (the timeline stays separate either way)
  - the meta toolset
- **[P]** The chat kind (RP or Workshop) is chosen at creation and can't be toggled afterwards. Workshops have a distinct accent, a badge and a capability strip.
- **[P]** An out-of-character side channel attached to an RP chat: a small workshop docked in a panel that can read the story but writes to its own timeline.
- **[P]** Permissions:
  - tools with external effects need approval
  - installing a plugin always needs confirmation
  - **[D]** Content the user loads (a card, a preset) is effectively their own prompt. If it steers the agent, that's user error, not our vulnerability. Agent capabilities don't depend on where content came from, because defending against the user's own prompt would hamstring the agent (owner, 2026-10-11).
  - **[P]** Import formats never carry capability grants: a card or preset file's own fields can't enable tools, plugins or permissions (Marinara's bug, §11). The user turns those on.
- **[P]** Every UI action is a typed server operation, so that later it can be exposed as an agent tool.

---

## 8. LCM (hierarchical summarization)

- **[D]** This is the main feature: chats of unlimited length with a fixed, predictable, cache-friendly context budget, keeping all original messages and every intermediate summary. The agent can drill down and search.
- **[D] Baseline:** reference-harness ARCHITECTURE.md §9b:
  - summarization sessions reuse the agent factory, model, persona and rendered prefix
  - rich, compact and summary tiers, with target/max hysteresis
  - eager generation threshold below the compact maximum
  - use / wait / omit
  - condensation cascade
  - failure placeholders
  - lineage tables, `expand_summary`, summary search
- **[D]** The owner's manual ST workflow already works:
  1. hide messages up to the end of the last summary
  2. keep the summaries in context
  3. ask the model to summarize the chat since then, with the full preset loaded

  Some frontier models took the summary request for a prompt injection until a line acknowledging summary instructions was added to the preset. That's acceptable under the compatibility contract.
- **[D]** Normally LCM runs in response to user messages, and it doesn't have to run immediately on large imported chats.
- **[D]** **Semi-background idle-time jobs:** run LCM work in the gap after a reply, while the cache is still warm, which also refreshes it (depending on settings and provider).
- **[P]** Summaries cover **path segments**, so threads and branches share summaries up to their fork.
- **[P]** Editing a message already covered by a summary marks that summary stale and re-summarizes it lazily. Mechanical edits such as renames are applied to the summaries directly.
- **[P]** Summaries are **editable**, with versions.
- **[D]** Memory retrieval of *some* sort will be a feature. LCM is already a form of RAG (owner, 2026-10-10).
- **[D]** Assume vector search will exist somewhere eventually. Plain embedding search over all messages is of doubtful value on its own (owner, 2026-10-10). sqlite-vec already covers vector search, but only by brute force; an indexed ANN search is a benefit of alternatives such as Turso, not a requirement.
- **[P]** Search tools combine full-text and vector results with reciprocal rank fusion (RRF). reference-harness's memory retrieval (`spec/MEMORY-RETRIEVAL.md`) and its RRF evaluations are the baseline.
- **[D]** The UI shows where verbatim context ends and which summaries stand in for older history. **[P]** Three layers:
  1. an always-on **boundary divider** in the stream, which opens the current summaries
  2. an optional **coverage rail** next to the messages, with bars per summary by level, stale marks, and click to open
  3. the **context view**: the exact assembled request with token counts and cache breakpoints, plus "the context this message was generated from" for each message

---

## 9. Connections and models

- **[D]** No ST-style connection profiles. **A connection is one wire type, one provider and one set of settings.** You switch models within a connection; otherwise you switch connections.
- **[D]** Every provider type has an **overridable base URL**. No special "proxy" concept; a provider's native model picker stays whatever the address.
- **[D]** Model lists are fetched from the configured upstream. Users can add and edit models for every provider type.
- **[P]** User-added and edited models have capability fields: context length, reasoning, prefill support, cache mode, TTL (like reference-harness's `compat` flags).
- **[D]** No coupling between presets and connections, except an optional one-way "preset override" field on a connection.
- **[P]** Model choice is a (connection, model) pair, inherited through the same kind of chain as presets but completely separate from them. The summarizer can have its own model.
- **[P]** Several connections of the same type are allowed.
- **[P]** API keys are write-only: stored on the server and never sent back to the browser.
- **[D]** Keys are stored once as credentials that connections share, and are sent only to the hosts they were entered for. Moving a key to a new host takes typing it again. Keys are protected more than chats because they have economic value: easy key theft makes the frontend worth attacking, as with ST (owner, 2026-10-11).
- **[D]** Most settings are configurable from inside the app, so the user's agent can change them. Security settings are the exception, changeable only from outside (environment or config); host binding for keys is the first (owner, 2026-10-11).
- **[D]** A provider kind is an upstream API as that upstream defines it, endpoints included. The base URL moves the whole API; there are no per-endpoint URLs (owner, 2026-10-10).
- **[D]** Day-one kinds include OpenAI Chat Completions and OpenAI Responses, Anthropic, and DeepSeek at minimum (its reasoning has agentic quirks). OpenAI Chat Completions is the default, listed first, then Anthropic (owner, 2026-10-10).
- **[D]** The server secret that encrypts keys is generated automatically; setup must be trivial (owner, 2026-10-10).
- **[D]** An instance-wide outbound proxy (HTTP or SOCKS) for every request the harness makes, LLM calls included, with a bypass list of IP ranges that contains the local ranges by default, and a per-connection override as a collapsed advanced option. Local addresses aren't blocked by default: local models are normal (owner, 2026-10-10).
- **[D]** Every LLM request is tracked: uncached input, cache reads, cache writes and output, normalized across providers' reporting quirks. Cost is computed from that by formulas: built in for every supported provider, overridable by users, conditional on model, upstream and context size, with a currency label that's only for display (owner, 2026-10-10).
- **[D]** Later, and deliberately small: connections an admin shares with all or chosen users. Their URL, key and proxy stay hidden; the admin can optionally restrict their models; per-user cost limits are optional. Connections are per user by default (owner, 2026-10-10).
- **[P]** The provider layer's design is in [PROVIDERS.md](PROVIDERS.md).

---

## 10. Web app, platform and stack

### 10.1 Web app
- **[D]** Accessible from a browser and usable remotely (the owner runs it in Docker behind Authelia on their own domain). It must work well on phones for a real release, though not perfectly from day one.
- **[D]** Every view has a URL. Refresh and the back button work.
- **[D]** **Multiple tabs work from day one**, e.g. comparing an old branch in another tab. In-app side-by-side panels come later.
- **[D]** Any number of generations can run at once across chats. You can read or send in another chat while one is generating.
- **[D]** **Nothing is locked during generation.** (ST can't even show group members' cards while generating.)
- **[P]** A running generation uses the context snapshot taken when it started.
- **[D]** Notifications when something finishes elsewhere, like a chat client: badges, plus the tab title and favicon, with optional sound. **[P]** Web push for phones.
- **[P]** The server owns all state. Clients subscribe over a WebSocket. Writes are per entity with a version check, and no client ever writes back a large settings blob.
- **[D]** **Separate users**, each with their own library, chats, connections and settings, as in ST's multi-user mode.
- **[P]** Authentication: works behind a reverse proxy that handles auth, such as Authelia, plus built-in login. Proxy identities map to users.
- **[D]** Built-in login (owner, 2026-10-11):
  - **No sign-up:** accounts are created for people, not by them.
  - **No account, no login:** on loopback, the app works without setting up an account. Most people will use it this way.
  - **Once an account is configured,** loopback requires login too. A setting turns that off; it's on by default, for security. As a security setting, it's set only outside the app (§11).
- **[D]** The details of built-in login (owner, 2026-10-11):
  - **What counts as configured:** a user with a password.
  - **Loopback without login, once accounts exist** (with the setting off), acts as the admin.
  - **Before any account exists,** allowlisted addresses (`ALLOWED_IPS`) work without login too, like loopback. Docker needs this, because there the host's browser connects from the bridge gateway, not loopback.
  - **The first password** is set from inside the app, over that passwordless access. There's no separate bootstrap mechanism.

### 10.2 Rendering
- **[D]** HTML rendering must be possible (ST's HTML "games"). Interactivity will be expanded later, once the harness is agentic.
- **[D]** Per-turn HTML makes the context explode, so recent and older messages need to be shown differently.
- **[P]** Model-generated HTML renders only in a **sandboxed iframe**: no same-origin access, ideally a separate origin, a strict CSP, and a narrow `postMessage` bridge to the harness. This follows AIRI's CVE-2025-59053, where card text rendered as HTML led to RCE through Tauri IPC.
- **[P]** Ordinary messages get sanitized markdown.
- **[P]** Each version has a **display form** and a **context form**: recent turns send the rich form, older ones the compact form (reference-harness's rich/compact split).
- **[L]** Template-bound UI: a persistent "stage" or widget whose state the model updates through tools, so only small state changes enter the context.

### 10.2a Image input (vision)
- **[D]** Users can attach images to their messages, as in any chat interface, and vision models see them (owner, 2026-10-10). It's rarely used in RP, but it must work well and feel integrated. The owner's case: sending drawings to a card-making chat as the source for character and costume designs.
- **[D]** Attaching is direct: drag and drop onto the composer or the chat, paste from the clipboard, and a picker button. ST's "find the right button in a submenu" is the anti-pattern.
- **[D]** No captioning by another model for text-only models, for now. There's no clear reason to send an image to a text-only model in this app.
- **[P]** Attachments belong to the version, so editing or writing a new version can keep, add or remove them. Thumbnails show inline in the message, and a click opens a full-size viewer.
- **[P]** When the chosen model has no vision capability, the composer and the request preview say so before sending, so images are never silently dropped ("Nothing changes silently").
- **[P]** Images are context like anything else, so their token cost and cache effect show in the context view. Older images may need an LCM policy (keep, summarize as text, or drop beyond the verbatim window). **[O]** Which policy, decided with phase 3.

### 10.3 Chat-wide edits
- **[D]** Large edits across a whole conversation, summaries included, such as search and replace to rename a character, and agentic editing to instructions.
- **[P]** A **changeset** is one atomic batch of new versions across slots and summaries, with a title and one entry in the chat's history.
- **[D]** It's applied directly, with no review gate since everything is reversible. Afterwards you can inspect the diff and revert all of it or individual messages. (The earlier "draft, then review" proposal was rejected.)
- **[P]** Scope options: the current path, all branches, or chosen threads; messages, summaries, notes, and card overrides. Drastic rewrites can be applied as a new chat.

### 10.4 Stack reasoning
- **[D]** TypeScript. Rust was considered (smaller memory footprint, no Node, faster startup) but isn't viable today:
  - the Rust LLM crates either own their loop and change often (rig) or are chat-only clients (genai)
  - hot-loading plugins written by an agent is far easier in TS
  - one language lets the macro engine and preset parser run in both browser and server
- **[D]** The provider layer is pi-ai 1.x (owner, 2026-10-10).
- **[P]** pi-agent-core 1.x for the agent loop, with pi-ai underneath (Pi reached 1.0 on 2026-10-01), as in reference-harness, which is on 0.84.2 with a pi-ai patch. Pi's experimental durable-execution package isn't needed: surviving a disconnect only requires running the loop on the server.
- **[D]** Not building on DSH as the host:
  - it's about two months old, with weekly breaking alphas
  - its rule that "model-visible means logged" and its core-service context assembly conflict with separating the timeline from rollouts
  - it has no documented auth
- **[D]** No Cordis (owner, 2026-10-11; evaluation in [CORDIS.md](CORDIS.md)). The plugin threat model and structure are in [PLUGINS.md](PLUGINS.md).
- **[P]** SQLite with FTS5 for the timeline, versions, summaries, rollouts and jobs. JSON files can't handle the version and branch structures.
- **[D]** Performance on chats of any length is an absolute priority: very smooth, never buggy, no corners cut. Looks rank below that but matter a lot (screenshots) (owner, 2026-10-10).
- **[D]** TanStack libraries, Query where it applies (owner, 2026-10-10).
- **[P]** Effect 4 across the server and the client data layer: [EFFECT.md](EFFECT.md). The owner asked for it to be strongly considered.
- **[D]** Client framework: **React** (owner, 2026-10-10). This is one of the main stack decisions, because UI quality for real users matters most; reference-harness's console stack is not the default. Evaluation, and the proposed stack around React: [CLIENT-FRAMEWORK.md](CLIENT-FRAMEWORK.md).

---

## 11. Security

- **[D]** Avoiding RCEs is the top priority.
- **[D]** Running a plugin is the user's conscious choice, and a plugin written by the user's own agent is the user's plugin. Our responsibility is that content (cards, presets, lorebooks, chats, model output) never becomes code. The three lines of attack to weigh: credentials, the user's system, and exfiltrated chats (owner, 2026-10-11; [PLUGINS.md](PLUGINS.md)).
- **[D]** Users are never assumed trusted. One user must never be able to see another user's chats, cards, connections or keys, and that has to be certain (owner, 2026-10-10).
- **[D]** It must be hard to expose an instance by accident. Without a password, an IP allowlist or an auth proxy, the server doesn't listen beyond localhost (owner, 2026-10-10).
- **[D]** The exposure rules (owner, 2026-10-11; built, ARCHITECTURE.md §4):
  - Listening on loopback is always allowed.
  - Beyond loopback, the server starts only with protection: an IP allowlist; proxy mode with named trusted proxies, the only addresses that may then connect, so nobody else can send the identity header; or, once built-in login exists, a password on every user. An allowlist alone is enough, without a password.
  - Peers are checked by each connection's source address, never by a forwarded header, so the check holds in Docker, where the host's requests come from the bridge gateway.
  - The override, `ALLOW_INSECURE_EXPOSURE`, is set only outside the app, like every security setting.
- **[P]** Cross-site requests (built, ARCHITECTURE.md §4; found 2026-10-11): browsers let any page open a WebSocket to the user's own loopback, so before this, any site the owner visited could call every RPC of a local instance. Requests are refused when `Origin` names another site, or when `Host` is a name that isn't the instance's (DNS rebinding). Proxy mode with named trusted proxies skips the `Host` check, since only the proxies can connect. Instances served under a domain name list it in `PUBLIC_ORIGINS`.
- **[P]** Rules:
  - imported cards, presets and lorebooks never execute code, and their fields never grant capabilities (a file can't enable tools or plugins by itself)
  - model and card HTML renders only in a sandbox
  - API keys are write-only
  - tools with external effects need approval
  - plugin installation is always confirmed
- Reference incidents:
  - **AIRI** (CVE-2025-59053): card text rendered as HTML, leading to RCE through Tauri IPC.
  - **Marinara Engine** v2.0.9–v2.3.3: undisclosed. The fix removed its extension system and stopped imported agent files from granting themselves tool access.
  - **ST's 2026 CVEs**: in its CORS proxy and SearXNG proxy (SSRF/XSS) and extension deletion. Don't ship open proxies.

---

## 12. Later / meta

- **[L]** Agent-driven configuration: the agent edits or imports presets, sets up chats and modes, writes plugins.
- **[L]** Plugin system, and the harness extending itself from within.
- **[L]** Template-bound interactive UI (§10.2).
- **[L]** Per-character agent memory and private state (§7.1).
- **[L]** Internal side-by-side panels.
- **[L]** A native app as a thin client to the user's server (a wrapper around the same frontend, not a standalone app). Low priority, and it must not constrain the design (owner, 2026-10-10).
