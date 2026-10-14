// A composer's speaker and reply choice (migration 0036, `ComposerChoice` in
// @rp/shared/composerApi.ts): columns of its draft row, so a draft moving to the next tip
// takes them along, and deleting it takes them away. A card purged for good clears them.
const raise = (message: string) => `SELECT RAISE(ABORT, '${message}')`

const column = (name: string) => [
  `ALTER TABLE drafts ADD COLUMN ${name} TEXT REFERENCES entities(id) ON DELETE SET NULL`,
  `CREATE INDEX drafts_${name} ON drafts(${name}) WHERE ${name} IS NOT NULL`,
  ...(["INSERT", `UPDATE OF ${name}`] as const).map(
    (event) => `CREATE TRIGGER drafts_${name}_owner${event === "INSERT" ? "" : "_update"} BEFORE ${event} ON drafts
      WHEN NEW.${name} IS NOT NULL
        AND (NEW.target_kind IS NOT 'composer'
          OR (SELECT owner_user_id FROM entities WHERE id = NEW.${name}) IS NOT NEW.user_id)
      BEGIN ${raise("a composer chooses among the cards of its owner")}; END`
  )
]

export const composerChoiceSchema = [...column("speaker_entity_id"), ...column("reply_from_entity_id")]
