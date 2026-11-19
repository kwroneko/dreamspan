import { Cause } from "effect"
import { expect, it } from "vitest"
import { PluginRejected } from "@dreamspan/shared/plugins.ts"
import { describeCause } from "../src/errors.ts"
it("shows the host's fixed plugin refusal instead of an unknown error", () => {
  expect(
    describeCause(Cause.fail(new PluginRejected({ message: "Plugins changed elsewhere. Review this version again." })))
  ).toMatchObject({ tag: "PluginRejected", message: "Plugins changed elsewhere. Review this version again." })
})
