import type { EntityId } from "@rp/shared/chat.ts"
import type { CardDoc } from "@rp/shared/docs/card.ts"
import type { NoteDoc } from "@rp/shared/docs/note.ts"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { exportFile } from "../../src/importer/exporters.ts"
import * as Importers from "../../src/importer/importers.ts"
import { cardToJson, exportCardCharx, exportCardPng } from "../../src/formats/cardExport.ts"
import { importCard } from "../../src/formats/cardImport.ts"
import { decodeText, readChunks } from "../../src/formats/png.ts"
import { defaultLimits } from "../../src/formats/safety.ts"
import { cardChunk, cardV3, failure, json, png, run, stCardV2, textChunk, zip } from "./support.ts"

const imported = (value: unknown) => run(importCard(json(value))).card

const OWNER = "0190a000-0000-7000-8000-000000000000" as EntityId

const cardNote = (fields: Partial<NoteDoc>): NoteDoc => ({
  schema_version: 1,
  title: "",
  content: "",
  placement: { mode: "section", section: "tail_end", role: "system" },
  owner: { card: OWNER },
  exportable: true,
  ...fields
})

const characterNote = (content: string) =>
  cardNote({
    title: "Character's Note",
    content,
    placement: { mode: "depth", depth: 4, role: "system" },
    on_by_default: true
  })

/** A card exported with its notes, as the export route sends them to the format worker. */
const exportNotes = (card: CardDoc, note: NoteDoc | null, notes: ReadonlyArray<NoteDoc>) =>
  Effect.runPromise(
    exportFile({
      format: "card-v2-json",
      docJson: JSON.stringify(card),
      noteDocJson: note && JSON.stringify(note),
      notesDocJson: notes.map((n) => JSON.stringify(n)),
      avatar: null,
      assets: []
    })
  )

/** A file through the card importer: the card, its Character's Note and its other notes. */
const parsed = async (bytes: Uint8Array) => {
  const file = await Effect.runPromise(Importers.parseFile(bytes, "card.json").pipe(Effect.provide(Importers.layer)))
  const library = file.library!
  return {
    card: JSON.parse(library.docJson) as CardDoc,
    note: library.noteDocJson === null ? null : (JSON.parse(library.noteDocJson) as Record<string, unknown>),
    notes: (library.notesDocJson ?? []).map((n) => JSON.parse(n) as Record<string, unknown>),
    report: JSON.stringify(file.report.issues)
  }
}

/** Every key and value of `expected` is in `actual`; `actual` may have more keys. */
const expectSuperset = (actual: unknown, expected: unknown, path = "") => {
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), path).toBe(true)
    expect((actual as Array<unknown>).length, path).toBe(expected.length)
    expected.forEach((item, index) => expectSuperset((actual as Array<unknown>)[index], item, `${path}[${index}]`))
  } else if (typeof expected === "object" && expected !== null) {
    for (const [key, value] of Object.entries(expected)) {
      expectSuperset((actual as Record<string, unknown>)[key], value, `${path}.${key}`)
    }
  } else {
    expect(actual, path).toEqual(expected)
  }
}

