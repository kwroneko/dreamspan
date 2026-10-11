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

Phase 0 (foundations). The scaffold runs: a typed RPC server over WebSocket, SQLite in worker threads, auth, and a placeholder client. [ARCHITECTURE.md](ARCHITECTURE.md) describes what's implemented.

```bash
npm install
npm run build        # the client
npm start            # http://127.0.0.1:8080, data in ./data
npm run check        # typecheck, lint, format, tests
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
