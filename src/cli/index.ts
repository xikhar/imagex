#!/usr/bin/env node
import { Command } from 'commander';
import { clearAuthStore, getCodexAuthStatus, resolveCodexBearerToken } from '../auth/store.js';
import { loginToCodex } from '../auth/codex.js';
import { imagexPaths } from '../config/paths.js';
import { startServer } from '../daemon/server.js';

const program = new Command();

program
  .name('imagex')
  .description('Local-first AI image workflow app')
  .version('1.0.0');

program
  .command('auth')
  .description('Authenticate with ChatGPT/Codex OAuth')
  .action(async () => {
    await loginToCodex();
    console.log('Authenticated with OpenAI Codex / ChatGPT.');
  });

program
  .command('whoami')
  .description('Show current auth status')
  .action(async () => {
    const status = await getCodexAuthStatus();
    if (!status.authenticated) {
      console.log('Provider: OpenAI Codex / ChatGPT');
      console.log('Status: not authenticated');
      return;
    }

    await resolveCodexBearerToken();
    console.log('Provider: OpenAI Codex / ChatGPT');
    console.log('Status: authenticated');
    if (status.accountId) console.log(`Account ID: ${status.accountId}`);
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
  .option('--no-open', 'do not open the browser automatically')
  .action(async (options: { host: string; port: string; open: boolean }) => {
    const port = Number.parseInt(options.port, 10);
    if (!Number.isFinite(port)) throw new Error(`Invalid port: ${options.port}`);

    await startServer({ host: options.host, port });
    const url = `http://${options.host}:${port}`;
    console.log(`imagex is running at ${url}`);
    console.log(`Data directory: ${imagexPaths().root}`);

    if (options.open) {
      const { spawn } = await import('node:child_process');
      const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
      const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
      const child = spawn(command, args, { detached: true, stdio: 'ignore' });
      child.unref();
    }
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
