import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse } from "yaml";
import { WorkflowDefinition } from "./types";

export async function loadEffectiveWorkflowDefinitionsFromPaths(
  installedWorkflowConfigPath: string,
  workspaceWorkflowConfigPath?: string,
  onWarning?: (message: string) => void
): Promise<WorkflowDefinition[]> {
  const [installedWorkflows, workspaceWorkflows] = await Promise.all([
    loadWorkflowDefinitionsFromPath(installedWorkflowConfigPath, onWarning),
    workspaceWorkflowConfigPath ? loadWorkflowDefinitionsFromPath(workspaceWorkflowConfigPath, onWarning) : Promise.resolve([])
  ]);

  return mergeWorkflowDefinitions(installedWorkflows, workspaceWorkflows);
}

export async function loadWorkflowDefinitionsFromPath(
  workflowConfigPath: string,
  onWarning?: (message: string) => void
): Promise<WorkflowDefinition[]> {
  try {
    const stats = await fs.stat(workflowConfigPath);
    if (stats.isDirectory()) {
      const entries = (await fs.readdir(workflowConfigPath))
        .filter((entry) => isYamlPath(entry))
        .sort((left, right) => left.localeCompare(right));
      const loaded = await Promise.all(
        entries.map((entry) => loadWorkflowDefinitionsFromFile(path.join(workflowConfigPath, entry), onWarning))
      );
      return loaded.flat();
    }

    return loadWorkflowDefinitionsFromFile(workflowConfigPath, onWarning);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onWarning?.(`Failed to load workflow config '${workflowConfigPath}': ${message}`);
    return [];
  }
}

export async function loadWorkflowDefinitionsFromFile(
  workflowConfigPath: string,
  onWarning?: (message: string) => void
): Promise<WorkflowDefinition[]> {
  try {
    const raw = await fs.readFile(workflowConfigPath, "utf8");
    const parsed = parse(raw) as
      | { workflows?: WorkflowDefinition[]; workflow?: WorkflowDefinition }
      | WorkflowDefinition
      | undefined;

    if (!parsed) {
      return [];
    }

    if (Array.isArray((parsed as { workflows?: WorkflowDefinition[] }).workflows)) {
      return (parsed as { workflows: WorkflowDefinition[] }).workflows;
    }

    if ((parsed as { workflow?: WorkflowDefinition }).workflow) {
      return [(parsed as { workflow: WorkflowDefinition }).workflow];
    }

    if (isWorkflowDefinition(parsed)) {
      return [parsed];
    }

    return [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onWarning?.(`Failed to parse workflow config '${workflowConfigPath}': ${message}`);
    return [];
  }
}

export function mergeWorkflowDefinitions(
  installedWorkflows: WorkflowDefinition[],
  workspaceWorkflows: WorkflowDefinition[]
): WorkflowDefinition[] {
  const merged = new Map<string, WorkflowDefinition>();

  for (const workflow of installedWorkflows) {
    if (!workflow.id || merged.has(workflow.id)) {
      continue;
    }

    merged.set(workflow.id, workflow);
  }

  for (const workflow of workspaceWorkflows) {
    if (!workflow.id) {
      continue;
    }

    merged.set(workflow.id, workflow);
  }

  return Array.from(merged.values());
}

export function dedupeWorkflowDefinitions(workflows: WorkflowDefinition[]): WorkflowDefinition[] {
  const unique = new Map<string, WorkflowDefinition>();
  for (const workflow of workflows) {
    if (!workflow.id || unique.has(workflow.id)) {
      continue;
    }
    unique.set(workflow.id, workflow);
  }
  return Array.from(unique.values());
}

function isWorkflowDefinition(value: unknown): value is WorkflowDefinition {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<WorkflowDefinition>;
  return typeof candidate.id === "string";
}

function isYamlPath(targetPath: string): boolean {
  const extension = path.extname(targetPath).toLowerCase();
  return extension === ".yml" || extension === ".yaml";
}