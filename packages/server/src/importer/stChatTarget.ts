// Which chat an ST chat file goes into (ARCHITECTURE.md §13 "Branches and checkpoints",
// "Re-running is idempotent"): its own record from an earlier import, else its parent file's
// chat when it's a branch of a file already in, else a chat of its own. One function for the
// import (`StImports.beginChat`) and its re-import preview (`StImportPlans`), so the preview
// maps each file where the import puts it.

/** What an earlier import recorded of a chat file, as both read it. */
export interface StChatRecordView {
  readonly recordId: string
  readonly chatId: string
  readonly complete: boolean
  readonly binned: boolean
  readonly merged: boolean
}

export type StChatTarget<R extends StChatRecordView> =
  /** Its chat is in the recycle bin: the import leaves it there. */
  | { readonly _tag: "bin"; readonly own: R }
  /** A branch whose parent file isn't in yet: sent again after the others. */
  | { readonly _tag: "deferred" }
  | {
      readonly _tag: "chat"
      readonly own: R | undefined
      readonly parent: R | undefined
      /** The parent's record, unless its chat is in the bin. */
      readonly parentLive: R | undefined
      /** The file went, or goes, into another file's chat. */
      readonly branch: boolean
      /** The chat a branch's first import goes into. */
      readonly into: R | undefined
      /** A branch whose parent never came, imported as a chat of its own. */
      readonly orphan: boolean
    }

export const stChatTarget = <R extends StChatRecordView>(
  records: ReadonlyMap<string, R>,
  path: string,
  parentPath: string | null,
  orphan: boolean
): StChatTarget<R> => {
  const own = records.get(path)
  if (own?.binned) return { _tag: "bin", own }
  const parent = parentPath === null ? undefined : records.get(parentPath)
  const parentLive = parent !== undefined && !parent.binned ? parent : undefined
  const orphaned = own === undefined && parentPath !== null && parentLive === undefined
  if (orphaned && !orphan) return { _tag: "deferred" }
  // A branch is a file that went into another file's chat; an orphan is a chat of its own.
  const branch = own !== undefined ? own.merged : parentLive !== undefined
  return {
    _tag: "chat",
    own,
    parent,
    parentLive,
    branch,
    into: own === undefined && branch ? parentLive : undefined,
    orphan: orphaned
  }
}
