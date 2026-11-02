// The library at a heavy user's scale: the realistic synthetic ST folder, every picture in it
// repainted, plus 420 more cards with pictures, long names, personas and forks. Every name is
// made up.
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { crc32, deflateSync } from "node:zlib"
import { expect, type Page } from "@playwright/test"
import { Effect } from "effect"
import { writeRealisticStFolder } from "../../../server/test/support/stRealistic.ts"
import { cardChunk } from "../../../server/test/formats/support.ts"
import { asUser } from "./rpc.ts"
import { ADMIN, apiLogin, type TestServer } from "./server.ts"

const pngChunk = (type: string, data: Uint8Array) => {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data])
  const out = Buffer.alloc(body.length + 8)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc32(body), body.length + 4)
  return out
}
/** A 64×96 picture: a vertical gradient in a hue picked from `seed`, with `chunks` in it. */
const picture = (seed: number, ...chunks: ReadonlyArray<Uint8Array>) => {
  const [w, h] = [64, 96]
  const hue = (seed * 47) % 360
  const rgb = (l: number) => {
    const c = (1 - Math.abs(2 * l - 1)) * 0.6
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
    const [r, g, b] =
      hue < 60
        ? [c, x, 0]
        : hue < 120
          ? [x, c, 0]
          : hue < 180
            ? [0, c, x]
            : hue < 240
              ? [0, x, c]
              : hue < 300
                ? [x, 0, c]
                : [c, 0, x]
    const m = l - c / 2
    return [r + m, g + m, b + m].map((v) => Math.round(v * 255))
  }
  const rows = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    const [r, g, b] = rgb(0.25 + (0.5 * y) / h)
    for (let x = 0; x < w; x++) rows.set([r!, g!, b!], y * (w * 3 + 1) + 1 + x * 3)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(rows)),
    ...chunks,
    pngChunk("IEND", new Uint8Array())
  ])
}
/** A PNG's tEXt chunks (the card data), kept as they are. */
const textChunks = (file: Buffer) => {
  const chunks: Array<Uint8Array> = []
  for (let at = 8; at < file.length;) {
    const length = file.readUInt32BE(at)
    if (file.toString("latin1", at + 4, at + 8) === "tEXt") chunks.push(file.subarray(at, at + length + 12))
    at += length + 12
  }
  return chunks
}
const FIRST = ["Aurelia", "Bram", "Cassia", "Dorian", "Elowen", "Fenwick", "Galen", "Hesper", "Isolde", "Jareth"]
const LAST = ["Ashdown", "Blackwood", "Corrigan", "Dunmore", "Everly", "Fairweather", "Greaves", "Hollis"]
const LONG = "Lady Seraphina Evangeline Montgomery-Ashworth of the Northern Reaches and the Glass Coast"
/** The extra cards: names, versions and whether they have a picture. */
const EXTRA = Array.from({ length: 420 }, (_, i) => ({
  name:
    i === 7
      ? LONG
      : i === 8
        ? "Supercalifragilisticexpialidocious_Unbroken_Name_Without_Any_Spaces_At_All"
        : `${FIRST[i % FIRST.length]} ${LAST[Math.floor(i / FIRST.length) % LAST.length]}${i >= 80 ? ` ${Math.floor(i / 80) + 1}` : ""}`,
  version:
    i % 3 === 0 ? "" : i % 3 === 1 ? `v${(i % 7) + 1}.${i % 4}` : `Alternate universe, rewritten for slow burn ${i}`,
  picture: i % 5 !== 4
}))

export const seedLibrary = async (page: Page, server: TestServer) => {
  await apiLogin(page.request, server, ADMIN.handle, ADMIN.password)
  const folder = writeRealisticStFolder(join(server.dataDir, "synthetic-st"))
  // The folder's pictures are 1×1 grey; a real ST folder's are portraits.
  for (const [n, file] of ["characters", "User Avatars"]
    .flatMap((dir) => readdirSync(join(folder, dir)).map((name) => join(folder, dir, name)))
    .filter((file) => file.endsWith(".png"))
    .entries())
    writeFileSync(file, picture(1000 + n * 3, ...textChunks(readFileSync(file))))
  for (const [i, spec] of EXTRA.entries()) {
    const card = {
      name: spec.name,
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: {
        name: spec.name,
        description: `${spec.name} is made up for the library page.`,
        personality: "",
        scenario: "",
        first_mes: "Hello.",
        mes_example: "",
        creator_notes: "",
        system_prompt: "",
        post_history_instructions: "",
        tags: [],
        creator: "tests",
        character_version: spec.version,
        alternate_greetings: [],
        extensions: {}
      }
    }
    // ST gives every character a picture; the ones without are made here (New card).
    if (spec.picture) writeFileSync(join(folder, "characters", `extra-${i}.png`), picture(i, cardChunk("chara", card)))
  }
  await page.goto(`${server.url}/import/st`)
  await page.getByLabel("Folder path").fill(folder)
  await page.getByRole("button", { name: "Look in this folder" }).click()
  await page.getByRole("button", { name: "Import", exact: true }).click()
  await expect(page.getByRole("list", { name: "Imported" })).toBeVisible({ timeout: 280_000 })
  // Two generations of forks, and a fork of a long name.
  await asUser(server, ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      for (const spec of EXTRA.filter((s) => !s.picture))
        yield* api.CreateCard({ label: spec.name, name: spec.name, version: spec.version })
      const cards = yield* api.ListLibrary({ kind: "card" })
      const aria = cards.find((c) => c.label === "Aria Vance")!
      const fork = yield* api.ForkCard({
        refId: aria.id,
        name: "Aria Vance",
        nickname: "Aria",
        characterVersion: "Stormbound rewrite"
      })
      yield* api.ForkCard({
        refId: fork.id,
        name: "Aria Vance",
        nickname: "Aria",
        characterVersion: "Stormbound, epilogue"
      })
      const long = cards.find((c) => c.label === LONG)!
      yield* api.ForkCard({
        refId: long.id,
        name: LONG,
        nickname: "Seraphina",
        characterVersion: "Court intrigue"
      })
    })
  )
}
