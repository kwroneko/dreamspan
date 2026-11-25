import { execFile } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { expect, it } from "vitest"
import { tempDir } from "./support/tempDir.ts"

const execute = promisify(execFile)

it("renders initials without any system fonts", async () => {
  const directory = tempDir("placeholder-font")
  const config = join(directory, "fonts.conf")
  await writeFile(config, "<fontconfig></fontconfig>")
  // Fontconfig caches process-wide state; a fresh child must load the empty configuration.
  const script = `
    import sharp from 'sharp'
    import { placeholderPortrait } from ${JSON.stringify(new URL("../src/importer/placeholder.ts", import.meta.url).href)}
    const bytes = await placeholderPortrait('Mira Vale')
    const { data, info } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const colors = new Set(['122,162,247', '125,211,160', '230,180,80', '242,119,122'])
    let letters = 0
    for (let i = 0; i < data.length; i += info.channels)
      if (colors.has(Array.from(data.subarray(i, i + 3)).join(','))) letters++
    console.log(JSON.stringify({ letters, width: info.width, height: info.height }))
  `
  const { stdout } = await execute(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: new URL("../../..", import.meta.url),
    env: { ...process.env, FONTCONFIG_FILE: config, FONTCONFIG_PATH: directory }
  })
  const result = JSON.parse(stdout) as { letters: number; width: number; height: number }
  expect([result.width, result.height]).toEqual([400, 600])
  expect(result.letters).toBeGreaterThan(2_000)
})
