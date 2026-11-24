import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it } from "vitest"
import { FeedRoutes } from "../src/features/connections/models.tsx"
import { TooltipProvider } from "../src/ui/Tooltip.tsx"

it("uses the currency of the route price on the model page", () => {
  const feed = {
    fetchedAt: 1,
    currency: "EUR",
    price: { input: 1, output: 2, currency: "EUR" },
    routes: [{ target: "fast", price: { input: 3, output: 15, currency: "EUR" } }]
  }
  const html = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(FeedRoutes, { feed })))
  expect(html).toContain("fast 3.00 EUR / 15.00 EUR")
})
