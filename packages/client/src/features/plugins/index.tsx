import { RegistryContext } from "@effect/atom-react"
import { formatByteSize } from "@rp/shared/byteSize.ts"
import { hasServerCode, pluginAccessGrows, pluginConsent, pluginSurfaces } from "@rp/shared/pluginConsent.ts"
import type { PluginDetails, PluginReport, PluginView } from "@rp/shared/plugins.ts"
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router"
import { useContext, useEffect, useRef, useState } from "react"
import { AsyncView, ErrorAlert, invalidateKeys, useAction } from "../../actions.tsx"
import { syncClientPlugins } from "../../pluginLifecycle.ts"
import { AppClient } from "../../rpc.ts"
import { routes } from "../../routes.tsx"
import { useSession } from "../../session.ts"
import { Button } from "../../ui/Button.tsx"
import { CenterHeaderContent } from "../../ui/CenterHeader.tsx"
import { ConfirmDialog, Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Alert, Badge, Card, CardHeader, EmptyState } from "../../ui/Surface.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { userNoticeReceivers } from "../noticeContributions.tsx"
import { appBanners, useTitle } from "../shell.tsx"
import { settingsGroups } from "../settings/groups.ts"
import { openWithoutPlugins } from "../../plugins.tsx"

type View = typeof PluginView.Type
type Detail = typeof PluginDetails.Type
const KEY = "plugins"
const pluginsAtom = AppClient.query("ListPlugins", undefined, { reactivityKeys: [KEY] })
const targetOf = (plugin: View) => ({ scope: plugin.scope, id: plugin.id })
const routeId = (plugin: View) => `${plugin.scope}~${plugin.id}`
const status = (plugin: View) => (!plugin.pin || plugin.pin.suspended ? "Off" : "On")
const canManage = (plugin: View, admin: boolean) =>
  admin || (plugin.scope === "user" && plugin.manifest !== null && !hasServerCode(plugin.manifest))
const label = (plugin: View) => plugin.manifest?.name || plugin.id

