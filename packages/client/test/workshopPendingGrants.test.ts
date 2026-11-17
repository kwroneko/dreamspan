// Grants chosen in a workshop's composer before its first message (owner, 2026-11-17): the chip
// shows the rows as they'll stand once made, and the choices go to `CreateWorkshop` as made.
import { describe, expect, it, vi } from "vitest"
import type { WorkshopCapability } from "@rp/shared/workshopApi.ts"

vi.hoisted(() => {
  vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1" })
})

const { choosePending, chipText, grantKey, withPendingGrants } =
  await import("../src/features/workshop/capabilities.ts")

const row = (
  id: string,
  mode: WorkshopCapability["mode"],
  extra: Partial<WorkshopCapability> = {}
): WorkshopCapability => ({
  id,
  order: 1,
  label: id,
  explanation: `Does ${id}.`,
  mode,
  defaultMode: mode,
  modes: ["off", "ask", "allow"],
  chosen: false,
  ...extra
})

describe("grants chosen before a workshop's first message", () => {
  const read = row("chats.read", "allow", { defaultMode: "ask", chosen: true })
  const edit = row("cards.edit", "ask")
  const server = row("mcp", "off", { target: "conn-1", modes: ["off", "allow"] })

  it("leaves the server's rows as they are with nothing chosen", () => {
    const rows = [read, edit, server]
    expect(withPendingGrants(rows, new Map())).toBe(rows)
  })

  it("shows a choice as the row's mode, and the default as not chosen", () => {
    let grants = choosePending(new Map(), edit, "off")
    grants = choosePending(grants, read, null)
    grants = choosePending(grants, server, "allow")
    const rows = withPendingGrants([read, edit, server], grants)
    expect(rows.map((c) => [c.id, c.mode, c.chosen])).toEqual([
      ["chats.read", "ask", false],
      ["cards.edit", "off", true],
      ["mcp", "allow", true]
    ])
    expect(chipText(rows)).toBe("Can: 1 · Asks: 1 · Off: 1")
    // As CreateWorkshop takes them: one per row, an MCP server's with its target.
    expect([...grants.values()]).toEqual([
      { capability: "cards.edit", mode: "off" },
      { capability: "chats.read", mode: null },
      { capability: "mcp", mode: "allow", target: "conn-1" }
    ])
  })

  it("keeps the last choice per row, and tells a server's row from the capability's own", () => {
    let grants = choosePending(new Map(), edit, "off")
    grants = choosePending(grants, edit, "allow")
    expect(grants.size).toBe(1)
    expect(grants.get(grantKey("cards.edit"))?.mode).toBe("allow")
    expect(grantKey("mcp")).not.toBe(grantKey("mcp", "conn-1"))
  })
})
