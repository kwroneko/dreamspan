import { describe, expect, it } from "vitest"
import { runInNewContext } from "node:vm"
import { withoutPromptPreviews } from "./previewIsolation.ts"

// The automatic preview call site from ST 1.19.0 PromptManager.render. The generator
// below controls the reset/await/decorate interleaving reproduced in ST's world-info code.
const promptManager = `({
  tryGenerate() { return generate(true) },
  render() { this.tryGenerate().finally(async () => {}) }
})`
const overlap = async (source: string) => {
  let note = ""
  let previews = 0
  let sends = 0
  let release!: () => void
  const paused = new Promise<void>((resolve) => {
    release = resolve
  })
  const jobs: Array<Promise<string>> = []
  const generate = async (dry: boolean) => {
    if (dry) previews++
    else sends++
    note = "Full instruction"
    if (dry) await paused
    else {
      release()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    note = `Above\n${note}\nBelow`
    return note
  }
  const manager = runInNewContext(source, {
    generate: (dry: boolean) => {
      const job = generate(dry)
      jobs.push(job)
      return job
    }
  }) as { render: () => void }
  manager.render()
  const request = await generate(false)
  await Promise.all(jobs)
  return { request, previews, sends }
}

describe("ST reference preview isolation", () => {
  it("fails closed if the pinned preview call site changes", () => {
    expect(() => withoutPromptPreviews("different source")).toThrow(/preview call changed/)
    expect(() => withoutPromptPreviews(promptManager + promptManager)).toThrow(/preview call changed/)
  })
  it("reproduces duplicated lore when a preview overlaps the real send", async () => {
    expect(await overlap(promptManager)).toEqual({
      request: "Above\nAbove\nFull instruction\nBelow\nBelow",
      previews: 1,
      sends: 1
    })
  })
  it("prevents the same scheduled overlap without changing the real request", async () => {
    expect(await overlap(withoutPromptPreviews(promptManager))).toEqual({
      request: "Above\nFull instruction\nBelow",
      previews: 0,
      sends: 1
    })
  })
})
