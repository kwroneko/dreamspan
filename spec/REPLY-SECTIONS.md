# Tagged sections at the start of a reply

Status: proposal (coordinator's design, owner request 2026-10-31), recorded in DESIGN §7.4 as [P]. Built in the same branch; once merged, the implemented behaviour lives in ARCHITECTURE §12 ("Reply sections") and this file is obsolete as a plan.

Some prompt presets ask the model to begin its visible reply with a planning section in tags (`<think>…</think>`, `<thinking>…</thinking>`). That text is in the reply the user receives. SillyTavern's "Reasoning formatting → Auto-parse" moves such a leading section out of the body into the reasoning panel. This does the same, as a layout of text the model already returned: nothing is hidden, nothing is asked of the model.

## Deltas from SillyTavern (`public/scripts/reasoning.js`)

| | SillyTavern | Here |
|---|---|---|
| Tags | one literal prefix and one literal suffix | a list of opening/closing **pairs**, literal text matched exactly by default (owner, 2026-11-02: "ST does not even support regex there"), a pair opting into regex with "Treat as a regex"; case-insensitive by default. Default pairs `<think>` / `</think>` and `<thinking>` / `</thinking>`. (This spec first proposed regex pairs, default `<think(?:ing)?>` / `</think(?:ing)?>`; overtaken.) |
| With a provider reasoning field | parses only while the field is empty | parses whether or not the provider sent reasoning; both are kept, apart |
| Where | the start of the message | the start of the reply, after whitespace; several consecutive leading sections are all taken; tags later in the text are left alone |
| Setting lives in | `power_user.reasoning` (global) | the prompt preset (`reply_sections`), beside End of request; an ST folder import applies `power_user.reasoning` to the presets it imports, its prefix and suffix as one literal pair, as written (tags are literal unless a pair opts into regex; owner 2026-11-02) |
| Sent back | `add_to_prompts`, last `max_additions` messages with reasoning, provider reasoning included | off by default; the preset's "send back on the last N replies" sends a section back wrapped in its original tags. Provider reasoning is never sent (unchanged). |

## Data

- Preset document: `reply_sections?: { enabled, pairs: [{ open, close, case_sensitive?, regex? }], send_back }`. Absent means the default (on, the default pair, send_back 0), so new and built-in presets get it.
- Version: `versions.reply_sections` (JSON, baseline schema edit, no migration), exposed as `Version.replySections = { sections: [{ lead, open, text, close, prefilled? }], gap }`. `content` is the body without the sections. `lead` (whitespace before a tag), the exact `open`/`close` text and `gap` (whitespace before the body) make the original reply `lead + open + text + close … + gap + content`, byte for byte. `close: null`: the reply ended inside the section. `prefilled`: how many leading characters came from the request's prefill (a preset prefill that opens a section), not from the model.
- The provider's reasoning stays in `versions.reasoning`.

## Parsing (a registered reply parser)

- `ExecutionRegistry.replyParsers`, built-in `reply-sections`. The generator runs every registered parser over the chunk stream, in registration order; a plugin can replace, wrap, disable or add one.
- States (a literal tag is held exactly while the text still begins it; the limits below are for regex pairs): *lead* (holding the start of the reply until an opening pattern matches, or the held text can no longer start one: a line break after non-whitespace, 64 characters, or the end), *inside* (section text streams to the panel, held back only from a character within the last 64 that may start the closing tag), *after* (whitespace after a close is held until the next character shows whether another section opens), *body* (pass-through). A tag split across deltas parses; text never flashes into the body first. Tags are at most 64 characters.
- What the parser holds back is reported to the generation service, so a stop, crash or failure ends with it in the right place.
- Never closed: the text stays in the panel and the body is empty, as ST's streaming leaves it (`ReasoningHandler.finish`); the panel says the section was never closed.
- Continue: the prefill is the original reply (sections in their tags, then the body), as SillyTavern's prefix. A version cut off inside a section resumes inside it.
- A preset prefill that opens a section (`<thinking>` as "Start reply with") starts the reply inside it.

## Display

- Two collapsible panels above the body: "Reasoning" (provider) first, then "Thinking in the reply". Both follow the streaming open/closed preference; Copy and Collapse all cover both; selection copy maps both.
- The panels are entries of the `message.reasoning-panels` slot; their header actions are the existing `message.reasoning-actions` slot, with the panel's kind in its props.
- "Show as reply text" (a header action of the sections panel) makes a new edited version whose text is the original reply, keeping the provider reasoning; the parsed version stays in the version picker. Model output stays frozen.
- Streaming (owner, 2026-11-02): once the opening tag has fully arrived, everything after it streams to the panel, not the body, until the closing tag; the panel header reads "Thinking…" until the body starts, folded or open as the streaming preference says, live when open. `Section { versionId, offset, text }` events carry the panel text (sections joined by a blank line); `Hello` carries it for live versions.

## Requests

- History sends the body only, unless the preset's `send_back` is N > 0: the last N replies that have sections send them in their original tags before the body (an assembler stage after `history`, so it can be replaced). Those messages are volatile for the cache prefix: they lose the section as the chat grows.
- Summaries see the body only. Token counts and the context inspector reflect what is sent.

## ST chats

- Import: `extra.reasoning` with `extra.reasoning_type: "parsed"` becomes a section in `<think>` / `</think>` (ST's default tags; ST doesn't store the matched text); any other type stays `versions.reasoning`.
- Export (`stReasoningExtra`, for the ST chat exporter; the app has none yet): a version with sections and no provider reasoning exports them as `extra.reasoning` with `reasoning_type: "parsed"` and the body as `mes`; with both, provider reasoning goes to `extra.reasoning` (`"model"`) and the sections stay in `mes` in their tags, so nothing is lost.
