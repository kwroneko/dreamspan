# Dreamspan

A self-hosted roleplay app for desktop and phone browsers. Bring your own model connection and start a story with one character or a whole cast.

Dreamspan keeps the original chat as automatic summaries make room for new turns in the model's context. You can edit a message, try a different reply, branch the story, or follow a side thread. Chats, character cards, personas, lorebooks and prompt presets can come with you from SillyTavern.

**0.1.0** is the first tester release. Start with the [user guide](docs/GUIDE.md), see what's included in the [changelog](CHANGELOG.md), or read the [Docker setup](docker/README.md) and [upgrade and rollback runbook](docs/ROLLBACK.md) to host a copy.

## Quick start from source

From the repository root, with Node.js 24.11 or later and npm:

```bash
npm ci
npm run build
NODE_ENV=production npm start
```

Open the local address on port 8080 over HTTP. By default Dreamspan listens only on loopback and stores its data in `./data`. Settings → Account lets you set a password for the local admin account.

## Development

Run `npm run dev:server` and `npm run dev:client` in separate terminals. Vite runs on port 5173 and proxies to the server. Run `npm run check` for static checks and fast tests, and `npm run test:slow` for the slow suite.

[ARCHITECTURE.md](ARCHITECTURE.md) describes the implemented system. Design documents:

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
NODE_ENV=production npm start
```

`NODE_ENV=production` runs the bundled database workers. While no account has a password, a browser on the same machine opens as admin. After setting a password, sign in with it. Set `DATA_DIR` to store the data elsewhere on a local disk. Syncing a live SQLite database through a cloud drive can corrupt it.

`llama-server` and `mlx_lm.server` also default to port 8080. Start them on another port (below), or move this one with `PORT=8090`.

**Start the model server** on loopback:

| Server | Command | Base URL |
|---|---|---|
| LM Studio | Developer tab → Start server (load the model with the context length you want) | The model server's local HTTP address on port 1234, ending in `/v1` |
| llama.cpp | `llama-server -m model.gguf -c 32768 --jinja --port 8081` | The model server's local HTTP address on port 8081, ending in `/v1` |
| MLX | `mlx_lm.server --model <path or Hugging Face id> --port 8081` | The model server's local HTTP address on port 8081, ending in `/v1` |

**Add the connection:**

1. Settings → Connections → New connection.
2. Choose OpenAI Chat Completions and enter the model server's base URL ending in `/v1`. Leave the API key blank if the server doesn't require one.
3. Run **Test**, choose the default model for new chats, then select **Create connection**. If the server doesn't list the model, type its model ID.
4. To change the default later, go to **Settings → Chats → Default model**. Use the chat's model picker to choose a model for that chat.

**Context size.** A model whose window isn't reported shows `128k context (assumed)` and its cost stays unknown. Set its actual context window with Edit on the connection's page to match what the server loaded (`-c` for llama-server, the context length in LM Studio). Requests use that model's window; its optional "Context to send" setting can lower the limit. Prompt presets don't set the context size. Token counts are estimates, so leave some room below a local server's loaded window.

**Long prompts.** A local model can take minutes to read a long prompt before it sends a token, more so the first time a chat is sent, before the server has it cached. The app waits up to 30 minutes for a response to start, or between its chunks. Stop cancels at any time.