function DetailsLink({ plugin }: { plugin: View }) {
  return (
    <Tooltip label="Opens this plugin's versions, checks and stored data.">
      <Link
        to="/settings/plugins/$pluginId"
        params={{ pluginId: routeId(plugin) }}
        className="font-medium text-accent underline-offset-4 hover:underline [overflow-wrap:anywhere]"
      >
        {label(plugin)}
      </Link>
    </Tooltip>
  )
}
function SafeStart() {
  return (
    <Button
      hint="Saves your drafts and opens this page without client plugins."
      onClick={() => void openWithoutPlugins()}
    >
      Open without plugins
    </Button>
  )
}
function PluginsPage() {
  useTitle("Plugins")
  return (
    <Card>
      <CardHeader center title="Plugins" actions={<SafeStart />} />
      <AsyncView atom={pluginsAtom} loading="Reading plugins…">
        {(plugins) =>
          plugins.length === 0 ? (
            <EmptyState title="No plugins installed">
              <p>An admin can add one through the server's plugins folder.</p>
            </EmptyState>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {plugins.map((plugin) => (
                <li key={routeId(plugin)} className="flex min-w-0 flex-col gap-1 py-3 first:pt-0 last:pb-0">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <DetailsLink plugin={plugin} />
                    <Badge>{status(plugin)}</Badge>
                  </div>
                  <p className="text-sm text-muted">
                    {plugin.scope === "instance" ? "Every account" : "Your account"}
                    {plugin.pin?.suspended && plugin.pin.suspended.reason !== "Plugin turned off"
                      ? " · Needs attention"
                      : ""}
                  </p>
                </li>
              ))}
            </ul>
          )
        }
      </AsyncView>
    </Card>
  )
}
function CheckReport({ report }: { report: PluginReport | null }) {
  const turnedOff = report?.message === "Plugin turned off"
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {report ? (
        <Alert
          tone={turnedOff ? "neutral" : report.ok ? "success" : "danger"}
          title={turnedOff ? "Turned off" : report.ok ? "Checks passed" : "Checks failed"}
        >
          <p>{report.message}</p>
          <p className="text-xs text-muted">Version {report.commit.slice(0, 8)}</p>
        </Alert>
      ) : (
        <p className="text-sm text-muted">This version hasn't been checked yet.</p>
      )}
      {report?.steps && (
        <ul className="flex flex-col gap-1 text-sm text-muted">
          {report.steps.map((step) => (
            <li key={step.step}>
              {(
                {
                  snapshot: "Source files",
                  manifest: "Plugin information",
                  types: "Code",
                  bundle: "Build",
                  probe: "Startup",
                  tests: "Tests",
                  ready: "Ready"
                } as Record<string, string>
              )[step.step] ?? "Startup"}
              : {step.ok ? "Passed" : "Failed"}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
function PluginPage() {
  const { pluginId = "" }: { pluginId?: string } = useParams({ strict: false })
  const [scope, id = ""] = pluginId.split("~")
  if ((scope !== "instance" && scope !== "user") || !/^[a-z][a-z0-9-]{0,63}$/.test(id))
    return <EmptyState title="This plugin doesn't exist" />
  const atom = AppClient.query("GetPlugin", { scope, id }, { reactivityKeys: [KEY] })
  return (
    <AsyncView atom={atom} loading="Reading the plugin…">
      {(plugin) => <PluginDetail key={routeId(plugin)} plugin={plugin} />}
    </AsyncView>
  )
}
function PluginDetail({ plugin }: { plugin: Detail }) {
  useTitle(label(plugin))
  const admin = useSession().user.role === "admin"
  const registry = useContext(RegistryContext)
  const action = useAction()
  const navigate = useNavigate()
  const search: { enable?: unknown; enableRevision?: unknown; deleteData?: unknown } = useSearch({ strict: false })
  const busy = useRef(false)
  const [report, setReport] = useState<PluginReport | null>(null)
  const target = targetOf(plugin)
  const manage = canManage(plugin, admin)
  const version = plugin.versions.find((v) => v.commit === search.enable)
  const closeDialog = () =>
    void navigate({
      to: ".",
      search: (previous: Record<string, unknown>) => ({
        ...previous,
        enable: undefined,
        enableRevision: undefined,
        deleteData: undefined
      }),
      replace: true
    })
  const run = async (kind: "enable" | "off" | "back" | "delete") => {
    if (busy.current) return
    const previousVersion = plugin.versions.find((v) => v.commit === plugin.pin?.previousCommit)
    const currentVersion = plugin.versions.find((v) => v.commit === plugin.pin?.commit)
    if (
      kind === "back" &&
      previousVersion?.manifest &&
      pluginAccessGrows(currentVersion?.manifest, previousVersion.manifest)
    ) {
      void navigate({
        to: ".",
        search: (previous: Record<string, unknown>) => ({
          ...previous,
          enable: previousVersion.commit,
          enableRevision: plugin.revision
        })
      })
      return
    }
    busy.current = true
    setReport(null)
    try {
      const result = await action.run<PluginReport | void, unknown>(
        (client) =>
          kind === "enable" && version
            ? client("PinPluginCommit", {
                ...target,
                commit: version.commit,
                consent: true,
                expectedRevision: Number.isSafeInteger(Number(search.enableRevision))
                  ? Number(search.enableRevision)
                  : plugin.revision
              })
            : kind === "back"
              ? client("GoBackPlugin", { ...target, expectedRevision: plugin.revision })
              : kind === "delete"
                ? client("DeletePluginData", target)
                : client("DisablePlugin", target),
        [KEY]
      )
      if (!result.ok) invalidateKeys(registry, [KEY])
      if (result.ok) {
        if (result.value) setReport(result.value)
        await syncClientPlugins()
        if (!result.value || result.value.ok) closeDialog()
      }
    } finally {
      busy.current = false
    }
  }
  const activeManifest = plugin.versions.find((v) => v.commit === plugin.pin?.commit)?.manifest
  const grew = version?.manifest && activeManifest && pluginAccessGrows(activeManifest, version.manifest)
  return (
    <div className="flex min-w-0 flex-col gap-4 [overflow-wrap:anywhere]">
      <div className="flex min-w-0 flex-col gap-1">
        <Tooltip label="Returns to Plugins.">
          <Link to="/settings/plugins" className="hidden self-start text-sm text-muted hover:text-text md:block">
            ← Plugins
          </Link>
        </Tooltip>
        <CenterHeaderContent>
          <h1 className="min-w-0 truncate text-xl font-semibold">{label(plugin)}</h1>
        </CenterHeaderContent>
        <p className="text-sm text-muted">
          {plugin.scope === "instance" ? "Every account" : "Your account"} · {status(plugin)}
        </p>
      </div>
      <Card>
        <CardHeader title="Plugin" actions={<SafeStart />} />
        {plugin.manifest && (
          <ul className="flex flex-col gap-1 text-sm">
            {pluginSurfaces(plugin.manifest).map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        )}
        {plugin.pin?.suspended && plugin.pin.suspended.reason !== "Plugin turned off" && (
          <div className="mt-3">
            <Alert tone="warning" title="This plugin is off">
              It couldn't keep running. Review the checks or go back to an earlier enabled version.
            </Alert>
          </div>
        )}
        {manage && (
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              hint="Stops this plugin and keeps its data. You can turn it on again."
              disabled={!plugin.pin || !!plugin.pin.suspended || action.pending}
              onClick={() => void run("off")}
            >
              Turn off
            </Button>
            <Button
              hint={
                plugin.pin?.previousCommit
                  ? "Turns on the previous enabled version after checking it."
                  : "No earlier enabled version is available."
              }
              disabled={!admin || !plugin.pin?.previousCommit || action.pending}
              onClick={() => void run("back")}
            >
              Go back
            </Button>
          </div>
        )}
        {!admin && <p className="mt-3 text-sm text-muted">An admin turns plugins on and applies new versions.</p>}
      </Card>
      <ErrorAlert error={action.error} />
      <Card>
        <CardHeader title="Versions" />
        {plugin.versions.length ? (
          <ul className="flex min-w-0 flex-col divide-y divide-border">
            {plugin.versions.map((entry) => (
              <li key={entry.commit} className="flex min-w-0 flex-col gap-2 py-3 first:pt-0 last:pb-0">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <p className="min-w-0 flex-1 text-sm [overflow-wrap:anywhere]">{entry.message}</p>
                  {entry.commit === plugin.pin?.commit && (
                    <Badge>{plugin.pin.suspended ? "Last enabled" : "Enabled"}</Badge>
                  )}
                </div>
                <p className="text-xs text-muted">
                  {entry.commit.slice(0, 8)}
                  {plugin.pin?.enabledCommits?.includes(entry.commit) ? " · Enabled before" : ""}
                </p>
                {admin && (
                  <div>
                    <Button
                      hint="Reviews what this version can do before turning it on."
                      disabled={
                        !entry.manifest ||
                        (entry.commit === plugin.pin?.commit && !plugin.pin.suspended) ||
                        action.pending
                      }
                      onClick={() =>
                        void navigate({
                          to: ".",
                          search: (previous: Record<string, unknown>) => ({
                            ...previous,
                            enable: entry.commit,
                            enableRevision: plugin.revision
                          })
                        })
                      }
                    >
                      Turn on
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">No saved versions are available.</p>
        )}
      </Card>
      <Card>
        <CardHeader title="Checks" />
        <CheckReport report={report ?? plugin.report} />
      </Card>
      <Card>
        <CardHeader
          title="Stored data"
          description={
            plugin.data
              ? `${plugin.data.length} saved ${plugin.data.length === 1 ? "entry" : "entries"} · ${formatByteSize(plugin.data.reduce((sum, row) => sum + row.bytes, 0))}`
              : "Managed by an admin"
          }
        />
        {plugin.data && plugin.data.length > 0 && (
          <ul className="mb-4 flex flex-col gap-1 text-sm text-muted">
            {plugin.data.map((row) => (
              <li key={row.key}>
                {row.key} · {formatByteSize(row.bytes)}
              </li>
            ))}
          </ul>
        )}
        {manage && (
          <Button
            hint="Deletes this plugin's private saved data after confirmation."
            disabled={action.pending}
            onClick={() =>
              void navigate({
                to: ".",
                search: (previous: Record<string, unknown>) => ({ ...previous, deleteData: "1" })
              })
            }
          >
            Delete its data
          </Button>
        )}
      </Card>
      <Dialog
        open={typeof search.enable === "string" && admin}
        onOpenChange={(open) => {
          if (!open) closeDialog()
        }}
        title={`Turn on ${version?.manifest?.name || label(plugin)}?`}
      >
        {version?.manifest ? (
          <>
            <p className="text-sm [overflow-wrap:anywhere]">{version.message}</p>
            <p className="text-xs text-muted">Version {version.commit.slice(0, 8)}</p>
            {grew && (
              <Alert tone="warning">This version can change more of the app than the last enabled version.</Alert>
            )}
            <ul className="flex flex-col gap-2 text-sm">
              {pluginConsent(version.manifest, plugin.scope).map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
            {report && !report.ok && <CheckReport report={report} />}
            <ErrorAlert error={action.error} />
            <DialogActions>
              <Button hint="Closes this dialog and leaves the plugin as it is." onClick={closeDialog}>
                Not now
              </Button>
              <Button
                variant="primary"
                hint="Checks and runs this exact version from now on."
                pending={action.pending}
                onClick={() => void run("enable")}
              >
                Turn on
              </Button>
            </DialogActions>
          </>
        ) : (
          <p>This version isn't available. Close this dialog and choose another version.</p>
        )}
      </Dialog>
      <ConfirmDialog
        open={(search.deleteData === "1" || search.deleteData === 1) && manage}
        onOpenChange={(open) => {
          if (!open) closeDialog()
        }}
        title="Delete its data?"
        description={`Permanently deletes ${plugin.data?.length ?? 0} private saved entries for ${label(plugin)}${plugin.scope === "instance" ? ", shared by every account" : ", in your account"}. Chats, library items, plugin files and versions stay. ${status(plugin) === "On" ? "The plugin stays on and may save new data." : "The plugin stays off."}`}
        confirmLabel="Delete data"
        pending={action.pending}
        onConfirm={() => void run("delete")}
      >
        <ErrorAlert error={action.error} />
      </ConfirmDialog>
    </div>
  )
}

const dismissed = new Set<string>()
function SuspendedPlugins() {
  const registry = useContext(RegistryContext)
  useEffect(() => {
    return userNoticeReceivers.register({
      id: "plugins.settings.refresh",
      receive: (notice) => {
        if (notice._tag === "PluginsChanged") invalidateKeys(registry, [KEY])
      }
    })
  }, [registry])
  return (
    <AsyncView atom={pluginsAtom} loading="Reading plugin status…">
      {(plugins) => (
        <>
          {plugins
            .filter((p) => p.pin?.suspended && p.pin.suspended.reason !== "Plugin turned off")
            .map((p) => (
              <SuspendedNotice key={`${routeId(p)}:${p.pin!.suspended!.at}`} plugin={p} />
            ))}
        </>
      )}
    </AsyncView>
  )
}
function SuspendedNotice({ plugin }: { plugin: View }) {
  const identity = `${routeId(plugin)}:${plugin.pin!.suspended!.at}`
  const [hidden, setHidden] = useState(() => dismissed.has(identity))
  if (hidden) return null
  return (
    <Alert
      tone="warning"
      title={`${label(plugin)} is off`}
      actions={
        <>
          <Tooltip label="Opens this plugin's checks and recovery controls.">
            <Link
              to="/settings/plugins/$pluginId"
              params={{ pluginId: routeId(plugin) }}
              className="text-accent hover:underline"
            >
              Open plugins
            </Link>
          </Tooltip>
          <Button
            hint="Hides this notice in this tab. The plugin's details keep the problem."
            onClick={() => {
              dismissed.add(identity)
              setHidden(true)
            }}
          >
            Dismiss
          </Button>
        </>
      }
    >
      <p>The app couldn't run this plugin. Its data is kept.</p>
      <Recovery plugin={plugin} />
    </Alert>
  )
}
function Recovery({ plugin }: { plugin: View }) {
  const admin = useSession().user.role === "admin"
  const registry = useContext(RegistryContext)
  const action = useAction()
  const [report, setReport] = useState<PluginReport | null>(null)
  const navigate = useNavigate()
  const busy = useRef(false)
  return (
    <>
      {admin && plugin.pin?.previousCommit && (
        <AsyncView atom={AppClient.query("GetPlugin", targetOf(plugin), { reactivityKeys: [KEY] })}>
          {(detail) => (
            <Button
              hint="Checks and turns on the previous enabled version."
              pending={action.pending}
              onClick={async () => {
                if (busy.current) return
                const previousVersion = detail.versions.find((v) => v.commit === detail.pin?.previousCommit)
                const currentVersion = detail.versions.find((v) => v.commit === detail.pin?.commit)
                if (
                  previousVersion?.manifest &&
                  pluginAccessGrows(currentVersion?.manifest, previousVersion.manifest)
                ) {
                  void navigate({
                    to: "/settings/plugins/$pluginId",
                    params: { pluginId: routeId(plugin) },
                    search: { enable: previousVersion.commit, enableRevision: detail.revision }
                  })
                  return
                }
                busy.current = true
                const result = await action.run(
                  (client) => client("GoBackPlugin", { ...targetOf(plugin), expectedRevision: detail.revision }),
                  [KEY]
                )
                busy.current = false
                if (!result.ok) invalidateKeys(registry, [KEY])
                if (result.ok) {
                  setReport(result.value)
                  await syncClientPlugins()
                }
              }}
            >
              Go back
            </Button>
          )}
        </AsyncView>
      )}
      <ErrorAlert error={action.error} />
      {report && !report.ok && <CheckReport report={report} />}
    </>
  )
}
export const register = () => {
  settingsGroups.register({ id: "plugins", label: "Plugins", order: 25, pages: ["settings.plugins"] })
  routes.register({
    id: "settings.plugins",
    parent: "settings",
    path: "plugins",
    component: PluginsPage,
    nav: { label: "Plugins", order: 50, description: "Turn plugins on or off and manage their versions and data." }
  })
  routes.register({
    id: "settings.plugins.detail",
    parent: "settings",
    path: "plugins/$pluginId",
    component: PluginPage
  })
  appBanners.register({ id: "plugins.host.suspended", order: -90, component: SuspendedPlugins })
}
