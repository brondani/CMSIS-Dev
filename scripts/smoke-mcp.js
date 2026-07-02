const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { assertReviewChangesPrompt, createChangedGitRepo, repoRoot } = require("./smoke-utils");

const mcpServerPath = path.join(repoRoot, "out", "mcp", "server.js");
const tempRoot = createChangedGitRepo("cmsis-dev-mcp-smoke-");
const tempRunOutput = path.join(tempRoot, "previous-run.md");

function assertTool(tools, name) {
  if (!tools.some((tool) => tool.name === name)) {
    throw new Error(`Expected MCP tool '${name}' to be registered.`);
  }
}

async function main() {
  if (!fs.existsSync(mcpServerPath)) {
    throw new Error("Missing out/mcp/server.js. Run 'npm run build:mcp' before 'npm run smoke:mcp'.");
  }

  fs.writeFileSync(tempRunOutput, "Previous CMSIS-Dev output for MCP follow-up.", "utf8");
  fs.writeFileSync(
    `${tempRunOutput}.meta.json`,
    `${JSON.stringify(
      {
        workflowId: "review-changes",
        workflowTitle: "Review Changes",
        outputFile: tempRunOutput,
        reasoningFile: `${tempRunOutput}.reasoning.md`
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const client = new Client({ name: "cmsis-dev-mcp-smoke", version: "0.0.1" }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpServerPath],
    cwd: repoRoot,
    env: {
      CMSIS_DEV_BUNDLED_WORKFLOW_CONFIG: path.join(repoRoot, ".cmsis-dev", "workflows")
    },
    stderr: "pipe"
  });

  try {
    await client.connect(transport);
    const toolsResult = await client.listTools();
    assertTool(toolsResult.tools, "review_changes");
    assertTool(toolsResult.tools, "plan_next_steps");

    const callResult = await client.callTool({ name: "review_changes", arguments: { repoPath: tempRoot } });
    const text = callResult.content.find((part) => part.type === "text")?.text ?? "";
    assertReviewChangesPrompt(text, tempRoot, "MCP smoke output");

    const followUpResult = await client.callTool({ name: "plan_next_steps", arguments: { sourceRun: tempRunOutput } });
    const followUpText = followUpResult.content.find((part) => part.type === "text")?.text ?? "";
    if (!followUpText.includes("Previous CMSIS-Dev output for MCP follow-up.")) {
      throw new Error("Expected MCP plan_next_steps output to include the previous run output.");
    }
  } finally {
    await client.close();
  }

  process.stdout.write("MCP smoke passed.\n");
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });