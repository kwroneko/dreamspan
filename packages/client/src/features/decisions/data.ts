// The decision points registered on the server and the user's settings for them, read once and
// shared by the connection's Decisions card, the composer and this chat's Decisions setting.
import { AppClient } from "../../rpc.ts"

export const pointsAtom = AppClient.query("ListDecisionPoints", undefined, { timeToLive: "5 minutes" })
export const settingsAtom = AppClient.query("GetDecisionSettings", undefined, { reactivityKeys: ["decisions"] })
