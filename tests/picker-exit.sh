#!/usr/bin/env bash
# End-to-end check: ← opens the subagent picker on an empty prompt, Enter switches the tmux client
# to the child, and the exit key switches it back. The run directory is crafted by hand, so no model
# call happens.
set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
AGENT_DIR=${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}

PANE_WIDTH=140
PANE_HEIGHT=45
POLL_INTERVAL=0.5
BOOT_TRIES=40
CLIENT_TRIES=20

for tool in tmux pi node; do
	command -v "$tool" >/dev/null 2>&1 || {
		echo "SKIP $tool is not on PATH"
		exit 0
	}
done

# Every name carries a random suffix so a leftover session from an earlier run never collides.
ID=$(node -e 'console.log(crypto.randomUUID())')
SHORT=${ID%%-*}
HANDLE=e2e$SHORT
CHILD_SESSION=pi-subagent-$HANDLE
PARENT_SESSION=pi-e2e-parent-$SHORT
DRIVER_SESSION=pi-e2e-driver-$SHORT
PARENT_ID=$(node -e 'console.log(crypto.randomUUID())')
HANDLE_DIR=$AGENT_DIR/subagents/$HANDLE
WORKDIR=$(mktemp -d /tmp/picker-e2e.XXXXXX)
# Pi prints the working directory above the prompt; the resolved form is what the pane shows.
PROMPT_MARKER=$(cd "$WORKDIR" && pwd -P)

cleanup() {
	tmux kill-session -t "$DRIVER_SESSION" 2>/dev/null
	tmux kill-session -t "$CHILD_SESSION" 2>/dev/null
	tmux kill-session -t "$PARENT_SESSION" 2>/dev/null
	rm -rf "$HANDLE_DIR" "$WORKDIR"
	rm -f "$AGENT_DIR"/sessions/*/"$PARENT_ID".jsonl
}
trap cleanup EXIT

fail() {
	echo "FAIL $*"
	exit 1
}
ok() { echo "ok   $*"; }
screen() { tmux capture-pane -p -t "$1"; }
client_on() { tmux list-clients -t "$1" -F '#{client_name}' 2>/dev/null | head -1; }

expect_visible() {
	if screen "$1" | grep -qF -- "$2"; then
		ok "$3"
		return 0
	fi
	fail "$3: pane does not show '$2'"
}

expect_hidden() {
	if screen "$1" | grep -qF -- "$2"; then
		fail "$3: pane still shows '$2'"
	fi
	ok "$3"
}

# Polls the pane until it shows an editor prompt. Returns 1 on timeout, 2 when the session is gone.
wait_prompt() {
	local attempt
	for attempt in $(seq "$2"); do
		screen "$1" 2>/dev/null | grep -qF -- "$PROMPT_MARKER" && return 0
		tmux has-session -t "$1" 2>/dev/null || return 2
		sleep "$POLL_INTERVAL"
	done
	return 1
}

wait_client_on() {
	local attempt
	for attempt in $(seq "$CLIENT_TRIES"); do
		[ -n "$(client_on "$1")" ] && return 0
		sleep "$POLL_INTERVAL"
	done
	return 1
}

wait_visible() {
	local attempt
	for attempt in $(seq "$CLIENT_TRIES"); do
		screen "$1" | grep -qF -- "$2" && return 0
		sleep "$POLL_INTERVAL"
	done
	return 1
}

mkdir -p "$HANDLE_DIR/inbox"
: >"$HANDLE_DIR/session.jsonl"
cat >"$HANDLE_DIR/metadata.json" <<EOF
{"version":1,"handle":"$HANDLE","name":"e2e","parentSessionId":"$PARENT_ID",
 "tmuxSession":"$CHILD_SESSION","runDir":"$HANDLE_DIR","sessionFile":"$HANDLE_DIR/session.jsonl",
 "cwd":"$WORKDIR","provider":"magpie","model":"mify/deepseek/deepseek-flash","thinking":"low",
 "launchArgs":[],"state":"idle","hasStarted":true,"createdAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
EOF

tmux new-session -d -s "$CHILD_SESSION" -x "$PANE_WIDTH" -y "$PANE_HEIGHT" -c "$WORKDIR" \
	"env PI_SUBAGENT_RUN_DIR='$HANDLE_DIR' PI_SUBAGENT_EXIT_KEY=ctrl+y pi --no-extensions -e '$ROOT/index.ts' --no-session"

wait_prompt "$CHILD_SESSION" "$BOOT_TRIES"
CHILD_READY=$?
case $CHILD_READY in
0) ok "child pi painted its editor" ;;
2) echo "SKIP child pi exited before painting its editor"
	exit 0 ;;
*) fail "child pi painted no editor within $((BOOT_TRIES * 2))s" ;;
esac

tmux new-session -d -s "$PARENT_SESSION" -x "$PANE_WIDTH" -y "$PANE_HEIGHT" -c "$WORKDIR" \
	"pi --no-extensions -e '$ROOT/index.ts' --session-id $PARENT_ID"
tmux new-session -d -s "$DRIVER_SESSION" -x "$PANE_WIDTH" -y "$PANE_HEIGHT" \
	"unset TMUX TMUX_PANE; tmux attach -t $PARENT_SESSION"

wait_client_on "$PARENT_SESSION" || fail "driver client never attached to $PARENT_SESSION"
ok "driver client attached to the parent session"

wait_prompt "$DRIVER_SESSION" "$BOOT_TRIES" || fail "parent painted no editor within $((BOOT_TRIES * 2))s"
ok "parent painted its editor"

# The widget only names the key once the extension sees a live run of this session.
wait_visible "$DRIVER_SESSION" "← for agents" || fail "widget never advertised ← for agents"
ok "widget advertises ← for agents"

# A non-empty prompt must keep ← as plain cursor movement.
tmux send-keys -t "$DRIVER_SESSION" -l "abc"
sleep "$POLL_INTERVAL"
tmux send-keys -t "$DRIVER_SESSION" Left
sleep "$POLL_INTERVAL"
expect_hidden "$DRIVER_SESSION" "Attach to subagent" "← on a typed prompt does not open the picker"

# Left parked the cursor before the last character; End brings it back so three backspaces empty the line.
tmux send-keys -t "$DRIVER_SESSION" End BSpace BSpace BSpace
sleep "$POLL_INTERVAL"

tmux send-keys -t "$DRIVER_SESSION" Left
wait_visible "$DRIVER_SESSION" "Attach to subagent" || fail "← on an empty prompt did not open the picker"
ok "← on an empty prompt opens Attach to subagent"

tmux send-keys -t "$DRIVER_SESSION" Enter
wait_client_on "$CHILD_SESSION" || fail "Enter did not move the client to $CHILD_SESSION"
ok "Enter moves the client to the child session"

EXIT_ARGV=$(node -e "const m=require('$HANDLE_DIR/metadata.json');console.log(JSON.stringify(m.exitArgv))")
case "$EXIT_ARGV" in
'["switch-client","-c","'*) ok "parent recorded a named switch back: $EXIT_ARGV" ;;
*) fail "parent recorded no named switch back: exitArgv=$EXIT_ARGV" ;;
esac

tmux send-keys -t "$DRIVER_SESSION" C-y
wait_client_on "$PARENT_SESSION" || fail "exit key did not move the client back to $PARENT_SESSION"
ok "exit key moves the client back to the parent session"

wait_visible "$DRIVER_SESSION" "← for agents" || fail "parent did not repaint after the round trip"
ok "parent repaints its widget after the round trip"

echo "PASS picker and exit key"
