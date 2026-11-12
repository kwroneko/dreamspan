// What a surface adds to every request that starts a reply (Send, Generate, Regenerate, Continue,
// Resume, carrying on from a step). A side chat beside a story sends where the story is shown in
// its own browser tab (`storyAt`, spec/WORKSHOP.md §4), read at the moment of each request, so
// two tabs on two branches each send their own. Surfaces set it on their ChatSession, and give it
// to the steps' controls through `ReplyExtrasContext`.
import type { StoryAt } from "@rp/shared/chat.ts"
import { createContext } from "react"

export interface ReplyExtras {
  readonly storyAt?: StoryAt
}

export type ReplyExtrasSource = () => ReplyExtras

export const noReplyExtras: ReplyExtrasSource = () => ({})

/** The surface's extras for the reply requests made inside it; none by default. */
export const ReplyExtrasContext = createContext<ReplyExtrasSource>(noReplyExtras)
