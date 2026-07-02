import * as cp from "node:child_process";
import * as path from "node:path";
import * as vscode from "vscode";
import { ActionsProvider } from "./actionsProvider";
import { RunsProvider } from "./runsProvider";
import { clearGitHubToken, initializeSecretStorage, setGitHubToken } from "./secrets";
import { WorkflowDefinition } from "./types";
import { createWorkflowDiagnosticCollection, refreshWorkflowDiagnostics, validateWorkflowTextDocument } from "./workflowDiagnostics";
import { WorkflowsProvider } from "./workflowsProvider";
import {
  DEFAULT_WORKFLOW_CONFIG_PATH,
  getConfiguredWorkflowConfigPath,
  initializeWorkflowConfig,
  resolveWorkflowConfigUri,
  resolveWorkflowRunsDirUri
} from "./workflowConfig";
import {
  getActiveOutputFollowUpState,
  openCodexChatForActiveOutput,
  openIssueForActiveOutput,
  openPrForActiveOutput,
  openReasoningForActiveOutput,
  PromptWorkflowResult,
  postCommentForActiveOutput,
  runPromptWorkflow,
  submitPrForActiveOutput
} from "./workflows/promptWorkflow";

let mcpProcess: cp.ChildProcess | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initializeSecretStorage(context.secrets);
  const provider = new ActionsProvider();
  const runsProvider = new RunsProvider();
  const workflowsProvider = new WorkflowsProvider();
  const workflowDiagnostics = createWorkflowDiagnosticCollection();
  const workflowWatchers = createWorkflowWatchers(getConfiguredWorkflowConfigPath());
  const runsWatcher = await createRunsWatcher(runsProvider);

  for (const workflowWatcher of workflowWatchers) {
    workflowWatcher.onDidCreate(() => {
      void provider.refresh();
      void runsProvider.refresh();
      void workflowsProvider.refresh();
      void refreshWorkflowDiagnostics(workflowDiagnostics);
    });
    workflowWatcher.onDidChange(() => {
      void provider.refresh();
      void runsProvider.refresh();
      void workflowsProvider.refresh();
      void refreshWorkflowDiagnostics(workflowDiagnostics);
    });
    workflowWatcher.onDidDelete(() => {
      void provider.refresh();
      void runsProvider.refresh();
      void workflowsProvider.refresh();
      void refreshWorkflowDiagnostics(workflowDiagnostics);
    });
  }

  context.subscriptions.push(
    workflowDiagnostics,
    ...workflowWatchers,
    ...(runsWatcher ? [runsWatcher] : []),
    vscode.workspace.onDidOpenTextDocument((document) => {
      void validateWorkflowTextDocument(document, workflowDiagnostics);
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      void validateWorkflowTextDocument(event.document, workflowDiagnostics);
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      void updateActiveOutputContexts(editor);
    }),
    vscode.window.registerTreeDataProvider("cmsisDev.actions", provider),
    vscode.window.registerTreeDataProvider("cmsisDev.workflows", workflowsProvider),
    vscode.window.registerTreeDataProvider("cmsisDev.runs", runsProvider),
    vscode.commands.registerCommand("cmsisDev.initializeWorkflows", async () => {
      await initializeWorkflowConfig();
      await provider.refresh();
      await workflowsProvider.refresh();
      await runsProvider.refresh();
    }),
    vscode.commands.registerCommand("cmsisDev.runAction", async (workflow?: WorkflowDefinition) => {
      const chosen = workflow ?? (await chooseWorkflow(provider));
      if (!chosen) {
        return;
      }
      await runWorkflowWithStatus(chosen);
      await runsProvider.refresh();
    }),
    vscode.commands.registerCommand("cmsisDev.refreshRuns", async () => {
      await runsProvider.refresh();
    }),
    vscode.commands.registerCommand("cmsisDev.refreshWorkflows", async () => {
      await workflowsProvider.refresh();
    }),
    vscode.commands.registerCommand("cmsisDev.setGitHubToken", async () => {
      const token = await vscode.window.showInputBox({
        title: "Set GitHub Token",
        prompt: "Enter a GitHub personal access token with repo scope",
        password: true,
        ignoreFocusOut: true,
        validateInput: (value) => (value.trim().length > 0 ? null : "Token cannot be empty")
      });

      if (!token) {
        return;
      }

      await setGitHubToken(token);
      vscode.window.showInformationMessage("CMSIS-Dev GitHub token saved in SecretStorage.");
    }),
    vscode.commands.registerCommand("cmsisDev.clearGitHubToken", async () => {
      await clearGitHubToken();
      vscode.window.showInformationMessage("CMSIS-Dev GitHub token removed from SecretStorage.");
    }),
    vscode.commands.registerCommand("cmsisDev.openReasoningForActiveOutput", async () => {
      await openReasoningForActiveOutput();
    }),
    vscode.commands.registerCommand("cmsisDev.postCommentForActiveOutput", async () => {
      await postCommentForActiveOutput();
    }),
    vscode.commands.registerCommand("cmsisDev.openPrForActiveOutput", async () => {
      await openPrForActiveOutput();
    }),
    vscode.commands.registerCommand("cmsisDev.openIssueForActiveOutput", async () => {
      await openIssueForActiveOutput();
    }),
    vscode.commands.registerCommand("cmsisDev.openCodexChatForActiveOutput", async () => {
      await openCodexChatForActiveOutput();
    }),
    vscode.commands.registerCommand("cmsisDev.submitPrForActiveOutput", async () => {
      await submitPrForActiveOutput();
    })
  );

  await provider.refresh();
  await workflowsProvider.refresh();
  await runsProvider.refresh();
  await refreshWorkflowDiagnostics(workflowDiagnostics);
  for (const document of vscode.workspace.textDocuments) {
    await validateWorkflowTextDocument(document, workflowDiagnostics);
  }
  await updateActiveOutputContexts(vscode.window.activeTextEditor);
  void startMcpServer(context);
}

