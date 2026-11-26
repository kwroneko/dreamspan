import { expect, it } from "vitest"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { editWorkshopBlocks, workshopBlocks } from "../src/agent/workshopBlocks.ts"
import { stepsOf } from "../src/agent/steps.ts"

const assistant = (...content: Array<Record<string, unknown>>) => ({ role: "assistant", content })
const text = (text: string) => ({ type: "text", text })
const tool = (id: string, name = "list_library", args = {}) => ({ type: "toolCall", id, name, arguments: args })
const result = (id: string, name: string) => ({ role: "toolResult", toolCallId: id, toolName: name, content: [] })

it("interleaves prose and indexed trace groups, while explicit sends keep stray prose in the trace", () => {
  const messages = [
    { role: "rpUser" },
    assistant(text("One"), tool("one")),
    result("one", "list_library"),
    assistant(text("Two"), tool("two")),
    result("two", "list_library"),
    assistant(text("Final"))
  ] as unknown as Array<AgentMessage>
  expect(workshopBlocks(messages, [], true, "reply")).toEqual([
    { kind: "text", id: "text:1:0", message: 1, part: 0, text: "One" },
    { kind: "trace", id: "trace:1:1", start: 1, end: 2, count: 1 },
    { kind: "text", id: "text:3:0", message: 3, part: 0, text: "Two" },
    { kind: "trace", id: "trace:3:1", start: 3, end: 4, count: 1 },
    { kind: "text", id: "text:5:0", message: 5, part: 0, text: "Final" }
  ])
  const explicit = [
    { role: "rpRequest", contract: "send_message" },
    ...messages.slice(0, -1),
    assistant(text("Stray"), tool("send", "send_message", { message: "Sent explicitly" })),
    result("send", "send_message")
  ] as Array<AgentMessage>
  expect(
    workshopBlocks(explicit, [], true, "reply").map((block) => (block.kind === "text" ? block.text : block.end))
  ).toEqual([stepsOf(explicit, [], true, "reply").length, "Sent explicitly"])
})

it("edits a sent block by coordinate and drops signatures only from the edited turn onward", () => {
  const thinking = () => ({ type: "thinking", thinking: "Thought", thinkingSignature: "signature" })
  const messages = [
    { role: "rpRequest", contract: "send_message" },
    assistant(thinking(), text("Private progress"), tool("search")),
    result("search", "list_library"),
    assistant(thinking(), { ...tool("send", "send_message", { message: "Original" }), thoughtSignature: "signature" }),
    result("send", "send_message")
  ] as unknown as Array<AgentMessage>
  const blocks = workshopBlocks(messages, [], true, "source")
  expect(
    editWorkshopBlocks(messages, blocks, [{ message: 1, part: 1, text: "Invisible" }], "source", "edit")
  ).toBeNull()
  const edited = editWorkshopBlocks(messages, blocks, [{ message: 3, part: 1, text: "Edited" }], "source", "edit")
  expect(edited?.at(-1)).toMatchObject({ kind: "text", text: "Edited" })
  expect(messages[1]).toMatchObject({ content: [thinking(), text("Private progress"), tool("search")] })
  expect(messages[3]).toMatchObject({
    content: [{ type: "thinking", thinking: "Thought" }, tool("send", "send_message", { message: "Edited" })]
  })
  if (messages[3]?.role === "assistant") {
    expect(messages[3].content[0]).not.toHaveProperty("thinkingSignature")
    expect(messages[3].content[1]).not.toHaveProperty("thoughtSignature")
  }
})
