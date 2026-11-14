// A chat's lines as SillyTavern files (formats/stChatExport.ts) and the streamed zip that holds
// every branch (formats/zipStream.ts). Synthetic messages only.
import type { PathEntry, Version } from "@rp/shared/chat.ts"
import { describe, expect, it } from "vitest"
import { fileStem, stHeader, stLine, stStamp, textLine } from "../../src/formats/stChatExport.ts"
import { parseStDate } from "../../src/formats/stChat.ts"
import { textChunks, zipStream } from "../../src/formats/zipStream.ts"
import { extract, readZip } from "../../src/formats/zip.ts"
import { defaultLimits } from "../../src/formats/safety.ts"

const version = (id: string, content: string, more: Partial<Version> = {}) =>
  ({
    id,
    slotId: "slot",
    ordinal: 0,
    status: "complete",
    speakerEntityId: "aria",
    writer: "model",
    content,
    macroMode: "verbatim",
    hidden: false,
    starred: false,
    createdAt: Date.UTC(2026, 0, 2, 10),
    model: null,
    error: null,
    ...more
  }) as unknown as Version

const entry = (shown: Version, more: Partial<PathEntry> = {}) =>
  ({
    slotId: "slot",
    contextExcluded: false,
    version: shown,
    versionCount: 1,
    firstSpeakerEntityId: "aria",
    ...more
  }) as unknown as PathEntry

const aria = { name: "Aria", user: false }

describe("SillyTavern chat lines", () => {
  it("a header names the user, the character and the main chat of a branch", () => {
    const header = JSON.parse(
      stHeader({
        userName: "Sam",
        characterName: "Aria",
        createdAt: Date.UTC(2026, 0, 2, 3, 4, 5),
        mainChat: "Aria - main"
      })
    )
    expect(header).toEqual({
      user_name: "Sam",
      character_name: "Aria",
      create_date: "2026-01-02@03h04m05s",
      chat_metadata: { main_chat: "Aria - main" }
    })
    expect(parseStDate(header.create_date)).toBe(Date.UTC(2026, 0, 2, 3, 4, 5))
  })

  it("every version is a swipe, the shown one chosen, each with its dates and generation", () => {
    const first = version("v1", "First.", {
      createdAt: Date.UTC(2026, 0, 2, 10),
      model: "OpenRouter · synthetic/model",
      modelRef: { provider: "openrouter", model: "synthetic/model" },
      recorded: {
        startedAt: Date.UTC(2026, 0, 2, 9, 59),
        finishedAt: Date.UTC(2026, 0, 2, 10),
        tokens: 12,
        firstTokenMs: 300
      }
    })
    const second = version("v2", "Second.", { reasoning: "Thinking it over.", createdAt: Date.UTC(2026, 0, 2, 11) })
    const failed = version("v3", "", { status: "failed" })
    const line = JSON.parse(
      stLine(entry(second, { versionCount: 3, contextExcluded: true }), [first, second, failed], aria, "Sam")
    )
    expect(line).toMatchObject({
      name: "Aria",
      is_user: false,
      is_system: true,
      mes: "Second.",
      send_date: "2026-01-02T11:00:00.000Z",
      extra: { reasoning: "Thinking it over.", reasoning_type: "model" },
      swipe_id: 1,
      swipes: ["First.", "Second."]
    })
    expect(line.swipe_info[0]).toEqual({
      send_date: "2026-01-02T10:00:00.000Z",
      gen_started: "2026-01-02T09:59:00.000Z",
      gen_finished: "2026-01-02T10:00:00.000Z",
      extra: { api: "openrouter", model: "synthetic/model", token_count: 12, time_to_first_token: 300 }
    })
  })

  it("a message never swiped has no swipe fields, and a greeting's names are filled in", () => {
    const greeting = version("g", "Hello {{user}}, I am {{char}}.", { macroMode: "template" })
    const line = JSON.parse(stLine(entry(greeting), [greeting], aria, "Sam"))
    expect(line.mes).toBe("Hello Sam, I am Aria.")
    expect(line).not.toHaveProperty("swipes")
    expect(textLine(entry(greeting), aria, "Sam")).toBe("Aria: Hello Sam, I am Aria.")
  })

  it("stamps and file names are ones ST and any file system accept", () => {
    expect(stStamp(Date.UTC(2025, 11, 31, 23, 59, 58))).toBe("2025-12-31@23h59m58s")
    expect(fileStem('A/B: "C"?. ', "x")).toBe("A_B_ _C__")
    expect(fileStem("  ", "fallback")).toBe("fallback")
  })
})

describe("streamed zip", () => {
  it("holds each file whole, readable by the zip reader", async () => {
    async function* lines(n: number) {
      for (let i = 0; i < n; i++) yield `line ${i} ${"text ".repeat(50)}\n`
    }
    async function* entries() {
      yield { name: "Aria - main.jsonl", chunks: textChunks(lines(5000), 4096) }
      yield { name: "Aria - main - Branch #1.jsonl", chunks: textChunks(lines(10)) }
      yield { name: "empty.txt", chunks: textChunks(lines(0)) }
    }
    const parts: Array<Uint8Array> = []
    for await (const chunk of zipStream(entries())) parts.push(chunk)
    const bytes = new Uint8Array(Buffer.concat(parts))
    const read = readZip(bytes, defaultLimits)
    expect([...read.keys()]).toEqual(["Aria - main.jsonl", "Aria - main - Branch #1.jsonl", "empty.txt"])
    const budget = { used: 0 }
    const text = (name: string) => new TextDecoder().decode(extract(bytes, read.get(name)!, defaultLimits, budget))
    expect(text("Aria - main.jsonl").split("\n")).toHaveLength(5001)
    expect(text("Aria - main - Branch #1.jsonl").startsWith("line 0 ")).toBe(true)
    expect(text("empty.txt")).toBe("")
  })
})
