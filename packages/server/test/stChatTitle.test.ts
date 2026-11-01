import { assert, describe, it } from "@effect/vitest"
import { stChatTitle } from "../src/importer/stMapping.ts"

const DATE = "2026-3-14@09h26m53s589ms"

// An ST file's name names neither a fork nor, for a branch, the chat (owner, 2026-11-01).
describe("stChatTitle", () => {
  it("is the root chat's name for a solo chat", () => {
    assert.strictEqual(stChatTitle(`Bot - ${DATE}`, null, null), `Bot - ${DATE}`)
    assert.strictEqual(stChatTitle("Before the duel", null, null), "Before the duel")
  })
  it("takes a branch whose parent wasn't imported by its main chat's name", () => {
    assert.strictEqual(stChatTitle("Branch #207 - 2025-01-12@21h40m51s", `Bot - ${DATE}`, null), `Bot - ${DATE}`)
    assert.strictEqual(stChatTitle(`Bot - ${DATE} - Branch #3`, `Bot - ${DATE} - Branch #1`, null), `Bot - ${DATE}`)
  })
  it("drops a name ST made up for a branch", () => {
    for (const name of [
      `Branch #12 - ${DATE}`,
      "Checkpoint #3 - 2024-07-12@01h31m37s",
      "Bookmark #2 - 2023-6-19 @14h 20m 12s 123ms",
      "   "
    ]) {
      assert.strictEqual(stChatTitle(name, null, null), "", name)
      assert.strictEqual(stChatTitle("x", name, null), "", name)
    }
  })
  it("is the group's name for a group chat, with its root's name after it", () => {
    assert.strictEqual(stChatTitle(DATE, null, "Misaka Mikoto"), `Misaka Mikoto: ${DATE}`)
    assert.strictEqual(stChatTitle("Branch #207 - 2025-01-12@21h40m51s", null, "Misaka Mikoto"), "Misaka Mikoto")
    assert.strictEqual(
      stChatTitle("Branch #207 - 2025-01-12@21h40m51s", DATE, "Misaka Mikoto"),
      `Misaka Mikoto: ${DATE}`
    )
  })
})
