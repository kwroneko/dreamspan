// Measuring a toolbar must not render it again when the same pinned actions fit.
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { showActions } from "./support/message.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`toolbar measurements retain unchanged controls: ${width} ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 1000 })
      await page.emulateMedia({ colorScheme: theme })
      const { chat, slot } = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        Effect.gen(function* () {
          yield* api.SetDisplayPrefs({
            prefs: {
              messageToolbar: {
                "message.edit": true,
                "message.continue": false,
                "message.branch": false,
                "message.delete": false
              }
            }
          })
          const chat = yield* api.CreateChat({ title: "Toolbar measurement" })
          const posted = yield* api.SendMessage({
            chatId: chat.id,
            parentSlotId: null,
            branch: false,
            reply: false,
            content: "A synthetic message for toolbar measurements."
          })
          if (posted._tag !== "Posted") throw new Error("synthetic message was queued")
          return { chat, slot: posted.entry.slotId }
        })
      )
      await page.addInitScript((slot) => {
        interface Fiber {
          type: unknown
          flags: number
          memoizedProps?: { context?: { entry?: { slotId?: string } }; role?: string }
          alternate?: Fiber
          stateNode?: HTMLElement
          child?: Fiber
          sibling?: Fiber
        }
        const w = window as unknown as {
          __toolbarSeen: boolean
          __toolbarRenders: number
          __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown
        }
        const previous = new WeakMap<HTMLElement, Fiber>()
        w.__toolbarSeen = false
        w.__toolbarRenders = 0
        w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
          supportsFiber: true,
          inject: () => 1,
          onCommitFiberRoot: (_id: unknown, root: { current: Fiber }) => {
            const visit = (fiber: Fiber | undefined) => {
              if (!fiber) return
              const bar = fiber.child?.stateNode
              if (
                typeof fiber.type !== "string" &&
                fiber.memoizedProps?.context?.entry?.slotId === slot &&
                fiber.child?.memoizedProps?.role === "toolbar" &&
                bar instanceof HTMLElement
              ) {
                w.__toolbarSeen = true
                if (
                  bar.dataset.toolbarProbe &&
                  fiber.alternate &&
                  previous.get(bar) !== fiber &&
                  (fiber.flags & 1) !== 0
                )
                  w.__toolbarRenders++
                previous.set(bar, fiber)
              }
              visit(fiber.child)
              visit(fiber.sibling)
            }
            visit(root.current)
          },
          onCommitFiberUnmount: () => {}
        }
      }, slot)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/chats/${chat.id}`)
      const message = page.locator(`article[data-slot="${slot}"]`)
      await expect(message).toContainText("A synthetic message")
      await showActions(message)
      const bar = message.getByRole("toolbar", { name: "Message actions" }).locator("visible=true")
      const edit = bar.getByRole("button", { name: "Edit", exact: true })
      await expect(edit).toBeVisible()
      await expect
        .poll(() => page.evaluate(() => (window as unknown as { __toolbarSeen: boolean }).__toolbarSeen))
        .toBe(true)
      const resize = async (buttons: number) => {
        await bar.evaluate((element, buttons) => {
          const more = element.querySelector<HTMLElement>("[data-more]")!
          element.dataset.toolbarProbe = "true"
          element.style.flex = "none"
          element.style.maxWidth = "100%"
          element.style.width = `${buttons * more.getBoundingClientRect().width}px`
        }, buttons)
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
        await page.waitForTimeout(100)
      }
      const renders = () => page.evaluate(() => (window as unknown as { __toolbarRenders: number }).__toolbarRenders)
      await resize(3.5)
      await expect(edit).toBeVisible()
      const before = await renders()
      await resize(2.5)
      await expect(edit).toBeVisible()
      expect((await renders()) - before, "a capacity change with the same visible buttons does no React work").toBe(0)
      await resize(1.5)
      await expect(edit).toHaveCount(0)
      await bar.getByRole("button", { name: "More actions" }).click()
      await expect(page.getByRole("menu", { name: "More actions" }).getByText("Edit", { exact: true })).toBeVisible()
      await page.keyboard.press("Escape")
      await showActions(message)
      await resize(2.5)
      await expect(edit).toBeVisible()
      await expectLayout(page, info, `message toolbar fitting ${width} ${theme}`, {
        scope: `article[data-slot="${slot}"]`
      })
    })
