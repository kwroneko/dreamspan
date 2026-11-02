import { AppClient } from "../../rpc.ts"

/** The account's global regex scripts; SetGlobalRegex invalidates `globalRegex`. */
export const globalRegexAtom = AppClient.query("GetGlobalRegex", undefined, {
  reactivityKeys: ["globalRegex"],
  // Keep a speculative React render's read until the suspended tree commits.
  timeToLive: "400 millis"
})
