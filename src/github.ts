import * as https from "node:https";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { IssueComment, IssueSummary, PullRequestFile, PullRequestSummary } from "./types";

interface GitHubRequestOptions {
  token?: string;
}

export interface RepoInfo {
  owner: string;
  repo: string;
}

export interface WorkspaceRepoInfo extends RepoInfo {
  workspaceFolderName: string;
}

export interface WorkspaceGitRepoInfo {
  rootPath: string;
  workspaceFolderName: string;
  owner?: string;
  repo?: string;
}

export interface CreatedPullRequest {
  number: number;
  htmlUrl: string;
  title: string;
}

export interface WorkflowRunSummary {
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

export interface WorkflowRunJobSummary {
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

export async function resolveRepoFromWorkspace(): Promise<RepoInfo | undefined> {
  const repos = await resolveReposFromWorkspace();
  return repos[0] ? { owner: repos[0].owner, repo: repos[0].repo } : undefined;
}

export async function resolveReposFromWorkspace(): Promise<WorkspaceRepoInfo[]> {
  const gitRepos = await resolveGitReposFromWorkspace();
  return gitRepos
    .filter((repo): repo is WorkspaceGitRepoInfo & { owner: string; repo: string } => Boolean(repo.owner && repo.repo))
    .map((repo) => ({
      owner: repo.owner,
      repo: repo.repo,
      workspaceFolderName: repo.workspaceFolderName
    }));
}

export async function resolveGitReposFromWorkspace(): Promise<WorkspaceGitRepoInfo[]> {
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  const discovered: WorkspaceGitRepoInfo[] = [];

  for (const workspaceFolder of workspaceFolders) {
    const gitConfigUris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(workspaceFolder, "**/.git/config"),
      null,
      100
    );

    for (const gitConfigUri of gitConfigUris) {
      try {
        const gitConfig = await fs.readFile(gitConfigUri.fsPath, "utf8");
        const originUrlMatch = gitConfig.match(/\[remote \"origin\"\][\s\S]*?url\s*=\s*(.+)/);
        const originUrl = originUrlMatch?.[1]?.trim();
        if (!originUrl) {
          const rootPath = path.dirname(path.dirname(gitConfigUri.fsPath));
          discovered.push({
            rootPath,
            workspaceFolderName: workspaceFolder.name
          });
          continue;
        }

        const parsed = parseRepoFromRemote(originUrl);
        const rootPath = path.dirname(path.dirname(gitConfigUri.fsPath));

        discovered.push({
          rootPath,
          ...(parsed ?? {}),
          workspaceFolderName: workspaceFolder.name
        });
      } catch {
        // Skip unreadable git config files.
      }
    }
  }

  const unique = new Map<string, WorkspaceGitRepoInfo>();
  for (const repo of discovered) {
    const key = repo.rootPath.toLowerCase();
    if (!unique.has(key)) {
      unique.set(key, repo);
    }
  }

  return Array.from(unique.values());
}

export function parseRepoFromRemote(remoteUrl: string): RepoInfo | undefined {
  const cleaned = remoteUrl.replace(/\.git$/, "");

  const httpsMatch = cleaned.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  const sshMatch = cleaned.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  return undefined;
}

export function parseWorkflowRunUrl(url: string): { owner: string; repo: string; runId: number } | undefined {
  const match = url.trim().match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)(?:\/.*)?$/i);
  if (!match) {
    return undefined;
  }

