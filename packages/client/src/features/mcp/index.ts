// MCP servers (spec/MCP.md §13.1): Settings → Tools → MCP servers, and each server's page.
import { routes } from "../../routes.tsx"
import { settingsGroups } from "../settings/groups.ts"
import {
  CallsSection,
  DeleteSection,
  LoadingSection,
  McpServerPage,
  mcpSections,
  RouteSection,
  ServerSection,
  SignInSection,
  ToolsSection,
  ProgramOutputSection,
  UsesSection
} from "./detail.tsx"
import { McpServersPage, NewMcpServerPage } from "./list.tsx"
import { SharingSection } from "./sharing.tsx"
import { McpSignInCallbackPage } from "./signIn.tsx"
import { MCP_OAUTH_CALLBACK } from "@dreamspan/shared/mcp.ts"

export const register = () => {
  settingsGroups.register({ id: "tools", label: "Tools", order: 15, pages: ["settings.mcp"] })
  routes.register({
    id: "settings.mcp",
    parent: "settings",
    path: "mcp",
    component: McpServersPage,
    nav: { label: "MCP servers", order: 10, description: "Programs and services whose tools the model can use." }
  })
  routes.register({ id: "settings.mcp.new", parent: "settings", path: "mcp/new", component: NewMcpServerPage })
  routes.register({
    id: "settings.mcp.connection",
    parent: "settings",
    path: "mcp/$connectionId",
    component: McpServerPage
  })
  // Where a server's sign-in page sends the browser back (spec/MCP.md §2.4).
  routes.register({
    id: "mcp.signInCallback",
    parent: "app",
    path: MCP_OAUTH_CALLBACK,
    component: McpSignInCallbackPage
  })
  mcpSections.register({ id: "server", order: 10, component: ServerSection })
  mcpSections.register({ id: "sign-in", order: 20, component: SignInSection })
  mcpSections.register({ id: "uses", order: 25, component: UsesSection })
  mcpSections.register({ id: "tools", order: 30, component: ToolsSection })
  mcpSections.register({ id: "program-output", order: 32, component: ProgramOutputSection })
  mcpSections.register({ id: "loading", order: 35, component: LoadingSection })
  mcpSections.register({ id: "route", order: 40, component: RouteSection })
  mcpSections.register({ id: "sharing", order: 45, component: SharingSection })
  mcpSections.register({ id: "calls", order: 50, component: CallsSection })
  mcpSections.register({ id: "delete", order: 100, component: DeleteSection })
}
