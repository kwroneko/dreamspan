# Plugins: threat model and structure

**Status**: Proposed, 2026-10-11. The owner's statements of that date are marked **[D]**. Supersedes the recommendation in [CORDIS.md](CORDIS.md), whose evaluation of Cordis itself still stands. Building the plugin system is PLAN phase 6. §5 lists what has to shape the code before then.

---

## 1. What the owner decided (2026-10-11)

- **[D] Cordis isn't needed.**
- **[D] Running a plugin is the user's conscious choice to run code.** If a plugin steals keys, that's on the plugin.
  - **Our responsibility is that content never becomes code:** cards, presets, lorebooks, chats, model output and imported files. An RCE from a card is entirely on us (DESIGN §11).
- **[D] A plugin written by the user's own agent is the user's plugin,** not untrusted code. Treating it as hostile was backwards.
- **[D] Three lines of attack to consider** (consider means weigh mitigations, not guarantee safety):
  1. **Stealing AI provider credentials.** By far the most likely target. It's as much a supply-chain risk as a plugin risk: AI-specific dependencies and their trees deserve suspicion, even though this software is too small to be targeted directly.
  2. **The user's system:** escaping the harness to damage or infect the machine. Docker with a non-root user covers deployment. Users who don't use Docker can get other sandboxing later. This has lower priority.
  3. **Logging and exfiltrating the user's chats.** Plugins must read text, so reading can't be prevented generically. Some can be blocked from making web requests.
- **[D] The ideal**, knowing something will have to give:
  - plugins can change almost anything
  - each user customizes the harness by asking their own agent inside the app
  - plugins survive harness updates
  - any plugin can be installed without worry
- **[D] Priority:** plugins could become a core benefit, possibly what turns a tool made for the owner into a standard platform, but they rank below getting the harness itself to work as designed. Our side must not explode in complexity.
- **[D] Not limited to fixed integration points a priori.** The owner wanted DSH because everything there is a plugin (users can change the UI, the context, or add whole systems). That is weighed against the cost of a fully generic design, and against forking.
- **[D] Forks are a real alternative.** Coding agents make maintaining a fork cheaper. A plugin is still easier than a fork, and plugins can be combined and distributed.
- **[D] An ST-style registry:** add a plugin from any GitHub repo.

## 2. Correcting CORDIS.md

CORDIS.md treated "plugins written by the agent itself" as untrusted code that needs an out-of-process sandbox. The premise was wrong (§1). Its evaluation of Cordis (maturity, overlap with Effect) still holds.

**Prompt injection is not ours to defend against [D] (owner, 2026-10-11).**
- A card the user loads is effectively their prompt. If it steers their agent into writing a harmful plugin, that's user error.
- Defending against the user's own prompt would hamstring the agent, so agent capabilities don't depend on where content came from.

**What stays on our side:**
- **Import formats carry no capability grants [P].** A card or preset file's own fields can't enable tools, plugins or permissions; the user does that. This was Marinara's bug: imported agent files granting themselves tool access. It's content becoming configuration, and it doesn't limit the agent at all.
- **Installing or changing a plugin goes through the normal install confirmation [P]**, whoever wrote it. Agent-written plugins included, that's a UX choice and not an injection defense. **[O]** A setting could let the user's own agent activate plugin changes without asking.

## 3. Structure: how much is a plugin [P]

**The spectrum, from no code to full control:**

| Level | What it changes | Survives updates | Cost to us |
|---|---|---|---|
| Data | Cards, presets, notes, templates | Yes | None |
| Declarative | Regex scripts, display rules, macros defined as text, design-token themes | Yes | Low |
| Extension points | Adds tools, assembler stages, importers, renderers, panels, commands | With a stable API | Medium |
| Overrides | Wraps or replaces any core module or service | Only with repair | Low if the core is built for it |
| Fork | Anything | With merging | None to us |

**Proposal: the core is built from its own registries,** a middle way between fixed integration points and DSH's everything-is-a-plugin kernel.
- **Every core feature registers itself by a stable id,** through the same registries plugins use:
  - the assembler's stages (DESIGN §5.1)
  - macros, importers and display rules
  - the RP tools
  - on the client: message renderers, panels, composer actions, routes and commands
- **A plugin can add, wrap, replace or disable any entry.** So the user can change how the context works or how the UI behaves, at the seams the core itself uses.
- **This is the answer to "plugin APIs never anticipate what people need".** The core is the first client of every registry, so the seams exist where the app actually has them, not where we imagined plugins would want them.
- **The kernel stays a fixed application, not a plugin:** storage and its invariants, RPC, authentication and ownership, the provider layer and key handling.
  - Making the kernel generic is where DSH-style designs spend their complexity, and nobody customizing RP needs it.
  - Changing the kernel is what forks are for.

