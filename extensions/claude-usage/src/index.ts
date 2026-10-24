import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Keep this module small. Pi loads it during startup, so it must not import the
// quota implementation, read files, start processes, or contact the network.
// ./usage.ts loads only when the session uses Claude, and its first refresh
// waits until after startup.

const COMMAND_NAME = "claude-account";

type UsageModule = typeof import("./usage");
type UsageService = ReturnType<UsageModule["createClaudeUsage"]>;

export default function (pi: ExtensionAPI) {
	let servicePromise: Promise<UsageService> | undefined;
	let activeSessionId: string | undefined;
	let failureReported = false;

	function isClaudeModel(ctx: ExtensionContext, model: ExtensionContext["model"]): boolean {
		if (!model) return false;
		if (model.provider === "claude-directsdk" || model.provider.startsWith("claude")) return true;
		// Pi's built-in Anthropic provider uses a subscription only through OAuth.
		return model.provider === "anthropic" && ctx.modelRegistry.isUsingOAuth(model);
	}

	function service(): Promise<UsageService> {
		if (!servicePromise) {
			servicePromise = import("./usage")
				.then((module) => module.createClaudeUsage())
				.catch((error: unknown) => {
					servicePromise = undefined;
					throw error;
				});
		}
		return servicePromise;
	}

	function report(ctx: ExtensionContext, error: unknown): void {
		if (failureReported) return;
		failureReported = true;
		const message = error instanceof Error ? error.message : String(error);
		try {
			ctx.ui.notify(`Claude usage unavailable: ${message}`, "warning");
		} catch {
			// No UI is available; the footer stays empty.
		}
	}

	function sessionId(ctx: ExtensionContext): string {
		return ctx.sessionManager.getSessionId();
	}

	function activate(ctx: ExtensionContext): void {
		activeSessionId = sessionId(ctx);
		void service()
			.then((usage) => usage.activate(ctx))
			.catch((error: unknown) => report(ctx, error));
	}

	function deactivate(ctx: ExtensionContext): void {
		activeSessionId = undefined;
		if (!servicePromise) return;
		void service()
			.then((usage) => usage.deactivate(ctx))
			.catch((error: unknown) => report(ctx, error));
	}

	pi.on("session_start", (_event, ctx) => {
		const id = sessionId(ctx);
		if (ctx.mode !== "tui" || !isClaudeModel(ctx, ctx.model)) {
			if (activeSessionId === id) deactivate(ctx);
			return;
		}
		if (activeSessionId === id) return;
		activate(ctx);
	});

	pi.on("model_select", (event, ctx) => {
		const id = sessionId(ctx);
		if (ctx.mode === "tui" && isClaudeModel(ctx, event.model)) {
			if (activeSessionId !== id) activate(ctx);
			return;
		}
		if (activeSessionId === id) deactivate(ctx);
	});

	// Follow usage while the run is in progress, not only when it settles.
	// The usage module throttles the requests, so extra events cost nothing.
	function poke(ctx: ExtensionContext): void {
		if (activeSessionId !== sessionId(ctx)) return;
		void service()
			.then((usage) => usage.poke(ctx))
			.catch((error: unknown) => report(ctx, error));
	}

	pi.on("agent_start", (_event, ctx) => poke(ctx));
	pi.on("turn_end", (_event, ctx) => poke(ctx));
	pi.on("agent_settled", (_event, ctx) => poke(ctx));

	pi.on("session_shutdown", (_event, ctx) => {
		if (activeSessionId === sessionId(ctx)) deactivate(ctx);
	});

	pi.registerCommand(COMMAND_NAME, {
		description: "Choose which Claude account the usage footer shows (5h + weekly remaining)",
		handler: async (args, ctx) => {
			const usage = await service();
			await usage.runCommand(args, ctx, activeSessionId === sessionId(ctx));
		},
	});
}
