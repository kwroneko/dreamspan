# Cordis as the plugin kernel: evaluation

**Status**: Evaluation, 2026-10-10. The owner decided not to use Cordis (2026-10-11). **The recommendation in §4 and §6 rests on a wrong premise**: that plugins written by the user's agent are untrusted and need a sandbox. They are the user's own plugins. [PLUGINS.md](PLUGINS.md) replaces both sections with the owner's threat model and a proposed structure. The facts about Cordis (§1–§3) still stand.

**Related**: DESIGN §7.7, §10.4, §11; [EFFECT.md](EFFECT.md); PLAN phase 6.

**Evidence.**
- npm registry metadata and download counts.
- The published tarballs, read from source: `cordis@4.0.0-rc.10`, `@cordisjs/plugin-loader@1.0.0-rc.7`, `@cordisjs/plugin-hmr@1.1.0`, `@cordisjs/core@3.18.1`.
- The GitHub API for cordiverse/cordis and deepseek-ai/deepseek-harness.
- A probe script run against `cordis@4.0.0-rc.10` on Node 24.15 with the repo's `effect@4.0.1`.

reference-harness has no plugin kernel, so this isn't a delta from it.

---

## 1. Maturity

**Releases.**
- `cordis` has 166 versions since 2022-04.
- The last stable release is **3.18.1** (2024-09).
- 4.x has been a prerelease for two years:
  - alpha.0: 2024-11
  - beta.5: 2025-06
  - no releases for about ten months
  - rc.0: 2026-03
  - **rc.10: 2026-09-08**
- npm `latest` points at rc.10, so `npm i cordis` installs a release candidate.
- The README says "the API is not yet stable and may change without notice".

**Two incompatible lines.**
- 3.x is built on `EffectScope`, `MainScope`, `ForkScope` and `Lifecycle`.
- 4.x replaced them with `Fiber` and an `EventsService`.
- Koishi (4.18.11), the original host, still depends on `cordis ^3.18.1`.

