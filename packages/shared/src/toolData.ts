/** Decode one literal-data layer, never HTML and never recursively. */
export const decodeToolData = (text: string): string =>
  text.replace(/&(amp|lt|gt|quot|apos|#x[0-9a-f]{1,4});/gi, (whole, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCharCode(Number.parseInt(entity.slice(2), 16))
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[entity] ?? whole
  })

/** Read-only display. Editors, persistence and model replay retain the encoded bytes.
 * React renders this as text. Invisible controls/lone surrogates get visible code units.
 */
export const displayToolData = (text: string): string =>
  text.replace(
    /(<tool_data>\n)([\s\S]*?)(\n<\/tool_data>)/g,
    (_, open: string, body: string, close: string) =>
      open +
      decodeToolData(body).replace(
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]|[\ud800-\udfff]/gu,
        (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
      ) +
      close
  )
