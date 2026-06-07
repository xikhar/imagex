#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const host = '127.0.0.1';
const chromeBin = process.env.CHROME_BIN || 'google-chrome';
const tinyPngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAI0lEQVR4nGP8z4AATAxEcQAZGJgYGBgYQfqA4gIiAABm0wQJ8d71WQAAAABJRU5ErkJggg==';

class CdpClient {
  static connect(url) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const client = new CdpClient(socket);
      socket.addEventListener('open', () => resolve(client), { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) {
        this.events.push(message);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
  }

  call(method, params = {}) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  close() {
    this.socket.close();
  }
}

const tempHome = await mkdtemp(join(tmpdir(), 'imagex-e2e-'));
const daemonPort = await getFreePort();
const webPort = await getFreePort();
const mockPort = await getFreePort();
const debugPort = await getFreePort();
const checks = [];
let mockDelayMs = 250;
let daemonSessionToken = null;

const mockServer = createMockCodexServer();
await listen(mockServer, mockPort);

await seedAuth(tempHome);

const daemon = spawn(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['tsx', 'src/cli/index.ts', 'ui', '--host', host, '--port', String(daemonPort), '--no-open'],
  {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      IMAGEX_HOME: tempHome,
      CODEX_API_BASE: `http://${host}:${mockPort}/backend-api/codex/responses`,
    },
  },
);
const daemonOutput = captureOutput(daemon);

const vite = spawn(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['vite', '--host', host, '--port', String(webPort), '--strictPort', '--clearScreen', 'false'],
  {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      IMAGEX_DAEMON_URL: `http://${host}:${daemonPort}`,
    },
  },
);
const viteOutput = captureOutput(vite);

