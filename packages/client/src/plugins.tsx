// Full-trust page code. Deadlines recover cooperative async failures, not synchronous loops.
import { useState, useSyncExternalStore, type ComponentType } from "react"
import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import type { ClientPlugin } from "@dreamspan/shared/pluginClient.ts"
import { builtinReplacement } from "@dreamspan/shared/builtinParts.ts"
import type {
  Activate,
  ClientHost,
  ClientRegistry,
  ComposerEntry,
  PanelEntry,
  RouteEntry,
  BannerEntry,
  NoticeChannelEntry
} from "../../plugin-api/src/client.ts"
import { startDisplayPlugin, isDisplayPlugin, DisplaySuperseded, type DisplayBridge } from "./displayPlugin.ts"
import { displayInput, displayResult, displayListInput, displayListResult, timelineResult } from "./displayAdapter.ts"
import { displayTransforms } from "./features/chat/displayPipeline.ts"
import { timelineTransforms, timelineInput, timelineRows } from "./features/chat/timelineContributions.tsx"
import { displayScriptLists } from "./features/chat/displayScripts.ts"
import type { DisplayTransformV1, DisplayScriptListV1, TimelineTransformV1 } from "../../plugin-api/src/display.ts"
import { composerControls } from "./features/chat/composerControls.tsx"
import { composerTextbox } from "./features/chat/composerFocus.ts"
import { chatPanels } from "./features/chat/panels.tsx"
import { appBanners } from "./features/shell.tsx"
import { shellSearchKeys } from "./features/workbench/kinds.ts"
import { fullPath, routes } from "./routes.tsx"
import { userNoticeReceivers, noticeChannels } from "./features/noticeContributions.tsx"
import { Button } from "./ui/Button.tsx"
import { Popover } from "./ui/Popover.tsx"
import { useAction } from "./actions.tsx"
import { sessionAtom } from "./session.ts"
import { flushOpenEditors } from "./features/editor/openEditors.ts"
import { installPluginSync, listenForPluginChanges } from "./pluginLifecycle.ts"
import { pluginComponent } from "./pluginBoundary.tsx"
import type { Registry } from "./registry.ts"

export const CLIENT_PLUGIN_TIMEOUT_MS = 3000
const active = new Map<string, { plugin: ClientPlugin; close: () => void }>()
const claims = new Map<string, string>()
const listeners = new Set<() => void>()
let snapshot: {
  changed: boolean
  errors: ReadonlyArray<{ key: string; part: string; name: string; scope: "instance" | "user"; id: string }>
} = { changed: false, errors: [] }
const publish = () => {
  for (const listener of listeners) listener()
}
const changed = () => {
  snapshot = { ...snapshot, changed: true }
  publish()
}
const keyOf = (p: ClientPlugin) => `${p.scope}/${p.id}`
const clientPluginUrl = (p: ClientPlugin) => `/plugins/${p.scope}/${p.id}/${p.commit}/client.mjs`
const report = (p: ClientPlugin, entry: string, registry = "host") => {
  const key = `${keyOf(p)}/${p.commit}/${registry}/${entry}`
  if (snapshot.errors.some((e) => e.key === key)) return
  snapshot = {
    ...snapshot,
    errors: [...snapshot.errors, { key, part: entry, name: p.manifest.name, scope: p.scope, id: p.id }]
  }
  publish()
}
export const pluginsOff = (url: string) => new URL(url, "http://app").searchParams.get("plugins") === "off"
const withoutPlugins = (url: string) => {
  const next = new URL(url, window.location.origin)
  next.searchParams.set("plugins", "off")
  return next.href
}

