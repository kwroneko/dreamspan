# Tab history: back and forward in each tab

**Status**: Proposed, 2026-11-24 (job `tabhistory1`). **Built** (tabhistory1, 2026-11-24) for wide screens, §1 to §7 and §9: obsolete as an implementation proposal; ARCHITECTURE §5 "The workbench" ("Tab history", "Back and forward in the strip") records it. §8 (phones) stays open. Everything here is **[P]** unless it cites a **[D]** (DESIGN §10.1, "Every tab has its own back and forward", owner 2026-11-24). It is a delta from master `50493640a`: ARCHITECTURE §5 "The workbench: frames and tabs" (each tab its own router over a memory history, the browser's URL following the focused tab, the least frame size of minframe1 and minframe2). reference-harness has no tabs or frames, so there's nothing to take from it.

## 1. The problem

With several tabs and panes, the browser's navigation can't undo navigation per tab (owner, 2026-11-24). A search result clicked in a preview tab replaces the search; the only way back is the browser's Back, and once you navigate in another pane, Back reverts that pane first. The browser has one history for the browser tab, and the workbench copies the focused tab's navigations into it.

## 2. Decided (owner, 2026-11-24)

- **[D]** Every tab has its own back and forward history.
- **[D]** ← and → sit at the far left of each frame's tab strip, before the tabs: tab infrastructure, one layout to change. The arrows sit at strip level but act on the frame's selected tab ("it's probably fine").
- **[D]** The arrows follow the selected tab: switching tabs updates their enabled state and destination.
- **[D]** Hover names only the destination: "Back to cardex search: elf knight", "Forward to Mara". Never the tab ("Back in Mara" was rejected as confusing).
- **[D]** "We should not hijack browser behaviour to do unexpected things." The browser's Back and Forward, the mouse's back and forward buttons and Alt+Left/Right keep exactly their current behaviour. No keys are bound.

## 3. What a step is

A tab's history is a list of entries and the index of the one shown. Each entry is a URL, the view's history state at that URL (a chat's reading place), the scroll positions the tab had when it was left, and a label for hovers.

- **A step** is a push into the tab's own history: moving to a different place within the tab. The places that push today are the steps: another item in place (a preview tab following a link, a search result opened in a preview tab, the next card replacing a preview tab with View beside or Edit beside, an open that reuses the preview), and a different place within one item where the view pushes (Home's Show tabs, a chat's branch).
- **Not a step**: what views already write by replacing their entry (DESIGN §10.1: "Sort and filter changes replace the history entry; switching places pushes one"): typing in a search box, filter and sort changes, a chat's reading place. These update the current entry, so going back to it restores the search text, filters and sort exactly as they were left. Scrolling isn't navigation at all: the scroll positions are taken when the entry is left (§5).
- **A new tab** (opened beside, in a new frame, dropped, a split's copy, a link from a kept tab) starts its own history at its own entry. The entry before it that a tab opened from another gets today (`takeOpenedFrom`, so an Import page's own Back returns to where it was opened) stays, but the arrows never go to it: the history's **floor** is the tab's first own entry.
- **Moving a tab** to another frame keeps its history (it's the same tab, the same router). Closing it drops it; Reopen closed tab opens a new history.
- **New navigation clears forward**, as a browser does.
- **At most 50 entries** per tab; a step past that drops the oldest.
- A step to the URL the entry already has replaces it rather than adding a second, identical entry.

## 4. The arrows

- In every frame's strip on a wide screen, right after the hidden sidebar's Show button (which keeps the strip's corner, as the shell's), before the first tab: ← Back and → Forward, the strip's icon buttons, a little smaller than Maximize and ⋯ (28 px): with its padding and the divider after it the pair takes 67 px.
- Always present while the strip shows; disabled when there's nowhere to go, so nothing shifts and no gap opens. A disabled arrow keeps its look on hover and explains itself, as a disabled split button does: "Nothing to go back to" / "Nothing to go forward to". An enabled one names its destination: "Back to <label>" / "Forward to <label>".
- A label is what the tab was called while the entry was shown (`useTitle`), or the place a view names for its entry: Home names a search ("cardex search: elf knight", "Characters search: elf", the source alone while nothing is typed). An entry never shown in this page (restored from storage without a label) uses its kind's default title.
- They act on the frame's selected tab and focus the frame, as a click on its strip does.
- **One step back or forward:** the tab shows that entry's URL with its history state, and its scroll positions come back (§5). The browser's URL follows as for any of the focused tab's navigations, replacing its current entry: the arrows add nothing to the browser's history, so the browser's Back still walks back through what it walked through before.
- **An item another tab of the frame shows** (the frame has one tab per item): stepping to it reveals that tab, as following a link to it does; this tab's history doesn't move. The arrows then follow the revealed tab.
- **Registered part**: the arrows are the strip's `workbench.strip.start` slot's entry `workbench.tab-history`, so a plugin replaces or removes them as any other part (the owner's self-customizable rule).
- **One view alone** has no strip, so no arrows: its history is the browser tab's, and the browser's Back is its back, as before. Once a second tab opens or the view splits, the strip shows with them.

## 5. Scroll

When a tab leaves an entry (a step, or ← / →), the scroll positions inside the tab are taken with it: each scrolled element as its path from the tab's element (child indices, and its tag and classes to check it's the same element). Coming back to an entry whose view keeps no history state of its own puts them back once the page is long enough, trying each animation frame for up to 3 s while results load, and again while what loads above moves them (the browser's scroll anchoring) until the page's length holds still; any wheel, touch, key or pointer press in the tab stops it. A view that keeps its own place in its history state (a chat's reading place) restores itself, so its entries are left to it.

## 6. Where history lives

- Per browser tab, in `sessionStorage`: `dreamspan.tabHistory.<user>.<tab id>`, one key per tab, and `dreamspan.tabHistory.<user>.order`, the tabs in layout order with their items, written whenever the layout is saved. Not on the server, not per account or device (DESIGN §10.1: the URL is the truth; each browser tab's address decides what it shows).
- A reload makes tab ids afresh (layoutParam.ts), so the store matches the saved histories to the restored tabs in layout order by item; a matched tab's current entry takes the tab's URL from the layout (the URL stays the truth), and unmatched histories are dropped. A duplicated browser tab copies its session storage, so its tabs start with the same histories and then go their own ways.
- Every read and write is wrapped in try/catch; with storage unavailable, histories last as long as the page.
- Writes are gathered for 150 ms, and written at once on `pagehide`.

## 7. Width

The strip's fixed parts grow by the arrows' 67 px. The least frame width (`MIN_FRAME_WIDTH`, minframe1) goes from 320 to 344 px, measured in the browser: the hidden sidebar's Show (48), the arrows (67), the shown tab's 96 px and Maximize, ⋯ and the panel's toggle (116) come to 327 px, and the rest is room for the title. 344 rather than the ~360 first estimated: at 1440 px with the sidebar and the side panel open the frames have 704 px, and 360 would have refused splitting a chat there (two frames need twice the least width and a divider). The room checks, the splits refused and the overflow scroll follow the constant, and `e2e/workbenchMinFrame.spec.ts` checks the arrows whole inside the strip.

## 8. Phones

Below 1024 px there's one frame; the strip lists every open tab once two are open. The header's ← there isn't a generic back: it's "Chats and menu" (`shell.tsx` `CenterPage`, `chat/ChatHeader.tsx`), which opens the app menu. Settings' ← returns to the settings list. Neither is changed, and the phone's strip gets no arrows in this job; the coordinator decides after seeing the screenshots.

## 9. Tests

- `client/test/workbenchHistory.test.ts`: the model (push, replace, cap, floor, forward cleared, identical push, storage round trip and validation, matching saved histories after a reload).
- `e2e/tabHistory.spec.ts`: a cardex search with a filter, scrolled, then a result opened in the preview tab, then ← restores the search text, filter and scroll, → returns; navigating in pane B leaves pane A's arrows as they were, still working; the next card replacing a preview tab is a step; switching tabs updates the arrows; disabled states and hover texts; the browser's Back as before; a reload keeps the history.
- `e2e/workbenchMinFrame.spec.ts`: the arrows whole at the new least width, under the layout audit at 1340, 1920, 2560 and 3840.
