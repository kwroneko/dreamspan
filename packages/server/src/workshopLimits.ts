/** Resource bounds shared by the offered setup schemas and their worker operations. */
export const workshopLimits = {
  rewriteItems: 10000,
  textChars: 65_536,
  nameChars: 200,
  listItems: 32,
  castCards: 16,
  documentBytes: 262_144,
  cloneBytes: 1_048_576,
  calls: 32,
  effects: 128
} as const