let chrome;
try {
  await waitForServer(`http://${host}:${daemonPort}/api/health`, 20_000, () => daemonOutput.value);
  await waitForServer(`http://${host}:${webPort}`, 20_000, () => viteOutput.value);

  const project = await seedProject(daemonPort);
  const targetUrl = `http://${host}:${webPort}/projects/e2e--${project.metadata.id}`;

  chrome = spawn(
    chromeBin,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      `--remote-debugging-port=${debugPort}`,
      targetUrl,
    ],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const chromeOutput = captureOutput(chrome);

  const wsUrl = await waitForPageWebSocket(debugPort, targetUrl, 20_000);
    const cdp = await CdpClient.connect(wsUrl);
  try {
    await cdp.call('Runtime.enable');
    await cdp.call('Log.enable');
    await cdp.call('Page.enable');
    await cdp.call('Page.navigate', { url: targetUrl });
    await waitForExpression(cdp, `location.origin === ${JSON.stringify(`http://${host}:${webPort}`)}`, 20_000);
    await evaluate(cdp, `localStorage.setItem('imagex.rightOpen', 'false'); localStorage.setItem('imagex.minimap', 'false')`);
    await cdp.call('Page.navigate', { url: targetUrl });
    await waitForExpression(cdp, 'document.querySelectorAll(".react-flow__node").length >= 4', 20_000);
    check('project opens seeded workflow');

    await verifyGenerationCancelAndRecovery(cdp, targetUrl);
    mockDelayMs = 50;
    await verifyGenerationSocketsAndConnections(cdp);
    await verifyCanvasGestures(cdp);
    await verifyMenusAndWorkflowSwitching(cdp);

    console.log(`E2E_VERIFY_PASS ${JSON.stringify({ checks: checks.length })}`);
  } catch (error) {
    const debugState = await browserDebugState(cdp).catch((debugError) => ({ debugError: String(debugError) }));
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${JSON.stringify(debugState, null, 2)}\n${chromeOutput.value}`);
  } finally {
    cdp.close();
  }
} finally {
  if (chrome && !chrome.killed) chrome.kill('SIGTERM');
  daemon.kill('SIGTERM');
  vite.kill('SIGTERM');
  mockServer.close();
  await rm(tempHome, { recursive: true, force: true });
}

async function verifyCanvasGestures(cdp) {
  await clickNode(cdp, 'output-main');
  await waitForExpression(cdp, '!document.querySelector(".ix-split-button-main")?.disabled', 5_000);
  check('selected output enables run button');

  const before = await nodeRect(cdp, 'prompt-main');
  await drag(cdp, before.x + 48, before.y + 22, before.x + 138, before.y + 67);
  await waitForExpression(
    cdp,
    `(() => {
      const rect = document.querySelector('.react-flow__node[data-id="prompt-main"]')?.getBoundingClientRect();
      return rect && Math.abs(rect.left - ${before.x}) > 20;
    })()`,
    5_000,
  );
  check('node drag updates live canvas position');

  const transformBeforePan = await viewportTransform(cdp);
  await drag(cdp, 520, 420, 640, 490, 'middle');
  await waitForExpression(cdp, `document.querySelector('.react-flow__viewport')?.style.transform !== ${JSON.stringify(transformBeforePan)}`, 5_000);
  check('canvas pan changes viewport transform');

  const zoomBefore = await viewportTransform(cdp);
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 520, y: 420, deltaY: -500, deltaX: 0 });
  await waitForExpression(cdp, `document.querySelector('.react-flow__viewport')?.style.transform !== ${JSON.stringify(zoomBefore)}`, 5_000);
  check('canvas zoom changes viewport transform');
}

async function verifyMenusAndWorkflowSwitching(cdp) {
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
  await waitForExpression(cdp, '[...document.querySelectorAll(".node-menu .menu-item")].some((item) => item.textContent?.includes("Add Image"))', 5_000);
  check('A shortcut opens add-node context menu');
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });

  const tab = await elementRect(cdp, '.top-bar-tab.active');
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: tab.x + 20, y: tab.y + 10, button: 'right', buttons: 2 });
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tab.x + 20, y: tab.y + 10, button: 'right', buttons: 0 });
  await waitForExpression(cdp, '[...document.querySelectorAll(".node-menu .menu-item")].some((item) => item.textContent?.includes("Rename"))', 5_000);
  check('workflow tab context menu opens');
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });

  await evaluate(cdp, `(() => [...document.querySelectorAll('.top-bar-tab')].find((tab) => tab.textContent?.includes('Second Workflow'))?.click())()`);
  await waitForFlowNodeCount(cdp, 0);
  check('workflow switch loads second workflow');
  await evaluate(cdp, `(() => [...document.querySelectorAll('.top-bar-tab')].find((tab) => tab.textContent?.includes('E2E Workflow'))?.click())()`);
  await waitForFlowNodeCount(cdp, 4);
  check('workflow switch returns to original workflow');
}

async function verifyGenerationCancelAndRecovery(cdp, targetUrl) {
  mockDelayMs = 3_000;
  await selectOutputForRun(cdp);
  await clickRunButton(cdp);
  await waitForExpression(cdp, 'document.querySelector(".ix-split-button-main")?.textContent?.includes("Running")', 5_000);
  check('generation enters running state');

  await cdp.call('Page.navigate', { url: targetUrl });
  await waitForExpression(cdp, 'document.querySelector(".ix-split-button-main")?.textContent?.includes("Running")', 10_000);
  await waitForExpression(cdp, 'Boolean(document.querySelector("[aria-label=\\"Cancel generation\\"]"))', 5_000);
  check('refresh preserves running generation state');

  await evaluate(cdp, `document.querySelector('[aria-label="Cancel generation"]')?.click()`);
  await waitForExpression(cdp, '!document.querySelector(".ix-split-button-main")?.textContent?.includes("Running")', 10_000);
  await waitForExpression(
    cdp,
    `(async () => {
      const { flowStore } = await import('/state/flowStore.ts');
      const node = flowStore.getNode('output-main')?.data.workflowNode;
      return !node?.data.generating && node?.data.generation?.status === 'cancelled';
    })()`,
    10_000,
  );
  check('cancel clears running state after refresh');
}

async function verifyGenerationSocketsAndConnections(cdp) {
  await selectOutputForRun(cdp);
  await clickRunButton(cdp);
  await waitForExpression(
    cdp,
    `(async () => {
      const { flowStore } = await import('/state/flowStore.ts');
      const node = flowStore.getNode('output-main')?.data.workflowNode;
      return Array.isArray(node?.data.previewUrls) && node.data.previewUrls.length === 3 && node.data.generation?.status === 'done';
    })()`,
    20_000,
  );
  await waitForExpression(cdp, 'document.querySelectorAll(".react-flow__handle[data-nodeid=\\"output-main\\"][data-handleid^=\\"result-out\\"]").length === 3', 10_000);
  check('generation creates three output sockets');

  await waitForExpression(
    cdp,
    `(async () => {
      const { flowStore } = await import('/state/flowStore.ts');
      const { isCompatibleConnection, outputPortsFor } = await import('/ui/flow/ports.ts');
      const nodes = flowStore.getWorkflowNodes();
      const output = nodes.find((node) => node.id === 'output-main');
      return outputPortsFor(output).length === 3 &&
        isCompatibleConnection({ source: 'output-main', sourceHandle: 'result-out:1', target: 'blur-main', targetHandle: 'image-in' }, nodes, flowStore.getEdges()) &&
        isCompatibleConnection({ source: 'output-main', sourceHandle: 'result-out:2', target: 'dependent-output', targetHandle: 'input-in' }, nodes, flowStore.getEdges());
    })()`,
    10_000,
  );
  check('dynamic output sockets are valid connection sources');

  await evaluate(
    cdp,
    `(async () => {
      const { flowStore } = await import('/state/flowStore.ts');
      flowStore.setEdges([
        ...flowStore.getEdges().filter((edge) => !(edge.target === 'blur-main' && edge.targetHandle === 'image-in')),
        {
          id: 'output-main-result-out-blur-main-image-in',
          source: 'output-main',
          sourceHandle: 'result-out',
          target: 'blur-main',
          targetHandle: 'image-in',
          type: 'default',
        },
      ]);
    })()`,
  );
  await waitForEdge(cdp, 'output-main', 'result-out', 'blur-main', 'image-in');
  check('dynamic output socket edge renders');

  await evaluate(
    cdp,
    `(async () => {
      const { flowStore } = await import('/state/flowStore.ts');
      flowStore.setEdges([
        ...flowStore.getEdges().filter((edge) => !(edge.target === 'blur-main' && edge.targetHandle === 'image-in')),
        {
          id: 'output-main-result-out-1-blur-main-image-in',
          source: 'output-main',
          sourceHandle: 'result-out:1',
          target: 'blur-main',
          targetHandle: 'image-in',
          type: 'default',
        },
        {
          id: 'output-main-result-out-2-dependent-output-input-in',
          source: 'output-main',
          sourceHandle: 'result-out:2',
          target: 'dependent-output',
          targetHandle: 'input-in',
          type: 'default',
        },
      ]);
    })()`,
  );
  await waitForExpression(
    cdp,
    `(async () => {
      const { flowStore } = await import('/state/flowStore.ts');
      const blurEdges = flowStore.getEdges().filter((edge) => edge.target === 'blur-main' && edge.targetHandle === 'image-in');
      return blurEdges.length === 1 &&
        blurEdges[0]?.sourceHandle === 'result-out:1' &&
        flowStore.getEdges().some((edge) => edge.source === 'output-main' && edge.sourceHandle === 'result-out:2' && edge.target === 'dependent-output');
    })()`,
    10_000,
  );
  check('dynamic output socket edges can be replaced and reused');
}

async function seedAuth(home) {
  const authFile = join(home, 'auth.json');
  await writeFile(
    authFile,
    JSON.stringify(
      {
        'openai-codex': {
          access: 'imagex-e2e-token',
          refresh: 'imagex-e2e-refresh',
          expires: Date.now() + 60 * 60 * 1000,
          accountId: 'imagex-e2e',
        },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}

async function seedProject(port) {
  const created = await api(port, '/api/projects', {
    method: 'POST',
    body: { title: 'E2E Workflow', description: 'Browser regression fixture', templateId: 'scratch' },
  });
  const project = created.project;
  const mainWorkflow = buildMainWorkflow(project.workflow.id);
  await api(port, `/api/projects/${encodeURIComponent(project.metadata.id)}/workflow`, {
    method: 'POST',
    body: { workflow: mainWorkflow },
  });
  await api(port, `/api/projects/${encodeURIComponent(project.metadata.id)}/workflows`, {
    method: 'POST',
    body: { title: 'Second Workflow' },
  });
  return (await api(port, `/api/projects/${encodeURIComponent(project.metadata.id)}`)).project;
}

function buildMainWorkflow(id) {
  const now = new Date().toISOString();
  return {
    id,
    version: '0.1',
    name: 'E2E Workflow',
    createdAt: now,
    updatedAt: now,
    settings: { provider: 'openai-codex', useCase: 'product-shot' },
    nodes: [
      {
        id: 'prompt-main',
        type: 'prompt',
        position: { x: 0, y: 0 },
        data: {
          fieldsMode: 'managed',
          fields: [{ id: 'text', label: 'Text', kind: 'textarea', value: 'Create a clean product image.' }],
        },
      },
      {
        id: 'output-main',
        type: 'codex-output',
        position: { x: 420, y: 0 },
        data: {
          count: 3,
          model: 'gpt-image-2',
          size: '1024x1024',
          quality: 'low',
          format: 'png',
          background: 'auto',
        },
      },
      {
        id: 'blur-main',
        type: 'blur',
        position: { x: 820, y: -120 },
        data: { radius: 12 },
      },
      {
        id: 'dependent-output',
        type: 'codex-output',
        position: { x: 1160, y: 40 },
        data: {
          count: 1,
          model: 'gpt-image-2',
          size: '1024x1024',
          quality: 'low',
          format: 'png',
          background: 'auto',
        },
      },
    ],
    edges: [
      {
        id: 'prompt-output',
        source: 'prompt-main',
        sourceHandle: 'text-out',
        target: 'output-main',
        targetHandle: 'input-in',
      },
    ],
  };
}

function createMockCodexServer() {
  return createHttpServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/backend-api/codex/responses') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    req.resume();
    setTimeout(() => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.end(
        `data: ${JSON.stringify({
          type: 'response.output_item.done',
          item: {
            type: 'image_generation_call',
            result: tinyPngBase64,
            revised_prompt: 'E2E mock image',
          },
        })}\n\ndata: [DONE]\n\n`,
      );
    }, mockDelayMs);
  });
}

async function api(port, path, options = {}) {
  const method = options.method || 'GET';
  const init = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) {
    daemonSessionToken ??= (await api(port, '/api/session')).token;
    init.headers['x-imagex-session'] = daemonSessionToken;
  }
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  const response = await fetch(`http://${host}:${port}${path}`, init);
  if (!response.ok) throw new Error(`${init.method} ${path} failed: ${response.status} ${await response.text()}`);
  return response.json();
}

async function clickNode(cdp, nodeId) {
  const rect = await nodeRect(cdp, nodeId);
  await click(cdp, rect.x + rect.width / 2, rect.y + 24);
}

async function selectOutputForRun(cdp) {
  await clickNode(cdp, 'output-main');
  await waitForExpression(cdp, 'document.querySelector(".react-flow__node[data-id=\\"output-main\\"] .ix-node")?.classList.contains("selected")', 5_000);
  await waitForExpression(cdp, '!document.querySelector(".ix-split-button-main")?.disabled', 5_000);
}

async function clickRunButton(cdp) {
  await evaluate(
    cdp,
    `(() => {
      const button = document.querySelector('.ix-split-button-main');
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`,
  );
}

async function waitForEdge(cdp, source, sourceHandle, target, targetHandle) {
  await waitForExpression(
    cdp,
    `(async () => {
      const { flowStore } = await import('/state/flowStore.ts');
      return flowStore.getEdges().some((edge) =>
        edge.source === ${JSON.stringify(source)} &&
        edge.sourceHandle === ${JSON.stringify(sourceHandle)} &&
        edge.target === ${JSON.stringify(target)} &&
        edge.targetHandle === ${JSON.stringify(targetHandle)}
      );
    })()`,
    10_000,
  );
}

async function waitForFlowNodeCount(cdp, count) {
  await waitForExpression(
    cdp,
    `(async () => {
      const { flowStore } = await import('/state/flowStore.ts');
      return flowStore.getNodes().length === ${count};
    })()`,
    10_000,
  );
}

async function click(cdp, x, y, button = 'left') {
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: buttonMask(button), clickCount: 1 });
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1 });
}

