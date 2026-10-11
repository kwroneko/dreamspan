// The ST harness's mock endpoint, without Docker: it records requests and completes a turn
// both streamed and not.
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { MOCK_MODEL, MOCK_REPLY, type MockEndpoint, startMock } from "./mock.ts"

let mock: MockEndpoint
beforeAll(async () => {
  mock = await startMock()
})
afterAll(() => mock.stop())

const post = (body: object) =>
  fetch(`${mock.url}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  })

describe("the ST harness's mock endpoint", () => {
  it("lists its model", async () => {
    const response = await fetch(`${mock.url}/models`)
    expect(await response.json()).toMatchObject({ data: [{ id: MOCK_MODEL }] })
  })

  it("records a completion request and answers it whole", async () => {
    const next = mock.nextCompletion(5_000)
    const response = await post({ model: MOCK_MODEL, messages: [{ role: "user", content: "Hi" }] })
    expect(await response.json()).toMatchObject({ choices: [{ message: { content: MOCK_REPLY } }] })
    expect(await next).toEqual({
      method: "POST",
      path: "/v1/chat/completions",
      body: { model: MOCK_MODEL, messages: [{ role: "user", content: "Hi" }] }
    })
  })

  it("streams the same reply as server-sent events", async () => {
    const response = await post({ model: MOCK_MODEL, stream: true, messages: [] })
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    const events = (await response.text()).split("\n\n").filter(Boolean)
    expect(events.at(-1)).toBe("data: [DONE]")
    const deltas = events
      .slice(0, -1)
      .map((event) => JSON.parse(event.slice("data: ".length)).choices[0].delta.content ?? "")
    expect(deltas.join("")).toBe(MOCK_REPLY)
    expect(mock.requests.at(-1)?.body).toEqual({ model: MOCK_MODEL, stream: true, messages: [] })
  })
})
