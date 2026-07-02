import * as vscode from "vscode";

const GITHUB_TOKEN_KEY = "cmsisDev.githubToken";
const LANGUAGE_MODEL_PROVIDER_API_KEY = "cmsisDev.languageModelProvider.apiKey";

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

export async function getLanguageModelProviderApiKey(): Promise<string | undefined> {
  if (!secretStorage) {
    return undefined;
  }

  const token = await secretStorage.get(LANGUAGE_MODEL_PROVIDER_API_KEY);
  const trimmed = token?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export async function setLanguageModelProviderApiKey(token: string): Promise<void> {
  if (!secretStorage) {
    throw new Error("Secret storage is not initialized.");
  }

  await secretStorage.store(LANGUAGE_MODEL_PROVIDER_API_KEY, token.trim());
}

export async function clearLanguageModelProviderApiKey(): Promise<void> {
  if (!secretStorage) {
    throw new Error("Secret storage is not initialized.");
  }

  await secretStorage.delete(LANGUAGE_MODEL_PROVIDER_API_KEY);
}
