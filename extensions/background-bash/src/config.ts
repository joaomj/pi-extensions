import { loadConfigOrDefault, templatedString } from "@richardgill/pi-config";
import { z } from "zod";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const BACKGROUND_BASH_STATUS_KEY = "backgroundBashProcesses";

const DEFAULT_BASH_DESCRIPTION =
  "Execute a bash command. Output is truncated to Pi's standard limits. Known long-running commands (test suites, builds, installs, containers, migrations, servers, remote sessions, waits) start in the background immediately. Other commands wait up to {{defaultTimeoutSeconds}}s (max {{maxTimeoutSeconds}}s), then continue in the background as the same process. Background processes report automatically when they finish.";
const DEFAULT_PROCESS_DESCRIPTION =
  "List, inspect, or kill background processes created by {{bashToolName}}.";
const DEFAULT_GUIDELINES = [
  "Run the narrowest test or check that proves a change. Do not run a full test suite unless the user asks for it.",
  "Known long-running commands start in the background automatically; other {{bashToolName}} commands move there after their timeout. Commands are never killed by a timeout.",
  "After a background handoff, end the turn. Do not rerun the command.",
  "Background processes survive reloads and Pi exit. Their results are recovered when their owning session resumes.",
  "You will be notified when background processes finish. Do not sleep or poll to wait.",
  "Logs keep their first {{maxLogBytes}} bytes, then discard excess output without stopping the command. A capped log is not a complete record.",
  "Use {{processToolName}} list/peek/kill with the jobId returned by {{bashToolName}}.",
];

const templateVariables = [
  "bashToolName",
  "processToolName",
  "defaultTimeoutSeconds",
  "maxTimeoutSeconds",
  "maxLogBytes",
];

const nonEmptyStringSchema = z.string().trim().min(1);
const positiveIntegerSchema = z.number().int().positive();
const promptTemplateSchema = templatedString({ variables: templateVariables }).trim().min(1);
const promptSnippetSchema = z.union([promptTemplateSchema, z.literal(false)]);

const timeoutOrderIsValid = (config: {
  defaultTimeoutSeconds?: number;
  maxTimeoutSeconds?: number;
}): boolean =>
  config.defaultTimeoutSeconds === undefined ||
  config.maxTimeoutSeconds === undefined ||
  config.defaultTimeoutSeconds <= config.maxTimeoutSeconds;

const buildOptionsSchema = () =>
  z
    .object({
      defaultTimeoutSeconds: positiveIntegerSchema.default(30),
      maxTimeoutSeconds: positiveIntegerSchema.default(30),
      maxLogBytes: positiveIntegerSchema.max(Number.MAX_SAFE_INTEGER).default(2 * 1024 * 1024),
      outputDir: nonEmptyStringSchema.default(join(tmpdir(), "pi-background-bash")),
      preserveOutputFiles: z.boolean().default(true),
      bashToolName: nonEmptyStringSchema.default("bash"),
      processToolName: nonEmptyStringSchema.default("bash_process"),
      bashToolDescription: promptTemplateSchema.default(DEFAULT_BASH_DESCRIPTION),
      processToolDescription: promptTemplateSchema.default(DEFAULT_PROCESS_DESCRIPTION),
      systemPrompt: z.boolean().default(true),
      bashSystemPromptSnippet: promptSnippetSchema.default(
        "Execute bash commands with automatic background handoff",
      ),
      processSystemPromptSnippet: promptSnippetSchema.default(
        "Inspect and control background bash processes",
      ),
      systemPromptGuidelines: z.array(promptTemplateSchema).default(() => [...DEFAULT_GUIDELINES]),
    })
    .refine(timeoutOrderIsValid, {
      message: "defaultTimeoutSeconds must be less than or equal to maxTimeoutSeconds",
    });

export const BackgroundBashOptionsSchema = buildOptionsSchema();
export const BackgroundBashConfigSchema = buildOptionsSchema();

export type BackgroundBashOptions = z.input<typeof BackgroundBashOptionsSchema>;
export type ResolvedOptions = z.infer<typeof BackgroundBashOptionsSchema>;

const renderTemplate = (template: string, options: ResolvedOptions): string => {
  const values = {
    bashToolName: options.bashToolName,
    processToolName: options.processToolName,
    defaultTimeoutSeconds: String(options.defaultTimeoutSeconds),
    maxTimeoutSeconds: String(options.maxTimeoutSeconds),
    maxLogBytes: String(options.maxLogBytes),
  };

  return Object.entries(values).reduce(
    (text, [name, value]) => text.replace(new RegExp(`{{\\s*${name}\\s*}}`, "g"), value),
    template,
  );
};

const renderSnippet = (value: string | false, options: ResolvedOptions): string | false =>
  value === false ? false : renderTemplate(value, options);

const resolveParsedOptions = (options: ResolvedOptions): ResolvedOptions => ({
  ...options,
  bashToolDescription: renderTemplate(options.bashToolDescription, options),
  processToolDescription: renderTemplate(options.processToolDescription, options),
  bashSystemPromptSnippet: renderSnippet(options.bashSystemPromptSnippet, options),
  processSystemPromptSnippet: renderSnippet(options.processSystemPromptSnippet, options),
  systemPromptGuidelines: options.systemPromptGuidelines.map((guideline) =>
    renderTemplate(guideline, options),
  ),
});

export const resolveOptions = (input: BackgroundBashOptions = {}): ResolvedOptions =>
  resolveParsedOptions(BackgroundBashOptionsSchema.parse(input));

export const DEFAULT_OPTIONS = resolveOptions();

export const loadBackgroundBashConfig = (): ResolvedOptions =>
  resolveOptions(
    loadConfigOrDefault({
      filename: "background-bash.jsonc",
      schema: BackgroundBashConfigSchema,
    }),
  );
