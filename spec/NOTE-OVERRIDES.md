# Notes that replace prompts: UI, cache display and assembly

**Status:** Built 2026-11-05 (job noteoverrides); **obsolete as an implementation requirement**: what is built is in ARCHITECTURE §12 ("Notes that replace prompts") and §15 ("Replacements"). Kept as the design record for DESIGN §4.2. **[D]** marks the owner's decisions (quoted in DESIGN §4.2); everything else here is **[P]**, the coordinator's or this job's choices, open to the owner's change.

This completes DESIGN §4.2's **[O] Still to design**: the UI on every surface, the cache-breakpoint display and the assembler changes. reference-harness has no counterpart (it has no presets or card fields to replace); the assembler part is a delta from our own registered pipeline (ARCHITECTURE §15), not from reference-harness.

## 1. The model

- **[P] A note's target** is `replaces` on the note document (`@dreamspan/shared/docs/note.ts`, `ReplaceTarget`):
  - `{ kind: "preset_prompt", identifier }`: a preset prompt by its identifier, resolved in whichever preset the chat uses (DESIGN §4.2 [P], preset updates). Markers (where the chat or the cards go) and the end-of-request texts aren't targets: they have no text of their own to replace.
  - `{ kind: "card_field", field, card? }`: one of the card's prompt fields (`description`, `personality`, `scenario`, `mes_example`, `system_prompt`, `post_history_instructions`; a persona has only `description`). `card` names the character's place in the chat; a card's own note leaves it out for its own card.
- **[P] Its own position** is `own_position: true`. Absent, the note goes where its target goes and its `placement` is ignored (DESIGN §4.2 [D] placement). On, the note goes at its `placement` as any note, and the target is left out.
- **[D] On/off and empty:** off, the target is sent as it is; on and empty, the target is left out.
- **[P] No schema change:** both are optional keys of the note document (JSON in its revisions). Not a baseline change.

## 2. The UI

The owner's rule for every placement below: no invented space or rows. Each sits in a place the real UI already has (screenshots before the change: `<work>/artifacts/noteoverrides/before/`).

### 2.1 A replaced card field or preset prompt (owner, 2026-11-05)

- **[D]** The field itself is visibly changed: "A line above it won't do it. I am thinking a glowing blue border, maybe, but it also can't be obnoxious and too eye-catching. Just obvious enough it cannot be ignored when editing the field."
- **[D]** Tabs and the changed field together: "this isn't exclusive with the tabs. I simply don't see why we wouldn't have both. It's just about which tab is shown first and how to style this."
- **[P] (coordinator, told to the owner)** While a note replaces the field in the chat being viewed, **As replaced** opens first, since that's what is sent. Its box carries the glow and its edits go to the note, which is named and linked. **Original** shows the card's or preset's own text, editable as usual.
- **[P] Where the tabs go:** two compact tabs (`ui/FieldTabs.tsx`) at the end of the field's label row, which already spans the field's width with only the label at its start. A prompt's text has no visible label: the tabs take the place of its label row, just above its box.
- **[P] The glow:** a `--replaced` blue (hue 245, a little apart from the focus ring's 265 so focus stays distinguishable) on the box's border with a 1 px ring and a 10 px soft shadow at a third of its strength (`[data-replaced-field]`, `styles.css`). Light and dark have their own value.
- **[P] The note named and linked:** under the box, in the field's description line, "Replaced in this chat by the note **‹title›**." (a link that opens the note in the large note editor over the chat); for a note with its own position, "Left out in this chat: the note ‹title› goes at its own position instead."; for a note with a condition, "…, on the turns it applies to."
- **[P] Collapsed prompts:** a preset prompt's row says **replaced in this chat** as a badge in the row's existing badge line (where the summary badge goes), so it shows closed too. Card fields are never collapsed.
- **[P] Which notes count:** the ones the next reply's assembly found on in this chat (`PresetContext.replacements`, §3): replaced, at its own position, or on but not due this turn. Outside a chat (the library's own editors) nothing is replaced, and nothing shows.

### 2.2 Starting from the current text

- **[D]** Easy, "without always-visible affordances for this specific case".
- **[P] Replace with a note in this chat:** a note icon in the field box's own strip (the row inside the box's bottom border with its edit history and Open large), shown on hover and focus like the strip's other controls, in every card prompt field and preset prompt in a chat. It makes a note of the chat's own titled after the target ("Mira's Description", "Main Prompt"), with the field's current text (unsaved typing included), on from the latest message of the branch shown; the field then shows As replaced. The design report's [P] of the field's ⋯ menu doesn't fit card fields, which have none; the strip is the one place both kinds of field share.
- **[P] Copy its current text:** in the note's ⋯ menu, first; it puts the target's current text (as resolved in this chat: the card that fills the place now) in place of the note's text. Disabled, with its reason, on a note that replaces nothing.
- **[P] `{{original}}`** in the note's text is the target's own text, expanded (DESIGN §4.2 [P]); once, as card prompt overrides do.