/** Revocable, typed adapters own every mutation, including partial and late activation. */
export const clientPluginHost = (p: ClientPlugin, display?: DisplayBridge) => {
  const key = keyOf(p)
  let live = true
  const lifetimeListeners = new Set<() => void>()
  const wrap = <P extends object>(Content: ComponentType<P>, fail: () => void) => {
    const Bounded = pluginComponent(Content, fail)
    return function ScopedEntry(props: P) {
      const enabled = useSyncExternalStore(
        (listener) => {
          lifetimeListeners.add(listener)
          return () => {
            lifetimeListeners.delete(listener)
          }
        },
        () => live
      )
      return enabled ? <Bounded {...props} /> : null
    }
  }
  const disposers: Array<() => void> = display ? [display.close] : []
  const own = (dispose: () => void) => {
    if (!live) {
      dispose()
      throw new Error("Plugin is off")
    }
    let disposed = false
    const once = () => {
      if (!disposed) {
        disposed = true
        dispose()
      }
    }
    disposers.push(once)
    return once
  }
  const close = () => {
    if (!live) return
    const focused = document.activeElement
    live = false
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        /* Continue disposing other entries. */
      }
    }
    for (const listener of lifetimeListeners) listener()
    if (typeof requestAnimationFrame === "function")
      requestAnimationFrame(() => {
        if (focused && !focused.isConnected && document.activeElement === document.body)
          composerTextbox()?.focus({ preventScroll: true })
      })
  }
  // A worker stopped while idle (it posted without being asked) has no call to fail: the
  // copy is reported and turned off here, exactly as a failed call does.
  display?.onFault?.(() => {
    if (!live) return
    report(p, "display", "display")
    queueMicrotask(() => {
      close()
      if (active.get(key)?.plugin === p) active.delete(key)
    })
  })
  const reserved = (name: string, id: string) =>
    (name === "appBanners" && (id === "plugins.host" || id.startsWith("plugins.host."))) ||
    (name === "routes" && (id === "settings.plugins" || id.startsWith("settings.plugins.")))
  const adapter = <A extends { readonly id: string }, B extends { readonly id: string }>(
    name: string,
    registry: Registry<B>,
    convert: (entry: A, fail: () => void) => B
  ): ClientRegistry<A> =>
    Object.freeze({
      register: (entry: A) => {
        const id = entry.id
        if (!live) throw new Error("Plugin is off")
        if (reserved(name, entry.id)) throw new Error("The plugin host cannot be replaced")
        if (!/^[a-z][a-zA-Z0-9._/-]{0,99}$/.test(entry.id)) throw new Error("Invalid entry id")
        const claim = `${name}:${entry.id}`
        if (claims.has(claim)) throw new Error("Plugin entry already owned")
        if (registry.get(entry.id) && claims.get(claim) !== key && !p.manifest.replaces.includes(claim))
          throw new Error("Replacement must be declared")
        if ((registry.get(id) || p.manifest.replaces.includes(claim)) && builtinReplacement(claim)?.side !== "client")
          throw new Error("This built-in still needs a copy adapter")
        const converted = convert(entry, () => {
          if (live) {
            const displayRule = ["displayTransforms", "displayScriptLists", "timelineTransforms"].includes(name)
            report(p, displayRule ? "display" : p.manifest.replaces.includes(claim) ? "event" : id, name)
            // A broken replacement must reveal the original, including render failures.
            if (displayRule || p.manifest.replaces.includes(claim))
              queueMicrotask(() => {
                close()
                if (active.get(key)?.plugin === p) active.delete(key)
              })
          }
        })
        claims.set(claim, key)
        const stop = registry.register(converted)
        return own(() => {
          stop()
          if (claims.get(claim) === key) claims.delete(claim)
        })
      },
      disable: (id: string) => {
        if (reserved(name, id)) throw new Error("The plugin host cannot be replaced")
        if (!live || !p.manifest.replaces.includes(`${name}:${id}`) || claims.has(`${name}:${id}`))
          throw new Error("Replacement must be declared")
        if (builtinReplacement(`${name}:${id}`)?.side !== "client")
          throw new Error("This built-in still needs a copy adapter")
        claims.set(`${name}:${id}`, key)
        const stop = registry.disable(id)
        return own(() => {
          stop()
          if (claims.get(`${name}:${id}`) === key) claims.delete(`${name}:${id}`)
        })
      },
      list: () => registry.list().map(({ id }) => Object.freeze({ id }))
    })
  const registries: { -readonly [K in keyof ClientHost["registries"]]: ClientHost["registries"][K] } = {}
  for (const surface of p.manifest.surfaces.filter((s) => s.startsWith("client:"))) {
    switch (surface) {
      case "client:timelineTransforms":
        if (!display) throw new Error("Display rules start in a browser worker")
        registries.timelineTransforms = adapter<TimelineTransformV1, Parameters<typeof timelineTransforms.register>[0]>(
          "timelineTransforms",
          timelineTransforms,
          (entry, fail) => {
            if (entry.api !== 1 || !Number.isFinite(entry.order)) throw new Error("Invalid timeline rule")
            const original = timelineTransforms.get(entry.id)
            const fallback = (
              rows: Parameters<NonNullable<typeof original>["transform"]>[0],
              context: Parameters<NonNullable<typeof original>["transform"]>[1]
            ) => original?.transform(rows, context) ?? rows
            return {
              id: entry.id,
              order: entry.order,
              ...(p.manifest.replaces.includes(`timelineTransforms:${entry.id}`)
                ? { replacement: p.manifest.name }
                : {}),
              transform: fallback,
              asyncTransform: async (rows, context, signal) => {
                try {
                  if (!live) throw new Error("Plugin is off")
                  const result = await display.call(
                    "timelineTransforms",
                    entry.id,
                    timelineInput(rows, context),
                    signal
                  )
                  return timelineRows(timelineResult(result), rows, context)
                } catch (error) {
                  // The timeline moved on before this was sent: nobody reads this answer.
                  if (error instanceof DisplaySuperseded) return rows
                  fail()
                  close()
                  return fallback(rows, context)
                }
              }
            }
          }
        )
        break
      case "client:displayTransforms":
        if (!display) throw new Error("Display rules start in a browser worker")
        registries.displayTransforms = adapter<DisplayTransformV1, Parameters<typeof displayTransforms.register>[0]>(
          "displayTransforms",
          displayTransforms,
          (entry, fail) => {
            if (entry.api !== 1 || !Number.isFinite(entry.order)) throw new Error("Invalid display rule")
            const original = displayTransforms.get(entry.id)
            return {
              id: entry.id,
              order: entry.order,
              ...(p.manifest.replaces.includes(`displayTransforms:${entry.id}`)
                ? { replacement: p.manifest.name }
                : {}),
              needsContext: true,
              transform: async (input, signal) => {
                const fallback = () => (original ? original.transform(input) : { text: input.text, issues: [] })
                try {
                  if (!live) throw new Error("Plugin is off")
                  return displayResult(await display.call("displayTransforms", entry.id, displayInput(input), signal))
                } catch (error) {
                  // The message changed or left the screen before this was sent.
                  // Nobody reads this answer, so the original is not run for it either.
                  if (error instanceof DisplaySuperseded) return { text: input.text, issues: [] }
                  fail()
                  close()
                  return fallback()
                }
              }
            }
          }
        )
        break
      case "client:displayScriptLists":
        if (!display) throw new Error("Display rules start in a browser worker")
        registries.displayScriptLists = adapter<DisplayScriptListV1, Parameters<typeof displayScriptLists.register>[0]>(
          "displayScriptLists",
          displayScriptLists,
          (entry, fail) => {
            if (entry.api !== 1 || !Number.isFinite(entry.order)) throw new Error("Invalid display rule")
            const original = displayScriptLists.get(entry.id)
            // Every message on screen asks with the same lists. One worker call answers them
            // all: the newest answers are kept by the identity of what was asked.
            const answers: Array<{
              readonly input: Parameters<NonNullable<typeof original>["scripts"]>[0]
              readonly scripts: Promise<ReturnType<typeof displayListResult>>
            }> = []
            return {
              id: entry.id,
              order: entry.order,
              ...(p.manifest.replaces.includes(`displayScriptLists:${entry.id}`)
                ? { replacement: p.manifest.name }
                : {}),
              scripts: (input) => original?.scripts(input) ?? [],
              asyncScripts: async (input) => {
                try {
                  if (!live) throw new Error("Plugin is off")
                  let known = answers.find(
                    (answer) =>
                      answer.input.global === input.global &&
                      answer.input.preset === input.preset &&
                      answer.input.character === input.character &&
                      answer.input.characterId === input.characterId &&
                      answer.input.placement === input.placement
                  )
                  if (!known) {
                    known = {
                      input,
                      scripts: display
                        .call("displayScriptLists", entry.id, displayListInput(input))
                        .then(displayListResult)
                    }
                    answers.unshift(known)
                    answers.length = Math.min(answers.length, 32)
                  }
                  return await known.scripts
                } catch {
                  fail()
                  close()
                  return original?.scripts(input) ?? []
                }
              }
            }
          }
        )
        break
      case "client:noticeChannels":
        registries.noticeChannels = adapter<NoticeChannelEntry, Parameters<typeof noticeChannels.register>[0]>(
          "noticeChannels",
          noticeChannels,
          (entry, fail) => {
            const guard = (run: () => void) => () => {
              if (!live) return
              const failed = () => {
                fail()
                close()
              }
              try {
                const result: unknown = run()
                // Void callbacks can still be async in TypeScript. Observe their rejection
                // here rather than relying on an attributable global Error stack.
                if (result) void Promise.resolve(result).catch(failed)
              } catch {
                failed()
              }
            }
            return {
              id: entry.id,
              component: wrap(entry.component, fail),
              activate: guard(entry.activate),
              receive: guard(entry.receive)
            }
          }
        )
        break
      case "client:composerControls":
        registries.composerControls = adapter<ComposerEntry, Parameters<typeof composerControls.register>[0]>(
          "composerControls",
          composerControls,
          (entry, fail) => {
            if (!["tools", "banner", "strip"].includes(entry.placement)) throw new Error("Unsupported placement")
            const Content = wrap(entry.component, fail)
            return {
              id: entry.id,
              order: entry.order,
              placement: entry.placement,
              component: (context) => (
                <Content
                  draft={context.draft}
                  compact={context.compact ?? false}
                  busy={context.busy}
                  ready={context.ready}
                />
              )
            }
          }
        )
        break
      case "client:chatPanels":
        registries.chatPanels = adapter<PanelEntry, Parameters<typeof chatPanels.register>[0]>(
          "chatPanels",
          chatPanels,
          (entry, fail) => {
            const Content = wrap(entry.component, fail)
            return {
              id: entry.id,
              label: entry.label,
              description: entry.description,
              order: entry.order,
              icon: "panel",
              savedOnly: true,
              component: (props) => (
                <Content active={props.active} chatId={props.session.chatId} forkId={props.view.forkId} />
              )
            }
          }
        )
        break
      case "client:routes":
        registries.routes = adapter<RouteEntry, Parameters<typeof routes.register>[0]>(
          "routes",
          routes,
          (entry, fail) => {
            if (!/^\/extensions\/[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*$/.test(entry.path))
              throw new Error("Unsupported route path")
            const previous = routes.get(entry.id)
            if (previous && (previous.path === undefined || routes.list().some((other) => other.parent === entry.id)))
              throw new Error("The extension-page adapter cannot replace a layout")
            if (routes.list().some((other) => other.id !== entry.id && fullPath(other) === entry.path))
              throw new Error("Plugin route path already registered")
            const Content = wrap(entry.component, fail)
            return { id: entry.id, parent: "app", path: entry.path, component: () => <Content /> }
          }
        )
        break
      case "client:appBanners":
        registries.appBanners = adapter<BannerEntry, Parameters<typeof appBanners.register>[0]>(
          "appBanners",
          appBanners,
          (entry, fail) => ({ id: entry.id, order: entry.order, component: wrap(entry.component, fail) })
        )
        break
      default:
        throw new Error("Unsupported client surface")
    }
  }
  return {
    host: Object.freeze({ api: 1, id: p.id, registries: Object.freeze(registries), onDispose: own }) as ClientHost,
    close
  }
}