describe("card export", () => {
  it("keeps everything an imported card had, in both versions", () => {
    for (const source of [stCardV2(), cardV3()]) {
      const card = imported(source)
      for (const version of ["v2", "v3"] as const) {
        const exported = cardToJson(card, version)
        expectSuperset(exported.data, source.data)
        expect(imported(exported)).toEqual(card)
      }
    }
    expectSuperset(cardToJson(imported(stCardV2()), "v2"), { some_root_field: 42 })
  })

  it("writes V1 fields at the top level of V2 only", () => {
    const card = imported(stCardV2())
    expect(cardToJson(card, "v2")).toMatchObject({ spec: "chara_card_v2", spec_version: "2.0", name: "Wren" })
    expect(cardToJson(card, "v3")).not.toHaveProperty("name")
    expect(cardToJson(card, "v3")).toMatchObject({ spec: "chara_card_v3", spec_version: "3.0" })
  })

  it("writes ST's World Info fields into each entry's extensions", () => {
    const data = cardToJson(imported(stCardV2()), "v3").data as { character_book?: { entries: Array<unknown> } }
    const entry = data.character_book!.entries[1]
    expect(entry).toMatchObject({
      id: 8,
      position: "after_char",
      use_regex: false,
      extensions: { position: 1, depth: 4, role: 0, selectiveLogic: 0, probability: 100, useProbability: true }
    })
  })

  it("exports exportable notes only, and an import brings them back as card notes", async () => {
    const card = imported(stCardV2())
    const { extensions: _dropped, ...rest } = card
    const plain = { ...rest, extensions: {} }
    const placed = { mode: "section", section: "tail_end", role: "system" } as const
    const exported = await exportNotes(plain, characterNote("She hums when nervous."), [
      cardNote({ title: "Outfit", content: "Oilskin coat.", placement: placed, module_id: "outfit", scan_lore: true }),
      cardNote({ title: "Secret", content: "Private plans.", exportable: false }),
      // A linked note comes as its shared note's text, which the reader put in it.
      cardNote({ title: "Weather", content: "It is raining.", link: OWNER })
    ])
    const text = new TextDecoder().decode(exported)
    expect(text).not.toContain("Private plans.")
    expect(text).not.toContain(OWNER)
    const data = (JSON.parse(text) as { data: CardDoc }).data
    expect(data.extensions["depth_prompt"]).toEqual({ prompt: "She hums when nervous.", depth: 4, role: "system" })
    expect(data.extensions["rp_harness"]).toEqual({
      notes: [
        { id: "outfit", title: "Outfit", content: "Oilskin coat.", placement: placed, scan_lore: true },
        { id: "note-2", title: "Weather", content: "It is raining.", placement: placed }
      ]
    })
    const back = await parsed(exported)
    expect(back.note).toMatchObject({ content: "She hums when nervous.", on_by_default: true })
    expect(back.notes).toEqual([
      {
        schema_version: 1,
        title: "Outfit",
        content: "Oilskin coat.",
        placement: placed,
        exportable: true,
        module_id: "outfit",
        scan_lore: true
      },
      {
        schema_version: 1,
        title: "Weather",
        content: "It is raining.",
        placement: placed,
        exportable: true,
        module_id: "note-2"
      }
    ])
    // Our namespace is emptied into the notes, so a re-export doesn't double them.
    expect(back.card.extensions).not.toHaveProperty("rp_harness")
  })

  it("gives a note without an id one no other note in the file has", async () => {
    const plain = { ...imported(stCardV2()), extensions: {} }
    const exported = await exportNotes(plain, null, [
      cardNote({ title: "First", content: "One." }),
      cardNote({ title: "Kept", content: "Two.", module_id: "note-1" }),
      cardNote({ title: "Third", content: "Three." })
    ])
    const data = (JSON.parse(new TextDecoder().decode(exported)) as { data: CardDoc }).data
    const ids = (data.extensions["rp_harness"] as { notes: Array<{ id: string }> }).notes.map((n) => n.id)
    expect(ids).toEqual(["note-2", "note-1", "note-3"])
    expect(new Set(ids).size).toBe(3)
  })

  it("keeps a depth note that isn't on in every chat out of depth_prompt, so an import doesn't switch it on everywhere", async () => {
    const { extensions: _dropped, ...rest } = imported(stCardV2())
    const off = cardNote({
      title: "Outfit",
      content: "Oilskin coat.",
      placement: { mode: "depth", depth: 2, role: "system" }
    })
    const exported = await exportNotes({ ...rest, extensions: {} }, off, [])
    const data = (JSON.parse(new TextDecoder().decode(exported)) as { data: CardDoc }).data
    expect(data.extensions).not.toHaveProperty("depth_prompt")
    const back = await parsed(exported)
    expect(back.note).toBeNull()
    expect(back.notes).toHaveLength(1)
    expect(back.notes[0]).toMatchObject({ title: "Outfit", placement: off.placement })
    expect(back.notes[0]).not.toHaveProperty("on_by_default")
  })

  it("reads an older export's modules as card notes, never the agent's permission to edit them", async () => {
    const placed = { mode: "depth", depth: 2, role: "system" } as const
    const old = stCardV2()
    const file = {
      ...old,
      data: {
        ...old.data,
        extensions: {
          rp_harness: {
            modules: [
              { id: "outfit", title: "Outfit", content: "Coat.", placement: placed, agent_editable: true },
              { id: "bad", title: "Bad", content: "Nowhere.", placement: { mode: "depth", depth: -1, role: "system" } },
              { title: "No id" }
            ]
          }
        }
      }
    }
    const back = await parsed(json(file))
    expect(back.notes).toEqual([
      {
        schema_version: 1,
        title: "Outfit",
        content: "Coat.",
        placement: placed,
        exportable: true,
        module_id: "outfit"
      },
      {
        schema_version: 1,
        title: "Bad",
        content: "Nowhere.",
        // An invalid placement goes with the definitions.
        placement: { mode: "section", section: "after_main_prompt", role: "system" },
        exportable: true,
        module_id: "bad"
      }
    ])
    expect(back.report).toContain("card.invalid_note")
  })

  it("never lets unknown fields override defined ones", () => {
    const card: CardDoc = {
      ...imported(cardV3()),
      unknown_fields: { name: "Impostor", extensions: { evil: true } },
      unknown_root_fields: { spec: "chara_card_v9", data: {} }
    }
    const exported = cardToJson(card, "v3")
    expect(exported.spec).toBe("chara_card_v3")
    expect(exported.data.name).toBe("Moss")
    expect(exported.data.extensions).toEqual({})
  })
})

