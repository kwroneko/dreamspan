// A summary's text follows its path; settings stay with the bound revision.
export const SUMMARY_HISTORY = 1_000

export const summaryOnPath = <D extends { readonly content?: unknown; readonly source_slot_id?: unknown }>(
  current: D,
  history: ReadonlyArray<{ readonly revision: string; readonly doc: D }>,
  onPath: ReadonlySet<string>
) => {
  const found = history.find(({ doc }) => doc.source_slot_id === undefined || onPath.has(doc.source_slot_id as string))
  return found ? { revision: found.revision, doc: { ...current, content: found.doc.content } } : null
}
