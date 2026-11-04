import { readFile } from "node:fs/promises"
import { expect, test } from "@playwright/test"
import { asUser } from "./support/rpc.ts"
import { saveRevision } from "./support/saveRevision.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { expectTextBox } from "./support/textbox.ts"

const server = serverPerFile(withAdmin)
const before = "A quiet harbor.\nThe lamp burns.\n" + "Keep this unchanged line.\n".repeat(90) + "End of original."
const after = before.replace("burns", "flickers").replace("End of original.", "End of revision.")
const paths = ["clipboard", "cdp", "ime", "drop", "insertReplacementText", "insertFromPaste", "insertFromDrop"] as const

for (const width of [1440, 390])
  for (const path of paths)
    test(`preset input via ${path} ${width}`, async ({ page, context }, testInfo) => {
      await page.setViewportSize({ width, height: 960 })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const preset = JSON.parse(
        await readFile(new URL("../../server/test/fixtures/presets/default.json", import.meta.url), "utf8")
      )
      preset.prompts.find((prompt: { identifier: string }) => prompt.identifier === "main").content = before
      const name = `Input ${path} ${width}`
      const response = await page.request.post(`${server().url}/library/import?name=${encodeURIComponent(name)}.json`, {
        data: Buffer.from(JSON.stringify(preset)),
        headers: { origin: server().url, "content-type": "application/octet-stream" }
      })
      expect(response.status()).toBe(200)
      const id = (
        await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.ListLibrary({ kind: "preset" }))
      ).find((ref) => ref.label === name)!.id
      await page.goto(`${server().url}/library/${id}`)
      const box = page.getByRole("textbox", { name: "Prompt: Main Prompt", exact: true })
      await expectTextBox(box, before)
      await box.evaluate((element) => {
        const events: unknown[] = []
        Object.assign(window, { replacementEvents: events })
        for (const type of [
          "beforeinput",
          "input",
          "paste",
          "drop",
          "compositionstart",
          "compositionupdate",
          "compositionend"
        ])
          element.addEventListener(type, (event) => {
            const input = event as InputEvent
            events.push({
              type: event.type,
              inputType: input.inputType,
              data: input.data,
              trusted: event.isTrusted,
              prevented: event.defaultPrevented
            })
          })
      })
      await box.focus()
      await box.press("ControlOrMeta+a")
      if (path === "clipboard") {
        await context.grantPermissions(["clipboard-read", "clipboard-write"])
        await page.evaluate((text) => navigator.clipboard.writeText(text), after)
        await box.press("ControlOrMeta+v")
      } else if (path === "cdp" || path === "ime") {
        const cdp = await context.newCDPSession(page)
        if (path === "ime")
          await cdp.send("Input.imeSetComposition", { text: "仮の入力", selectionStart: 4, selectionEnd: 4 })
        await cdp.send("Input.insertText", { text: after })
        await cdp.detach()
      } else if (path === "drop") {
        await box.evaluate((element, text) => {
          const dataTransfer = new DataTransfer()
          dataTransfer.setData("text/plain", text)
          const bounds = element.getBoundingClientRect()
          element.dispatchEvent(
            new DragEvent("drop", {
              bubbles: true,
              cancelable: true,
              composed: true,
              dataTransfer,
              clientX: bounds.left + 10,
              clientY: bounds.top + 10
            })
          )
        }, after)
      } else {
        await box.evaluate(
          (element, { text, inputType }) => {
            const selection = (element.getRootNode() as ShadowRoot & { getSelection: () => Selection }).getSelection()
            const range = selection.getRangeAt(0)
            const dataTransfer = new DataTransfer()
            dataTransfer.setData("text/plain", text)
            const options = {
              bubbles: true,
              composed: true,
              inputType,
              data: text,
              dataTransfer,
              targetRanges: [
                new StaticRange({
                  startContainer: range.startContainer,
                  startOffset: range.startOffset,
                  endContainer: range.endContainer,
                  endOffset: range.endOffset
                })
              ]
            }
            if (!element.dispatchEvent(new InputEvent("beforeinput", { ...options, cancelable: true }))) return
            // Dispatching synthetic events does not perform a browser edit.
            // Model the resulting multiline DOM, without leftover empty lines.
            const lines = text.split("\n").map((text) => {
              const line = document.createElement("div")
              line.className = "cm-line"
              line.textContent = text
              return line
            })
            element.replaceChildren(...lines)
            range.selectNodeContents(lines.at(-1)!)
            range.collapse(false)
            selection.removeAllRanges()
            selection.addRange(range)
            element.dispatchEvent(new InputEvent("input", options))
          },
          { text: after, inputType: path }
        )
      }
      const expected = path === "drop" ? after + before : after
      // External drop inserts at the drop point; it does not replace a selection.
      await testInfo.attach("replacement-events", {
        body: JSON.stringify(
          await page.evaluate(() => (window as unknown as { replacementEvents: unknown[] }).replacementEvents),
          null,
          2
        ),
        contentType: "application/json"
      })
      await expectTextBox(box, expected)
      await saveRevision(page)
      await page.reload()
      await expectTextBox(box, expected)
    })