const deadline = async <A,>(promise: Promise<A>) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Plugin load timed out")), CLIENT_PLUGIN_TIMEOUT_MS)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
export const loadClientPlugin = async (
  p: ClientPlugin,
  load: (url: string) => Promise<{ activate: Activate }> = (url) => import(/* @vite-ignore */ url)
) => {
  let display: ReturnType<typeof startDisplayPlugin> | undefined
  let scope: ReturnType<typeof clientPluginHost>
  try {
    display = isDisplayPlugin(p) ? startDisplayPlugin(p, clientPluginUrl(p)) : undefined
    scope = clientPluginHost(p, display?.bridge)
  } catch {
    display?.bridge.close()
    report(p, "load")
    return
  }
  const current = { plugin: p, close: scope.close }
  // Attribute errors during import/activation as well as after startup. A failed
  // pending activation must never publish itself again when its Promise settles.
  active.set(keyOf(p), current)
  try {
    await deadline(
      (async () => {
        if (display) {
          for (const entry of await display.ready) {
            if (entry.registry === "displayTransforms")
              scope.host.registries.displayTransforms!.register({
                ...entry,
                transform: () => {
                  throw new Error("Worker only")
                }
              })
            else if (entry.registry === "displayScriptLists")
              scope.host.registries.displayScriptLists!.register({
                ...entry,
                scripts: () => {
                  throw new Error("Worker only")
                }
              })
            else if (entry.registry === "timelineTransforms")
              scope.host.registries.timelineTransforms!.register({
                ...entry,
                transform: () => {
                  throw new Error("Worker only")
                }
              })
            else throw new Error("Unsupported display registry")
          }
        } else {
          const module = await load(clientPluginUrl(p))
          await module.activate(scope.host)
        }
      })()
    )
  } catch {
    scope.close()
    if (active.get(keyOf(p)) === current) {
      active.delete(keyOf(p))
      report(p, "load")
    }
  }
}
const readPlugins = async (): Promise<ReadonlyArray<ClientPlugin>> => {
  const response = await fetch("/plugins/client.json", {
    cache: "no-store",
    signal: AbortSignal.timeout(CLIENT_PLUGIN_TIMEOUT_MS)
  })
  if (response.status === 401) return []
  if (!response.ok) throw new Error("Can't read plugins")
  return response.json() as Promise<ReadonlyArray<ClientPlugin>>
}
let knownPlugins = ""
const fingerprint = (plugins: ReadonlyArray<ClientPlugin>) =>
  plugins
    .map((p) => `${keyOf(p)}/${p.commit}`)
    .sort()
    .join("\n")
