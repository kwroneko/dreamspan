import { expect, test } from "vitest"
import { mainPrompt } from "@dreamspan/shared/presetOrder.ts"
import { placeholderHelp, promptKind, volatileMacros } from "../src/features/editor/promptKinds.tsx"

test("volatile warnings use the registry, parsed nested calls and actual aliases", () => {
  expect(volatileMacros("{{roll::1d6}} {{random::red::blue}} {{DATE}} {{idle_duration}} {{roll::1d6}}")).toEqual([
    "{{roll}}",
    "{{random}}",
    "{{DATE}}",
    "{{idle_duration}}"
  ])
  expect(volatileMacros("{{pick::red::blue}} {{char}} {{roll")).toEqual([])
  expect(volatileMacros("{{if::{{roll::1d6}}::then}}")).toEqual(["{{roll}}"])
})

test.each([
  ["charDescription", "Each character's Description, from their cards"],
  ["charPersonality", "Each character's Personality, from their cards"],
  ["scenario", "Each character's Scenario, from their cards"],
  ["personaDescription", "Your persona's Description, from its card"],
  [
    "charDefinitions",
    "Each character's Description, Personality and Scenario, and your persona's Description, from their cards"
  ],
  ["dialogueExamples", "Each character's example messages, from their cards"],
  ["worldInfoBefore", "Lorebook entries placed before the character definitions"],
  ["worldInfoAfter", "Lorebook entries placed after the character definitions"],
  ["chatHistory", "The messages of the chat"],
  ["newestMessage", "The newest message of the chat"],
  ["summaries", "The chat's summaries of earlier messages"],
  ["unknownMarker", "No content source"]
])("%s names its placeholder source", (identifier, source) => {
  expect(promptKind({ ...mainPrompt, identifier, marker: true })?.hint).toBe(source)
})

test.each([
  ["charDescription", "Edit Description in each character's card, Definition tab."],
  ["charPersonality", "Edit Personality in each character's card, Definition tab."],
  ["scenario", "Edit Scenario in each character's card, Definition tab."],
  ["personaDescription", "Edit Description in your persona's card, Definition tab."],
  ["charDefinitions", "in their cards' Definition tabs."],
  ["dialogueExamples", "Edit Example messages in each character's card, Definition tab."],
  ["worldInfoBefore", "Edit the entries in the chat's lorebooks."],
  ["worldInfoAfter", "Edit the entries in the chat's lorebooks."],
  ["chatHistory", "Edit the messages in the chat."],
  ["newestMessage", "Edit the message in the chat."],
  ["summaries", "Edit the summaries in the chat's Summaries tab."]
])("%s explains insertion, editability and where to edit in at most three sentences", (identifier, destination) => {
  const help = placeholderHelp(identifier)
  expect(help).toContain("Each request inserts")
  expect(help).toContain("isn't from the preset and can't be edited here")
  expect(help).toContain(destination)
  expect(help.split(".").filter((sentence) => sentence.trim()).length).toBeLessThanOrEqual(3)
})

test("source help explains Definitions routing and unknown sources truthfully", () => {
  expect(placeholderHelp("charDescription", true)).toContain("sent through the enabled Definitions block instead")
  expect(placeholderHelp("unknownMarker")).toContain("no text is inserted")
})

test.each(["constructor", "toString", "__proto__"])("%s has no placeholder source", (identifier) => {
  expect(placeholderHelp(identifier)).toBe(placeholderHelp("unknownMarker"))
})
