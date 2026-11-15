import { describe, expect, it } from "vitest"
import { decodeToolData, displayToolData } from "../src/toolData.ts"

describe("literal result display", () => {
  it("decodes a single layer as readable text and keeps nested entities literal", () => {
    const encoded =
      "<tool_data>\n{&quot;name&quot;:&quot;&lt;img src=x onerror=alert(1)&gt; &amp;lt;literal&amp;gt;&quot;}\n</tool_data>"
    expect(displayToolData(encoded)).toBe(
      '<tool_data>\n{"name":"<img src=x onerror=alert(1)> &lt;literal&gt;"}\n</tool_data>'
    )
    expect(displayToolData("legacy &quot;bytes&quot;")).toBe("legacy &quot;bytes&quot;")
  })
  it("recovers exact code units while displaying invisible and invalid units visibly", () => {
    expect(decodeToolData("&#x0;&#x202e;&#xd800;x&#xdc00;😀&amp;#x0;")).toBe("\0\u202e\ud800x\udc00😀&#x0;")
    expect(displayToolData("<tool_data>\n&#x0;&#x202e;&#xd800;x&#xdc00;😀\n</tool_data>")).toBe(
      "<tool_data>\n\\u0000\\u202e\\ud800x\\udc00😀\n</tool_data>"
    )
  })
})
