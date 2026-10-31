// What a reply shows while it streams (ARCHITECTURE §12, "Live rewrites"): its texts so far
// through the scripts its finish runs, as ST's streaming runs them on the text so far at every
// update. An entry of `ExecutionRegistry.liveRewrites`; Generations takes them in order and
// shows the texts as they are when none is registered or none can change anything.
import type { TextRewrite } from "@rp/shared/regexScripts.ts"
import { type Context, Effect } from "effect"
import type { Reader } from "../db/Database.ts"
import type { GenerationRequest } from "./Generator.ts"
import type { rewriteItems } from "./rewrites.ts"

type LiveItems = ReturnType<typeof rewriteItems>

export interface LiveRewrite {
  readonly id: string
  /**
   * The texts of a generating reply so far (`rewriteItems`: body, reasoning, each section)
   * as they're shown, item for item, and how long the rewriting itself took (`ms`, not
   * counting the way there and back). `null`: this rewrite never changes this reply's text,
   * so its later texts needn't come here. A failure leaves what's shown as it was, and the
   * next change tries again.
   */
  readonly rewrite: (
    services: { readonly reader: Context.Service.Shape<typeof Reader> },
    request: GenerationRequest,
    items: LiveItems
  ) => Effect.Effect<{ readonly texts: ReadonlyArray<TextRewrite>; readonly ms: number } | null, unknown>
}

/** The built-in: the reader worker's prepared rewrite for the version (`RewriteLive`). */
export const regexLiveRewrite: LiveRewrite = {
  id: "live.regex",
  rewrite: ({ reader }, request, items) =>
    Effect.suspend(() =>
      reader.RewriteLive({
        userId: request.userId,
        chatId: request.chatId,
        ...(request.forkId === undefined ? {} : { forkId: request.forkId }),
        slotId: request.slotId,
        versionId: request.versionId,
        items
      })
    ).pipe(Effect.map(({ active, texts, ms }) => (active ? { texts, ms } : null)))
}
