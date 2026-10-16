# Card forks: every surface

**Status**: Proposal for discussion, 2026-10-16. Built on the owner's decisions in DESIGN §4 (three names; forking with parent and child; an easy way to find every variant; forks don't follow their parent). Everything below is **[P]** unless marked.

## The model in one paragraph

A fork is a card of its own from the moment it's made: a full copy of its parent's current revision, with its own names, its own revisions and its own chats. Its only tie to the parent is the recorded relationship. A card's **family** is every card connected by fork relationships. Forks exist only in the library. A chat customizes a card by forking it and swapping: see "A card in a chat" below.

## Surfaces

**1. Forking from the library.** The card panel and the editor have **Fork**. The dialog asks for the three names before anything is created:
- display name: prefilled with the parent's
- subtitle: empty, focused, labelled as what tells this fork from its parent
- in-character name: prefilled, editable, because a new premise sometimes renames the character

The new card opens in the editor. The parent and every chat using it are untouched.

**2. Editing a card in a chat.** This is the main way cards get edited, as in ST. See "A card in a chat" below.

**3. Switching a chat to another fork.** In the chat's cast, each character has **Use another version**. It shows the family tree. Picking one swaps the card this branch uses (see below). This is how a story that moved on picks up a fork made for it.

**4. Finding every fork of a card.** The card panel has a **Forks** section: the whole family as a tree, from the card nobody forked down to every fork of a fork. Each entry shows display name, subtitle, when it was last used and how many chats use it, and opens in one click. The tree is the same from any member.

**5. Telling forks apart elsewhere.** Every place that lists cards shows the display name with the subtitle: the grid, the speaker switcher's tabs, the cast, search results, pickers. Search matches display name, subtitle and in-character name. Forks are separate tiles in the grid.

**6. Chats of a fork.** Opening a fork lists exactly the chats that use it (CHATS.md), so finding "the chat with that version" is opening that version.

**7. Comparing with the parent.** Any fork can **Compare with parent**, or with any other member of the family: a read-only field diff. Taking something over is ordinary editing.

**8. Fork for this chat.** See "A card in a chat" below.

**9. Imported ST duplicates.** **Mark as a fork of…** on a card picks its parent from the library. Only the relationship is recorded; neither card's content changes. **Unlink** removes it. A card's ST `character_version` imports as its subtitle and exports from it.

**10. Re-importing a card file.** It updates that card only, merged into the user's edits on it with conflicts shown (DESIGN §4). Its forks are untouched; their Compare shows the difference.

**11. Deleting.** Deleting a card leaves its forks as they are; they show "forked from ⟨card⟩ (in the bin)". **[O]** What chats using a deleted card do.

**12. Exporting.** A fork exports as a standard card: in-character name as the card's name, subtitle as `character_version`. The display name has no ST field.

**13. Personas** are cards, so all of the above applies to them unchanged.

## A card in a chat

Revised 2026-10-16 from the owner's decisions (DESIGN §3.4, §4). The earlier "chat fork" and the timeline copy as the main mechanism are withdrawn.

- **Which card a chat uses belongs to the branch, not to a message.** A new fork of the chat, made from any point, starts with the cards its branch uses now; existing forks keep theirs.
- **Fork for this chat** is the typical way to customize a card for one chat: it forks the card (surface 1's dialog, subtitle prefilled with the chat's name) and swaps this branch to the fork. Going back a few messages, or redoing much of the story, keeps it.
- **Editing a card edits it wherever it's used**, every chat and branch bound to it included. A card made with Fork for this chat is used by this branch and the forks made from it since, so editing it changes all of them; a fork of the chat that should differ gets its own Fork for this chat.
- **What you're editing is chosen before typing.** The card panel in a chat names the card the branch uses, with "used by N chats", and offers Fork for this chat. A text box always edits one definite card.
- **Explicit Save, with the draft kept on the server** (DESIGN §6.2); applying fields as you type was withdrawn (owner: with continuous saving there's no real revision and no diff view). A draft of a card shows wherever that card is opened, marked unsaved, with Save and Discard, and never reaches the model; the panel says so while one exists.
- **Editor**: every card field is a code-editor-like box (DESIGN §6.2): new, modified and unchanged lines marked at the left edge; a diff of the current changes against the last revision; a diff browser for every earlier revision. Save shows that diff.
- **Changes that follow the messages** are a separate, specific mechanism: a change made at a point in the timeline, attached to the message (or the version that made it), reset by branching before it. It's mainly for the agent's card rewriting in a turn, which must work this way so swipes stay reversible, and it's available manually for character progression. It takes a copy of the whole card at its first change, so later edits to the card never merge into it.
- **Character progression** mostly goes through notes tied to the card and the chat (DESIGN §4.1), not edits of the card. Not designed yet.

## Open

- Whether forks made with Fork for this chat get their own tile in the grid like any fork, or show only in their family's Forks tree and in their chat.
- Which kinds of chat state follow the messages and which belong to the branch (DESIGN §3.4).

- What chats using a deleted card do (surface 11).
