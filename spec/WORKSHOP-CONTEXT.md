**Built/superseded worklcm1 (2026-11-13):** The owner closed WORKSHOP §10 question 4: “the agent NEEDS LCM summaries. It was INVENTED FOR CODING AGENTS.” ARCHITECTURE §16, “Workshop transcript summaries”, replaces §2's old default elision/timeline-only summary policy: new workshops enable model-sized LCM, completed summaries include agent steps, a run compacts before its next request, and tool results share an aggregate turn budget. The `summaries` marker in §4.2 is now filled. These implemented portions and §7 question 2 are obsolete as implementation proposals. The skills markers and creation pickers were built by wsb2 (2026-11-15, §6) and are obsolete as proposals too.

# Workshop context: window, long runs, history tools, the preset

**Status**: Proposed, 2026-11-12 (job `workctx1`). A delta to [WORKSHOP.md](WORKSHOP.md) §2.4 and §10 question 4, [LCM.md](LCM.md) and [AGENTIC.md](AGENTIC.md) §4.5, and to reference-harness on branch `latest` (`9b385944`): its ARCHITECTURE §9b, `spec/SUMMARY-LAYER-BUDGET.md`, `spec/TOOL-RESULT-BUDGET.md`, `spec/RESUMABLE-SESSIONS.md` §12 and `spec/SESSION-RECORDS.md` §5. Items are marked as in DESIGN.md: **[D]** the owner said it (quoted), **[P]** proposed, **[O]** open. The parts built by `workctx1` are listed in §6 and documented in ARCHITECTURE §16 ("Workshop context"); their text here is obsolete as an implementation proposal and stays as the design record.

