import * as fs from "node:fs/promises";
import {
  getIssue,
  getIssueComments,
  getIssueReferences,
  getPullRequest,
  getPullRequestFiles,
  getWorkflowJobLog,
  getWorkflowRun,
  getWorkflowRunJobs
} from "./githubCore";
import { collectLocalChangesValues } from "./localGitCore";
import { WorkflowInputDefinition } from "./types";
import {
  buildIssueContextValues,
  buildPullRequestContextValues,
  buildWorkflowRunContextValues,
  mergeWorkflowContextValues,
  tailText,
  truncateForPrompt
} from "./workflowContextCore";

export type WorkflowContextArgumentValue = string | number | undefined;

export type WorkflowContextArguments = Record<string, WorkflowContextArgumentValue>;

export type WorkflowContextResolutionDefinition = {
  id: string;
  type?: string;
  inputs?: WorkflowInputDefinition[];
};

export type WorkflowContextResolutionOptions = {
  args: WorkflowContextArguments;
  githubToken?: string;
  workflowRunsDirPath?: string;
  includeTextInputs?: boolean;
  formatArgumentName?: (key: string) => string;
  isLocalReviewWorkflowId?: (workflowId: string | undefined) => boolean;
};

type RunOutputMetadata = {
  workflowId?: string;
  workflowTitle?: string;
  outputFile?: string;
  reasoningFile?: string;
};

export async function resolveWorkflowContextValues(
  workflow: WorkflowContextResolutionDefinition,
  options: WorkflowContextResolutionOptions
): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  const inputs = workflow.inputs ?? [];

  const prContextCount = inputs.filter((input) => input.type === "github-pr-context").length;
  const issueContextCount = inputs.filter((input) => input.type === "github-issue-context").length;
  const localChangesCount = inputs.filter((input) => input.type === "git-local-changes-context").length;
  const workflowRunContextCount = inputs.filter((input) => input.type === "github-workflow-run-context").length;

  for (const input of inputs) {
    if (!input.type || input.type === "text") {
      if (options.includeTextInputs) {
        const raw = options.args[input.id];
        values[input.id] = typeof raw === "string" ? raw : "";
      }
      continue;
    }

    if (input.type === "run-output-context") {
      const outputPath = expectStringArg(options.args, input.id, options.formatArgumentName);
      const runOutput = await collectRunOutputValues(outputPath, input.id);
      Object.assign(values, runOutput.values);
      continue;
    }

    if (input.type === "github-pr-context") {
      const names = getPrContextArgNames(input.id, prContextCount);
      const owner = expectStringArg(options.args, names.owner, options.formatArgumentName);
      const repo = expectStringArg(options.args, names.repo, options.formatArgumentName);
      const pullNumber = expectPositiveIntegerArg(options.args, names.pullNumber, options.formatArgumentName);
      const pr = await getPullRequest(owner, repo, pullNumber, { token: options.githubToken });
      const files = await getPullRequestFiles(owner, repo, pullNumber, { token: options.githubToken });
      mergeWorkflowContextValues(values, input.id, buildPullRequestContextValues(input.id, owner, repo, pr, files));
      continue;
    }

    if (input.type === "github-issue-context") {
      const names = getIssueContextArgNames(input.id, issueContextCount);
      const owner = expectStringArg(options.args, names.owner, options.formatArgumentName);
      const repo = expectStringArg(options.args, names.repo, options.formatArgumentName);
      const issueNumber = expectPositiveIntegerArg(options.args, names.issueNumber, options.formatArgumentName);
      const issue = await getIssue(owner, repo, issueNumber, { token: options.githubToken });
      const comments = await getIssueComments(owner, repo, issueNumber, { token: options.githubToken });
      const references = await getIssueReferences(owner, repo, issueNumber, { token: options.githubToken });
      mergeWorkflowContextValues(values, input.id, buildIssueContextValues(input.id, owner, repo, issue, comments, references));
      continue;
    }

    if (input.type === "git-local-changes-context") {
      const names = getLocalChangesArgNames(input.id, localChangesCount);
      const repoPath = expectStringArg(options.args, names.repoPath, options.formatArgumentName);
      const localChanges = await collectLocalChangesValues({ rootPath: repoPath }, input.id, {
        committedOnly: workflow.id === "create-pr" || workflow.type === "create-pr",
        workflowRunsDirPath: options.workflowRunsDirPath,
        isLocalReviewWorkflowId: options.isLocalReviewWorkflowId ?? isReviewChangesWorkflowId
      });
      if (!localChanges) {
        throw new Error(`No local changes found in repository '${repoPath}'.`);
      }
      Object.assign(values, localChanges.values);
      continue;
    }

    if (input.type === "github-workflow-run-context") {
      const names = getWorkflowRunContextArgNames(input.id, workflowRunContextCount);
      const owner = expectStringArg(options.args, names.owner, options.formatArgumentName);
      const repo = expectStringArg(options.args, names.repo, options.formatArgumentName);
      const runId = expectPositiveIntegerArg(options.args, names.runId, options.formatArgumentName);
      const workflowRun = await collectWorkflowRunValues(owner, repo, runId, input.id, options.githubToken);
      Object.assign(values, workflowRun.values);
      continue;
    }

    throw new Error(`Unsupported workflow input type '${input.type}' for workflow '${workflow.id}'.`);
  }

  return values;
}

