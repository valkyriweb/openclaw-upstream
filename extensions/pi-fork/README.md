# pi-fork

OpenClaw agent harness plugin that routes turns through [pi-mono-fork](~/Projects/personal/pi-mono-fork) — Luke's fork of the pi coding-agent CLI.

## How it works

```
OpenClaw (Cora)                    Pi (pi-mono-fork)
─────────────────                  ─────────────────
session created        →  spawn:  pi --mode rpc --cwd <dir>
send user message      →  stdin:  { type: "prompt", message: "..." }
                       ←  stdout: message_update events (streaming)
                       ←  stdout: tool_execution_start/end events
                       ←  stdout: agent_end event
return result to Cora  ←  collected from events
```

One persistent pi process is kept per OpenClaw session. Pi owns:

- **Tool execution** — bash, read, write, grep, find, agent, etc.
- **Session history & compaction** — pi's own session files under the managed OpenClaw Pi agent dir
- **Model routing & auth** — the spawned Pi runtime's managed `settings.json`

OpenClaw owns:

- **Channel delivery** — message routing to WhatsApp, web, etc.
- **Transcript mirroring** — visible chat history
- **Session selection & reset** — `new_session`, fork, reset commands

## Context-efficiency direction

By default this plugin forwards OpenClaw's prompt unchanged. You can explicitly opt into lean automation prompts:

- **interactive/user turns** still receive the full OpenClaw-composed prompt
- **heartbeat/cron turns** are reshaped only when `promptContextMode` is set to `lean-automation`
- `leanPromptTriggers` lets you choose which automation lanes are eligible
- pi remains responsible for its own stable system/bootstrap context and on-demand file reads

See `extensions/pi-fork/CONTEXT_EFFICIENCY.md` for the current spec and rollout plan.

## Installation

This is an in-repo bundled plugin (like `extensions/codex`). It is not published to ClawHub.

## Configuration

Add to `openclaw.json`:

```json
{
  "plugins": {
    "allow": ["pi-fork"],
    "config": {
      "pi-fork": {
        "command": "/Users/luke/.local/bin/pi"
      }
    }
  },
  "agents": {
    "defaults": {
      "model": "pi-fork/claude-opus-4-7",
      "models": {
        "pi-fork/claude-opus-4-7": {
          "agentRuntime": { "id": "pi-fork" }
        }
      }
    }
  }
}
```

### Pi binary resolution order (no `command` needed if already on PATH)

1. `config.command` (if set)
2. `~/Projects/personal/pi-mono-fork/packages/coding-agent/dist/cli.js` (via `node`)
3. `~/.local/bin/pi`
4. `pi` on PATH

### Plugin config options

| Field                    | Default                                                         | Description                                                                   |
| ------------------------ | --------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `command`                | auto-detected                                                   | Path to pi binary or `dist/cli.js`                                            |
| `args`                   | `[]`                                                            | Extra argv before `--mode rpc`                                                |
| `turnTimeoutMs`          | `300000`                                                        | Max ms per turn before abort                                                  |
| `promptContextMode`      | `"full"`                                                        | Prompt passthrough by default; set `"lean-automation"` to enable lean prompts |
| `leanPromptTriggers`     | heartbeat + cron                                                | Automation triggers eligible for lean prompts when enabled                    |
| `myPiHarnessPackagePath` | `~/Projects/personal/my-pi/packages/my-pi-harness` when present | Package loaded through the spawned Pi `settings.json`                         |
| `piAgentDir`             | `$OPENCLAW_HOME/pi-fork-agent`                                  | Managed Pi config dir containing the generated `settings.json`                |

The plugin writes `<piAgentDir>/settings.json` with exactly the configured `my-pi-harness` package. That profile loads `pi-agents` and `pi-observability`; it does not load `pi-agent-ui` or human UX plugins. Per-deployment extras remain available through `PI_HARNESS_EXTENSIONS=/path/a.js,/path/b.js`, which expands to `pi -e <path>` args.

Lean automation example:

```json
{
  "plugins": {
    "config": {
      "pi-fork": {
        "promptContextMode": "lean-automation",
        "leanPromptTriggers": ["heartbeat"]
      }
    }
  }
}
```

## Model refs

The `pi` synthetic provider exposes built-in model refs:

| Ref                         | Model                        |
| --------------------------- | ---------------------------- |
| `pi-fork/claude-opus-4-7`   | Claude Opus 4.7 (pi default) |
| `pi-fork/claude-sonnet-4-5` | Claude Sonnet 4.5            |
| `pi-fork/claude-haiku-4-5`  | Claude Haiku 4.5             |

Any model id that the installed pi binary supports can be used via `/model`.

## Explicit harness pinning

To ensure a specific agent always uses pi and fails hard if pi is unavailable:

```json
{
  "agents": {
    "list": [
      {
        "id": "pi-cora",
        "model": "pi-fork/claude-opus-4-7",
        "models": {
          "pi-fork/claude-opus-4-7": {
            "agentRuntime": { "id": "pi-fork" }
          }
        }
      }
    ]
  }
}
```

## Verification

```bash
# Check plugin is discovered
openclaw plugins inspect pi-fork --runtime

# Run a smoke turn
openclaw agent --message "reply with: pi ok" --model pi-fork/claude-opus-4-7
```

## Limitations

- Pi's native tools (bash, file I/O, agent) run inside pi's own security sandbox — OpenClaw tool approvals do not gate pi-native tool calls.
- OpenClaw cannot inject dynamic tools (MCP, plugin-registered tools) into pi's tool loop in this release. Pi uses its own tool set.
- The `pi` provider lists a static model catalog; actual available models depend on the installed pi binary's auth state.
- Compaction is managed by pi, not OpenClaw's compaction provider. Pi's own auto-compaction settings apply.
