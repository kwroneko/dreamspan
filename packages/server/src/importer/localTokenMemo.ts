// Exact text and encoding keys never depend on database freshness or branch identity.
export const makeTokenMemo = (maxCharacters = 4_000_000, maxEntries = 20_000) => {
  const tokenMemo = new Map<string, number>()
  let memoCharacters = 0
  return (encoding: string, count: (text: string) => number) =>
    (text: string): number => {
      const key = `${encoding}\u0000${text}`
      const hit = tokenMemo.get(key)
      if (hit !== undefined) {
        tokenMemo.delete(key)
        tokenMemo.set(key, hit)
        return hit
      }
      const tokens = count(text)
      if (key.length <= maxCharacters) {
        while (memoCharacters + key.length > maxCharacters || tokenMemo.size >= maxEntries) {
          const oldest = tokenMemo.keys().next().value!
          tokenMemo.delete(oldest)
          memoCharacters -= oldest.length
        }
        tokenMemo.set(key, tokens)
        memoCharacters += key.length
      }
      return tokens
    }
}
