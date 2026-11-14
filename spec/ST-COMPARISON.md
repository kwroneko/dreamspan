# SillyTavern versus rp-harness on the same data

**Status: completed comparison, 2026-10-14.** Stock **SillyTavern 1.19.0** versus master **`7af349035f1f3debd9a7ea3d6bb1f035b9530fbe`**. This records master, not the unmerged R4 work. No application code was changed.

The owner's verdict is supported by the walkthrough. Master has a much clearer home and a stronger underlying chat/version model, but everyday group roleplay still takes more navigation and leaves less story visible. Several controls exist without providing ST's equivalent workflow. The biggest immediate differences are reading density, deciding who replies, keeping the selected persona, portraits, and repeatedly editing notes and presets.

## How this was made

- Read `CLAUDE.md`, PLAN's “Next session”, `ST-GRIPES.md`, the implemented differential-harness architecture, and the realistic fixture instructions in `scratchpad/units/common.md`.
- Ran `npm ci` and `npm run build` in this worktree. Generated the folder with **`writeRealisticStFolder(dir)`**, directly from `packages/server/test/support/stRealistic.ts`, under the work directory's `synthetic/`. Used no real cards, chats, ST installation, other machines, or `~/`.
- Copied that generated `default-user` folder into `st-container/data/default-user`. Used **the repo's `startSt()`**, not a separately chosen image/configuration: `ghcr.io/sillytavern/sillytavern@sha256:eef27ff0c7961f1a2f488400f581f48ff38f8b910c5d3b8d389138d71791bb14`, host networking, loopback whitelist, calling UID/GID, `rp-st-diff-*` names and `rp-harness.st-diff.owner` PID-namespace/PID label. Did **not** call the harness's orphan remover; only this run's containers were removed by their registered exact-name stop functions.
- Stock ST fills in its fresh-install defaults and adds its bundled character/persona. Kept those defaults, disabled first-run onboarding, and pointed its custom OpenAI-compatible connection at the repo's loopback `startMock()` (`st-diff-model`). Preset-to-connection binding was disabled so imported presets could not move traffic away from the mock. The synthetic preset selected in both apps was **Celia 4.2**. No external model or real key was used.
- Ran our development entry point with **`HOST=127.0.0.1 PORT=5994 FAKE_GENERATOR_TPS=60`**, fresh `app-data/`, and `IMPORT_START_DIR` pointing at the synthetic folder. Imported by the actual UI: Folder path → Look in this folder → Import. Added a synthetic local connection and refreshed its model list through Settings; selected the model in This chat.
- Drove Chromium with Playwright, **1440×900 and 390×844**, DPR 1, en-US, UTC. Used real UI clicks for the task paths; URL navigation was used to restore/setup a capture, not counted as a shortcut. Captured viewport PNGs and accessibility snapshots, inspected contact sheets and key full-size images, and retook frames with a fading overlay or the wrong scroll position. The long-chat density captures are pinned to the same final message before any edits/deletion/generation.
- Performed and checked message edit/save, swipe selection, message deletion, presence changes, triggering Aria, switching personas, note revision/save, preset toggle/save, new-group first send, opening Karen's 420-message chat, and switching its imported 355-message branch. Extra synthetic edits/replies were confined to these disposable copies. ST's continuation appended the mock reply without adding a message. Our fake generator has different output, so generated-reply length is **not** used to compare density or model quality.

**Evidence locations.** The committed set is **30 PNG pairs / 60 PNGs**, in [st-comparison/](st-comparison/). Each pair means ST and ours at the same viewport, doing the same task; a confirmation dialog versus Undo, or an unsupported editor versus a working editor, intentionally shows different results of that task. The complete raw desktop/phone set, scripts, fixture, measurements and full command logs remain outside the commit at:

```text
<scratchpad>/
  raw/           PNGs and matching accessibility snapshots
  scripts/       stack.mjs, numbered Playwright steps, curate.py
  logs/          npm-ci.log, build.log, app.log, stack3.log, check.log,
                 walkthrough-record.log and numbered per-step logs,
                 r4a-r4e logs/stats and focused source reads
  metrics.json   computed geometry and visible-character counts
  manifest.json  the 30 committed pairs
```

For a task whose phone frame is not curated, its raw paths are `raw/st-<capture>-phone.png` and `raw/ours-<capture>-phone.png` under that root. These files are intentionally not all committed. Card inspection reuses ST's unobstructed card-editor frame (`st-06-editor`) instead of the first embedded-lorebook import question. Notes reuse `st-08-notes`. The fixture's art is a gray placeholder, not realistic portrait artwork: **size, shape, click behavior and placement are verified; visual fidelity/cropping of real artwork is not**. ST's first selection of Karen creates a greeting-only chat because the fixture does not set a current single-chat pointer; the explicit history path is used to open the matching 420-message file. Do not generalize that initialization detail to an established real ST installation.

