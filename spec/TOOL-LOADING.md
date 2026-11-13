# Dynamic tool loading: tool_search, load_skill and card skills

**Status**: Implemented portions obsolete as proposals (§2–§7, §10), reviewed 2026-11-13 (`review-toolload1`); ARCHITECTURE.md records the implementation. Remaining choices are **[P]** unless they quote the owner. It is a delta from the build at master `44c46181` (agent session `agent/session.ts`, provider transforms `providers/builtins.ts`) and from reference-harness on branch `latest` (`src/agent/declared-tools.ts`, `src/tools/tool-search.ts`, `src/tools/load-skill.ts`).

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
| `openai-responses` (candidate only, disabled) | none until measured live | Only immediate tools top-level. After the loading call's `function_call_output`: a `tool_search_call` / `tool_search_output` pair (`execution: "client"`) with the loaded definitions, `defer_loading: true`. A later `function_call` of a loaded tool gets `namespace` = its name |
| every other wire and host (Chat Completions, OpenRouter, DeepSeek, Google, Bedrock, Vertex, Bedrock-hosted OpenAI) | nothing | Every tool from the start, as today |

The transforms are `providers/toolLoading.ts`, registered first in `providers/builtins.ts` so the breakpoint transforms see the final tools. They act only when the session passes `toolLoading` in the stream options.

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
- Skills are registry entries (`ExecutionRegistry.skills`, `agent/skills.ts`): `{ id, label, description, instructions, tools: patterns, kinds?, always? }`. Built in: `cards`, `presets-lorebooks`, `library`, `chat-setup`, `stories`, `settings`; together they cover every workshop tool (tested). A skill is listed in a run only when it loads a deferred tool there, or has instructions only.

## 6. Card skills

A card carries skills in `extensions.rp_harness.skills` (format **[P]**), which other apps keep on export and ignore, like any extension:

```json
{ "extensions": { "rp_harness": { "skills": [
  { "use": "cards" },
  { "name": "proofread", "description": "Checks a card's spelling.",
    "instructions": "Read the card, then list each typo with its field.", "tools": ["read_card"] }
] } } }
```

- `{ "use": id }` names a registered skill: one registered with `always: false` is offered only when the workshop's card names it. The built-in skills are `always: false` **[P]**: the seeded Assistant card names them all (`ExecutionRegistry.workshopCardSkills`, passed to `CreateWorkshop` as `assistantSkills`), so a user's own workshop card chooses its skills. A card that names none still reaches every deferred tool through `tool_search`, whose description then lists them all. Assistant cards seeded before this have no references (re-import expected).
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

## 9. reference-harness's caching problems, and how this avoids them

1. Responses `supports_tool_search` off by default (f631da3f; 71 of 72 skill loads rewrote the whole context): here the Responses wire uses `tool_search_output` items whenever it's on, and a wire is on only for its measured host.
2. Responses deferred `function_call` replay without namespace: 400 "Missing namespace for function_call" (347a99b2, 5c44829b): the transform sets `namespace` to the tool's name on every replayed call of a loaded tool.
3. Anthropic: declaring a loaded tool only at load time changes `tools`, rewriting the cache and invalidating thinking bound to the prefix (e4a7823d, f4f4119e): every tool is declared from the first request, deferred ones marked; the tool list bytes never change (measured, §8).
4. Bedrock has no cache lookback, and its own breakpoints work (96a2c8ce, 58480097): Bedrock gets no wire, so nothing is deferred there until it is measured.
5. Tools the agent shouldn't search (6618bd30, harness-only tools): only the run's frozen offer is searchable.

## 10. Built, and not yet

Built: §2–§6 server side, the Assistant card's skill references, §7 (fields and the inspector's groups), the transforms, tests (`toolLoading.test.ts`, `toolLoadingWorkshop.test.ts`, live `live/toolLoading.test.ts`, e2e `toolLoading.spec.ts`).

Not yet: a client view of a card's skills in the card editor; wires for Bedrock, Vertex, OpenRouter and DeepSeek, and either option of §11.1 for them.

## 11. Open questions

1. **Hosts without a wire** (OpenRouter, DeepSeek, Bedrock, Google). Today they get every tool from the start. Neither option is built:
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
2. **Built-in skills only with the Assistant card** (§6) is now built as Proposed: confirm or revert.

## 12. Review verification (2026-11-13)

The active loading profile is limited to the five measured Anthropic model versions in §8. Responses and all other unmeasured profiles send every tool from the start. No provider calls were made during review; §8 records the builder's measurements, not new live verification.

Public documentation checked: [Anthropic custom tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool) specifies top-level declarations and tool-reference results; [Anthropic tool caching](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching) requires cache markers on immediate tools. The existing transform follows these shapes and keeps reference-only results, with skill text after results. [OpenAI tool search](https://developers.openai.com/api/docs/guides/tools-tool-search) documents client call/output items, deferred definitions and namespaced calls; its unmeasured candidate transform remains covered offline, disabled in built-in profiles.

Regressions: `toolLoadingReview.test.ts` (untrusted index/read, frozen and selected skills, collisions, transcript load provenance, continuity changes, limits), `toolLoading.test.ts` (wire bytes and RP/unprofiled parity), `toolLoadingWorkshop.test.ts` (real server loop, approvals, batches, carry and step edit), `formats/cardExport.test.ts` (skills plus notes round trips), browser `toolLoading.spec.ts` (saved inspector groups after restart and layout).
