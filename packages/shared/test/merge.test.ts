import { describe, expect, it } from "vitest"
import { merge3, mergeText } from "../src/merge.ts"

// The owner's case (DESIGN §4): a preset re-imported after local edits.
const upstreamV1 = {
  name: "Narrator",
  samplers: { temperature: 1.0, top_p: 0.95 },
  prompts: [
    {
      identifier: "main",
      role: "system",
      content: "You are {{char}}. Write vivid prose in the third person. Do not impersonate {{user}} or speak for them."
    },
    { identifier: "nsfw", role: "system", content: "Keep it tasteful." }
  ],
  order: [
    { identifier: "main", enabled: true },
    { identifier: "nsfw", enabled: true }
  ]
}

// The owner added a summary prompt and softened the impersonation rule.
const ownersVariant = {
  ...upstreamV1,
  prompts: [
    {
      ...upstreamV1.prompts[0],
      content: "You are {{char}}. Write vivid prose in the third person. Avoid speaking for {{user}} unless asked."
    },
    upstreamV1.prompts[1],
    { identifier: "summary", role: "system", content: "{{summary}}" }
  ],
  order: [...upstreamV1.order, { identifier: "summary", enabled: true }]
}

// Upstream v2 rewrote the first sentence, added a style prompt and changed a sampler.
const upstreamV2 = {
  ...upstreamV1,
  samplers: { temperature: 0.8, top_p: 0.95 },
  prompts: [
    {
      ...upstreamV1.prompts[0],
      content:
        "You are {{char}}, the narrator. Write vivid prose in the third person. Do not impersonate {{user}} or speak for them."
    },
    upstreamV1.prompts[1],
    { identifier: "style", role: "system", content: "Prefer short paragraphs." }
  ],
  order: [
    { identifier: "main", enabled: true },
    { identifier: "style", enabled: true },
    { identifier: "nsfw", enabled: true }
  ]
}

describe("merge3: preset re-import", () => {
  it("keeps the owner's edits and takes upstream's, with no conflicts", () => {
    const { value, conflicts } = merge3(upstreamV1, ownersVariant, upstreamV2)
    expect(conflicts).toEqual([])
    expect(value).toEqual({
      name: "Narrator",
      samplers: { temperature: 0.8, top_p: 0.95 },
      prompts: [
        {
          identifier: "main",
          role: "system",
          content:
            "You are {{char}}, the narrator. Write vivid prose in the third person. Avoid speaking for {{user}} unless asked."
        },
        { identifier: "nsfw", role: "system", content: "Keep it tasteful." },
        // Upstream's new prompt goes where upstream put it: after nsfw.
        { identifier: "style", role: "system", content: "Prefer short paragraphs." },
        { identifier: "summary", role: "system", content: "{{summary}}" }
      ],
      order: [
        { identifier: "main", enabled: true },
        { identifier: "style", enabled: true },
        { identifier: "nsfw", enabled: true },
        { identifier: "summary", enabled: true }
      ]
    })
  })

  it("reports a conflict when both sides rewrote the same passage, and keeps ours there", () => {
    const theirs = {
      ...upstreamV1,
      prompts: [
        {
          ...upstreamV1.prompts[0],
          content: upstreamV1.prompts[0]!.content.replace(
            "Do not impersonate {{user}} or speak for them.",
            "Never write {{user}}'s actions."
          )
        },
        upstreamV1.prompts[1]
      ]
    }
    const { value, conflicts } = merge3(upstreamV1, ownersVariant, theirs)
    expect(conflicts.map((c) => c.path)).toEqual([["prompts", "identifier=main", "content"]])
    expect((value as typeof ownersVariant).prompts[0]!.content).toBe(ownersVariant.prompts[0]!.content)
    // Everything else still merged.
    expect((value as typeof ownersVariant).prompts.map((p) => p?.identifier)).toEqual(["main", "nsfw", "summary"])
  })

  it("reports a conflict when upstream deleted a prompt the owner edited", () => {
    const ours = {
      ...upstreamV1,
      prompts: [upstreamV1.prompts[0], { ...upstreamV1.prompts[1], content: "Anything goes." }]
    }
    const theirs = { ...upstreamV1, prompts: [upstreamV1.prompts[0]] }
    const { conflicts } = merge3(upstreamV1, ours, theirs)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!.path).toEqual(["prompts", "identifier=nsfw"])
    expect(conflicts[0]!.theirs).toBeUndefined()
  })

  it("drops a prompt upstream deleted when the owner never touched it", () => {
    const theirs = { ...upstreamV1, prompts: [upstreamV1.prompts[0]] }
    const { value, conflicts } = merge3(upstreamV1, ownersVariant, theirs)
    expect(conflicts).toEqual([])
    expect((value as typeof ownersVariant).prompts.map((p) => p?.identifier)).toEqual(["main", "summary"])
  })
})

