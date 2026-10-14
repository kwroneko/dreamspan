import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { ChatSetupApi } from "../src/chatSetupApi.ts"

const rpc = ChatSetupApi.requests.get("StartChat")!

describe("StartChat title contract", () => {
  for (const length of [200, 201, 218, 1000]) {
    it(`preserves a group name of ${length} characters`, () => {
      const title = "x".repeat(length)
      const payload = {
        cards: ["01900000-0000-7000-8000-000000000001"],
        persona: null,
        greeting: null,
        first: { _tag: "Send", content: "First message", speakerEntityId: null },
        title
      }
      expect(Schema.encodeUnknownSync(rpc.payloadSchema)(payload)).toEqual(payload)
    })
  }
})
