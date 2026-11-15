/** Scripted providers inspect literal data as fixtures; this never interprets model instructions. */
export const unquoteToolData = (text: string): string => {
  const body = text.match(/<tool_data>\n([\s\S]*?)\n<\/tool_data>/)?.[1]
  return body === undefined
    ? text
    : body
        .replaceAll("&apos;", "'")
        .replaceAll("&quot;", '"')
        .replaceAll("&gt;", ">")
        .replaceAll("&lt;", "<")
        .replaceAll("&amp;", "&")
}
