# Using Dreamspan

Dreamspan is a browser-based roleplay app. You can play one or more characters, try different versions of a reply, and branch a story to see where it goes.

## Start Dreamspan on your computer

Install [Node.js 24](https://nodejs.org/) (24.11 or later, with npm), then clone Dreamspan or download and extract its source ZIP. Open `Start.bat` on Windows or `Start.command` on macOS. On Linux run `./start.sh` in the Dreamspan folder. You can also run `npm start` from that folder on any platform.

The first launch installs dependencies and builds the app. Leave the launcher running and open `http://127.0.0.1:8080` in your browser. If a one-click update is available, the launcher lets Dreamspan restart automatically once the update is ready.

## Sign in and write your first turn

Open the address your host gave you and sign in with your handle and password. If your host uses a separate sign-in page, follow that page. For a fresh local install, Dreamspan opens as admin on the same machine until you set a password under **Settings → Account**.

Home walks you through connecting a model, bringing in a character, and starting a chat. Open a character from the library to start. You can also create a card or browse a card source.

## Connect a model

1. In **Settings → Connections → New connection**, pick your provider. For a hosted model, create a key in the provider's dashboard. For example, use **API keys** in the OpenAI Platform, **API Keys** in the Anthropic Console, **API Keys** in Google AI Studio, or **Keys** in OpenRouter settings.
2. Under **API key**, enter a new key or choose one you saved in **Settings → Keys**. For a local model server, enter its base URL and leave the key blank if the server runs without one. Saved keys are restricted to the addresses you approve.
3. Run **Test**, choose a default model for new chats, then select **Create connection**. You can change the default under **Settings → Chats** or choose a model for one chat using its model picker.

Your model provider receives the context needed to answer, which may include messages, card details, lore and summaries. Your provider bills the account associated with the key.

## Import from SillyTavern

- **On a computer**, open **Import → Import a SillyTavern folder → Choose the folder**. Select your SillyTavern profile folder and review the import. This brings over supported characters, personas, chats, groups, lorebooks and chat-completion presets. Set up the provider key separately.
- **On a phone**, use **Import → Import files** for individual character cards (PNG, JSON or CHARX), lorebooks and chat-completion presets. To bring over existing chat history, use the folder importer from a desktop browser.

## Automatic summaries and costs

Dreamspan uses layered summaries, sometimes called LCM, to fit long stories into a model's context. Older messages are summarized, and groups of older summaries can be condensed again. You can still read the original messages in the chat. The model can miss details that a summary leaves out.

Use **This chat → Summarize older messages** to change a chat's setting. Imported chats start with summaries off. When you turn them on for a long chat, review the catch-up choices and any available estimate before starting. Set defaults, including the summary model, in **Settings → Chats → Summaries**.

Summarizing and condensing make separate model requests, which can add cost, especially during catch-up. Shorter context can save input tokens on later replies. The result depends on the models, their rates and how much context the provider caches. Open the chat's **Summaries** tab to see the summaries in use and jobs in progress. Use **Details** on a summary to see its requests, token usage and cost when available. **Settings → Costs** shows account usage.

## Workshops, MCP and plugins

Workshops are an experimental space for asking an assistant to work on cards, lore, prompts, stories or files. Review its changes and any permission requests. MCP lets you connect external tool servers. Only connect servers you trust with the data you allow them to receive. Plugins can change how Dreamspan works, and server plugins run trusted code. An admin reviews and approves the exact plugin version before turning it on.

## Take your data with you

Use **Export…** in the chat menu for one branch or all branches, or **Export the whole library** on the Import page for a SillyTavern-style ZIP. Chat JSONL keeps the transcript, swipes and available thinking and generation details. The library ZIP also includes cards, personas, lorebooks, presets and supported card notes. Workshops export as plain text from the chat menu.

SillyTavern export leaves out chat images, chat notes, summaries, edit history, deleted items, and Dreamspan's swipe flags and statuses. Threads and separate character contexts flatten into the transcript, so the export loses who could see what. The library ZIP also leaves out workshops, saved card assets and account settings, including API keys.

Ask your host about backups and account removal. Disabling an account blocks sign-in and keeps its saved data. A host who restores a pre-upgrade backup returns the instance to that point, so changes made after the backup are absent from the restored copy.

## Report a problem

Tell your tester contact or file an issue in the project repository. Include the version from **Settings → Server status**, your browser and device, the steps to reproduce it, what you expected, and the exact error if one appeared. Use a made-up chat or card to show the problem and remove keys, passwords and private content from screenshots and logs.
