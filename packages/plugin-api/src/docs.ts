/** Supported, typed adapters only. Examples are compiled and exercised by the host/browser suites. */
export const pluginDocumentation = [
  {
    topic: "composerControls",
    side: "client",
    types: ["DraftControl", "ComposerContext", "ComposerEntry", "ClientRegistry", "ClientHost", "ButtonProps"],
    description:
      "client:composerControls. tools places controls beside the composer's tools; banner and strip are also available. Use draft.append(text). Full-trust page code runs as the signed-in user.",
    example: `import { ui, type Activate } from "@rp/plugin-api/client"
export const activate: Activate = host => {
  host.registries.composerControls!.register({ id: "dice-roller.roll", order: 60, placement: "tools",
    component: ({ draft }) => <ui.IconButton hint="Rolls a d20 and adds the result to your message" onClick={() => draft.append("🎲 " + (1 + Math.floor(Math.random() * 20)))}>🎲</ui.IconButton> })
}`
  },
  {
    topic: "chatPanels",
    side: "client",
    types: ["PanelContext", "PanelEntry", "ClientRegistry"],
    description: "client:chatPanels. A saved chat's panel; active, chatId and nullable forkId are supplied.",
    example: `import { type Activate } from "@rp/plugin-api/client"
export const activate: Activate = host => { host.registries.chatPanels!.register({ id: "example.panel", label: "Example", description: "Shows a small example panel.", order: 80, component: ({ active }) => active ? <p>Example</p> : null }) }`
  },
  {
    topic: "routes",
    side: "client",
    types: ["RouteEntry", "ClientRegistry"],
    description: "client:routes. Pages below /extensions/. Changed pages need a reload; layouts cannot be replaced.",
    example: `import { type Activate } from "@rp/plugin-api/client"
export const activate: Activate = host => { host.registries.routes!.register({ id: "example.page", path: "/extensions/example", component: () => <p>Example</p> }) }`
  },
  {
    topic: "appBanners",
    side: "client",
    types: ["BannerEntry", "ClientRegistry"],
    description:
      "client:appBanners. A notice in the existing app banner slot. Recovery contributions cannot be replaced.",
    example: `import { type Activate } from "@rp/plugin-api/client"
export const activate: Activate = host => { host.registries.appBanners!.register({ id: "example.banner", order: 80, component: () => <p>Example notice</p> }) }`
  },
  {
    topic: "noticeChannels",
    side: "client",
    types: ["NoticeChannelEntry", "ClientRegistry"],
    description:
      "client:noticeChannels. Optional completion sounds and settings. Callbacks receive no account data. A failing replacement is off in this tab and the original returns. Use plugin_copy_builtin to start from the shipped sound.",
    example: `import {type Activate} from "@rp/plugin-api/client"
export const activate: Activate = host => {host.registries.noticeChannels!.register({id:"example.alert",component:()=> <p>Example alert</p>,activate:()=>{},receive:()=>{}})}`
  },
  {
    topic: "presence",
    side: "server",
    types: ["PresenceArgs", "PresenceContext", "PresenceTool"],
    surfaces: ["server:rolloutTools", "server:presence"],
    replaces: ["rolloutTools:set_presence"],
    description:
      "server:rolloutTools plus server:presence, replaces rolloutTools:set_presence. Only this tool receives causal cast data and a validated presence write, preserving receipts and narrator rules. Other tools receive data-only context. Read the shipped copy before editing it. Full server trust still applies.",
    example: `import {Effect,type PresenceTool,type Activate} from "@rp/plugin-api/server"
const tool:PresenceTool={id:"set_presence",label:"Presence",description:"Marks presence",effect:"chat_state",parameters:{type:"object",properties:{}},summarize:()=>"Presence",execute:context=>Effect.map(context.cast,cards=>({text:cards.map(c=>c.name).join(", ")}))}
export const activate:Activate=host=>host.registries.rolloutTools!.register(tool)`
  },
  {
    topic: "rolloutTools",
    side: "server",
    types: ["PluginToolContext", "PluginTool", "StoryToolV1", "HistoryContextV1", "NotesContextV1", "NoteToolV1"],
    description:
      "server:rolloutTools. StoryToolV1 uses server:history for causal viewer-filtered messages/summaries; NoteToolV1 uses server:notes for speaker-filtered notes and validated switches. The host retains the original effect/capability/approval/snapshot and receipt/Undo rules. Other tools use data-only call context, no database/service/credential handles. Tools with outside effects need a registered capability. Server code has full access, including stored keys and network; handles are not containment.",
    example: `import { Effect, type Activate } from "@rp/plugin-api/server"
export const activate: Activate = host => host.registries.rolloutTools!.register({ id: "example_read", label: "Read example", description: "Returns a constant example.", effect: "read", parameters: { type: "object", properties: {}, additionalProperties: false }, execute: () => Effect.succeed({ text: "Example" }) })`
  },
  {
    topic: "storyTools",
    side: "server",
    types: ["StoryToolV1", "HistoryContextV1"],
    surfaces: ["server:rolloutTools", "server:history"],
    replaces: ["rolloutTools:read_messages"],
    description:
      "Editable history policy. Host snapshots preserve private addresses across Resume. Reads cannot choose a branch or viewer; results cannot invent effects or receipts. Read-only tools need no Undo; state tools retain branch-local version effects. Ask-first and capabilities are fixed by the host.",
    example: `import {Effect,type StoryToolV1,type Activate} from "@rp/plugin-api/server"
const tool:StoryToolV1={id:"read_messages",label:"Read earlier messages",description:"Reads known earlier messages",effect:"read",parameters:{type:"object",properties:{}},execute:context=>Effect.map(context.messages,rows=>({text:rows.map(r=>r.content).join("\\n")}))}
export const activate:Activate=host=>host.registries.rolloutTools!.register(tool)`
  },
  {
    topic: "stateKeys",
    side: "worker",
    types: ["WorkerHost"],
    description:
      "worker:stateKeys. Namespaced Effect Schema keys; branch or chat scope. Replacing a built-in requires replaces. WorkerHost passes the actual worker registry.",
    example: `import { Schema, type Activate } from "@rp/plugin-api/worker"
export const activate: Activate = host => host.registries.stateKeys!.register({ id: "example/flag", value: Schema.Boolean, ids: { ids: {} }, scope: "branch" })`
  },
  {
    topic: "macros",
    side: "worker",
    types: ["WorkerHost", "MacroContractV1", "MacroCall", "MacroContext"],
    description:
      "worker:macros. MacroContractV1 (the v1 MacroSpec) provides causal data (see macroContext for field types), resolve/expandTemplate, metadata lookup, budgeted work, variable overlays, once and injected random. volatile:true freezes draws; clock freezes time; pick uses chat/text/offset. All copied macros conservatively mark their segment as changing, reducing prompt cache reuse even without declared volatility. A throw or 100ms synchronous deadline fails the request and suspends the plugin; the next request uses the original. Retained calls refuse after Turn off. No settings, credentials or other-branch queries.",
    example: `import { registerMacro, type Activate } from "@rp/plugin-api/worker"
export const activate: Activate = host => registerMacro(host.registries.macros!, { kind: "value", name: "example", args: [{name:"text"}], handler: call => call.resolve(call.args[0]!).toUpperCase() })`
  },
  {
    topic: "macroContext",
    side: "worker",
    types: ["MacroContext", "CardFields", "ChatMessage"],
    surfaces: ["worker:macros"],
    description:
      "MacroContractV1 context fields. Read alongside macros for resolver, variables, work and freezing. Messages precede the expansion on the current visible path. No branch selector, settings, own-turn-note lookup or credentials are supplied. Variable methods affect only the current expansion overlay.",
    example: `import {registerMacro,type Activate} from "@rp/plugin-api/worker"
export const activate:Activate=host=>registerMacro(host.registries.macros!,{kind:"value",name:"example",handler:call=>call.context.names.char})`
  },
  {
    topic: "storage",
    side: "common",
    types: ["PrivateStorage"],
    description:
      "server:storage or worker:storage. Per-plugin/account private JSON, revision-checked; values at most 512 KiB, 1,000 keys/8 MiB per namespace. Disabling keeps data.",
    example: `import { Effect, type Activate } from "@rp/plugin-api/server"
export const activate: Activate = host => Effect.gen(function* () { const prior = yield* host.storage!.get("example"); yield* host.storage!.set("example", { count: 1 }, prior?.revision ?? 0) })`
  }
] as const
