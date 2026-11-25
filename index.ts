import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, watch, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CustomEditor,
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionContext,
	keyHint,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	type EditorTheme,
	type KeyId,
	matchesKey,
	type SelectItem,
	SelectList,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import {
	appendRunEvent,
	assistantText,
	getRunsDir,
	inspectRuns,
	isEventsFile,
	isProcessAlive,
	markCrashNotified,
	markDelivered,
	readDeliveredSeq,
	readRunEvents,
	Run,
	wasCrashNotified,
	type InboxMessage,
	type RunSnapshot,
	type RunState,
} from "./shared.ts";

const packageDir = dirname(fileURLToPath(import.meta.url));

const PICKER_KEY: KeyId = "left";

const STATE_COLORS = {
	busy: "warning",
	idle: "success",
	starting: "muted",
	exited: "muted",
	interrupted: "warning",
	crashed: "error",
	error: "error",
} as const satisfies Record<RunState, string>;

/** How long a client that left for a subagent may take to come back before one last redraw. */
const CLIENT_POLL_ATTEMPTS = 60;
const CLIENT_POLL_INTERVAL_MS = 500;

/**
 * A finished child writes one line; the watcher turns it into a turn within a few milliseconds.
 * The timer also covers what no file event announces — a child whose process is simply gone — so it
 * runs at crash-report speed, not at "safety net" speed.
 */
const DELIVERY_INTERVAL_MS = 1000;
const COMPLETION_TYPE = "subagent.completion";

interface Pending {
	run: Run;
	kind: "settled" | "aborted" | "crashed";
	/** For a crash, the state that says how it ended (crashed, exited, interrupted, error). */
	label?: RunState;
	text: string;
	/** Event seq; absent for a crash, which is deduplicated by its marker file instead. */
	seq?: number;
}

/** `details` on the custom message, so a renderer or a later reader can tell the lines apart. */
type CompletionDetails =
	| { kind: Pending["kind"]; handle: string; seq?: number }
	| { kind: "digest"; items: { handle: string; kind: string; seq?: number }[] };

/** How an ending reads: a normal end, a crash, or a run that went away with the session. */
function endingLabel(item: Pending): string {
	if (item.kind === "settled") return "finished";
	if (item.kind === "aborted" || item.label === "interrupted") return "was interrupted";
	if (item.label === "exited") return "exited";
	// starting, busy, crashed and error all mean the same thing to a reader: no result came back.
	return "crashed";
}

function completionHeadline(item: Pending): string {
	return `[subagent ${item.run.displayName}] ${endingLabel(item)}`;
}

function completionContent(item: Pending): string {
	return `${completionHeadline(item)}\n\n${item.text}`;
}

/** One wakeup for everything that ended while the session was closed. */
function digestContent(pending: Pending[]): string {
	const lines = pending.map((item) => {
		const summary = item.text.split("\n").find((line) => line.trim()) ?? "";
		return `- ${item.run.displayName}: ${endingLabel(item)} — ${summary.slice(0, 160)}`;
	});
	return `[subagent] ${pending.length} subagents ended while this session was closed\n\n${lines.join("\n")}`;
}

function crashReason(state: RunState, error: string | undefined): string {
	if (error) return error;
	if (state === "interrupted") return "Interrupted when this session closed.";
	if (state === "exited") return "Exited without a result.";
	return "The process is gone.";
}

/** The text of the last assistant turn, taken from the live session rather than the transcript file. */
function turnText(ctx: ExtensionContext): string {
	for (const entry of ctx.sessionManager.getEntries().toReversed()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		return assistantText(entry.message);
	}
	return "(no response text)";
}

function isInboxMessage(value: unknown): value is InboxMessage {
	if (typeof value !== "object" || value === null) return false;
	const message = value as Record<string, unknown>;
	if (message.kind === "interrupt") return true;
	// A CLI from before the interrupt protocol omits kind, and its files are still plain messages.
	if (message.kind !== undefined && message.kind !== "message") return false;
	return typeof message.message === "string" && (message.delivery === "auto" || message.delivery === "followUp");
}

function displayState(state: string): string {
	return state.padEnd(8);
}

/** A run is active while its lock is bound, and while a fresh one is still booting. */
function isActive(snapshot: RunSnapshot): boolean {
	return snapshot.alive || snapshot.state === "starting";
}

