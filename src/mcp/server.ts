import * as fs from "node:fs/promises";
import * as path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  getIssueContextArgNames,
  getLocalChangesArgNames,
  getPrContextArgNames,
  getWorkflowRunContextArgNames,
  resolveWorkflowContextValues
} from "../workflowContextResolverCore";
import { renderPromptTemplate } from "../workflowCore";
import { dedupeWorkflowDefinitions, loadEffectiveWorkflowDefinitionsFromPaths } from "../workflowRegistryCore";

const server = new McpServer({
  name: "CMSIS-Dev-MCP",
  version: "0.0.1"
});

const mcpServer: any = server;

type WorkflowInputType =
  | "text"
  | "github-pr-context"
  | "github-issue-context"
  | "git-local-changes-context"
  | "run-output-context"
  | "github-workflow-run-context";

type WorkflowInputDefinition = {
  id: string;
  label: string;
  type?: WorkflowInputType;
  required?: boolean;
};

type WorkflowDefinition = {
  id: string;
  title?: string;
  description?: string;
  promptTemplate?: string;
  inputs?: WorkflowInputDefinition[];
};

type WorkflowToolSchema = Record<string, z.ZodTypeAny>;

void start();

async function start(): Promise<void> {
  try {
    await registerWorkflowTools();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[CMSIS-Dev MCP] Failed to register workflow tools: ${message}`);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function registerWorkflowTools(): Promise<void> {
  const bundledWorkflowConfigPath = resolveBundledWorkflowConfigPath();
  const workspaceWorkflowConfigPath = await resolveWorkspaceWorkflowConfigPath();
  const workflowRunsDirPath = resolveWorkflowRunsDirPath(workspaceWorkflowConfigPath);
  const workflows = dedupeWorkflowDefinitions(
    await loadEffectiveWorkflowDefinitionsFromPaths(bundledWorkflowConfigPath, workspaceWorkflowConfigPath, (message) => {
      console.warn(`[CMSIS-Dev MCP] ${message}`);
    })
  );
  const registeredToolNames = new Set<string>();

  for (const workflow of workflows) {
    const promptTemplate = workflow.promptTemplate?.trim();
    if (!promptTemplate) {
      console.warn(`[CMSIS-Dev MCP] Skipping workflow '${workflow.id}' because promptTemplate is missing.`);
      continue;
    }

    const schema = buildWorkflowToolSchema(workflow);
    if (!schema) {
      console.warn(`[CMSIS-Dev MCP] Skipping workflow '${workflow.id}' because its inputs are not MCP-compatible.`);
      continue;
    }

    const toolName = toMcpToolName(workflow.id);
    if (registeredToolNames.has(toolName)) {
      console.warn(`[CMSIS-Dev MCP] Duplicate MCP tool name '${toolName}' derived from workflow '${workflow.id}'. Skipping.`);
      continue;
    }

    registeredToolNames.add(toolName);
    mcpServer.tool(toolName, schema, async (args: Record<string, unknown>) => {
      const values = await resolveWorkflowValues(workflow, workflowRunsDirPath, args);
      const prompt = renderPromptTemplate(promptTemplate, values);
      return {
        content: [
          {
            type: "text",
            text: prompt
          }
        ]
      };
    });
  }
}

function buildWorkflowToolSchema(workflow: WorkflowDefinition): WorkflowToolSchema | undefined {
  const inputs = workflow.inputs ?? [];
  const shape: WorkflowToolSchema = {};
  let needsGitHubToken = false;

  const prContextCount = inputs.filter((input) => input.type === "github-pr-context").length;
  const issueContextCount = inputs.filter((input) => input.type === "github-issue-context").length;
  const localChangesCount = inputs.filter((input) => input.type === "git-local-changes-context").length;
  const workflowRunContextCount = inputs.filter((input) => input.type === "github-workflow-run-context").length;

  for (const input of inputs) {
    const required = input.required !== false;
    const label = input.label || input.id;

    if (!input.type || input.type === "text") {
      shape[input.id] = required
        ? z.string().min(1).describe(label)
        : z.string().optional().describe(label);
      continue;
    }

    if (input.type === "github-pr-context") {
      const names = getPrContextArgNames(input.id, prContextCount);
      shape[names.owner] = z.string().min(1).describe(`GitHub repository owner for ${label}`);
      shape[names.repo] = z.string().min(1).describe(`GitHub repository name for ${label}`);
      shape[names.pullNumber] = z.number().int().positive().describe(`Pull request number for ${label}`);
      needsGitHubToken = true;
      continue;
    }

    if (input.type === "github-issue-context") {
      const names = getIssueContextArgNames(input.id, issueContextCount);
      shape[names.owner] = z.string().min(1).describe(`GitHub repository owner for ${label}`);
      shape[names.repo] = z.string().min(1).describe(`GitHub repository name for ${label}`);
      shape[names.issueNumber] = z.number().int().positive().describe(`Issue number for ${label}`);
      needsGitHubToken = true;
      continue;
    }

    if (input.type === "git-local-changes-context") {
      const names = getLocalChangesArgNames(input.id, localChangesCount);
      shape[names.repoPath] = z.string().min(1).describe(`Local git repository path for ${label}`);
      continue;
    }

    if (input.type === "run-output-context") {
      shape[input.id] = required
        ? z.string().min(1).describe(`CMSIS-Dev run output file path for ${label}`)
        : z.string().optional().describe(`CMSIS-Dev run output file path for ${label}`);
      continue;
    }

    if (input.type === "github-workflow-run-context") {
      const names = getWorkflowRunContextArgNames(input.id, workflowRunContextCount);
      shape[names.owner] = z.string().min(1).describe(`GitHub repository owner for ${label}`);
      shape[names.repo] = z.string().min(1).describe(`GitHub repository name for ${label}`);
      shape[names.runId] = z.number().int().positive().describe(`Workflow run id for ${label}`);
      needsGitHubToken = true;
      continue;
    }

    return undefined;
  }

  if (needsGitHubToken) {
    shape.githubToken = z.string().optional().describe("Optional GitHub token for GitHub API requests.");
  }

  return shape;
}

async function resolveWorkflowValues(
  workflow: WorkflowDefinition,
  workflowRunsDirPath: string,
  args: Record<string, unknown>
): Promise<Record<string, string>> {
  const token = typeof args.githubToken === "string" && args.githubToken.trim().length > 0 ? args.githubToken.trim() : undefined;
  return resolveWorkflowContextValues(workflow, {
    args: args as Record<string, string | number | undefined>,
    githubToken: token,
    workflowRunsDirPath,
    includeTextInputs: true
  });
}

function resolveBundledWorkflowConfigPath(): string {
  const fromEnv = process.env.CMSIS_DEV_BUNDLED_WORKFLOW_CONFIG?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  const extensionPath = process.env.CMSIS_DEV_EXTENSION_PATH?.trim();
  if (extensionPath) {
    return path.join(extensionPath, ".cmsis-dev", "workflows");
  }

  return path.resolve(__dirname, "..", "..", ".cmsis-dev", "workflows");
}

function resolveWorkflowRunsDirPath(workspaceWorkflowConfigPath?: string): string {
  const fromEnv = process.env.CMSIS_DEV_WORKFLOW_RUNS_DIR?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  if (workspaceWorkflowConfigPath) {
    return path.join(path.dirname(workspaceWorkflowConfigPath), "runs");
  }

  return path.join(process.cwd(), ".cmsis-dev", "runs");
}

async function resolveWorkspaceWorkflowConfigPath(): Promise<string | undefined> {
  const fromEnv = process.env.CMSIS_DEV_WORKSPACE_WORKFLOW_CONFIG?.trim();
  if (fromEnv && (await fileExists(fromEnv))) {
    return fromEnv;
  }

  const directDir = path.join(process.cwd(), ".cmsis-dev", "workflows");
  if (await fileExists(directDir)) {
    return directDir;
  }

  const nestedPath = await findNestedWorkflowConfig(process.cwd(), 6);
  if (nestedPath) {
    return nestedPath;
  }

  return undefined;
}

async function findNestedWorkflowConfig(rootDir: string, maxDepth: number): Promise<string | undefined> {
  const skipDirs = new Set([".git", "node_modules", "out", "dist"]);
  const queue: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    const candidate = path.join(current.dir, ".cmsis-dev", "workflows");
    if (await fileExists(candidate)) {
      return candidate;
    }

    if (current.depth >= maxDepth) {
      continue;
    }

    let entries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || skipDirs.has(entry.name)) {
        continue;
      }

      queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
    }
  }

  return undefined;
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function toMcpToolName(workflowId: string): string {
  return workflowId.replace(/-/g, "_");
}

