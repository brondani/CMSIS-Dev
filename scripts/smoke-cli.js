const fs = require("node:fs");
const path = require("node:path");
const { assertReviewChangesPrompt, createChangedGitRepo, repoRoot, run } = require("./smoke-utils");

const cliPath = path.join(repoRoot, "out", "cli.js");
const tempRoot = createChangedGitRepo("cmsis-dev-cli-smoke-");

try {
  if (!fs.existsSync(cliPath)) {
    throw new Error("Missing out/cli.js. Run 'npm run compile' before 'npm run smoke:cli'.");
  }

  const output = run(process.execPath, [cliPath, "render", "review-changes", "--repo-path", tempRoot]);
  assertReviewChangesPrompt(output, tempRoot, "CLI smoke output");

  process.stdout.write("CLI smoke passed.\n");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}