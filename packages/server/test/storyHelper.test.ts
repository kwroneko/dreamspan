// The story helper (spec/SUBAGENTS.md SA8, §9 S2 + S3; DESIGN §7.10 [D]): one read-only subagent a
// story reply may ask to look something up or check a draft. Off by default; once This chat →
// Tools allows it, it runs with the reply's read tools only, on the chat's subagent models, within
// the story limits. Synthetic data and scripted loopback providers only.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { STORY_HELPER } from "@dreamspan/shared/subagents.ts"
import type { RolloutStep } from "@dreamspan/shared/agent.ts"
import type { StateEventData } from "@dreamspan/shared/state.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { generateReply } from "./support/generation.ts"
import { completionChunks, sse } from "./support/mockProvider.ts"
import {
  type Body,
  completions,
  isChild,
  mockProvider,
  scripted,
  toolTexts,
  TRIGGER
} from "./support/subagentScript.ts"

const names = (body: Body) => (body.tools ?? []).map((t) => t.function.name)

const settings = (name: string, baseUrl: string) => ({
  name,
  baseUrl,
  compat: {},
  cacheTtlS: null,
  maxConcurrent: null,
  presetOverrideRefId: null
})

const toolsOn = (tools: ReadonlyArray<string>): ReadonlyArray<StateEventData> => [
  { key: "agent.enabled", value: { on: true } },
  { key: "output.contract", value: "final_text" },
  { key: "agent.tools", value: { tools } }
]

const userText = (body: Body) =>
  body.messages
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n")

describe("the story helper", () => {
  it.live("is off by default: listed for This chat → Tools, never offered until allowed", () =>
    Effect.gen(function* () {
      const script = scripted({ parent: [], child: () => undefined })
      const provider = yield* mockProvider(script.handler)
      const api = yield* client()
      const listed = yield* api.ListReplyTools({})
      const helper = listed.tools.find((t) => t.id === STORY_HELPER)
      assert.isDefined(helper)
      assert.strictEqual(helper!.subagents, true)
      assert.notInclude(listed.defaultTools, STORY_HELPER)
      yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${provider.url}/v1` },
        model: {},
        content: `${TRIGGER} hello`,
        state: [
          { key: "agent.enabled", value: { on: true } },
          { key: "output.contract", value: "final_text" }
        ]
      })
      const bodies = completions(provider.requests())
      assert.isAbove(bodies.length, 0)
      for (const body of bodies) {
        assert.notInclude(names(body), STORY_HELPER)
        assert.notInclude(names(body), "agent")
      }
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("checks a draft with the reply's read tools, on the chat's model, within the story limits", () =>
    Effect.gen(function* () {
      const script = scripted({
        parent: [
          {
            name: STORY_HELPER,
            args: { task: "The key.", draft: "Mira hands Tobin the brass key." },
            id: "check"
          }
        ],
        // It searches as long as it may; its last request has no tools, so it reports.
        child: (done, body) =>
          body.tools?.length ? { name: "search_chat", args: { query: "key" }, id: `s${done}` } : undefined,
        report: "No contradiction found.",
        answer: "Mira hands over the key."
      })
      const provider = yield* mockProvider(script.handler)
      const elsewhere = yield* mockProvider((_request, res) => sse(res, completionChunks(["Elsewhere."], {})))
      const api = yield* client()
      // A summary model elsewhere: subagents weren't given it, so the helper never sends there.
      const other = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: settings("Elsewhere", `${elsewhere.url}/v1`)
      })
      const otherModel = yield* api.AddUserModel({ connectionId: other.id, key: "elsewhere-model", overrides: {} })
      yield* api.ChangeGenerationDefaults({
        change: { summarizer: { connection: other.id, model: otherModel.id } }
      })
      const reply = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${provider.url}/v1` },
        model: {},
        content: `${TRIGGER} the key`,
        state: toolsOn(["search_chat", "lookup_lore", "write_note", STORY_HELPER])
      })
      const bodies = completions(provider.requests())
      const parent = bodies.filter((b) => !isChild(b))
      const child = bodies.filter(isChild)
      // The reply was offered the helper, and the helper only the reply's read tools and its own.
      assert.include(names(parent[0]!), STORY_HELPER)
      assert.sameMembers(names(child[0]!), ["search_chat", "lookup_lore", "report_progress"])
      // The draft reached it as its task; the chat's own model answered every request.
      assert.include(userText(child[0]!), "Mira hands Tobin the brass key.")
      assert.include(userText(child[0]!), "What to look at especially: The key.")
      assert.lengthOf(completions(elsewhere.requests()), 0)
      // The story limits: 6 requests, the last without tools.
      assert.lengthOf(child, 6)
      assert.lengthOf(names(child.at(-1)!), 0)
      // Its report came back as the call's result, quoted as data.
      const results = toolTexts(parent.at(-1)!)
      assert.include(results[0], "No contradiction found.")
      assert.include(results[0], "helper-1")
      // The reply's step carries its row.
      const steps = reply.events
        .flatMap((e) => (e._tag === "Steps" && e.versionId === reply.version.id ? [e.steps] : []))
        .at(-1) as ReadonlyArray<RolloutStep>
      const step = steps.find((s) => s.kind === "tool" && s.id === "check")
      assert.strictEqual(step?.kind === "tool" ? step.subagent?.typeLabel : undefined, "Story helper")
      assert.strictEqual(step?.kind === "tool" ? step.subagent?.name : undefined, "draft check")
      assert.strictEqual(step?.kind === "tool" ? step.subagent?.status : undefined, "done")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("its own limits come from the story helper's, and a model's can only lower them", () =>
    Effect.gen(function* () {
      const script = scripted({
        parent: [{ name: STORY_HELPER, args: { task: "Who has the key?" }, id: "look" }],
        child: (done, body) =>
          body.tools?.length ? { name: "search_chat", args: { query: "key" }, id: `s${done}` } : undefined
      })
      const provider = yield* mockProvider(script.handler)
      const api = yield* client()
      // Raised for stories to 9, but the chat's own model may make 3: the lower holds.
      yield* api.ChangeSubagentSettings({
        limits: { requests: 50, story: { requests: 9 } },
        rows: { same: { alias: "same", note: "The model you're running on.", caps: { requests: 3 } } }
      })
      yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${provider.url}/v1` },
        model: {},
        content: `${TRIGGER} who`,
        state: toolsOn(["search_chat", STORY_HELPER])
      })
      const child = completions(provider.requests()).filter(isChild)
      assert.lengthOf(child, 3)
      assert.include(userText(child[0]!), "Who has the key?")
      const settings = yield* api.GetSubagentSettings({})
      assert.deepStrictEqual(settings.limits.story, { requests: 9 })
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )
})
