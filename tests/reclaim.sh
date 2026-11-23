#!/usr/bin/env bash
# Exercises the reclaim state machine with hand-built run directories: no model, no tmux.
set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d /tmp/subagent-reclaim.XXXXXX)
export PI_CODING_AGENT_DIR=$WORK/agent
export PI_SESSION_ID=
RUNS=$PI_CODING_AGENT_DIR/subagents
FAILS=0
HOLDER=

cleanup() {
	[ -n "$HOLDER" ] && kill "$HOLDER" 2>/dev/null
	rm -rf "$WORK"
}
trap cleanup EXIT

ok() { echo "ok   $1"; }
fail() {
	echo "FAIL $1"
	FAILS=$((FAILS + 1))
}

cli() { node --experimental-strip-types "$ROOT/subagent.ts" "$@"; }

make_run() {
	local handle=$1 state=$2 started=$3 transcript=${4:-}
	local dir=$RUNS/$handle
	mkdir -p "$dir/inbox"
	node -e '
		const fs = require("node:fs");
		const path = require("node:path");
		const [dir, handle, state, started, transcript] = process.argv.slice(1);
		const now = new Date().toISOString();
		fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify({
			version: 1, handle, tmuxSession: `pi-subagent-${handle}`, runDir: dir,
			sessionFile: path.join(dir, "session.jsonl"), cwd: dir,
			provider: "test", model: "test", thinking: "off", createdAt: now,
		}, null, 2));
		fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({
			version: 1, state, hasStarted: started === "1", updatedAt: now,
		}, null, 2));
		fs.writeFileSync(path.join(dir, "session.jsonl"), transcript);
	' "$dir" "$handle" "$state" "$started" "$transcript"
}

field() {
	node -e 'console.log(require(process.argv[1])[process.argv[2]] ?? "")' "$1" "$2"
}

expect_contains() {
	case "$1" in
	*"$2"*) ok "$3" ;;
	*) fail "$3 (got: $1)" ;;
	esac
}

# Idle with no lock: the process is gone and the record says so.
make_run dead1 idle 1 '{}\n'
OUT=$(cli status dead1)
expect_contains "$OUT" "dead1: exited" "idle without a lock reads exited"

# Busy with no lock: the record lied and reconcile corrects it.
make_run dead2 busy 1 '{}\n'
OUT=$(cli status dead2)
expect_contains "$OUT" "dead2: crashed" "busy without a lock reads crashed"
expect_contains "$(field "$RUNS/dead2/status.json" state)" "crashed" "reconcile persists crashed"

# A bound socket means alive, and killing the holder flips the state without touching files.
make_run live1 idle 1 '{}\n'
node "$ROOT/tests/hold-lock.mjs" "$RUNS/live1/alive.sock" >/dev/null &
HOLDER=$!
for _ in $(seq 50); do [ -S "$RUNS/live1/alive.sock" ] && break; sleep 0.1; done
OUT=$(cli status live1)
expect_contains "$OUT" "live1: idle" "a bound lock reads idle"
kill "$HOLDER" 2>/dev/null
wait "$HOLDER" 2>/dev/null
HOLDER=
OUT=$(cli status live1)
expect_contains "$OUT" "live1: exited" "killing the lock holder reads exited"

# A fresh run before its process binds the lock is booting, not dead.
make_run boot1 starting 0 ''
OUT=$(cli status boot1)
expect_contains "$OUT" "boot1: starting" "a fresh starting run keeps its grace window"

# The grace window follows the last start, so a resumed run with an old createdAt still boots.
make_run resume1 starting 0 ''
node -e 'const fs=require("fs"),p=process.argv[1];const j=JSON.parse(fs.readFileSync(p,"utf8"));j.createdAt=new Date(Date.now()-86400000*3).toISOString();fs.writeFileSync(p,JSON.stringify(j))' "$RUNS/resume1/run.json"
OUT=$(cli status resume1)
expect_contains "$OUT" "resume1: starting" "a resumed run keeps its grace window"

# A start that never bound its lock long ago is crashed, not still booting.
make_run stale1 starting 0 ''
node -e 'const fs=require("fs"),p=process.argv[1];const j=JSON.parse(fs.readFileSync(p,"utf8"));j.updatedAt=new Date(Date.now()-86400000*3).toISOString();fs.writeFileSync(p,JSON.stringify(j))' "$RUNS/stale1/status.json"
OUT=$(cli status stale1)
expect_contains "$OUT" "stale1: crashed" "a stale starting run reads crashed"

# Nothing started, nothing queued, no lock: the record is moved, not deleted.
make_run zero1 idle 0 ''
OUT=$(cli gc)
expect_contains "$OUT" "zero1" "gc reports the zero-value record"
[ -d "$RUNS/zero1" ] && fail "zero1 still in the run root" || ok "zero-value record left the run root"
ls "$RUNS/.trash" | grep -q "^zero1\." && ok "zero-value record landed in .trash" || fail "zero1 missing from .trash"

# Dry run keeps the trash; --purge removes it.
cli gc >/dev/null
ls "$RUNS/.trash" | grep -q "^zero1\." && ok "dry run keeps trash" || fail "dry run purged trash"
OUT=$(cli gc --purge)
expect_contains "$OUT" "Purged" "gc --purge reports what it removed"
ls "$RUNS/.trash" 2>/dev/null | grep -q "^zero1\." && fail "zero1 survived --purge" || ok "--purge removed the trashed record"

# Stop on a dead run goes straight to trash and keeps the history.
make_run stop1 idle 1 '{}\n'
OUT=$(cli stop stop1)
expect_contains "$OUT" "moved to trash" "stop reports a trash move"
[ -d "$RUNS/stop1" ] && fail "stop1 still in the run root" || ok "stop moved the record out of the run root"
[ -f "$RUNS/.trash/stop1."*/session.jsonl ] && ok "trash keeps the transcript" || fail "trash lost the transcript"

# Records from the old single-file format are left alone.
mkdir -p "$RUNS/legacy1"
echo '{"version":1,"handle":"legacy1","tmuxSession":"x","runDir":"/tmp/x","sessionFile":"/tmp/x/s"}' >"$RUNS/legacy1/metadata.json"
OUT=$(cli list)
case "$OUT" in
*legacy1*) fail "legacy record leaked into list" ;;
*) ok "legacy records are ignored" ;;
esac

# A record whose run.json cannot be parsed is invisible to every command; gc names it and leaves it.
make_run broken1 idle 0 ''
echo '{' >"$RUNS/broken1/run.json"
OUT=$(cli gc)
expect_contains "$OUT" "1 unreadable record" "gc reports an unreadable record"
cli gc --purge >/dev/null
[ -d "$RUNS/broken1" ] && ok "gc leaves an unreadable record in place" || fail "gc purged an unreadable record"

# List reconciles every record it shows.
make_run dead3 busy 1 '{}\n'
OUT=$(cli list)
expect_contains "$OUT" "dead3" "list shows the crashed record"
expect_contains "$(field "$RUNS/dead3/status.json" state)" "crashed" "list persists reconcile"

echo
if [ "$FAILS" -eq 0 ]; then
	echo "PASS reclaim"
else
	echo "FAILED $FAILS check(s)"
	exit 1
fi
