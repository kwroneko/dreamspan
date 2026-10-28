# Plugins: threat model and structure

**Status**: Proposed, 2026-10-11. The owner's statements of 2026-10-11 are marked **[D]**. Supersedes the recommendation in [CORDIS.md](CORDIS.md), whose evaluation of Cordis itself still stands. Building the plugin system is PLAN phase 6. §8 lists what has to shape the code before then.

---

## 1. What the owner decided (2026-10-11)

**Scope and priority**
- **[D] Cordis isn't needed.**
- **[D] The ideal**, knowing something will have to give:
  - plugins can change almost anything
  - each user customizes the harness by asking their own agent inside the app
  - plugins survive harness updates
  - any plugin can be installed without worry
- **[D] Priority:** plugins could become a core benefit, possibly what turns a tool made for the owner into a standard platform. But they rank below getting the harness to work well without plugins; otherwise nobody will use it. Our side must not explode in complexity.
- **[D] Not limited to fixed integration points a priori.** The owner wanted DSH because everything there is a plugin. That's weighed against the cost of a fully generic design, and against forking.
- **[D] Forks are a real alternative.** Coding agents make a fork cheaper to maintain. A plugin is still easier than a fork, and plugins can be combined and distributed.
- **[D] Providers are a basic plugin surface:** custom providers, and provider-specific behavior such as cache breakpoints. A sidecar proxy can do some of this, but it's outside the app, less convenient and not shareable.

**Threat model**
- **[D] Running a plugin is the user's conscious choice to run code.** If a plugin steals keys, that's on the plugin.
- **[D] Our responsibility is that content never becomes code:** cards, presets, lorebooks, chats, model output and imported files. An RCE from a card is entirely on us (DESIGN §11).
- **[D] A plugin written by the user's own agent is the user's plugin.**
- **[D] Prompt injection is user error, not our vulnerability.** A card the user loads is effectively their own prompt (DESIGN §7.7).
- **[D] Three lines of attack to consider** (weigh mitigations, not guarantee safety):
  1. **Stealing AI provider credentials:** by far the most likely target, and as much a supply-chain risk as a plugin risk.
  2. **The user's system:** escaping the harness to damage or infect the machine. Docker with a non-root user covers deployment. Lower priority.
  3. **Exfiltrating the user's chats:** reading can't be prevented, but some plugins can be blocked from making web requests.

**Mechanics**
- **[D] Consent prompts only for actions that are infrequent and important,** like enabling a plugin. The agent can do all the work, and the final application is gated by explicit consent, as coding agents gate actions with permission prompts. Prompts the user has to approve constantly are to be avoided: coding agents largely replaced them with auto mode and sandboxing.
- **[D] Every plugin that isn't built in is a git repository.** This is mandatory, since everything else in the harness has non-destructive editing and version control built in. It's also what lets a coding agent keep a local fork of a broken upstream plugin.
  - registry installs are git repos by construction
  - the agent creates a repo for every extension it writes, and updates it by committing
  - folders and zips are imported by initializing a repo
- **[D] The kernel is the platform's opinionated core,** the technical choices rather than features someone might want to change. Example: the conversation storage format, with messages, immutability and versioning.
- **[D] To consider:** extensions adding their own metadata to messages, chats, cards and other items, and plugins declaring which surfaces they touch, so users can decline security-sensitive ones. Declared surfaces are hard to guarantee and may be dropped.
- **[D] Building the core from its own registries (§3) is accepted as the direction,** with the concern that it adds development complexity. Starting with it should make it cleaner than retrofitting.

## 2. What stays on our side

- **Import formats carry no capability grants [P].** A card's or preset's own fields can't enable tools, plugins or permissions; only the user does. This was Marinara's bug, and it doesn't limit the agent at all.
- **Content renders only in a sandbox** and is never evaluated (DESIGN §10.2, §11).

## 3. Structure

### 3.1 The core is built from its own registries [D direction, details P]