Counts below are navigation/action clicks; they exclude text-field focus/typing, hover, scrolling, waiting, import/setup and resetting a screenshot. A dropdown selection counts opening and choosing (two clicks), even where Playwright's `selectOption` sets the value in one command. Counts start with panels closed unless stated. **D/P** means desktop/phone; an unavailable action has no finite completion count. Phone results are browser viewport checks, not a measurement of a physical phone's keyboard, touch browser or network latency.

## Reading the same 380-message chat

Measured at the bottom of **The Lantern Inn**, original messages #374–#380 (our numbering is one-based; ST's internal IDs are zero-based). Both apps display the same synthetic prose and the same final Captain Rhee message. Character counts include only message-body text whose glyph rectangles are fully inside the message scroller and viewport; they exclude names, dates, controls, composer, sidebar and clipped lines.

| Measurement | ST desktop | Ours desktop | ST phone | Ours phone |
|---|---:|---:|---:|---:|
| Message portrait | 50×50 px | 40×40 px | 50×50 px | 32×32 px |
| Width/height ratio | 1.00 | 1.00 | 1.00 | 1.00 |
| Shape | Circle | Circle | Circle | Circle |
| Body font | 15 px | 16 px | 15 px | 16 px |
| Body line height | 23 px | 25.6 px | 23 px | 25.6 px |
| Message-box width | 720 px | 768 px | 388 px | 390 px |
| Message padding, T/R/B/L | 10/10/0/10 px | 10/12/10/12 px | 10/10/0/10 px | 10/10/10/10 px |
| Text element width | 640 px | 690 px | 308 px | 326 px |
| Text element horizontal padding | 30 px right | 0 | 30 px right | 0 |
| Usable text column | 610 px | 690 px | 278 px | 326 px |
| Message scroller top→bottom | 35→859.5 px | 93→837 px | 35→803.5 px | 134→739 px |
| Body characters visible | **1,583** | **1,117** | **916** | **605** |
| Messages with visible body text | **7** | **5** | **4** | **2** |

The wider text column does not compensate for our larger type, taller rows, gaps and permanently visible version footers, including `1/1`. Juniper's same original reply is **203 px high in ST versus 269.16 px here** on desktop. Ours shows **29.4% less text on desktop and 34.0% less on phone**. On phone our shell, chat header, context banner and two-row composer leave a 605 px message viewport; ST leaves 768.5 px. Larger type can be comfortable, but the loss of scene context is a real cost and there is no equivalent compact-density control here.

**Portrait shape correction:** fresh ST 1.19.0 defaults to circles. It would be inaccurate to call rectangular portraits its untouched default. Its User Settings offer Circle, Square, Rounded and **Rectangle**; selecting Rectangle measured **60×90 px, ratio 0.667, 10 px corners**. Master offers no corresponding shape choice. Those optional-ST screenshots are `raw/st-22-rectangle-{desktop,phone}.png`; the density table uses the default circles. R4-E's rectangular default therefore addresses the owner's preferred ST configuration, while its circle option matches the actual fresh default.

Names are clear in both. ST shows the full date **and clock time** inline; ours shows a short day such as `Apr 1` and a message number, with the precise timestamp relegated to the time element's tooltip. Ours shades user turns and labels hidden/context state, which helps orient the reader, but the repeated controls and banner consume reading space.

## Tasks and observed click paths

### 1. Landing and character list

Screenshots — desktop: [ST](st-comparison/st-01-home-desktop.png) · [ours](st-comparison/ours-01-home-desktop.png); phone: [ST](st-comparison/st-01-home-phone.png) · [ours](st-comparison/ours-01-home-phone.png).

**ST: 1/1 click** on Character Management from its welcome/recent-chats screen. A narrow, searchable list appears beside the desktop chat; on phone it occupies the screen. It includes groups, version numbers and raw HTML-looking creator-note snippets in this fixture. **Ours: 0/0 clicks**: Characters is the landing page, with a grid, groups, search, Recent/Name sort, Never used and separate Inspect/New chat actions. **Better:** useful first screen and deliberate inspection without automatically opening a chat. Our desktop chat-list sidebar still repeats all the individual group sessions and uses considerable width. Capture `01-home` (D/P).

### 2. Open The Lantern Inn, specifically its 380-message session

