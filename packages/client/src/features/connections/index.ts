import { routes } from "../../routes.tsx"
import {
  connectionSections,
  ConnectionPage,
  DeleteSection,
  HeadersSection,
  KeySection,
  RouteSection,
  SettingsSection,
  TestSection
} from "./detail.tsx"
import { DefaultModelSection } from "./defaultModel.tsx"
import { ConnectionsPage, NewConnectionPage } from "./list.tsx"
import { ModelsSection } from "./models.tsx"

export const register = () => {
  routes.register({
    id: "settings.connections",
    parent: "settings",
    path: "connections",
    component: ConnectionsPage,
    nav: { label: "Connections", order: 10 }
  })
  routes.register({
    id: "settings.connections.new",
    parent: "settings",
    path: "connections/new",
    component: NewConnectionPage
  })
  routes.register({
    id: "settings.connection",
    parent: "settings",
    path: "connections/$connectionId",
    component: ConnectionPage
  })
  // Which model new chats use; a new connection fetches its models here at once.
  connectionSections.register({ id: "default-model", order: 5, component: DefaultModelSection })
  connectionSections.register({ id: "settings", order: 10, component: SettingsSection })
  connectionSections.register({ id: "key", order: 20, component: KeySection })
  connectionSections.register({ id: "test", order: 30, component: TestSection })
  connectionSections.register({ id: "models", order: 40, component: ModelsSection })
  connectionSections.register({ id: "headers", order: 50, component: HeadersSection })
  connectionSections.register({ id: "route", order: 60, component: RouteSection })
  connectionSections.register({ id: "delete", order: 100, component: DeleteSection })
}
