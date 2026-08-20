# Model presets

A **model preset** is a saved bundle of *provider + model + call parameters* that you can select anywhere Kady asks you
to choose a model.

Presets exist so that "which model does this use?" is a decision you can change in one place, at any time, rather than a
constant somewhere in the code. Anything that references a preset stores its **id** and asks the server to resolve it at
the moment it dispatches — so editing a preset changes every consumer at once, and deleting one makes those consumers
fail with a message rather than quietly run on some other model.

Where to find them: **Settings ▸ Model providers ▸ Model presets**.

---

## Provider groups

The section groups presets by provider. There are eight groups:

| Group | How you configure it | Notes |
|---|---|---|
| **Cerebras** | set `CEREBRAS_API_KEY` | billed per token |
| **OpenAI** | connect the ChatGPT subscription under Settings ▸ Model providers | OAuth |
| **OpenRouter** | add the OpenRouter key under Settings ▸ API keys (`OPENROUTER_API_KEY`, or `OR_API_KEY`) | billed per token |
| **Anthropic** | connect the Claude subscription under Settings ▸ Model providers | OAuth; metered extra usage |
| **Groq** | set `GROQ_API_KEY` | billed per token |
| **xAI** | connect the xAI subscription under Settings ▸ Model providers | OAuth |
| **Local** | set `OLLAMA_BASE_URL` or `OPENAI_COMPATIBLE_BASE_URL` to your own server | runs on your hardware, $0 |
| **Modal** | set `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` | remote GPU compute, not a chat endpoint |

A group you have not configured is **shown, not hidden**, marked "Not configured", and tells you exactly which variable
to set or which subscription to connect. You can still write a preset against it; you just cannot run it yet.