- **Every feature registers itself by a stable id,** through the same registries plugins use. A plugin can add, wrap, replace or disable any entry.
- **The core is the first client of every registry,** so the seams exist where the app actually has them. That counters the usual failure of plugin APIs, which don't anticipate what people need.
- **The cost to us is one registry per extension point,** plus the discipline of never wiring a feature in directly. That discipline is cheap if it starts now, and expensive to retrofit.

**Registries** (initial list, grown as features land):

| Area | Registries |
|---|---|
| Providers | Provider kinds (wire API adapter, defaults, model-list format, compat), request transforms (payload rewrites such as cache breakpoints), response observers (usage capture), cost formulas |
| Context | Assembler stages (DESIGN §5.1), macros, role projections, card layouts |
| Content | Importers and exporters, display rules, message renderers |
| Agent | Tools, orchestration modes, output contracts |
| Client | Routes, panels, composer actions, commands, slots in the message view, theme tokens |

### 3.2 The kernel: fixed, opinionated platform features [P]

These are choices the rest of the design depends on. They're replaced by forking, not by plugins.
- **Storage:**
  - the message graph, versions, state events, library revisions and refs
  - drafts, the recycle bin, the usage ledger
  - the invariants the database enforces (ARCHITECTURE §3.7)
- **Ownership and authentication.**
- **Secret storage:** the server secret, encryption, and the rule that keys never reach the browser.
- **The RPC transport, the worker architecture and the plugin host itself.**

