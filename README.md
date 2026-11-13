# rp-harness (working name)

A browser-based agentic roleplay harness meant to replace SillyTavern (ST) for people who want more than a chat UI. It runs on a server, is used remotely from any browser, and must eventually work well on phones.

Its main feature is LCM-style hierarchical summarization: chats of unlimited length with a fixed, cache-friendly context budget, and nothing lost. Around that, it rebuilds what ST does badly:

- Chats are first-class objects with any number of cards.
- Personas are just cards.
- Message versions can be swapped in place, branched, or run as parallel threads.
- Edits never destroy anything.
- The web app behaves like a web app: URLs, multiple tabs, concurrent generations.

It stays compatible with what users already have: ST cards, chat-completion presets, lorebooks, and whole ST data folders.

## Status

Built through the Phase 3 LCM implementation (2026-10-30): ST imports, streaming roleplay chats, independent forks and message versions, library editors, protected drafts, image input and context estimates, and hierarchical summarization. Agentic RP and workshop features remain planned. [ARCHITECTURE.md](ARCHITECTURE.md) describes what's implemented.

```bash
npm install
npm run build        # the client and the database worker bundles
npm start            # http://127.0.0.1:8080, data in ./data
npm run check        # typecheck, lint, format, the fast tests
npm run test:slow    # scale, model-based, timing and process-spawn tests
```

For development, run `npm run dev:server` and `npm run dev:client` (Vite on :5173, proxying to the server).

Design documents:

- [spec/OVERVIEW.md](spec/OVERVIEW.md): goals, non-goals, principles, stack.
- [spec/DESIGN.md](spec/DESIGN.md): requirements and design decisions by area, each marked decided, proposed or open.
- [spec/PLAN.md](spec/PLAN.md): phased implementation plan and open questions.
- [spec/DATA-MODEL.md](spec/DATA-MODEL.md): the data model (phase 0).
- [spec/CLIENT-FRAMEWORK.md](spec/CLIENT-FRAMEWORK.md): client framework evaluation, performance harness, design-system timing (phase 0).
- [spec/EFFECT.md](spec/EFFECT.md): Effect across the stack (phase 0).
- [spec/STORAGE.md](spec/STORAGE.md): storage engine, SQLite vs Turso (phase 0).
- [spec/PROVIDERS.md](spec/PROVIDERS.md): the provider layer on pi-ai 1.x, as a delta from reference-harness (phase 0).
- [spec/PLUGINS.md](spec/PLUGINS.md): plugin threat model and structure.
- [spec/CORDIS.md](spec/CORDIS.md): Cordis evaluated as the plugin kernel (not adopted).

## Running on a laptop, offline

Natively, without Docker, against a model server on the same machine: LM Studio, llama.cpp's `llama-server` or `mlx_lm.server`. Checked on Linux with no network but loopback; macOS (Apple silicon) is expected to work the same way, since nothing at runtime is native but Node's own SQLite.

**Before you lose the network:**

1. Install Node 24 (24.11 or later), from nodejs.org or a version manager. Check that its SQLite has full-text search, which the app needs:
   ```bash
   node -e "new (require('node:sqlite').DatabaseSync)(':memory:').exec('CREATE VIRTUAL TABLE t USING fts5(x)')"
   ```
   No output means it's fine. A Node built against another SQLite (some package managers do this) may fail here.
2. In the repository: `npm ci`, then `npm run build`. Nothing after this needs the network: the client loads no fonts or scripts from elsewhere, and the server has no update checks, telemetry or remote model catalogs.
3. Download the model weights and check that the model server starts.
4. If you want your SillyTavern characters and presets, import them now (Import, or "Import a SillyTavern folder" there). You'll want a preset whose context size you can set (below).

**Start it:**

```bash
NODE_ENV=production npm start    # http://127.0.0.1:8080, data in ./data
```

`NODE_ENV=production` runs the bundled database workers (about half the memory); without it the server runs them from source, which also works. No other environment is needed: the server listens on `127.0.0.1` only, and while no account has a password, a browser on the same machine is the admin without logging in. If you set a password, you log in as usual. `DATA_DIR=/some/dir` keeps the data elsewhere. Keep it out of iCloud Drive, Dropbox and other synced folders: syncing a live SQLite database can corrupt it, and on macOS the server can't detect them as it does network filesystems on Linux.

`llama-server` and `mlx_lm.server` also default to port 8080. Start them on another port (below), or move this one with `PORT=8090`.

**Start the model server** on loopback:

| Server | Command | Base URL |
|---|---|---|
| LM Studio | Developer tab → Start server (load the model with the context length you want) | `http://127.0.0.1:1234/v1` |
| llama.cpp | `llama-server -m model.gguf -c 32768 --jinja --port 8081` | `http://127.0.0.1:8081/v1` |
| MLX | `mlx_lm.server --model <path or Hugging Face id> --port 8081` | `http://127.0.0.1:8081/v1` |

**Add the connection:**

1. Settings → Connections → New connection.
2. Provider: OpenAI Chat Completions. Base URL: the one above, with `/v1`. API key: No key (or the key you gave the server). Create connection.
3. Check: it should say "It works" and list the model. Then Models → Refresh from provider. A model the server doesn't list can be added with Add a model.
4. Settings → Chats → Default model: pick it. Or set a model per chat in the chat's side panel.

**Context size.** A model whose window isn't reported shows `128k context (assumed)` and its cost stays unknown. Set its actual context window with Edit on the connection's page to match what the server loaded (`-c` for llama-server, the context length in LM Studio). Requests use that model's window; its optional "Context to send" setting can lower the limit. Prompt presets don't set the context size. Token counts are estimates, so leave some room below a local server's loaded window.

**Long prompts.** A local model can take minutes to read a long prompt before it sends a token, more so the first time a chat is sent, before the server has it cached. The app waits up to 30 minutes for a response to start, or between its chunks. Stop cancels at any time.
