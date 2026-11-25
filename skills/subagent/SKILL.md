---
name: subagent
description: Spawn and communicate with observable Pi subagents for second opinions, independent investigations, and delegated implementation work.
---

# Subagent

Use the `subagent` CLI to delegate work to a separate Pi process with its own context and tmux session. Managed subagents cannot spawn nested subagents, and this skill is not loaded into their sessions.

## Spawn

Give each child a short, descriptive name. The name appears in the parent UI, while the generated handle remains its stable identifier:

```sh
subagent spawn --name implementation --prompt "Complete task"
```

The child resolves provider, model, and thinking from `--preset`, then the flags, then config `defaults`, then the parent's `PI_*` bash variables. Prefer a preset over flags: a preset outranks a flag per field, so `--model` alongside a preset changes nothing, and a flag only fills a field the preset leaves empty. Never pass `$PI_PROVIDER`, `$PI_MODEL`, or `$PI_REASONING_LEVEL` back to the CLI explicitly.

`--cwd` defaults to the current directory. Repeat `--prompt` and `--file` as needed; Pi receives all of them in the first user turn. Run `subagent spawn` directly without piping or redirecting its concise output.

When the user keeps choosing the same model, they want it in the config file, not on every command:

```sh
subagent spawn --preset review --prompt "Review the current diff"
```

## Configure

The CLI and every child read `$PI_CODING_AGENT_DIR/subagents.json`, then `<cwd>/.pi/subagents.json`, which overrides it:

```json
{
  "defaults": { "model": "mify/deepseek/deepseek-flash", "thinking": "low" },
  "presets": { "review": { "provider": "openai-codex", "model": "gpt-5.4-high", "thinking": "high" } },
  "exitKey": "ctrl+q"
}
```

Per field, `--preset` wins over a spawn flag, which wins over `defaults`, which wins over the inherited `PI_*` variables. `exitKey` is the key that leaves an attached child and returns to the parent session. Never write this file to change one run; a preset is the standing choice, and flags only fill the fields it leaves empty.

## Tools

Without `--tools`, Pi enables its four default tools:

- `read` - Read text files and images.
- `bash` - Execute shell commands. This can also modify files, so it is not a read-only capability.
- `edit` - Apply exact text replacements to existing files.
- `write` - Create or overwrite files.

Three additional built-in tools are available but off by default:

- `grep` - Search file contents.
- `find` - Find files by glob pattern.
- `ls` - List directory contents.

`--tools` is a comma-separated allowlist across built-in, extension, and custom tools. Common choices:

```sh
# Enforced read-only repository investigation
--tools read,grep,find,ls

# Investigation that may run tests or other commands; bash can modify files
--tools read,bash,grep,find,ls

# Implementation work: omit --tools to use the defaults
```

## Isolation flags

- `--no-extensions` - Disable normal extension discovery. Use for an independent run that should not inherit unrelated extension behavior or extension-provided tools. The subagent control bridge is still explicitly loaded.
- `--extension <path|builtin:name>` - Load one more extension in the child; repeatable. Use a path for a local extension file, or a built-in name such as `builtin:codemode`. The bridge stays loaded either way.
- `--no-skills` - Hide installed skills from the child. Use for tightly specified tasks that should rely only on the supplied prompt and files.
- `--no-prompt-templates` - Disable prompt-template commands. Usually unnecessary, but useful when testing a minimal child environment.
- `--no-context-files` - Ignore repository instruction files such as `AGENTS.md` and `CLAUDE.md`. Use only when those instructions would bias an independent investigation. Do not use for implementation unless intentionally bypassing repository guidance.

Spawn prints a random handle and the exact tmux attach command. Keep the handle for later commands. A child lives for one turn: when its turn settles and nothing is queued, the process exits on its own. The record and transcript stay, so `send` starts a fresh process with the same history. A running child survives `/reload`. When the spawning Pi session quits, any turn still running is stopped and the record is kept. `subagent stop` moves the record to the trash and `subagent gc --purge` deletes it.

Do not wait for a spawned child by default. Keep working on something else: when the child finishes, its result arrives as a message in this session, and you can answer the user while it runs. Spawn several children for parallel work and collect their results as they arrive.

Add `--wait` when the next step genuinely depends on the result and nothing else can proceed; it prints the same text `wait` does.

## Inspect and wait

```sh
subagent status <handle>
subagent list
subagent wait <handle>
```

Run `subagent list` at any time to rediscover active subagents and their handles, names, and current states if you no longer remember them.

`wait` blocks until the turn settles and its process leaves, then prints the latest final assistant response. Prefer not to call it after `spawn`: a finished child reports its own result. Use it to re-read a result you have lost, or from a script that needs the text on stdout. Run it directly so the bash tool returns that response; do not redirect it to a file or pipe it unless the user explicitly asks for an artifact. Do not infer completion from captured terminal text. Set the bash timeout above `wait`'s default 1800-second deadline.

## Communicate

```sh
# Change the name shown in the parent UI.
subagent rename <handle> "new name"

# Idle: starts a new prompt. Busy: steers the current work.
subagent send <handle> "message"

# Busy: waits until current work finishes, then starts another turn.
subagent send <handle> --follow-up "message"
```

Names are 1–64 characters and need not be unique. Messages use the subagent extension's control inbox; do not use `tmux send-keys`.

## Attach

Use `/subagent`, or press `←` on an empty parent prompt, to pick a child. The exit key from the config (`ctrl+q` by default) returns to the parent session, whether the child is idle or working.

## Interrupt

```sh
subagent interrupt <handle>
```

Aborts the child's current turn. The record and transcript stay, and the child exits once that turn settles unless another message is queued. The parent does this on its own for every busy child when the user presses Esc, so interrupt a child directly only when the user asks for one subagent to stop while the rest keep working.

## Stop

```sh
subagent stop <handle>
```

Stop a subagent when its history is no longer needed. This kills any running turn and moves the record to `~/.pi/agent/subagents/.trash`, transcript included; `subagent gc --purge` deletes it for good. A finished turn needs no stop: its process is already gone.

## Reclaim

```sh
subagent gc                       # dry run: reconcile dead records, list the trash
subagent gc --purge               # delete everything in the trash
subagent gc --purge --older-than 7
```

`gc` reconciles first. A record whose process is gone reads `crashed` instead of holding a stale `busy`, and a record that never started and queued nothing moves straight to the trash. Liveness comes from a socket the child process holds, so a tmux restart no longer turns a live run into a dead one. A settled turn exits by itself, so most records are already cool before anyone runs `gc`. `list` and `status` reconcile too, and `gc` without `--purge` only reports. A directory whose `run.json` cannot be parsed is invisible to the other commands, so `gc` names it and leaves it alone.

The interactive `/subagent` command lists active subagents spawned by the current Pi session. Selecting one suspends the current Pi TUI and attaches to its tmux session; detaching returns to the parent Pi. When the parent already runs inside tmux, selection switches the current tmux client instead.
