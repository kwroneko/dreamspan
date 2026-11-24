import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { LIVE, startRecorder } from "./live/support/live.ts"
import { tempDir } from "./support/tempDir.ts"

it("redacts a credential split across upstream response chunks", async () => {
  const out = tempDir("live-recorder")
  const previousOut = LIVE.out
  LIVE.out = out
  const parts = ["refusal echoed synthetic-", "credential"]
  const fetchRecorder = globalThis.fetch
  const upstream = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      new ReadableStream({
        start(controller) {
          for (const part of parts) controller.enqueue(new TextEncoder().encode(part))
          controller.close()
        }
      })
    )
  )
  const recorder = await startRecorder(["synthetic-credential"])
  try {
    const response = await fetchRecorder(`${recorder.url}/openai/refusal`)
    expect(await response.text()).toBe(parts.join(""))
    expect(recorder.exchanges[0]?.body).toBe("refusal echoed <redacted>")
    const artifact = await readFile(join(out, `exchanges-${process.pid}.jsonl`), "utf8")
    expect(JSON.parse(artifact).body).toBe("refusal echoed <redacted>")
  } finally {
    await recorder.close()
    upstream.mockRestore()
    LIVE.out = previousOut
  }
})