describe("PNG export", () => {
  const keywords = (bytes: Uint8Array) =>
    readChunks(bytes, defaultLimits).map((c) => (c.type === "tEXt" ? decodeText(c.data).keyword : c.type))

  it("replaces card chunks, writing chara then ccv3 before IEND as ST does", () => {
    const image = png(textChunk("Comment", "kept"), cardChunk("chara", { name: "Old" }), cardChunk("CCV3", {}))
    const card = imported(cardV3())
    const out = run(exportCardPng(card, image))
    expect(keywords(out)).toEqual(["IHDR", "IDAT", "Comment", "chara", "ccv3", "IEND"])
    const reread = run(importCard(out))
    expect(reread.card).toEqual(card)
    expect(reread.report.format).toBe("card-v3-png")
  })

  it("refuses an image that isn't a valid PNG", () => {
    expect(failure(exportCardPng(imported(cardV3()), json({})))).toBe("png.invalid")
  })
})

describe("CHARX export", () => {
  it("writes the avatar as the main icon, and assets that have files", () => {
    const base = imported(cardV3())
    const card: CardDoc = {
      ...base,
      assets: [
        { type: "icon", uri: "ccdefault:", name: "main", ext: "png" },
        { type: "background", uri: "embeded://assets/background/images/sea.png", name: "sea", ext: "png" },
        { type: "emotion", uri: "embeded://assets/emotion/images/sad.png", name: "sad", ext: "png" },
        { type: "other", uri: "https://example.com/x.png", name: "remote", ext: "png" }
      ]
    }
    const sea = { uri: "embeded://assets/background/images/sea.png", ext: "png", bytes: png(textChunk("x", "sea")) }
    const avatar = { uri: "ccdefault:", ext: "png", bytes: png() }
    const result = run(importCard(exportCardCharx(card, { avatar, assets: [sea] })))
    expect(result.report.format).toBe("card-v3-charx")
    expect(Buffer.from(result.avatar!.bytes)).toEqual(png())
    expect(result.assets).toEqual([{ ...sea, bytes: Buffer.from(sea.bytes) }])
    expect(result.card.assets).toEqual([
      { type: "icon", uri: "embeded://assets/icon/images/main.png", name: "main", ext: "png" },
      card.assets![1],
      card.assets![3]
    ])
    expect({ ...result.card, assets: card.assets }).toEqual(card)
  })

  it("never writes an asset outside the archive's folder", () => {
    const uri = "embeded://../../evil.png"
    const card: CardDoc = { ...imported(cardV3()), assets: [{ type: "other", uri, name: "evil", ext: "png" }] }
    const result = run(importCard(exportCardCharx(card, { avatar: null, assets: [{ uri, ext: "png", bytes: png() }] })))
    expect(result.card.assets).toEqual([])
    expect(result.report.issues).toEqual([])
  })

  it("never writes two files under one name, so our import takes every export back", () => {
    const asset = (type: string, name: string, path: string) => ({ type, name, ext: "png", uri: `embeded://${path}` })
    const base = imported(cardV3())
    // The avatar keeps its own path, so an asset at the default avatar path doesn't collide.
    const charx = zip([
      {
        name: "card.json",
        data: json({
          ...cardV3(),
          data: {
            ...cardV3().data,
            assets: [asset("icon", "main", "a/1.png"), asset("emotion", "smile", "assets/icon/images/main.png")]
          }
        })
      },
      { name: "a/1.png", data: png(), method: 0 },
      { name: "assets/icon/images/main.png", data: png(textChunk("x", "smile")), method: 0 }
    ])
    const first = run(importCard(charx))
    const again = run(importCard(exportCardCharx(first.card, { avatar: first.avatar, assets: first.assets })))
    expect(again.avatar).toEqual(first.avatar)
    expect(again.assets).toEqual(first.assets)
    // An asset named like card.json, or at the path the avatar takes, is left out.
    const card: CardDoc = {
      ...base,
      assets: [asset("other", "x", "card.json"), asset("other", "y", "assets/icon/images/main.png")]
    }
    const files = [
      { uri: "embeded://card.json", ext: "png", bytes: png() },
      { uri: "embeded://assets/icon/images/main.png", ext: "png", bytes: png() }
    ]
    const avatar = { uri: "ccdefault:", ext: "png", bytes: png() }
    const result = run(importCard(exportCardCharx(card, { avatar, assets: files })))
    expect(result.card.name).toBe("Moss")
    expect(result.card.assets).toEqual([
      { type: "icon", uri: "embeded://assets/icon/images/main.png", name: "main", ext: "png" }
    ])
  })
})

