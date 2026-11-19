// The reader returns independently allocated long messages. Old export retained every
// page before emitting anything; the export must stay below a fixed memory budget as
// total selected text grows to about 1.5 GiB. No real chats, SQLite or provider calls.
import { expect, it } from "vitest"
import { Effect } from "effect"
import type { Chat, Fork, SlotId } from "@dreamspan/shared/chat.ts"
import { chatFiles, type ReaderService } from "../src/importer/chatExport.ts"

it("bounds selected-message memory while streaming a 1.5 GiB transcript", async () => {
  const pages = 24
  const pageSize = 1000
  const textSize = 64 * 1024
  const baseline = process.memoryUsage().rss
  let peak = baseline
  const sample = () => {
    peak = Math.max(peak, process.memoryUsage().rss)
  }
  const reader = {
    StateEventsAt: () => Effect.succeed([]),
    CastCards: () => Effect.succeed([]),
    ReadPath: ({ range }: { range: { _tag: string; from?: SlotId } }) =>
      Effect.sync(() => {
        const page = range._tag === "Bottom" ? pages - 1 : Number(range.from)
        const entries = Array.from({ length: pageSize }, (_, i) => ({
          slotId: `${page}-${i}`,
          firstSpeakerEntityId: null,
          version: {
            speakerEntityId: null,
            writer: "human",
            macroMode: "verbatim",
            content: Buffer.alloc(textSize, 97 + (page % 26)).toString("utf8")
          }
        }))
        sample()
        return { entries, older: page === 0 ? null : String(page - 1), newer: null }
      })
  } as unknown as ReaderService
  const fork = { id: "fork", parentForkId: null, name: null, createdAt: 0, tipSlotId: "end" } as unknown as Fork
  const chat = { id: "chat", title: "Synthetic memory", createdAt: 0 } as unknown as Chat
  const files = await Effect.runPromise(chatFiles(reader, "user" as never, chat, [fork], fork, "txt"))
  let bytes = 0
  for await (const chunk of files.single(fork)) {
    bytes += chunk.byteLength
    sample()
  }
  expect(bytes).toBeGreaterThan(pages * pageSize * textSize)
  expect((peak - baseline) / 1024 ** 2).toBeLessThan(1200)
  console.log(
    "EXPORT_SELECTED_MEMORY",
    JSON.stringify({ bytes, baselineRssMb: baseline / 1024 ** 2, peakRssMb: peak / 1024 ** 2 })
  )
}, 180_000)
