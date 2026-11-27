# Dreamspan

A self-hosted roleplay web app for desktop and mobile browsers. Bring your own model connection and run stories with one character or a whole cast.

## Features

- **Stories & casts:** Solo or multi-character chats with alternate replies (swipes), in-place message editing, branching, and side threads.
- **Long-context summaries & caching:** Automatic layered summaries keep long stories within the model's context window while keeping the full original transcript readable and preserving prompt caches.
- **Bring your own models:** Connect Anthropic, OpenAI, Google Gemini, DeepSeek, OpenRouter, AWS Bedrock, or OpenAI-compatible local servers (LM Studio, `llama.cpp`, MLX).
- **SillyTavern import & export:** Import character cards (PNG, JSON, CHARX), personas, lorebooks, chats, groups, and chat-completion presets, and export your chats or library back out.
- **Workshops, MCP & plugins:** Assistant workshops for drafting and editing cards, lorebooks, prompts, stories, and files, plus optional MCP tool servers and plugins.
- **Self-hosted & multi-user:** Runs locally or on your own server with SQLite, per-account libraries, and optional Docker sandboxing.

## Quick start

### Run locally (Node.js)

1. Install [Node.js 24](https://nodejs.org/) (24.11 or later, with `npm`).
2. Clone this repository or download and extract its source ZIP.
3. Start Dreamspan from the repository folder:

   | Platform | How to start |
   | --- | --- |
   | Windows | Double-click `Start.bat`. |
   | macOS | Double-click `Start.command` (if extracted from a ZIP, run `chmod +x Start.command` in Terminal first). |
   | Linux | Run `./start.sh` in a terminal. |

   You can also run `npm start` on any platform. The first run installs dependencies and builds the app automatically.

4. Open `http://127.0.0.1:8080`. By default Dreamspan listens only on loopback and stores data in `./data` (override with `DATA_DIR` and `PORT`). Go to **Settings → Account** to set a password for the local admin account, then add a model under **Settings → Connections**.

### Run with Docker

See [docker/README.md](docker/README.md) for a Docker Compose setup, reverse-proxy settings, and optional sandboxed workshop commands.

## Documentation

- [User guide](docs/GUIDE.md) — connecting models, importing from SillyTavern, summaries, workshops, and exports
- [Local model servers](docs/LOCAL-MODELS.md) — connecting LM Studio, `llama.cpp`, or MLX
- [Docker & self-hosting](docker/README.md) — container deployment, HTTPS proxy, and command sandboxing
- [Upgrade & rollback](docs/ROLLBACK.md) — backups, migrations, and recovery
- [Changelog](CHANGELOG.md)

## Development

Run `npm run dev:server` and `npm run dev:client` in separate terminals (Vite serves the client on port `5173` and proxies API traffic to the server). Run `npm run check` for static checks and fast tests, or `npm run test:slow` for the full suite. See [ARCHITECTURE.md](ARCHITECTURE.md) for codebase structure.