export function deactivate(): void {
  if (mcpProcess && !mcpProcess.killed) {
    mcpProcess.kill();
  }
}

async function chooseWorkflow(provider: ActionsProvider): Promise<WorkflowDefinition | undefined> {
  await provider.refresh();
  const workflows = provider.getWorkflows();
  if (workflows.length === 0) {
    vscode.window.showInformationMessage("No workflows found. Run 'CMSIS-Dev: Initialize Workflow Config'.");
    return undefined;
  }

  const pick = await vscode.window.showQuickPick(
    workflows.map((workflow) => ({
      label: workflow.title,
      description: workflow.id,
      detail: workflow.description,
      workflow
    })),
    { placeHolder: "Choose an AI Action" }
  );

  return pick?.workflow;
}

async function runWorkflow(
  workflow: WorkflowDefinition,
  onStatus?: (status: string) => void
): Promise<PromptWorkflowResult> {
  return runPromptWorkflow(workflow, { onStatus });
}

async function runWorkflowWithStatus(workflow: WorkflowDefinition): Promise<void> {
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.name = "CMSIS-Dev AI Action";
  statusBar.text = `$(sync~spin) CMSIS-Dev: Running ${workflow.title}`;
  statusBar.show();
  let dismissAfterMs = 8000;

  try {
    const result = await runWorkflow(workflow, (status) => {
      statusBar.text = `$(sync~spin) CMSIS-Dev: ${status}`;
    });

    if (result.canceled) {
      statusBar.text = `$(circle-slash) CMSIS-Dev: Cancelled ${workflow.title}`;
      dismissAfterMs = 2500;
    } else {
      statusBar.text = result.handedOffToCodexChat
        ? `$(comment-discussion) CMSIS-Dev: Waiting in Codex Chat for ${workflow.title}`
        : `$(check) CMSIS-Dev: Completed ${workflow.title}`;
      dismissAfterMs = result.handedOffToCodexChat ? 30000 : 8000;
    }
  } catch (error) {
    statusBar.text = `$(error) CMSIS-Dev: Failed ${workflow.title}`;
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`AI action '${workflow.title}' failed: ${message}`);
    dismissAfterMs = 8000;
    throw error;
  } finally {
    setTimeout(() => {
      statusBar.hide();
      statusBar.dispose();
    }, dismissAfterMs);
  }
}

