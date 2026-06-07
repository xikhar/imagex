import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { OAuthCredentials, OAuthProviderId } from '@earendil-works/pi-ai/oauth';
import { getOAuthApiKey } from '@earendil-works/pi-ai/oauth';
import { imagexPaths } from '../config/paths.js';
import { readJsonFile, writeJsonFile } from '../config/jsonStore.js';

export type AuthStore = Record<OAuthProviderId, OAuthCredentials>;

const codexProviderId = 'openai-codex';

export async function loadAuthStore(): Promise<AuthStore> {
  try {
    return await readJsonFile<AuthStore>(imagexPaths().authFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

export async function saveAuthStore(auth: AuthStore): Promise<void> {
  const authFile = imagexPaths().authFile;
  await mkdir(dirname(authFile), { recursive: true, mode: 0o700 });
  await writeJsonFile(authFile, auth, { mode: 0o600 });
}

export async function clearAuthStore(): Promise<void> {
  await rm(imagexPaths().authFile, { force: true });
}

export async function saveCodexCredentials(credentials: OAuthCredentials): Promise<void> {
  const auth = await loadAuthStore();
  auth[codexProviderId] = credentials;
  await saveAuthStore(auth);
}

export async function getCodexAuthStatus(): Promise<{
  authenticated: boolean;
  provider: typeof codexProviderId;
  accountId?: string;
  expires?: number;
}> {
  const credentials = (await loadAuthStore())[codexProviderId];
  const status: {
    authenticated: boolean;
    provider: typeof codexProviderId;
    accountId?: string;
    expires?: number;
  } = {
    authenticated: Boolean(credentials),
    provider: codexProviderId,
  };
  if (typeof credentials?.accountId === 'string') status.accountId = credentials.accountId;
  if (typeof credentials?.expires === 'number') status.expires = credentials.expires;
  return status;
}

export async function resolveCodexBearerToken(): Promise<string> {
  const auth = await loadAuthStore();
  const result = await getOAuthApiKey(codexProviderId, auth);
  if (!result) {
    throw new Error('Not authenticated. Run `imagex auth` first.');
  }

  auth[codexProviderId] = result.newCredentials;
  await saveAuthStore(auth);
  return result.apiKey;
}