Screenshots — desktop: [ST](st-comparison/st-02-lantern-desktop.png) · [ours](st-comparison/ours-02-lantern-desktop.png); phone: [ST](st-comparison/st-02-lantern-phone.png) · [ours](st-comparison/ours-02-lantern-phone.png).

**ST: 2/2 clicks on this fixture**: Character Management → Lantern Inn; the group's stored `chat_id` selects the 380-message session. Close the panel for the reading comparison (one additional layout click). **Ours: 1 desktop click** on its named `380 messages` sidebar row; **2 phone clicks** via Chats and that session row. From the home tile, ordinary Continue opens the most recent session (initially 24 messages), so selecting this particular older session uses **All 3 chats → the 380-message row (2 clicks)**. Both can open it directly once their corresponding history list is visible. **Same for explicit-session access, worse for the reading result** quantified above; the app's readable title and cast header are useful. Capture `02-lantern` (D/P).

### 3. Open a one-card chat: Karen Holt, 420 messages

Screenshots — desktop: [ST](st-comparison/st-03-karen-desktop.png) · [ours](st-comparison/ours-03-karen-desktop.png); phone: [ST](st-comparison/st-03-karen-phone.png) · [ours](st-comparison/ours-03-karen-phone.png).

**ST: 5/5 clicks on first initialization of this fixture**: Character Management → Karen → composer menu → Manage chat files → 420-message file. It has five regular sessions, a 355-message branch and the newly opened greeting-only file. **Ours: 2/2 from Characters**: Inspect Karen → choose the 420-message chat; a desktop sidebar row is a one-click shortcut. The header identifies Karen and the fork at message #336. **Better for choosing an existing session and recognizing its branch; worse for reading density**, as in the group. The explicit ST path includes the fixture's missing current-chat pointer, not an established ST user's steady-state resume cost. Capture `03-karen` (D/P), retaken with both at the same original final message.

### 4. Portraits and opening the image

Screenshots — desktop: [ST](st-comparison/st-20-portrait-desktop.png) · [ours](st-comparison/ours-20-portrait-desktop.png).

**ST: 1/1 click** on a message portrait opens a separate image window; measured 360×364 px in this placeholder test, placed beside the desktop chat and over it on phone. **Ours: unavailable**: clicking the message image does nothing; the element is a plain image, with no button role or keyboard target. **Worse:** smaller portraits, especially on phone; no shape control; no image view alongside the scene. **Addressed by r4e** (size/style options and full-image panel). The placeholder cannot establish which app crops real art better. Capture `20-portrait` (D; raw P) and default portraits in `02-lantern`.

### 5. Swipe the latest reply and inspect its versions

Screenshots — desktop: [ST](st-comparison/st-12-picker-desktop.png) · [ours](st-comparison/ours-12-picker-desktop.png); phone: [ST](st-comparison/st-12-picker-phone.png) · [ours](st-comparison/ours-12-picker-phone.png).

The fixture ends with a user turn, so neither app's “latest assistant reply” is literally the final message. After the matched deletion task removes that user turn, Juniper is the final reply with four existing swipes. **ST: 1/1 click** on the right arrow to go 1/4→2/4; **ours: 1/1** on Next version, producing the same text. Opening the picker and choosing a listed version is **2/2 in each**. ST opens Swipe Selection with full texts, search and sort; ours opens a short radio menu with two-line starts. **Same for stepping; worse for reviewing many alternatives. Partly addressed by r4b:** star/hide/filter/compare and model attribution, but its ordinary list still uses two-line previews and does not reproduce ST's search/sort. Capture `12-picker` (D/P); raw stepping captures `12-swipes`.

**Older replies:** ours retains arrows and regeneration on earlier assistant turns without erasing their continuation; ST's normal arrows are at the tip. **Better.** Persona-side generation/swiping is an owner's improvement request, but ST's Impersonate also has awkward swipe handling: it is not counted as an ST-relative regression. R4-B broadens version controls to every turn.

### 6. Edit and save a message

Screenshots — desktop: [ST](st-comparison/st-14-message-edit-desktop.png) · [ours](st-comparison/ours-14-message-edit-desktop.png); phone: [ST](st-comparison/st-14-message-edit-phone.png) · [ours](st-comparison/ours-14-message-edit-phone.png).

**ST: 2/2 clicks**: pencil → confirm, with an inline textarea and extra copy/delete/move/reasoning controls. **Ours: 2/3**: Edit → Save; phone first taps the message to reveal its actions. It has a clearly labeled editor and Save/Cancel. The matched synthetic user-turn edit was stored in both. **Same on desktop, worse by one discovery tap on phone; better preservation for generated edits**, which become a new version here. Ours lacks ST's move-up/down controls and Add reasoning block. Capture `14-message-edit` (D/P; the curated retake shows Karen's same final user turn).

