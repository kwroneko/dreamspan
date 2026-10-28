// Migration 0056: a fork is a card of its own, and its tie to the card it came from is
// recorded on it, outside its content (spec/CARD-FORKS-DELTA.md §2). Cards only for now.
import { raise } from "./integrity.ts"

// The parent is another entity of the same owner and kind; the revision copied is the
// parent's; the chat it was made for is its owner's. The writer refuses longer cycles
// (triggers can't run the recursive query that needs).
const invalid = `NEW.forked_from_entity_id = NEW.id
  OR (NEW.forked_from_entity_id IS NOT NULL AND (
    (SELECT owner_user_id FROM entities WHERE id = NEW.forked_from_entity_id) IS NOT NEW.owner_user_id
    OR (SELECT kind FROM entities WHERE id = NEW.forked_from_entity_id) IS NOT NEW.kind))
  OR (NEW.forked_from_revision_id IS NOT NULL
    AND (SELECT entity_id FROM entity_revisions WHERE id = NEW.forked_from_revision_id) IS NOT NEW.forked_from_entity_id)
  OR (NEW.forked_in_chat_id IS NOT NULL
    AND (SELECT owner_user_id FROM chats WHERE id = NEW.forked_in_chat_id) IS NOT NEW.owner_user_id)`

const message = raise(
  "a fork's parent is another entity of its owner and kind, its revision the parent's, its chat its owner's"
)

export const cardForks = [
  `ALTER TABLE entities ADD COLUMN forked_from_entity_id TEXT REFERENCES entities(id)`,
  // Deleting the parent for good deletes its revisions; the fork keeps its parent.
  `ALTER TABLE entities ADD COLUMN forked_from_revision_id TEXT REFERENCES entity_revisions(id) ON DELETE SET NULL`,
  `ALTER TABLE entities ADD COLUMN forked_in_chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL`,
  `ALTER TABLE entities ADD COLUMN forked_at INTEGER`,
  `CREATE INDEX entities_forked_from ON entities(forked_from_entity_id) WHERE forked_from_entity_id IS NOT NULL`,
  `CREATE INDEX entities_forked_from_revision ON entities(forked_from_revision_id) WHERE forked_from_revision_id IS NOT NULL`,
  `CREATE INDEX entities_forked_in_chat ON entities(forked_in_chat_id) WHERE forked_in_chat_id IS NOT NULL`,
  `CREATE TRIGGER entities_fork_parent BEFORE INSERT ON entities WHEN ${invalid} BEGIN ${message}; END`,
  `CREATE TRIGGER entities_fork_parent_update
    BEFORE UPDATE OF forked_from_entity_id, forked_from_revision_id, forked_in_chat_id, kind ON entities
    WHEN ${invalid} BEGIN ${message}; END`
]
