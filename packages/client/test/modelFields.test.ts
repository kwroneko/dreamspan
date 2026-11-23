// The model form's fields by name (modelmassedit1): which fields an edit touched, what many
// models share, a copy's fields, and the patches Edit N… saves, within each model's limits.
import type { Model, ModelId } from "@dreamspan/shared/providers.ts"
import { expect, it } from "vitest"
import { commonOf, copyFields, fieldsChanged, fieldsSet, massPatches } from "../src/features/connections/modelFields.ts"
import { draftOf } from "../src/features/connections/modelForm.ts"

const model = (id: string, overrides: Model["overrides"]) => ({ id: id as ModelId, overrides }) as unknown as Model

it("an edit ticks the fields it touched, typed text included", () => {
  const before = draftOf({}, 0)
  expect(fieldsChanged(before, { ...before, settings: { samplers: { temperature: 0.5 } }, reasoning: "no" })).toEqual([
    "reasoning",
    "temperature"
  ])
  expect(fieldsChanged(before, { ...before, drafts: { "overrides.maxImages": "x" } })).toEqual(["maxImages"])
  expect(fieldsChanged(before, { ...before, context: "abc" })).toEqual(["context"])
  expect(fieldsChanged(before, { ...before, rows: { "settings.routing": [{ name: "sort", value: "" }] } })).toEqual([
    "routing"
  ])
})

it("what many models share, and how they differ", () => {
  const { draft, mixed } = commonOf([
    model("a", { vision: true, settings: { samplers: { temperature: 0.2 } } }),
    model("b", { vision: true }),
    model("c", { vision: true })
  ])
  expect(draft.vision).toBe("yes")
  expect(draft.settings).toEqual({})
  expect(mixed.temperature).toBe("Differs: not set on 2, 0.2 on 1.")
  expect(mixed.vision).toBeUndefined()
})

it("a copy fills and names every field the source sets", () => {
  const source = { reasoning: false, settings: { samplers: { temperature: 0.4 }, stop: ["END"] }, name: "Source" }
  const fields = fieldsSet(source)
  expect(fields).toEqual(["reasoning", "stop", "temperature"])
  const copied = copyFields(draftOf({}, 0), source, fields)
  expect(copied.reasoning).toBe("no")
  expect(copied.settings).toEqual({ samplers: { temperature: 0.4 }, stop: ["END"] })
  expect(copied.name).toBe("")
})

it("patches carry only the ticked paths, each model within its limits", () => {
  const values = {
    ...draftOf({}, 0),
    settings: { samplers: { temperature: 0.7, top_p: 0.5, openai_max_context: 64_000, openai_max_tokens: 9000 } }
  }
  const patches = massPatches(
    values,
    ["temperature", "openai_max_context", "openai_max_tokens"],
    [
      { id: "small" as ModelId, limits: { context: 32_000, maxOutput: 4000 } },
      { id: "big" as ModelId, limits: { context: 200_000, maxOutput: 16_000 } },
      { id: "big2" as ModelId, limits: { context: 200_000, maxOutput: 16_000 } }
    ]
  )
  expect(patches).toEqual([
    {
      modelIds: ["small"],
      paths: [
        ["settings", "samplers", "temperature"],
        ["settings", "samplers", "openai_max_context"],
        ["settings", "samplers", "openai_max_tokens"]
      ],
      values: { settings: { samplers: { temperature: 0.7, openai_max_tokens: 4000 } } }
    },
    {
      modelIds: ["big", "big2"],
      paths: [
        ["settings", "samplers", "temperature"],
        ["settings", "samplers", "openai_max_context"],
        ["settings", "samplers", "openai_max_tokens"]
      ],
      values: { settings: { samplers: { temperature: 0.7, openai_max_context: 64_000, openai_max_tokens: 9000 } } }
    }
  ])
})
