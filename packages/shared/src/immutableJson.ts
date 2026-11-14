// Immutable read models retain their validated encoding and the last decoded
// value. Only exactly equal data may reuse it; changed data uses the full codec.
import { Effect, Schema, SchemaTransformation } from "effect"

// Only data properties can be retained: freezing an accessor or Date does not
// freeze the value its getter/internal slots may produce later.
const freeze = (value: unknown, seen = new WeakSet<object>()): boolean => {
  if (typeof value === "function") return false
  if (typeof value !== "object" || value === null) return true
  if (seen.has(value)) return true
  if (!Array.isArray(value) && Object.prototype.toString.call(value) !== "[object Object]") return false
  seen.add(value)
  let data = true
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key)!
    if (!("value" in property) || !freeze(property.value, seen)) data = false
  }
  Object.freeze(value)
  return data
}

// Only the JSON transport may mark an input: parsed network data has no
// accessors, proxies, methods or cycles. Direct codec callers use strict equality.
const parsed = new WeakSet<object>()
export const markParsedJson = (value: unknown): void => {
  if (typeof value === "object" && value !== null) parsed.add(value)
}
const fingerprint = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null || !parsed.has(value)) return undefined
  try {
    return JSON.stringify(value, (_, field: unknown) => {
      // JSON.parse accepts overflow such as 1e400. Never collapse it to null.
      if (typeof field === "number" && (!Number.isFinite(field) || Object.is(field, -0)))
        throw new Error("Non-canonical JSON number")
      return field
    })
  } catch {
    return undefined
  }
}

export const immutableJson = <A extends object, I>(schema: Schema.Codec<A, I>) => {
  const codec = Schema.toCodecJson(schema)
  const decode = Schema.decodeUnknownEffect(codec)
  const encode = Schema.encodeUnknownEffect(codec)
  const encoded = new WeakMap<A, unknown>()
  let previous: { readonly input: unknown; readonly value: A; readonly key: string | undefined } | undefined
  const valid = new WeakMap<object, A>()
  const rawDecode = Schema.decodeUnknownEffect(schema)
  const descriptions = new WeakMap<
    object,
    {
      readonly prototype: unknown
      readonly keys: ReadonlyArray<PropertyKey>
      readonly values: ReadonlyArray<unknown>
    }
  >()
  const description = (value: object) => {
    const known = descriptions.get(value)
    if (known) return known
    const keys = Reflect.ownKeys(value)
    const values: unknown[] = []
    for (const key of keys) {
      const property = Object.getOwnPropertyDescriptor(value, key)!
      if (!("value" in property)) return undefined
      values.push(property.value)
    }
    const result = { prototype: Object.getPrototypeOf(value), keys, values }
    descriptions.set(value, result)
    return result
  }
  // Equality only recognizes plain data properties. Accessors, exotic objects,
  // cycles, different types and different key sets must take the full decoder.
  const equal = (a: unknown, b: unknown, seen = new WeakSet<object>()): boolean => {
    if (Object.is(a, b)) return true
    if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return false
    const prototype = Object.getPrototypeOf(a)
    if ((prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) || seen.has(a))
      return false
    const previous = description(b)
    if (!previous || prototype !== previous.prototype || Reflect.ownKeys(a).length !== previous.keys.length)
      return false
    seen.add(a)
    for (let i = 0; i < previous.keys.length; i++) {
      const property = Object.getOwnPropertyDescriptor(a, previous.keys[i]!)
      if (!property || !("value" in property) || !equal(property.value, previous.values[i], seen)) return false
    }
    return true
  }
  const wire = Schema.declare<unknown>((_): _ is unknown => true, { toCodecJson: () => undefined })
  return Schema.declareConstructor<A, I>()(
    [],
    () => (input, _ast, options) => {
      if (typeof input === "object" && input !== null) {
        const known = valid.get(input)
        if (known) return Effect.succeed(known)
      }
      return rawDecode(input, options).pipe(
        Effect.mapError((error) => error.issue),
        Effect.tap((value) =>
          Effect.sync(() => {
            const data = freeze(value)
            if (data) valid.set(value, value)
            if (freeze(input) && data && typeof input === "object" && input !== null) valid.set(input, value)
          })
        )
      )
    },
    {
      toCodecJson: () =>
        Schema.link<A>()(
          wire,
          SchemaTransformation.transformEffect({
            decode: (input, options) => {
              const key = fingerprint(input)
              if (previous && (key !== undefined ? key === previous.key : equal(input, previous.input)))
                return Effect.succeed(previous.value)
              return decode(input, options).pipe(
                Effect.mapError((error) => error.issue),
                Effect.tap((value) =>
                  Effect.sync(() => {
                    const data = freeze(value)
                    if (data) valid.set(value, value)
                    if (freeze(input) && data) previous = { input, value, key }
                  })
                )
              )
            },
            encode: (value, options) =>
              Effect.suspend(() => {
                if (encoded.has(value)) return Effect.succeed(encoded.get(value))
                return encode(value, options).pipe(
                  Effect.mapError((error) => error.issue),
                  Effect.tap((json) =>
                    Effect.sync(() => {
                      if (freeze(value) && freeze(json)) encoded.set(value, json)
                    })
                  )
                )
              })
          })
        )
    }
  )
}
