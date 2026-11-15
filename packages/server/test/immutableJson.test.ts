import { RpcSerialization } from "effect/rpc"
import { AppApi } from "@rp/shared/api.ts"
import { ShellLibrary } from "@rp/shared/chatSetupApi.ts"
import { TransportApi, transportJson } from "@rp/shared/transportApi.ts"
import { describe, it, assert } from "@effect/vitest"
import { Schema } from "effect"
import { immutableJson } from "@rp/shared/immutableJson.ts"

class ReadModel extends Schema.Class<ReadModel>("ImmutableReadModelTest")({
  rows: Schema.Array(Schema.Struct({ name: Schema.String }))
}) {}

describe("immutable read-model JSON", () => {
  it("validates once per instance and retains identical encoded bytes", () => {
    const codec = Schema.toCodecJson(immutableJson(ReadModel))
    const encode = Schema.encodeUnknownSync(codec)
    const model = new ReadModel({ rows: [{ name: "Synthetic row" }] })
    const json = encode(model)
    assert.strictEqual(encode(model), json)
    assert.strictEqual(JSON.stringify(json), JSON.stringify(Schema.encodeSync(Schema.toCodecJson(ReadModel))(model)))
    assert.isTrue(Object.isFrozen(model))
    assert.isTrue(Object.isFrozen(model.rows))
    assert.isTrue(Object.isFrozen(model.rows[0]))
    assert.throws(() => Object.assign(model.rows[0]!, { name: "Changed" }))
    assert.notStrictEqual(encode(new ReadModel({ rows: [{ name: "New epoch" }] })), json)
  })

  it("retains full validation for untrusted responses and invalid new instances", () => {
    const codec = Schema.toCodecJson(immutableJson(ReadModel))
    const decode = Schema.decodeUnknownSync(codec)
    const encode = Schema.encodeUnknownSync(codec)
    assert.throws(() => decode({ rows: [{ name: 42 }] }))
    assert.throws(() => encode(new ReadModel({ rows: [{ name: 42 as never }] }, { disableChecks: true })))
    const first = decode({ rows: [{ name: "Synthetic" }] })
    const second = decode({ rows: [{ name: "Synthetic" }] })
    assert.instanceOf(first, ReadModel)
    assert.isTrue(Object.isFrozen(first.rows))
    assert.strictEqual(first, second)
    assert.deepStrictEqual(first, second)
    assert.throws(() => decode({ rows: [{ name: 42 }] }))
    assert.deepStrictEqual(decode({ rows: [{ name: "Changed" }] }).rows, [{ name: "Changed" }])
    let name: unknown = "Synthetic"
    const accessor = {
      rows: [
        {
          get name() {
            return name
          }
        }
      ]
    }
    assert.strictEqual(decode(accessor).rows[0]!.name, "Synthetic")
    name = 42
    assert.throws(() => decode(accessor))
  })
})

it("does not confuse non-JSON numbers with validated nulls", () => {
  class Nullable extends Schema.Class<Nullable>("ImmutableNullableTest")({ value: Schema.NullOr(Schema.Int) }) {}
  const decode = Schema.decodeUnknownSync(Schema.toCodecJson(immutableJson(Nullable)))
  assert.isNull(decode({ value: null }).value)
  assert.throws(() => decode({ value: Number.POSITIVE_INFINITY }))
  assert.throws(() => decode({ value: Number.NaN }))
  assert.throws(() => decode({ value: undefined }))
})

it("preserves public RPC definitions, payload schemas and authentication", () => {
  assert.strictEqual(AppApi.requests.get("GetShellLibrary")!.successSchema, ShellLibrary)
  assert.strictEqual(TransportApi.requests.size, AppApi.requests.size)
  for (const [tag, original] of AppApi.requests) {
    const transport = TransportApi.requests.get(tag)!
    if (tag !== "GetShellLibrary") assert.isTrue(transport === original)
    assert.strictEqual(transport.payloadSchema, original.payloadSchema)
    assert.deepStrictEqual(transport.middlewares, original.middlewares)
    assert.strictEqual(transport.annotations, original.annotations)
  }
})

it("reuses parsed network data without confusing overflow with null or changing request bytes", () => {
  class Nullable extends Schema.Class<Nullable>("ImmutableWireNullableTest")({ value: Schema.NullOr(Schema.Int) }) {}
  const codec = Schema.toCodecJson(immutableJson(Nullable)),
    decode = Schema.decodeUnknownSync(codec)
  const parser = transportJson.makeUnsafe()
  const wire = (value: string) =>
    (
      parser.decode(`{"_tag":"Exit","requestId":"1","exit":{"_tag":"Success","value":{"value":${value}}}}`)[0] as {
        exit: { value: unknown }
      }
    ).exit.value
  const request = { _tag: "Request", id: "1", tag: "GetShellLibrary", payload: {}, headers: [] }
  assert.strictEqual(parser.encode(request), RpcSerialization.json.makeUnsafe().encode(request))
  const first = decode(wire("null"))
  assert.strictEqual(decode(wire("null")), first)
  assert.throws(() => decode(wire("1e400")))
  assert.throws(() => decode(wire('"invalid"')))
  assert.strictEqual(decode(wire("7")).value, 7)
  assert.strictEqual(decode(wire("0")).value, 0)
  assert.isTrue(Object.is(decode(wire("-0")).value, -0))
})