const checkChanges = () => {
  if (pluginsOff(location.href)) return
  void readPlugins()
    .then((plugins) => {
      if (fingerprint(plugins) !== knownPlugins) changed()
    })
    .catch(() => undefined)
}
let routesNeedReload = false
const routesChanged = () => {
  routesNeedReload = true
  changed()
}
let syncing: Promise<void> | undefined
/** P3 calls this after its own successful enable/disable. Other tabs offer a reload. */
const syncClientPlugins = () =>
  (syncing ??= (async () => {
    if (pluginsOff(location.href)) return
    const plugins = await readPlugins()
    knownPlugins = fingerprint(plugins)
    snapshot = {
      changed: routesNeedReload,
      errors: snapshot.errors.filter((error) => plugins.some((p) => error.key.startsWith(`${keyOf(p)}/${p.commit}/`)))
    }
    publish()
    for (const [key, current] of active) {
      if (!plugins.some((p) => keyOf(p) === key && p.commit === current.plugin.commit)) {
        current.close()
        active.delete(key)
        if (current.plugin.manifest.surfaces.includes("client:routes")) routesChanged()
      }
    }
    await Promise.all(
      plugins
        .filter((p) => !active.has(keyOf(p)))
        .map((p) => {
          if (p.manifest.surfaces.includes("client:routes")) {
            routesChanged()
          }
          return loadClientPlugin(p)
        })
    )
  })().finally(() => {
    syncing = undefined
  }))