**Not kernel:** providers, the assembler, the agent loop's strategies, the UI. Each is a set of core modules in registries, replaceable like any plugin.
- **For providers, that means a plugin can add a provider kind** with its own wire API (or reuse pi-ai's), list format and defaults. It can also add or replace request transforms, so a custom cache-breakpoint strategy is a plugin and not a sidecar proxy.
- **The kernel decrypts the key for each request,** and hands it to the provider implementation serving that request, built-in or plugin. A plugin provider sees the keys of the connections that use it, exactly as a built-in one does. Credentials are discussed in §6.1.

### 3.3 Plugin data on platform items [P]

Plugins attach metadata without changing the kernel's formats:
- **Cards, presets and other library documents:** a namespaced `extensions.<plugin-id>` object inside the document.
  - Character Card V2/V3 already reserve `data.extensions` for exactly this, so it survives import and export.
  - It's versioned with the document, and follows the three-way merge (ARCHITECTURE §3.9).
- **Chats:** namespaced state-event keys (`<plugin-id>/<key>`) with schemas the plugin registers. They sit on the graph like all chat state, so they're positioned per branch and versioned.
- **Messages:** annotations on a version, keyed by plugin and key, append-only with history.
  - Content stays immutable. An annotation is data about a version, like a plugin's score or tag, not a change to it.
  - **[O]** Whether annotations are needed before a concrete plugin asks for them.
- **Private plugin state:** a per-plugin storage namespace, never the core tables.

### 3.4 Overrides: the escape hatch [P]

- Every server capability is an Effect service, and a plugin can provide a layer that wraps or replaces one, like Emacs advice. Client components from `src/ui/` can be replaced by id.
- Overrides reach beyond the registries without an API designed for each case.
- **Compatibility has two tiers:**
  - **Stable:** registries and their contracts, versioned.
  - **Internal:** overrides and internal types, which may change in any release.

## 4. Plugins are git repositories [D, details P]

- **Where they live:** each plugin is a repo under `DATA_DIR/plugins/`. Enabling a plugin pins a commit, so nothing changes under the user without a new commit being enabled.
- **Upstream and local edits:**
  - A registry install tracks its upstream remote. Edits the user's agent makes are commits on a local branch.
  - An upstream update is fetched and merged. On conflicts the agent resolves them, much like a ref that follows another in the library.
  - That's how a broken plugin gets a local fix that survives later upstream updates.
- **Agent-written plugins** are repos from the start, with each change a commit.
- **Folders and zips** become a repo with an initial commit on import.
- **Built-in features can be forked into a repo:** the module's source is exported as a plugin that replaces the built-in id, and the user's agent changes it from there. The built-in keeps updating, and the fork shows when its base changed.
- **When an update breaks a plugin:**
  - The plugin is type-checked and bundled against the running version at startup. If it no longer compiles or fails to load, it's disabled and reported; the app keeps running.
  - The user's agent can repair it from the changelog and the types, committing the fix. Agents make repairs as cheap as they make forks, which is what makes the internal tier affordable.
- **[O] Git itself:** shelling out to a `git` binary (it would have to be in the Docker image) or a library such as isomorphic-git.

## 5. Consent and declared surfaces [P]

**When to prompt:**
- Prompts gate final application, never the work. The agent creates, edits, tests and commits plugins without asking.
- **A permission prompt appears when:**
  - a plugin is enabled
  - an enabled plugin's declared surfaces grow (below)
  - an update to an enabled plugin is applied
- **To keep prompts rare:**
  - **"Allow for this session":** while the user iterates on a plugin with their agent, its updates apply without asking again.
  - **[O]** A per-plugin setting to always apply its updates: "trusted" for a plugin the user maintains, or one from an author they trust.
- **There's no code review step in the prompt.** Users don't read the code, and a diff in a prompt is theater. The prompt says what the plugin will be able to touch.

**Declared surfaces: the simplest version that's honest.**
- A plugin's manifest lists the registries it uses (providers, context, tools, UI, storage), the services it overrides, and whether it runs server code.
- **Enforced for honest plugins:** the plugin host gives each plugin handles only to the registries it declared. So an update can't quietly start touching providers without the prompt saying so.
- **Not enforced against malicious server code:** in-process server code can import anything. So the prompt states plainly whether a plugin runs on the server ("full access to the server, including stored keys"), or only in the browser.
- **Browser-only plugins are contained less than it first seems.**
  - **What holds:** they can't read keys, since keys never reach the browser. And they can't send anything anywhere but our server, once the CSP restricts `connect-src` to our origin.
  - **But a plugin that runs in the page acts as the user.** It can call every RPC the user can, and it can click our own buttons, including a consent prompt. So a malicious in-page plugin could:
    - enable a server-side plugin and approve the prompt itself, which gives it full access
    - redirect a stored key (§6.1)
  - **In-page prompts are therefore not a boundary against code already in the page.** Only code that can't reach our page is contained, for example a widget in a sandboxed iframe that talks to the app through a narrow `postMessage` bridge.
  - **[O]** Whether to make enabling server-side code require something page script can't produce, for example confirming in a separate origin or in the CLI. That's probably too much friction for what it buys.
- **[O]** If declared surfaces turn out to mislead more than help, drop them.

**[D] A future sandboxed ("safe") plugin type** (owner, 2026-10-11): plugins that run in a sandbox and reach only certain hooks and APIs, never the main app process directly.
- This may become the main distinction in the end: full plugins versus sandboxed ones. It isn't needed now.
- Browser-only plugins resemble it, but their containment is accidental, not designed, and partial (above). **[D]** They aren't a trust category.
- If a browser-only category turns out not useful enough for its cost, it's dropped in favor of the sandboxed type later. Client-side code keeps existing, as the browser half of a full plugin.
- **[P] What the sandboxed type would offer:** the hooks that don't need the process, for example display rules, message renderers in iframes, macros, assembler stages working on data passed to them, and tools with declared effects. All through a narrow API (RPC or `postMessage`), with no access to keys, files or the page.

## 6. The three lines of attack [P]

### 6.1 Credentials (the most likely target)

- Keys never reach the browser (DESIGN §9), so browser-side plugins can't read them.
- **A gap independent of plugins: redirecting a stored key.** Anything that can call our RPCs as the user can change a connection's base URL, and the server then sends the stored key to the new host.

**What a fix would protect against:**

| Attacker | Steals keys without a fix | Steals keys with a fix | Why |
|---|---|---|---|
| A malicious in-page browser plugin | Yes: redirect the base URL | Only by escalating: enabling a server plugin through the in-page prompt (§5) | It can't read keys or send data off-origin |
| An XSS in our app (a sandbox escape in rendering) | Yes | The same escalation, if it can reach plugin management | Content becoming code is our responsibility, so this is defense in depth |
| A stolen session (a leaked cookie or proxy session) | Yes | No, though the attacker can still read chats and spend quota | It never sees a key |
| A server-side plugin, including request transforms | Yes, trivially | Yes, trivially | It runs in the process: `secret.key`, the outgoing headers, anything |
| Another user on the same instance | No | No | Ownership: someone else's connection is `NotFound` |
| A custom proxy to an `https` base URL | No | No | The proxy only sees a TLS tunnel. An `http` base URL exposes the key to any proxy. |

**So the fix is worth something only against a stolen session and an XSS,** plus in-page plugins that don't bother to escalate. It does nothing against server plugins, which remain full access by design. Its benefit is real but modest, so its cost in annoyance has to be small.

**[D] Decided and built (owner, 2026-10-11; ARCHITECTURE.md §3.12):** credentials bound to hosts, on by default, switchable only from outside the app (`KEY_HOST_BINDING`). Keys get more protection than chats because they're money, and easy key theft is what makes a frontend worth attacking.

**The design as proposed:**
, instead of clearing keys on edit. It also addresses the other annoyance, re-pasting the same key for a second endpoint on the same platform:
- **A key is stored once, as a named credential** (for example "OpenRouter" with hint `…4321`). Connections reference a credential instead of holding their own key.
  - A second connection on the same platform picks the existing credential from a list, so there's nothing to copy.
  - Replacing a key once updates every connection that uses it.
- **A credential remembers the origins it may be sent to** (scheme, host and port), which are recorded when the key is entered.
  - A path change on the same host (`/v1` to `/api/v1`) needs nothing.
  - Pointing a connection at a new origin requires typing the key again, once, to bind it there. Code without the key can't do that.
  - A consent prompt wouldn't work here: in-page code can click it.
- **The only time a user notices:** moving a key to a different host, which is rare and exactly the case that matters.
- **The cost:** a `credentials` table and a reference from connections. Today `connections` holds the key directly (migration 0005), and nothing stores real keys yet, so this is a cheap change now.
- **The alternative is no fix:** accept that a stolen session or an XSS can redirect keys, and say so. That's a defensible choice too, since a stolen session already exposes every chat.
- **Server plugins run in the server process,** so they can read `secret.key` and decrypt every stored key. In a multi-user instance that means every user's:
  - Server-side plugins are instance-wide code, installable only by an admin.
  - Per-user customization in a multi-user instance means declarative plugins now, and sandboxed plugins (§5) later.
- **Later, the sandboxed plugin type (§5)** covers this: it never holds the server secret and reaches the host only through its API. Full plugins keep in-process power, overrides and provider plugins included.
- **Supply chain:**
  - The same exposure applies to our own dependencies; pi-ai alone brings the OpenAI, Anthropic, Google and AWS SDKs.
  - In place: exact pins, the cooldown, and decryption only on the main thread.
  - Addition: review the dependency tree whenever an AI-related package is added or bumped.

### 6.2 The user's system

The Docker image runs as the unprivileged `node` user. Outside Docker, a later start mode could run the server under Node's permission model, with file access limited to the app and `DATA_DIR`. That's a seat belt, and low priority.

### 6.3 Exfiltrating chats

- Reading can't be prevented.
- **Browser-side code can't send anything but to our server,** once the CSP restricts `connect-src`. That has to hold from the first client release: no third-party origins at runtime, and HTML only in sandboxed iframes.
- **In-process server plugins can't be stopped from sending.** Their requests through `Network.fetchFor` are logged with their route.

## 7. Development cost

The owner's concern is complexity. What this structure adds to normal development:
- **One registry per extension point,** and registering features instead of calling them directly. That's a small, mechanical cost per feature.
- **Stable ids for core modules,** which tests and the request inspector benefit from anyway.
- **Nothing for the loader, git, prompts or overrides until phase 6.**

The rule that protects the main objective: a registry is added when a core feature needs a seam, never speculatively. The app is designed to work well with no plugins; plugins use the seams the app already has.

## 8. What has to shape the code now [P]

- **The provider layer becomes registries:**
  - `providerKinds` (today a static record in `@rp/shared/providers.ts`) and the wire API map in `Providers.ts` become a provider-kind registry
  - the Anthropic breakpoints and the usage capture become a registered request transform and a registered response observer
  - the kind column stays a string, validated against the registry when a connection is used, not by a closed literal list

  **Built** (2026-10-11, ARCHITECTURE.md §6): the generic registry in `src/registry.ts` and the provider registry, with the built-ins registered through it.
  - **Cost formulas** are a registry too (built 2026-10-11): the price table and the provider's reported cost are its first entries.
- **Phase 1–2 features register as modules with ids:** assembler stages, macros, importers, display rules, then tools.
- **What's deliberately not in registries:** everything built on 2026-10-11 besides cost formulas (accounts and login, exposure, the request guard, the graph's integrity rules) is kernel (§3.2). Each is an Effect service or layer, so it's still reachable through overrides (§3.4).
- **The client renders through slot registries** (message view, panels, composer actions). `src/ui/` stays the single import path for components.
  - **Routes too.** The route and slot registries were built with the first real screens, the settings and login pages, so they're shaped by real use.
  - **Built** (2026-10-11, ARCHITECTURE.md §5): both registries, with the login and settings screens as their first users and `connection.sections` as the first slot.