  return {
    owner: match[1],
    repo: match[2],
    runId: Number.parseInt(match[3], 10)
  };
}

export async function listOpenPullRequests(
  owner: string,
  repo: string,
  options: GitHubRequestOptions = {}
): Promise<PullRequestSummary[]> {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&per_page=30`;
  const payload = await getJson<unknown[]>(url, options.token);
  return payload.map((pr: any) => ({
    number: pr.number,
    title: pr.title,
    htmlUrl: pr.html_url,
    author: pr.user?.login ?? "unknown",
    baseRef: pr.base?.ref ?? "",
    headRef: pr.head?.ref ?? "",
    body: pr.body ?? ""
  }));
}

export async function listOpenIssues(
  owner: string,
  repo: string,
  options: GitHubRequestOptions = {}
): Promise<IssueSummary[]> {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues?state=open&per_page=30`;
  const payload = await getJson<any[]>(url, options.token);
  return payload
    .filter((issue) => !issue.pull_request)
    .map(mapIssueSummary);
}

export async function listFailedWorkflowRuns(
  owner: string,
  repo: string,
  options: GitHubRequestOptions = {}
): Promise<WorkflowRunSummary[]> {
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/runs?status=completed&per_page=30`;
  const payload = await getJson<any>(url, options.token);
  const runs = Array.isArray(payload?.workflow_runs) ? payload.workflow_runs : [];

  return runs
    .filter((run: any) => typeof run?.conclusion === "string" && run.conclusion !== "success" && run.conclusion !== "skipped")
    .map(mapWorkflowRunSummary);
}

export async function getPullRequest(owner: string, repo: string, number: number, options: GitHubRequestOptions = {}): Promise<PullRequestSummary> {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`;
  const pr: any = await getJson(url, options.token);
  return {
    number: pr.number,
    title: pr.title,
    htmlUrl: pr.html_url,
    author: pr.user?.login ?? "unknown",
    baseRef: pr.base?.ref ?? "",
    headRef: pr.head?.ref ?? "",
    body: pr.body ?? ""
  };
}

export async function getIssue(owner: string, repo: string, number: number, options: GitHubRequestOptions = {}): Promise<IssueSummary> {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${number}`;
  const issue: any = await getJson(url, options.token);
  if (issue.pull_request) {
    throw new Error(`GitHub issue request resolved to a pull request for ${owner}/${repo}#${number}.`);
  }

  return mapIssueSummary(issue);
}

export async function getPullRequestFiles(
  owner: string,
  repo: string,
  number: number,
  options: GitHubRequestOptions = {}
): Promise<PullRequestFile[]> {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`;
  const files = await getJson<unknown[]>(url, options.token);
  return files.map((file: any) => ({
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    patch: file.patch
  }));
}

export async function getIssueComments(
  owner: string,
  repo: string,
  number: number,
  options: GitHubRequestOptions = {}
): Promise<IssueComment[]> {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`;
  const comments = await getJson<any[]>(url, options.token);
  return comments.map((comment) => ({
    author: comment.user?.login ?? "unknown",
    body: comment.body ?? "",
    createdAt: comment.created_at ?? "",
    htmlUrl: comment.html_url ?? ""
  }));
}

export async function getIssueReferences(
  owner: string,
  repo: string,
  number: number,
  options: GitHubRequestOptions = {}
): Promise<{ linkedPullRequests: string[]; relatedIssues: string[] }> {
  const linkedPullRequests = new Set<string>();
  const relatedIssues = new Set<string>();

  try {
    const timelineUrl = `https://api.github.com/repos/${owner}/${repo}/issues/${number}/timeline?per_page=100`;
    const timeline = await getJson<any[]>(timelineUrl, options.token);

    for (const event of timeline) {
      const sourceIssue = event.source?.issue;
      if (!sourceIssue?.number || sourceIssue.number === number) {
        continue;
      }

      const label = `#${sourceIssue.number} ${sourceIssue.title ?? ""}`.trim();
      if (sourceIssue.pull_request) {
        linkedPullRequests.add(label);
      } else {
        relatedIssues.add(label);
      }
    }
  } catch {
    // Timeline references are best-effort only.
  }

  return {
    linkedPullRequests: Array.from(linkedPullRequests).sort(),
    relatedIssues: Array.from(relatedIssues).sort()
  };
}

export async function getWorkflowRun(
  owner: string,
  repo: string,
  runId: number,
  options: GitHubRequestOptions = {}
): Promise<WorkflowRunSummary> {
  const run: any = await getJson(`https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}`, options.token);
  return mapWorkflowRunSummary(run);
}

export async function getWorkflowRunJobs(
  owner: string,
  repo: string,
  runId: number,
  options: GitHubRequestOptions = {}
): Promise<WorkflowRunJobSummary[]> {
  const payload: any = await getJson(`https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=100`, options.token);
  const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
  return jobs.map((job: any) => ({
    id: job.id,
    name: job.name ?? `Job ${job.id}`,
    status: job.status ?? "",
    conclusion: job.conclusion ?? "",
    startedAt: job.started_at ?? "",
    completedAt: job.completed_at ?? "",
    steps: Array.isArray(job.steps)
      ? job.steps.map((step: any) => ({
          name: step.name ?? "",
          status: step.status ?? "",
          conclusion: step.conclusion ?? "",
          number: Number(step.number ?? 0)
        }))
      : []
  }));
}