### 7. Message actions

Screenshots — phone: [ST](st-comparison/st-13-actions-phone.png) · [ours](st-comparison/ours-13-actions-phone.png).

**ST: 1/1 click** on the visible ellipsis reveals an inline icon strip: copy, exclude/include, embed file/image, checkpoint, branch, translate, narrate and image generation; the edit button remains available. **Ours: 1/2**: More actions, preceded by a tap on phone. Its menu uses useful words: Write your own version, Branch from here, Hide from the model, Copy text and Copy link; additional items depend on versions/run data. **Better labels and direct links; worse phone discovery and a smaller action repertoire**, notably attachments. Translation/TTS/image-generation surfaces were visible in stock ST, but their external services were not configured or performance-tested. Capture `13-actions` (P; raw D).

### 8. Composer: send, choose who speaks and who replies

Screenshots — desktop: [ST](st-comparison/st-04-cast-desktop.png) · [ours](st-comparison/ours-04-cast-desktop.png); phone: [ST](st-comparison/st-04-cast-phone.png) · [ours](st-comparison/ours-04-cast-phone.png); desktop: [ST](st-comparison/st-07-personas-desktop.png) · [ours](st-comparison/ours-07-personas-desktop.png); phone: [ST](st-comparison/st-07-personas-phone.png) · [ours](st-comparison/ours-07-personas-phone.png).

Sending typed text is **1/1 click in each** (typing excluded). ST's empty send requests the group's reply; Impersonate and Continue are explicitly named in its composer menu. Our Generate visibly says only “Generate”; its accessible name in this group is **Generate Captain Rhee**, and it writes the currently selected persona's turn. Sending gets the first present character the user does not play. To ask Aria, ST and ours both support **members panel → Aria's trigger (2/2)**, but master has no Reply from control in an established chat and no turn strategy. **Worse for daily group direction and the meaning of Generate. Addressed by r4a** for explicit reply choice, round-robin and clearer persona generation. Its pending-new-group page already has separate Playing as/Reply from selectors; the established composer is the gap. Captures `04-cast`, `07-personas`, `16-new-group`; raw `21-composer-menu` contrasts the established composers.

### 9. Group members: mute/presence and trigger a reply

Screenshots — desktop: [ST](st-comparison/st-04-cast-desktop.png) · [ours](st-comparison/ours-04-cast-desktop.png); phone: [ST](st-comparison/st-04-cast-phone.png) · [ours](st-comparison/ours-04-cast-phone.png).

**ST: 2/2 clicks**: Character Management → mute icon or speech icon for a member. Its panel offers Natural/List/Pooled/Manual reply strategy, member reordering, self responses and Auto Mode. **Ours: 2/2**: Cast → Present switch or Speak now. Presence was switched off/on for Rook and Aria's reply was generated in each app. Our Cast includes played-by-you, Write as, definition inspection and edit scope; it is clearer about card actions. **Same reachability, worse group strategy/automation. R4-A partly addresses it**; it does not supply all of ST's strategies or Auto Mode. When absent, our switch is unchecked but still says **“Rook is Present”**; ST grays the member and changes the mute control. No R4 branch addresses that wording. Capture `04-cast` (D/P); raw `04-muted` and `17-trigger` (D/P).

### 10. Character card view/edit from the chat

Screenshots — desktop: [ST](st-comparison/st-05-card-desktop.png) · [ours](st-comparison/ours-05-card-desktop.png); desktop: [ST](st-comparison/st-06-editor-desktop.png) · [ours](st-comparison/ours-06-editor-desktop.png).

**ST: 2/2 clicks**: Character Management → Aria's View character card; the resulting side panel is editable. This fixture also asks whether to import Aria's still-unimported embedded lorebook (one additional No click); that is a third click on the measured path. Text edits then autosave, with no separate revision confirmation. **Ours: 2/2 to inspect**: Cast → Show card; **3/3 to enter editing**: Cast → Edit → Only in this chat/Everywhere. It navigates to the full editor. A saved change adds Save and Save revision, making the tested edit **5/5 clicks** from the closed panel (typing excluded). **Worse continuity and more save ceremony; better edit scope and recoverable revisions.** We completed the same synthetic description edit in ST and in our Lantern-only override. No R4 branch keeps this editor beside the chat. Capture `05-card` (D; raw P) for inspection and `06-editor` (D; raw P) for editing.

### 11. Switch persona, then reopen the chat

