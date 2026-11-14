import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { assert, describe, it } from "@effect/vitest"
import { planMessageResume, StepNotResumable } from "../src/agent/resume.ts"
import { stepsOf } from "../src/agent/steps.ts"

const call = (id: string, name: string) => ({ type: "toolCall", id, name, arguments: { message: id } })
const transcript = [
  { role: "rpRequest", timestamp: 1 },
  {
    role: "assistant",
    content: [call("send-1", "send_message"), call("read-2", "read_card"), call("send-2", "send_message")],
    timestamp: 2,
    stopReason: "toolUse"
  },
  {
    role: "toolResult",
    toolCallId: "send-1",
    toolName: "send_message",
    content: [{ type: "text", text: "Sent." }],
    details: { versionId: "v1" },
    isError: false,
    timestamp: 3
  },
  {
    role: "toolResult",
    toolCallId: "read-2",
    toolName: "read_card",
    content: [{ type: "text", text: "Card." }],
    isError: false,
    timestamp: 4
  },
  {
    role: "toolResult",
    toolCallId: "send-2",
    toolName: "send_message",
    content: [{ type: "text", text: "Sent." }],
    details: { versionId: "v2" },
    isError: false,
    timestamp: 5
  },
  { role: "assistant", content: [{ type: "text", text: "Final." }], timestamp: 6, stopReason: "stop" }
] as Array<AgentMessage>
const tools = [{ name: "read_card", description: "", label: "Read a card", effect: "read" as const, parameters: {} }]

describe("several messages from the same assistant turn", () => {
  it("places a tool executed between sends on the second message", () => {
    assert.deepStrictEqual(stepsOf(transcript, tools, true, "v1"), [])
    assert.deepStrictEqual(
      stepsOf(transcript, tools, true, "v2").map((step) => (step.kind === "tool" ? step.id : step.kind)),
      ["read-2"]
    )
    assert.deepStrictEqual(stepsOf(transcript, tools, true, "v3"), [])
  })

  it("regenerates send 2 while retaining send 1 and its intervening tool result", () => {
    const plan = planMessageResume(JSON.stringify(transcript), "v2")
    if (plan instanceof StepNotResumable) return assert.fail(plan.message)
    assert.deepStrictEqual(plan.keptCalls, ["send-1", "read-2"])
    assert.deepStrictEqual(
      plan.transcript.map((m) => m.role),
      ["rpRequest", "assistant", "toolResult", "toolResult"]
    )
    const assistant = plan.transcript[1]!
    if (assistant.role !== "assistant") return assert.fail("assistant turn missing")
    assert.deepStrictEqual(
      assistant.content.filter((p) => p.type === "toolCall").map((p) => p.id),
      ["send-1", "read-2"]
    )
    assert.notInclude(JSON.stringify(plan.transcript), "send-2")
  })
})

it("shows a pending tool after send 1 on the working message, not on message 1", () => {
  const waiting = transcript.slice(0, 3)
  assert.isEmpty(stepsOf(waiting, tools, false, "v1"))
  const pending = stepsOf(waiting, tools, false, "working").find((step) => step.kind === "tool")
  assert.deepInclude(pending, { kind: "tool", id: "read-2", status: "running" })
})

it("pairs reused call IDs with results from their own assistant turn", () => {
  const repeated = [
    ...transcript.slice(0, 5),
    { role: "rpUser", message: { role: "user", content: "Next turn." }, timestamp: 7 },
    { role: "assistant", content: [call("read-2", "read_card")], timestamp: 8, stopReason: "toolUse" },
    {
      role: "toolResult",
      toolCallId: "read-2",
      toolName: "read_card",
      content: [{ type: "text", text: "New result." }],
      isError: false,
      timestamp: 9
    },
    { role: "assistant", content: [{ type: "text", text: "Next answer." }], timestamp: 10, stopReason: "stop" }
  ] as Array<AgentMessage>
  assert.isEmpty(stepsOf(repeated, tools, true, "v1"))
  assert.deepStrictEqual(
    stepsOf(repeated, tools, true, "v2")
      .filter((s) => s.kind === "tool")
      .map((s) => s.result),
    ["Card."]
  )
  assert.deepStrictEqual(
    stepsOf(repeated, tools, true, "working")
      .filter((s) => s.kind === "tool")
      .map((s) => s.result),
    ["New result."]
  )
})

it("regenerates a later turn's reused send ID and copies only that turn's receipts", () => {
  const repeated = [
    ...transcript,
    { role: "rpUser", message: { role: "user", content: "New turn." }, timestamp: 7 },
    { role: "assistant", content: [call("send-1", "send_message")], timestamp: 8, stopReason: "toolUse" },
    {
      role: "toolResult",
      toolCallId: "send-1",
      toolName: "send_message",
      content: [{ type: "text", text: "Sent." }],
      details: { versionId: "v4" },
      isError: false,
      timestamp: 9
    }
  ] as Array<AgentMessage>
  const plan = planMessageResume(JSON.stringify(repeated), "v4", transcript.length)
  if (plan instanceof StepNotResumable) return assert.fail(plan.message)
  assert.lengthOf(plan.transcript, transcript.length + 1)
  assert.strictEqual(plan.transcript.at(-1)!.role, "rpUser")
  assert.deepStrictEqual(plan.keptCalls, [])
})

it("projects a tool's display title separately from its model result", () => {
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "enable", name: "plugin_enable", arguments: { commit: "a".repeat(40), plugin: "dice" } }
      ],
      stopReason: "toolUse",
      timestamp: 1
    },
    {
      role: "toolResult",
      toolCallId: "enable",
      toolName: "plugin_enable",
      content: [{ type: "text", text: "Enabled." }],
      details: { presentation: { title: "Dice Roller", subtitle: "Version aaaaaaaa" } },
      isError: false,
      timestamp: 2
    }
  ] as unknown as AgentMessage[]
  const [step] = stepsOf(messages, [], true)
  if (step?.kind !== "tool") throw new Error("Missing tool step")
  assert.strictEqual(step.title, "Dice Roller")
  assert.strictEqual(step.subtitle, "Version aaaaaaaa")
  assert.strictEqual(step.result, "Enabled.")
})
