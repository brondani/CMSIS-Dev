import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildWorkflowPrompt } from "./workflowCore";
import { camelToKebab, resolveWorkflowContextValues } from "./workflowContextResolverCore";
import { loadEffectiveWorkflowDefinitionsFromPaths } from "./workflowRegistryCore";

type CliOptions = {
  command?: string;
  workflowId?: string;
  installedWorkflows?: string;
  workspaceWorkflows?: string;
  workflowRunsDir?: string;
  githubToken?: string;
  args: Record<string, string>;
  valuesFile?: string;
  values: Record<string, string>;
};

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options.command || options.command === "help" || options.command === "--help" || options.command === "-h") {
    printHelp();
    return;
  }

  if (options.command !== "render") {
    throw new Error(`Unknown command '${options.command}'.`);
  }

  if (!options.workflowId) {
    throw new Error("Missing workflow id. Usage: cmsis-dev-cli render <workflow-id> [options]");
  }

  const installedWorkflows = options.installedWorkflows ?? resolveDefaultInstalledWorkflowsPath();
  const workspaceWorkflows = options.workspaceWorkflows ?? (await resolveDefaultWorkspaceWorkflowsPath());
  const workflows = await loadEffectiveWorkflowDefinitionsFromPaths(installedWorkflows, workspaceWorkflows, (message) => {
    console.warn(`[CMSIS-Dev CLI] ${message}`);
  });
  const workflow = workflows.find((candidate) => candidate.id === options.workflowId);
  if (!workflow) {
    throw new Error(`Workflow '${options.workflowId}' was not found.`);
  }

  const promptTemplate = workflow.promptTemplate?.trim();
  if (!promptTemplate) {
    throw new Error(`Workflow '${workflow.id}' does not define promptTemplate.`);
  }

  const fileValues = options.valuesFile ? await readValuesFile(options.valuesFile) : {};
  const githubToken = options.githubToken ?? process.env.CMSIS_DEV_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN;
  const workflowRunsDir = options.workflowRunsDir ?? resolveDefaultWorkflowRunsDirPath(workspaceWorkflows);
  const contextValues = await resolveWorkflowContextValues(workflow, {
    args: options.args,
    githubToken,
    workflowRunsDirPath: workflowRunsDir,
    formatArgumentName: (key) => `--${camelToKebab(key)}`
  });
  const values = { ...fileValues, ...contextValues, ...options.values };
  process.stdout.write(`${buildWorkflowPrompt(promptTemplate, values)}\n`);
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { args: {}, values: {} };
  const [command, workflowId, ...rest] = args;
  options.command = command;
  options.workflowId = workflowId;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--installed-workflows") {
      options.installedWorkflows = expectValue(rest, (index += 1), arg);
      continue;
    }

    if (arg === "--workspace-workflows") {
      options.workspaceWorkflows = expectValue(rest, (index += 1), arg);
      continue;
    }

    if (arg === "--values-file") {
      options.valuesFile = expectValue(rest, (index += 1), arg);
      continue;
    }

    if (arg === "--workflow-runs-dir") {
      options.workflowRunsDir = expectValue(rest, (index += 1), arg);
      continue;
    }

    if (arg === "--github-token") {
      options.githubToken = expectValue(rest, (index += 1), arg);
      continue;
    }

    if (arg === "--value") {
      const rawValue = expectValue(rest, (index += 1), arg);
      const separator = rawValue.indexOf("=");
      if (separator <= 0) {
        throw new Error("Expected --value in key=value format.");
      }

      options.values[rawValue.slice(0, separator)] = rawValue.slice(separator + 1);
      continue;
    }

    if (arg.startsWith("--")) {
      options.args[kebabToCamel(arg.slice(2))] = expectValue(rest, (index += 1), arg);
      continue;
    }

    throw new Error(`Unknown argument '${arg}'.`);
  }

  return options;
}

function expectValue(args: string[], index: number, optionName: string): string {
  const value = args[index];
  if (!value) {
    throw new Error(`Missing value for ${optionName}.`);
  }
  return value;
}

async function readValuesFile(valuesFile: string): Promise<Record<string, string>> {
  const raw = await fs.readFile(valuesFile, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    values[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return values;
}

function resolveDefaultInstalledWorkflowsPath(): string {
  const fromEnv = process.env.CMSIS_DEV_BUNDLED_WORKFLOW_CONFIG?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  const repoRootCandidate = path.resolve(__dirname, "..", ".cmsis-dev", "workflows");
  return repoRootCandidate;
}

async function resolveDefaultWorkspaceWorkflowsPath(): Promise<string | undefined> {
  const fromEnv = process.env.CMSIS_DEV_WORKSPACE_WORKFLOW_CONFIG?.trim();
  if (fromEnv && (await fileExists(fromEnv))) {
    return fromEnv;
  }

  const directDir = path.join(process.cwd(), ".cmsis-dev", "workflows");
  return (await fileExists(directDir)) ? directDir : undefined;
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function resolveDefaultWorkflowRunsDirPath(workspaceWorkflowConfigPath?: string): string {
  const fromEnv = process.env.CMSIS_DEV_WORKFLOW_RUNS_DIR?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  if (workspaceWorkflowConfigPath) {
    return path.join(path.dirname(workspaceWorkflowConfigPath), "runs");
  }

  return path.join(process.cwd(), ".cmsis-dev", "runs");
}

function kebabToCamel(value: string): string {
  return value.replace(/-([a-z0-9])/g, (_match, character: string) => character.toUpperCase());
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage: cmsis-dev-cli render <workflow-id> [options]",
      "",
      "Options:",
      "  --installed-workflows <path>   Installed workflow file or directory",
      "  --workspace-workflows <path>   Local override workflow file or directory",
      "  --workflow-runs-dir <path>      Directory containing CMSIS-Dev run metadata",
      "  --github-token <token>          GitHub token; defaults to CMSIS_DEV_GITHUB_TOKEN or GITHUB_TOKEN",
      "  --values-file <path>           JSON object with placeholder values",
      "  --value <key=value>            Placeholder value; can be repeated",
      "",
      "Context options:",
      "  --owner <owner>                GitHub owner for single GitHub context workflows",
      "  --repo <repo>                  GitHub repository for single GitHub context workflows",
      "  --pull-number <number>         Pull request number for github-pr-context",
      "  --issue-number <number>        Issue number for github-issue-context",
      "  --run-id <number>              Workflow run id for github-workflow-run-context",
      "  --repo-path <path>             Local repository path for git-local-changes-context",
      "  --<input-id>-owner, --<input-id>-repo, etc. are used when a workflow has multiple contexts"
    ].join("\n") + "\n"
  );
}