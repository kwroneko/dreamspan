import { lazy, Suspense } from "react"
import { cardContributions, type CardMenuProps, type CardSurfaceContext } from "./surfaces.tsx"

const Command = lazy(() => import("./surfacesImpl.tsx").then((m) => ({ default: m.ForkCommand })))
const MenuEntry = lazy(() => import("./surfacesImpl.tsx").then((m) => ({ default: m.ForkMenuItem })))
const MenuDialog = lazy(() => import("./surfacesImpl.tsx").then((m) => ({ default: m.ForkMenuDialog })))
const Provenance = lazy(() => import("./surfacesImpl.tsx").then((m) => ({ default: m.Provenance })))
const ForkBadge = lazy(() => import("./surfacesImpl.tsx").then((m) => ({ default: m.ForkBadge })))
const FamilySection = lazy(() => import("./surfacesImpl.tsx").then((m) => ({ default: m.FamilySection })))
export const register = () => {
  const disposers = []
  for (const [order, command] of (["fork", "family", "compare", "parent", "unlink"] as const).entries())
    disposers.push(
      cardContributions.register({
        id: `card-forks.${command}`,
        placement: "actions",
        overflow: command !== "fork",
        order: 100 + order,
        component: (props: CardSurfaceContext) => (
          <Suspense fallback={null}>
            <Command {...props} command={command} />
          </Suspense>
        ),
        menu: (props: CardMenuProps) => (
          <Suspense fallback={null}>
            <MenuEntry {...props} command={command} />
          </Suspense>
        ),
        dialog: (props: CardMenuProps) => (
          <Suspense fallback={null}>
            <MenuDialog {...props} command={command} />
          </Suspense>
        )
      })
    )
  for (const [placement, Component] of [
    ["family", FamilySection],
    ["provenance", Provenance],
    ["badge", ForkBadge]
  ] as const)
    disposers.push(
      cardContributions.register({
        id: `card-forks.${placement}-surface`,
        placement,
        order: 100,
        component: (props: CardSurfaceContext) => (
          <Suspense fallback={null}>
            <Component {...props} />
          </Suspense>
        )
      })
    )
  return disposers
}
