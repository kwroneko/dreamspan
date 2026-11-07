import { expect, test } from "vitest"
import { changeHomeBrowse, readHomeSearch, writeHomeSearch } from "../src/features/characters/homeSearch.ts"

test("home query state round-trips while omitting defaults", () => {
  // Every key, the card source's too, is left out at its default.
  const empty = writeHomeSearch(readHomeSearch({}))
  expect(Object.keys(empty).length).toBeGreaterThan(0)
  expect(Object.values(empty).every((value) => value === undefined)).toBe(true)
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

test("a card source's browsing round-trips, and choosing one of the user's own filters leaves it", () => {
  const query = {
    show: "src.cardex",
    sq: "lantern",
    stags: ["mystery"],
    sxtags: ["horror"],
    sf: { forks: false, tokens: { min: 100 } },
    ssort: "name",
    sreverse: true
  }
  const state = readHomeSearch(query)
  expect(state.source).toBe("cardex")
  expect(state.filter).toBe("all")
  expect(writeHomeSearch(state)).toEqual(query)
  // A malformed source name or value is dropped on its own.
  expect(readHomeSearch({ show: "src.Bad Name!", sq: 5, stags: "x" })).toEqual(readHomeSearch({}))
  expect(changeHomeBrowse(state, { filter: "groups" }).source).toBeNull()
  expect(changeHomeBrowse(state, { sort: "name" }).source).toBe("cardex")
})
