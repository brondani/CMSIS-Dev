import * as cp from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { formatSimpleList } from "./workflowContextCore";

export interface LocalChangesContext {
  rootPath: string;
  workspaceFolderName: string;
  owner?: string;
  repo?: string;
  currentBranch: string;
  defaultRef: string;
  defaultBranchName: string;
  changedFiles: number;
}

export interface BranchCandidate {
  ref: string;
  shortName: string;
  source: "remote" | "local";
}

export interface LocalGitRepoInfo {
  owner: string;
  repo: string;
}

export interface LocalChangesSelection {
  rootPath: string;
  workspaceFolderName?: string;
  owner?: string;
  repo?: string;
}

export interface CollectLocalChangesOptions {
  committedOnly?: boolean;
  workflowRunsDirPath?: string;
  isLocalReviewWorkflowId?: (workflowId: string) => boolean;
  resolveAmbiguousDefaultBranch?: (repoRoot: string, candidates: BranchCandidate[]) => Promise<BranchCandidate | undefined>;
}

export async function collectLocalChangesValues(
  selected: LocalChangesSelection,
  inputId: string,
  options: CollectLocalChangesOptions = {}
): Promise<{ context: LocalChangesContext; values: Record<string, string> } | undefined> {
  const defaultRef = await resolveDefaultBranchRef(selected.rootPath, options.resolveAmbiguousDefaultBranch);
  if (!defaultRef) {
    throw new Error(`Could not resolve the default branch for repository '${selected.rootPath}'.`);
  }

  const currentBranch = (await runGitCommand(selected.rootPath, ["branch", "--show-current"])).trim() || "detached HEAD";
  let compareRef = options.committedOnly ? `${defaultRef.ref}...HEAD` : defaultRef.ref;
  let changedEntries = await getTrackedDiffEntries(selected.rootPath, compareRef);
  if (!options.committedOnly && changedEntries.length === 0 && (await hasTrackedWorkingTreeChanges(selected.rootPath))) {
    compareRef = "HEAD";
    changedEntries = await getTrackedDiffEntries(selected.rootPath, compareRef);
  }
  if (changedEntries.length === 0) {
    return undefined;
  }

  const fileSections = await formatLocalChangeSections(selected.rootPath, compareRef, changedEntries);
  const latestLocalReview = options.workflowRunsDirPath
    ? await findLatestLocalReviewSummary(selected.rootPath, options.workflowRunsDirPath, options.isLocalReviewWorkflowId)
    : "(No previous local review found)";
  const pullRequestTemplates = await readPullRequestTemplates(selected.rootPath);
  const changedFilesList = changedEntries.map((entry) => entry.displayPath);
  const uniqueChangedFiles = Array.from(new Set(changedFilesList));
  const repoInfo = selected.owner && selected.repo ? { owner: selected.owner, repo: selected.repo } : await resolveRepoInfoFromGit(selected.rootPath);
  const workspaceFolderName = selected.workspaceFolderName ?? path.basename(selected.rootPath);
  const values: Record<string, string> = {
    [inputId]: selected.rootPath,
    [`${inputId}_repoPath`]: selected.rootPath,
    [`${inputId}_workspaceFolder`]: workspaceFolderName,
    [`${inputId}_currentBranch`]: currentBranch,
    [`${inputId}_defaultBranch`]: defaultRef.shortName,
    [`${inputId}_compareRef`]: compareRef,
    [`${inputId}_changedFiles`]: formatSimpleList(uniqueChangedFiles, "(No changed files found)"),
    [`${inputId}_changedFilesCount`]: String(uniqueChangedFiles.length),
    [`${inputId}_fileSections`]: fileSections,
    [`${inputId}_latestLocalReview`]: latestLocalReview,
    [`${inputId}_pullRequestTemplates`]: pullRequestTemplates
  };

  values.repoPath ??= selected.rootPath;
  values.workspaceFolder ??= workspaceFolderName;
  values.currentBranch ??= currentBranch;
  values.defaultBranch ??= defaultRef.shortName;
  values.compareRef ??= compareRef;
  values.changedFiles ??= formatSimpleList(uniqueChangedFiles, "(No changed files found)");
  values.changedFilesCount ??= String(uniqueChangedFiles.length);
  values.fileSections ??= fileSections;
  values.latestLocalReview ??= latestLocalReview;
  values.pullRequestTemplates ??= pullRequestTemplates;
  if (repoInfo?.owner) {
    values.owner ??= repoInfo.owner;
  }
  if (repoInfo?.repo) {
    values.repo ??= repoInfo.repo;
  }

  return {
    context: {
      rootPath: selected.rootPath,
      workspaceFolderName,
      owner: repoInfo?.owner,
      repo: repoInfo?.repo,
      currentBranch,
      defaultRef: compareRef,
      defaultBranchName: defaultRef.shortName,
      changedFiles: uniqueChangedFiles.length
    },
    values
  };
}

