// Workshops whose tests read the library along the way, not about asking for it (spec/
// WORKSHOP-CARDS.md §2.2): each library class allowed in the workshop, as its strip would set it.
export const OPEN_LIBRARY = ["library.cards", "library.lorebooks", "library.presets", "library.notes"].map(
  (capability) => ({ capability, mode: "allow" as const })
)
