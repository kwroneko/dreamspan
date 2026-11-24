import { expect, it } from "vitest"
import { systemOneKind } from "../src/providers/systemOne.ts"

const decide = (response: Response) =>
  systemOneKind.decide!.decide({
    baseUrl: "/decide",
    apiKey: null,
    headers: {},
    fetch: async () => response,
    body: { model: "test", state: {}, questions: {} },
    signal: new AbortController().signal
  })

it("rejects an oversized UTF-8 decision response and cancels further reads", async () => {
  const encoder = new TextEncoder()
  const chunks = ['{"text":"', "é".repeat(300_000), "é".repeat(300_000), '"}'].map((text) => encoder.encode(text))
  let bytesRead = 0
  let cancelled = false
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = chunks.shift()
        if (!chunk) return controller.close()
        bytesRead += chunk.byteLength
        controller.enqueue(chunk)
      },
      cancel() {
        cancelled = true
      }
    },
    { highWaterMark: 0 }
  )
  expect((await decide(new Response(body))).body).toBeNull()
  expect(cancelled).toBe(true)
  expect(bytesRead).toBe(1_200_009)
  expect(chunks).toHaveLength(1)
})

it("decodes a complete UTF-8 JSON response at the byte limit", async () => {
  const text = "é".repeat(499_994) + "x"
  const json = JSON.stringify({ text })
  expect(new TextEncoder().encode(json)).toHaveLength(1_000_000)
  expect((await decide(new Response(json))).body).toEqual({ text })
})
