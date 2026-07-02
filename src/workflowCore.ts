import { WorkflowDefinition, WorkflowFollowUp } from "./types";

export const DEFAULT_OUTPUT_FOLLOW_UPS: readonly WorkflowFollowUp[] = ["openReasoning"];

const ALLOWED_FOLLOW_UPS = new Set<WorkflowFollowUp>([
  "openReasoning",
  "openPr",
  "openIssue",
  "postComment",
  "submitPr",
  "commitChanges"
]);

export function renderPromptTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_full, key) => values[key] ?? "");
}

export function buildWorkflowPrompt(
  template: string,
  values: Record<string, string>,
  additionalInstructions?: string
): string {
  const prompt = renderPromptTemplate(template, values);
  const extra = additionalInstructions?.trim();
  if (!extra) {
    return prompt;
  }

  return [prompt.trimEnd(), "", "Additional user instructions:", extra].join("\n");
}

export function normalizeWorkflowFollowUps(followUps: readonly WorkflowFollowUp[] | undefined): WorkflowFollowUp[] {
  return Array.from(new Set((followUps ?? []).filter((followUp) => ALLOWED_FOLLOW_UPS.has(followUp)))) as WorkflowFollowUp[];
}

export function resolveWorkflowFollowUps(workflow: Pick<WorkflowDefinition, "followUps">): WorkflowFollowUp[] {
  const configured = normalizeWorkflowFollowUps(workflow.followUps);
  if (configured.length > 0) {
    return configured;
  }

  return [...DEFAULT_OUTPUT_FOLLOW_UPS];
}