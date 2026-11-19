// Synthetic paths: reports must retain each file's identity when names share a long prefix.
import { describe, expect, it } from "vitest"
import type { ChatId } from "@dreamspan/shared/chat.ts"
import { Report } from "../src/importer/stReport.ts"

describe("ST report file links", () => {
  it("keeps long file paths distinct and links each issue to its own chat", () => {
    const report = new Report()
    const prefix = `chats/${"Long character name ".repeat(3)}/`
    const paths = [`${prefix}first.jsonl`, `${prefix}second.jsonl`]
    for (const [index, path] of paths.entries()) {
      report.issue(path, "warning", "st.author_note_riders", "Check the placement.")
      report.chat(path, `chat-${index}` as ChatId)
    }
    expect(report.build().issues.map(({ path, chatId }) => ({ path, chatId }))).toEqual(
      paths.map((path, index) => ({ path, chatId: `chat-${index}` }))
    )
  })
})
