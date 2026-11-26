// What a workshop's assistant may look at, a library class at a time (spec/WORKSHOP-CARDS.md
// §2.1–§2.5). An item in view (attached on the reply's path, made by it, the workshop's own cast,
// a story's cast and books beside it) is read and changed without asking. Anything else asks its
// class once per reply, inside the call's step, with the four scopes: Allow (this reply), Allow
// in this chat, Allow always for the workshop's assistant card, Allow always. Off refuses.
//
// The first use of a class asks the user. The user chooses the scope of that grant.
import type { ApprovalPrompt } from "@dreamspan/shared/agent.ts"
import type { ChatId, ForkId, SlotId } from "@dreamspan/shared/chat.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { foldState } from "@dreamspan/shared/state.ts"
import { Deferred, Effect, Exit } from "effect"
import type { LibrarySightPosition } from "../db/ops.ts"
import { askUser, type PermitDeps } from "./approvals.ts"
import { libraryClassMode, type LibraryClass } from "./capabilities.ts"
import type { ToolContext } from "./tools.ts"

export interface LibrarySight {
  /** The reply's positioned view, also used to verify a write in the database worker. */
  readonly position?: Effect.Effect<LibrarySightPosition, unknown>
  /** Whether this entity is in view for the reply now (its own creations so far included). */
  readonly inView: (entityId: string) => Effect.Effect<boolean>
  /**
   * The class's standing for this call, asking the user first where it says so; `line` says what
   * the call does ("search your characters and personas for “lighthouse”"). Use `current` to
   * recheck consent without opening a new question.
   */
  readonly gate: (capability: LibraryClass, line: string, mode?: "current") => Effect.Effect<Decision>
}

type Decision = { readonly ok: true } | { readonly ok: false; readonly text: string }

/** One displayed question for a class across the reply and its subagents. */
const questions = new Map<string, Deferred.Deferred<Decision | null>>()

/** Made with a run's permit deps; each call gets its own, showing its question on its own step. */
export type LibrarySightFor = (context: ToolContext, onWaiting: (prompt: ApprovalPrompt | null) => void) => LibrarySight

const declinedText = (noun: string, note: string | null) =>
  `The user declined letting you look through their ${noun}. Ask them to attach the ones they want you to work on.${note ? ` Their note: ${note}` : ""}`

/**
 * What the branch's state puts in view (§2.1 points 1 and 4): the workshop's cast (its assistant
 * card and persona) at the reply's position, and beside a story, that story's cast and its books
 * (the chat's and its cards' own) at the position the reply reads. Once per run.
 */
const fixedView = (context: ToolContext) =>
  Effect.gen(function* () {
    const key = "library-sight:fixed"
    const known = context.cache.get(key) as
      | { readonly entities: ReadonlyArray<string>; readonly refs: ReadonlyArray<string>; readonly card: string | null }
      | undefined
    if (known) return known
    const own = foldState(
      yield* context.reader.StateEventsAt({
        userId: context.userId,
        chatId: context.chatId,
        slotId: context.leafSlotId,
        forkId: context.forkId
      })
    )
    const story = context.storyAt
      ? foldState(
          yield* context.reader.StateEventsAt({
            userId: context.userId,
            chatId: context.storyAt.chatId as ChatId,
            slotId: context.storyAt.leafSlotId as SlotId | null,
            forkId: context.storyAt.forkId as ForkId
          })
        )
      : null
    const storyCast = story ? [...story.participants, ...story.playedByMe] : []
    const fixed = {
      entities: [...own.participants, ...own.playedByMe, ...storyCast],
      refs: story
        ? [
            ...story.lorebooks,
            ...story.listedLorebooks.map((book) => book.ref),
            ...storyCast.map((id) => story.lorebookBindings[id]).filter((ref): ref is string => typeof ref === "string")
          ]
        : [],
      // The workshop's assistant: its cast member who isn't the user's persona (§2.4 [character]).
      card: own.participants.find((id) => !own.playedByMe.includes(id)) ?? null
    }
    context.cache.set(key, fixed)
    return fixed
  })

export const makeLibrarySight =
  (deps: PermitDeps): LibrarySightFor =>
  (context, onWaiting) => {
    const position = fixedView(context).pipe(
      Effect.map((fixed): LibrarySightPosition => ({
        forkId: context.forkId,
        leafSlotId: context.leafSlotId,
        ...fixed
      }))
    )
    const access = Effect.flatMap(position, (at) =>
      context.reader.LibraryAccess({
        userId: deps.userId as UserId,
        chatId: deps.chatId as ChatId,
        rolloutId: deps.rolloutId,
        ...at
      })
    )
    return {
      position,
      inView: (entityId) =>
        access.pipe(
          Effect.map((found) => found.inView.includes(entityId)),
          Effect.orElseSucceed(() => false)
        ),
      gate: (capability, line, mode) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const entry = deps.registries.workshopCapabilities.get(capability)
            const noun = entry?.scoped?.noun ?? "library"
            const label = entry?.label ?? capability
            const decide = (found: Effect.Success<typeof access>): Decision | null => {
              const mode = libraryClassMode(deps.registries, found, capability)
              if (mode === "off")
                return {
                  ok: false,
                  text: `“${label}” is turned off in this workshop, so this wasn't done. Ask the user to attach what you need, or to turn it on.`
                }
              if (mode === "allow") return { ok: true }
              const declined = found.replyDeclined.find((answer) => answer.capability === capability)
              return declined ? { ok: false, text: declinedText(noun, declined.note) } : null
            }
            let found = yield* restore(access)
            const key = `${found.replyId}:${capability}`
            while (true) {
              const decided = decide(found)
              if (decided) return decided
              if (mode === "current") return { ok: false, text: `“${label}” needs a current approval. Try again.` }
              const pending = questions.get(key)
              if (pending) {
                const answered = yield* restore(Deferred.await(pending))
                found = yield* restore(access)
                const fresh = decide(found)
                if (fresh) return fresh
                if (answered) return answered
                continue
              }
              const answer = Deferred.makeUnsafe<Decision | null>()
              questions.set(key, answer)
              return yield* restore(
                Effect.gen(function* () {
                  // Another call may have settled between our read and taking over this key.
                  const fresh = yield* access
                  const settled = decide(fresh)
                  if (settled) return settled
                  const asked = yield* askUser(deps, {
                    toolCallId: context.toolCallId,
                    capability,
                    key: `class:${capability}`,
                    onWaiting,
                    prompt: {
                      capabilityLabel: label,
                      title: entry?.scoped?.title ?? label,
                      rows: [],
                      uncertain: false,
                      scoped: { line, ...(fresh.card ? { card: fresh.card } : {}) }
                    }
                  })
                  return (
                    decide(yield* access) ??
                    (asked.allow
                      ? ({ ok: true } as const)
                      : ({ ok: false, text: declinedText(noun, asked.note) } as const))
                  )
                })
              ).pipe(
                Effect.onExit((exit) =>
                  Effect.sync(() => {
                    questions.delete(key)
                    Deferred.doneUnsafe(answer, Effect.succeed(Exit.isSuccess(exit) ? exit.value : null))
                  })
                )
              )
            }
          })
        ).pipe(
          Effect.catch(() =>
            Effect.succeed({ ok: false, text: "The app couldn't check whether this is allowed. Try again." } as const)
          )
        )
    }
  }
