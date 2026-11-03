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
  it("keeps a renamed group's name for stamp-only files", () => {
    assert.strictEqual(stChatTitle(DATE, null, "Misaka Mikoto"), `Misaka Mikoto: ${DATE}`)
    assert.strictEqual(stChatTitle("Branch #207 - 2025-01-12@21h40m51s", null, "Misaka Mikoto"), "Misaka Mikoto")
    assert.strictEqual(
      stChatTitle("Branch #207 - 2025-01-12@21h40m51s", DATE, "Misaka Mikoto"),
      `Misaka Mikoto: ${DATE}`
    )
    assert.strictEqual(stChatTitle("2024-08-25@03h30m53s", null, "Party"), "Party: 2024-08-25@03h30m53s000ms")
    assert.strictEqual(stChatTitle("2024-9-10 @13h 44m 41s", null, "Party"), "Party: 2024-9-10 @13h 44m 41s000ms")
  })
  it("recognizes ST's default group name against all actual members, in either order", () => {
    assert.strictEqual(stChatTitle(DATE, null, "Group: Cleo, Dax", ["Dax", "Cleo"]), DATE)
    assert.strictEqual(stChatTitle(DATE, null, "Group: Cleo, Cleo", ["Cleo", "Cleo"]), DATE)
    assert.strictEqual(stChatTitle(DATE, null, "Group: Dax, Cleo, Jr.", ["Cleo, Jr.", "Dax"]), DATE)
    assert.strictEqual(stChatTitle(DATE, null, "Group: Jr., Cleo", ["Cleo, Jr."]), `Group: Jr., Cleo: ${DATE}`)
    assert.strictEqual(stChatTitle(DATE, null, "Group: Cleo, Dax", ["Cleo"]), `Group: Cleo, Dax: ${DATE}`)
    assert.strictEqual(stChatTitle(DATE, null, "Group: Cleo", [null]), `Group: Cleo: ${DATE}`)
    assert.strictEqual(stChatTitle(DATE, null, "Group: Cleo", ["Dax"]), `Group: Cleo: ${DATE}`)
    assert.strictEqual(stChatTitle(DATE, null, "Group: Cleo", ["Cleo", "Cleo"]), `Group: Cleo: ${DATE}`)
    assert.strictEqual(
      stChatTitle("2024-08-25@03h30m53s - Branch #2", null, "Group: Cleo", ["Cleo"]),
      "2024-08-25@03h30m53s000ms"
    )
  })
  it("keeps a user-named group chat file without prefixing its group", () => {
    assert.strictEqual(stChatTitle("Before the duel", null, "Group: Cleo", ["Cleo"]), "Before the duel")
    assert.strictEqual(stChatTitle("Before the duel", null, "Party", ["Cleo"]), "Before the duel")
  })
})
