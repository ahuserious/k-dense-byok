# Local models (Ollama and OpenAI-compatible servers)

You can run Kady entirely against local models - no OpenRouter key required for those models. This is useful if you want to keep everything on your machine or experiment without spending on API calls.

Two kinds of local server are supported, and they appear as separate sections in the model picker:

| Server | Section | Model refs |
|---|---|---|
| [Ollama](https://ollama.com) | **Local (Ollama)** | `ollama/<name>` |
| Anything speaking the OpenAI API — LM Studio, vLLM, text-generation-webui, `llama.cpp` server | **Local (OpenAI-compatible)** | `openai-compatible/<model-id>` |

## Ollama setup

1. **Install Ollama and start the daemon:**

   ```bash
   # macOS / Linux
   curl -fsSL https://ollama.com/install.sh | sh
   ollama serve
   ```

   On Windows, download and run the installer from [ollama.com/download](https://ollama.com/download) — it starts the daemon for you.

2. **Pull one or more models:**

   ```bash
   ollama pull qwen3.6
   ollama pull qwen2.5-coder:7b
   ```

3. **Point Kady at the daemon.** Set `OLLAMA_BASE_URL` in the repo-root `.env` — `.env.example` ships the line commented out, so uncomment it:

   ```bash
   OLLAMA_BASE_URL=http://localhost:11434   # or wherever your daemon listens
   ```

   This is required even on the default port. Kady used to assume `http://localhost:11434` and probe it on every install, which meant a machine running Ollama for something else had its models enumerated by an app that was never pointed at it (#64). With the variable unset the backend makes no request and the **Local (Ollama)** section stays empty; the cost of that is this one line.

4. **Pick the model in the app.** Open the model dropdown in the chat input. Pulled models appear under the **Local (Ollama)** section at the bottom. Picking one routes Kady - and any subagents it spawns - through your local daemon.

The list is populated live from Ollama's `GET /api/tags` endpoint (via the backend's `/ollama/models` route), so pulling a new model and re-opening the dropdown is enough - no app restart needed.

To make a local model the default for every new chat, set in `.env`:

```bash
DEFAULT_MODEL_PROVIDER="ollama"
DEFAULT_MODEL_ID="llama3"   # any model you've pulled
```

## OpenAI-compatible server setup (LM Studio, vLLM, …)

Any local server exposing the standard `GET /v1/models` and `POST /v1/chat/completions` endpoints works. Like the Ollama section above, it stays off until you name a server:

1. **Start your server and load a model.** In LM Studio that's the *Developer* tab → *Start Server*; with vLLM it's `vllm serve <model>`.

2. **Point Kady at it** in the repo-root `.env`:

   ```bash
   OPENAI_COMPATIBLE_BASE_URL=http://localhost:1234   # LM Studio's default port
   ```

   The section is switched on by setting the variable, and nothing is probed until you do. **vLLM defaults to port 8000, which is Kady's backend port** — move one of the two, e.g. `vllm serve <model> --port 1234`.

3. **Pick the model in the app.** Loaded models appear under **Local (OpenAI-compatible)**. The list comes from your server's `/v1/models` (via the backend's `/openai-compatible/models` route), so loading a different model and re-opening the dropdown is enough — no app restart.

To make one the default for every new chat:

```bash
DEFAULT_MODEL_PROVIDER="openai-compatible"
DEFAULT_MODEL_ID="qwen/qwen3-8b"   # exactly as your server reports it
```

Notes:

- **One server at a time.** There is a single base URL, as with Ollama. If you run both LM Studio and Ollama, both sections appear — but not two OpenAI-compatible servers.
- **Local servers only.** These models are treated as free and are never counted against a project spend cap. Pointing the base URL at a paid hosted gateway would leave that spend untracked and uncapped. For hosted gateways that mirror OpenRouter's model ids, use `OPENROUTER_BASE_URL` instead — those keep catalogue pricing and stay inside the cap.
- **Only the model id is read** from `/v1/models`. Servers disagree on every other field, so context length and pricing use the same defaults as Ollama (32K, $0), and thinking levels are disabled.

## Caveats

Local models are fully supported, but skill-heavy work leans on model quality (see [Known limitations](./limitations.md)):

- **Tool-calling fidelity is noticeably weaker** on sub-frontier models.
- **Skills that rely on multi-tool choreography** (running scripts, chaining file edits, producing structured output) are the most fragile.

If a task loops or ignores its skill, try a **larger local model** (or temporarily switch back to an OpenRouter-hosted model) before assuming the workflow is broken.
