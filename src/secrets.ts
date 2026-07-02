import * as vscode from "vscode";

const GITHUB_TOKEN_KEY = "cmsisDev.githubToken";

let secretStorage: vscode.SecretStorage | undefined;

export function initializeSecretStorage(storage: vscode.SecretStorage): void {
  secretStorage = storage;
}

export async function getGitHubToken(): Promise<string | undefined> {
  if (!secretStorage) {
    return undefined;
  }

  const token = await secretStorage.get(GITHUB_TOKEN_KEY);
  const trimmed = token?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export async function setGitHubToken(token: string): Promise<void> {
  if (!secretStorage) {
    throw new Error("Secret storage is not initialized.");
  }

  await secretStorage.store(GITHUB_TOKEN_KEY, token.trim());
}

export async function clearGitHubToken(): Promise<void> {
  if (!secretStorage) {
    throw new Error("Secret storage is not initialized.");
  }

  await secretStorage.delete(GITHUB_TOKEN_KEY);
}
