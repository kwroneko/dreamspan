// 0011_guidance_target (guidancedurable1, owner 2026-11-21): the reply a composer's text is aimed
// at while a new version's guidance is written in it (DESIGN §2.2, guidance on swipes). The text
// is the composer draft's own; this names the slot, so a reload, another tab or another device
// reopens the same mode. Kept with the other composer choices on the draft; null: new turns.
// No foreign key, as for every draft target: a slot gone closes the mode in the client.
export const guidanceTargetMigration: ReadonlyArray<string> = [`ALTER TABLE drafts ADD COLUMN guidance_slot_id TEXT`]