**Maintainers.**
- One npm maintainer (shigma) for `cordis`, `cosmokit`, `schemastery` and all `@cordisjs/*` packages.
- On GitHub, shigma has 550 commits; the next contributor has 8.
- A recent burst of outside fixes landed, and 49 PRs are open. One of them fixes "four disposal-order defects around fiber activation and teardown" (#185).

**DSH doesn't use upstream.**
- DeepSeek Harness vendors Cordis as `@deepseek-ai/cordis` 4.0.4, forked from rc.7, with **23 logged local modifications**. Among them:
  - lifecycle hardening that closes three reentrant-disposal gaps in `fiber.ts`
  - a loader fix where updating a provider and a consumer together could strand the consumer in `PENDING`
  - Node-native-TypeScript compatibility
  - a cross-package "volatile config" feature
- The heaviest user found the kernel's lifecycle core needed patching, and chose to own a fork.

**Usage (week of 2026-10-02):**

| Package | Weekly downloads |
|---|---|
| `@deepseek-ai/cordis` | 480k |
| `cordis` | 91k |
| `@cordisjs/plugin-loader` | 51k |
| `koishi` | 4k |

No independent standalone user was found. **[O]** The 91k/week for upstream `cordis` isn't explained by Koishi (on 3.x) or DSH (on the fork).

**Docs.**
- No official documentation site: the README says it's "under construction".
- DSH's "cordis primer" covers DSH conventions only.
- The deepest reference is a 92-page arXiv paper formalizing "revertible effects".
- In practice, the source is the documentation.

**Packaging.**
- MIT license. 4.x is ESM-only and ships `.d.ts`. The core is 79 KB, with `cosmokit` as a dependency.
- Hot reload adds:
  - `@cordisjs/plugin-loader` (71 KB)
  - `@cordisjs/plugin-hmr`, which brings `chokidar`, `picomatch`, `@babel/code-frame`, `schemastery` and the timer plugin
  - optionally a native addon from a single maintainer
- The packages depend on each other with `^` ranges on prereleases, so every one would need pinning.

## 2. The model

Read from the 4.x source and checked with the probe.

**Context and fiber.**
- `new Context()` is the root. `ctx.plugin(p, config)` creates a **Fiber**: one plugin instance with its own derived `ctx`.
- Fiber states: `PENDING`, `LOADING`, `ACTIVE`, `FAILED`, `UNLOADING`, `DISPOSED`.
- A plugin is a function, a class, or an object with `apply`, and carries static `name`, `inject`, `provide` and `Config`.

**Services.**
- `ctx.provide(name, value)` registers a service under a string key. Types come from global declaration merging.
- The context is a `Proxy`, and reading an undeclared service throws.

**Declared dependencies.**
- A fiber with `inject: ["tools"]` stays `PENDING` until `tools` is provided.
- Dependents unload when their provider is disposed, and rerun when it returns (confirmed by the probe).
- Services can be overridden per subtree (`isolate`, `intercept`).

**Reversible side effects.**
- `ctx.effect(() => { …; return dispose })` registers a disposer on the fiber. `ctx.on` and `ctx.provide` are built on it.
- Disposal runs disposers in reverse order. A plugin whose setup throws partway has its earlier registrations rolled back (confirmed by the probe).
- **"Reversible" covers only what goes through `ctx.effect`.** Database writes, network calls, global mutation and stray timers aren't reverted.

**Config.**
- 4.x accepts any Standard Schema. Effect 4's `Schema.toStandardSchemaV1` works: the probe rejected `{ greeting: 42 }` with "Expected string".
- An invalid config is logged and the fiber marked `FAILED`. It doesn't throw.

**Error isolation.**
- Setup and disposal errors are caught per fiber and logged.
- Events aren't isolated. `emit`, `serial`, `bail` and `waterfall` call listeners in order, and a throwing listener propagates to the emitter and skips the rest (confirmed by the probe). `parallel` collects errors into an `AggregateError`.
- There are no timeouts, no resource bounds, and no cancellation signal into plugin work.

**Hot reload has three layers:**
1. **The core:** `fiber.dispose()` plus `ctx.plugin(newImpl)` swaps an instance and cascades to its dependents.
2. **`plugin-loader`:** a YAML config tree, reconciled on change. Its `!!js` nodes are evaluated with `new Function(... with (ctx) { return eval(expr) })`, so **the config file is code**.
3. **`plugin-hmr`:** a file watcher plus partial module reload.
   - Node's ESM cache can't be invalidated through public APIs, so the loader reaches into `internal/modules/esm/loader`, through `--expose-internals` or the native addon.
   - It handles two internal shapes: Node 22 to 24.11, and 24.12 and later.
   - This is the most fragile part.

## 3. Fit with Effect 4

**The overlap is nearly complete:**

| Concern | Cordis | Effect 4 (already in the server) |
|---|---|---|
| Dependency injection | String-keyed `ctx.foo`, global declaration merging | `Context.Service` tags, checked in the `R` type |
| Lifetimes | Fiber and `ctx.effect` disposers | `Scope`, `acquireRelease`, `Layer.buildWithScope` |
| Dependency activation | `inject` → `PENDING` until provided | Layer construction order; no dynamic activation |
| Keyed rebuild | `fiber.dispose()` + `ctx.plugin()` | `LayerMap`/`RcMap` with `invalidate`, `Scope.close` |
| Errors | Logged; fiber `FAILED` | Typed error channel, `Exit`/`Cause` |
| Cancellation | None (Promise-based disposal) | Fiber interruption and `AbortSignal` |
| Config schema | Standard Schema | Effect Schema (the same schemas work in both) |

**What only Cordis has:**
- reactive activation, where dependents restart when a provided service appears, disappears or is replaced
- subtree service overrides
- the loader and HMR

**Running both means two DI systems and two lifetime models.**
- Every Effect service a plugin may use needs a Cordis facade calling `runtime.runPromise`. Typed errors and interruption are lost at that facade.
- `ctx.effect` also shares a name with Effect's `Effect`, a trap for agents (EFFECT.md §4).

**Sketch A: Cordis over Effect services.**
```ts
// Host bridge (ours): exposes Effect services as Cordis services.
export const RpBridge = (rt: ManagedRuntime.ManagedRuntime<ToolRegistry | Assembly, never>) => (ctx: Context) => {
  ctx.provide("rpTools", {
    register: (def: ToolDef) =>
      ctx.effect(() => {
        const scope = rt.runSync(Scope.make())
        rt.runSync(ToolRegistry.use((r) => r.register(def)).pipe(Scope.provide(scope)))
        return () => rt.runPromise(Scope.close(scope, Exit.void))
      })
  })
}

// A plugin
export const name = "dice"
export const inject = ["rpTools", "assembly"]
export const Config = Schema.toStandardSchemaV1(Schema.Struct({ sides: Schema.Int }))
export function apply(ctx: Context, config: { sides: number }) {
  ctx.rpTools.register({ name: "roll_dice", parameters: DiceArgs, execute: async () => roll(config.sides) })
  ctx.assembly.hook("tail", (draft) => draft)
}
```

**Sketch B: Effect-native.**
```ts
// ToolRegistry.register: (def) => Effect<void, never, Scope>, with acquireRelease inside.
export const Dice = Plugin.make({
  id: "dice",
  config: Schema.Struct({ sides: Schema.Int }),
  layer: (config) =>
    Layer.effectDiscard(
      Effect.gen(function* () {
        const tools = yield* ToolRegistry
        yield* tools.register({
          name: "roll_dice",
          parameters: DiceArgs,
          execute: () => Effect.sync(() => roll(config.sides)) // interruptible, typed errors
        })
        const assembly = yield* ContextAssembly
        yield* assembly.addHook({ stage: "tail", run: (draft) => Effect.succeed(draft) })
      })
    )
})
// PluginHost: a Map<id, Scope.Closeable>. load = Layer.buildWithScope(plugin.layer(config), scope);
// unload = Scope.close(scope); reload = unload, re-import, load.
```

In B, a missing service is a type error, and a tool's execution runs on a fiber the stop button interrupts. In A, both are runtime matters.

## 4. Security

**Cordis can't contain an untrusted plugin.** Plugins run in-process, with the server's realm, globals, `process`, `fs`, `import()` and network.
- `inject` is an ergonomic guard, not a boundary. In the probe, a plugin without `inject` couldn't read `ctx.tools`, but `ctx.root.get("tools")` returned the service.
- Any plugin can `import("node:fs")`.
- The paper's "non-interference" is a correctness property of composition, not a security one.

**Sandboxing agent-written plugins needs, whatever the kernel:**
- **Out-of-realm execution.** The options:
  - **`node:vm`:** Node documents it as "not a security mechanism". Excluded.
  - **`worker_threads`:** full Node API access. Not a sandbox by itself.
  - **The Node permission model:** process-wide, not carried into worker threads, and documented as no guarantee against malicious code. Usable only as a second layer on a child process.
  - **QuickJS compiled to WASM (`quickjs-emscripten`):** no ambient Node APIs, with memory and interrupt limits. Slow, but adequate for tool and hook bodies.
  - **`isolated-vm`:** a separate V8 isolate with heap limits. A native addon, now in maintenance mode.
  - **A child process under an OS sandbox (bubblewrap, seccomp, a container), plus `--permission`:** the strongest boundary and the heaviest.
  - **SES/Hardened JS:** in-process object capabilities. `lockdown()` freezes intrinsics for the whole realm, so its compatibility with Effect, pi-ai and undici is unknown. No resource limits.
- **A capability API over RPC.** The sandbox has no ambient authority. It calls a narrow, schema-validated API: register a tool, read the story through presence-limited views, propose a state event, fetch through `Network`. Every call is checked against that plugin's grants. The repo already runs typed Effect RPC to worker threads (ARCHITECTURE §3.1).
- **Grants per plugin, confirmed by the user on install** (DESIGN §7.7, §11). Imported content never grants anything, and grants are diffed on every update the agent writes.
- **Resource limits:** wall-clock timeouts, a heap cap, killing without harming the host, and rate limits on capability calls.

**Cordis doesn't help with the sandbox, and gets in the way in two places.**
- With sandboxing, the host side of each untrusted plugin is one unit, a sandbox handle plus its registrations, whose lifetime is one `Scope`. Inside the sandbox, a single plugin has nothing to compose.
- Reloading a sandboxed plugin means restarting its sandbox, so the Node-internals HMR is unnecessary.
- The loader's `!!js` evaluation is a liability if its config file is ever reachable from imports or from the agent.

## 5. The alternative: a minimal Effect-native plugin host [P]

- **`Plugin` descriptor:** id, version, an Effect Schema config, the capabilities it requests, the plugins it requires, and `layer(config): Layer<never, E, HostServices>`.
- **`PluginHost` service:**
  - a `Map<id, { scope, status, error }>`
  - `load`, `unload`, `reload`, `list`
  - status as a stream for the UI
  - dependents unloaded in reverse topological order when a plugin they require unloads or reloads, and rebuilt after
- **Extension-point registries** (tools, context-assembly hooks, macros, importers, later UI panels). Each `register` is `Effect<void, never, Scope>` built on `acquireRelease`, so unloading a plugin reverts its registrations.
- **Failures stay with their plugin:** a failed `load` closes its scope, rolling back partial registrations. Hooks run per plugin with `Effect.exit` and a timeout, so one failure is recorded against its plugin and doesn't skip the others.
- **Hot reload:**
  - **First-party in-process plugins:** close the scope, `import(url + "?v=" + contentHash)`, and rebuild. Old module instances stay in memory, which is acceptable for development.
  - **Sandboxed plugins:** restart the sandbox.
- **Size:** about 400 to 700 lines plus tests. The sandbox and the capability RPC are a separate, larger piece needed under either kernel.

**What we'd lose compared with Cordis:**
- automatic reactive activation for arbitrary plugin-provided services (we'd implement only declared `requires`)
- subtree service overrides
- the declarative loader
- module-graph-aware HMR
- the fiber introspection tree (we'd want our own for the activity panel)
- a formal model and large-scale exposure (through DSH's fork)

These matter most for DSH's "everything is a plugin" design. In rp-harness the core is a fixed set of Effect services and plugins extend named extension points, so most of the loss is in features we'd rarely use.

## 6. Recommendation

**[P] Don't adopt Cordis. Build a small Effect-native plugin host (§5), and make the plugin API a capability RPC from the start**, so one API serves first-party in-process plugins and sandboxed agent-written ones. Reasons:
1. **It duplicates Effect's `Layer`/`Scope` model,** and would cost us typed errors, interruption and compile-time dependency checks at the plugin boundary.
2. **Its maturity is below the bar the stack has used so far** (pinned, GA, LTS):
   - 4.0 is still a release candidate after two years
   - one maintainer
   - no official docs
   - its main user ships a fork with 23 patches, several in lifecycle code
3. **Its distinctive features serve trusted code:** in-process reversible composition, and HMR through Node internals. The goal that makes a kernel matter here, plugins written by the agent itself with RCE avoidance as the top priority (DESIGN §11), needs an out-of-process boundary that Cordis neither provides nor helps with.

**[O] Choosing the sandbox technology** (QuickJS-WASM, `isolated-vm`, or a child process under an OS sandbox) is the real open question for phase 6. It deserves its own spike measuring cold start, memory per plugin and capability-call latency on the server's host.

**What would change this:**
- Plugins are limited to trusted, owner-reviewed in-process code, and plugin-to-plugin service graphs become rich (optional dependencies, runtime replacement).
- Cordis ships 4.0.0 final with a stability policy, and gains a second active maintainer, or DSH's fork becomes a maintained semver'd upstream.
- The in-house host grows past about 1,500 lines, or we find ourselves reimplementing reactive activation badly.
- Effect is dropped on the server.

---

## Sources

- npm: [cordis](https://www.npmjs.com/package/cordis), [@cordisjs/plugin-loader](https://www.npmjs.com/package/@cordisjs/plugin-loader), [@cordisjs/plugin-hmr](https://www.npmjs.com/package/@cordisjs/plugin-hmr), [@deepseek-ai/cordis](https://www.npmjs.com/package/@deepseek-ai/cordis), [koishi](https://www.npmjs.com/package/koishi). Download counts from `api.npmjs.org/downloads/point/last-week`, checked 2026-10-10.
- Upstream: [cordiverse/cordis](https://github.com/cordiverse/cordis) ([open PRs](https://github.com/cordiverse/cordis/pulls), [PR #185](https://github.com/cordiverse/cordis/pull/185)).
- DSH's fork: [deepseek-harness `vendor/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/vendor/README.md); [Cordis primer](https://deepseek-harness.github.io/deepseek-harness/reference/cordis-primer).
- Paper: [A Programming Paradigm for Spatiotemporal Composability (arXiv:2608.25512)](https://arxiv.org/abs/2608.25512).
- Node: [permission model](https://nodejs.org/api/permissions.html), [`node:vm`](https://nodejs.org/api/vm.html), [`worker_threads`](https://nodejs.org/api/worker_threads.html).
- Sandboxes: [quickjs-emscripten](https://github.com/justjake/quickjs-emscripten), [isolated-vm](https://github.com/laverdet/isolated-vm), [SES / Hardened JavaScript](https://github.com/endojs/endo/tree/master/packages/ses).
- Effect 4: `node_modules/effect/dist/LayerMap.d.ts`, `Scope.d.ts`, `Schema.d.ts` (`toStandardSchemaV1`).
