import { expect, test } from "vitest"
import { changeHomeBrowse, readHomeSearch, writeHomeSearch } from "../src/features/characters/homeSearch.ts"

test("home query state round-trips while omitting defaults", () => {
  expect(Object.values(writeHomeSearch(readHomeSearch({})))).toEqual(Array(6).fill(undefined))
  const query = {
    show: "groups",
    sort: "name",
    reverse: true,
    personas: true,
    q: "  Alice & Bob?  ",
    pinsSort: "created"
  }
  expect(writeHomeSearch(readHomeSearch(query))).toEqual(query)
})

test("stale and malformed query values fall back independently", () => {
  expect(
    readHomeSearch({ show: {}, sort: ["name"], reverse: "true", personas: "yes", q: 123, pinsSort: "added" })
  ).toEqual(readHomeSearch({}))
  expect(readHomeSearch({ show: "deleted", sort: "added", reverse: true, q: "Bob" })).toMatchObject({
    filter: "all",
    sort: "added",
    reversed: true,
    search: "Bob"
  })
})

test("a new sort resets direction while other choices keep it", () => {
  const state = readHomeSearch({ sort: "name", reverse: true })
  expect(changeHomeBrowse(state, { sort: "created" }).reversed).toBe(false)
  expect(changeHomeBrowse(state, { sort: "name" }).reversed).toBe(true)
  expect(changeHomeBrowse(state, { filter: "groups", search: "Trio" }).reversed).toBe(true)
})

test("Personas is a home tab, and Include personas round-trips", () => {
  expect(readHomeSearch({ show: "personas" }).filter).toBe("personas")
  expect(readHomeSearch({ personas: true }).withPersonas).toBe(true)
  expect(writeHomeSearch(readHomeSearch({})).personas).toBeUndefined()
})