async function reload(url?: string) {
  try {
    await Promise.race([flushOpenEditors(), new Promise<void>((done) => setTimeout(done, 1500))])
  } catch {
    /* Browser backups remain. */
  }
  if (url) location.assign(url)
  else location.reload()
}
export const openWithoutPlugins = () => reload(withoutPlugins(location.href))

function FailureDetails({ part }: { readonly part: string }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="Details"
      triggerLabel="Details"
      title="Plugin problem"
      hint="Explains what stopped working in this tab."
    >
      <p className="text-sm">
        {part === "load"
          ? "This plugin couldn't start and is off in this tab."
          : part === "display"
            ? "A display rule failed. This plugin is off in this tab."
            : part === "event"
              ? "An action failed. This plugin is off in this tab."
              : "One part couldn't be shown. The rest of the app is available."}{" "}
        Ask a workshop to fix it.
      </p>
      <Button
        hint="Saves your drafts and opens this page without plugins."
        onClick={() => void reload(withoutPlugins(location.href))}
      >
        Open without plugins
      </Button>
    </Popover>
  )
}
function PluginBanners() {
  const action = useAction()
  const session = useAtomValue(sessionAtom)
  const admin = AsyncResult.isSuccess(session) && session.value.user.role === "admin"
  const state = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => snapshot
  )
  if (!state.changed && !state.errors.length) return null
  return (
    <div
      className="flex flex-col gap-2 border-b border-border bg-surface-raised px-4 py-2 text-sm"
      aria-label="Plugins"
      role="status"
    >
      {state.changed && (
        <div className="flex flex-wrap items-center gap-2">
          <span>Plugins changed. Reload to apply.</span>
          <Button hint="Saves your drafts and reloads this tab." onClick={() => void reload()}>
            Reload
          </Button>
        </div>
      )}
      {state.errors.map((error) => (
        <div key={error.key} data-plugin-error={error.part} className="flex flex-wrap items-center gap-2">
          <span>
            {error.name}
            {error.part === "load" || error.part === "event" || error.part === "display"
              ? " failed and is off here."
              : " had a problem. One part is hidden."}
          </span>
          {(error.scope === "user" || admin) && (
            <Button
              hint="Turns this plugin off for future visits."
              pending={action.pending}
              onClick={async () => {
                const result = await action.run((client) =>
                  client("DisablePlugin", { scope: error.scope, id: error.id })
                )
                if (result.ok) {
                  await syncClientPlugins()
                  snapshot = {
                    ...snapshot,
                    errors: snapshot.errors.filter((e) => e.id !== error.id || e.scope !== error.scope)
                  }
                  publish()
                }
              }}
            >
              Turn it off
            </Button>
          )}
          <FailureDetails part={error.part} />
        </div>
      ))}
      {action.error && <p role="alert">Couldn't turn it off. Try again, or open without plugins.</p>}
      <Button
        hint="Saves your drafts and opens this page without plugins."
        onClick={() => void reload(withoutPlugins(location.href))}
      >
        Open without plugins
      </Button>
    </div>
  )
}
export const startClientPlugins = async () => {
  installPluginSync(syncClientPlugins)
  listenForPluginChanges(checkChanges)
  shellSearchKeys.register({ id: "plugins.host", keys: ["plugins"] })
  appBanners.register({ id: "plugins.host", order: -100, component: PluginBanners })
  userNoticeReceivers.register({
    id: "plugins.host",
    receive: (notice) => {
      if (notice._tag === "PluginsChanged") checkChanges()
    }
  })
  if (pluginsOff(location.href)) return
  const failure = (error: unknown, filename = "") => {
    const stack = (error instanceof Error ? (error.stack ?? "") : "") + filename
    for (const [key, current] of active)
      if (stack.includes(clientPluginUrl(current.plugin))) {
        report(current.plugin, "event")
        current.close()
        active.delete(key)
      }
  }
  window.addEventListener("error", (event) => failure(event.error, event.filename))
  window.addEventListener("unhandledrejection", (event) => failure(event.reason))
  try {
    const plugins = await readPlugins()
    knownPlugins = fingerprint(plugins)
    await Promise.all(plugins.map((p) => loadClientPlugin(p)))
  } catch {
    changed()
  }
  window.addEventListener("rp:connected", checkChanges)
  window.addEventListener("focus", checkChanges)
}
