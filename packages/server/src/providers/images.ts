/** Image blocks in the final wire body, including Chat Completions payload overrides. */
export const hasImageBlocks = (node: unknown): boolean => {
  if (!node || typeof node !== "object") return false
  if (
    ("type" in node && ["image", "image_url", "input_image"].includes(String(node.type))) ||
    "inlineData" in node ||
    "inline_data" in node
  )
    return true
  return Object.values(node).some(hasImageBlocks)
}

/** Cap actual image blocks after all payload overrides, newest first, on every request. */
export const limitImages = <A>(value: A, maximum: number): A => {
  let left = Math.max(0, Math.floor(maximum))
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node))
      return node
        .slice()
        .reverse()
        .flatMap((item) => {
          if (
            item &&
            typeof item === "object" &&
            (("type" in item && ["image", "image_url", "input_image"].includes(String(item.type))) ||
              "inlineData" in item ||
              "inline_data" in item)
          ) {
            if (left-- <= 0) return []
          }
          return [visit(item)]
        })
        .reverse()
    if (
      node &&
      typeof node === "object" &&
      (Object.getPrototypeOf(node) === Object.prototype || Object.getPrototypeOf(node) === null)
    )
      return {
        ...node,
        ...Object.fromEntries(
          Object.entries(node)
            .reverse()
            .map(([key, v]) => [key, visit(v)])
            .reverse()
        )
      }
    return node
  }
  return visit(value) as A
}