The owner, 2026-11-12, on this work (the brief's quotes; these are the only **[D]** items here):
- **[D]** "We're building a generic agent, just focused and scoped on working for our harness. People will use it for more than just making plugins, and making/editing cards and libraries (those are the main use cases, though). It can't be too rigid, but it should be easiest for those things."
- **[D]** "Being a coding/work agent, it will need a different preset, potentially with different structure."
- **[D]** "LCM/Hierarchical summaries however very much fit, more than the roleplay-agents, since they were invented for coding agents. We have to make sure we have the LCM tools for context/summary expansion and message search. Miku should have them, but we don't necessarily want everything to be the same, since our app is different. … These tools would also exist for agentic RP."
- **[D]** "32768 is nothing for an agent", and the context limit is "a model-related setting".
- **[D]** "Why would we ever limit context to 4096 by default?"
- **[D]** "Workshops still have a card you're talking to… it can just be a regular card. We will likely supply some default ones of our own."
- **[D]** "It should definitely be possible to 'convert' an existing chat preset to workshop however."
- **[D]** "The workshop persona selection is separate from the RP persona selection. They should be independent."

## 1. The context window comes from the model

### 1.1 What the code does (verified 2026-11-12, master `44c46181`)

- The budget's context size is `min(preset samplers.openai_max_context, model window)` (`assembler/budget.ts`), but the preset's own samplers never reach it: `withModelSettings` (`@dreamspan/shared/modelSettings.ts`) replaces them with `DEFAULT_SAMPLERS`, then the model's window (`openai_max_context = window`), then the model's own settings. So a workshop and a story both use **the chosen model's window**, unless the model's settings lower it ("Context to send", whose placeholder reads "All of its window").
- The window comes from `resolveModel` (`@dreamspan/shared/providers.ts`): the user's value, a limit learned from a provider error, the provider's model list, a catalog match, else **`ASSUMED_CONTEXT` = 128,000 tokens**, with source `unknown`. The model editor shows that value as "(assumed)", and the context inspector's budget origin says "assumed: nothing reports this model's size".
- **Where 4,095 came from.** The server test helper `generateReply` (`test/support/generation.ts`) writes a whole imported ST preset's samplers into the fixture model's settings, ST's default `openai_max_context: 4095` included ("Explicit fixture model settings preserve the old test scenarios; production imports never do this"). Workshop tests that set up their model with it inherit 4,095; W6's note and the W5 fixtures' explicit 32,768 both come from there. In production a model only carries a context setting the user set, or one imported from an ST preset file that has the key (`formats/presetSettings.ts` copies only keys the file has).
- **RP chats** use the same path, so they don't have a defect of their own. Nothing in RP behaviour changes here.

### 1.2 The reply reserve for agent turns [P]

- Today every turn's reply length, without a model setting, is `min(model's max output, 4,096, half the context)` (`DEFAULT_RESPONSE`): a story reply's size. The reserve is also what's sent as `max_tokens`. An agent turn that writes a card through a tool call, or thinks first, needs more: thinking counts towards `max_tokens` on Anthropic.
- **[P]** A planner says how its turns size the reply: `assembly.response = "model"` (the workshop planner) takes the model's own max output, within a quarter of the context size. The model's own response-length setting still wins, as for every chat. Example: Claude with a 200,000 window and 64,000 max output reserves 50,000; a model with an assumed 128,000 window and no reported max output (`DEFAULT_MAX_OUTPUT` 4,096) reserves 4,096. Story planners keep the story rule byte for byte.
- No workshop-specific fixed number exists anywhere: the window, the max output and the quarter are the model's and the window's.

### 1.3 Showing the fallback where the model is chosen [P]

- The model picker (the composer's chip and the Model tab share it) gets the window on each row's last line: "200k context · used 3 min ago", or "128k context (assumed) · never used" in the warning tone when nothing reports it. The row's hover explanation says: "Context window: 128,000 tokens, assumed: nothing reports this model's window. Set it in Settings → Connections."
- The model editor keeps its "(assumed)" cell; the inspector keeps its budget origin.

### 1.4 No 4,095 default anywhere

The owner's question ("Why would we ever limit context to 4096 by default?") settles that no default caps the context. Each place the number appears:

| Where | What it was | Now |
|---|---|---|
| `@dreamspan/shared/modelSettings.ts` `DEFAULT_SAMPLERS.openai_max_context` | 4,095, replaced by the model's window before use | 128,000 (`ASSUMED_CONTEXT`'s size), still replaced by the window; no path reads it uncapped |
| `formats/presetSettings.ts` (an ST preset file imported onto a model) | The file's `openai_max_context` copied as the model's "Context to send" | **[P]** A file whose value is exactly ST's default, 4,095, is taken as nobody's choice: the key is dropped and the import report says "The preset's context size was SillyTavern's default (4,095 tokens), so the model's own window is used." Any other value is the user's and is kept. Example: an exported preset with 4,095 leaves a 200k model at 200k; one with 16,384 sets 16,384 |
| `server/formats/preset.ts` `DEFAULT_SAMPLERS` | A preset document's samplers, 4,095 | Unchanged: preset samplers never reach assembly (§1.1), and ST export writes them back as ST expects |
| `test/support/generation.ts` `generateReply` | Writes a full ST preset's samplers (4,095 included) into fixture models | Unchanged: it preserves the old scenarios, and new workshop tests set models up without it |

`DEFAULT_RESPONSE` (4,096) is a story reply's length, not the context; §1.2 covers agent turns.

## 2. Long workshop runs

### 2.1 reference-harness, and the deltas

| reference-harness (`latest`) | Here | Why |
|---|---|---|
| Reply-to-continue resumes a completed session's rollout (RESUMABLE-SESSIONS §4–§9); session records later replaced it as the default (SESSION-RECORDS §2) | Every workshop turn carries on the previous run (`resume_previous`, built W5; DESIGN §7.7 [D]) | The workshop is one long piece of work with one user |
| **No compaction**: a resumed session near its ceiling re-parks (`failed-resumable`); the spec names "eliding old tool *results* while keeping assistant turns and tool-call args" as the least-bad first cut (RESUMABLE-SESSIONS §12) | **Elide old tool results first** (§2.3), then a fresh build with the summaries (§2.4) | Keeps the "what I did" narrative and the cache prefix before the first elided result |
| Tool-result shaping: a per-result cap (16,384 tokens) and a per-turn aggregate clamp against the context left, less a 32,768 reserve (TOOL-RESULT-BUDGET §3–§4) | The per-result cap is built (16,000 characters, `budgetResult`). **[P]** The aggregate clamp, against this turn's window less the reply reserve, comes later (§2.5) | A carried workshop starts each turn below the trigger, so a turn's runway is the trigger's margin |
| `read_session_transcript(session_id, query?, range?)`: calls with arguments, results clipped per the result budget (SESSION-RECORDS §5) | **`read_run { message, call?, query? }`** (§3.2): a message's run steps with their results | The way back for an elided or summarized-away result |
| Summary layer budget with absorb-and-regenerate (SUMMARY-LAYER-BUDGET §3) | The built LCM (LCM.md), now allowed in workshops (§2.4) | Already built and tested at scale |

### 2.2 Three stages, cheapest first [P]

For a turn whose previous run can be carried (the W5 checks pass), with `room` = the context maximum less the reply reserve, and the carried request counted by the model's tokenizer (`CountRolloutContext`, built):

1. **Carry** while the carried request is at most **¾ of `room`**: the previous request plus its whole transcript plus the new message, every request a cache read up to its new tail (built W5, now with a trigger below the hard limit so the turn has runway for its own tool results).
2. **Elide** past ¾: older tool results in the carried transcript are replaced, oldest first, by a marker, until the count is at most **½ of `room`** (the hysteresis LCM's keep/trigger use, LCM.md §2.6). The calls, their arguments, the assistant's text and reasoning, and `send_message` results stay. The last turn's results are never elided. The new rollout stores the elided transcript, so the next turns carry it unchanged and read it from cache.
3. **Build fresh** when eliding can't reach ½ (the conversation itself, not its tool results, outgrew the window): the built fallback, the preset, the card, the summary layer when summaries are on (§2.4), the timeline's messages and one line of steps per message (`workshop-step-summaries`, now naming the message's number, §3.2). The rollout after it carries on from that new base.

**Built review correction (review-workctx1):** The selected model's tokenizer checks replacement batches, including the final half-window admission. A character estimate cannot accept a carry above that target. A request above the trigger with no eligible older results also builds fresh. These implementation details are obsolete as a proposal; see ARCHITECTURE §16, "Context review".

Cache: stage 1 breaks nothing. Stage 2 breaks the cache once, from the first elided result on; everything before it (the preset, the card, the history and the transcript up to there) stays a cache read. Stage 3 breaks it once after the preset and card. With ½ as the target, the next break comes after another ¼ of the window of new work. Example with a 200,000 window and a 50,000 reserve: room 150,000; carry to 112,500, elide to 75,000, so about 37,500 tokens of tool traffic between cache breaks.

The marker, model-facing: `[Result left out to save room. read_run with message 12 and call "toolu_01…" shows it again.]`. The inspector's request line says "Older tool results were left out to make room (9 results); the rest was carried on from the previous turn's run", with the parent link.

### 2.3 What is never lost [P]

- **Tool results.** The originals stay in the run that produced them (`rollouts.transcript`; every rollout is kept), and `read_run` reads them there: a marker names the message and the call. A summarized-away message's steps are found through `search_chat` / `search_summaries` and its number, then `read_run`.
- **Changes.** Library and setup changes keep their receipts and undo records (W3); eliding their results changes nothing in them.
- **Messages.** Elision never touches a message; a fresh build keeps every message verbatim or under a summary (LCM invariants 2 and 4).

### 2.4 Summaries in workshops [P]

- The workshop kind profile allows summaries (`allowsSummaries: true`), and `CreateWorkshop` starts LCM as new story chats do: from the user's default (`newChatLcmSettings`), which is on unless the user turned it off (LCM.md question 4's recommendation). The Summaries tab and switch appear in workshops through the same profile check.
- Summaries are written exactly as in stories: through the chat's preset (the Workshop preset) with the summarization tail, idle while the cache is warm. They cover the timeline (the messages), not tool results; the step lines stay out of the summarized text (§7 question 2).
- They enter only a fresh build (stage 3); a carried request keeps its frozen request and history, so a summary landing meanwhile never rewrites a cached prefix (LCM invariant: "a running generation keeps the summary selection it started with").

### 2.5 Later [P]

- The per-turn aggregate clamp of TOOL-RESULT-BUDGET §4, against this run's window, so one turn of many large reads can't outgrow the window before its next request. Until then such a turn fails with the provider's context error, and the learned limit makes the next turn rebuild.
- Compacting inside a running turn (stage 2 between two requests of one run).

## 3. History tools for agents

### 3.1 What exists, and reference-harness's names

| Here (built, AGENTIC §4.5) | reference-harness | Bound here | Bound there |
|---|---|---|---|
| `search_chat { query, speaker?, limit?, before_message? }`, the chat's full-text index (`versions_fts`, the index `job/review-search` built message search on; reader `SearchChat`) | `search_messages` (FTS, `limit` ≤ 200, default 30) | ≤ 20 results (8), 240-character excerpts: about 1,600 tokens | 6,000-character bodies, 200,000 characters in all, then one-line snippets |
| `read_messages { from, count? }` | `read_messages` | ≤ 20 messages, the 16,000-character result cap | Its paging |
| `expand_summary { messages: "120–180", max_tokens? }`: children, or a first-level summary's messages | `expand_summary { id, depth?, include_messages?, token_cap? }` (depth ≤ 3, cap 4,000) | One level, `max_tokens` 200–8,000 (2,000), at least one part, "N more left out" | Depth and token caps, "N more constituent(s) omitted" |
| `search_summaries { query, limit? }` | `search_summaries` (FTS over summaries) | ≤ 20 (5), excerpts | Its paging |
| — | `read_session_transcript` | `read_run` (§3.2) | Results clipped per the result budget |

Summaries are named by the messages they cover here, not by an id, because the layer the model reads shows `from` and `to` (LCM.md §2.9). That stays.

### 3.2 `read_run` [P]

`read_run { message, call?, query?, from_step?, max_tokens? }`, effect `read`, no capability (it reads the chat's own run):
- `message`: the number of a message the assistant wrote, before the one being generated. The result is that message's steps as its steps row shows them (`placedSteps` over its run's stored transcript, cut at that message): `Step 3, read_card {"card":"Mara"}: <result>`.
- `call`: only the step with that tool call id (what a §2.2 marker names). `query`: only steps whose arguments or result contain all the words. `from_step`: start there.
- Bounded: `max_tokens` 200–8,000 (2,000), at least one step, then "[N more steps: read_run with from_step=K.]"; each step's result is already within the 16,000-character cap.
- Causal: the message must be on the generating version's path before it; its segment ends at its own post, so later messages of the same run are never read.

### 3.3 Where they're offered [P]

- **Workshops**: the workshop planner offers `search_chat`, `read_messages`, `expand_summary`, `search_summaries` and `read_run` with the library and setup tools. Workshop variants (`kindTools`, `workshop:<id>`) say "this conversation" where the story versions say "the story"; they run the same code.
- **Agentic story chats**: `read_run` is a registered rollout tool like the others, offered when the chat's Tools list includes it. It isn't added to the story planner's default list, so story requests keep their bytes (§7 question 1).
- **Side chats** (W9, `job/review-workshop9`, not merged at `44c46181`): its `search_story`, `read_story`, `open_story_summary` and `search_story_summaries` wrap these same tools at the story's position (its current branch's newest message, read anew for each call). `read_run` over the story is not offered there.

**What a side chat's model sees** (from W9's code on `job/review-workshop9`; a worked example). The user opens a side chat beside the story "The Skerry Light" at message 412 and asks "Did Mara ever say where the key is?":
1. The side chat's own request is a workshop request: the Workshop preset (or the one bound in the side chat), the assistant card (§4.3), the workshop persona (W9 makes side chats through `CreateWorkshop`, so they take §4.3's persona once both are merged), the side chat's own messages and the workshop instructions with the side-chat paragraph. The story's preset, its cards and its messages are not in it.
2. The model calls `search_story { query: "key Mara" }` (capability `chats.read`, on by default in a side chat). The tool reads the story's current branch to its newest message, and returns lines as a tool result: `Message 388, Mara: …the key is under the third step…`, pages of at most 15,000 characters, then `[More: repeat with offset=15000.]`.
3. It calls `read_story { from: 386, count: 5 }` and gets those messages verbatim, as `Message N, Speaker: text` blocks.
4. Those results are ordinary tool results in the side chat's run: carried, elided (§2.2) and read again (`read_run`) like any other. Nothing in the story changes, and the story's own requests never see the side chat.
- Dynamic tool loading (`tool_search`, `load_skill`, `job/toolload1`) decides which of these are immediate; these are registered the ordinary way.

### 3.4 Causal order

**[D]** (DESIGN, rules): a generated message sees only what precedes it. Every tool here reads the path to the message before the generating one (`ToolContext.leafSlotId`), in the generation's fork, with each message as that fork shows it. A regenerated middle message never sees the messages after it, nor their runs.

## 4. The Workshop preset, card and persona

### 4.1 Before this work (verified at `44c46181`)

The seeded **Workshop** preset is an ordinary library preset (`entity_revisions.origin = 'import'`, `origin_ref = builtin:workshop-preset@1`), bound by `preset.binding` in each new workshop: the user edits it in the preset editor, or binds another preset from the chat's Model tab. Its order is Main, Definitions (the Assistant card), Chat history and Newest message; the workshop instructions come from the registered `workshop-instructions` stage after `end-of-request`, overridable by a `workshopTurn` prompt. New workshops took the story default persona (`chat.persona`).

### 4.2 Structure [P]

| Piece | What | Where it comes from |
|---|---|---|
| Main | Who the assistant is and what the app is | The preset's `main` prompt |
| Assistant | The card the user talks to: its description, personality and the rest of its card slots | `charDefinitions` and the other card markers, as in a story preset. **[D]** the card stays ("it can just be a regular card") |
| Workspace instructions | The user's standing instructions for working in this app ("my cards use second person", "never touch presets marked Final"), as reference-harness's `AGENTS.md` | A prompt, `workspaceInstructions`, whose text is the user's own |
| Summaries | Where the summary layer goes | A marker, `summaries`; until the assembler fills it, the layer goes before the history as in stories |
| Skills | The installed skills the assistant can load, each with what it's for | A marker, `skillsIndex` (built, wsb2) |
| Card skills | The names of the skills the assistant's card carries; their instructions reach the model only once the user allows one | A marker, `cardSkills` (built, wsb2) |
| History | The conversation | `chatHistory`, `newestMessage` |
| Workshop instructions | Tools, contract, what's turned off | The `workshop-instructions` stage |

The pieces are ordinary prompt entries a preset can move, turn off or leave out (`workshopPieces` in `@dreamspan/shared/workshopPreset.ts`). The seeded preset is now `builtin:workshop-preset@2`, with the four added pieces present and **off**, so what it sends is what @1 sent; users who already have @1 keep it (seeds are made once). A story preset bound in a workshop still works: its card slots fill from the workshop's card.

### 4.3 The workshop's card and persona [P]

- **Seeds are a registry** (`workshopSeeds`, `db/workshopSeeds.ts`): each seed is a card or a preset, made once per user as an ordinary library item; the one marked default of each kind is what new workshops start with. More assistant cards are added as entries ("We will likely supply some default ones of our own"). The registry is read in the writer worker, so a plugin's registration on the main thread doesn't reach it yet.
- **The card** is any card. `CreateWorkshop { card? }` starts with the chosen one (its greeting is the first message), else the default. Afterwards the Cast tab changes it as in any chat (Join the new card, Leave the old one). The start card's Assistant choice picks it for that workshop (built, wsb2).
- **The workshop persona** **[D]** is independent of the story default. `workshop.defaults.persona` holds it. The first workshop makes one, a persona card named after the account's display name (`builtin:workshop-persona@1`); it is never made again, also after the user clears or deletes it (no persona then). A persona's menu has "Set as workshop persona" / "Clear workshop persona" beside the story default's item; neither changes the other. `CreateWorkshop { persona? }` starts one workshop with another; changing the persona in a workshop's Cast changes only that workshop. Example: the story default is Tobin; the user sets Ana as workshop persona; a new story starts as Tobin, a new workshop as Ana, and switching that workshop to Tobin leaves the next workshop as Ana.

### 4.4 Converting a story preset [D capability, P details]

"Convert to workshop" in the preset editor makes a **new** preset from the preset's saved version; the original never changes.
- The dialog lists the preset's pieces the user decides about, in its order. Story pieces (persona description, example dialogue, scenario, enhance definitions, the NSFW prompt, post-history instructions) default to **Drop**, each with why. The preset's own other prompts default to **Keep**, and a kept one can be reworded in place. Main, the card's pieces, the history and the lorebook positions always stay.
- The workshop pieces (§4.2) are added after the card, off, except Workspace instructions when the user writes some in the dialog.
- "Make preset" creates it (`ConvertPresetToWorkshop`, origin `user`) and opens it in the editor. Converting a converted preset adds nothing twice.

**Built review correction (review-workctx1):** Converting an existing workshop preset applies the supplied replacement workspace instructions, including explicitly clearing them. The dialog opens with the source's instructions. Its open state is in the URL and its form edits are private user drafts, in both editors, so reload restores the work. See ARCHITECTURE §16, "Context review"; this subset is obsolete as an implementation proposal.

## 5. Stored data

No new tables or columns: elided transcripts are ordinary `rollouts.transcript` values, the continuity record in the snapshot gains `elided` (a count), and `read_run` reads existing rollouts. The user setting `workshop.defaults` gains an optional `persona` (absent: never chosen; null: none). No baseline change.

## 6. Built (workctx1)

- §1.2 (`assembly.response = "model"`), §1.3 (the picker's window), §1.4 (no 4,095 default), §2.2–§2.4 (the trigger, elision, workshop summaries), §3.2–§3.3 (`read_run`, the workshop's history tools and their variants), step lines with message numbers, §4.2's pieces in the seeded preset (off), §4.3 (seeds registry, card and persona at creation, the workshop persona and its menu items), §4.4 (the conversion and its dialog). See ARCHITECTURE §16, "Workshop context".
- Built (wsb2, 2026-11-15; obsolete as proposals, ARCHITECTURE §16 "Workshop skills in every mode"): the `skillsIndex` and `cardSkills` markers, filled with the run's skills where the preset has them on (the seeded preset keeps them off); the start card's Assistant and You choices, kept in the URL, for that workshop only. The `summaries` marker was filled by worklcm1.
- Not built: §2.5.

## 7. Open questions

1. **Should story agent replies offer `read_run` by default?** Example: a story with tools on, where the narrator looked up a lorebook entry three replies ago; with `read_run` it can read that lookup again instead of searching again. Adding it changes every story agent request's tool list (one more definition, about 150 tokens, read from cache). **Recommendation:** not by default; it's in the chat's Tools list for those who want it.
2. **Should workshop summaries include each message's steps?** Example: "Created the card Mara Quill; started the chat The Skerry Light" in the summarized text makes the summary say what was done, not only what was said, at the cost of reading each message's run when summarizing. **Recommendation:** yes, in a later unit; today a summary covers the messages, and `read_run` reaches the steps.
3. **Are ¾ and ½ of the room the right trigger and target?** Example: with a 200,000-token window, carrying until 112,500 and eliding to 75,000 breaks the cache about every 37,500 tokens of tool traffic; ⅞ and ¾ would break it half as often but leave a turn only 18,750 tokens of runway before the provider refuses. **Recommendation:** ¾ and ½, as LCM's trigger and keep.
4. **Resolved [D], owner's review brief, 2026-11-12:** The first workshop creates its persona in the same transaction; it is never recreated after clearing or deletion. Its selection is independent of the RP default in both directions. Built; obsolete as an implementation proposal.
5. **Resolved [D], owner's review brief, 2026-11-12:** Only an exact imported ST preset context of 4,095 is dropped. Other values, and deliberate model settings including 4,095, are retained. Built; obsolete as an implementation proposal.
