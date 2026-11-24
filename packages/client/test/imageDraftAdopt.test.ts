// Attachments an old new-chat page kept in this browser, before new chats were pending chats
// (rev-drafts5 #5): a group's page kept them under its characters and name, and the group's new
// chat takes them.
import { expect, it } from "vitest"
import { isGroupCopyOf } from "../src/features/chat/imageDraft.ts"

const prefix = "user:pending:"

it("a group's old copy is the new chat's when all its characters are in the chat's cast", () => {
  const cast = new Set(["mira", "tobin", "persona"])
  expect(isGroupCopyOf(prefix, `${prefix}pending-group-chat:mira,tobin:Pier friends`, cast)).toBe(true)
  // A name with a colon in it still names the group's characters first.
  expect(isGroupCopyOf(prefix, `${prefix}pending-group-chat:mira,tobin:Pier: night`, cast)).toBe(true)
})

it("another group's copy, another user's, or a card's isn't", () => {
  const cast = new Set(["mira", "tobin"])
  expect(isGroupCopyOf(prefix, `${prefix}pending-group-chat:mira,ana:Other`, cast)).toBe(false)
  expect(isGroupCopyOf(prefix, `other:pending:pending-group-chat:mira,tobin:Pier friends`, cast)).toBe(false)
  expect(isGroupCopyOf(prefix, `${prefix}pending-chat:mira`, cast)).toBe(false)
  expect(isGroupCopyOf(prefix, `${prefix}pending-group-chat::Empty`, cast)).toBe(false)
})
