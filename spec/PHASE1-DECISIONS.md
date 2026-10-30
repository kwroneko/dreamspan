# Phase 1 decisions and the next work (2026-10-28)

Status: the owner's answers of 2026-10-28 on the Phase 1 build (deployed 2026-10-27, master b129497), plus the defaults the coordinator settled where the owner left the choice open (marked **default**). The full question write-ups, with file:line references to the built code, are in `work-folder/2026-10-27/DECISIONS.md`; where that file and this one differ, this one wins. Each item names what to change; "keep" means the build already does it.

Once built, each item moves into ARCHITECTURE.md and the matching DESIGN.md item becomes **Decided** (owner-stated items) in the same commit.

## 1. Highest priority: the context inspector

The owner can't test the harness without it; it comes before everything else.

- From **any** generated message or swipe, old ones included, a button opens the exact request that produced it, top to bottom.
- **Storage:** keep storing what was sent (today `rollout_payloads.sent_context_json` per attempt, plus the frozen assembly snapshot). **No** reconstruction from references: the owner judged the storage saving not worth the complexity.
- **"Debug symbols":** every part of the request records what it is and where it came from: which preset prompt (name), which card and which field, which note, which lorebook and entry, which history message (and version), the added closing user turn, summary blocks, macros' sources where practical. Check what the assembler already records (ARCHITECTURE §15, "a record of where every piece of it came from"; `env.piece` ids such as `card:<id>:description`) and fill the gaps.
- **Display:**
  - one clearly separated block per user / assistant / system turn, in order;
  - inside and around the turns, titled boxes grouping the parts, each title saying what the content is and where it's from;
  - **all prompt text verbatim**; the inspector's own additions (box titles, labels, source links) must be visually unmistakable from the actual prompt text;
  - easy to read and well formatted, at desktop 1440 and phone 390, light and dark;
  - nice to have: notes and prompts skipped by their condition this turn, shown as "not sent" entries (today only sent notes appear).
- Existing: "Context it was generated from" in a generated version's menu, `e2e/inspector.spec.ts`, ARCHITECTURE §15. Its test "a long context opens collapsed" fails on master because new chats now summarize: set that test chat's summarization off.

## 2. RP loop

Guidance and speaker-picker corrections are built for saved and pending chats (U06, 2026-10-28); their implemented behavior lives in ARCHITECTURE.md §12.