async function drag(cdp, fromX, fromY, toX, toY, button = 'left') {
  const buttons = buttonMask(button);
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fromX, y: fromY, button: 'none', buttons: 0 });
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: fromX, y: fromY, button, buttons, clickCount: 1 });
  await sleep(120);
  for (let step = 1; step <= 14; step += 1) {
    const x = fromX + ((toX - fromX) * step) / 14;
    const y = fromY + ((toY - fromY) * step) / 14;
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button, buttons });
    await sleep(16);
  }
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: toX, y: toY, button, buttons: 0, clickCount: 1 });
}

function buttonMask(button) {
  if (button === 'right') return 2;
  if (button === 'middle') return 4;
  return 1;
}

async function nodeRect(cdp, nodeId) {
  return elementRect(cdp, `.react-flow__node[data-id="${cssEscape(nodeId)}"]`);
}

async function elementRect(cdp, selector) {
  const rect = await evaluate(
    cdp,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
    })()`,
  );
  if (!rect) throw new Error(`Missing element: ${selector}`);
  return rect;
}

async function viewportTransform(cdp) {
  return evaluate(cdp, `document.querySelector('.react-flow__viewport')?.style.transform || ''`);
}

async function evaluate(cdp, expression) {
  const response = await cdp.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description ||
        response.exceptionDetails.exception?.value ||
        response.exceptionDetails.text ||
        'Runtime evaluation failed',
    );
  }
  return response.result?.value;
}

async function browserDebugState(cdp) {
  const pageState = await evaluate(
    cdp,
    `(() => ({
      href: location.href,
      title: document.title,
      bodyText: document.body?.innerText?.slice(0, 1000) || '',
      nodeCount: document.querySelectorAll('.react-flow__node').length,
      apiText: document.querySelector('pre')?.textContent || '',
    }))()`,
  );
  return {
    ...pageState,
    events: cdp.events
      .filter((event) => event.method === 'Runtime.exceptionThrown' || event.method === 'Log.entryAdded')
      .slice(-10),
  };
}

async function waitForExpression(cdp, expression, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await evaluate(cdp, expression);
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for expression: ${expression}`);
}

async function waitForServer(target, timeoutMs, output) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(target);
      if (response.ok || response.status === 404) return;
    } catch {
      // Server is still starting.
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${target}\n${output()}`);
}

async function waitForPageWebSocket(debugPort, targetUrl, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://${host}:${debugPort}/json`);
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find((target) => target.type === 'page' && target.url === targetUrl)
          || targets.find((target) => target.type === 'page');
        if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
      }
    } catch {
      // Chrome is still starting.
    }
    await sleep(100);
  }
  throw new Error('Timed out waiting for Chrome DevTools.');
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.listen(0, host, () => {
      const address = server.address();
      const selected = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(selected));
    });
    server.on('error', reject);
  });
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.listen(port, host, resolve);
    server.on('error', reject);
  });
}

function captureOutput(child) {
  const output = { value: '' };
  child.stdout.on('data', (chunk) => { output.value += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output.value += chunk.toString(); });
  child.on('exit', (code, signal) => {
    if (code && code !== 0) output.value += `\nprocess exited with ${signal || code}`;
  });
  return output;
}

function check(message) {
  checks.push(message);
}

function cssEscape(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
