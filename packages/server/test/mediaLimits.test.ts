import { expect, it } from "vitest"
import { makeMediaLimits } from "../src/net/mediaLimits.ts"

it("limits bursts, replenishes tokens, isolates users and expires idle buckets", () => {
  let time = 0
  const limits = makeMediaLimits(() => time)
  for (let i = 0; i < 60; i++) {
    const release = limits.acquire("alice")
    expect(release).not.toBeNull()
    release!()
    release!()
  }
  expect(limits.acquire("alice")).toBeNull()
  limits.acquire("bob")!()
  time = 1000
  limits.acquire("alice")!()
  expect(limits.acquire("alice")).toBeNull()
  time = 61_000
  limits.acquire("alice")!()
})

it("bounds all users together and releases capacity", () => {
  const limits = makeMediaLimits()
  const release = Array.from({ length: 32 }, (_, i) => limits.acquire(`user-${i}`))
  expect(release.every(Boolean)).toBe(true)
  expect(limits.acquire("another")).toBeNull()
  release[0]!()
  expect(limits.acquire("another")).not.toBeNull()
})
