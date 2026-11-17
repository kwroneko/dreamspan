import { expect, test } from "@playwright/test"
import { layoutAudit } from "./support/layoutAudit.ts"

test("a transparent growing toolbar reserves space between painted groups", async ({ page }) => {
  await page.setContent(`
    <main style="padding:16px">
      <div id="row" style="display:flex;gap:8px;align-items:center;width:600px;padding:8px">
        <span>First</span><span>Second</span>
        <div style="flex:1;opacity:0"><button>Hover action</button></div>
        <span>Last</span>
      </div>
    </main>`)
  const gaps = (await layoutAudit(page)).filter((v) => v.kind === "gap" && v.selector === "#row")
  expect(gaps).toEqual([])
})

test("an absent growing toolbar does not hide genuinely uneven gaps", async ({ page }) => {
  await page.setContent(`
    <main style="padding:16px">
      <div id="row" style="display:flex;gap:8px;align-items:center;width:600px;padding:8px">
        <span>First</span><span>Second</span>
        <div style="flex:1;opacity:0;display:none"><button>Absent action</button></div>
        <span style="margin-left:16px">Last</span>
      </div>
    </main>`)
  const gaps = (await layoutAudit(page)).filter((v) => v.kind === "gap" && v.selector === "#row")
  expect(gaps).toHaveLength(1)
  expect(gaps[0]!.measurement).toContain("spread 16.00px")
})

test("a control's short label cut by an ellipsis is reported; a long name cut is intended", async ({ page }) => {
  const cell = "display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
  await page.setContent(`
    <main style="padding:16px;display:flex;flex-direction:column;align-items:start;gap:16px">
      <button style="width:48px;padding:0 8px"><span id="short" style="${cell}">Auto replies</span></button>
      <button style="width:120px;padding:0 8px"><span id="long" style="${cell}">Captain Alexandra Rhee of the Northern Expedition</span></button>
      <button style="padding:0 8px"><span id="whole" style="${cell}">Auto…</span></button>
      <button style="width:48px;padding:0 8px"><span id="named" data-layout-name style="${cell}">Original</span></button>
      <button style="width:24px;padding:0"><span id="icon" style="${cell}"><svg width="40" height="12"></svg></span></button>
    </main>`)
  const cut = (await layoutAudit(page)).filter((v) => v.kind === "text" && v.measurement.startsWith("short label"))
  expect(cut.map((v) => v.selector)).toEqual(["#short"])
  expect(cut[0]!.measurement).toContain("“Auto replies”")
})
