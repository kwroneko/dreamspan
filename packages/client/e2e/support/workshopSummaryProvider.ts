import { completionChunks, sse, startMockProvider } from "../../../server/test/support/mockProvider.ts"

export const WORKSHOP_MEMORY = "WORKSHOP MEMORY: Synthetic keeper was read; its original results remain available."
export const WORKSHOP_DONE = "Synthetic workshop task complete."

/** Independent script progress survives summary replacement of earlier tool results. */
export const startSummaryWorkshopProvider = async () => {
  let step = 99,
    task = 0
  const mock = await startMockProvider((req, res) => {
    if (!req.body) {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ data: [] }))
      return
    }
    if (!Array.isArray(req.body.tools) || !req.body.tools.length)
      return sse(res, completionChunks([WORKSHOP_MEMORY], {}))
    const calls = [
      { name: "list_library", arguments: { kind: "card" } },
      ...Array.from({ length: 6 }, () => ({
        name: "read_card",
        arguments: { card: "Synthetic keeper", fields: ["description"] }
      })),
      {
        name: "edit_card",
        arguments: { card: "Synthetic keeper", changes: [{ field: "personality", text: `Synthetic task ${task}` }] }
      }
    ]
    const call = calls[step++]
    if (!call) return sse(res, completionChunks([WORKSHOP_DONE], {}))
    sse(res, [
      {
        id: "synthetic",
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: `task-${task}-${step}`,
                  type: "function",
                  function: { name: call.name, arguments: JSON.stringify(call.arguments) }
                }
              ]
            },
            finish_reason: null
          }
        ]
      },
      {
        id: "synthetic",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
      }
    ])
  })
  return {
    ...mock,
    begin: () => {
      task++
      step = 0
    }
  }
}
