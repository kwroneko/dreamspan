# Dynamic tool loading: tool_search, load_skill and card skills

**Status**: Implemented portions obsolete as proposals (§2–§7, §10, §11.1(b), §15–§16), reviewed 2026-11-13 (`review-toolload1`); provider research and the OpenRouter wire 2026-11-13 (§8.1, §8.2, §13); ARCHITECTURE.md records the implementation. Remaining choices are **[P]** unless they quote the owner. It is a delta from the build at master `44c46181` (agent session `agent/session.ts`, provider transforms `providers/builtins.ts`) and from reference-harness on branch `latest` (`src/agent/declared-tools.ts`, `src/tools/tool-search.ts`, `src/tools/load-skill.ts`).

The owner: "we obviously need toolsearch (that *doesn't* break the cache) and skills like reference-harness does. We can't load all tools at once." And: "This MUST actually be tested with each provider. It will not work consistently out of the box." And on cards: "workshops still have a card you're talking to. It would either supply personality or specific skills/agent defs etc, but it can just be a regular card. We will likely supply some default ones of our own."

This replaces WORKSHOP §1.2's "Skills … Not taken" row and AGENTIC §1.2's "dynamic tool loading" exclusion, for workshops only.

## 1. What changes

A workshop run sent all 28 tool definitions on every request: 4,241 tokens (o200k) for 27 tools plus `send_message`. With loading, a run on a supported wire starts with `list_library`, `tool_search`, `load_skill` and the reply tool: 424 tokens, the skill index included (`test/toolLoading.test.ts`, "sends far fewer tool tokens"). The rest are loaded when the assistant needs them, without rewriting the cached prefix.

RP runs are unchanged: their profile keeps every tool immediate (§2), so their requests are byte for byte what they were.

## 2. Profiles: what each chat kind sends from the start

Registry `ExecutionRegistry.toolLoadingProfiles`, keyed by chat kind: `{ id, immediate: patterns }` (`name` or `prefix*`).

| Kind | Immediate | Why |
| --- | --- | --- |
| `rp` | `*` | RP toolsets are small and chosen by the user (AGENTIC §1.2) |
| `workshop` | `list_library` | Finding things is every workshop's first step; everything else is in a skill |

A tool not matched is deferred, including a plugin's new tool: a plugin adds its tool to `immediate` by registering a replacement profile. The loaders are never deferred. A kind without a profile defers nothing.

## 3. Wires: where deferred tools are carried without breaking the cache

Registry `ExecutionRegistry.toolLoadingWires`, keyed by wire API: `{ id, supports(target), declaresDeferred }`. If the run's model has no supporting wire, nothing is deferred and the request is exactly today's. That is the default for every wire until it is measured live (§8).

