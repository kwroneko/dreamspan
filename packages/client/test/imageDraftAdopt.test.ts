// Attachments an old new-chat page kept in this browser, before new chats were pending chats
// (rev-drafts5 #5): a group's page kept them under its characters and its name, and that
// group's new chat takes them, no other group's (rev-dfu1 #1).
import { expect, it } from "vitest"
import { legacyGroupScope } from "../src/features/chat/imageDraft.ts"

const prefix = "user:pending:"
const harbor = `${prefix}pending-group-chat:mira,tobin:Harbor`

it("a group's old copy is under its sorted characters and its name", () => {
  expect(legacyGroupScope(prefix, { name: "Harbor", members: ["tobin", "mira"] })).toBe(harbor)
  expect(legacyGroupScope(prefix, { name: "Pier: night", members: ["mira", "tobin"] })).toBe(
    `${prefix}pending-group-chat:mira,tobin:Pier: night`
  )
})

it("another group with the same characters, or with one more, doesn't take it", () => {
  expect(legacyGroupScope(prefix, { name: "Night Watch", members: ["mira", "tobin"] })).not.toBe(harbor)
  expect(legacyGroupScope(prefix, { name: "Harbor", members: ["mira", "tobin", "wren"] })).not.toBe(harbor)
  expect(legacyGroupScope(prefix, { name: "Harbor", members: ["mira"] })).not.toBe(harbor)
})