async function activeRuns(sessionId: string, sessionFile?: string): Promise<RunSnapshot[]> {
	return (await inspectRuns(sessionId, sessionFile)).filter(isActive);
}

interface EditorHooks {
	onLeft: () => void;
	hasActiveRun: () => boolean;
}

/**
 * Editor that steals ← only when the picker can do something with it.
 * Empty box + a live run means "show me the agents"; anything else is plain cursor movement.
 */
class SubagentEditor extends CustomEditor {
	private readonly hooks: EditorHooks;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, hooks: EditorHooks) {
		super(tui, theme, keybindings);
		this.hooks = hooks;
	}

	handleInput(data: string): void {
		if (matchesKey(data, PICKER_KEY) && this.getText().length === 0 && this.hooks.hasActiveRun()) {
			this.hooks.onLeft();
			return;
		}
		super.handleInput(data);
	}
}

/** Session the parent TUI lives in. Undefined when pi runs outside tmux. */
function parentSessionName(): string | undefined {
	const pane = process.env.TMUX_PANE;
	if (!pane) return undefined;
	const result = spawnSync("tmux", ["display-message", "-p", "-t", pane, "#{session_name}"], { encoding: "utf8" });
	if (result.status !== 0) return undefined;
	return result.stdout.trim() || undefined;
}

/** The client currently looking at a session. Undefined when nobody is attached. */
function firstClient(session: string): string | undefined {
	const result = spawnSync("tmux", ["list-clients", "-t", session, "-F", "#{client_name}"], { encoding: "utf8" });
	if (result.status !== 0) return undefined;
	return result.stdout.trim().split("\n")[0] || undefined;
}

function runTmux(argv: string[]): Promise<number | null> {
	return new Promise<number | null>((resolveExit) => {
		const child = spawn("tmux", argv, { stdio: "inherit" });
		child.on("error", () => resolveExit(null));
		child.on("close", resolveExit);
	});
}

/**
 * switch-client hands the client to the child session and returns at once, so the parent TUI is
 * hidden while a client it still owns is elsewhere. Redraw only once that client is back,
 * otherwise the first paint lands on a terminal that is showing the child.
 */
async function redrawWhenClientBack(tui: TUI): Promise<void> {
	const session = parentSessionName();
	for (let attempt = 0; session && attempt < CLIENT_POLL_ATTEMPTS; attempt++) {
		await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, CLIENT_POLL_INTERVAL_MS));
		if (firstClient(session) !== undefined) break;
	}
	tui.requestRender(true);
}

