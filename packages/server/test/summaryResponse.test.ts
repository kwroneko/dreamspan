import { assert, it } from "@effect/vitest"
import type { AssistantMessage } from "@earendil-works/pi-ai"
import { summaryResponse } from "../src/providers/summaryResponse.ts"
import { makeScrub } from "../src/providers/Providers.ts"

it("summary responses scrub strings before JSON escaping, including tool argument keys, and omit signatures", () => {
  const secret = 'synthetic-"quote\\slash'
  const captured = JSON.parse(
    summaryResponse(
      {
        content: [
          { type: "text", text: `Text ${secret}`, textSignature: "private signature" },
          { type: "thinking", thinking: secret, thinkingSignature: "private signature" },
          { type: "toolCall", id: secret, name: secret, arguments: { [secret]: [secret] } }
        ],
        stopReason: "error",
        errorMessage: secret
      } as AssistantMessage,
      makeScrub([secret])
    )
  )
  assert.deepStrictEqual(captured, {
    content: [
      { type: "text", text: "Text [redacted]" },
      { type: "thinking", thinking: "[redacted]" },
      { type: "toolCall", id: "[redacted]", name: "[redacted]", arguments: { "[redacted]": ["[redacted]"] } }
    ],
    stopReason: "error",
    error: "[redacted]"
  })
})
