import type { BrowserContext, Page } from "@playwright/test"

// ST 1.19.0 previews mutate the live author's-note buffer. Only the automatic call is
// disabled; reference sends still use ST's unchanged generation and assembly path.
export const withoutPromptPreviews = (source: string): string => {
  const call = "this.tryGenerate().finally(async () => {"
  if (source.split(call).length !== 2)
    throw new Error("ST prompt-manager preview call changed; update capture isolation.")
  return source.replace(call, "Promise.resolve().finally(async () => {")
}

interface OverlapProbe {
  armed: boolean
  waiting?: boolean
  rendered?: boolean
  manager?: { render: () => void }
}
declare const __stOverlap: OverlapProbe

export const withPreviewOverlap = (source: string): string => {
  const render = "render(afterTryGenerate = true) {"
  const completed = "this.profileEnd('filling context');"
  if (!source.includes(render) || !source.includes(completed)) throw new Error("ST preview probe call sites changed")
  return source
    .replace(
      render,
      `${render}
    globalThis.__stOverlap.manager = this;
    if (!globalThis.__stOverlap.armed || globalThis.__stOverlap.started) return;
    globalThis.__stOverlap.started = true;`
    )
    .replace(completed, `${completed} globalThis.__stOverlap.rendered = true;`)
}

/** Schedule the actual ST preview immediately before the real generation's lore write. */
export const installPreviewOverlap = async (context: BrowserContext) => {
  await context.addInitScript(() => {
    Object.assign(globalThis, { __stOverlap: { armed: false } })
  })
  await context.route("**/scripts/world-info.js", async (route) => {
    const response = await route.fetch()
    const source = await response.text()
    const append = "    if (shouldWIAddPrompt) {"
    if (source.split(append).length !== 2) throw new Error("ST lore overlap probe call site changed")
    const body = source.replace(
      append,
      `${append}
      if (globalThis.__stOverlap.armed && (ANTopEntries.length || ANBottomEntries.length)) {
        if (isDryRun) {
          globalThis.__stOverlap.waiting = true;
          await new Promise(resolve => globalThis.__stOverlap.release = resolve);
        } else if (globalThis.__stOverlap.release) {
          globalThis.__stOverlap.release();
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }`
    )
    await route.fulfill({ response, body })
  })
}

export const armPreviewOverlap = async (page: Page, protectedCapture: boolean) => {
  await page.waitForFunction(() => __stOverlap.manager !== undefined)
  await page.evaluate(() => {
    __stOverlap.armed = true
    __stOverlap.manager!.render()
  })
  await page.waitForFunction(
    (protectedCapture) => (protectedCapture ? __stOverlap.rendered : __stOverlap.waiting),
    protectedCapture
  )
}
