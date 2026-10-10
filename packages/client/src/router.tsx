import { createRootRoute, createRoute, createRouter, Link, Outlet } from "@tanstack/react-router"
import { Home } from "./routes/Home.tsx"

const rootRoute = createRootRoute({
  component: () => <Outlet />,
  notFoundComponent: () => (
    <main className="p-6">
      <p className="text-muted">Nothing here.</p>
      <Link to="/" className="text-accent">
        Back home
      </Link>
    </main>
  )
})

const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: Home })

export const router = createRouter({ routeTree: rootRoute.addChildren([indexRoute]) })

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}
