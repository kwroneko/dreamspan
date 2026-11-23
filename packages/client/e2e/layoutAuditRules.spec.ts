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

test("icon buttons in one row share one square and one gap; a text button or a chip is left out", async ({ page }) => {
  const icon = `<svg width="16" height="16"><path d="M0 0h16"/></svg>`
  const button = (id: string, width: number, style = "") =>
    `<button id="${id}" aria-label="${id}" style="width:${width}px;height:32px;padding:0;border:0;display:inline-flex;align-items:center;justify-content:center;${style}">${icon}</button>`
  await page.setContent(`
    <main style="padding:16px">
      <div style="display:flex;align-items:center;gap:4px;padding:8px">
        ${button("a", 32)}${button("b", 32)}<button style="height:32px">1/1</button>${button("c", 32)}
        <button aria-label="Speaker" style="height:32px;width:50px">${icon}${icon}</button>
      </div>
      <div style="display:flex;align-items:center;gap:4px;padding:8px">
        ${button("d", 24)}${button("e", 32)}${button("f", 36)}${button("g", 32)}${button("h", 32, "margin-left:-4px")}
      </div>
    </main>`)
  const found = (await layoutAudit(page)).filter((v) => v.kind === "iconrow")
  expect(found.map((v) => v.selector).sort()).toEqual(["#d", "#d", "#f"])
  expect(found.find((v) => v.measurement.startsWith("gaps"))!.measurement).toContain("spread 4.00px")
})