describe("merge3: other shapes", () => {
  it("treats arrays without identities as atomic values", () => {
    expect(merge3({ tags: ["a"] }, { tags: ["a", "b"] }, { tags: ["a"] }).value).toEqual({ tags: ["a", "b"] })
    const both = merge3({ tags: ["a"] }, { tags: ["a", "b"] }, { tags: ["a", "c"] })
    expect(both.conflicts.map((c) => c.path)).toEqual([["tags"]])
  })

  it("merges object keys added on both sides", () => {
    expect(merge3({}, { a: 1 }, { b: 2 })).toEqual({ value: { a: 1, b: 2 }, conflicts: [] })
  })

  it("is the identity when nothing changed", () => {
    expect(merge3(upstreamV1, upstreamV1, upstreamV1)).toEqual({ value: upstreamV1, conflicts: [] })
  })
})

describe("merge3: order of keyed arrays", () => {
  const entry = (identifier: string, enabled = true) => ({ identifier, enabled })
  const base = [entry("main"), entry("nsfw"), entry("jb")]
  const ids = (value: unknown) => (value as Array<{ identifier: string }>).map((e) => e.identifier)

  it("takes theirs' order when only theirs reordered, keeping ours' edits and additions", () => {
    const ours = [entry("main"), entry("nsfw", false), entry("summary"), entry("jb")]
    const theirs = [entry("jb"), entry("main"), entry("nsfw")]
    const { value, conflicts } = merge3(base, ours, theirs)
    expect(conflicts).toEqual([])
    expect(value).toEqual([entry("jb"), entry("main"), entry("nsfw", false), entry("summary")])
  })

  it("keeps ours' order when only ours reordered", () => {
    const ours = [entry("jb"), entry("main"), entry("nsfw")]
    const theirs = [entry("main"), entry("nsfw", false), entry("jb")]
    expect(ids(merge3(base, ours, theirs).value)).toEqual(["jb", "main", "nsfw"])
  })

  it("reports a conflict when both sides reordered differently", () => {
    const ours = [entry("jb"), entry("main"), entry("nsfw")]
    const theirs = [entry("nsfw"), entry("main"), entry("jb")]
    const { value, conflicts } = merge3({ order: base }, { order: ours }, { order: theirs })
    expect(conflicts.map((c) => c.path)).toEqual([["order"]])
    expect(ids((value as { order: unknown }).order)).toEqual(["jb", "main", "nsfw"])
  })
})

describe("merge3: keys named like Object.prototype members", () => {
  it("merges a __proto__ key as data", () => {
    const { value, conflicts } = merge3(
      JSON.parse('{"ext":{"__proto__":{"a":1},"k":1}}'),
      JSON.parse('{"ext":{"__proto__":{"a":2},"k":1}}'),
      JSON.parse('{"ext":{"__proto__":{"a":1},"k":2}}')
    )
    expect(conflicts).toEqual([])
    expect(JSON.stringify(value)).toBe('{"ext":{"__proto__":{"a":2},"k":2}}')
  })

  it("reports conflicts on keys like constructor with no inherited base value", () => {
    const { conflicts } = merge3({}, { constructor: "mine" }, { constructor: "theirs" })
    expect(conflicts.map((c) => ({ ...c }))).toEqual([{ path: ["constructor"], ours: "mine", theirs: "theirs" }])
  })
})

describe("mergeText", () => {
  it("combines edits to different sentences of one paragraph", () => {
    expect(mergeText("One two. Three four.", "One TWO. Three four.", "One two. Three FOUR.")).toBe(
      "One TWO. Three FOUR."
    )
  })

  it("keeps line breaks and spacing", () => {
    expect(mergeText("a\n\nb", "a!\n\nb", "a\n\nb?")).toBe("a!\n\nb?")
  })

  it("returns undefined for overlapping edits", () => {
    expect(mergeText("the red door", "the blue door", "the green door")).toBeUndefined()
  })
})
