import { expect, it, vi } from "vitest"
import { emptySourceQuery } from "@dreamspan/shared/cardSources.ts"
import type { SourceBrowse } from "../src/features/cardSources/browse.tsx"
import { hideCreator, showCreator } from "../src/features/cardSources/creator.tsx"

it("creator navigation retains site identity and can be reversed with browser history", () => {
  const change = vi.fn()
  const browse = {
    caps: { creators: { filterId: "author", excludeFilterId: "not_author", profiles: true } },
    remote: { ...emptySourceQuery, filters: { not_author: "chub/other" } },
    change
  } as unknown as SourceBrowse
  showCreator(browse, "risuai/shared-name")
  expect(change).toHaveBeenLastCalledWith(
    { filters: { not_author: "chub/other", author: "risuai/shared-name" } },
    { replace: false }
  )
  hideCreator(
    {
      ...browse,
      remote: { ...browse.remote, filters: { author: "risuai/shared-name", not_author: "chub/shared-name" } }
    },
    "risuai/shared-name"
  )
  expect(change).toHaveBeenLastCalledWith(
    { filters: { not_author: "chub/shared-name,risuai/shared-name" } },
    { replace: false }
  )
})
