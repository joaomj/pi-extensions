import { backgroundBash } from "../../src/extension";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const [outputDir, sessionId] = process.argv.slice(2);
if (!outputDir || !sessionId) throw new Error("outputDir and sessionId are required");
const handlers = new Map<string, (event: unknown, context: ExtensionContext) => Promise<void>>();
let bash: {
  execute: (
    ...args: unknown[]
  ) => Promise<{ details: { jobId: string; pgid: number; fullOutputPath: string } }>;
};
const context = {
  cwd: process.cwd(),
  hasUI: false,
  sessionManager: {
    getSessionId: () => sessionId,
    getSessionFile: () => undefined,
    getBranch: () => [],
  },
} as unknown as ExtensionContext;
const pi = {
  on: (name: string, handler: typeof handlers extends Map<string, infer H> ? H : never) =>
    handlers.set(name, handler),
  registerTool: (tool: typeof bash & { name: string }) => {
    if (tool.name === "bash") bash = tool;
  },
  registerCommand: () => {},
  registerMessageRenderer: () => {},
  sendMessage: () => {},
  getThinkingLevel: () => "off",
} as unknown as ExtensionAPI;
backgroundBash({ outputDir })(pi);
await handlers.get("session_start")!({}, context);
const result = await bash!.execute(
  "host-command",
  { command: "sleep 1; printf host-independent", background: true },
  undefined,
  undefined,
  context,
);
process.stdout.write(
  `${JSON.stringify({ jobId: result.details.jobId, pgid: result.details.pgid, logPath: result.details.fullOutputPath })}\n`,
);
setInterval(() => {}, 1000);