async function startMcpServer(context: vscode.ExtensionContext): Promise<void> {
  const serverScript = path.join(context.extensionPath, "out", "mcp", "server.js");
  const resolvedWorkflowConfigUri = await resolveWorkflowConfigUri();
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const workflowConfigAbsolutePath =
    resolvedWorkflowConfigUri?.scheme === "file"
      ? resolvedWorkflowConfigUri.fsPath
      : workspaceFolder
        ? path.join(workspaceFolder.uri.fsPath, getConfiguredWorkflowConfigPath())
        : path.join(context.extensionPath, getConfiguredWorkflowConfigPath());

  mcpProcess = cp.spawn(process.execPath, [serverScript], {
    cwd: workspaceFolder?.uri.fsPath ?? context.extensionPath,
    env: {
      ...process.env,
      CMSIS_DEV_WORKFLOW_CONFIG: workflowConfigAbsolutePath
    },
    stdio: "pipe",
    windowsHide: true
  });

  mcpProcess.on("error", (error) => {
    vscode.window.showWarningMessage(`CMSIS-Dev MCP server failed to start: ${error.message}`);
  });

  mcpProcess.stderr?.on("data", (chunk) => {
    const message = chunk.toString().trim();
    if (message.length > 0) {
      console.error(`[CMSIS-Dev MCP] ${message}`);
    }
  });

  context.subscriptions.push({
    dispose: () => {
      if (mcpProcess && !mcpProcess.killed) {
        mcpProcess.kill();
      }
    }
  });
}

async function createRunsWatcher(runsProvider: RunsProvider): Promise<vscode.FileSystemWatcher | undefined> {
  const runsDirUri = await resolveWorkflowRunsDirUri();
  if (!runsDirUri || runsDirUri.scheme !== "file") {
    return undefined;
  }

  const pattern = new vscode.RelativePattern(path.dirname(runsDirUri.fsPath), `${path.basename(runsDirUri.fsPath)}/**/*.md`);
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);

  watcher.onDidCreate(() => void runsProvider.refresh());
  watcher.onDidChange(() => void runsProvider.refresh());
  watcher.onDidDelete(() => void runsProvider.refresh());

  return watcher;
}

function createWorkflowWatchers(configuredWorkflowPath: string): vscode.FileSystemWatcher[] {
  const normalizedConfiguredPath = configuredWorkflowPath.replace(/\\/g, "/");
  const patterns =
    normalizedConfiguredPath === DEFAULT_WORKFLOW_CONFIG_PATH
      ? ["**/.cmsis-dev/workflows.yml", "**/.cmsis-dev/workflows/*.yml", "**/.cmsis-dev/workflows/*.yaml"]
      : normalizedConfiguredPath.endsWith(".yml") || normalizedConfiguredPath.endsWith(".yaml")
        ? [`**/${normalizedConfiguredPath}`]
        : [`**/${normalizedConfiguredPath}/*.yml`, `**/${normalizedConfiguredPath}/*.yaml`];

  return Array.from(new Set(patterns)).map((pattern) => vscode.workspace.createFileSystemWatcher(pattern));
}

async function updateActiveOutputContexts(editor: vscode.TextEditor | undefined): Promise<void> {
  const followUpState = await getActiveOutputFollowUpState(editor);
  await Promise.all([
    vscode.commands.executeCommand("setContext", "cmsisDev.activeOutput.canOpenReasoning", followUpState.canOpenReasoning),
    vscode.commands.executeCommand("setContext", "cmsisDev.activeOutput.canOpenPr", followUpState.canOpenPr),
    vscode.commands.executeCommand("setContext", "cmsisDev.activeOutput.canOpenIssue", followUpState.canOpenIssue),
    vscode.commands.executeCommand("setContext", "cmsisDev.activeOutput.canPostComment", followUpState.canPostComment),
    vscode.commands.executeCommand("setContext", "cmsisDev.activeOutput.canSubmitPr", followUpState.canSubmitPr),
    vscode.commands.executeCommand("setContext", "cmsisDev.activeOutput.canOpenCodexChat", followUpState.canOpenCodexChat)
  ]);
}
