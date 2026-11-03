import { expect, test } from "vitest"
import { volatileMacros } from "../src/features/editor/promptKinds.tsx"

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
