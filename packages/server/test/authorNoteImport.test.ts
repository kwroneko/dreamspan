// What an ST import makes of what ST places at its author's note (owner, 2026-11-01: no
// author's note), compared with what master sent for the same synthetic folder.
//
// `fixtures/authorNote/master-requests.json` is the request each fork assembled on master
// (e6ef53ff) after importing `authorNoteFolder()` and then `authorNoteFolder("Rain all night.",
// true)`, with lore "only below the history" turned off in every chat but the plain and quiet
// ones (`loreWherePlaced`).
import { readFileSync } from "node:fs"
import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { authorNoteFolder } from "./support/authorNoteFolder.ts"
import { serverLayer, testConfig } from "./support/config.ts"
import { forkRequests, loreWherePlaced, type RequestMessage } from "./support/forkRequests.ts"
import { importStFolder } from "./support/stUpload.ts"

const fixture = (name: string) => new URL(`./fixtures/authorNote/${name}`, import.meta.url)

/** Master's requests, keyed as `forkRequests` keys them. */
const masterRequests = (() => {
  const raw = JSON.parse(readFileSync(fixture("master-requests.json"), "utf8")) as Record<
    string,
    { readonly chat: string; readonly fork: string; readonly messages: ReadonlyArray<RequestMessage> }
  >
  const out: Record<string, ReadonlyArray<RequestMessage>> = {}
  const seen = new Map<string, number>()
  // Written in chat title order, each chat's forks by creation, as `forkRequests` reads them.
  for (const [key, value] of Object.entries(raw)) {
    const title = key.split(" :: ")[0]!
    const index = seen.get(title) ?? 0
    seen.set(title, index + 1)
    out[`${title} #${index}`] = value.messages.map(({ role, content }) => ({ role, content }))
  }
  return out
})()

const system = (content: string) => ({ role: "system", content })
const lore = "Lore at depth one.\nLore after the note.\nLore before the note."
const riders = "Aria wears a grey coat.\nAria hums when nervous.\nSam is tall and patient."
const mainNote = (note: string) => ({
  [`Sam is tall and patient.\nAria hums when nervous.\nLore before the note.\n${note}\nLore after the note.\nAria wears a grey coat.\nLore at depth one.`]:
    [system(`${note}\n${riders}\n${lore}`)]
})

/**
 * How the requests differ from master's, by the master message each change replaces; every
 * other message is byte for byte master's. What rode on the author's note is where the folder's
 * default author's note is (depth 1, the system), joined in the order notes and lore at one
 * depth always join (the chat's notes, the cards', the personas', then lore) rather than
 * around the author's note's text. A card's note and lore have one place in every chat: the
 * group chat's author's note is at depth 2, and `Bram - one`'s after the main prompt, so what
 * ST put at theirs is at depth 1, and the import report warns (`st.author_note_riders`).
 */
const IMPORTED: Record<string, Record<string, ReadonlyArray<RequestMessage>>> = {
  "Aria - main #0": mainNote("Rain all night."),
  "Aria - main #1": mainNote("Snow now."),
  "Aria - main #2": mainNote("Rain all day."),
  "Aria - plain #0": {
    "Sam is tall and patient.\nAria hums when nervous.\nAria wears a grey coat.": [system(riders)]
  },
  "Both: Both - 1 #0": {
    "Sam is tall and patient.\nLore before the note.\nCrowded room.\nLore after the note.": [system("Crowded room.")],
    "Aria wears a grey coat.\nLore at depth one.": [
      system(`Aria wears a grey coat.\nSam is tall and patient.\n${lore}`)
    ]
  },
  "Bram - one #0": {
    "Dust storm.\nBram limps.\nRook keeps a ledger.": [{ role: "user", content: "Dust storm." }],
    "I brought the ledger.": [
      system("Bram limps.\nRook keeps a ledger."),
      { role: "user", content: "I brought the ledger." }
    ]
  }
}

/** Master's requests with `changes` applied. */
const expected = (changes: typeof IMPORTED) =>
  Object.fromEntries(
    Object.entries(masterRequests).map(([key, messages]) => [
      key,
      messages.flatMap((m) => changes[key]?.[m.content as string] ?? [m])
    ])
  )

layer(serverLayer(testConfig()), { excludeTestServices: true, timeout: "180 seconds" })(
  "ST author's note import",
  (it) => {
    it.effect("places what ST put at the author's note where the default one is, kept", () =>
      Effect.gen(function* () {
        const { report } = yield* importStFolder(authorNoteFolder())
        assert.deepStrictEqual(
          report.issues.filter((issue) => issue.code === "st.author_note_riders").map((issue) => issue.path),
          ["chats/Bram/Bram - one.jsonl", "group chats/Both - 1.jsonl"]
        )
        yield* importStFolder(authorNoteFolder("Rain all night.", true))
        yield* loreWherePlaced(["plain", "quiet"])
        assert.deepStrictEqual(yield* forkRequests, expected(IMPORTED))
      })
    )
  }
)
