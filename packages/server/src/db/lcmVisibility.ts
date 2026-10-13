/** A staged unhide takes effect with its run's single publication. Explicit later visibility
 * edits clear the overlay, so users can hide those messages again. */
export const contextExcluded = (alias = "s") => `CASE WHEN ${alias}.context_excluded = 1 AND EXISTS (
  SELECT 1 FROM lcm_enable_slots es JOIN lcm_enable_runs er ON er.id = es.run_id
  WHERE es.slot_id = ${alias}.id AND es.shown = 1 AND er.published = 1
) THEN 0 ELSE ${alias}.context_excluded END`
