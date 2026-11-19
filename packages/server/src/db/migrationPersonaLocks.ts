// 0006_persona_locks (personalock1, owner 2026-11-18; DESIGN §2.2): "an explicit lock
// per-character". One row per account and character card: the persona new single chats with
// that character start with. Keyed by the card entity, as favourites and the account default
// persona are: a card fork is its own entity and a different character in a cast
// (spec/LIBRARY-FORKS.md), so it has its own lock. Additive only: one new table.
export const personaLocksMigration: ReadonlyArray<string> = [
  `CREATE TABLE persona_locks (
    owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    character_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    persona_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    updated_at INTEGER NOT NULL,
    CHECK (character_entity_id <> persona_entity_id),
    PRIMARY KEY (owner_user_id, character_entity_id)
  ) STRICT, WITHOUT ROWID`,
  `CREATE INDEX persona_locks_character ON persona_locks(character_entity_id)`,
  `CREATE INDEX persona_locks_persona ON persona_locks(persona_entity_id)`,
  // Both cards are the owner's own.
  `CREATE TRIGGER persona_locks_owner BEFORE INSERT ON persona_locks BEGIN
    SELECT RAISE(ABORT, 'a persona lock names two cards of its owner') WHERE (
      SELECT count(*) FROM entities e WHERE e.id IN (NEW.character_entity_id, NEW.persona_entity_id)
        AND e.owner_user_id = NEW.owner_user_id AND e.kind = 'card'
    ) <> 2;
  END`,
  `CREATE TRIGGER persona_locks_identity BEFORE UPDATE ON persona_locks BEGIN
    SELECT RAISE(ABORT, 'a persona lock keeps its owner and character') WHERE NEW.owner_user_id <> OLD.owner_user_id
      OR NEW.character_entity_id <> OLD.character_entity_id;
    SELECT RAISE(ABORT, 'a persona lock names two cards of its owner') WHERE NOT EXISTS (
      SELECT 1 FROM entities e WHERE e.id = NEW.persona_entity_id AND e.owner_user_id = NEW.owner_user_id AND e.kind = 'card'
    );
  END`
]
