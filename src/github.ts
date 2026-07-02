import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { tryRunGitCommand } from "./localGitCore";
export {
  CreatedPullRequest,
  CreatedPullRequestReview,
  GitHubRequestOptions,
  PullRequestReviewCommentInput,
  WorkflowRunJobSummary,
  WorkflowRunSummary,
  createPullRequest,
  createPullRequestReview,
  getIssue,
  getIssueComments,
  getIssueReferences,
  getPullRequest,
  getPullRequestFiles,
  getWorkflowJobLog,
  getWorkflowRun,
  getWorkflowRunJobs,
  listFailedWorkflowRuns,
  listOpenIssues,
  listOpenPullRequests,
  postPullRequestComment
} from "./githubCore";

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
    const workspaceRepo = await resolveGitRepoFromPath(workspaceFolder.uri.fsPath, workspaceFolder.name);
    if (workspaceRepo) {
      discovered.push(workspaceRepo);
    }

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
          const rootPath = await normalizeRepoRootPath(path.dirname(path.dirname(gitConfigUri.fsPath)));
          discovered.push({
            rootPath,
            workspaceFolderName: workspaceFolder.name
          });
          continue;
        }

        const parsed = parseRepoFromRemote(originUrl);
        const rootPath = await normalizeRepoRootPath(path.dirname(path.dirname(gitConfigUri.fsPath)));

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
    const key = normalizeRepoRootKey(repo.rootPath);
    if (!unique.has(key)) {
      unique.set(key, repo);
    }
  }

  return Array.from(unique.values());
}

async function resolveGitRepoFromPath(repoPath: string, workspaceFolderName: string): Promise<WorkspaceGitRepoInfo | undefined> {
  const rawRootPath = (await tryRunGitCommand(repoPath, ["rev-parse", "--show-toplevel"]))?.trim();
  if (!rawRootPath) {
    return undefined;
  }

  const rootPath = await normalizeRepoRootPath(rawRootPath);
  const originUrl = (await tryRunGitCommand(rootPath, ["config", "--get", "remote.origin.url"]))?.trim();
  const parsed = originUrl ? parseRepoFromRemote(originUrl) : undefined;
  return {
    rootPath,
    ...(parsed ?? {}),
    workspaceFolderName
  };
}

async function normalizeRepoRootPath(rootPath: string): Promise<string> {
  const normalized = path.normalize(rootPath);
  try {
    return path.normalize(await fs.realpath(normalized));
  } catch {
    return normalized;
  }
}

function normalizeRepoRootKey(rootPath: string): string {
  return path.normalize(rootPath).replace(/[\\/]+/g, path.sep).toLowerCase();
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

