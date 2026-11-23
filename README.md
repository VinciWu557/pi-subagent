# Pi Subagent

Observable, turn-scoped Pi subagents for independent reviews, investigations, and delegated implementation.

A fork of [badlogic/pi-subagent](https://github.com/badlogic/pi-subagent), adding presets, an interactive picker, a config file, and Esc-to-interrupt.

Each subagent runs in its own tmux session with a dedicated Pi JSONL session. The parent can inspect status, wait for durable results, steer active work, queue follow-ups, or attach directly to the child TUI.

## Requirements

- Pi
- Node.js 22.19 or newer
- tmux

## Install

Install as a Pi package from npm:

```sh
pi install npm:@vinciwu557/pi-subagent
```

Run `/reload` in an existing Pi session. The extension registers its bundled skill automatically.

The package also ships the `subagent` CLI. Pi links it at `~/.pi/agent/npm/node_modules/.bin/subagent`, and `~/.pi/agent/bin` is usually already on `PATH`, so expose it there:

```sh
ln -sf ~/.pi/agent/npm/node_modules/.bin/subagent ~/.pi/agent/bin/subagent
```

To track the repository instead of a published release, clone into Pi's global extension directory and expose the CLI on `PATH`:

```sh
git clone git@github.com:VinciWu557/pi-subagent.git ~/.pi/agent/extensions/subagent
ln -s ../extensions/subagent/subagent.ts ~/.pi/agent/bin/subagent
```

The clone path runs the TypeScript source directly. That only works outside `node_modules`: Node refuses to strip types from installed packages, so a published release ships a bundled `subagent.js` instead, built by `prepack`.

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

Pressing Esc aborts the parent turn and interrupts every child that is mid-work. Interrupted children keep their transcript and accept the next `subagent send`; their turn ends when it settles.

## Configuration

One JSON file, read by both the CLI and every child it spawns:

- `$PI_CODING_AGENT_DIR/subagents.json` applies to every project.
- `<cwd>/.pi/subagents.json` applies to one project and overrides the user file.

```json
{
  "defaults": { "provider": "magpie", "model": "mify/deepseek/deepseek-flash", "thinking": "low" },
  "presets": {
    "review": { "provider": "openai-codex", "model": "gpt-5.4-high", "thinking": "high" },
    "cheap": { "model": "deepseek/deepseek-flash", "thinking": "off" }
  },
  "exitKey": "ctrl+q"
}
```

`subagent spawn --preset review` picks a named choice. Per field, `--preset` wins over a spawn flag, which wins over `defaults`, which wins over `PI_PROVIDER`, `PI_MODEL`, and `PI_REASONING_LEVEL`; thinking falls back to `medium`. Errors name the file they came from, and a broken file only warns, so spawn keeps working.

## Isolation

Optional spawn flags:

- `--tools <names>`: comma-separated tool allowlist
- `--no-extensions`: disable extension discovery while retaining the control bridge
- `--extension <path|builtin:name>`: load one more extension in the child; repeatable. Paths must exist, built-ins take the `builtin:` prefix (e.g. `builtin:codemode`)
- `--no-skills`: disable skills
- `--no-prompt-templates`: disable prompt templates
- `--no-context-files`: ignore repository instruction files

Nested subagents are disabled. Child sessions do not receive the subagent skill. Children survive `/reload`, and a child lives only as long as its turn: when the turn settles with nothing queued, the process exits and the record stays. `send` starts a fresh process with the same history. When the spawning session quits, a running turn is stopped and its record kept. `subagent stop` moves a run to the trash and `subagent gc --purge` deletes it.

## Upgrading to 0.1.4

0.1.4 changes how runs are stored and how long a child lives. Both changes are breaking.

- Runs use `run.json` and `status.json` instead of `metadata.json`. Directories written by 0.1.3 and earlier are ignored by `list`, `wait`, and `gc`. Remove them by hand when they are no longer needed.
- A child exits when its turn settles and nothing is queued. `send` starts a new process with the same session history. Suspended runs are gone, and a restarted parent no longer revives children.
- `stop` moves the run to `.trash`. `gc` lists the trash and `gc --purge` deletes it.

## Tests

The end-to-end test drives a real parent and child TUI in tmux, so it needs `tmux` and `pi` on `PATH`. It crafts a run directory by hand and makes no model call.

```sh
npm run test:e2e
```

When `tmux`, `pi`, or `node` is missing, the run exits 0 after printing `SKIP`.

The reclaim test builds run directories by hand and makes no model call. It covers lock liveness, crash correction, zero-value trashing, and purge.

```sh
npm run test:reclaim
```

The lifecycle test covers the turn boundary. Without a model it kills a lock holder mid-delivery and checks that `send` cold-starts instead of reporting a lost message. With `PI_E2E_MODEL=1` it spawns a real child, quits the parent, and checks that the record reads interrupted and the process is gone.

```sh
PI_E2E_MODEL=1 npm run test:lifecycle
```

## Acknowledgements

This project is forked from [badlogic/pi-subagent](https://github.com/badlogic/pi-subagent), which provides the original design: tmux-backed child sessions, the control bridge, and the CLI surface. Upstream is the reference for core behavior; this fork extends it.