export default function subagentExtension(pi: ExtensionAPI) {
	const runDir = process.env.PI_SUBAGENT_RUN_DIR;
	if (!runDir) {
		pi.on("resources_discover", () => ({ skillPaths: [join(packageDir, "skills")] }));
	}

	const openPicker = async (ctx: ExtensionContext): Promise<void> => {
		const runs = await activeRuns(ctx.sessionManager.getSessionId());
		if (runs.length === 0) {
			ctx.ui.notify("No active subagents spawned by this session", "info");
			return;
		}

		const items: SelectItem[] = runs.map(({ run, state }) => ({
			value: run.handle,
			label: `${run.displayName}  ${displayState(state)}  ${run.provider}/${run.model}  ${run.thinking}`,
		}));
		let tui: TUI | undefined;
		const selected = await ctx.ui.custom<string | undefined>((customTui, theme, _keybindings, done) => {
			tui = customTui;
			const list = new SelectList(items, Math.min(items.length, 10), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(undefined);

			const container = new Container();
			container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
			container.addChild(new Text(theme.fg("accent", theme.bold("Attach to subagent")), 1, 0));
			container.addChild(list);
			container.addChild(
				new Text(
					theme.fg(
						"dim",
						`${keyHint("tui.select.confirm", "attach")}  ${keyHint("tui.select.cancel", "cancel")}`,
					),
					1,
					0,
				),
			);
			container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

			return {
				render: (width) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data) => {
					list.handleInput(data);
					customTui.requestRender();
				},
			};
		});
		if (!selected || !tui) return;
		const run = runs.find((candidate) => candidate.run.handle === selected)?.run;
		if (!run) return;

		const attachMode = process.env.TMUX ? "switch-client" : "attach-session";
		// Named client and session make the return trip exact; `switch-client -l` drifts to whatever
		// session the client left last, which is the child itself after a few round trips.
		const parent = attachMode === "switch-client" ? parentSessionName() : undefined;
		const client = parent ? firstClient(parent) : undefined;
		const exitArgv =
			parent && client
				? ["switch-client", "-c", client, "-t", parent]
				: attachMode === "switch-client"
					? ["switch-client", "-l"]
					: ["detach-client"];
		run.attach(exitArgv);

		if (attachMode === "switch-client") {
			const exitCode = await runTmux(["switch-client", "-t", run.tmuxSession]);
			if (exitCode !== 0) {
				ctx.ui.notify(`Could not switch to ${run.handle}`, "error");
				return;
			}
			await redrawWhenClientBack(tui);
			return;
		}

		tui.stop();
		try {
			const exitCode = await runTmux(["attach-session", "-t", run.tmuxSession]);
			if (exitCode !== 0) process.stderr.write(`Could not attach to ${run.handle}\n`);
		} finally {
			tui.start();
			tui.requestRender(true);
		}
	};

	pi.registerCommand("subagent", {
		description: "Select and attach to a subagent spawned by this session",
		handler: async (_args, ctx) => openPicker(ctx),
	});

	pi.registerMessageRenderer(COMPLETION_TYPE, (message, _options, theme) => {
		const [headline, ...rest] = message.content.split("\n");
		const kind = (message.details as { kind?: string } | undefined)?.kind;
		const color = kind === "settled" || kind === "digest" ? "success" : "warning";
		return new Text(theme.fg(color, headline) + theme.fg("text", `\n${rest.join("\n")}`), 0, 0);
	});

	if (!runDir) {
		let widgetTimer: ReturnType<typeof setInterval> | undefined;
		let deliveryTimer: ReturnType<typeof setInterval> | undefined;
		let deliveryWatcher: FSWatcher | undefined;
		let widgetContext: ExtensionContext | undefined;
		let editorInstalled = false;
		let activeCount = 0;
		let refreshing = false;
		let delivering = false;
		let deliverAgain = false;
		/** Highest completion already put into this session's context, per run handle. */
		const delivered = new Map<string, number>();
		/** Handed to the runtime but not yet seen in the transcript; resending would duplicate it. */
		const sent = new Map<string, string>();
		const markKey = (handle: string, seq: number): string => `${handle}:${seq}`;

		const refreshWidget = async (): Promise<void> => {
			const ctx = widgetContext;
			if (!ctx || refreshing) return;
			refreshing = true;
			try {
				const active = await activeRuns(ctx.sessionManager.getSessionId(), ctx.sessionManager.getSessionFile());
				activeCount = active.length;
				if (active.length === 0) {
					ctx.ui.setWidget("subagents", undefined);
					return;
				}

				const visible = active.slice(0, 5).map(({ run, state }) =>
					ctx.ui.theme.fg(STATE_COLORS[state], `${run.name ?? run.handle}:${state}`),
				);
				if (active.length > visible.length) {
					visible.push(ctx.ui.theme.fg("muted", `+${active.length - visible.length}`));
				}
				ctx.ui.setWidget(
					"subagents",
					[
						ctx.ui.theme.fg("dim", "subagents: ") +
							visible.join(ctx.ui.theme.fg("dim", " | ")) +
							// keyHint would render the key id "left" instead of the arrow the key is printed as.
							ctx.ui.theme.fg("dim", "  ← for agents"),
					],
					{ placement: "belowEditor" },
				);
			} catch {
				// A probe failure must not kill the session or spam stderr; drop the widget until it recovers.
				ctx.ui.setWidget("subagents", undefined);
			} finally {
				refreshing = false;
			}
		};

		/**
		 * Completions and crashes are both read from disk, never from memory, so a reload or a crash
		 * between the child finishing and the parent waking up costs nothing: the next tick reads the
		 * same lines and the same marker files.
		 */
		/** A run that produced a result is never also reported as having died. */
		const crashPending = async (run: Run, boot: boolean): Promise<Pending | undefined> => {
			if (wasCrashNotified(run.dir)) return undefined;
			const pid = run.pid;
			// The cheap check first: a live pid needs no socket probe at all.
			if (pid !== undefined && isProcessAlive(pid)) return undefined;
			const snapshot = await run.inspect();
			if (snapshot.alive) return undefined;
			// Nothing has reported yet, so only the boot grace can tell a boot from a corpse.
			if (pid === undefined && snapshot.state === "starting") return undefined;
			// This parent interrupts its children on shutdown; saying so mid-session is noise.
			if (snapshot.state === "interrupted" && !boot) return undefined;
			return { run, kind: "crashed", label: snapshot.state, text: crashReason(snapshot.state, run.error) };
		};

		const pendingOf = async (run: Run, boot: boolean): Promise<Pending[]> => {
			const last = delivered.get(run.handle) ?? readDeliveredSeq(run.dir);
			delivered.set(run.handle, last);
			const events = readRunEvents(run.dir);
			if (events.length > 0) {
				return events
					.filter((event) => event.seq > last && !sent.has(markKey(run.handle, event.seq)))
					.map((event) => ({ run, kind: event.kind, text: event.text, seq: event.seq }));
			}
			const crash = await crashPending(run, boot);
			return crash ? [crash] : [];
		};

		const collectPending = async (boot: boolean): Promise<Pending[]> => {
			const ctx = widgetContext;
			if (!ctx) return [];
			const runs = Run.list(ctx.sessionManager.getSessionId(), ctx.sessionManager.getSessionFile());
			const pending: Pending[] = [];
			for (const run of runs) pending.push(...(await pendingOf(run, boot)));
			return pending;
		};

		const sendCompletion = (content: string, details: CompletionDetails): void => {
			const message = { customType: COMPLETION_TYPE, content, display: true, details };
			// triggerTurn is explicit on purpose: it defaults to false, which appends without waking anyone.
			pi.sendMessage(message, { triggerTurn: true, deliverAs: "steer" });
		};

		/**
		 * A returned sendMessage only means the runtime took the message, not that it reached the
		 * session: a steer waits in the run's queue and dies with the process. The cursor moves when
		 * the transcript shows the message, so a crash in between re-delivers instead of losing it.
		 */
		const handOver = (item: Pending): void => {
			if (item.seq === undefined) return;
			sent.set(markKey(item.run.handle, item.seq), item.run.dir);
		};

		const confirm = (marks: { handle: string; seq?: number }[]): void => {
			for (const mark of marks) {
				if (mark.seq === undefined) continue;
				const key = markKey(mark.handle, mark.seq);
				const dir = sent.get(key);
				sent.delete(key);
				if (!dir || mark.seq <= (delivered.get(mark.handle) ?? 0)) continue;
				delivered.set(mark.handle, mark.seq);
				markDelivered(dir, mark.seq);
			}
		};

		const deliverEach = (pending: Pending[]): void => {
			for (const item of pending) {
				if (item.seq === undefined && !markCrashNotified(item.run.dir, item.kind)) continue;
				sendCompletion(completionContent(item), { kind: item.kind, handle: item.run.handle, seq: item.seq });
				handOver(item);
			}
		};

		const deliverDigest = (pending: Pending[]): void => {
			for (const item of pending) {
				if (item.seq === undefined) markCrashNotified(item.run.dir, item.kind);
			}
			sendCompletion(digestContent(pending), {
				kind: "digest",
				items: pending.map(({ run, kind, seq }) => ({ handle: run.handle, kind, seq })),
			});
			for (const item of pending) handOver(item);
		};

		const deliverCompletions = async (boot = false): Promise<void> => {
			if (!widgetContext) return;
			if (delivering) {
				// A second line landed while the first delivery was in flight; do not drop it.
				deliverAgain = true;
				return;
			}
			delivering = true;
			try {
				const pending = await collectPending(boot);
				if (pending.length === 0) return;
				// One wakeup for everything that ended while the session was closed.
				if (boot && pending.length > 1) deliverDigest(pending);
				else deliverEach(pending);
			} catch {
				// A bad run directory must not stop the timer or spam stderr; the next tick retries.
			} finally {
				delivering = false;
				if (deliverAgain) {
					deliverAgain = false;
					setTimeout(() => void deliverCompletions(), 0).unref();
				}
			}
		};

		/** The watcher is the fast path; the tick is what notices a death and any edge the watcher missed. */
		const startDelivery = (): void => {
			if (deliveryTimer) return;
			try {
				// The root may not exist yet on a fresh agent dir; watching a missing path throws.
				mkdirSync(getRunsDir(), { recursive: true, mode: 0o700 });
				deliveryWatcher = watch(getRunsDir(), { recursive: true }, (_event, file) => {
					if (typeof file === "string" && isEventsFile(file)) void deliverCompletions();
				});
				deliveryWatcher.on("error", () => {
					deliveryWatcher?.close();
					deliveryWatcher = undefined;
				});
				deliveryWatcher.unref();
			} catch {
				// No watcher (unsupported filesystem): the timer still catches everything.
			}
			// The first tick is a digest: whatever ended while this session was closed, in one turn.
			void deliverCompletions(true);
			deliveryTimer = setInterval(() => void deliverCompletions(), DELIVERY_INTERVAL_MS);
			deliveryTimer.unref();
		};

		const stopDelivery = (): void => {
			if (deliveryTimer) clearInterval(deliveryTimer);
			deliveryTimer = undefined;
			deliveryWatcher?.close();
			deliveryWatcher = undefined;
		};

		/** A completion in the transcript is the only proof that it reached the context. */
		pi.on("message_start", (event) => {
			const message = event.message;
			if (message.role !== "custom" || message.customType !== COMPLETION_TYPE) return;
			const details = message.details as CompletionDetails | undefined;
			confirm(details?.items ?? [{ handle: details?.handle ?? "", seq: details?.seq }]);
		});

		pi.on("session_start", async (_event, ctx) => {
			widgetContext = ctx;
			delivered.clear();
			sent.clear();
			// Delivery is headless: an RPC driver wants the same wakeup the TUI gets.
			startDelivery();
			if (!ctx.hasUI) return;
			// Another extension may own the editor slot; never replace it.
			if (!editorInstalled && ctx.ui.getEditorComponent() === undefined) {
				// Hooks read the live widgetContext, so a later session swap does not leave them on a stale ctx.
				ctx.ui.setEditorComponent(
					(tui, theme, keybindings) =>
						new SubagentEditor(tui, theme, keybindings, {
							onLeft: () => {
								if (!widgetContext) return;
								void openPicker(widgetContext);
							},
							hasActiveRun: () => activeCount > 0,
						}),
				);
				editorInstalled = true;
			}
			void refreshWidget();
			widgetTimer = setInterval(() => void refreshWidget(), 1000);
			widgetTimer.unref();
		});

		pi.on("agent_settled", async (event, ctx) => {
			// Escape aborts the parent run; every child that is still working stops its own turn likewise.
			if (!event.aborted) return;
			const runs = await inspectRuns(ctx.sessionManager.getSessionId(), ctx.sessionManager.getSessionFile());
			for (const { run, state } of runs) {
				if (state !== "busy" && state !== "starting") continue;
				run.queue({ kind: "interrupt" });
			}
		});

		/** Records outlive the parent; only a turn still running has to stop with it. */
		const stopChildren = async (ctx: ExtensionContext): Promise<void> => {
			const runs = await inspectRuns(ctx.sessionManager.getSessionId(), ctx.sessionManager.getSessionFile());
			for (const view of runs) {
				if (!view.alive) continue;
				spawnSync("tmux", ["kill-session", "-t", view.run.tmuxSession], { stdio: "ignore" });
				await view.run.waitForShutdown();
				// A turn we cut short is not the same as one that settled.
				if (view.run.state === "busy" || view.run.state === "starting") view.run.updateStatus({ state: "interrupted" });
			}
		};

		pi.on("session_shutdown", async (event, ctx) => {
			if (widgetTimer) clearInterval(widgetTimer);
			widgetTimer = undefined;
			stopDelivery();
			widgetContext = undefined;
			ctx.ui.setWidget("subagents", undefined);
			// Restore before a reload, so the freshly loaded extension sees a free editor slot.
			if (editorInstalled) {
				ctx.ui.setEditorComponent(undefined);
				editorInstalled = false;
			}
			if (event.reason === "reload") return;
			await stopChildren(ctx);
		});
		return;
	}

	let currentContext: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let processing = false;
	let sessionName: string | undefined;

	// Launch sets this; a pi started by hand has no run to leave, so it stays unregistered.
	const exitKey = process.env.PI_SUBAGENT_EXIT_KEY;
	if (exitKey) {
		pi.registerShortcut(exitKey as KeyId, {
			description: "Leave the subagent and return to the parent session",
			handler: (ctx) => {
				const result = spawnSync("tmux", Run.load(runDir)?.exitArgv ?? ["detach-client"], { encoding: "utf8" });
				if (!result.error && result.status === 0) return;
				const reason = result.error?.message ?? (result.stderr.trim() || `tmux exited with ${result.status}`);
				ctx.ui.notify(`Could not leave the subagent: ${reason}`, "error");
			},
		});
	}

	const syncSessionName = (): void => {
		const run = Run.load(runDir);
		if (!run) return;
		const next = `subagent ${run.name ?? run.handle}`;
		if (next === sessionName) return;
		pi.setSessionName(next);
		sessionName = next;
	};

	const processInbox = async (): Promise<void> => {
		if (processing || !currentContext) return;
		syncSessionName();
		const run = Run.load(runDir);
		if (!run) return;
		const queueDir = run.inboxDir;
		if (!existsSync(queueDir)) return;
		processing = true;
		try {
			for (const name of readdirSync(queueDir)
				.filter((entry) => entry.endsWith(".json"))
				.sort()) {
				const path = join(queueDir, name);
				let payload: InboxMessage;
				try {
					const value: unknown = JSON.parse(readFileSync(path, "utf8"));
					if (!isInboxMessage(value)) throw new Error("Invalid inbox message");
					payload = value;
				} catch (error) {
					unlinkSync(path);
					run.updateStatus({
						state: "error",
						error: error instanceof Error ? error.message : String(error),
					});
					continue;
				}

				if (payload.kind === "interrupt") {
					unlinkSync(path);
					// State returns to idle through agent_settled once the aborted turn unwinds.
					if (!currentContext.isIdle()) currentContext.abort();
					continue;
				}

				run.updateStatus({ state: "busy", error: undefined });
				try {
					if (currentContext.isIdle()) {
						pi.sendUserMessage(payload.message);
					} else {
						pi.sendUserMessage(payload.message, {
							deliverAs: payload.delivery === "followUp" ? "followUp" : "steer",
						});
					}
					unlinkSync(path);
				} catch (error) {
					run.updateStatus({
						state: currentContext.isIdle() ? "idle" : "busy",
						error: error instanceof Error ? error.message : String(error),
					});
					return;
				}
			}
		} finally {
			processing = false;
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		currentContext = ctx;
		const run = Run.load(runDir);
		if (!run) return;
		try {
			await run.lock();
		} catch (error) {
			process.stderr.write(`Could not claim ${runDir}: ${String(error)}\n`);
			ctx.shutdown();
			return;
		}
		run.updateStatus({
			childSessionId: ctx.sessionManager.getSessionId(),
			state: ctx.isIdle() ? "idle" : "busy",
			error: undefined,
			// The parent needs a pid to tell "still booting" from "died before it could report".
			pid: process.pid,
		});
		syncSessionName();
		if (!timer) {
			timer = setInterval(() => void processInbox(), 250);
			timer.unref();
		}
		void processInbox();
	});

	pi.on("agent_start", (_event, ctx) => {
		currentContext = ctx;
		Run.load(runDir)?.updateStatus({ state: "busy", hasStarted: true, error: undefined });
	});

	pi.on("agent_settled", (event, ctx) => {
		currentContext = ctx;
		if (!ctx.isIdle()) return;
		const run = Run.load(runDir);
		if (!run) return;
		run.updateStatus({ state: "idle" });
		// Written before the exit path: this line is the whole reason the parent can act without waiting.
		appendRunEvent(run.dir, event.aborted ? "aborted" : "settled", turnText(ctx));
		// A turn-scoped process: with nothing queued, this is where the run ends.
		if (run.hasInbox()) return;
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		ctx.shutdown();
	});

	pi.on("session_shutdown", (event) => {
		currentContext = undefined;
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		// A reload keeps this process and its lock; any other shutdown ends the run.
		if (event.reason === "reload") return;
		const run = Run.load(runDir);
		if (!run) return;
		run.updateStatus({ state: "exited" });
		run.unlock();
	});
}
