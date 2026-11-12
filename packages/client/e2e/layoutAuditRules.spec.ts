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
