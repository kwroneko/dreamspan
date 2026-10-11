import { describe, expect, it } from "vitest"
import { ReportBuilder, shownList, shownText } from "../src/importReport.ts"

describe("bounded import reports", () => {
  it("keeps 200 issues, then counts the rest in one truncation issue", () => {
    const builder = new ReportBuilder()
    for (let i = 0; i < 1000; i++) builder.add("warning", "field.invalid", `Issue ${i}`, ["entries", i])
    const report = builder.build("test")
    expect(report.issues).toHaveLength(201)
    expect(report.issues[199]!.message).toBe("Issue 199")
    expect(report.issues[200]).toMatchObject({ code: "report.truncated", message: "800 more issues aren't listed." })
    const small = new ReportBuilder()
    small.add("info", "x", "only one")
    expect(small.build("test").issues).toHaveLength(1)
  })

  it("shortens file text, lists and paths", () => {
    expect(shownText("a".repeat(41))).toBe(`${"a".repeat(40)}…`)
    expect(shownText("short")).toBe("short")
    const items = Array.from({ length: 13 }, (_, i) => `k${i}`)
    expect(shownList(items)).toBe("k0, k1, k2, k3, k4, k5, k6, k7, k8, k9 and 3 more")
    const builder = new ReportBuilder()
    builder.add("warning", "x", "deep", [...Array.from({ length: 30 }, () => "b".repeat(100)), 5])
    const path = builder.build("test").issues[0]!.path!
    expect(path).toHaveLength(16)
    expect(path[0]).toBe(`${"b".repeat(40)}…`)
    expect(path[15]).toBe("…")
  })
})
