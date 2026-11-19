import { expect, test } from "vitest"
import { RequestPurpose, RequestStatus } from "@dreamspan/shared/usage.ts"
import { requestPurposeText, requestStatusText } from "../src/features/chat/requestWords.ts"

test("a summary request's purpose and status read as words", () => {
  expect(`${requestPurposeText("condense", { summaries: 5 })}, ${requestStatusText("complete")}`).toBe(
    "Condensing 5 summaries, finished"
  )
  expect(requestPurposeText("condense", { summaries: 1 })).toBe("Condensing 1 summary")
  expect(requestPurposeText("summarize", { from: 41, to: 69 })).toBe("Summarizing messages 41–69")
  expect(requestPurposeText("summarize", { from: 3, to: 3 })).toBe("Summarizing message 3")
  expect(requestPurposeText("summarize")).toBe("Summarizing messages")
  expect(requestStatusText("aborted")).toBe("stopped")
})

test("every stored purpose and status has words, none of them the stored identifier", () => {
  for (const purpose of RequestPurpose.literals) expect(requestPurposeText(purpose)).not.toMatch(/^[a-z_]+$/)
  for (const status of RequestStatus.literals) expect(requestStatusText(status)).toBeTruthy()
})
