const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");

function run(command, args, options = {}) {
  return cp.execFileSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"]
  });
}

function createChangedGitRepo(prefix) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));

  try {
    run("git", ["init"], { cwd: tempRoot });
    run("git", ["checkout", "-b", "main"], { cwd: tempRoot });
    run("git", ["config", "user.email", "cmsis-dev-smoke@example.invalid"], { cwd: tempRoot });
    run("git", ["config", "user.name", "CMSIS-Dev Smoke"], { cwd: tempRoot });
    run("git", ["remote", "add", "origin", "https://github.com/cmsis-dev-smoke/repo.git"], { cwd: tempRoot });

    fs.writeFileSync(path.join(tempRoot, "README.md"), "# Smoke\n\nInitial content.\n", "utf8");
    run("git", ["add", "README.md"], { cwd: tempRoot });
    run("git", ["commit", "-m", "Initial commit"], { cwd: tempRoot });
    fs.writeFileSync(path.join(tempRoot, "README.md"), "# Smoke\n\nChanged content.\n", "utf8");

    return tempRoot;
  } catch (error) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

function assertIncludes(output, expected, label = "smoke output") {
  if (!output.includes(expected)) {
    throw new Error(`Expected ${label} to include ${JSON.stringify(expected)}.`);
  }
}

function assertReviewChangesPrompt(output, repoPath, label) {
  assertIncludes(output, "Repository: cmsis-dev-smoke/repo", label);
  assertIncludes(output, `Repository path: ${repoPath}`, label);
  assertIncludes(output, "Current branch: main", label);
  assertIncludes(output, "Default branch: main", label);
  assertIncludes(output, "Changed files count: 1", label);
  assertIncludes(output, "README.md", label);
}

module.exports = {
  assertIncludes,
  assertReviewChangesPrompt,
  createChangedGitRepo,
  repoRoot,
  run
};