# Card forks: every surface

**Status**: Proposal for discussion, 2026-10-16. Built on the owner's decisions in DESIGN §4 (three names; forking with parent and child; an easy way to find every variant; forks don't follow their parent). Everything below is **[P]** unless marked.

## The model in one paragraph

A fork is a card of its own from the moment it's made: a full copy of its parent's current revision, with its own names, its own revisions and its own chats. Its only tie to the parent is the recorded relationship. A card's **family** is every card connected by fork relationships. A **chat fork** is a fork made from inside a chat for that chat alone: it has no place in the library or the grid, and "Save as a library card" turns it into an ordinary fork.

## Surfaces

**1. Forking from the library.** The card panel and the editor have **Fork**. The dialog asks for the three names before anything is created:
- display name: prefilled with the parent's
- subtitle: empty, focused, labelled as what tells this fork from its parent
- in-character name: prefilled, editable, because a new premise sometimes renames the character

The new card opens in the editor. The parent and every chat using it are untouched.

**2. Changing a card from inside a chat.** The card's definition sits in the right-hand panel of the chat. Editing it there ends in an explicit Save that asks the scope:
- **This chat only**, from the message shown, on this branch (or on every branch of this chat). The first such save makes a chat fork and switches this chat to it from that position, as a state event with a marker in the stream. Later saves from the same chat edit that chat fork.
- **Everywhere**: edits the card itself, listing the chats it changes (used by N chats). Its forks and chat forks are not affected, and the dialog says so if it has any.

**3. Switching a chat to another fork.** In the chat's cast, each character has **Use another version**. It shows the family tree, the chat forks of this chat included. Picking one applies from the message shown on this branch, as a state event. This is how a story that moved on picks up a fork made for it.

**4. Finding every fork of a card.** The card panel has a **Forks** section: the whole family as a tree, from the card nobody forked down to every fork of a fork. Each entry shows display name, subtitle, when it was last used and how many chats use it, and opens in one click. The tree is the same from any member. Chat forks appear under their parent in a collapsed "Made in chats" group, each naming its chat.

**5. Telling forks apart elsewhere.** Every place that lists cards shows the display name with the subtitle: the grid, the speaker switcher's tabs, the cast, search results, pickers. Search matches display name, subtitle and in-character name. Forks are separate tiles in the grid; chat forks never are.

**6. Chats of a fork.** Opening a fork lists exactly the chats that use it (CHATS.md), so finding "the chat with that version" is opening that version.

**7. Comparing with the parent.** Any fork can **Compare with parent**, or with any other member of the family: a read-only field diff. Taking something over is ordinary editing.

**8. Saving a chat fork to the library.** **Save as a library card** on a chat fork opens the Fork dialog (surface 1). The chat goes on using the same card, now a library fork.

**9. Imported ST duplicates.** **Mark as a fork of…** on a card picks its parent from the library. Only the relationship is recorded; neither card's content changes. **Unlink** removes it. A card's ST `character_version` imports as its subtitle and exports from it.

**10. Re-importing a card file.** It updates that card only, merged into the user's edits on it with conflicts shown (DESIGN §4). Its forks are untouched; their Compare shows the difference.

**11. Deleting.** Deleting a card leaves its forks as they are; they show "forked from ⟨card⟩ (in the bin)". **[O]** What chats using a deleted card do.

**12. Exporting.** A fork exports as a standard card: in-character name as the card's name, subtitle as `character_version`. The display name has no ST field.

**13. Personas** are cards, so all of the above applies to them unchanged.

## Open

- What chats using a deleted card do (surface 11).
- Whether "on every branch of this chat" belongs in the scope choice of surface 2, given DESIGN §3.4's open question about identity.
