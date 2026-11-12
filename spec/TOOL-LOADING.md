# Dynamic tool loading: tool_search, load_skill and card skills

**Status**: Proposed, 2026-11-12 (job `toolload1`). Built in the same job: the server side of §2–§7 (see §10). Everything below is **[P]** unless it quotes the owner. It is a delta from the build at master `44c46181` (agent session `agent/session.ts`, provider transforms `providers/builtins.ts`) and from reference-harness on branch `latest` (`src/agent/declared-tools.ts`, `src/tools/tool-search.ts`, `src/tools/load-skill.ts`).

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
| `anthropic-messages` | connection kind `anthropic` only; Claude 4.5 and later (Anthropic's tool search model list) | Every tool declared on every request; deferred ones get `defer_loading: true`. The cache marker pi-ai puts on the last tool moves to the last immediate one (a deferred tool can't carry it). The loading call's `tool_result` becomes `tool_reference` blocks only; its text moves after the message's tool results (the API refuses the two mixed: measured, §8) |
| `openai-responses` | connection kind `openai-responses` only; gpt-5.4 and later | Only immediate tools top-level. After the loading call's `function_call_output`: a `tool_search_call` / `tool_search_output` pair (`execution: "client"`) with the loaded definitions, `defer_loading: true`. A later `function_call` of a loaded tool gets `namespace` = its name |
| every other wire and host (Chat Completions, OpenRouter, DeepSeek, Google, Bedrock, Vertex, Bedrock-hosted OpenAI) | nothing | Every tool from the start, as today |

The transforms are `providers/toolLoading.ts`, registered first in `providers/builtins.ts` so the breakpoint transforms see the final tools. They act only when the session passes `toolLoading` in the stream options.

## 4. The loaded set comes from the transcript

A loading tool's successful result stores `details.loaded` (names). The loaded set at any point is the deferred names some successful loading result names (`loadedSet`, `loadPoints` in `agent/toolLoading.ts`), as in reference-harness. Nothing else stores it, so resume, step edits and carried turns load the same tools at the same points:

- Editing a load result's text keeps its `details`: the load stays.
- Editing a loading call's arguments runs it again under a new id: a new load.
- A capped last request (sent without tools) carries no load points.

A call to a deferred tool before it's loaded returns, as an error result: “read_card” isn't loaded yet. Load it with tool_search or load_skill first.

## 5. The loaders and skills

- `tool_search { query, max_results? }`: `select:a,b` loads exact names; other words search names (weight 3) and descriptions (1), up to 5. Its description lists the deferred tools no skill covers.
- `load_skill { name }`: returns `<skill name="…">instructions</skill>` and loads the skill's tools. Its description is the skill index, frozen with the run's tools.
- Both are `read` tools: no capability, never asked first. Loading grants nothing: a loaded tool still goes through the offered-tools check, capability standing, approvals and receipts. Only tools in the run's frozen offer can be loaded, and an Off capability's tools aren't in it.
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

- `{ "use": id }` names a registered skill: one registered with `always: false` is offered only when the workshop's card names it. Built-in skills are `always`, so a card can't lose them.
- A card's own skill: name `^[a-z0-9][a-z0-9_-]{0,47}$`, description and instructions required; at most 16 entries; anything else is ignored.
- Which cards: those the assistant speaks as at the revisions the request was assembled with; cards played by the user (persona) are left out. Read once per fresh run and frozen in the snapshot (`agent.cardSkills`).
- A registered skill wins a name clash: a card can't stand in for a built-in skill.
- Card skills only name tools, never grant them: their patterns match only the run's offer.
- An imported card is untrusted: loading one of its own skills needs the new capability `skills.card` (“Use skills from cards”, default Ask first). The approval shows the skill's description, instructions and the tools it loads. The workshop chip lists the capability whenever the kind loads tools as it goes.
- Card swap mid-workshop: tools loaded so far stay loaded (they're in the transcript); the next fresh turn reads the new card's skills, so `load_skill`'s description changes and that request writes the cache once in full. A resumed run keeps its frozen skills.

## 7. Inspector

`GetRunTranscript.tools[]` gains `deferred` and `loadedBy` (the loading call's id). Showing them in the run's Tools list is not built (§10).

## 8. Live measurements (2026-11-12)

`test/live/toolLoading.test.ts`: one workshop reply of six requests: two `list_library` calls, a `load_skill("cards")`, then two `read_card` calls. Numbers are provider-reported input tokens. "Read after load" is the cache read of the first request whose history holds the load, against the whole input of the request before it.

| Target | Loading | Before the load (read/input per request) | Read after load | Tool list bytes | Result |
| --- | --- | --- | --- | --- | --- |
| Anthropic, claude-haiku-4-5 | yes | 0/7821 (write 7729), 7729/7980, 7975/8135 | 8130 of 8135 | same on all 6 | pass |
| Anthropic, claude-sonnet-4-5 | yes | 0/4647, 4555/4797, 4792/4938 | 4933 of 4938 | same on all 6 | pass |
| OpenAI Responses, gpt-5.4-mini | yes | not run: the test endpoint refused the Responses API for its key | — | — | not tested live; golden wire test only |
| Anthropic on Bedrock | no (no wire) | not reachable from the test setup | — | — | not tested; nothing deferred |
| Vertex | no (no wire) | not reachable | — | — | not tested; nothing deferred |
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

Built: §2–§6 server side, §7's fields, the transforms, tests (`toolLoading.test.ts`, `toolLoadingWorkshop.test.ts`, live `live/toolLoading.test.ts`).

Not yet: the inspector's display of deferred/loaded tools; a client view of a card's skills in the card editor; seeding `{ "use": … }` references on the built-in Assistant card (built-in skills are `always`, so they'd add nothing yet); wires for Bedrock, Vertex, OpenRouter and DeepSeek.

## 11. Open questions

1. **Hosts without a wire** (OpenRouter, DeepSeek, Bedrock, Google). Today they get every tool from the start. Alternatives: (a) grow `tools` at a load and pay one full cache write per load (shown in the inspector), or (b) one immediate `call_tool { name, arguments }` dispatcher whose loaded definitions travel as tool-result text, which never changes `tools`. Example: a DeepSeek workshop that loads `cards` mid-run would cost one ~9k-token uncached request under (a), and nothing extra under (b), at the price of the model calling tools indirectly.
2. **Should built-in skills come only with the Assistant card?** Making them `always: false` and listing them on the seeded card would let a user's own workshop card choose its skills; a card without them would still reach every tool through `tool_search`.
