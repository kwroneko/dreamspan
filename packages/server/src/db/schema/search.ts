// Full-text search (DATA-MODEL.md §12). External-content FTS5 indexes keyed on each
// table's integer `seq` (a rowid alias, so it survives VACUUM), kept in sync by
// triggers. Versions are indexed only once they stop generating, so streaming
// doesn't churn the index.

const fts = (table: string, column: string) =>
  `CREATE VIRTUAL TABLE ${table}_fts USING fts5(
    ${column}, content='${table}', content_rowid='seq',
    tokenize='unicode61 remove_diacritics 2', prefix='2 3'
  )`

export const search = [
  fts("versions", "content"),
  `CREATE TRIGGER versions_fts_insert AFTER INSERT ON versions WHEN NEW.status <> 'generating'
    BEGIN INSERT INTO versions_fts (rowid, content) VALUES (NEW.seq, NEW.content); END`,
  `CREATE TRIGGER versions_fts_update AFTER UPDATE OF content, status ON versions
    BEGIN
      INSERT INTO versions_fts (versions_fts, rowid, content)
        SELECT 'delete', OLD.seq, OLD.content WHERE OLD.status <> 'generating';
      INSERT INTO versions_fts (rowid, content)
        SELECT NEW.seq, NEW.content WHERE NEW.status <> 'generating';
    END`,
  `CREATE TRIGGER versions_fts_delete AFTER DELETE ON versions WHEN OLD.status <> 'generating'
    BEGIN INSERT INTO versions_fts (versions_fts, rowid, content) VALUES ('delete', OLD.seq, OLD.content); END`,

  fts("summary_revisions", "content"),
  `CREATE TRIGGER summary_revisions_fts_insert AFTER INSERT ON summary_revisions
    BEGIN INSERT INTO summary_revisions_fts (rowid, content) VALUES (NEW.seq, NEW.content); END`,
  `CREATE TRIGGER summary_revisions_fts_delete AFTER DELETE ON summary_revisions
    BEGIN INSERT INTO summary_revisions_fts (summary_revisions_fts, rowid, content) VALUES ('delete', OLD.seq, OLD.content); END`,

  fts("entity_revisions", "search_text"),
  `CREATE TRIGGER entity_revisions_fts_insert AFTER INSERT ON entity_revisions
    BEGIN INSERT INTO entity_revisions_fts (rowid, search_text) VALUES (NEW.seq, NEW.search_text); END`
]