export async function hasTrackedWorkingTreeChanges(repoRoot: string): Promise<boolean> {
  const raw = await runGitCommand(repoRoot, ["diff", "--no-ext-diff", "--name-only", "HEAD"]);
  return raw.trim().length > 0;
}

export async function resolveDefaultBranchRef(
  repoRoot: string,
  resolveAmbiguousDefaultBranch?: (repoRoot: string, candidates: BranchCandidate[]) => Promise<BranchCandidate | undefined>
): Promise<BranchCandidate | undefined> {
  const originHead = (await tryRunGitCommand(repoRoot, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]))?.trim();
  if (originHead) {
    return { ref: originHead, shortName: originHead.replace(/^origin\//, ""), source: "remote" };
  }

  const fallbackRefs: BranchCandidate[] = [
    { ref: "refs/remotes/origin/main", shortName: "main", source: "remote" },
    { ref: "refs/remotes/origin/master", shortName: "master", source: "remote" },
    { ref: "refs/remotes/origin/develop", shortName: "develop", source: "remote" },
    { ref: "refs/remotes/origin/dev", shortName: "dev", source: "remote" },
    { ref: "refs/remotes/origin/trunk", shortName: "trunk", source: "remote" },
    { ref: "refs/heads/main", shortName: "main", source: "local" },
    { ref: "refs/heads/master", shortName: "master", source: "local" },
    { ref: "refs/heads/develop", shortName: "develop", source: "local" },
    { ref: "refs/heads/dev", shortName: "dev", source: "local" },
    { ref: "refs/heads/trunk", shortName: "trunk", source: "local" }
  ];

  for (const candidate of fallbackRefs) {
    const resolved = await tryRunGitCommand(repoRoot, ["rev-parse", "--verify", candidate.ref]);
    if (resolved?.trim()) {
      return candidate;
    }
  }

  const remoteCandidates = await listBranchRefCandidates(repoRoot, "refs/remotes/origin", "remote");
  if (remoteCandidates.length === 1) {
    return remoteCandidates[0];
  }

  const localCandidates = await listBranchRefCandidates(repoRoot, "refs/heads", "local");
  if (localCandidates.length === 1) {
    return localCandidates[0];
  }

  const candidates = dedupeBranchRefCandidates([...remoteCandidates, ...localCandidates]);
  if (candidates.length > 0 && resolveAmbiguousDefaultBranch) {
    return resolveAmbiguousDefaultBranch(repoRoot, candidates);
  }

  return candidates[0];
}

export async function runGitCommand(
  repoRoot: string,
  args: string[],
  options: {
    input?: string;
    timeoutMs?: number;
  } = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = cp.execFile(
      "git",
      args,
      {
        cwd: repoRoot,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        timeout: options.timeoutMs,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GCM_INTERACTIVE: "never"
        }
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || error.message).trim() || `git ${args.join(" ")} failed`));
          return;
        }

        resolve(stdout);
      }
    );

    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }
  });
}

export async function tryRunGitCommand(repoRoot: string, args: string[]): Promise<string | undefined> {
  try {
    return await runGitCommand(repoRoot, args);
  } catch {
    return undefined;
  }
}

async function listBranchRefCandidates(repoRoot: string, refPrefix: string, source: "remote" | "local"): Promise<BranchCandidate[]> {
  const raw = await tryRunGitCommand(repoRoot, ["for-each-ref", "--format=%(refname)", refPrefix]);
  if (!raw) {
    return [];
  }

  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((ref) => ref !== "refs/remotes/origin/HEAD")
    .map((ref) => ({
      ref,
      shortName: ref.replace(/^refs\/remotes\/origin\//, "").replace(/^refs\/heads\//, ""),
      source
    }));
}

function dedupeBranchRefCandidates(candidates: BranchCandidate[]): BranchCandidate[] {
  const priority = (candidate: BranchCandidate): number => {
    const preferredNames = ["main", "master", "develop", "dev", "trunk"];
    const nameIndex = preferredNames.indexOf(candidate.shortName);
    const sourceWeight = candidate.source === "remote" ? 0 : 10;
    return sourceWeight + (nameIndex >= 0 ? nameIndex : preferredNames.length + 1);
  };

  return candidates
    .slice()
    .sort((left, right) => {
      const leftPriority = priority(left);
      const rightPriority = priority(right);
      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }

      return left.shortName.localeCompare(right.shortName);
    })
    .filter((candidate, index, all) => {
      const firstIndex = all.findIndex(
        (entry) => entry.shortName === candidate.shortName && entry.source === candidate.source
      );
      return firstIndex === index;
    });
}

