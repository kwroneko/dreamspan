import { Effect, Option, Result, Schema } from "effect"
import type { Generation } from "../assembler/types.ts"
import type { ProviderEvent } from "../providers/Providers.ts"
import { REPLY_TOOL } from "../assembler/prefill.ts"
import { GenerationFailed, type GenerationChunk, type GenerationRequest } from "./Generator.ts"

export interface ReplyOutputStrategy {
  readonly id: string
  /** A fresh decoder for each generation; prefix state never crosses requests. */
  readonly create: (input: {
    readonly prefix: string | null
    readonly request: GenerationRequest
    readonly generation: Generation
    readonly rolloutId: string
  }) => {
    readonly replyTool?: string
    readonly decode: (event: ProviderEvent) => Effect.Effect<Result.Result<GenerationChunk, void>, GenerationFailed>
  }
}

export const defaultReplyOutput: ReplyOutputStrategy = {
  id: "reply",
  create: ({ prefix }) => {
    let emitted = ""
    const decodeReply = Schema.decodeUnknownOption(Schema.Struct({ text: Schema.String }))
    const suffix = (args: unknown, final: boolean): Effect.Effect<string, GenerationFailed> => {
      const decoded = decodeReply(args)
      const text = Option.isSome(decoded) ? decoded.value.text : null
      if (text === null || !text.startsWith(prefix!)) {
        return final
          ? Effect.fail(
              new GenerationFailed({
                class: "bad_prefill",
                message: "The provider did not return the required reply prefix."
              })
            )
          : Effect.succeed("")
      }
      const next = text.slice(prefix!.length)
      if (!next.startsWith(emitted))
        return Effect.fail(
          new GenerationFailed({ class: "bad_prefill", message: "The provider changed text already streamed." })
        )
      const delta = next.slice(emitted.length)
      emitted = next
      return Effect.succeed(delta)
    }

    return {
      ...(prefix !== null ? { replyTool: REPLY_TOOL } : {}),
      decode: (event) => {
        if (event.type === "thinking")
          return Effect.succeed(Result.succeed<GenerationChunk>({ reasoning: event.delta }))
        if (prefix !== null) {
          if (event.type === "toolcall" && event.name === REPLY_TOOL)
            return suffix(event.arguments, false).pipe(
              Effect.map((delta) => (delta ? Result.succeed<GenerationChunk>(delta) : Result.failVoid))
            )
          if (event.type === "done") {
            const calls = event.message.content.filter((block) => block.type === "toolCall")
            if (calls.length !== 1 || calls[0]!.name !== REPLY_TOOL)
              return Effect.fail(
                new GenerationFailed({
                  class: "bad_prefill",
                  message: "The provider did not return the required reply tool."
                })
              )
            let args: unknown
            try {
              args = JSON.parse(event.toolArguments[calls[0]!.id] ?? "")
            } catch {
              return Effect.fail(
                new GenerationFailed({
                  class: "bad_prefill",
                  message: "The provider returned malformed reply tool JSON."
                })
              )
            }
            return suffix(args, true).pipe(
              Effect.map((delta) => (delta ? Result.succeed<GenerationChunk>(delta) : Result.failVoid))
            )
          }
          return Effect.succeed(Result.failVoid)
        }
        return Effect.succeed(event.type === "text" ? Result.succeed<GenerationChunk>(event.delta) : Result.failVoid)
      }
    }
  }
}