- **Guidance (owner).** Guidance changes only *who writes*, never *which character*. Off: Enter sends your text as the selected speaker's message. On: Enter makes the model write the **selected speaker's** message following your text as the direction (persona or card alike). **Change:** the build generates for the "Reply from" / next-in-turn character.
- **Speaker picker (owner).** "Writing as" lists only the chat's cast (the persona and the cards in the chat). To speak as another card, add it to the chat first. **Change:** the build lists library cards and silently adds the chosen one.
- **Closing user turn (owner).** Added only when there's no new user text **and** no user-role prompt follows the history. It goes right after the last chat message (before any system prompts that follow). **No warning** on messages or replies; it's visible only in the inspector. **Change:** remove the per-reply warning; check placement. *(Replaced by DESIGN §2.2's end-of-request instruction, owner 2026-10-29: there's no closing user turn; the end-of-request message is always last, and the only fallback is a bare `[Write {{speaker}}'s next message.]` when its texts are empty, nothing is prefilled and the request would end on assistant.)*
- **Persona change (owner).** Changing persona swaps the persona definitions, as ST does (the cache is rebuilt; the history is untouched: old messages keep their speaker's name). Several personas = add cards to the cast and switch the speaker.
- **ST prompt triggers (owner).** ST's per-prompt generation-type triggers (normal, swipe, regenerate, continue, impersonate, quiet; none set = always) are kept **in addition** to our conditions wherever they fit our model, and are a **normal per-prompt option in the preset editor**, not only an import artifact. Where a trigger doesn't fit our model, decide case by case whether we don't need it or it shows a gap in our model (write those cases up for the owner rather than guessing). **Change:** the build dropped the filter in favour of conditions.
- **Group nudge.** Sent whenever the model writes as a character (our model has no group / one-on-one distinction; the persona is a cast card). Keep; register it as a documented ST difference in the gate. *(Its placement is replaced by DESIGN §2.2's end-of-request instruction, owner 2026-10-29: it's the "when a character speaks" text, in the request's last message; the gate's difference is "End-of-request instruction".)*
- **Muting and presence (owner):** one thing, shown as Mute. Keep.
- **Preset export to ST (owner):** keep as built (conditions back to triggers where they map; nudge and impersonation back into ST's fields; the added direction prompt exported switched off). *(The direction prompt part is replaced by DESIGN §2.2's end-of-request instruction, owner 2026-10-29: the direction text is `directionPrompt`, outside the order, and isn't exported, since ST has no such field.)*
- **Impersonation prompt on ST preset import (default):** placed last, where ST sends it. *(Replaced by DESIGN §2.2's end-of-request instruction, owner 2026-10-29: it's the "when your card speaks" text, outside the order, sent in the request's last message.)*
- **On an impersonation turn (owner):** the speaking card's prompt override applies (impersonating the persona: none).

## 3. Notes

- **Principle (owner): no hidden note kinds.** Notes are plain things users create and edit; a note's behaviour is fully described by what the note shows. **Change:**
  - remove the `persona_description` note kind and `placedPersonas` (a note's kind silently removed the persona's description from the persona marker, even when the note was off);
  - audit every place where a note's kind, title or origin changes behaviour beyond its visible settings (`character_author_note`, notes from `module_id`, the imported ST summary note and `{{summary}}`, special handling of "the author's note", `on_by_default` quirks) and remove each or make it a visible setting on the note.
- **ST persona import (owner).**
  - ST had the persona at the preset's persona marker: the text is the persona card's description.
  - ST had it at the author's note top/bottom, at a depth, or nowhere: the importer writes the text into an **ordinary** note on the persona card and leaves the card's description **empty** (one copy, nothing hidden). For AN top/bottom, the position is decided per imported chat from that chat's own imported author's note: same depth and role, immediately before (top) or after (bottom) it. One persona note at the position the imported chats share; a chat whose author's note sits elsewhere gets its own position for that note without copying the text (check how card notes' per-chat positions are stored). Check in ST 1.19.0's source whether ST still sends the persona when the chat's author's note is empty or disabled.
  - New chats: nothing special; a persona-card note goes where notes go by default.
- **ST per-character author's note (owner):** imported as a card note on that card; the chat's author's note becomes a chat note; "replace" never replaces anything.
- **Card note placed "with the definitions" (owner):** inside that card's own part.
- **Conditioned note above the history (owner):** allowed; a user choice. A cache warning may show; nothing is restricted.
- **Deleting a shared note that slots link to (default):** keep as built (to the bin; its slots send nothing and offer Restore and Unlink).
- **Shared notes:** global only for now; chat-scoped ones come with snippets. **Implemented 2026-10-28; obsolete as a proposal:** snippets extend the same store with fork-scoped bindings (ARCHITECTURE §14).

## 4. Assembly

- **Card prompt overrides (owner, already decided):** a preset setting per prompt, as in ST; ours default to "no". An imported ST preset keeps the value its file carries. Keep.
- **`<Name>` wrappers (owner):** there is never only one character (`{{user}}` is a cast card), so every cast card's definitions, the persona's included, are always wrapped as `<Name>…</Name>`. **Change** if the persona isn't wrapped today.
- **New lore entry above the history while pinned (owner):** add it immediately. Keep.

## 5. Summarization

- **Default sizes (owner):** recent history target 12,000 / maximum 20,000 tokens; summaries target 14,000 / maximum 18,000. (Summaries cover unbounded history; recent chat grows faster, so it gets the wider target-to-maximum gap.) **Change** from 16,000/24,000 and 8,000/12,000.
- **Summary blocks vs `{{summary}}` (owner, correction).** Summaries are **separate blocks placed like the chat history**, usually just before it, so a new summary never invalidates the ones before it. `{{summary}}` exists only for an imported ST chat's single monolithic summary note text. **Change:** the build made `{{summary}}` a placeholder for the summary blocks.
- **Notes in summary requests (owner).** A summary request can't send the current notes (they may describe events after the summarized range). Add a setting "include notes in summary requests", overridable per chat, **default off**. A point-in-time snapshot of the notes at the cutoff may come later.
- **Summary length unit (default):** state the requested length in words (about 0.75 words per token); models follow word counts more reliably than token counts.
- **Imported ST summary note when summarization is switched on (owner):** switched off in the same step, visibly on the note; the user can switch it back on.
- **ST chat whose Summarize extension was disabled (default):** the note imports switched off, as ST sent nothing. Keep.

## 6. Import report

- Nobody reads it, and it's bloated. Never rely on it to carry information the user needs. **Change:** cut it down to what a user must act on.

## 7. Small fixes (default: fix all)

26. Hide the "Muted" switch on cards you play (the persona's row).
27. The Cast tab's "N characters" counts only characters you don't play.
28. At 390 px, put the composer's actions under the text box.
29. The one-time impersonation notice wraps cleanly at 390 px.
30. Under Main in the preset editor: "A card's own prompt can replace it".
31. A global lorebook also attached to the chat: listed once, under Global, with the per-chat switch.
32. (Covered by §6.)
33. Lowering a summarization maximum below its target lowers the target with it, and says so.
34. Revisit after §5's `{{summary}}` correction.
35. A shared note's "edits change it in N places" counts every linking slot.
36. Preset editor overlay: stale Find match list; content showing above the sticky toolbar; "At depth N" notes listed twice; a missing "Tail starts" divider when Chat History is last; notes placed at the author's note top/bottom appear in no slot.
37. Part of §1 (skipped notes in the inspector).

Also from the reviews, code lows for a cleanup pass: `DECISIONS.md` "Not decisions" list.

## 8. ST fidelity gate

Run `npm run test:st` locally (Docker works on the owner's machine) on master after the fixes. Every intended difference gets a documented matcher with its explanation in ARCHITECTURE §15: the group nudge in every chat, the closing user turn, conditioned prompt order, `<Name>` wrappers, the removed one-character ST mode. *(The nudge, closing turn and conditioned order are replaced by one "End-of-request instruction" difference, DESIGN §2.2, owner 2026-10-29; `{{char}}` in groups is listed too.)* Anything else that differs is a bug.

## 9. Work order for the next run

1. The context inspector (§1). Merge, deploy.
2. The fix batch (§2 to §6, §8). Merge, run the gate, deploy.
3. Small fixes (§7). Merge, deploy.
4. Phase 2 as far as the budget goes (owner: "Phase 1, then Phase 2"), in the handoff's order: fork independence units (1–3 clean on `fi-3`; 4 on `fi-4r` needs a full check; 5–9 not started), card forks (`d-1r` built, unreviewed), snippets, search and replace.

Deploy after each milestone once master is green: back up `the data folder` first (verify the copy), never wipe it.
