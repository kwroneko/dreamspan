import { Schema } from "effect"
import { expect, it } from "vitest"
import { uuidv7 } from "../src/id.ts"
import { applyModelPatch, ModelPatches } from "../src/modelPatch.ts"

it("accepts patches to whole editable fields and rejects descendants of lists and maps", () => {
  const modelIds = [uuidv7()]
  const values = { settings: { samplers: { temperature: 0.5 } } }
  const valid = Schema.is(ModelPatches)
  for (const path of [
    ["settings", "stop", "0"],
    ["compat", "constructor"],
    ["learned", "context"],
    ["settings", "routing", "only"],
    ["settings"],
    ["settings", "not-a-setting"]
  ]) {
    expect(valid([{ modelIds, paths: [path, ["settings", "samplers", "temperature"]], values }]), path.join(".")).toBe(
      false
    )
  }

  const [patch] = Schema.decodeUnknownSync(ModelPatches)([
    {
      modelIds,
      paths: [
        ["settings", "stop"],
        ["settings", "samplers", "temperature"]
      ],
      values
    }
  ])
  const before = { settings: { stop: ["A", "B"], samplers: { temperature: 0.7 } } }
  const { next, previous } = applyModelPatch(before, patch!.paths, patch!.values)
  expect(next).toEqual(values)
  expect(previous).not.toBeNull()
  expect(applyModelPatch(next, previous!.paths, previous!.values).next).toEqual(before)
})
