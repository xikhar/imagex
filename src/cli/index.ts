#!/usr/bin/env node
import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { clearAuthStore, getCodexAuthStatus, resolveCodexBearerToken } from '../auth/store.js';
import { loginToCodex } from '../auth/codex.js';
import { imagexPaths } from '../config/paths.js';
import { startServer } from '../daemon/server.js';
import { assertSafeBindHost, remoteBindWarning } from '../daemon/security.js';

const program = new Command();

program
  .name('imagex')
  .description('Local-first AI image workflow app')
  .version('1.0.0')
  .action(async () => {
    await ensureCodexAuth();
    await startImagexUi({
      host: '127.0.0.1',
      port: '3847',
      allowRemote: false,
      open: true,
    });
  });

program
  .command('auth')
  .description('Authenticate with ChatGPT/Codex OAuth')
  .action(async () => {
    await loginToCodex();
    console.log('Authenticated with OpenAI Codex / ChatGPT.');
  });

program
  .command('status')
  .description('Show current auth status')
  .action(async () => {
    await printAuthStatus();
  });

program
  .command('whoami')
  .description('Alias for status')
  .action(async () => {
    await printAuthStatus();
  });

program
  .command('logout')
  .description('Clear stored credentials')
  .action(async () => {
    await clearAuthStore();
    console.log('Logged out.');
  });

program
  .command('ui')
  .description('Start the local imagex daemon and web UI')
  .option('--host <host>', 'host to bind', '127.0.0.1')
  .option('--port <port>', 'port to bind', '3847')
  .option('--allow-remote', 'allow binding to a non-loopback host')
  .option('--no-open', 'do not open the browser automatically')
  .action(async (options: { host: string; port: string; allowRemote?: boolean; open: boolean }) => {
    await startImagexUi(options);
  });

program
  .command('doctor')
  .description('Check local imagex setup')
  .action(async () => {
    const status = await getCodexAuthStatus();
    console.log(`Auth: ${status.authenticated ? 'configured' : 'missing'}`);
    console.log(`Data directory: ${imagexPaths().root}`);
    console.log(`Workflows: ${imagexPaths().workflowsDir}`);
    console.log(`Outputs: ${imagexPaths().outputsDir}`);
  });

await program.parseAsync();

async function printAuthStatus(): Promise<void> {
  const status = await getCodexAuthStatus();
  console.log('Provider: OpenAI Codex / ChatGPT');
  if (!status.authenticated) {
    console.log('Status: not authenticated');
    return;
  }

  try {
    await resolveCodexBearerToken();
    console.log('Status: authenticated');
  } catch {
    console.log('Status: needs refresh');
    console.log('Run: imagex auth');
  }
  if (status.accountId) console.log(`Account ID: ${status.accountId}`);
}

async function ensureCodexAuth(): Promise<void> {
  const status = await getCodexAuthStatus();
  if (status.authenticated) {
    try {
      await resolveCodexBearerToken();
      return;
    } catch {
      console.log('Stored OpenAI Codex / ChatGPT credentials need to be refreshed.');
    }
  } else {
    console.log('OpenAI Codex / ChatGPT authentication is required before starting Imagex.');
  }

  await loginToCodex();
  console.log('Authenticated with OpenAI Codex / ChatGPT.');
}

async function startImagexUi(options: { host: string; port: string; allowRemote?: boolean; open: boolean }): Promise<void> {
  const port = Number.parseInt(options.port, 10);
  if (!Number.isFinite(port)) throw new Error(`Invalid port: ${options.port}`);
  assertSafeBindHost(options.host, Boolean(options.allowRemote));

  await startServer({ host: options.host, port });
  const url = `http://${options.host}:${port}`;
  console.log(`imagex is running at ${url}`);
  console.log(`Data directory: ${imagexPaths().root}`);
  const warning = remoteBindWarning(options.host);
  if (warning) console.warn(warning);

  if (options.open) openUrl(url);
}

function openUrl(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {
    // The printed URL is the fallback.
  });
  child.unref();
}
