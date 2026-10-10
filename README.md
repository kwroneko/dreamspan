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

Design phase. No code yet.

- [spec/OVERVIEW.md](spec/OVERVIEW.md): goals, non-goals, principles, stack.
- [spec/DESIGN.md](spec/DESIGN.md): requirements and design decisions by area, each marked decided, proposed or open.
- [spec/PLAN.md](spec/PLAN.md): phased implementation plan and open questions.
- [spec/DATA-MODEL.md](spec/DATA-MODEL.md): the data model (phase 0).
- [spec/CLIENT-FRAMEWORK.md](spec/CLIENT-FRAMEWORK.md): client framework evaluation, performance harness, design-system timing (phase 0).
- [spec/EFFECT.md](spec/EFFECT.md): Effect across the stack (phase 0).
- [spec/STORAGE.md](spec/STORAGE.md): storage engine, SQLite vs Turso (phase 0).
