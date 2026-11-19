// A card's skills as the server reads them and as the editor explains them (spec/TOOL-LOADING.md
// §6): the editor's reasons agree with what the reader keeps. Synthetic entries only.
import { describe, expect, it } from "vitest"
import {
  CARD_SKILL_LIMITS,
  cardSkillList,
  cardSkillProblems,
  duplicateSkillNames,
  readCardSkill
} from "../src/cardSkills.ts"

const own = { name: "proofread", description: "Checks spelling.", instructions: "List typos.", tools: ["read_card"] }

describe("card skills", () => {
  it("reads references and own skills, and skips what it can't use", () => {
    expect(cardSkillList({ dreamspan: { skills: [own, { use: "cards" }] } })).toHaveLength(2)
    expect(cardSkillList({ dreamspan: { skills: "no" } })).toEqual([])
    expect(cardSkillList(undefined)).toEqual([])
    expect(readCardSkill({ use: "cards" })).toEqual({ use: "cards" })
    expect(readCardSkill(own)).toEqual(own)
    expect(readCardSkill({ ...own, name: "Bad Name" })).toBeNull()
    expect(readCardSkill({ ...own, description: " " })).toBeNull()
    expect(readCardSkill({ ...own, instructions: "" })).toBeNull()
  })

  it("explains each entry the reader would skip or shorten, and nothing about a good one", () => {
    expect(cardSkillProblems(own, 0)).toEqual([])
    expect(cardSkillProblems({ use: "cards" }, 0)).toEqual([])
    for (const entry of [
      { ...own, name: "Bad Name" },
      { ...own, description: "" },
      { ...own, instructions: "" }
    ]) {
      expect(readCardSkill(entry)).toBeNull()
      expect(cardSkillProblems(entry, 0).some((p) => p.startsWith("Skipped"))).toBe(true)
    }
    const long = { ...own, description: "x".repeat(CARD_SKILL_LIMITS.description + 1) }
    expect(readCardSkill(long)).not.toBeNull()
    expect(cardSkillProblems(long, 0)).toEqual([
      `Only the first ${CARD_SKILL_LIMITS.description} characters of what it's for are used.`
    ])
    expect(cardSkillProblems(own, CARD_SKILL_LIMITS.entries)).toEqual([
      `Only the first ${CARD_SKILL_LIMITS.entries} skills are used.`
    ])
  })

  it("names duplicates among the card's own skills", () => {
    expect([...duplicateSkillNames([own, own, { use: "cards" }])]).toEqual(["proofread"])
    expect(duplicateSkillNames([own, { ...own, name: "other" }]).size).toBe(0)
  })
})