Screenshots — desktop: [ST](st-comparison/st-07-personas-desktop.png) · [ours](st-comparison/ours-07-personas-desktop.png); phone: [ST](st-comparison/st-07-personas-phone.png) · [ours](st-comparison/ours-07-personas-phone.png).

**ST: 2/2 clicks**: Persona Management → Kim. Its panel has search, persona description, chat/default locks and character connections. **Ours: 3/3 on first use**: speaker pill → Personas tab → Kim; **2/2 later** when that tab is remembered. It exposes members and all cards too, with recent-speaker shortcuts. **Worse search and persistence:** master has no search in this picker; after selecting Kim, reopening/reloading Lantern resets the pill to Captain Rhee. This was observed, not inferred from the checklist. **Addressed by r4a**, including search. ST's currently selected persona is less obvious in the closed composer, which ours improves. Capture `07-personas` (D/P).

### 12. Author's note from the chat

Screenshots — desktop: [ST](st-comparison/st-08-note-editor-desktop.png) · [ours](st-comparison/ours-08-note-editor-desktop.png); phone: [ST](st-comparison/st-08-note-editor-phone.png) · [ours](st-comparison/ours-08-note-editor-phone.png).

**ST: 2/2 clicks**: composer menu → Author's Note. A floating panel offers text, placement, role, depth, frequency, world-info scanning, character/default notes. Text changes autosave. **Ours: 2/2 to edit**, Notes → Edit Author's Note, in the side panel/sheet. After typing, **Save the note → Save revision adds two clicks**, so a complete change is **4/4**. We saved “Stay inside The Lantern Inn.” in both. **Worse for a repeated small edit:** the additional revision dialog is ceremony in the owner's everyday note workflow. **Better structure:** multiple notes, separate switches, draft history and explicit application from here on on this branch. No R4 branch changes this save path. Capture `08-note-editor` (D/P).

### 13. Lorebook from the chat

Screenshots — desktop: [ST](st-comparison/st-09-lore-editor-desktop.png) · [ours](st-comparison/ours-09-lore-editor-desktop.png); phone: [ST](st-comparison/st-09-lore-editor-phone.png) · [ours](st-comparison/ours-09-lore-editor-phone.png).

**ST: 3/3 clicks to select a book for editing**: World Info → open Pick to Edit → Kepler Station; one more expands an entry. Keys, content, status, placement, depth/order/probability and other conditions are editable. **Ours: 1/1** to see this chat's books and card-owned book status. For an attached book, Open is a second click, but the resulting editor says **“Lorebooks can't be edited here yet.”** Adding Kepler first is Add lorebook → Kepler (two additional clicks). **Worse: cannot complete entry editing.** Its applicable-only list and explicit reason why Aria's unimported embedded book is off are better than an undifferentiated library. No R4 branch supplies a lorebook editor. Capture `09-lore-editor` (D/P); raw `09-lorebooks` shows the original group's list. Identical synthetic world files are deduplicated here, so the library offers Kepler Station rather than two independent identical copies; this is not evidence about distinct real books.

### 14. Preset and prompt controls from the chat

Screenshots — desktop: [ST](st-comparison/st-10-preset-desktop.png) · [ours](st-comparison/ours-10-preset-desktop.png); desktop: [ST](st-comparison/st-10-preset-editor-desktop.png) · [ours](st-comparison/ours-10-preset-editor-desktop.png); phone: [ST](st-comparison/st-10-preset-editor-phone.png) · [ours](st-comparison/ours-10-preset-editor-phone.png).

**ST: 1/1 click** opens AI Response Configuration, retaining the chat beside it: preset, context/output limits, samplers, reasoning/media settings and the prompt-manager toggles. A prompt toggle is **2/2 clicks from a closed panel**, with no Save step. **Ours: 1/1** opens This chat, showing effective Celia 4.2, its source, context budget and a preset selector. To edit, Open Celia in the editor is a second click and leaves the conversation. A prompt change then needs its switch, Save and Save revision: **5/5 clicks** total. The Main Prompt toggle was actually saved in each. **Worse reachability and chat continuity; better explicit effective-value/source display and revision recovery.** None of R4-A–E adds inline preset editing/toggles. **Do not overclaim ST scope:** this ST prompt manager uses a global order; per-chat toggles are an owner's requested improvement, not a proven stock-ST advantage. Captures `10-preset` (D; raw P) and `10-preset-editor` (D/P).

### 15. Connection settings from the chat

Screenshots — desktop: [ST](st-comparison/st-11-connection-desktop.png) · [ours](st-comparison/ours-11-connection-desktop.png).