describe("a card's regex scripts (ST's scoped scripts)", () => {
  const stScript = {
    id: "strip",
    scriptName: "Strip thinking",
    findRegex: "/<think>[\\s\\S]*?<\\/think>/g",
    replaceString: "",
    trimStrings: [],
    placement: [2],
    disabled: false,
    markdownOnly: false,
    promptOnly: false,
    runOnEdit: true,
    substituteRegex: 0,
    minDepth: null,
    maxDepth: null
  }
  const file = {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: { name: "Mira", extensions: { regex_scripts: [stScript], regex_approved: true, depth: 1 } }
  }

  it("imports them as data, never approved, and exports them back where ST keeps them", () => {
    const card = imported(file)
    expect(card.regex).toEqual([
      expect.objectContaining({ id: "strip", name: "Strip thinking", run_on_edit: true, placement: [2] })
    ])
    expect(card.regex_approved).toBeUndefined()
    expect(card.extensions).not.toHaveProperty("regex_scripts")
    const exported = cardToJson({ ...card, regex_approved: true }, "v2") as {
      data: { extensions: Record<string, unknown> }
    }
    expect(exported.data.extensions.regex_scripts).toEqual([stScript])
    expect(exported.data).not.toHaveProperty("regex_approved")
    expect(imported(exported).regex).toEqual(card.regex)
  })
})
