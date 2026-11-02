// ST's reasoning on messages and in settings.json (spec/REPLY-SECTIONS.md): reasoning ST parsed
// out of a reply (`reasoning_type: "parsed"`) is a reply section here, any other is the
// version's reasoning; its reasoning formatting becomes the imported presets' reply-section
// setting. Synthetic files only.
import { describe, expect, it } from "@effect/vitest"
import { ReportBuilder } from "@rp/shared/importReport.ts"
import { originalReply } from "@rp/shared/replySections.ts"
import { parseStChatPart, stReasoningExtra, type StMessage } from "../../src/formats/stChat.ts"
import { parseStSettings } from "../../src/formats/stData.ts"
import { compilePairs, parseReply } from "../../src/chat/replySections.ts"

const lines = (...values: ReadonlyArray<unknown>) =>
  new TextEncoder().encode(values.map((v) => JSON.stringify(v)).join("\n"))

const parsed = (text: string) => ({
  sections: [{ lead: "", open: "<think>", text, close: "</think>" }],
  gap: "\n"
})

describe("ST reasoning", () => {
  it("imports parsed reasoning as a reply section and model reasoning as reasoning", () => {
    const issues = new ReportBuilder()
    const part = parseStChatPart(
      lines(
        { user_name: "You", character_name: "Alice", create_date: "2025-01-01T09:00:00.000Z" },
        {
          name: "Alice",
          is_user: false,
          mes: "Hi.",
          send_date: "2025-01-01T10:00:00.000Z",
          swipe_id: 1,
          swipes: ["Hey.", "Hi.", "Yo."],
          swipe_info: [
            { send_date: "2025-01-01T09:00:00.000Z", extra: { reasoning: "plan one", reasoning_type: "parsed" } },
            { extra: { reasoning: "stale" } },
            { extra: { reasoning: "model thoughts", reasoning_type: "model" } }
          ],
          extra: { reasoning: "plan two", reasoning_type: "parsed" }
        }
      ),
      { first: true, firstIndex: 0, carryAt: null },
      issues
    )
    const [message] = part.batches.flatMap((b) => JSON.parse(b.messagesJson) as Array<StMessage>)
    expect(message!.versions.map(({ at: _, ...v }) => v)).toEqual([
      { content: "Hey.", reasoning: null, sections: parsed("plan one") },
      // The shown swipe takes the message's own reasoning.
      { content: "Hi.", reasoning: null, sections: parsed("plan two") },
      { content: "Yo.", reasoning: "model thoughts" }
    ])
  })

  it("exports sections as parsed reasoning, or keeps them in the text beside provider reasoning", () => {
    const sections = parsed("plan")
    expect(stReasoningExtra({ content: "Hi.", replySections: sections })).toEqual({
      mes: "Hi.",
      extra: { reasoning: "plan", reasoning_type: "parsed" }
    })
    expect(stReasoningExtra({ content: "Hi.", reasoning: "thoughts", replySections: sections })).toEqual({
      mes: originalReply("Hi.", sections),
      extra: { reasoning: "thoughts", reasoning_type: "model" }
    })
    expect(stReasoningExtra({ content: "Hi." })).toEqual({ mes: "Hi.", extra: {} })
  })

  it("maps reasoning formatting to the presets' setting, its tags literal", () => {
    const settings = (reasoning: unknown) =>
      parseStSettings(new TextEncoder().encode(JSON.stringify({ power_user: { reasoning } })), new ReportBuilder())
        .textSwitches
    const mapped = settings({
      auto_parse: true,
      add_to_prompts: true,
      max_additions: 3,
      prefix: "<|plan|>\n",
      suffix: "\n<|/plan|>"
    })
    expect(mapped).toEqual({
      reply_sections: {
        enabled: true,
        // As written, never a regex (ST has none there): no `regex` switch.
        pairs: [{ open: "<|plan|>\n", close: "\n<|/plan|>", case_sensitive: true }],
        send_back: 3
      }
    })
    expect(compilePairs(mapped!.reply_sections!)).toHaveLength(1)
    const parse = parseReply(compilePairs(mapped!.reply_sections!), undefined, null)
    const out = [...parse.push("<|plan|>\nPlan.\n<|/plan|>\nBody."), ...parse.end()]
    expect(out.filter((chunk) => typeof chunk === "string").join("")).toBe("Body.")
    expect(settings({ auto_parse: false, prefix: "<think>", suffix: "</think>" })!.reply_sections).toEqual({
      enabled: false,
      pairs: [{ open: "<think>", close: "</think>", case_sensitive: true }],
      send_back: 0
    })
    expect(settings({ auto_parse: true, prefix: "", suffix: "</think>" })!.reply_sections!.enabled).toBe(false)
    expect(parseStSettings(new TextEncoder().encode("{}"), new ReportBuilder()).textSwitches).toBeUndefined()
  })
})
