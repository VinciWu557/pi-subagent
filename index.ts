import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
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
	effectiveRunState,
	inboxDir,
	launchRun,
	listRuns,
	queueInboxMessage,
	readMetadata,
	removeRunDir,
	runDisplayName,
	type InboxMessage,
	type RunMetadata,
	tmuxSessionExists,
	updateMetadata,
	waitForRunShutdown,
} from "./shared.ts";

const packageDir = dirname(fileURLToPath(import.meta.url));

const PICKER_KEY: KeyId = "left";

/** How long a client that left for a subagent may take to come back before one last redraw. */
const CLIENT_POLL_ATTEMPTS = 60;
const CLIENT_POLL_INTERVAL_MS = 500;

function isInboxMessage(value: unknown): value is InboxMessage {
	if (typeof value !== "object" || value === null) return false;
	const message = value as Record<string, unknown>;
	if (message.kind === "interrupt") return true;
	// A CLI from before the interrupt protocol omits kind, and its files are still plain messages.
	if (message.kind !== undefined && message.kind !== "message") return false;
	return typeof message.message === "string" && (message.delivery === "auto" || message.delivery === "followUp");
}

function displayState(metadata: RunMetadata): string {
	return effectiveRunState(metadata).padEnd(8);
}

function liveRuns(sessionId: string): RunMetadata[] {
	return listRuns(sessionId).filter((run) => effectiveRunState(run) !== "exited");
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
		const runs = liveRuns(ctx.sessionManager.getSessionId());
		if (runs.length === 0) {
			ctx.ui.notify("No active subagents spawned by this session", "info");
			return;
		}

		const items: SelectItem[] = runs.map((run) => ({
			value: run.handle,
			label: `${runDisplayName(run)}  ${displayState(run)}  ${run.provider}/${run.model}  ${run.thinking}`,
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
		const run = runs.find((candidate) => candidate.handle === selected);
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
		updateMetadata(run.runDir, { exitArgv });

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

	if (!runDir) {
		let widgetTimer: ReturnType<typeof setInterval> | undefined;
		let widgetContext: ExtensionContext | undefined;
		let editorInstalled = false;

		const refreshWidget = (): void => {
			if (!widgetContext) return;
			const activeRuns = liveRuns(widgetContext.sessionManager.getSessionId()).map((run) => ({
				run,
				state: effectiveRunState(run),
			}));
			if (activeRuns.length === 0) {
				widgetContext.ui.setWidget("subagents", undefined);
				return;
			}

			const visible = activeRuns.slice(0, 5).map(({ run, state }) => {
				const color =
					state === "busy" ? "warning" : state === "idle" ? "success" : state === "error" ? "error" : "muted";
				return widgetContext!.ui.theme.fg(color, `${run.name ?? run.handle}:${state}`);
			});
			if (activeRuns.length > visible.length) {
				visible.push(widgetContext.ui.theme.fg("muted", `+${activeRuns.length - visible.length}`));
			}
			widgetContext.ui.setWidget(
				"subagents",
				[
					widgetContext.ui.theme.fg("dim", "subagents: ") +
						visible.join(widgetContext.ui.theme.fg("dim", " | ")) +
						// keyHint would render the key id "left" instead of the arrow the key is printed as.
						widgetContext.ui.theme.fg("dim", "  ← for agents"),
				],
				{ placement: "belowEditor" },
			);
		};

		pi.on("session_start", (_event, ctx) => {
			// Relaunch children that were suspended when this session was last quit or switched away from.
			for (const run of listRuns(ctx.sessionManager.getSessionId())) {
				if (!run.suspended || tmuxSessionExists(run.tmuxSession)) continue;
				if (!existsSync(run.sessionFile)) {
					removeRunDir(run.runDir);
					continue;
				}
				const starting = updateMetadata(run.runDir, { state: "starting", error: undefined }) ?? run;
				try {
					launchRun(starting);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					updateMetadata(run.runDir, { state: "error", error: message });
					if (ctx.hasUI) ctx.ui.notify(`Could not resume subagent ${runDisplayName(run)}: ${message}`, "error");
				}
			}

			if (!ctx.hasUI) return;
			widgetContext = ctx;
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
							hasActiveRun: () => {
								if (!widgetContext) return false;
								return liveRuns(widgetContext.sessionManager.getSessionId()).length > 0;
							},
						}),
				);
				editorInstalled = true;
			}
			refreshWidget();
			widgetTimer = setInterval(refreshWidget, 1000);
			widgetTimer.unref();
		});

		pi.on("agent_settled", (event, ctx) => {
			// Escape aborts the parent run; every child that is still working stops its own turn likewise.
			if (!event.aborted) return;
			for (const run of listRuns(ctx.sessionManager.getSessionId())) {
				const state = effectiveRunState(run);
				if (state !== "busy" && state !== "starting") continue;
				queueInboxMessage(run.runDir, { kind: "interrupt" });
			}
		});

		pi.on("session_shutdown", async (event, ctx) => {
			if (widgetTimer) clearInterval(widgetTimer);
			widgetTimer = undefined;
			widgetContext = undefined;
			ctx.ui.setWidget("subagents", undefined);
			// Restore before a reload, so the freshly loaded extension sees a free editor slot.
			if (editorInstalled) {
				ctx.ui.setEditorComponent(undefined);
				editorInstalled = false;
			}
			if (event.reason === "reload") return;
			// Suspend running children: stop the process but keep transcript and metadata so resuming this
			// session relaunches them. Children that already exited on their own are discarded.
			for (const run of listRuns(ctx.sessionManager.getSessionId())) {
				if (!tmuxSessionExists(run.tmuxSession)) {
					if (!run.suspended) removeRunDir(run.runDir);
					continue;
				}
				updateMetadata(run.runDir, { suspended: true });
				spawnSync("tmux", ["kill-session", "-t", run.tmuxSession], { stdio: "ignore" });
				await waitForRunShutdown(run.runDir);
			}
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
				const result = spawnSync("tmux", readMetadata(runDir)?.exitArgv ?? ["detach-client"], { encoding: "utf8" });
				if (!result.error && result.status === 0) return;
				const reason = result.error?.message ?? (result.stderr.trim() || `tmux exited with ${result.status}`);
				ctx.ui.notify(`Could not leave the subagent: ${reason}`, "error");
			},
		});
	}

	const syncSessionName = (): void => {
		const metadata = readMetadata(runDir);
		if (!metadata) return;
		const next = `subagent ${metadata.name ?? metadata.handle}`;
		if (next === sessionName) return;
		pi.setSessionName(next);
		sessionName = next;
	};

	const processInbox = async (): Promise<void> => {
		if (processing || !currentContext) return;
		syncSessionName();
		const queueDir = inboxDir(runDir);
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
					updateMetadata(runDir, {
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

				updateMetadata(runDir, { state: "busy", error: undefined });
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
					updateMetadata(runDir, {
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

	pi.on("session_start", (_event, ctx) => {
		currentContext = ctx;
		const metadata = readMetadata(runDir);
		if (!metadata) return;
		updateMetadata(runDir, {
			childSessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile() ?? metadata.sessionFile,
			state: ctx.isIdle() ? "idle" : "busy",
			suspended: undefined,
			error: undefined,
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
		updateMetadata(runDir, { state: "busy", hasStarted: true, error: undefined });
	});

	pi.on("agent_settled", (_event, ctx) => {
		currentContext = ctx;
		if (ctx.isIdle()) updateMetadata(runDir, { state: "idle" });
	});

	pi.on("session_shutdown", (event) => {
		currentContext = undefined;
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		if (event.reason === "quit") updateMetadata(runDir, { state: "exited" });
	});
}
