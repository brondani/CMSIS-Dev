import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { resolveWorkflowConfigUri } from "./workflowConfig";

class WorkflowFileItem extends vscode.TreeItem {
  readonly modifiedAt: number;

  constructor(
    public readonly uri: vscode.Uri,
    modifiedAt: number
  ) {
    super(path.basename(uri.fsPath), vscode.TreeItemCollapsibleState.None);
    this.modifiedAt = modifiedAt;
    this.resourceUri = uri;
    this.description = new Date(modifiedAt).toLocaleString();
    this.tooltip = uri.fsPath;
    this.contextValue = "cmsisDev.workflowFile";
    this.command = {
      command: "vscode.open",
      title: "Open Workflow File",
      arguments: [uri, { preview: false }]
    };
  }
}

class WorkflowsPlaceholderItem extends vscode.TreeItem {
  constructor(label: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
  }
}

type WorkflowsTreeItem = WorkflowFileItem | WorkflowsPlaceholderItem;

export class WorkflowsProvider implements vscode.TreeDataProvider<WorkflowsTreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<WorkflowsTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private workflowFiles: WorkflowFileItem[] = [];

  async refresh(): Promise<void> {
    this.workflowFiles = await this.loadWorkflowFiles();
    this.onDidChangeTreeDataEmitter.fire();
  }

  getTreeItem(element: WorkflowsTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<WorkflowsTreeItem[]> {
    if (this.workflowFiles.length === 0) {
      this.workflowFiles = await this.loadWorkflowFiles();
    }

    return this.workflowFiles.length > 0 ? this.workflowFiles : [new WorkflowsPlaceholderItem("No workflow config files found")];
  }

  private async loadWorkflowFiles(): Promise<WorkflowFileItem[]> {
    const workflowConfigUri = await resolveWorkflowConfigUri();
    if (!workflowConfigUri || workflowConfigUri.scheme !== "file") {
      return [];
    }

    try {
      const stat = await fs.stat(workflowConfigUri.fsPath);
      if (stat.isFile()) {
        if (!isWorkflowYamlFile(workflowConfigUri.fsPath)) {
          return [];
        }

        return [new WorkflowFileItem(workflowConfigUri, stat.mtimeMs)];
      }

      const entries = await fs.readdir(workflowConfigUri.fsPath, { withFileTypes: true });
      const files = await Promise.all(
        entries
          .filter((entry) => entry.isFile() && isWorkflowYamlFile(entry.name))
          .map(async (entry) => {
            const uri = vscode.Uri.file(path.join(workflowConfigUri.fsPath, entry.name));
            const entryStat = await fs.stat(uri.fsPath);
            return new WorkflowFileItem(uri, entryStat.mtimeMs);
          })
      );

      return files.sort((left, right) => left.label!.toString().localeCompare(right.label!.toString()));
    } catch {
      return [];
    }
  }
}

function isWorkflowYamlFile(targetPath: string): boolean {
  const extension = path.extname(targetPath).toLowerCase();
  return extension === ".yml" || extension === ".yaml";
}