| Wire | Supports | How a load is sent |
| --- | --- | --- |
| `anthropic-messages` | connection kind `anthropic` only; measured Sonnet/Haiku 4.5 and Sonnet/Opus/Haiku 5.5, including dated aliases | Every tool declared on every request; deferred ones get `defer_loading: true`. The cache marker pi-ai puts on the last tool moves to the last immediate one (a deferred tool can't carry it). The loading call's `tool_result` becomes `tool_reference` blocks only; its text moves after the message's tool results (the API refuses the two mixed: measured, §8) |
| `openai-completions` (OpenRouter) | connection kind `openrouter`, model `anthropic/claude-sonnet-4.5`, `-haiku-4.5`, `-sonnet-5.5`, `-opus-5.5` or `-haiku-5.5`, with the model's routing pinned to one upstream: `anthropic` or `google-vertex` (any region). Unpinned, Bedrock-pinned and every other model: nothing | Every tool declared on every request; deferred ones get `function.defer_loading: true` and the flags never change. pi-ai's cache marker on the last tool moves to the last immediate one (with it on a deferred tool OpenRouter returns 400 "Provider returned error": measured). The loading call's tool message gets the loaded definitions appended as text, after the heading "Loaded tool definitions (call them by name):", one JSON line `{name, description, parameters}` each; the model then calls the declared tools by name |
| `openai-responses` (OpenAI direct) | provider `openai`, kind `openai-responses`; exact GPT-5.4, mini and pro; no dated snapshots; never nano (§16) | Only immediate tools top-level. After the loading call's `function_call_output`: a `tool_search_call` / `tool_search_output` pair (`execution: "client"`) with the loaded definitions, `defer_loading: true`. A later `function_call` of a loaded tool gets `namespace` = its name |
| dispatcher fallback | Direct OpenAI Chat exact `gpt-5.4-nano` / `gpt-5.4-mini` (§16), plus §15’s existing profiles | Constant immediate tools plus `call_tool`; loaded definitions as result text |
| every other wire and host | nothing, except §15’s measured dispatcher profiles | Every tool from the start |

The transforms are `providers/toolLoading.ts`, registered first in `providers/builtins.ts` so the breakpoint transforms see the final tools. They act only when the session passes `toolLoading` in the stream options. Why OpenRouter's Claude gets definitions as text, not `tool_reference` or a reveal: §8.2.

**Built, reviewed 2026-11-13 (obsolete as a proposal):** Operation tools retain their original schemas in the frozen offer and validation. The replaceable `openrouter-openai-tool-schemas` compatibility shim applies `portableParameters` (`providers/toolSchemas.ts`) only to OpenAI models on OpenRouter Chat Completions: a `pattern` with a Unicode property escape (`\p{…}`, `\P{…}`) is left out of the wire copy, and a schema that isn't an object becomes an empty object schema. Other providers' request bytes remain unchanged. OpenAI's models through OpenRouter refused both with 400 "Provider returned error" (measured on `openai/gpt-5.4-nano`: `create_preset` and `create_lorebook` carried `^\P{Cc}*$`, `read_settings` had no `type: "object"`). The app still checks arguments against the full schema, so a name with a control character is still refused, by the app instead of the provider.

## 4. The loaded set comes from the transcript

A loading tool's successful result stores `details.loaded` (names). Only a result matching an earlier `tool_search` or `load_skill` call is a load point; unrelated and orphan results are ignored. The loaded set at any point is the deferred names some successful loading result names (`loadedSet`, `loadPoints` in `agent/toolLoading.ts`), as in reference-harness. Nothing else stores it, so resume, step edits and carried turns load the same tools at the same points:

- Editing a load result's text keeps its `details`: the load stays.
- Editing a loading call's arguments runs it again under a new id: a new load.
- A capped last request (sent without tools) carries no load points.

A call to a deferred tool before it's loaded returns, as an error result: “read_card” isn't loaded yet. Load it with tool_search or load_skill first.

## 5. The loaders and skills

- `tool_search { query, max_results? }`: `select:a,b` loads exact names; other words search names (weight 3) and descriptions (1), up to 5. Its description lists the deferred tools no skill covers.
- `load_skill { name }`: returns `<skill name="…">instructions</skill>` and loads the skill's tools. Its description is the skill index, frozen with the run's tools.
- Both are `read` tools. Search and registered skills need no extra capability; a card-carried skill requires `skills.card` approval. Loading grants nothing: a loaded tool still goes through the offered-tools check, capability standing, approvals and receipts. Only tools in the run's frozen offer can be loaded, and an Off capability's tools aren't in it.
- Skills are registry entries (`ExecutionRegistry.skills`, `agent/skills.ts`): `{ id, label, description, instructions, tools: patterns, kinds?, always? }`. Built in: `cards`, `presets-lorebooks`, `this-workshop`, `library`, `chat-setup`, `stories`, `settings`; together they cover every workshop tool (tested). A side chat's story tools are immediate rather than in a skill (merge-batch9). A skill is listed in a run only when it loads a deferred tool there, or has instructions only.

## 6. Card skills

A card carries skills in `extensions.dreamspan.skills` (format **[P]**), which other apps keep on export and ignore, like any extension:

```json
{ "extensions": { "dreamspan": { "skills": [
  { "use": "cards" },
  { "name": "proofread", "description": "Checks a card's spelling.",
    "instructions": "Read the card, then list each typo with its field.", "tools": ["read_card"] }
] } } }
```

- **[D]** The built-in skills are offered in every workshop, whatever card it uses; a card's own skills come on top. The owner, on tying them to the seeded Assistant card: "This is backwards it breaks the user's ability to swap characters for the workshop bot entirely, unless he manually moves the skills." Nothing is written onto the seeded card.
- `{ "use": id }` names a registered skill registered with `always: false` (a plugin's opt-in skill): it is offered only when the workshop's card names it. Naming an always-offered skill changes nothing.
- A card's own skill: name `^[a-z0-9][a-z0-9_-]{0,47}$`, description and instructions required; at most 16 entries; anything else is ignored.
- Which cards: those the assistant speaks as at the revisions the request was assembled with; cards played by the user (persona) are left out. Read once per fresh run. All offered skills, including registered skills, are frozen in the existing snapshot field `agent.cardSkills`; loading never reads the current registry. Unlisted skills cannot be loaded.
- Registered skill names are reserved even when not selected. Duplicate card-carried names are omitted from the offer, independent of card order; their tools remain searchable.
- Card skills only name tools, never grant them: their patterns match only the run's offer.
- The model sees only a validated skill name and a fixed approval notice before approval, with no imported description or source-card name in the index. Model-facing `read_card` results omit the skills extension; stored cards and exports retain it.
- An imported card is untrusted: loading one of its own skills needs the new capability `skills.card` (“Use skills from cards”, default Ask first). The approval shows the skill's description, instructions and the tools it loads. The workshop chip lists the capability whenever the kind loads tools as it goes.
- Card or skill changes between turns rebuild the request with a fresh transcript and catalog; this intentionally changes the prefix once. Carrying old loads into a different offer would be incorrect. Resume and step edits retain the frozen skills and definitions. Model changes already rebuild through the existing continuity checks.

## 7. Inspector

`GetRunTranscript.tools[]` gains `deferred`, `loadedBy` (the loading call's id) and `tokens` (the definition's size, counted with the run's model's tokenizer where the app has one). The run's Tools list groups them: "Sent from the start", "Loaded during the run" (each with the loader that loaded it) and "Never loaded", each heading with its tool count and tokens. A run with nothing deferred shows one group, "Available to this run". E2E: `e2e/toolLoading.spec.ts`, layout audit on the list at 1440/390, light and dark.

## 8. Live measurements (2026-11-12)

`test/live/toolLoading.test.ts`: one workshop reply of six requests: two `list_library` calls, a `load_skill("cards")`, then two `read_card` calls. Numbers are provider-reported input tokens. "Read after load" is the cache read of the first request whose history holds the load, against the whole input of the request before it.

| Target | Loading | Before the load (read/input per request) | Read after load | Tool list bytes | Result |
| --- | --- | --- | --- | --- | --- |
| Anthropic, claude-haiku-4-5 | yes | 0/7821 (write 7729), 7729/7980, 7975/8135 | 8130 of 8135 | same on all 6 | pass |
| Anthropic, claude-sonnet-4-5 | yes | 0/4647, 4555/4797, 4792/4938 | 4933 of 4938 | same on all 6 | pass |
| Anthropic, claude-sonnet-5-5 | yes | 0/10860 (write 10738), 10738/11103, 11101/11256 | 11254 of 11256 | same on all (31 tools) | pass |
| Anthropic, claude-opus-5-5 | yes | 10738/11074, 11072/11226 | 11224 of 11226 | same on all (31 tools) | pass |
| Anthropic, claude-haiku-5-5 | yes | not recorded | 11368 of 11370 | same on all (30 tools) | pass |
| OpenAI Responses, gpt-5.4-mini | no (disabled after review) | NOT TESTED live (2026-11-12) | — | — | golden wire test only |
| Anthropic on Bedrock | no (no wire) | NOT TESTED live (2026-11-12) | — | — | nothing deferred |
| Vertex | no (no wire) | NOT TESTED live (2026-11-12) | — | — | nothing deferred |
| OpenRouter → anthropic/claude-haiku-4.5 | no (all tools) | each request read the previous one (13151/13156 …) | — | same | pass (baseline) |
| OpenRouter → openai/gpt-5.4-nano | no (all tools) | first request 400 "Provider returned error" | — | — | fails without loading too: not caused by this change |
| DeepSeek, deepseek-flash | no (all tools) | 8960/9180, 9088/9310, 9344/9590 | — | same | pass (baseline) |

Found by measuring: Anthropic rejects a `tool_result` holding both `tool_reference` and text ("Tool definitions/code execution functions cannot be mixed with other content"); §3's text move is the fix.

### 8.1 Through the app, 2026-11-13

The same test, with OpenRouter models pinned as the model page's routing setting pins them (`routing: { only: [upstream], allow_fallbacks: false }`). Every target passed.

| Target | Loading | Before the load (read/input) | Read after load | Tool list bytes | Result |
| --- | --- | --- | --- | --- | --- |
| OpenRouter → claude-haiku-4.5, pinned `anthropic` | yes | 7727/7732, 7968/7973 | 8050 of 8055 | same on all 6 (30 tools, 26 flagged) | pass; `read_card` called twice |
| OpenRouter → claude-sonnet-4.5, pinned `anthropic` | yes | 7727/7732, 7962/7967 | 8103 of 8108 | same on all 6 | pass |
| OpenRouter → claude-sonnet-5.5, pinned `anthropic` | yes | 10732/10734, 11002/11004 | 11153 of 11155 | same on all 6 | pass; `read_card` called twice |
| OpenRouter → claude-haiku-4.5, pinned `google-vertex` | yes | 7727/7732, 7967/7972 | 8052 of 8057 | same on all 6 | pass |
| OpenRouter → claude-sonnet-4.5, pinned `google-vertex` | yes | 7728/7733, 7966/7971 | 8110 of 8115 | same on all 6 | pass; `read_card` called twice |
| OpenRouter → claude-sonnet-4.5, pinned `amazon-bedrock` | no (all tools, §8.2) | 13105/13110, 13339/13344, 13483/13488, 13786/13791 | — | same | pass (baseline) |
| OpenRouter → claude-haiku-4.5, unpinned | no (all tools) | 13105/13110, 13351/13356, 13506/13511, 13817/13822 | — | same | pass (baseline) |
| OpenRouter → deepseek/deepseek-v4-flash | no (all tools, §8.2) | 11904/12047, 12032/12174, 12160/12454, 12416/12734 | — | same | pass (baseline) |
| OpenRouter → openai/gpt-5.4-nano | no (all tools) | 5632/6416, 5632/6519, 5632/6744, 6656/6969 | — | same | pass (baseline); the 2026-11-12 400 was the tool schemas (§3), fixed |

The first app run on OpenRouter Claude failed: 400 `{"message":"api_error: Provider returned error","type":"invalid_request_error"}`. Replaying the saved body with one change at a time found the cause: pi-ai's `cache_control` on the last tool, which was deferred. §3's marker move fixed it.

### 8.2 Probes for each provider, 2026-11-13

Hand-written requests of the same shape (26 deferred and 4 immediate synthetic tools, a load of 5, ≈6k tokens of synthetic text). R*n* is request *n*; the load is in R3's history. "Read" is the provider's cache read. Each long text was placed both before the tool list (system prompt) and after it (first user message), because a provider that renders tools after the system prompt rewrites only what follows them.

| Host → model | Mechanism | Result | Verdict |
| --- | --- | --- | --- |
| Anthropic direct (4 models) | `tool_reference` in the load's result (the built wire) | expanded in place (+≈640 tokens, written once); R3 read the whole prefix; each model called `read_card` | pass (§8) |
| OpenRouter → Claude, `anthropic` / `google-vertex` (haiku-4.5, sonnet-4.5, sonnet-5.5, opus-5.5, haiku-5.5) | flags fixed, definitions as text in the load's result | sonnet-4.5 R3 read 7294 of 7299; haiku-4.5 7291 of 7296; 5.5 models ≈11083 of 11085. Extended to 7 requests with the text after the tools: every request read the one before (Vertex R3 7298/7837 … R7 8060/8141; Anthropic the same), including the first call of each newly used loaded tool | pass: built (§3) |
| same | `tool_reference` parts in the tool message | cache held (R3 read 7294 of 7299), but OpenRouter passed them on as text without expanding (+85 tokens, against +637 direct). Haiku 4.5 and the 5.5 models then called `tool_search` instead of the loaded tool | fail: the model can't see the definitions |
| same | reveal: drop a loaded tool's flag | R3 read 0, wrote 7939 | fail: the tool list is cached as one prefix |
| OpenRouter → Claude, `amazon-bedrock` | definitions as text, and `tool_reference` | the load itself held, but the first call of each newly used loaded tool read 0 and rewrote everything (R4 and R6; input +108–187 over the Anthropic upstream). Reproduced 4 times | fail |
| OpenRouter Responses → Claude (all three upstreams) | `defer_loading` with OpenRouter's tool search | deferral and expansion work; the load busts once (R3 read 0, write ≈8220). Caching needs a top-level `cache_control` there | fail: one full rewrite per load |
| OpenRouter → openai/gpt-5.4-mini, Responses | `tool_search_call` / `tool_search_output` pair (the built candidate) | R3 read 0, 3 runs of 3; reads afterwards | fail |
| same | `additional_tools` item at the load | cache held, and the model called `read_card`, but any later request replaying that call: 400 "Provider returned error" (with or without `namespace`, and replayed verbatim) | fail |
| OpenRouter → openai/gpt-5.4-mini, Chat Completions | `function.defer_loading` and reveal | R3 cache bust | fail |
| OpenRouter → deepseek/deepseek-v4-flash, pinned `deepseek` | `function.defer_loading` (OpenRouter defers it itself: R1 6210 in against 8861 with all tools) | text before the tools: reveal kept the prefix (R3 read 6144 of 6282). Text after the tools: reveal read 256 of 6871 at the load; definitions as text held the load (R3 6272 of 6767) and the model called `read_card`, but the first call of each newly used loaded tool read 384 (R4, R6) | fail: a workshop's history comes after the tools |
| DeepSeek direct, Chat Completions | `function.defer_loading` | accepted and ignored (R1 8860 in, with and without) | no mechanism |
| OpenRouter Chat Completions | OpenRouter's `deferred_tools` protocol (`v1`, `portable`) | 403 "Deferred-tool protocol is unavailable for this workspace." Its docs also forbid history edits, which step edits need | not usable |

At the time of this round, OpenAI direct was unmeasured; §16 supersedes that status with later measurements. OpenRouter’s `/v1/messages` and DeepSeek’s Anthropic-compatible API remain unmeasured and keep their defaults.


DeepSeek through OpenRouter also needs `reasoning` / `reasoning_content` on a replayed assistant tool call (400 without). Its valid ids are `deepseek/deepseek-v4-flash`, `deepseek/deepseek-v4-pro` and `deepseek/deepseek-chat`.

## 9. reference-harness's caching problems, and how this avoids them

1. Responses `supports_tool_search` off by default (f631da3f; 71 of 72 skill loads rewrote the whole context): here the Responses wire uses `tool_search_output` items whenever it's on, and a wire is on only for its measured host.
2. Responses deferred `function_call` replay without namespace: 400 "Missing namespace for function_call" (347a99b2, 5c44829b): the transform sets `namespace` to the tool's name on every replayed call of a loaded tool.
3. Anthropic: declaring a loaded tool only at load time changes `tools`, rewriting the cache and invalidating thinking bound to the prefix (e4a7823d, f4f4119e): every tool is declared from the first request, deferred ones marked; the tool list bytes never change (measured, §8).
4. Bedrock has no cache lookback, and its own breakpoints work (96a2c8ce, 58480097): Bedrock gets no wire. Through OpenRouter it was measured (§8.2): each newly used loaded tool rewrote the whole cache, so a Bedrock-pinned or unpinned OpenRouter Claude gets every tool. Direct Bedrock (connection kind `bedrock`) is not measured: Anthropic's docs list tool search on Bedrock's InvokeModel only, not Converse.
5. Hosts that don't defer natively: reference-harness's `declare_deferred_tools` with `supports_tool_references` off sends loaded definitions as text. That works through OpenRouter only where the upstream defers natively (Anthropic, Vertex); where OpenRouter defers itself (DeepSeek) or Bedrock serves, the first call of each loaded tool rewrote the cache (§8.2), so those get every tool instead.
6. Tools the agent shouldn't search (6618bd30, harness-only tools): only the run's frozen offer is searchable.

## 10. Built, and not yet

Built: §2–§6 server side, §7 (fields and the inspector's groups), the transforms (Anthropic Messages, OpenRouter Chat Completions for pinned Claude), portable tool schemas, tests (`toolLoading.test.ts`, `toolLoadingWorkshop.test.ts`, `operationTools.test.ts`, live `live/toolLoading.test.ts`, e2e `toolLoading.spec.ts`).

Built (wsb2, 2026-11-15; obsolete as a proposal, ARCHITECTURE §16 "Workshop skills in every mode"): `load_skill` in every mode, also with every tool sent from the start (it then returns instructions only; nothing is deferred), so the same skills and approvals apply whatever the connection's Tool loading; the card editor's Skills section (Extra tab) to list, add, edit, reorder and remove a card's own skills and its `{ "use" }` entries, saying why an entry would be skipped. It adds no way to type a new `{ "use" }` reference: the editor has no list of installed skills yet.

Reviewed (review-wsb2, 2026-11-15; ARCHITECTURE §16 "Workshop skills review"): `skills.card` offers Off and Ask first only; "Allow in this workshop" on a card skill is remembered for that skill's exact content in that workshop, so §6's approval is asked again whenever the skill changes.

Not yet: live verification of dispatcher loading outside §15's measured profiles. The fallback of §11.1(b) is built (§15), with untested providers remaining opt-in.

## 11. Open questions

1. **Hosts without a wire at that round** (OpenAI, DeepSeek, Google, Bedrock, Vertex, and OpenRouter except pinned Claude). §8.2’s OpenAI failures were through OpenRouter; direct OpenAI was later measured successfully in §16. At this earlier round: OpenAI's tool search rewrote it at the load or refused the replayed call, DeepSeek ignores the flag, and where OpenRouter defers itself or serves through Bedrock the first call of each loaded tool rewrote it. Today they get every tool from the start, which is (c) below. Option (b) is **[D] Decided** (owner, 2026-11-13): asked "build the dispatcher for those providers, or leave them on every tool from the start?", the owner answered "Ok, build it." **Built (calltool1); obsolete as an implementation proposal.** The other choices and details retain their existing markings; see §15 and ARCHITECTURE.md for implementation.

   - (c) **Every tool from the start** (today). Worked example: a workshop on DeepSeek, a 40,000-token chat, the user asks to make a card warmer. Every request carries all 28 definitions (≈4,200 tokens) before the chat; after the first request they are cache reads like the rest. Nothing is ever rewritten. The cost is ≈4,200 tokens of context and cache reads on every request, and the model choosing among 28 tools.
   - (a) **Grow `tools` at a load.** Same example: the run starts with 4 tools; the assistant calls `load_skill("cards")`, and the next request adds the 5 card tools to `tools`. Everything after the system prompt changes position, so that request pays for the 40,000 tokens again, uncached or as a cache write, once per load (measured below: DeepSeek read 1,536 of 52,414). A long chat pays that on every skill it loads.
   - (b) **[D] Definitions as text, one dispatcher**. Same example: the run starts with 4 tools plus `call_tool { name, arguments }`. The `load_skill("cards")` result carries the 5 definitions as text (≈1,800 tokens). To edit, the model calls `call_tool { "name": "edit_card", "arguments": { "card": "Tide", … } }`; the app checks the arguments against `edit_card`'s schema and runs it as if called directly (approvals and receipts included). `tools` never changes, so the next request reads the 40,000 tokens from the cache (measured: 50,688 of 52,397). The price: the provider doesn't enforce the arguments' schema, the model calls through one more step, and `call_tool` is one more definition on every request. Unlike §8.2's text mode, the loaded tools aren't declared, so nothing new is called that the provider could treat as a first use.

   (a) and (b) measured 2026-11-12, without the app (synthetic transcript; a load of 5 definitions, ≈1.8k tokens; "control" repeats the request unchanged):
   - (a) **Grow `tools` at a load.** The loaded definitions join `tools`; the request after the load rereads nothing past the system prompt, so it pays for the whole transcript uncached (or as a cache write), once per load.
   - (b) **Definitions as text, one dispatcher.** An immediate `call_tool { name, arguments }` is declared from the start; a load returns the loaded definitions as tool-result text, and the model calls them through `call_tool`. `tools` never changes, so the request after a load reads the whole cache. The price: the model calls tools indirectly (argument schemas aren't enforced by the provider, so the app validates them), and `call_tool` itself is one more tool from the first request.

   Measured 2026-11-12 (synthetic transcript; a load of 5 definitions, ≈1.8k tokens; "control" repeats the request unchanged):

   | Host, model | Transcript | Control | (a) after the load | (b) after the load |
   | --- | --- | --- | --- | --- |
   | DeepSeek, deepseek-flash | 3,679 tokens | read 3,456 | 5,498 in, read 1,536 | 5,481 in, read 3,712 |
   | DeepSeek, deepseek-flash | 50,595 tokens | read 50,432 | 52,414 in, read 1,536 (≈50.9k uncached) | 52,397 in, read 50,688 |
   | OpenRouter → anthropic/claude-haiku-4.5 | 4,434 tokens | read 4,431 | write 6,294, read 0 | read 4,545, write 1,752 |
   | OpenRouter → anthropic/claude-haiku-4.5 | 57,928 tokens | read 57,925 | write 59,788, read 0 | read 58,039, write 1,752 |

   So (a) costs the whole transcript once per load (≈50k tokens at 50k); (b) costs only the loaded definitions. Switching a running chat to (b) costs one full rewrite itself, since adding `call_tool` changes `tools` (measured: DeepSeek read 1,536, OpenRouter wrote everything). DeepSeek also needs `reasoning_content` on a replayed assistant tool call (400 otherwise).

   (b) on the two OpenRouter routes where §8.2's text mode failed, 2026-11-13 (7 requests, the long text after the tools, `call_tool` and 4 immediate tools; the load in R3's history; R3, R5 and R6 call loaded tools through `call_tool`, the model choosing it unprompted at R3):

   | Route | R2 read/input | R3 (load) | R4 | R6 (a second loaded tool's first call) | R7 |
   | --- | --- | --- | --- | --- | --- |
   | deepseek/deepseek-v4-flash, pinned `deepseek` | 6144/6346 | 6272/6830 | 6784/6921 | 6912/7097 | 6912/7166 |
   | claude-haiku-4.5, pinned `amazon-bedrock` | 7286/7372 | 7367/7906 | 7901/8008 | 8102/8206 | 8201/8282 |

   So (b) keeps the cache where every other mechanism failed. The owner authorized building it on 2026-11-13 (quote above); measured profiles and explicit untested overrides are implemented as recorded in §15.

## 12. Review verification (2026-11-13)

(Round 3 has since added pinned OpenRouter Claude, §3 and §8.1.) The active loading profile is limited to the five measured Anthropic model versions in §8. Responses and all other unmeasured profiles send every tool from the start. No provider calls were made during review; §8 records the builder's measurements, not new live verification.

Public documentation checked: [Anthropic custom tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool) specifies top-level declarations and tool-reference results; [Anthropic tool caching](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching) requires cache markers on immediate tools. The existing transform follows these shapes and keeps reference-only results, with skill text after results. [OpenAI tool search](https://developers.openai.com/api/docs/guides/tools-tool-search) documents client call/output items, deferred definitions and namespaced calls; its unmeasured candidate transform remains covered offline, disabled in built-in profiles.

Regressions: `toolLoadingReview.test.ts` (untrusted index/read, frozen and selected skills, collisions, transcript load provenance, continuity changes, limits), `toolLoading.test.ts` (wire bytes and RP/unprofiled parity), `toolLoadingWorkshop.test.ts` (real server loop, approvals, batches, carry and step edit), `formats/cardExport.test.ts` (skills plus notes round trips), browser `toolLoading.spec.ts` (saved inspector groups after restart and layout).

## 13. What each provider documents (checked 2026-11-13)

| Source | What it says that matters here |
| --- | --- |
| [OpenRouter tool search](https://openrouter.ai/docs/guides/features/server-tools/tool-search) | Client-side deferral: `defer_loading` on a function tool. Native deferral where Claude runs on Anthropic, Vertex, Azure Foundry or Claude Platform on AWS; OpenRouter defers the rest itself, rolled out per account. Its own search tool's name is checked. The `deferred_tools` protocol, its error codes, and its ban on history edits |
| [OpenRouter prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching) | Claude on the Responses API needs a top-level `cache_control` to cache |
| [OpenRouter provider selection](https://openrouter.ai/docs/guides/routing/provider-selection) | `only`, `order` and `allow_fallbacks`: how a model is pinned to one upstream |
| [OpenAI tool search](https://developers.openai.com/api/docs/guides/tools-tool-search) | gpt-5.4 and later only. Loaded tools go at the end of the context, keeping the cache; `tool_search_call` / `tool_search_output` and `additional_tools` items |
| [Anthropic tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool) | Custom tool search returns `tool_reference` blocks; supported models; on Bedrock through InvokeModel only (not Converse), and on Vertex |
| [DeepSeek Anthropic API](https://api-docs.deepseek.com/guides/anthropic_api) | Tool fields `name`, `input_schema`, `description`; `cache_control` ignored; no `defer_loading`, no `tool_reference` |
| reference-harness `latest` (9b385944), `spec/DYNAMIC-TOOL-LOADING.md` | Per-transport table; compat flags `supports_tool_search` (on by default), `supports_tool_references`, `declare_deferred_tools` (definitions as text when references are off), `drop_stale_thinking` |
| pi-ai 0.84.2 (npm) | Deferral modes: `kimi` (tools in a system message) only for Kimi K3 on Moonshot and Fireworks, never DeepSeek or OpenRouter; `supportsAdditionalTools` / `supportsToolSearch` for OpenAI gpt-5.4+; tool references off for Haiku. The installed pi-ai 1.0.3 has no deferral support |


## 14. Round 3 review verification (2026-11-13)

Schema portability is scoped to the measured OpenRouter OpenAI path through a registered compatibility shim; it no longer alters the catalog for every provider. `operationTools.test.ts` reproduces the original-schema drift and checks full validation before adaptation or invocation. `providerShims.test.ts` checks targeted simplification, deterministic replay and byte parity for other providers.

`toolLoadingRouter.test.ts` exercises the real loop with synthetic streams: removing a pin mid-run retains the frozen explicit route and tool bytes, step Resume replays the saved route and loaded definitions, and a fresh turn replans after a route change. It also switches to Anthropic direct and back, without carrying the other wire's loading material. The routing matrix covers `only`, `order`, fallbacks and exclusions; account-only preferences cannot enable a profile without an explicit request pin. [OpenRouter's routing documentation](https://openrouter.ai/docs/guides/routing/provider-selection) states that account restrictions narrow request restrictions; they cannot widen an explicit `only` pin. If the remote service violates that pin, cache behavior is outside the measured guarantee; the app's offered-tool, loaded-tool and capability checks still apply.

No provider calls during review. The measured allowlist remains the five Claude versions on Anthropic direct and the two OpenRouter upstreams recorded in §8. Unmeasured and failed routes remain disabled. Built-in skill selection continues through the existing frozen offer and permission boundary, including reserved names and imported text approval.

## 15. Dispatcher implementation (calltool1, 2026-11-13; obsolete as a proposal)

Delta from reference-harness's `declare_deferred_tools` with references off: definitions still travel as text at successful transcript load points, but loaded tools are never added to the declared array. The fixed `call_tool {name, arguments}` accompanies the immediate tools from the first request. The model uses exact names; immediate tools, loaders and `call_tool` itself cannot be dispatched. The established final request without tools remains the turn-cap/partial-text exception.

`ExecutionRegistry.toolLoadingWires` has a replaceable `dispatcher` fallback profile. Native profiles win in Automatic. Defaults are restricted to the following live results in §11.1; no new live measurements were made:

| Target | Automatic mode | Evidence |
| --- | --- | --- |
| Measured direct Claude versions | Native | §8 |
| Measured OpenRouter Claude versions pinned to Anthropic or Google Vertex | Native | §8.1–§8.2 |
| Direct DeepSeek, exact `deepseek-flash` | Dispatcher | §11.1, 2026-11-12: at ≈50k tokens, read 50,688/52,397 |
| OpenRouter `deepseek/deepseek-v4-flash`, pinned `deepseek` | Dispatcher | §11.1, 2026-11-13: R3 6272/6830, R4 6784/6921, R6 6912/7097 |
| OpenRouter `anthropic/claude-haiku-4.5`, pinned `amazon-bedrock` | Dispatcher | §11.1, 2026-11-13: R3 7367/7906, R4 7901/8008, R6 8102/8206 |
| Direct OpenAI Chat exact `gpt-5.4-nano`, `gpt-5.4-mini` | Dispatcher | §16, 2026-11-13 |
| Direct OpenAI Responses exact GPT-5.4, mini and pro | Native | §16: mini measured; larger variants included by coordinator ruling |
| Everything else, including Responses nano, unpinned OpenRouter and other DeepSeek versions | Every tool | No other default changes |

The older unpinned OpenRouter measurement does not establish an upstream pin, so it enables no default. Connection Advanced → Tool loading offers Automatic, Every tool from the start, and Try dispatcher (untested). `ProviderSettings.toolLoading` uses existing provider-settings storage, is frozen into `ModelInput`, and is not forwarded as a provider option. Automatic and untested overrides use the same replaceable profile; disabling it disables dispatch. RP and unprofiled chat kinds still send everything even under an override.

`agent/dispatcher.ts` converts completed calls to canonical real names/arguments before persistence, consent or execution. The raw provider payload is already captured by the request inspector. Full frozen JSON schemas are validated without coercion; execution repeats validation before permission checks, including dangling Resume calls. Existing tool-specific Effect schemas, target checks and writer transactions remain in force. Validation walks at most 48 levels, 32,768 values and 262,144 string/key characters before cloning/schema validation. Oversized arguments are refused and omitted from the canonical call. Rejections carry an app-owned transcript marker so restart cannot turn a refused immediate/loader call into a direct execution. Editing arguments under a new call id clears the marker and validates the replacement normally.

Unknown, unloaded, unoffered, reserved and Off tools receive the same unknown-tool refusal. Capability grants, approval digests, causal position checks, receipts, Changes and Undo all use the real tool and original call id. Parallel provider calls execute sequentially as before; a dispatcher target must already be loaded when the assistant turn arrives (no same-turn look-ahead load). Loaded definition descriptions are JSON strings under a data-only heading; their text never grants permissions. Imported card skills keep their existing frozen/approval boundary.

The canonical transcript replays through each target representation: dispatcher wraps deferred calls and returns JSON definitions at existing load points; native wires declare calls directly and apply their existing transforms; every-tool mode declares everything. A model-switch Resume retains the original catalog, partition and skill bodies, removing or adding only the transport definition in inspector metadata. A run originally offering everything retains those immediate tools on Resume; a fresh turn can split its new offer. New turns after model/connection/catalog changes still rebuild through continuity's established fallback, resetting old loads. The inspector continuity copy and connection form state the one-time full input cost when tool declarations change, including the rebuild after an app update or changed tool catalog.

DeepSeek dispatcher replays include `reasoning_content` even when a call has no visible thinking, including calls from another model. Assembler version 64 fences earlier request shapes. Native transforms and serializers are unchanged; native loading and RP byte-preservation regressions remain gates. New tests: `dispatcher.test.ts`, `dispatcherWorkshop.test.ts`; extended browser `toolLoading.spec.ts`, `connections.spec.ts`, and the shared `LAYOUT_AUDIT_DISPATCHER_ONLY` connection-form cases. Live acceptance/cache behavior outside the table remains unverified; coordinator request sequences are supplied in the external job report, with no provider-access setup in this repository.


### 15.1 Independent review (review-calltool1, 2026-11-13; implemented, obsolete as a proposal)

Merged master and sidechat2. Dispatcher-mode completed calls reject malformed original JSON even when the streaming library repaired its preview; output-contract calls get full non-coercing validation too. Availability precedes validation error disclosure, preserving the unknown-tool response for Off targets. Refusal metadata remains effective after switching modes on Resume. Original argument capture covers Chat Completions, Responses and Anthropic; Google's arguments already arrive as parsed JSON objects. New offline wire regressions cover canonical direct/dispatcher replay on Anthropic, Chat, Responses and Google, including removal of another model's reasoning signatures. The native/every-tool paths and measured mode table are unchanged. Assembler version 68 fences the combined build.

Side-chat scope presentation uses the branch menu's live name and retains saved naming for a deleted branch; internal branch coordinates are omitted from positioned setup approval rows. Earlier positioned tool arguments, as well as results, are withheld by read_run at another story position. These fixes retain WORKSHOP's existing permission policy. See ARCHITECTURE §16 for implementation and regression details. No provider calls or new live measurements were made during review.

## 16. Direct-provider measurements, 2026-11-13; fixes1114 implemented 2026-11-14

These are the supplied live measurements, not new requests by this implementation job. Synthetic card task, four immediate and five deferred tools; repeated baseline, load, two reads, edit, read, reply. Tool-array bytes stayed constant within each run. OpenAI used about 7.7k synthetic tokens after the tools, a stable prompt cache key, `strict: false`, accumulated history, and Responses `store: false` plus encrypted reasoning replay. Cells are cached/input tokens. R3 is the first request containing the load; R4 and R5 are subsequent loaded-tool requests.

| API | Mode | Model | Runs × requests | R1 repeat | R2 | R3 | R4 | R5 | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Chat | Dispatcher | gpt-5.4-nano | 3 × 9–11 | 6784/7814 | 6784/7846 | 7808/8118 | 7808/8157 | 7808/8196 | Holds, 3/3 |
| Chat | Every tool | gpt-5.4-nano | 3 × 7–8 | 7808/7862 | 7808/7894 | 7808/7947 | 7808/7979 | 7808/8011 | Holds, 3/3 |
| Chat | Dispatcher | gpt-5.4-mini | 1 × 10 | 7680/7814 | 7680/7846 | 7808/8118 | 8064/8157 | 8064/8196 | Holds |
| Chat | Every tool | gpt-5.4-mini | 1 × 8 | 7808/7862 | 7808/7894 | 7808/7947 | 7808/7979 | 7936/8011 | Holds |
| Responses | Dispatcher | gpt-5.4-nano | 3 × 9–13 | 6656/7733 | 7680/7842 | 7680/8039 | 7680/8204 | 7680/8416 | Holds, 3/3; weaker tool choice |
| Responses | Every tool | gpt-5.4-nano | 3 × 8 | 7680/7781 | 7680/7925 | 7680/7990 | 7680/8035 | 7680/8068 | Holds, 3/3 |
| Responses | Native | gpt-5.4-nano | 3 × 2 | 6656/7672 | 7680/7776 | 400 | — | — | Unsupported, 3/3 |
| Responses | Dispatcher | gpt-5.4-mini | 1 × 10 | 7552/7733 | 7552/7821 | 7680/8094 | 7936/8145 | 8064/8185 | Holds |
| Responses | Every tool | gpt-5.4-mini | 1 × 8 | 7680/7781 | 7680/7871 | 7680/7925 | 7680/7958 | 7680/7991 | Holds |
| Responses | Native | gpt-5.4-mini | 3 × 6–7 | 7552/7672 | 7552/7758 | 7680/8151 | 8064/8223 | 8064/8258 | Holds, 3/3; accepted namespaced replay |

All fifteen accepted baseline repeats and every post-load request retained at least the pre-load cached prefix. Native mini R3 was 7680/8151, 7680/8140 and 7680/8155 in its three runs. Dispatcher arguments and unknown-tool refusal were correct, with zero validation violations. Responses nano sometimes wrapped immediate tools or used an incorrect namespace; mini was clean. Chat nano refused reasoning effort other than `none` with function tools, so Chat measurements used `none`. The existing GPT-5.4 tool/effort shim covers known models. A registered refusal-specific shim retries an explicit matching 400 once with `none` for other models, before output. It does not infer a wider unsupported-model list or retry unrelated 400s. Requests that already succeed keep identical bytes. The sent-context inspector records a compatibility note with the selected and sent effort when either the existing shim or the refusal-specific shim changes it; saved user settings stay unchanged.

Automatic: direct OpenAI Chat selects dispatcher only for the two exact measured ids. Direct OpenAI Responses selects native for mini and the larger GPT-5.4 / GPT-5.4-pro variants, using exact ids without dated snapshots, per the coordinator's explicit ruling; only mini was measured natively. Nano remains Every tool on Responses. Other model families, custom compatible servers and other hosts keep their defaults. The connection provider id and canonical OpenAI API address are checked separately from API kind; snapshots carry only a non-secret direct-OpenAI flag, never the transport address. A named OpenAI connection with a custom/proxy address keeps its previous mode. Prefixes, suffixes and dated snapshots do not inherit these defaults. About 8k prompts and cache-key-on were measured; larger models, >50k prompts and cache-key-off were not. No new guarantee is made for those cases.

Anthropic direct used about 23k synthetic tokens after the tools: Haiku 5.5 three runs per mode, Sonnet 5.5 one per mode. Cells are read/total input; R3 is the load. Each request reads essentially the preceding input (2–4 token tail), writing only new material.

| Model | Mode | R1 repeat | R2 | R3 | R4 | R6 | R7 | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-haiku-5-5 | Dispatcher | 23256/23260 | 23256/23430 | 23428/23921 | 23919/24018 | 24113/24221 | 24219/24318 | Holds, 3/3 |
| claude-haiku-5-5 | Every tool | 23566/23570 | 23566/23817 | 23815/23909 | 23907/23973 | 24035/24125 | 24123/24189 | Holds, 3/3 |
| claude-haiku-5-5 | Native | 23195/23199 | 23195/23432 | 23430/23961 | 23959/24025 | 24087/24177 | 24175/24241 | Holds, 3/3 |
| claude-sonnet-5-5 | Dispatcher | — | 23256/23322 | 23320/23813 | 23811/23910 | 24005/24113 | 24111/24210 | Holds |
| claude-sonnet-5-5 | Every tool | — | 23566/23632 | 23630/23724 | 23722/23788 | 23850/23940 | 23938/24004 | Holds |
| claude-sonnet-5-5 | Native | — | 23195/23261 | 23259/23790 | 23788/23904 | 24087/24177 | 24175/24241 | Holds |

Haiku's other dispatcher runs read 23449/23942 at R3. Dispatcher loaded definitions cost about 490 written tokens versus native's 530; every-tool adds about 310 input tokens for these five definitions. Both models chose the dispatcher correctly at all loaded-tool steps, had zero argument violations, handled the unknown name as refused, and replayed signed thinking without errors or cache loss. Anthropic Automatic stays native; dispatcher is a measured cache-safe opt-in/fallback, with no default change. Other providers' measurements remain as recorded above.
