# Card forks: every surface

**Status**: Proposal for discussion, 2026-10-16. Built on the owner's decisions in DESIGN §4 (three names; forking with parent and child; an easy way to find every variant; forks don't follow their parent). Everything below is **[P]** unless marked.

## The model in one paragraph

A fork is a card of its own from the moment it's made: a full copy of its parent's current revision, with its own names, its own revisions and its own chats. Its only tie to the parent is the recorded relationship. A card's **family** is every card connected by fork relationships. Forks exist only in the library. A chat's own changes to a card are not a fork: see "A chat's changes to a card" below (revised 2026-10-16 after the owner's questions; the earlier "chat fork" is withdrawn).

## Surfaces

**1. Forking from the library.** The card panel and the editor have **Fork**. The dialog asks for the three names before anything is created:
- display name: prefilled with the parent's
- subtitle: empty, focused, labelled as what tells this fork from its parent
- in-character name: prefilled, editable, because a new premise sometimes renames the character

The new card opens in the editor. The parent and every chat using it are untouched.

**2. Editing a card in a chat.** This is the main way cards get edited, as in ST. See "A chat's changes to a card" below.

**3. Switching a chat to another fork.** In the chat's cast, each character has **Use another version**. It shows the family tree. Picking one applies from the message shown on this branch, as a state event. This is how a story that moved on picks up a fork made for it.

**4. Finding every fork of a card.** The card panel has a **Forks** section: the whole family as a tree, from the card nobody forked down to every fork of a fork. Each entry shows display name, subtitle, when it was last used and how many chats use it, and opens in one click. The tree is the same from any member.

**5. Telling forks apart elsewhere.** Every place that lists cards shows the display name with the subtitle: the grid, the speaker switcher's tabs, the cast, search results, pickers. Search matches display name, subtitle and in-character name. Forks are separate tiles in the grid.

**6. Chats of a fork.** Opening a fork lists exactly the chats that use it (CHATS.md), so finding "the chat with that version" is opening that version.

**7. Comparing with the parent.** Any fork can **Compare with parent**, or with any other member of the family: a read-only field diff. Taking something over is ordinary editing.

**8. Making a fork from a chat's changes.** **Fork with this chat's changes** opens the Fork dialog (surface 1) with the card as this chat has it at the message shown. The chat can then switch to it (surface 3).

**9. Imported ST duplicates.** **Mark as a fork of…** on a card picks its parent from the library. Only the relationship is recorded; neither card's content changes. **Unlink** removes it. A card's ST `character_version` imports as its subtitle and exports from it.

**10. Re-importing a card file.** It updates that card only, merged into the user's edits on it with conflicts shown (DESIGN §4). Its forks are untouched; their Compare shows the difference.

**11. Deleting.** Deleting a card leaves its forks as they are; they show "forked from ⟨card⟩ (in the bin)". **[O]** What chats using a deleted card do.

**12. Exporting.** A fork exports as a standard card: in-character name as the card's name, subtitle as `character_version`. The display name has no ST field.

**13. Personas** are cards, so all of the above applies to them unchanged.

## A chat's changes to a card

- **Two things you can edit, chosen before typing, never at save time.** The card panel in a chat shows the card as this chat has it at the message shown, and says which you're editing: **the card** (used by N chats; the default, since users expect a card edit to change it everywhere) or **this chat's changes**. A text box always edits one definite thing, so what you see when you come back to it is never ambiguous.
- **No unsaved state.** Card fields apply as you type, as in ST, with the undo history kept on the server. There is no Save, so there are no unsaved changes to find or lose. For the card itself, each editing session becomes a revision (History). This departs from DESIGN §6.2's [P] "explicit commit" for cards and needs the owner's confirmation; message edits keep their explicit commit, because there it decides between a new version and an amendment.
- **This chat's changes live on the timeline**, like every other piece of chat state (DESIGN §3.4). The first change takes a **copy of the whole card** as it is at that moment, as an event at the end of the branch shown, with the change applied; later changes are further events on that copy. The card this chat sees at any message is what the path up to that message says. So:
  - a later change (at message 200) is a new event at 200; at message 150 the chat still has only the change made at 100
  - branching at the point of a change gives the card as it was then, without later changes
  - branching before the first change gives the card itself, as it is now
  - to change the card from an earlier point, branch there first; changes never apply backwards
- **From its first change on, a chat no longer follows the card.** A chat without changes of its own uses the card as it is now (editing a card changes it everywhere, as users expect). Once a chat has its own copy, edits to the card don't reach it at those positions, so nothing is ever merged into the chat's text and no conflict can arise (owner, 2026-10-16: patches over a card that keeps changing "quite literally causes conflicts with per-chat changes"; the earlier field patches over the moving card are withdrawn).
  - Editing the card says how many chats will change and how many have their own copy and won't.
  - A chat with its own copy says so in its card panel ("this chat's own copy since message N"), and when the card has changed since, offers **Compare with the card** and **Use the card as it is now, from here**, an explicit event that leaves the earlier copy on the earlier positions.
- **Each generation records the card exactly as it used it**, shown in its run inspector.
- DESIGN §4.1a [P] has the agent's card edits as "field patches … on top of whatever card revision is bound, so upstream fixes still arrive". That has the same conflict and would follow this rule: the agent's first change takes the chat's copy.

## Open

- What chats using a deleted card do (surface 11).
- Card fields applying as you type, without Save (above): needs the owner's confirmation.
