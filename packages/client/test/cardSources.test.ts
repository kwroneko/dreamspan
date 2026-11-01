import { afterEach, beforeEach, expect, it } from "vitest"
import { register } from "../src/features/cardSources/index.tsx"
import { cardSources, sourceRecognizers, type SourceInput } from "../src/features/cardSources/sources.ts"

// Synthetic cards only.
const card = (fields: Partial<SourceInput> = {}): SourceInput => ({
  creator: "",
  creator_notes: "",
  extensions: {},
  ...fields
})

let disposers: Array<() => void> = []
beforeEach(() => {
  disposers = register()
})
afterEach(() => {
  for (const dispose of disposers.reverse()) dispose()
})

it("lists nothing for a card with no sources", () => {
  expect(cardSources(card())).toEqual([])
})

it("links a chub card from extensions.chub and its creator", () => {
  const doc = card({ extensions: { chub: { id: 12345, full_path: "synthcreator/test-card-1a2b" } } })
  expect(cardSources(doc)).toEqual([
    {
      kind: "link",
      site: "Chub",
      url: "https://chub.ai/characters/synthcreator/test-card-1a2b",
      label: "synthcreator/test-card-1a2b"
    },
    { kind: "link", site: "Chub", url: "https://chub.ai/users/synthcreator", label: "Creator: synthcreator" }
  ])
})

it("normalizes chub URLs in source and de-duplicates them against the extension link", () => {
  const doc = card({
    extensions: { chub: { full_path: "synthcreator/test-card" } },
    source: [
      "https://www.characterhub.org/characters/synthcreator/test-card",
      "https://chub.ai/lorebooks/synthcreator/world"
    ]
  })
  expect(cardSources(doc).map((s) => (s.kind === "link" ? s.url : s.id))).toEqual([
    "https://chub.ai/characters/synthcreator/test-card",
    "https://chub.ai/lorebooks/synthcreator/world",
    "https://chub.ai/users/synthcreator"
  ])
})

it("names RisuRealm URLs and reads RisuAI's extensions.risuai.source", () => {
  const doc = card({
    source: ["https://realm.risuai.net/character/0123abcd-0000-1111-2222-333344445555"],
    extensions: {
      risuai: {
        source: [
          "https://example.org/my-card",
          "https://realm.risuai.net/character/0123abcd-0000-1111-2222-333344445555"
        ]
      }
    }
  })
  expect(cardSources(doc)).toEqual([
    { kind: "link", site: "RisuRealm", url: "https://realm.risuai.net/character/0123abcd-0000-1111-2222-333344445555" },
    { kind: "link", site: "example.org", url: "https://example.org/my-card" }
  ])
})

it("names the other import sites by host and lists unknown URLs and ids plainly", () => {
  const doc = card({
    source: [
      "https://janitorai.com/characters/00000000-aaaa-bbbb-cccc-000000000000_character-synth",
      "https://pygmalion.chat/character/00000000-aaaa-bbbb-cccc-000000000001",
      "https://www.jannyai.com/characters/synth",
      "https://unknown.example/cards/7",
      "https://unknown.example/cards/7",
      "archive:synthetic-id-42",
      "javascript:alert(1)",
      "  "
    ]
  })
  expect(cardSources(doc).map((s) => (s.kind === "link" ? `${s.site} ${s.url}` : `id ${s.id}`))).toEqual([
    "JanitorAI https://janitorai.com/characters/00000000-aaaa-bbbb-cccc-000000000000_character-synth",
    "JannyAI https://www.jannyai.com/characters/synth",
    "Pygmalion https://pygmalion.chat/character/00000000-aaaa-bbbb-cccc-000000000001",
    "unknown.example https://unknown.example/cards/7",
    "id archive:synthetic-id-42",
    "id javascript:alert(1)"
  ])
})

it("lets a plugin add a recognizer that claims an id, and disable a built-in", () => {
  const dispose = sourceRecognizers.register({
    id: "plugin.synthetic-archive",
    site: "Synthetic Archive",
    links: (doc) =>
      (doc.source ?? []).flatMap((entry) => {
        const id = /^archive:(.+)$/.exec(entry)?.[1]
        return id ? [{ url: `https://archive.example/card/${id}`, label: id, from: entry }] : []
      })
  })
  const enable = sourceRecognizers.disable("card-sources.janitorai")
  try {
    const doc = card({ source: ["archive:synthetic-id-42", "https://janitorai.com/characters/x"] })
    expect(cardSources(doc)).toEqual([
      {
        kind: "link",
        site: "Synthetic Archive",
        url: "https://archive.example/card/synthetic-id-42",
        label: "synthetic-id-42"
      },
      { kind: "link", site: "janitorai.com", url: "https://janitorai.com/characters/x" }
    ])
  } finally {
    enable()
    dispose()
  }
})

it("keeps listing when a recognizer throws", () => {
  const dispose = sourceRecognizers.register({
    id: "plugin.broken",
    site: "Broken",
    links: () => {
      throw new Error("synthetic")
    }
  })
  try {
    expect(cardSources(card({ source: ["https://unknown.example/a"] }))).toEqual([
      { kind: "link", site: "unknown.example", url: "https://unknown.example/a" }
    ])
  } finally {
    dispose()
  }
})