**ST: 1/1 click** on the plug opens the active connection beside the chat: endpoint, source, model, profile, connection status and test controls. **Ours: 3/4**: Settings → Connections → Synthetic local; phone adds Chats and menu before Settings. We completed these paths in both viewport modes. The full connection page has useful model refresh/editing, routing and secrets management, but the chat is gone from the main view. **Worse reachability and continuity; better connection/model administration.** No R4 branch puts the active connection editor in the chat panel. Capture `11-connection` (D; raw P).

### 16. Start a new chat, especially a group

Screenshots — desktop: [ST](st-comparison/st-16-new-group-desktop.png) · [ours](st-comparison/ours-16-new-group-desktop.png).

The tested ST path from chat is **3/3 clicks**: composer menu → Manage chat files → + New Chat. It immediately starts a chat with **Tobias, Aria, Rook and Juniper all greeting**. The alternative menu → Start new chat path also adds a confirmation. **Ours: 3/3**: Characters → All chats of Lantern → New chat (home's tile has a shorter direct New chat link). It shows a pending chat with Playing as, Reply from and a greeting picker; only Tobias greets. A first Send, performed here, saves the chat. **Same entry cost; worse missing group greetings; better deliberate persona/reply setup and no persisted abandoned preview. Addressed by r4d** for every member's greeting. Capture `16-new-group` (D; raw P).

### 17. Chat history and branches

Screenshots — desktop: [ST](st-comparison/st-18-history-desktop.png) · [ours](st-comparison/ours-18-history-desktop.png); desktop: [ST](st-comparison/st-19-branches-desktop.png) · [ours](st-comparison/ours-19-branches-desktop.png).

**ST: 2/2 clicks**: composer menu → Manage chat files; **3/3** to choose a session/branch. It has searchable filenames, date/time, message count, snippet, import/export/backups, rename and deletion. It is a modal overlay (confirmed by the shadow intercepting toolbar clicks), not a live card side panel. **Ours: 2/2** for Characters → All chats of Lantern; **3/3** to pick a session. A desktop sidebar session is one click. This page leaves the chat view but presents readable peer sessions and their counts.

For Karen's imported fork, **ours: 2/2**, header Branch 1 of 2 → Branch 2, switching to the same imported 355-message branch ST opens through history. Selecting a branch anchors our window at the fork (around #336 here), while ST opens the chosen file at its latest message. Returning to the tip required scrolling through newly loaded windows; this is worse when resuming the story, though useful when inspecting the divergence. **Better click cost and direct branch URLs; worse naming/tidying:** master offers only Branch 1/2 and no branch deletion, whereas ST's file can be renamed/deleted. Chat/group names also have no rename UI here, while ST's group-name field and file renaming are visible. **Addressed by r4d**, including branch rename/delete. Captures `18-history` and `19-branches` (D; raw P); raw `19-branch-view` verifies both chosen branches.

### 18. Delete a message

Screenshots — desktop: [ST](st-comparison/st-15-delete-desktop.png) · [ours](st-comparison/ours-15-delete-desktop.png).

**ST: 3/3 clicks** on the direct path: pencil → trash → Delete Message confirmation. **Ours: 1/2**: delete icon, preceded by a phone reveal tap. A single-version message disappears immediately and a named toast offers Undo and Open the bin. Both deletions completed on the matched final Captain Rhee turn. **Better recovery and cost.** With multiple versions, the primary trash action deletes the selected version; deleting all versions moves to the menu, so the labels matter. ST additionally has a composer-level Delete messages selection/range workflow; master offers individual deletions only. Capture `15-delete` (D; raw P), intentionally confirmation versus completed deletion/Undo.

### 19. Phone layout and task discovery

Screenshots — desktop: [ST](st-comparison/st-02-lantern-desktop.png) · [ours](st-comparison/ours-02-lantern-desktop.png); phone: [ST](st-comparison/st-02-lantern-phone.png) · [ours](st-comparison/ours-02-lantern-phone.png); phone: [ST](st-comparison/st-13-actions-phone.png) · [ours](st-comparison/ours-13-actions-phone.png).

Both fit 390 px without turning the chat into a horizontal page. **ST: 1 tap** on a toolbar icon opens its panel over the chat; phone card/history/settings have the same basic task path. **Ours: 1 tap** on Cast/This chat/Notes opens a full sheet with a clear title and Close control; switching its tabs is easy. **Same fundamental panel behavior**, but our smaller 32 px portraits, reduced story viewport and hidden message-action reveal tap are worse. The top cast line loses the desktop member names; a user must open Cast (one click) to inspect the full lineup. Our displayed persona and recent speakers are better. No software keyboard, physical gesture reliability or mobile performance claim follows from viewport screenshots. R4-E enlarges portraits; R4-A changes the composer; neither branch by itself fixes all density/discovery costs. See the phone pairs throughout, especially `02-lantern`, `04-cast`, `07-personas`, `13-actions` and `14-message-edit`.

### 20. Additional controls encountered in these tasks

**Chat-content history search:** ST's history search, reached in **2/2 clicks**, found files containing “The letter was unsigned, but the handwriting was unmistakable.” in **earlier message bodies**, not just their final snippet. The served stock source confirms POST `/api/chats/search`. It returns matching chat files; this is not an in-chat jump-to-message UI. Our Find a chat matches titles/cards, not bodies; the same phrase leaves no chat rows. **Worse for finding a remembered scene.** Raw phone captures `23-body-search`; not addressed by R4.

**Panel sizing:** stock ST starts with Moving UI disabled. Enabling its User Settings checkbox changes the character panel's computed `resize` to `both`; the served drag code persists sizes. Master's left/right chat panels have fixed widths. **Worse customization once enabled in ST; addressed by r4e** with persistent resize grips. This is not a claim that untouched ST exposes a resize grip immediately.

**Reasoning and ancillary actions:** ST's response settings request/display reasoning and its message editor offers Add reasoning block; master does not retain streamed reasoning (implemented architecture and source). **Worse capability, addressed by r4c.** Neither mock supplied reasoning in this walkthrough, so live reasoning quality/timing was not compared. Stock message actions also expose attachments, narration, translation and image generation; master has no corresponding controls. These peripheral services were not configured and are ranked below the daily RP friction.

## R4 coverage and validation

Read `git log master..r4X` and every resulting `git show --stat`, then inspected the relevant changes. These are source coverage judgments, **not a browser certification of an unmerged branch**:

| Branch tip read | What it addresses here | What remains |
|---|---|---|
| r4a `02206f6` | Persistent speaker, searchable speaker picker, explicit Reply from, round-robin, clearer generation | ST's Natural/Pooled/Auto Mode and broader density/layout issues |
| r4b `825e83e` | Versions on persona turns, star/hide/filter/compare, per-version model | Full-text searchable/sortable ordinary picker list still differs |
| r4c `ccf8a60` | Continue preserving original text, stored/live reasoning | Main reading/editor/settings ergonomics |
| r4d `552c530` | Chat/group names, branch rename/delete, every member greets | History page navigation and other panel workflows |
| r4e `3546270` | Portrait sizes/styles/full image, show/blur/hide, resizable panels | Message type/spacing/version-footers and editor navigation |

`npm ci` and `npm run build` passed. `npm run check` passed typecheck, lint, the then-current formatting check and knip, but **Vitest failed: 62 files failed, 87 passed, one skipped; 211 tests failed, 2,023 passed, 314 skipped**. The full log is `logs/check.log`. Many failures are timeouts, including accounts/RPC/reader-pool/startup and the long LCM model test; there are assertion failures too. Cause was not established. No app code changed to investigate or hide these failures. The new report's formatting, PNG dimensions/count and Git diff/file scope are checked separately before committing.

## Every observed way master is worse, ranked for the owner's group RP

This ranks the regressions found in the tasks above, not every optional ST extension or every unmet future requirement in ST-GRIPES. “Addressed” below means source exists on that branch; it does not mean merged into the measured master. Partial coverage is stated explicitly.

1. **Less story per screen: −29.4% desktop, −34.0% phone.** Add a compact density setting, reduce row gaps/header height and make single-version footers unobtrusive. **Not addressed by R4.**

2. **Group reply control is too weak.** Put reply choice/order at the composer and expose group strategies/automation. **Partly addressed by r4a** (choice and round-robin; ST's other strategies/Auto Mode remain). **Auto Mode addressed by orchestr1** (2026-11-14): bounded auto replies from the composer (ARCHITECTURE §12, Auto replies).

3. **Plain Generate writes the selected persona instead of asking the group to answer.** Separate clearly named persona generation from the ordinary reply action. **Addressed by r4a.**

4. **The selected speaker resets when a chat is reopened.** Persist it per branch with the draft. **Addressed by r4a.**

5. **Portraits are smaller and their shape cannot be chosen.** Offer ST-size circles and 60×90 rectangles consistently on desktop/phone. **Addressed by r4e.**

6. **A portrait click has no image viewer.** Open the full original beside the chat, with a phone sheet. **Addressed by r4e.**

7. **A tiny author's-note edit requires Save plus a second revision dialog.** Commit directly from the note editor with an optional revision description and recoverable history. **Not addressed by R4.**

8. **Preset samplers/prompts require leaving the chat and a longer save path.** Put their controls in the chat panel, retaining revision recovery; distinguish global edits from future per-chat overrides. **Not addressed by R4.**

9. **No Continue, despite its preset prefill switch existing.** Add Continue to a version and retain its original text. **Addressed by r4c.**

10. **The swipe picker is inadequate for reading/comparing many versions.** Provide full-text review/search/sort plus compact favorites. **Partly addressed by r4b** (star/hide/filter/compare/model; ordinary previews/search/sort remain).

11. **Editing a card abandons the conversation.** Keep the scoped editor beside the chat; preserve the scope decision. **Not addressed by R4.**

12. **The speaker/persona picker has no search.** Add search across its Members/Personas/All cards tabs. **Addressed by r4a.**

13. **Lorebook entry editing is unavailable.** Implement keys/content/activation editing in the chat panel or a working editor. **Not addressed by R4.**

14. **Chat/group/branch names cannot be edited and branches cannot be deleted.** Add names and branch deletion to the header/group/history surfaces. **Addressed by r4d.**

15. **Only one group member greets in a new chat.** Preview and store every member's selected greeting. **Addressed by r4d.**

16. **Switching branches opens near the fork instead of the latest message.** Offer a clear Resume at the tip action alongside Inspect the fork, and preserve the last read position. **Not addressed by R4.**

17. **Phone message actions are undiscoverable until a reveal tap.** Keep a visible menu/edit affordance on each message. **Not addressed by R4.**

18. **Connection changes take 3 desktop / 4 phone clicks and replace the chat view.** Expose the active connection through This chat, with an inline editor. **Not addressed by R4.**

19. **Clock time disappears from the inline message header.** Show a compact local time beside the day, with the full timestamp on demand. **Not addressed by R4.**

20. **Chat/sidebar widths cannot be adjusted.** Add remembered resize handles and reset controls. **Addressed by r4e.**

21. **Chat-list search cannot find message-body phrases.** Add body search returning chats and, ideally, links to the matching messages. **Not addressed by R4. Built 2026-11-12 (search):** the left panel's chat search can look through message text, with links to the messages (ARCHITECTURE §12 "Finding a message").

22. **No attachment/embed control on a message or composer.** Add a picker plus paste/drop, with capability feedback. **Not addressed by R4.**

23. **No move-up/down controls in message editing.** Offer explicit, recoverable repositioning if manual scene repair is supported. **Not addressed by R4.**

24. **No selection/range workflow for deleting several messages.** Add selection and a recoverable batch delete. **Not addressed by R4. Built 2026-11-14 (msgactions1):** Select messages on a message's menu, ticks with Select range or Shift, and a confirmed Delete of up to 1,000 in the branch shown, with one Undo (ARCHITECTURE §3.11 "Several messages at once"). Moving messages (item 23) is not built.

25. **An absent member's switch still says “is Present.”** State Present/Absent correctly and keep the control's action clear. **Not addressed by R4.**

26. **Streamed reasoning is discarded and has no display surface.** Store it per version and display it live/collapsed. **Addressed by r4c**; source-backed gap, not a reasoning-provider benchmark here.

27. **ST's narration/translation/image-generation action surfaces are absent.** Add the intended actions when their services are supported, without crowding daily editing. **Not addressed by R4**; availability of those ST surfaces was observed, their services were not tested.

## Ways master is better

- **Characters is a useful landing screen:** groups, readable labels, Never used, search/sort, and Inspect/New chat apart from Continue.
- **Current context is clearer:** cast/title/start date, direct chat/branch/message URLs, displayed persona and recent speakers; effective model/preset names and sources are stated.
- **Older replies can be swiped/regenerated in place** while keeping their continuation. Branches are integrated with the chat rather than presented only as separate files.
- **Edits and deletions have recovery:** generated edits preserve the original version, editor drafts/history and explicit revision boundaries, message deletion has Undo and a named bin item.
- **Card edit scope is explicit:** this chat versus everywhere, including usage count, avoids ST's global card edit affecting another story unintentionally.
- **Notes are multiple and individually switchable**, with explicit position/role and from-here-on branch scope; lore lists applicable books and explains why an embedded book is off.
- **New-chat previews are deliberate:** persona and first replier are visible, greeting alternatives are selectable, and abandoning the preview does not persist an empty chat.
- **Connection administration is stronger:** editable/refreshed model lists, explicit routing and secrets management, separate connections, rather than only changing the active ST profile.
- **Generated-run inspection and server-owned generation have a stronger foundation** for reproducibility and multiple tabs/chats; the UI exposes saved-run context. This was not a latency or real-provider benchmark.
