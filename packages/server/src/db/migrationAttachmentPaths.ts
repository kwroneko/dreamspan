// 0008_attachment_paths (files3; spec/FILES-AND-ENVIRONMENT.md §6.1): a workshop's attachment
// draft keeps where its file was saved in Files, as the message's attachment does
// (`version_attachments.path`, 0002_files), and an amended message's history keeps its
// attachments' kind, name and path with the set, so restoring an earlier text restores its files
// too. Additive: one nullable column, and the history trigger made again with the same events.
// A released migration never changes, so its SQL is written out here rather than built from
// helpers (`attachmentJson` in rows.ts held the same expression on the day it was written).

export const attachmentPathsMigration: ReadonlyArray<string> = [
  `ALTER TABLE composer_images ADD COLUMN path TEXT`,
  `DROP TRIGGER versions_amend_history`,
  `CREATE TRIGGER versions_amend_history AFTER UPDATE OF content ON version_texts
    WHEN NEW.content IS NOT OLD.content AND EXISTS (
      SELECT 1 FROM versions WHERE seq = OLD.version_seq AND writer = 'human' AND status <> 'generating')
    BEGIN
      INSERT INTO version_history(version_id, content, replaced_at, images_json, reasoning_json, sections_json)
      SELECT v.id, OLD.content, v.updated_at, (SELECT json_group_array(json(CASE WHEN a.path IS NULL AND a.kind <> 'file'
          THEN json_object('mediaId', a.media_id, 'altText', coalesce(a.alt_text, ''))
          ELSE json_patch(json_object('mediaId', a.media_id, 'altText', coalesce(a.alt_text, '')),
            json_object('kind', CASE WHEN a.kind = 'file' THEN 'file' END, 'name', a.name, 'path', a.path)) END)) FROM
        (SELECT media_id, alt_text, kind, name, path FROM version_attachments WHERE version_id = v.id ORDER BY ordinal) a),
        json_quote(OLD.reasoning), OLD.reply_sections
      FROM versions v WHERE v.seq = OLD.version_seq;
    END`
]
