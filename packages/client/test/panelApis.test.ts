// Tier B (spec/HTML-MESSAGES.md §3.4): what a panel's scripts may read is a registered part,
// `frames.tavernHelper`, which reads the chat view's source for the panel's own message; a
// plugin can replace it to read less, or disable it, and then panels read nothing.
import type { SlotId } from "@dreamspan/shared/chat.ts"
import type { PanelData } from "@dreamspan/shared/panelDataApi.ts"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { effectivePanelApi, panelApis, type PanelDataSource } from "../src/ui/html/parts.ts"
import { registerHtmlParts } from "../src/ui/html/register.ts"

let disposers: Array<() => void> = []
beforeAll(() => {
  disposers = registerHtmlParts()
})
afterAll(() => disposers.forEach((dispose) => dispose()))

const data: PanelData = {
  messageId: 1,
  messages: [{ messageId: 1, name: "Mira", role: "assistant", hidden: false, message: "Tea." }],
  chatVariables: { hp: 12 },
  names: { user: "Sam", char: "Mira" }
}
const asked: Array<SlotId> = []
const source: PanelDataSource = {
  read: (slotId) => {
    asked.push(slotId)
    return Promise.resolve(data)
  },
  subscribe: () => () => {}
}

describe("frames.tavernHelper", () => {
  it("reads the panel's own message from the chat view's source", async () => {
    const api = effectivePanelApi()
    expect(api?.id).toBe("frames.tavernHelper")
    expect(await api!.read(source, "slot-1" as SlotId)).toEqual(data)
    expect(asked).toEqual(["slot-1"])
  })

  it("can be replaced to read less, or disabled to read nothing", async () => {
    const replaced = panelApis.register({
      id: "frames.tavernHelper",
      order: 0,
      read: async (from, slotId) => {
        const read = await from.read(slotId)
        return read && { ...read, chatVariables: {} }
      }
    })
    try {
      expect((await effectivePanelApi()!.read(source, "slot-2" as SlotId))?.chatVariables).toEqual({})
    } finally {
      replaced()
    }
    const off = panelApis.disable("frames.tavernHelper")
    try {
      expect(effectivePanelApi()).toBeUndefined()
    } finally {
      off()
    }
    expect(effectivePanelApi()?.id).toBe("frames.tavernHelper")
  })
})
