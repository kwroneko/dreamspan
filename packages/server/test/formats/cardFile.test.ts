// A card attached as a file (spec/WORKSHOP-CARDS.md §4.5): recognised by its bytes in every
// format, and edited in its own format with only the named fields changed. Unknown fields,
// extensions, a PNG's image and other chunks and a CHARX's other entries come back as they were.
// Synthetic cards only.
import { describe, expect, it } from "vitest"
import { editCardFile, readCardFile } from "../../src/formats/cardFile.ts"
import { readChunks } from "../../src/formats/png.ts"
import { defaultLimits } from "../../src/formats/safety.ts"
import { extract, readZip, writeZip } from "../../src/formats/zip.ts"
import { cardChunk, json, png, stCardV2, textChunk } from "./support.ts"

const v3 = () => ({
  spec: "chara_card_v3",
  spec_version: "3.0",
  data: {
    ...stCardV2().data,
    nickname: "",
    group_only_greetings: [],
    extensions: { depth_prompt: { prompt: "Keep the lamp lit.", depth: 4 }, tool_only: { kept: true } },
    future_field: { kept: "as is" }
  },
  root_extra: 7
})
const edit = [
  { field: "description", text: "A lighthouse keeper who mends nets." },
  { field: "first_message", find: "oil", replace: "a new wick" }
]
const ok = <A extends object>(result: A | { readonly error: string }) => {
  if ("error" in result) throw new Error(result.error)
  return result as A
}

describe("card files", () => {
  it("a PNG keeps its image and other chunks, and both copies of the card change", () => {
    const keep = textChunk("Comment", "made by hand")
    const before = png(cardChunk("chara", stCardV2()), keep, cardChunk("ccv3", v3()))
    const info = readCardFile(before)!
    expect(info).toMatchObject({ format: "png", spec: "chara_card_v3", specVersion: "3.0", name: "Wren" })
    const { bytes, after } = ok(editCardFile(before, edit))
    expect(after.doc.description).toBe("A lighthouse keeper who mends nets.")
    expect(after.doc.first_mes).toBe("The lamp needs a new wick.")
    const chunks = readChunks(bytes, defaultLimits)
    const original = readChunks(before, defaultLimits)
    expect(chunks.map((c) => c.type)).toEqual(original.map((c) => c.type))
    for (const [i, c] of chunks.entries())
      if (c.type !== "tEXt" || i === 3) expect(Buffer.from(c.raw)).toEqual(Buffer.from(original[i]!.raw))
    const decoded = (index: number) =>
      JSON.parse(
        Buffer.from(Buffer.from(chunks[index]!.data).toString("latin1").split("\0")[1]!, "base64").toString("utf8")
      )
    const v2 = decoded(2)
    expect(v2.data.description).toBe("A lighthouse keeper who mends nets.")
    expect(v2.chat).toBe(stCardV2().chat)
    const three = decoded(4)
    expect(three.data.extensions).toEqual(v3().data.extensions)
    expect(three.data.future_field).toEqual({ kept: "as is" })
    expect(three.root_extra).toBe(7)
  })

  it("a JSON card keeps its layout, unknown fields and extensions; V1 edits its top level", () => {
    const text = `${JSON.stringify(v3(), null, 4)}\n`
    const { bytes } = ok(editCardFile(Buffer.from(text), edit))
    const out = Buffer.from(bytes).toString("utf8")
    expect(out.endsWith("}\n")).toBe(true)
    expect(out).toContain('\n    "spec"')
    const root = JSON.parse(out)
    expect(root.data.extensions).toEqual(v3().data.extensions)
    expect(root.data.future_field).toEqual({ kept: "as is" })
    expect({ ...root, data: { ...root.data, description: "", first_mes: "" } }).toEqual({
      ...v3(),
      data: { ...v3().data, description: "", first_mes: "" }
    })

    const v1 = {
      name: "Gull",
      description: "Counts boats.",
      first_mes: "Hm.",
      personality: "",
      scenario: "",
      mes_example: ""
    }
    expect(readCardFile(json(v1))).toMatchObject({ format: "json", spec: "", name: "Gull" })
    const edited = JSON.parse(
      Buffer.from(ok(editCardFile(json(v1), [{ field: "name", text: "Gull Keeper" }])).bytes).toString()
    )
    expect(edited).toEqual({ ...v1, name: "Gull Keeper" })
  })

  it("edits the creator notes key used by a V1 card", () => {
    const original = { name: "Gull", creatorcomment: "Original notes", creator_notes: "Preserved fallback" }
    for (const change of [{ text: "Updated notes" }, { find: "Original", replace: "Updated" }]) {
      const { bytes, after } = ok(editCardFile(json(original), [{ field: "creator_notes", ...change }]))
      expect(after.doc.creator_notes).toBe("Updated notes")
      expect(JSON.parse(Buffer.from(bytes).toString("utf8"))).toEqual({ ...original, creatorcomment: "Updated notes" })
    }
  })

  it("a CHARX keeps its other entries", () => {
    const icon = png()
    const before = writeZip([
      { name: "card.json", data: json(v3()), deflate: true },
      { name: "assets/icon/images/main.png", data: icon, deflate: false }
    ])
    expect(readCardFile(before)).toMatchObject({ format: "charx", name: "Wren" })
    const { bytes, after } = ok(editCardFile(before, edit))
    expect(after.doc.description).toBe("A lighthouse keeper who mends nets.")
    const entries = readZip(bytes, defaultLimits)
    expect([...entries.keys()]).toEqual(["card.json", "assets/icon/images/main.png"])
    expect(
      Buffer.from(extract(bytes, entries.get("assets/icon/images/main.png")!, defaultLimits, { used: 0 }))
    ).toEqual(Buffer.from(icon))
  })

  it("limits the total uncompressed bytes read when editing a CHARX", () => {
    const before = writeZip([
      { name: "card.json", data: json({ spec: "chara_card_v3", data: { name: "Wren" } }), deflate: true },
      { name: "first.txt", data: Buffer.alloc(650), deflate: true },
      { name: "second.txt", data: Buffer.alloc(650), deflate: true }
    ])
    const limits = { ...defaultLimits, maxZipTotalBytes: 1024 }
    expect(readCardFile(before, limits)).toMatchObject({ format: "charx" })
    expect(editCardFile(before, [edit[0]!], limits)).toEqual({
      error: "The archive holds more than 1 KB uncompressed."
    })
  })

  it("other files aren't cards, and a bad edit changes nothing", () => {
    expect(readCardFile(png())).toBeNull()
    expect(readCardFile(json({ hello: "world" }))).toBeNull()
    expect(readCardFile(Buffer.from("plain text"))).toBeNull()
    expect(editCardFile(png(), edit)).toEqual({ error: "The file isn't a character card." })
    const card = png(cardChunk("ccv3", v3()))
    expect(editCardFile(card, [{ field: "description", find: "missing", replace: "x" }])).toEqual({
      error: "Find must occur exactly once in description. Read the card file again."
    })
    expect(editCardFile(card, [{ field: "extensions", text: "x" }])).toEqual({
      error: "The text field extensions cannot be edited by this tool."
    })
  })
})