**An unconfigured provider is never contacted.** Kady does not probe an address to find out whether a key works, and it
ships no default address for any provider — a provider with no key is simply not registered, so a request to it is
refused before it is built. This is the rule established by three earlier defects (#44, #57, #64) and it is enforced by
tests that assert *no outbound request was made*, not merely that an empty list came back.

Environment variables are referred to by **name** throughout Kady. Their values are never logged, echoed into an error
message, or returned by an API.

---

## What a preset holds

- **Name** — anything you like, up to 80 characters.
- **Provider** — one of the eight groups above.
- **Model id** — the provider's own id, e.g. `llama-3.3-70b-versatile` for Groq, `anthropic/claude-opus-4.8` for
  OpenRouter. A **Local** model id names its server: `ollama/llama3`, `openai-compatible/qwen/qwen3-8b`.
- **Hyperparameters** — temperature, top p, max tokens, reasoning level, seed. Every one is optional; leaving a field
  empty means "send nothing and let the provider use its default".
- **System-prompt override** — replaces the system prompt. When set, it is sent as the **only** system message; it is
  not appended alongside a default one.
- **Modal presets only** — a Hugging Face model id and a GPU count (see below).

### Parameters your provider will not accept

Not every provider accepts every parameter. Groq and Cerebras take no reasoning level; Anthropic takes no seed; a Modal
preset takes none of them, because it describes a GPU job rather than a chat call.

Where a provider will not accept a parameter, the control is **disabled and says why** — for example "Groq does not
accept a reasoning level." It is never left live over a value that would be discarded.

---

## Where a preset's parameters actually apply

This is the part worth reading carefully, because it is the part Kady has got wrong before.

Every surface uses the preset's **provider and model**. Not every surface currently carries its **hyperparameters** and
**system-prompt override**:

| Surface | Provider + model | Hyperparameters & system-prompt override |
|---|---|---|
| **Test preset** (the ▶ button in Settings) | carried | **carried on Cerebras, Groq and OpenRouter only** — see below |
| **Chat and runs** | carried | **both carried on Cerebras, Groq, OpenRouter and Local; system prompt only on OpenAI, Anthropic and xAI; Modal is not a chat model** |
| **Workflow nodes** | carried | not carried — nodes use their own settings |
| **Hosted Fusion nodes** | carried | not carried — nodes use their own settings |

**Test preset is not available for every provider group, and the section says so per group.** Kady builds that call
itself, as an OpenAI-shaped chat completion authenticated with an API key from an environment variable. So it can send
it for **Cerebras, Groq and OpenRouter**, and it cannot send it for:

- **OpenAI, Anthropic and xAI** — connected with a subscription login rather than an API key, and two of the three do
  not use the OpenAI chat-completions wire format at all.
- **Local** — configured with a base URL (`OLLAMA_BASE_URL` / `OPENAI_COMPATIBLE_BASE_URL`) rather than a credential.
- **Modal** — a compute job rather than a chat model. Use **Run on Modal** instead.

For those five, the ▶ Test button is **disabled with that reason visible on the group's row**, and the binding table
reports the parameters as not carried there. The preset's provider and model still apply wherever you select it.

The section shows all of this live, from the server, so it cannot drift out of date. The same information comes back on
every `resolve` call as a `binding` block, and on `GET /model-presets` as `bindingsByGroup`, so any part of Kady that
offers you a preset can enforce the same rule without re-deriving it.

Use **Test preset** to see exactly what Kady sends: the result names the address, the model id and the sampling values
that went on the wire. On chat, Kady replaces the turn's effective system prompt through Pi's
`before_agent_start` hook. It applies hyperparameters after Pi serializes an OpenAI-shaped provider request; OAuth
sampling remains disabled because those transports have provider-specific constraints that the group-level preset
editor cannot safely guess.

---

## Modal presets

A Modal preset describes a **Hugging Face model to load onto a number of GPUs**, rather than a chat endpoint:

- **Hugging Face model** — **chosen from a search of the Hugging Face hub**, not typed. The editor searches through
  Kady's Hugging Face integration; when that integration is not configured the chooser is **disabled** and tells you to
  set `HF_TOKEN`, and when the integration is not present in your build it says that instead. There is deliberately no
  free-text fallback: a model id Kady could not check is a value that looks saved and is not. The stored id is
  re-checked for the `org/name` shape on the server.
- **Modal instance** — from Kady's existing Modal catalogue, served by the Modal API the Modal panel already uses.
- **GPU count** — a whole number, sent to the Modal job as its `gpuCount`. Its ceiling is the **selected instance's**
  maximum (an A10 accepts at most 4, an H100 at most 8). A **CPU instance has no GPUs**, so with one selected — or with
  no instance selected, which means Modal's CPU default — the stepper is **disabled at 1** with that reason.

Modal presets do not appear in the chat model picker and cannot be sent as a completion. Instead of ▶ Test they carry
**Run on Modal**, which creates a Modal job that loads the preset's Hugging Face model at the preset's GPU count, on the
**same** Modal job path the Modal panel uses. Modal credentials come from the same single path everything else Modal
uses (`MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`); there is no second credential path for presets. See
`docs/modal-compute.md`.

---

## Using a preset

Saved presets appear at the top of the model picker under **Model presets**. Selecting one dispatches to that preset's
provider and model. If its provider is not configured, the entry is shown as unavailable rather than hidden, so you can
see why it will not run.

If you delete a preset that something was using, that something fails with a message naming the problem. It does not
fall back to a default model.

A Modal compute preset never becomes a chat model. Generic resolution refuses
`preset/<id>` and the stored `modal/<hugging-face-id>` ref before the
unknown-prefix OpenRouter compatibility path can reinterpret them.

### What is bound today, and what is not

`POST /model-presets/:id/resolve` returns a binding block per surface. Honour it:
a `dropped` control must not look live.

- **Test preset (`direct`)** — bound for Groq, Cerebras, and OpenRouter. OAuth,
  Local, and Modal stay dropped with a reason.
- **Chat and runs** — the preset's provider and model resolve. Hyperparameters
  and the system-prompt override wait for the session builder to install Kady's
  model-preset extension (`CHAT_SESSION_PRESET_EXTENSION_INSTALLED` in
  `server/src/agent/model-presets.ts`). Dest does not have that wiring.
- **Workflow nodes** — persist `{ provider: "preset", model: "<preset-id>" }` on
  the existing ModelRequest. That resolves to the preset's provider and model.
  Sampling and the system-prompt override still come from the node's own
  settings because ModelRequest has no control fields.
- **Hosted Fusion** — still dropped. Hosted Fusion accepts only a fixed
  OpenRouter ModelRequest, which has no durable preset id.

---

## API

Base path `/model-presets` on the Kady backend (no `/api` prefix).

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/model-presets` | — | `{ presets, groups, bindingsByGroup }` |
| `GET` | `/model-presets/bindings` | — | `{ bindingsByGroup, groups }` |
| `POST` | `/model-presets` | preset input | the created preset (201) |
| `PATCH` | `/model-presets/:id` | partial preset input | the updated preset |

On `PATCH`, an **absent** key means "leave this as it is" and an explicit **`null`** means "clear it". Send
`{"systemPromptOverride": null}` to remove an override, `{"hyperparameters": null}` to remove all of them, and
`{"modal": null}` when moving a preset off the Modal group.
| `DELETE` | `/model-presets/:id` | — | `{ ok: true }` |
| `POST` | `/model-presets/:id/resolve` | `{ surface? }` | the resolved preset + `binding` + `bindingBySurface` |
| `POST` | `/model-presets/:id/test` | `{ prompt? }` | the outbound request, the status, and the reply |
| `POST` | `/model-presets/:id/modal-job` | no body | the created Modal job's id, state and prepared request (202) |

`surface` is one of `direct`, `chat-session`, `workflow-node`, `hosted-fusion-supervised`; it defaults to `direct`.

`resolve` fails closed: an unknown id returns 404, and a preset whose provider is unconfigured returns 409 with the
message naming the variable to set. Neither contacts a provider.

### Referencing a preset from elsewhere in Kady

1. Persist the preset **id** only — never a copy of its contents.
2. At dispatch time, `POST /model-presets/:id/resolve` and use `ref`, `hyperparameters` and `systemPromptOverride`.
3. Honour `binding`: render disabled-with-reason anything reported `dropped`, and never send a dropped value as though
   it had landed. `binding` is per **provider group** as well as per surface — do not cache one group's verdict and
   apply it to another.
4. On 404 or an unconfigured provider, fail closed with the returned message.

Presets are stored in `model-presets.json` under Kady's own home directory — outside every project sandbox, because a
preset is a decision about which model to use, not a property of one project.
