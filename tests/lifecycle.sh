#!/usr/bin/env bash
# Turn lifecycle: send cold-starts when a child leaves mid-delivery, and a parent quit
# interrupts a running turn. The second needs a real model, so it is opt-in.
set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
FAILS=0

ok() { echo "ok   $1"; }
fail() {
	echo "FAIL $1"
	FAILS=$((FAILS + 1))
}
check() {
	if eval "$2"; then ok "$1"; else fail "$1"; fi
}

# send queues while the child looks alive. The child then leaves without taking the file.
# send has to notice and start a fresh process, not report a delivery that never happened.
race() {
	local work runs handle=race1 holder= pid= launched=0
	work=$(mktemp -d /tmp/subagent-race.XXXXXX)
	runs=$work/agent/subagents
	mkdir -p "$runs/$handle/inbox"
	node -e '
		const fs = require("node:fs"), path = require("node:path");
		const dir = process.argv[1], now = new Date().toISOString();
		fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify({
			version: 1, handle: "race1", tmuxSession: "pi-subagent-race1", runDir: dir,
			sessionFile: path.join(dir, "session.jsonl"), cwd: dir,
			provider: "test", model: "test", thinking: "off", createdAt: now,
		}, null, 2));
		fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({
			version: 1, state: "busy", hasStarted: true, updatedAt: now,
		}, null, 2));
	' "$runs/$handle"

	# The launcher hook means no model runs and the launch is still observable.
	printf '#!/usr/bin/env bash\ntouch "$(dirname "$0")/launched"\nsleep 5\n' > "$runs/$handle/pi-test.sh"
	chmod +x "$runs/$handle/pi-test.sh"

	node "$ROOT/tests/hold-lock.mjs" "$runs/$handle/alive.sock" > /dev/null &
	holder=$!
	for _ in $(seq 1 50); do [ -S "$runs/$handle/alive.sock" ] && break; sleep 0.05; done

	PI_CODING_AGENT_DIR=$work/agent PI_SESSION_ID= node --experimental-strip-types "$ROOT/subagent.ts" send "$handle" "hello" > "$work/send.out" 2>&1 &
	pid=$!
	sleep 0.4
	kill "$holder"
	holder=
	wait "$pid"

	check "send reports Started" 'grep -q "Started" "$work/send.out"'
	check "the fresh child is running" 'tmux has-session -t pi-subagent-$handle 2>/dev/null'

	# The tmux session exists a beat before its launcher execs.
	launched=0
	for _ in $(seq 1 40); do
		[ -f "$runs/$handle/launched" ] && { launched=1; break; }
		sleep 0.05
	done
	check "the launcher ran" '[ "$launched" = 1 ]'

	tmux kill-session -t "pi-subagent-$handle" 2>/dev/null
	rm -rf "$work"
}

# A turn owns the process. Quitting the parent stops it and marks the record interrupted.
quit() {
	local work sid parent handle= busy=0 gone=0 interrupted=0 state started child_alive
	unset PI_CODING_AGENT_DIR PI_SESSION_ID
	work=$(mktemp -d /tmp/subagent-quit.XXXXXX)
	sid=$(uuidgen | tr 'A-Z' 'a-z')
	parent="pi-e2e-parent-${sid:0:6}"

	cleanup_quit() {
		tmux kill-session -t "$parent" 2>/dev/null
		[ -n "$handle" ] && tmux kill-session -t "pi-subagent-$handle" 2>/dev/null
		[ -n "$handle" ] && rm -rf "$HOME/.pi/agent/subagents/$handle"
		find "$HOME/.pi/agent/sessions" -name "*$sid.jsonl" -delete 2>/dev/null
		# pi keys the session directory by cwd; rmdir only succeeds when we emptied it.
		find "$HOME/.pi/agent/sessions" -maxdepth 1 -type d -name "*$(basename "$work")*" -exec rmdir {} + 2>/dev/null
		rm -rf "$work"
	}
	trap cleanup_quit EXIT

	tmux new-session -d -s "$parent" -x 120 -y 40 -c "$work" \
		"pi --no-extensions -e '$ROOT/index.ts' --session-id $sid"
	sleep 5

	local out
	out=$(cd "$work" && PI_SESSION_ID=$sid node --experimental-strip-types "$ROOT/subagent.ts" spawn \
		--cwd "$work" --no-extensions \
		--prompt "Use the bash tool to run exactly: sleep 60. Do nothing else until it returns. Then reply with exactly: done." 2>&1)
	handle=$(echo "$out" | awk '/Spawned/{print $2}')
	if [ -z "$handle" ]; then
		fail "spawn printed a handle (got: $out)"
		return
	fi

	for _ in $(seq 1 180); do
		state=$(node -e 'try{console.log(require(process.argv[1]).state)}catch{}' "$HOME/.pi/agent/subagents/$handle/status.json")
		started=$(node -e 'try{console.log(require(process.argv[1]).hasStarted)}catch{}' "$HOME/.pi/agent/subagents/$handle/status.json")
		[ "$state" = busy ] && [ "$started" = true ] && { busy=1; break; }
		sleep 0.5
	done
	check "the turn starts" '[ "$busy" = 1 ]'
	sleep 2

	# The user's quit: one ctrl+c clears the editor, the second exits.
	tmux send-keys -t "$parent" C-c
	sleep 0.3
	tmux send-keys -t "$parent" C-c
	for _ in $(seq 1 40); do
		tmux has-session -t "$parent" 2>/dev/null || { gone=1; break; }
		sleep 0.25
	done
	check "the parent exits" '[ "$gone" = 1 ]'

	for _ in $(seq 1 40); do
		state=$(node -e 'try{console.log(require(process.argv[1]).state)}catch{}' "$HOME/.pi/agent/subagents/$handle/status.json")
		[ "$state" = interrupted ] && { interrupted=1; break; }
		sleep 0.25
	done
	check "the record reads interrupted" '[ "$interrupted" = 1 ]'

	tmux has-session -t "pi-subagent-$handle" 2>/dev/null && child_alive=1 || child_alive=0
	check "the child process is gone" '[ "$child_alive" = 0 ]'

	cleanup_quit
	trap - EXIT
}

race
if [ "${PI_E2E_MODEL:-0}" = 1 ]; then
	quit
else
	echo "skip parent quit (set PI_E2E_MODEL=1 to run it with a real model)"
fi

if [ "$FAILS" -eq 0 ]; then
	echo "PASS lifecycle"
	exit 0
fi
echo "$FAILS failed"
exit 1