**Overrides, the escape hatch.**
- Every server capability is already an Effect service. A plugin can provide a layer that wraps or replaces a service, much like Emacs advice.
- This reaches beyond the registries without us designing an API for each case. Overrides are typed, but they come with no stability promise.

**Two compatibility tiers:**
- **Stable:** registries and their contracts, versioned, with deprecation windows.
- **Internal:** overrides and internal types, which may change in any release.

**Updates and broken plugins.**
- At startup, plugins are type-checked and bundled against the running version. A plugin that no longer compiles or fails to load is disabled and reported, never taking the app down with it.
- The user's in-app agent can repair a broken plugin from the changelog and the types. Agents make plugin breakage cheap to fix, just as they make forks cheap to maintain. That's what makes a capable internal tier affordable.

**What plugins can't break:**
- The database enforces "nothing lost" and the graph invariants with triggers (ARCHITECTURE §3.7), so even an override can't break them.
- Plugins store their data in their own namespace, and add chat state through namespaced state-event keys with registered schemas.

**Distribution.**
- Install from a GitHub repo, pinned to a commit. An update is explicit and shows what changed: the code, and the declared capabilities (client and/or server, network, which services it overrides).
- The same plugin format serves the registry, agent-written plugins and hand-written ones.

## 4. The three lines of attack [P]

### 4.1 Credentials (the most likely target)

- **Keys never reach the browser** (DESIGN §9), so a client-side plugin can't read one.
- **Gap: redirecting a stored key.**
  - A client plugin, an XSS or a stolen session can't read a key, but it can call our RPCs. Changing a connection's base URL sends its stored key to the new host with the next request.
  - **Proposed fix, independent of plugins:** changing a keyed connection's base URL, kind or custom proxy clears its key, so it has to be entered again. A small change, worth making before the settings UI exists.
- **Server plugins run in the server process.** They can read `secret.key` and decrypt every stored key, and in a multi-user instance that means every user's. So:
  - **Server-side plugins are instance-wide code:** only an admin can install them.
  - **Per-user customization in a multi-user instance** is client plugins and declarative ones.
- **Possible later: out-of-process server plugins.**
  - They'd run in a separate process that never holds the server secret. They reach the host over RPC, can ask the provider layer for generations, and never see keys. Node's permission model would be a second layer, denying file access to `DATA_DIR`.
  - The cost: overrides and registry hooks cross an RPC boundary, and service overrides become much harder.
  - **[O]** Default to in-process (maximum power) or out-of-process (keys safe from plugins)? Possibly per plugin, declared and shown at install.
- **Supply chain:**
  - The same exposure applies to our own dependencies, and pi-ai alone brings the OpenAI, Anthropic, Google and AWS SDKs.
  - Mitigations already in place: exact pins, the cooldown, and secrets decrypted only on the main thread.
  - Additions: review the dependency tree whenever an AI-related package is added or bumped, and keep that list short.

### 4.2 The user's system

- The Docker image already runs as the unprivileged `node` user.
- For installs outside Docker, a later start mode could run the server under Node's permission model, with file access limited to the app and `DATA_DIR`. That's a seat belt, not a sandbox, and it's low priority, as stated.

### 4.3 Exfiltrating chats

- Reading can't be prevented: plugins exist to work with the text.
- **Sending can be limited for client plugins, cheaply.** The app's Content Security Policy (`connect-src 'self'`, no third-party origins) stops browser-side code from sending anything anywhere except our own server. This has to be designed in from the start: no external CDNs or fonts at runtime, and HTML rendering only in sandboxed iframes, as already planned.
- **Server plugins in-process can't be stopped from making requests.** Declaring network use is shown at install, and it's enforced only in the out-of-process mode. Routing their requests through `Network.fetchFor` gives the user a log of what was sent where.

## 5. What has to shape the code now [P]

Retrofitting this structure would be expensive, but building it in as features land costs little:
- **Phase 1–2 features register as modules with ids,** never as hard-wired calls: the assembler's stages, macros, importers, display rules, and later tools. That costs one registry per extension point.
- **The client routes through slot registries:** message rendering, panels and composer actions. `src/ui/` is already the single import path for components, which makes it a natural place to override them.
- **Chat state keys get a namespace scheme** before the first extension needs one. They're a closed typed union today (`@rp/shared/state.ts`).
- **The app's CSP restricts `connect-src` to our origin** from the first client release.
- **The key-clearing change in §4.1.**

Not before phase 6: the loader, the registry, overrides, the out-of-process mode and the capability display.

## 6. Open questions

1. Server plugins: in-process, out-of-process, or the author's choice (§4.1)?
2. How far client overrides go: slots only, or replacing any `ui/` component by id?
3. Whether the stable tier gets semver promises from the first release, or only after phase 6 settles.
4. The key-clearing change (§4.1): adopt now?
