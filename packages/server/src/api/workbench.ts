// The center column's saved layout (@rp/shared/workbenchApi.ts).
import { CurrentUser } from "@rp/shared/api.ts"
import type { WorkbenchApi } from "@rp/shared/workbenchApi.ts"
import { Effect } from "effect"
import { Reader, Writer } from "../db/Database.ts"
import { internal } from "./internal.ts"

const isJsonObject = (text: string) => {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === "object" && value !== null && !Array.isArray(value)
  } catch {
    return false
  }
}

export const makeWorkbenchHandlers = Effect.gen(function* () {
  const reader = yield* Reader
  const writer = yield* Writer
  const userId = Effect.map(CurrentUser, (user) => user.id)
  return {
    GetWorkbenchLayout: ({ device }) =>
      Effect.flatMap(userId, (id) => reader.GetWorkbenchLayout({ userId: id, device })).pipe(
        internal("GetWorkbenchLayout")
      ),
    // Only an object is kept: anything else is dropped, not stored.
    SetWorkbenchLayout: ({ device, layout }) =>
      Effect.flatMap(userId, (id) =>
        isJsonObject(layout) ? writer.SetWorkbenchLayout({ userId: id, device, layout }) : Effect.void
      ).pipe(internal("SetWorkbenchLayout")),
    ForgetWorkbenchLayouts: () =>
      Effect.flatMap(userId, (id) => writer.ForgetWorkbenchLayouts({ userId: id })).pipe(
        internal("ForgetWorkbenchLayouts")
      )
  } satisfies Parameters<typeof WorkbenchApi.of>[0]
})