export async function collectRunOutputValues(outputPath: string, inputId: string): Promise<{ values: Record<string, string> }> {
  const metadata = await readRunOutputMetadata(outputPath);
  const outputText = await readRunOutputText(metadata.outputFile || outputPath);
  const workflowId = metadata.workflowId || "";
  const workflowTitle = metadata.workflowTitle || workflowId || "Previous CMSIS-Dev Run";
  const resolvedOutputPath = metadata.outputFile || outputPath;
  const reasoningFile = metadata.reasoningFile || "";

  return {
    values: {
      [inputId]: outputPath,
      [`${inputId}_workflowId`]: workflowId,
      [`${inputId}_workflowTitle`]: workflowTitle,
      [`${inputId}_outputFile`]: resolvedOutputPath,
      [`${inputId}_reasoningFile`]: reasoningFile,
      [`${inputId}_output`]: outputText,
      sourceWorkflowId: workflowId,
      sourceWorkflowTitle: workflowTitle,
      sourceOutputFile: resolvedOutputPath,
      sourceReasoningFile: reasoningFile,
      sourceOutput: outputText
    }
  };
}

async function readRunOutputMetadata(outputPath: string): Promise<RunOutputMetadata> {
  try {
    const raw = await fs.readFile(`${outputPath}.meta.json`, "utf8");
    return JSON.parse(raw) as RunOutputMetadata;
  } catch {
    return { outputFile: outputPath };
  }
}

async function readRunOutputText(outputPath: string): Promise<string> {
  try {
    const raw = await fs.readFile(outputPath, "utf8");
    return truncateForPrompt(raw, 16_000);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read CMSIS-Dev run output '${outputPath}': ${message}`);
  }
}

export async function collectWorkflowRunValues(
  owner: string,
  repo: string,
  runId: number,
  inputId: string,
  token?: string
): Promise<{ values: Record<string, string> }> {
  const run = await getWorkflowRun(owner, repo, runId, { token });
  const jobs = await getWorkflowRunJobs(owner, repo, runId, { token });
  const failingJobs = jobs.filter((job) => job.conclusion && job.conclusion !== "success" && job.conclusion !== "skipped");
  const jobsForLogs = failingJobs.length > 0 ? failingJobs.slice(0, 3) : jobs.slice(0, 2);
  const logSections = await Promise.all(
    jobsForLogs.map(async (job) => {
      try {
        const log = await getWorkflowJobLog(owner, repo, job.id, { token });
        return `Job: ${job.name}\nConclusion: ${job.conclusion || "(unknown)"}\nLog excerpt:\n${tailText(log, 8_000)}`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `Job: ${job.name}\nConclusion: ${job.conclusion || "(unknown)"}\nLog excerpt unavailable: ${message}`;
      }
    })
  );

  const logs = truncateForPrompt(logSections.join("\n\n---\n\n"), 16_000);
  const values = buildWorkflowRunContextValues(inputId, owner, repo, runId, run, jobs, logs);

  return { values };
}

export function getPrContextArgNames(inputId: string, contextCount: number): { owner: string; repo: string; pullNumber: string } {
  if (contextCount === 1) {
    return { owner: "owner", repo: "repo", pullNumber: "pullNumber" };
  }

  return {
    owner: `${inputId}Owner`,
    repo: `${inputId}Repo`,
    pullNumber: `${inputId}PullNumber`
  };
}

export function getIssueContextArgNames(inputId: string, contextCount: number): { owner: string; repo: string; issueNumber: string } {
  if (contextCount === 1) {
    return { owner: "owner", repo: "repo", issueNumber: "issueNumber" };
  }

  return {
    owner: `${inputId}Owner`,
    repo: `${inputId}Repo`,
    issueNumber: `${inputId}IssueNumber`
  };
}

export function getLocalChangesArgNames(inputId: string, contextCount: number): { repoPath: string } {
  if (contextCount === 1) {
    return { repoPath: "repoPath" };
  }

  return { repoPath: `${inputId}RepoPath` };
}

export function getWorkflowRunContextArgNames(
  inputId: string,
  contextCount: number
): { owner: string; repo: string; runId: string } {
  if (contextCount === 1) {
    return { owner: "owner", repo: "repo", runId: "runId" };
  }

  return {
    owner: `${inputId}Owner`,
    repo: `${inputId}Repo`,
    runId: `${inputId}RunId`
  };
}

export function camelToKebab(value: string): string {
  return value.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
}

export function isReviewChangesWorkflowId(workflowId: string | undefined): boolean {
  return workflowId === "review-changes";
}

function expectStringArg(
  args: WorkflowContextArguments,
  key: string,
  formatArgumentName: ((key: string) => string) | undefined
): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required argument '${formatArgument(key, formatArgumentName)}'.`);
  }
  return value.trim();
}

function expectPositiveIntegerArg(
  args: WorkflowContextArguments,
  key: string,
  formatArgumentName: ((key: string) => string) | undefined
): number {
  const value = args[key];
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Missing required numeric argument '${formatArgument(key, formatArgumentName)}'.`);
  }
  return parsed;
}

function formatArgument(key: string, formatArgumentName: ((key: string) => string) | undefined): string {
  return formatArgumentName ? formatArgumentName(key) : key;
}