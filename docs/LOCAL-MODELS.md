# Using local model servers

Dreamspan can connect to any OpenAI-compatible model server running on your machine or local network, including LM Studio, `llama.cpp` (`llama-server`), and MLX (`mlx_lm.server`). Once dependencies are installed and built (`npm ci && npm run build`, or after one `npm start`), Dreamspan runs offline with no external fonts or scripts.

## Ports

`llama-server` and `mlx_lm.server` default to port `8080`, the same port as Dreamspan. Either start the model server on another port (such as `8081`) or start Dreamspan with `PORT=8090`.

## Start the model server

| Server | Example command | Base URL |
| --- | --- | --- |
| LM Studio | **Developer** tab → **Start server** (set the context length you want) | `http://127.0.0.1:1234/v1` |
| llama.cpp | `llama-server -m model.gguf -c 32768 --jinja --port 8081` | `http://127.0.0.1:8081/v1` |
| MLX | `mlx_lm.server --model <path or Hugging Face id> --port 8081` | `http://127.0.0.1:8081/v1` |

## Add the connection in Dreamspan

1. Open **Settings → Connections → New connection**.
2. Choose **OpenAI Chat Completions** and enter the server's base URL ending in `/v1`. Leave the API key blank if the server does not require one.
3. Click **Test**, pick a default model for new chats, and click **Create connection**. If the server does not list models, enter the model ID manually.
4. To change the default later, go to **Settings → Chats → Default model**, or pick a model per chat from the chat's model picker.

## Context size and timeouts

- **Context window:** If the model server does not report a model's context size, Dreamspan shows `128k (assumed)`. Edit the model on the connection page and set its **Context window** to match what your server actually loaded (`-c` for `llama-server`, or the context length in LM Studio). You can also lower the per-request **Context** limit without changing the model's window. Leave a little headroom below the server's loaded window since local token counts are estimates.
- **Slow first token on long prompts:** Local models can take minutes to evaluate a long prompt before streaming the first token (especially on a cold cache). Dreamspan waits up to 30 minutes for a response to start or between chunks; you can click **Stop** at any time.
- **SQLite FTS5 check (custom Node builds):** Official Node.js 24 builds include SQLite FTS5. If a distro-packaged Node fails to start with a SQLite FTS5 error, verify with:
  ```sh
  node -e "new (require('node:sqlite').DatabaseSync)(':memory:').exec('CREATE VIRTUAL TABLE t USING fts5(x)')"
  ```
- **Data directory:** Set `DATA_DIR` to store data elsewhere on a local disk. Avoid placing a live SQLite database inside a cloud-synced folder (Dropbox, iCloud, OneDrive), which can corrupt it.