export async function getWorkflowJobLog(
  owner: string,
  repo: string,
  jobId: number,
  options: GitHubRequestOptions = {}
): Promise<string> {
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`;
  return getTextWithRedirect(url, options.token);
}

function mapWorkflowRunSummary(run: any): WorkflowRunSummary {
  return {
    id: run.id,
    name: run.name ?? `Run ${run.id ?? "unknown"}`,
    displayTitle: run.display_title ?? run.name ?? `Run ${run.id ?? "unknown"}`,
    htmlUrl: run.html_url ?? "",
    event: run.event ?? "",
    status: run.status ?? "",
    conclusion: run.conclusion ?? "",
    headBranch: run.head_branch ?? "",
    headSha: run.head_sha ?? "",
    runNumber: Number(run.run_number ?? 0),
    attempt: Number(run.run_attempt ?? 0),
    actor: run.actor?.login ?? "unknown",
    createdAt: run.created_at ?? "",
    updatedAt: run.updated_at ?? ""
  };
}

export async function postPullRequestComment(
  owner: string,
  repo: string,
  number: number,
  body: string,
  options: GitHubRequestOptions = {}
): Promise<{ htmlUrl?: string; id?: number }> {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${number}/comments`;
  const response = await postJson<any>(url, { body }, options.token);
  return {
    htmlUrl: response.html_url,
    id: response.id
  };
}

export async function createPullRequest(
  owner: string,
  repo: string,
  payload: {
    title: string;
    body: string;
    head: string;
    base: string;
    draft?: boolean;
  },
  options: GitHubRequestOptions = {}
): Promise<CreatedPullRequest> {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls`;
  const response = await postJson<any>(
    url,
    {
      title: payload.title,
      body: payload.body,
      head: payload.head,
      base: payload.base,
      draft: payload.draft ?? false
    },
    options.token
  );

  return {
    number: response.number,
    htmlUrl: response.html_url,
    title: response.title ?? payload.title
  };
}

function mapIssueSummary(issue: any): IssueSummary {
  return {
    number: issue.number,
    title: issue.title ?? "",
    htmlUrl: issue.html_url,
    author: issue.user?.login ?? "unknown",
    body: issue.body ?? "",
    state: issue.state ?? "open",
    labels: Array.isArray(issue.labels)
      ? issue.labels
          .map((label: any) => (typeof label === "string" ? label : label?.name))
          .filter((label: string | undefined): label is string => Boolean(label))
      : [],
    assignees: Array.isArray(issue.assignees)
      ? issue.assignees
          .map((assignee: any) => assignee?.login)
          .filter((assignee: string | undefined): assignee is string => Boolean(assignee))
      : [],
    commentsCount: Number(issue.comments ?? 0)
  };
}

async function getJson<T>(url: string, token?: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          "User-Agent": "CMSIS-Dev",
          Accept: "application/vnd.github+json",
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        }
      },
      (response) => {
        let data = "";
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => {
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`GitHub API request failed (${response.statusCode ?? "unknown"}): ${data}`));
            return;
          }

          try {
            resolve(JSON.parse(data) as T);
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    request.on("error", reject);
  });
}

async function getTextWithRedirect(url: string, token?: string, redirectsRemaining = 5): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          "User-Agent": "CMSIS-Dev",
          Accept: "application/vnd.github+json",
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        }
      },
      (response) => {
        const statusCode = response.statusCode ?? 0;
        const location = response.headers.location;

        if ([301, 302, 303, 307, 308].includes(statusCode) && location) {
          if (redirectsRemaining <= 0) {
            reject(new Error(`GitHub log request exceeded redirect limit for ${url}`));
            return;
          }

          response.resume();
          void getTextWithRedirect(location, token, redirectsRemaining - 1).then(resolve, reject);
          return;
        }

        let data = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => {
          if (statusCode < 200 || statusCode >= 300) {
            reject(new Error(`GitHub API request failed (${statusCode || "unknown"}): ${data}`));
            return;
          }

          resolve(data);
        });
      }
    );

    request.on("error", reject);
  });
}

async function postJson<T>(url: string, payload: unknown, token?: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const request = https.request(
      url,
      {
        method: "POST",
        headers: {
          "User-Agent": "CMSIS-Dev",
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        }
      },
      (response) => {
        let responseData = "";
        response.on("data", (chunk) => {
          responseData += chunk;
        });
        response.on("end", () => {
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`GitHub API request failed (${response.statusCode ?? "unknown"}): ${responseData}`));
            return;
          }

          try {
            resolve(JSON.parse(responseData) as T);
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    request.on("error", reject);
    request.write(data);
    request.end();
  });
}
