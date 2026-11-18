# Pi Subagent

Observable, persistent Pi subagents for independent reviews, investigations, and delegated implementation.

Each subagent runs in its own tmux session with a dedicated Pi JSONL session. The parent can inspect status, wait for durable results, steer active work, queue follow-ups, or attach directly to the child TUI.

## Requirements

- Pi
- Node.js 22.19 or newer
- tmux

## Install

Clone into Pi's global extension directory and expose the CLI on `PATH`:

```sh
git clone git@github.com:earendil-works/pi-subagent.git ~/.pi/agent/extensions/subagent
ln -s ../extensions/subagent/subagent.ts ~/.pi/agent/bin/subagent
```

Run `/reload` in an existing Pi session. The extension contributes its bundled skill automatically.

## Usage

Spawn with a descriptive name using the parent session's provider, model, and thinking level:

```sh
subagent spawn --name review --prompt "Review the current diff independently"
```

Names appear in the parent UI. Generated handles remain the stable identifiers used by management commands.

Override the model configuration when needed:

```sh
subagent spawn \
  --provider openai-codex \
  --model gpt-5.4-mini \
  --thinking low \
  --prompt "Find the relevant implementation"
```

Provide multiple prompt fragments and files:

```sh
subagent spawn \
  --file /tmp/spec.md \
  --prompt "Implement this specification" \
  --prompt "Run the targeted tests"
```

Restrict tools for a read-only investigation:

```sh
subagent spawn --tools read,grep,find,ls --prompt "Investigate the failure"
```

Manage a run by its generated handle:

```sh
subagent status a1b2c3
subagent rename a1b2c3 "error handling review"
subagent send a1b2c3 "Focus on error handling"
subagent send a1b2c3 --follow-up "Then summarize"
subagent interrupt a1b2c3
subagent wait a1b2c3
subagent stop a1b2c3
subagent list
```

Use `/subagent` to select and attach to an active child. The status widget shows active names (or handles for unnamed runs) and their current state. Press `←` on an empty prompt to open the same list without typing; when the prompt holds text, `←` still moves the cursor.

Inside a child, the exit key (`ctrl+q` unless configured) returns to the parent session, whether the child is idle or working. Detaching with `ctrl+b d` still works where the child was attached rather than switched to.

Pressing Esc aborts the parent turn and interrupts every child that is mid-work. Interrupted children keep their process and transcript; they return to idle and accept the next `subagent send`.

## Configuration

One JSON file, read by both the CLI and every child it spawns:

- `$PI_CODING_AGENT_DIR/subagents.json` applies to every project.
- `<cwd>/.pi/subagents.json` applies to one project and overrides the user file.

```json
{
  "defaults": { "provider": "magpie", "model": "mify/deepseek/deepseek-flash", "thinking": "low" },
  "presets": {
    "review": { "provider": "openai-codex", "model": "gpt-5.4-high", "thinking": "high" },
    "cheap": { "model": "mify/deepseek/deepseek-flash", "thinking": "off" }
  },
  "exitKey": "ctrl+q"
}
```

`subagent spawn --preset review` picks a named choice. Per field, a spawn flag wins over `--preset`, which wins over `defaults`, which wins over `PI_PROVIDER`, `PI_MODEL`, and `PI_REASONING_LEVEL`; thinking falls back to `medium`. Errors name the file they came from, and a broken file only warns, so spawn keeps working.

## Isolation

Optional spawn flags:

- `--tools <names>`: comma-separated tool allowlist
- `--no-extensions`: disable extension discovery while retaining the control bridge
- `--extension <path|builtin:name>`: load one more extension in the child; repeatable. Paths must exist, built-ins take the `builtin:` prefix (e.g. `builtin:codemode`)
- `--no-skills`: disable skills
- `--no-prompt-templates`: disable prompt templates
- `--no-context-files`: ignore repository instruction files

Nested subagents are disabled. Child sessions do not receive the subagent skill. Children survive `/reload`. When their spawning Pi session quits or is replaced, running children are suspended: the process stops, but transcript and metadata are kept. Resuming that parent session relaunches them idle with their full history. `subagent stop` removes a run permanently.

## Tests

The end-to-end test drives a real parent and child TUI in tmux, so it needs `tmux` and `pi` on `PATH`. It crafts a run directory by hand and makes no model call.

```sh
npm run test:e2e
```

When `tmux`, `pi`, or `node` is missing, the run exits 0 after printing `SKIP`.