### 2.3 The note editor

- **[P] Replaces** is the first row of the note's settings (a registered section, `editor.note-settings`): a select ("Nothing", the preset's replaceable prompts in order, then each cast card's prompt fields, "Mira's Description"); a card's note offers the preset's prompts and its own card's fields only. Beside it, an **Open ‹target›** icon button opens the target in its editor (the preset's large editor at the prompt, the card's full editor), and the **Its own position** switch.
- **[D] Position switch:** Position, Depth and Role are greyed (with a hover saying why) until **Its own position** is on; switching it on prefills them from the prompt where that applies (a depth prompt's depth and role; another prompt's role). A card field has no placement, so the note's own stays.
- **[P] The header** says it: "In place of Mira's Description · always" (no role: it's sent as the prompt is), or "Depth 4 · replaces Mira's Description · always · as system" with its own position.
- **[D] One note per target:** picking a target another note of the chat (on or off) replaces shows "Only one note can replace ‹target›" with **Unlink ‹other›**, which takes the other's target away and sets this one. **Replace with a note in this chat** asks the same in a dialog.
- **[P] Missing prompt** (DESIGN §4.2 [P]): "Its prompt isn't in the selected preset. Pick another one to replace, or switch on Its own position." The select is the relinking picker.
- **[P] Forbid overrides** (DESIGN §4.2 [P]): a card's note on a prompt that forbids overrides says it isn't sent in that prompt's place.
- **[P] Every note kind** (DESIGN §4.2 [D]): the chat's own notes and card notes (personas' included); a shared note's own text has no target (the slot linking it has).

## 3. Assembly: the documented interface

- **[P] The `replacements` stage** (`packages/server/src/assembler/replacements.ts`), registered after `note-gate`, is the one place that decides what a note replaces this turn. It reads the notes that are on (`assembly.notes` and `assembly.skippedNotes`), resolves each target (a card field's place through the path's `card.swap` events: the card forked for this chat, or another version, takes the note), and records each note's outcome in `assembly.noteReplacements` (snapshot `noteReplacements`): `replaced`, `own_position`, `not_due`, `forbidden` (a card's note on a prompt that forbids overrides), `missing`, `disabled`, `conflict`. One note per target: the first in note order (the chat's before cards', each by id) wins and a `note_replacement` issue records the clash. Notes that go in their target's place are taken out of the notes to be placed.
- **[P] Composition** (`withReplacement` in `stages.ts`) sends the note's text in the target's place, as a piece whose source is the note (so the request inspector names it), expanded as the target would be (a card field's bindings, trimmed and cleaned as fields are); a card's note replacing a preset prompt has `{{char}}` as its card. A note at its own position leaves an empty piece. A note's condition makes the target volatile, due or not.
- **[P] Card prompt overrides:** a note replacing `main` or `jailbreak` wins over the speaking card's system prompt or post-history instructions; a note replacing the card's `system_prompt` field changes the override's text.
- **For Phase 4 (agent tools):** to change a card or prompt in a chat, create a note with `replaces` (and `content`, and `placement` with `own_position` for text going elsewhere), and turn it on at the version that produced it. `CreateChatNote` takes `replaces` and `content` for this. Nothing else in assembly needs to know; disabling the `replacements` stage turns the feature off (notes then go at their own placements).
- **[P] Version:** `ASSEMBLER_VERSION` 48 (47 is Phase 4's agent replies). Agent replies assemble through the same stages, so a card-swap reply's tail card takes a replacing note as the card's place does; `RebuildContext` replays it from the snapshot's pinned notes.

## 4. The cache-breakpoint display

- **[P]** The preset editor's token counts and **Cache breakpoint** dividers come from the next reply's assembly (`PresetContext`). A replacing note's piece counts as its target's block (a card field's as the marker it's sent in), so a replaced prompt keeps its token count and the dividers stay where the prompt is; the note isn't shown again in a slot of its own.
- **[P]** The note editor warns when a note with a condition goes in a place above the history (a card field, or a prompt above the chat history): "In a place above the history, it rewrites the cached part of the context whenever its condition changes." A note without a condition invalidates the cache from its target on once, when it's switched on, off or edited, as DESIGN §4.2's Phase 4 entry expects.
