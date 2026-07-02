import { IssueComment, IssueSummary, PullRequestFile, PullRequestSummary } from "./types";

export interface WorkflowRunSummaryLike {
  id: number;
  name: string;
  displayTitle: string;
  htmlUrl: string;
  event: string;
  status: string;
  conclusion: string;
  headBranch: string;
  headSha: string;
  runNumber: number;
  attempt: number;
  actor: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRunJobSummaryLike {
  id: number;
  name: string;
  status: string;
  conclusion: string;
  startedAt: string;
  completedAt: string;
  steps: Array<{
    name: string;
    status: string;
    conclusion: string;
    number: number;
  }>;
}

export function buildPullRequestContextValues(
  inputId: string,
  owner: string,
  repo: string,
  pr: PullRequestSummary,
  files: readonly PullRequestFile[],
  options: { rootPath?: string; workspaceFolderName?: string } = {}
): Record<string, string> {
  const fileSections = formatPullRequestFileSections(files);
  const values: Record<string, string> = {
    [inputId]: `${owner}/${repo}#${pr.number}`,
    [`${inputId}_owner`]: owner,
    [`${inputId}_repo`]: repo,
    [`${inputId}_prNumber`]: String(pr.number),
    [`${inputId}_prTitle`]: pr.title,
    [`${inputId}_author`]: pr.author,
    [`${inputId}_headRef`]: pr.headRef,
    [`${inputId}_baseRef`]: pr.baseRef,
    [`${inputId}_prBody`]: pr.body || "(No PR description provided)",
    [`${inputId}_fileSections`]: fileSections,
    [`${inputId}_prUrl`]: pr.htmlUrl,
    owner,
    repo,
    prNumber: String(pr.number),
    prTitle: pr.title,
    author: pr.author,
    headRef: pr.headRef,
    baseRef: pr.baseRef,
    prBody: pr.body || "(No PR description provided)",
    fileSections,
    prUrl: pr.htmlUrl
  };

  if (options.rootPath) {
    values[`${inputId}_repoPath`] = options.rootPath;
    values.repoPath = options.rootPath;
  }
  if (options.workspaceFolderName) {
    values[`${inputId}_workspaceFolder`] = options.workspaceFolderName;
    values.workspaceFolder = options.workspaceFolderName;
  }

  return values;
}

export function mergeWorkflowContextValues(target: Record<string, string>, inputId: string, source: Record<string, string>): void {
  for (const [key, value] of Object.entries(source)) {
    if (key === inputId || key.startsWith(`${inputId}_`)) {
      target[key] = value;
    } else {
      target[key] ??= value;
    }
  }
}

export function buildIssueContextValues(
  inputId: string,
  owner: string,
  repo: string,
  issue: IssueSummary,
  comments: readonly IssueComment[],
  references: { linkedPullRequests: readonly string[]; relatedIssues: readonly string[] },
  options: { rootPath?: string; workspaceFolderName?: string } = {}
): Record<string, string> {
  const issueBody = issue.body || "(No issue description provided)";
  const issueLabels = issue.labels.length > 0 ? issue.labels.join(", ") : "(No labels)";
  const issueAssignees = issue.assignees.length > 0 ? issue.assignees.join(", ") : "(No assignees)";
  const issueComments = formatIssueComments(comments);
  const linkedPrs = formatSimpleList(references.linkedPullRequests, "(No linked pull requests found)");
  const relatedIssues = formatSimpleList(references.relatedIssues, "(No related issues found)");
  const values: Record<string, string> = {
    [inputId]: `${owner}/${repo}#${issue.number}`,
    [`${inputId}_owner`]: owner,
    [`${inputId}_repo`]: repo,
    [`${inputId}_number`]: String(issue.number),
    [`${inputId}_title`]: issue.title,
    [`${inputId}_author`]: issue.author,
    [`${inputId}_body`]: issueBody,
    [`${inputId}_state`]: issue.state,
    [`${inputId}_labels`]: issueLabels,
    [`${inputId}_assignees`]: issueAssignees,
    [`${inputId}_commentsCount`]: String(issue.commentsCount),
    [`${inputId}_comments`]: issueComments,
    [`${inputId}_linkedPrs`]: linkedPrs,
    [`${inputId}_relatedIssues`]: relatedIssues,
    [`${inputId}_url`]: issue.htmlUrl,
    [`${inputId}_issueNumber`]: String(issue.number),
    [`${inputId}_issueTitle`]: issue.title,
    [`${inputId}_issueAuthor`]: issue.author,
    [`${inputId}_issueBody`]: issueBody,
    [`${inputId}_issueState`]: issue.state,
    [`${inputId}_issueLabels`]: issueLabels,
    [`${inputId}_issueAssignees`]: issueAssignees,
    [`${inputId}_issueCommentsCount`]: String(issue.commentsCount),
    [`${inputId}_issueComments`]: issueComments,
    owner,
    repo,
    issueNumber: String(issue.number),
    issueTitle: issue.title,
    issueAuthor: issue.author,
    issueBody,
    issueState: issue.state,
    issueLabels,
    issueAssignees,
    issueCommentsCount: String(issue.commentsCount),
    issueComments,
    linkedPrs,
    relatedIssues,
    issueUrl: issue.htmlUrl
  };

  if (options.rootPath) {
    values[`${inputId}_repoPath`] = options.rootPath;
    values.repoPath = options.rootPath;
  }
  if (options.workspaceFolderName) {
    values[`${inputId}_workspaceFolder`] = options.workspaceFolderName;
    values.workspaceFolder = options.workspaceFolderName;
  }

  return values;
}

export function buildWorkflowRunContextValues(
  inputId: string,
  owner: string,
  repo: string,
  runId: number,
  run: WorkflowRunSummaryLike,
  jobs: readonly WorkflowRunJobSummaryLike[],
  logs: string,
  options: { rootPath?: string; workspaceFolderName?: string } = {}
): Record<string, string> {
  const failingJobsSummary = formatWorkflowRunJobs(jobs);
  const values: Record<string, string> = {
    [inputId]: run.htmlUrl,
    [`${inputId}_owner`]: owner,
    [`${inputId}_repo`]: repo,
    [`${inputId}_runId`]: String(runId),
    [`${inputId}_runNumber`]: String(run.runNumber),
    [`${inputId}_title`]: run.displayTitle,
    [`${inputId}_event`]: run.event,
    [`${inputId}_status`]: run.status,
    [`${inputId}_conclusion`]: run.conclusion || "(No conclusion)",
    [`${inputId}_branch`]: run.headBranch || "(Unknown branch)",
    [`${inputId}_sha`]: run.headSha || "(Unknown SHA)",
    [`${inputId}_actor`]: run.actor,
    [`${inputId}_url`]: run.htmlUrl,
    [`${inputId}_failingJobsSummary`]: failingJobsSummary,
    [`${inputId}_logs`]: logs,
    owner,
    repo,
    workflowRunId: String(runId),
    workflowRunNumber: String(run.runNumber),
    workflowRunTitle: run.displayTitle,
    workflowRunEvent: run.event,
    workflowRunStatus: run.status,
    workflowRunConclusion: run.conclusion || "(No conclusion)",
    workflowRunBranch: run.headBranch || "(Unknown branch)",
    workflowRunSha: run.headSha || "(Unknown SHA)",
    workflowRunActor: run.actor,
    workflowRunUrl: run.htmlUrl,
    failingJobsSummary,
    workflowRunLogs: logs
  };

  if (options.rootPath) {
    values[`${inputId}_repoPath`] = options.rootPath;
    values.repoPath = options.rootPath;
  }
  if (options.workspaceFolderName) {
    values[`${inputId}_workspaceFolder`] = options.workspaceFolderName;
    values.workspaceFolder = options.workspaceFolderName;
  }

  return values;
}

export function formatPullRequestFileSections(files: readonly PullRequestFile[]): string {
  return files
    .map((file) => {
      const patch = (file.patch ?? "(No textual diff available)").slice(0, 4000);
      return `File: ${file.filename}\nStatus: ${file.status}, +${file.additions} -${file.deletions}\nPatch:\n${patch}`;
    })
    .join("\n\n---\n\n");
}

export function formatIssueComments(comments: readonly IssueComment[]): string {
  if (comments.length === 0) {
    return "(No issue comments available)";
  }

  return comments
    .map((comment) => {
      const body = (comment.body || "(No comment body)").slice(0, 4000);
      return `Comment by @${comment.author}${comment.createdAt ? ` on ${comment.createdAt}` : ""}:\n${body}`;
    })
    .join("\n\n---\n\n");
}

export function formatWorkflowRunJobs(jobs: readonly WorkflowRunJobSummaryLike[]): string {
  if (jobs.length === 0) {
    return "(No workflow jobs found)";
  }

  return jobs
    .map((job) => {
      const failingSteps = job.steps.filter((step) => step.conclusion && step.conclusion !== "success" && step.conclusion !== "skipped");
      const failingStepSummary =
        failingSteps.length > 0
          ? ` | failing steps: ${failingSteps.map((step) => step.name).join(", ")}`
          : "";
      return `- ${job.name} [status: ${job.status || "unknown"}, conclusion: ${job.conclusion || "unknown"}]${failingStepSummary}`;
    })
    .join("\n");
}

export function formatSimpleList(items: readonly string[], emptyText: string): string {
  if (items.length === 0) {
    return emptyText;
  }

  return items.map((item) => `- ${item}`).join("\n");
}

export function tailText(value: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `[Truncated to last ${maxLength} characters]\n${normalized.slice(-maxLength)}`;
}

export function truncateForPrompt(value: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength)}\n\n[Truncated by CMSIS-Dev for prompt size.]`;
}