- **Namespaced chat state keys,** before the first extension needs them (`@rp/shared/state.ts` is a closed union today).
  - **Ids inside values must be declared.** The writer checks every id in a core key's value against the acting user (ARCHITECTURE §3.8). A plugin key (`<plugin-id>/<key>`) must therefore register, with its value schema, which fields hold entity, ref, revision or connection ids, so the same check covers it. Any other field is treated as free-form data: a plugin that reads an id from one must check ownership itself.

  **Built** (2026-10-28, ARCHITECTURE.md §3.8): `registerStateKey` registers a plugin key (`<plugin-id>/<key>`) with its schema, id declaration (checked by `stateKeyProblems`), positional or branch scope and optional reducer; the fold keeps its value in `ChatState.plugin`. **Not built:** running the registration in the writer and reader workers (the loader).
- **Library documents keep `extensions` as a namespaced object,** matching the card spec, when the importers are built.
- **The CSP restricts `connect-src` to our origin** from the first client release.

## 9. Later: review, authoring and the public registry

Written down now, built after the product works (owner, 2026-10-11):
- **[D] Registry admission:** agents scan every extension that applies to join the registry, including its dependencies, before it's admitted.
- **[D] A local review skill:** the user can ask their own agent to review an extension, and its dependencies, before enabling it.
- **[D] Optional GitHub app integration**, so non-developers can author and share:
  - the user makes a GitHub account and logs in to the harness with OAuth
  - their agent can then create and push repositories, and apply to the public registry, through a PR or another mechanism
  - agents review submissions automatically, and may approve them for inclusion
- **[P] The pieces this reuses:**
  - every plugin is already a git repo (§4), so publishing is a push
  - declared surfaces (§5) are what a reviewer agent checks the code against: "declares client-only, but imports a server module" is a finding
  - the local review skill is the same review the registry runs

## 10. Open questions

1. Applying updates to an enabled plugin: always prompt, prompt with "allow for this session", or a per-plugin "trusted" setting (§5)?
2. Declared surfaces: keep them as information for honest plugins, or drop them (§5)?
3. The sandboxed plugin type: its sandbox technology and hook set, when it's built (§5).
4. How far client overrides go: slots and registries only, or replacing any `ui/` component by id (§3.4)?
5. Git: the `git` binary or a library (§4)?
