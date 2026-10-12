// Indexed traversal through individually deleted messages. A deleted subtree root is a
// barrier even when a separately binned descendant is restored, or the subtree is purged.
export const reachableSlot = (alias: string) => `(${alias}.deleted_at IS NULL OR (
  NOT ${alias}.branch_deleted AND EXISTS (
    WITH RECURSIVE deleted_chain(id, deleted_at, branch_deleted) AS (
      SELECT g.id, g.deleted_at, g.branch_deleted FROM slots g INDEXED BY slots_parent
        WHERE g.parent_slot_id = ${alias}.id
      UNION ALL
      SELECT g.id, g.deleted_at, g.branch_deleted FROM deleted_chain d
        JOIN slots g INDEXED BY slots_parent ON g.parent_slot_id = d.id
        WHERE d.deleted_at IS NOT NULL AND NOT d.branch_deleted
    )
    SELECT 1 FROM deleted_chain WHERE deleted_at IS NULL
  )
))`
