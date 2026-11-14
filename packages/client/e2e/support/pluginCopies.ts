import { test, expect, type Page, type TestInfo } from "@playwright/test"
import { readFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./server.ts"
import { asUser } from "./rpc.ts"
import { pluginFolder } from "../../../server/src/plugins/repo.ts"
import { expectLayout } from "./layoutAudit.ts"

export const pluginCopyTests = () => {
  const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "80", FAKE_GENERATOR_TOKENS: "20" })
  const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
  const shot = async (page: Page, info: TestInfo, name: string) => {
    await expect(page.getByText("Reading plugin status…", { exact: true })).toHaveCount(0, { timeout: 60000 })
    await expectLayout(page, info, name)
    if (process.env.SCREENSHOT_DIR) {
      await mkdir(process.env.SCREENSHOT_DIR, { recursive: true })
      await page.screenshot({
        path: join(process.env.SCREENSHOT_DIR, `${info.title.replace(/[^a-z0-9-]/gi, "-")}-${name}.png`),
        fullPage: true,
        animations: "disabled"
      })
    }
  }
  const reply = () =>
    admin((api) =>
      Effect.gen(function* () {
        const chat = yield* api.CreateChat({ title: "Sound in another chat" })
        yield* api.Generate({ chatId: chat.id, parentSlotId: null, branch: false })
      })
    )
  const frequencies = (page: Page) =>
    page.evaluate(() => (window as unknown as { frequencies: Array<number> }).frequencies)
  test.setTimeout(240000)
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const)
      test(`editable sound ${width} ${theme}`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 1000 })
        await page.emulateMedia({ colorScheme: theme })
        await page.addInitScript((theme) => {
          localStorage.setItem("rp.theme", theme)
          Object.assign(window, { frequencies: [] })
          const create = AudioContext.prototype.createOscillator
          AudioContext.prototype.createOscillator = function () {
            const tone = create.call(this),
              set = tone.frequency.setValueAtTime.bind(tone.frequency)
            tone.frequency.setValueAtTime = (value, time) => {
              ;(window as unknown as { frequencies: Array<number> }).frequencies.push(value)
              return set(value, time)
            }
            return tone
          }
        }, theme)
        await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
        await page.goto(`${server().url}/settings/plugins`)
        const sound = page.getByRole("listitem").filter({ has: page.getByText("Completion sound", { exact: true }) })
        await expect(sound).toBeVisible()
        await shot(page, info, "builtins")
        await sound.getByRole("button", { name: "Make an editable copy", exact: true }).click()
        await expect(page).toHaveURL(/settings\/plugins\/user~completion-sound-copy-/, { timeout: 90000 })
        const pluginId = new URL(page.url()).pathname.split("~")[1]!
        const target = { scope: "user" as const, id: pluginId }
        const user = await admin((api) => api.Whoami())
        const folder = pluginFolder(server().dataDir, user.id, pluginId)
        const helper = await readFile(join(folder, "src/part/completionSound.ts"), "utf8")
        const manifest = JSON.parse(await readFile(join(folder, "rp-plugin.json"), "utf8"))
        const base = JSON.parse(await readFile(join(folder, "builtin-base.json"), "utf8"))
        base.files[manifest.base.path] += "\n// Earlier shipped original\n"
        const sha = (s: string) => createHash("sha256").update(s).digest("hex")
        manifest.base.sha256 = sha(base.files[manifest.base.path])
        base.digest = sha(JSON.stringify(base.files))
        await admin((api) =>
          api.CommitPlugin({
            ...target,
            files: {
              "src/part/completionSound.ts": helper.replace("660, at", "880, at"),
              "rp-plugin.json": JSON.stringify(manifest),
              "builtin-base.json": JSON.stringify(base)
            },
            message: "Play a higher completion tone"
          })
        )
        await page.reload()
        await expect(page.getByText("The original changed in this update", { exact: true })).toBeVisible()
        await shot(page, info, "changed-original")
        await page.getByRole("button", { name: "Compare", exact: true }).click()
        await expect(page).toHaveURL(/compare=/)
        await page.reload()
        await expect(page.getByRole("dialog")).toContainText("Earlier shipped original")
        await shot(page, info, "comparison")
        await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).last().click()
        await page.getByRole("button", { name: "Turn on", exact: true }).first().click()
        await expect(page.getByRole("dialog")).toContainText("Changes optional reply sounds and alerts.")
        await expect(page.getByRole("dialog")).toContainText("Replaces existing parts")
        await shot(page, info, "consent")
        await page.getByRole("dialog").getByRole("button", { name: "Turn on", exact: true }).click()
        await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 90000 })
        await page.goto(`${server().url}/settings/plugins`)
        await expect(sound).toContainText("Replaced by")
        await shot(page, info, "replaced-badge")
        await page.goto(`${server().url}/settings/notifications`)
        const toggle = page.getByRole("switch", { name: /^Completion sound/ })
        if (!(await toggle.isChecked())) await toggle.click()
        else await page.getByRole("heading", { name: "Notifications", exact: true }).click()
        await reply()
        await expect.poll(() => frequencies(page)).toContain(880)
        await shot(page, info, "copied-sound")
        await page.goto(`${server().url}/settings/plugins/user~${pluginId}`)
        await page.getByRole("button", { name: "Turn off", exact: true }).click()
        await expect(page.getByText("Your account · Off", { exact: true })).toBeVisible()
        await page.goto(`${server().url}/settings/notifications`)
        await expect(page.getByRole("switch", { name: /^Completion sound/ })).toBeChecked()
        await page.getByRole("heading", { name: "Notifications", exact: true }).click()
        await reply()
        await expect.poll(() => frequencies(page)).toContain(660)
        expect(await frequencies(page)).not.toContain(880)
        // Shipped source never becomes a browser module, authenticated or otherwise.
        for (const path of [
          "/packages/client/src/features/completionSoundPart.tsx",
          "/src/features/completionSoundPart.tsx"
        ]) {
          const response = await page.request.get(server().url + path)
          expect(await response.text()).not.toContain("export const completionSound")
        }
      })

  test("a copied tool's added access is taken from the saved version in consent", async ({ page }, info) => {
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const made = await admin((api) =>
      api.CopyBuiltin({ registry: "rolloutTools", id: "set_presence", pluginId: "consent-presence-copy" })
    )
    const file = join(pluginFolder(server().dataDir, "", made.id), "rp-plugin.json")
    const manifest = JSON.parse(await readFile(file, "utf8"))
    manifest.surfaces.push("server:storage")
    await admin((api) =>
      api.CommitPlugin({
        ...made,
        files: { "rp-plugin.json": JSON.stringify(manifest) },
        message: "Keep private plugin data"
      })
    )
    // The working tree cannot hide the access declared by the saved version.
    const { writeFile } = await import("node:fs/promises")
    await writeFile(file, JSON.stringify({ ...manifest, surfaces: ["server:rolloutTools", "server:presence"] }))
    await page.goto(`${server().url}/settings/plugins/instance~${made.id}`)
    await page.getByRole("button", { name: "Turn on", exact: true }).first().click()
    await expect(page.getByRole("dialog")).toContainText("Stores its own data on the server.")
    await expect(page.getByRole("dialog")).toContainText("including stored keys and every user's chats")
    await shot(page, info, "copied-tool-access")
    await page.getByRole("dialog").getByRole("button", { name: "Turn on", exact: true }).click()
    await expect(page.getByRole("dialog")).toContainText("Plugin files are unavailable or invalid.", { timeout: 90000 })
    expect((await admin((api) => api.GetPlugin(made))).pin).toBeNull()
  })
}
