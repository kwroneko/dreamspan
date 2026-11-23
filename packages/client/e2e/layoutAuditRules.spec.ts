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

test("a text box's own buttons aren't in the row of the buttons beside the box", async ({ page }) => {
  const icon = `<svg width="16" height="16"><path d="M0 0h16"/></svg>`
  const button = (id: string, size: string, style = "") =>
    `<button id="${id}" aria-label="${id}" style="${size};padding:0;border:0;display:inline-flex;align-items:center;justify-content:center;${style}">${icon}</button>`
  await page.setContent(`
    <main style="padding:16px">
      <div style="display:flex;align-items:center;gap:4px;padding:8px">
        <span style="position:relative;display:flex;width:240px">
          <input aria-label="Search" style="width:100%;height:36px;padding-right:32px;box-sizing:border-box">
          ${button("clear", "width:32px;height:36px", "position:absolute;top:0;right:0")}
        </span>
        ${button("toggle", "width:36px;height:36px")}${button("next", "width:36px;height:36px")}
      </div>
      <div style="display:flex;align-items:center;gap:4px;padding:8px">
        <div data-field-frame style="display:flex;align-items:center;width:240px;height:36px">
          <input aria-label="Name" style="flex:1;min-width:0;height:34px">
          ${button("history", "width:24px;height:24px")}
        </div>
        ${button("copy", "width:36px;height:36px")}${button("remove", "width:36px;height:36px")}
      </div>
      <div style="display:flex;align-items:center;gap:4px;padding:8px">
        <input aria-label="Title" style="width:200px;height:36px">
        ${button("odd", "width:32px;height:32px")}${button("even1", "width:36px;height:36px")}${button("even2", "width:36px;height:36px")}
      </div>
    </main>`)
  const found = (await layoutAudit(page)).filter((v) => v.kind === "iconrow")
  expect(found.map((v) => v.selector)).toEqual(["#odd"])
})

test("text between icon buttons parts them; buttons with none between are still compared", async ({ page }) => {
  const icon = `<svg width="16" height="16"><path d="M0 0h16"/></svg>`
  const button = (id: string, size: number) =>
    `<button id="${id}" aria-label="${id}" style="width:${size}px;height:${size}px;padding:0;border:0;display:inline-flex;align-items:center;justify-content:center">${icon}</button>`
  await page.setContent(`
    <main style="padding:16px">
      <div style="display:flex;align-items:center;gap:8px;width:500px">
        ${button("tile", 40)}<span style="flex:1">Layout world</span><button style="height:32px">Edit</button>${button("more", 32)}
      </div>
      <div style="display:flex;align-items:center;gap:4px">
        <span>Name</span>${button("pencil1", 24)}<span>1.0</span>${button("pencil2", 24)}${button("save", 24)}${button("odd", 32)}
      </div>
    </main>`)
  const found = (await layoutAudit(page)).filter((v) => v.kind === "iconrow")
  expect(found.map((v) => v.selector)).toEqual(["#odd"])
})

test("a growing box's free room and a 12px group gap aren't gaps between icon buttons", async ({ page }) => {
  const icon = `<svg width="16" height="16"><path d="M0 0h16"/></svg>`
  const button = (id: string) =>
    `<button id="${id}" aria-label="${id}" style="width:32px;height:32px;padding:0;border:0;display:inline-flex;align-items:center;justify-content:center">${icon}</button>`
  await page.setContent(`
    <main style="padding:16px">
      <div style="display:flex;align-items:center;gap:4px;width:400px">
        <div style="flex:1;display:flex;align-items:center;min-width:0"><span style="width:290px">Name</span>${button("pencil")}</div>
        ${button("star")}${button("archive")}
      </div>
      <div style="display:flex;align-items:center;gap:12px">
        <div style="display:flex">${button("a")}${button("b")}${button("c")}</div>
        <div style="display:flex;gap:4px">${button("prev")}${button("next")}</div>
      </div>
    </main>`)
  expect((await layoutAudit(page)).filter((v) => v.kind === "iconrow")).toEqual([])
})