async function getTrackedDiffEntries(
  repoRoot: string,
  defaultRef: string
): Promise<Array<{ status: string; displayPath: string; pathSpec: string; pathSpecs?: string[] }>> {
  const raw = await runGitCommand(repoRoot, ["diff", "--no-ext-diff", "--find-renames", "--name-status", defaultRef]);
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      const status = parts[0] ?? "M";
      if (status.startsWith("R") || status.startsWith("C")) {
        const fromPath = parts[1] ?? "";
        const toPath = parts[2] ?? fromPath;
        return {
          status,
          displayPath: `${fromPath} -> ${toPath}`,
          pathSpec: toPath,
          pathSpecs: [fromPath, toPath]
        };
      }

      return {
        status,
        displayPath: parts[1] ?? parts[0],
        pathSpec: parts[1] ?? parts[0]
      };
    });
}

async function formatLocalChangeSections(
  repoRoot: string,
  defaultRef: string,
  changedEntries: Array<{ status: string; displayPath: string; pathSpec: string; pathSpecs?: string[] }>
): Promise<string> {
  const trackedSections = await Promise.all(
    changedEntries.map(async (entry) => {
      const patchArgs = [
        "diff",
        "--no-ext-diff",
        "--find-renames",
        "--unified=3",
        defaultRef,
        "--",
        ...(entry.pathSpecs ?? [entry.pathSpec])
      ];
      const patch = (await runGitCommand(repoRoot, patchArgs)).trim();
      const displayPatch = patch.length > 0 ? patch.slice(0, 4000) : "(No textual diff available)";
      return `File: ${entry.displayPath}\nStatus: ${entry.status}\nPatch:\n${displayPatch}`;
    })
  );

  return trackedSections.join("\n\n---\n\n");
}

async function readPullRequestTemplates(repoRoot: string): Promise<string> {
  const templatePaths = [
    path.join(repoRoot, ".github", "pull_request_template.md"),
    path.join(repoRoot, ".github", "PULL_REQUEST_TEMPLATE.md"),
    path.join(repoRoot, "pull_request_template.md"),
    path.join(repoRoot, "PULL_REQUEST_TEMPLATE.md")
  ];
  const templatesDir = path.join(repoRoot, ".github", "PULL_REQUEST_TEMPLATE");

  try {
    const entries = await fs.readdir(templatesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        templatePaths.push(path.join(templatesDir, entry.name));
      }
    }
  } catch {
    // No template directory found.
  }

  const sections: string[] = [];
  for (const templatePath of Array.from(new Set(templatePaths))) {
    try {
      const content = (await fs.readFile(templatePath, "utf8")).trim();
      if (!content) {
        continue;
      }

      sections.push(`Template: ${path.relative(repoRoot, templatePath)}\n${content.slice(0, 6000)}`);
    } catch {
      // Skip missing or unreadable template files.
    }
  }

  return sections.length > 0 ? sections.join("\n\n---\n\n") : "(No pull request templates found)";
}

async function findLatestLocalReviewSummary(
  repoRoot: string,
  workflowRunsDirPath: string,
  isLocalReviewWorkflowId: (workflowId: string) => boolean = (workflowId) => workflowId === "review-changes"
): Promise<string> {
  let metadataFiles: string[] = [];
  try {
    const entries = await fs.readdir(workflowRunsDirPath, { withFileTypes: true });
    metadataFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".meta.json"))
      .map((entry) => path.join(workflowRunsDirPath, entry.name));
  } catch {
    return "(No previous local review found)";
  }

  const matches: Array<{ modifiedAt: number; output: string }> = [];
  for (const metadataPath of metadataFiles) {
    try {
      const raw = await fs.readFile(metadataPath, "utf8");
      const metadata = JSON.parse(raw) as {
        workflowId?: string;
        generatedOutput?: string;
        localChangesContext?: {
          rootPath?: string;
        };
      };
      if (!metadata.workflowId || !isLocalReviewWorkflowId(metadata.workflowId)) {
        continue;
      }
      if (metadata.localChangesContext?.rootPath !== repoRoot) {
        continue;
      }
      if (!metadata.generatedOutput) {
        continue;
      }

      const stat = await fs.stat(metadataPath);
      matches.push({
        modifiedAt: stat.mtimeMs,
        output: metadata.generatedOutput.slice(0, 8000)
      });
    } catch {
      // Skip malformed metadata.
    }
  }

  if (matches.length === 0) {
    return "(No previous local review found)";
  }

  matches.sort((left, right) => right.modifiedAt - left.modifiedAt);
  return matches[0].output;
}

async function resolveRepoInfoFromGit(repoRoot: string): Promise<LocalGitRepoInfo | undefined> {
  const remoteUrl = (await tryRunGitCommand(repoRoot, ["config", "--get", "remote.origin.url"]))?.trim();
  return remoteUrl ? parseRepoFromRemote(remoteUrl) : undefined;
}

function parseRepoFromRemote(remoteUrl: string): LocalGitRepoInfo | undefined {
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
