import express, { type Request, type Response, type NextFunction } from 'express';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import photon from '@silvia-odwyer/photon-node';
import { readJsonFile, writeJsonFile } from '../config/jsonStore.js';
import { imagexPaths } from '../config/paths.js';
import { getCodexAuthStatus, resolveCodexBearerToken } from '../auth/store.js';
import { generateCodexImages } from '../providers/codexImage.js';
import type {
  GenerateWorkflowRequest,
  GenerateWorkflowRunRequest,
  GeneratedImage,
  GenerationJobStatus,
  GenerationRunMode,
  ImageXEdge,
  ImageXNode,
  ImageXOutputAsset,
  ImageXWorkflow,
  OutputNodeGenerationState,
  OutputNodeResult,
} from '../shared/types.js';
import { compileOutputNodeWorkflow, compileWorkflow } from '../workflows/compiler.js';
import { listWorkflows, saveWorkflow } from '../workflows/store.js';
import {
  createProject,
  createProjectNodeAsset,
  createProjectWorkflow,
  deleteProjectWorkflow,
  deleteProject,
  deleteProjectAsset,
  deleteProjectNodeAsset,
  getProject,
  importProjectAsset,
  loadProjectWorkflow,
  listProjectAssets,
  listProjectNodeAssets,
  listProjects,
  listTemplates,
  projectAssetDir,
  projectAssetPath,
  projectOutputDir,
  renameProjectAsset,
  renameProjectNodeAsset,
  renameProject,
  saveProjectWorkflow,
  type CreateProjectInput,
} from '../projects/store.js';

function log(scope: string, message: string, extra?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const extraStr = extra ? ` ${JSON.stringify(extra)}` : '';
  console.log(`[${ts}] [${scope}] ${message}${extraStr}`);
}

function logRequest(req: Request, res: Response, start: number): void {
  const duration = Date.now() - start;
  log('http', `${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
}

export type StartServerOptions = {
  host: string;
  port: number;
};

export async function startServer(options: StartServerOptions): Promise<Server> {
  const app = express();
  app.use(express.json({ limit: '25mb' }));
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => logRequest(req, res, start));
    next();
  });

  // ─── Active generation job tracking ─────────────────────────────────────────
  type DurableGenerationJob = {
    id: string;
    projectId: string;
    workflowId: string;
    mode: GenerationRunMode;
    requestedOutputNodeIds: string[];
    plannedOutputNodeIds: string[];
    status: 'running' | 'done' | 'error' | 'cancelled';
    outputs: Record<string, OutputNodeGenerationState>;
    results: OutputNodeResult[];
    createdAt: string;
    updatedAt: string;
    error?: string;
  };

  type ActiveJob = {
    job: DurableGenerationJob;
    controller: AbortController;
  };

  const activeJobs = new Map<string, ActiveJob>();

  function generationJobsFile(projectId: string): string {
    return join(projectOutputDir(projectId), 'runs', 'index.json');
  }

  function generationRunDir(projectId: string, jobId: string): string {
    return join(projectOutputDir(projectId), 'runs', safePathSegment(jobId));
  }

  function generationRunJobFile(projectId: string, jobId: string): string {
    return join(generationRunDir(projectId, jobId), 'job.json');
  }

  function generationOutputDir(projectId: string, jobId: string, outputNodeId: string): string {
    return join(generationRunDir(projectId, jobId), safePathSegment(outputNodeId));
  }

  function generationOutputUrlBase(projectId: string, jobId: string, outputNodeId: string): string {
    return `/api/projects/${encodeURIComponent(projectId)}/outputs/runs/${encodeURIComponent(safePathSegment(jobId))}/${encodeURIComponent(safePathSegment(outputNodeId))}`;
  }

  function safePathSegment(value: string): string {
    return value.replace(/[^a-z0-9._-]+/gi, '_').slice(0, 120) || 'item';
  }

  async function readGenerationJobs(projectId: string): Promise<DurableGenerationJob[]> {
    const parsed = await readJsonFile<DurableGenerationJob[]>(generationJobsFile(projectId), []);
    return Array.isArray(parsed) ? parsed : [];
  }

  async function writeGenerationJobs(projectId: string, jobs: DurableGenerationJob[]): Promise<void> {
    const file = generationJobsFile(projectId);
    await mkdir(dirname(file), { recursive: true });
    await writeJsonFile(file, jobs.slice(-50));
  }

  async function saveGenerationJob(job: DurableGenerationJob): Promise<void> {
    job.updatedAt = new Date().toISOString();
    const runDir = generationRunDir(job.projectId, job.id);
    await mkdir(runDir, { recursive: true });
    await writeJsonFile(generationRunJobFile(job.projectId, job.id), job);

    const jobs = await readGenerationJobs(job.projectId);
    const index = jobs.findIndex((candidate) => candidate.id === job.id);
    if (index >= 0) jobs[index] = job;
    else jobs.push(job);
    await writeGenerationJobs(job.projectId, jobs);
  }

  function latestGenerationJob(jobs: DurableGenerationJob[]): DurableGenerationJob | null {
    return [...jobs].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] || null;
  }

  function outputGenerationState(node: ImageXNode): OutputNodeGenerationState | null {
    const value = node.data.generation;
    if (!value || typeof value !== 'object') return null;
    const state = value as OutputNodeGenerationState;
    return Array.isArray(state.images) ? state : null;
  }

  function storedImagesForOutput(node: ImageXNode): GeneratedImage[] {
    const generation = outputGenerationState(node);
    if (generation?.images.length) return generation.images.filter((image) => existsSync(image.path));
    const urls = Array.isArray(node.data.previewUrls) ? node.data.previewUrls : [];
    return urls
      .filter((url): url is string => typeof url === 'string' && url.length > 0)
      .map((url, index) => ({
        id: `${node.id}-stored-${index}`,
        path: outputPathFromProjectUrl(String(url)),
        url,
      }))
      .filter((image) => Boolean(image.path) && existsSync(image.path));
  }

  function outputPathFromProjectUrl(url: string): string {
    const match = url.match(/^\/api\/projects\/([^/]+)\/outputs\/(.+?)(?:[?#].*)?$/);
    if (!match) return '';
    const projectId = decodeURIComponent(match[1] || '');
    const relativePath = decodeURIComponent(match[2] || '');
    const outputsRoot = resolve(projectOutputDir(projectId));
    const target = resolve(outputsRoot, relativePath);
    if (relative(outputsRoot, target).startsWith('..')) return '';
    return target;
  }

  function expectedCountForOutput(node: ImageXNode): number {
    return Math.max(1, Math.min(4, Math.trunc(Number(node.data?.count) || 1)));
  }

  function patchWorkflowOutputGeneration(
    workflow: ImageXWorkflow,
    outputNodeId: string,
    generation: OutputNodeGenerationState,
  ): ImageXWorkflow {
    return {
      ...workflow,
      nodes: workflow.nodes.map((node) => {
        if (node.id !== outputNodeId) return node;
        return {
          ...node,
          data: {
            ...node.data,
            previewUrl: generation.images[0]?.url || '',
            previewUrls: generation.images.map((image) => image.url),
            previewIndex: 0,
            generating: generation.status === 'queued' || generation.status === 'running',
            generation,
          },
        };
      }),
    };
  }

  function updateJobOutput(
    job: DurableGenerationJob,
    workflow: ImageXWorkflow,
    outputNodeId: string,
    patch: Partial<OutputNodeGenerationState>,
  ): ImageXWorkflow {
    const previous = job.outputs[outputNodeId];
    const now = new Date().toISOString();
    const next: OutputNodeGenerationState = {
      jobId: job.id,
      status: previous?.status || 'queued',
      images: previous?.images || [],
      expectedCount: previous?.expectedCount || 1,
      updatedAt: now,
      ...patch,
    };
    job.outputs[outputNodeId] = next;
    return patchWorkflowOutputGeneration(workflow, outputNodeId, next);
  }

  function outputDependencies(workflow: ImageXWorkflow): Map<string, Set<string>> {
    const outputIds = new Set(workflow.nodes.filter((node) => node.type === 'codex-output').map((node) => node.id));
    const dependencies = new Map<string, Set<string>>();

    function trace(nodeId: string, visited: Set<string>): string[] {
      if (visited.has(nodeId)) return [];
      visited.add(nodeId);
      const found: string[] = [];
      for (const edge of workflow.edges) {
        if (edge.target !== nodeId) continue;
        if (outputIds.has(edge.source)) {
          found.push(edge.source);
        } else {
          found.push(...trace(edge.source, visited));
        }
      }
      return found;
    }

    for (const id of outputIds) {
      dependencies.set(id, new Set(trace(id, new Set())));
    }
    return dependencies;
  }

  function planOutputRun(
    workflow: ImageXWorkflow,
    requestedOutputNodeIds: string[] | undefined,
    mode: GenerationRunMode,
  ): { plannedOutputNodeIds: string[]; levels: string[][]; dependencies: Map<string, Set<string>> } {
    const outputNodes = workflow.nodes.filter((node) => node.type === 'codex-output');
    const outputIds = new Set(outputNodes.map((node) => node.id));
    const nodesById = new Map(outputNodes.map((node) => [node.id, node]));
    const dependencies = outputDependencies(workflow);
    const requested = mode === 'all'
      ? outputNodes.map((node) => node.id)
      : (requestedOutputNodeIds || []).filter((id) => outputIds.has(id));
    const planned = new Set<string>();

    function includeWithDeps(id: string): void {
      if (!outputIds.has(id) || planned.has(id)) return;
      const deps = dependencies.get(id) || new Set<string>();
      for (const depId of deps) {
        const dep = nodesById.get(depId);
        const hasStored = dep ? storedImagesForOutput(dep).length > 0 : false;
        if (mode === 'selected' && hasStored && !requested.includes(depId)) continue;
        includeWithDeps(depId);
      }
      planned.add(id);
    }

    for (const id of requested) includeWithDeps(id);

    const plannedDependencies = new Map<string, Set<string>>();
    for (const id of planned) {
      plannedDependencies.set(id, new Set([...dependencies.get(id) || []].filter((depId) => planned.has(depId))));
    }

    const remaining = new Set(planned);
    const levels: string[][] = [];
    while (remaining.size > 0) {
      const ready = [...remaining].filter((id) => {
        const deps = plannedDependencies.get(id) || new Set<string>();
        return [...deps].every((depId) => !remaining.has(depId));
      });
      if (ready.length === 0) throw new Error('Circular dependency detected between output nodes');
      levels.push(ready);
      for (const id of ready) remaining.delete(id);
    }

    return { plannedOutputNodeIds: [...planned], levels, dependencies };
  }

  function jobStatusPayload(job: DurableGenerationJob, active: boolean): GenerationJobStatus {
    const payload: GenerationJobStatus = {
      active,
      jobId: job.id,
      status: job.status,
      mode: job.mode,
      requestedOutputNodeIds: job.requestedOutputNodeIds,
      plannedOutputNodeIds: job.plannedOutputNodeIds,
      outputs: job.outputs,
      results: job.results,
    };
    if (job.error) payload.error = job.error;
    return payload;
  }

  function outputAssetId(jobId: string, outputNodeId: string, imageId: string): string {
    return [jobId, outputNodeId, imageId].map((part) => encodeURIComponent(part)).join('~');
  }

  function parseOutputAssetId(assetId: string): { jobId: string; outputNodeId: string; imageId: string } {
    const [jobId, outputNodeId, imageId] = assetId.split('~').map((part) => decodeURIComponent(part || ''));
    if (!jobId || !outputNodeId || !imageId) throw new Error('Invalid output asset id.');
    return { jobId, outputNodeId, imageId };
  }

  function outputAssetFromImage(
    job: DurableGenerationJob,
    outputNodeId: string,
    state: OutputNodeGenerationState,
    image: GeneratedImage,
    imageIndex: number,
  ): ImageXOutputAsset {
    return {
      id: outputAssetId(job.id, outputNodeId, image.id),
      name: image.name || `Output ${imageIndex + 1}`,
      type: 'output',
      jobId: job.id,
      outputNodeId,
      imageId: image.id,
      imageIndex,
      url: image.url,
      path: image.path,
      ...(state.prompt ? { prompt: state.prompt } : {}),
      createdAt: job.createdAt,
      updatedAt: state.updatedAt || job.updatedAt,
    };
  }

  async function listProjectOutputAssets(projectId: string): Promise<ImageXOutputAsset[]> {
    const jobs = await readGenerationJobs(projectId);
    const assets: ImageXOutputAsset[] = [];
    for (const job of jobs) {
      for (const [outputNodeId, state] of Object.entries(job.outputs || {})) {
        state.images.forEach((image, index) => {
          if (image?.url && image?.path) assets.push(outputAssetFromImage(job, outputNodeId, state, image, index));
        });
      }
    }
    return assets.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async function updateOutputAsset(
    projectId: string,
    assetId: string,
    updater: (image: GeneratedImage, context: { job: DurableGenerationJob; outputNodeId: string; imageIndex: number }) => GeneratedImage | null,
  ): Promise<{ assets: ImageXOutputAsset[]; previous?: ImageXOutputAsset; deletedUrl?: string }> {
    const locator = parseOutputAssetId(assetId);
    const jobs = await readGenerationJobs(projectId);
    const jobIndex = jobs.findIndex((candidate) => candidate.id === locator.jobId);
    const job = jobs[jobIndex];
    if (!job) throw new Error('Output run not found.');
    const state = job.outputs[locator.outputNodeId];
    if (!state) throw new Error('Output node result not found.');
    const imageIndex = state.images.findIndex((image) => image.id === locator.imageId);
    const image = state.images[imageIndex];
    if (imageIndex < 0 || !image) throw new Error('Output image not found.');

    const previous = outputAssetFromImage(job, locator.outputNodeId, state, image, imageIndex);
    const nextImage = updater(image, { job, outputNodeId: locator.outputNodeId, imageIndex });
    const now = new Date().toISOString();
    state.updatedAt = now;
    job.updatedAt = now;

    if (nextImage) {
      state.images = state.images.map((candidate, index) => (index === imageIndex ? nextImage : candidate));
      job.results = job.results.map((result) =>
        result.outputNodeId === locator.outputNodeId
          ? { ...result, images: result.images.map((candidate) => (candidate.id === locator.imageId ? nextImage : candidate)) }
          : result
      );
    } else {
      state.images = state.images.filter((_, index) => index !== imageIndex);
      job.results = job.results
        .map((result) =>
          result.outputNodeId === locator.outputNodeId
            ? { ...result, images: result.images.filter((candidate) => candidate.id !== locator.imageId) }
            : result
        )
        .filter((result) => result.images.length > 0 || result.outputNodeId !== locator.outputNodeId);
    }

    jobs[jobIndex] = job;
    await writeGenerationJobs(projectId, jobs);
    await writeJsonFile(generationRunJobFile(projectId, job.id), job);
    return {
      assets: await listProjectOutputAssets(projectId),
      previous,
      ...(nextImage ? {} : { deletedUrl: image.url }),
    };
  }

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, name: 'imagex' });
  });

  app.get('/api/auth/status', async (_req, res, next) => {
    try {
      res.json(await getCodexAuthStatus());
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/workflows', async (_req, res, next) => {
    try {
      res.json({ workflows: await listWorkflows() });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/projects', async (_req, res, next) => {
    try {
      res.json({ projects: await listProjects() });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/templates', (_req, res) => {
    res.json({ templates: listTemplates() });
  });

  app.get('/api/projects/:projectId', async (req, res, next) => {
    try {
      res.json({ project: await getProject(req.params.projectId || '') });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/projects', async (req: Request<unknown, unknown, CreateProjectInput>, res, next) => {
    try {
      res.json({ project: await createProject(req.body) });
    } catch (error) {
      next(error);
    }
  });

  app.patch('/api/projects/:projectId', async (req: Request<{ projectId: string }, unknown, { title: string }>, res, next) => {
    try {
      res.json({ project: await renameProject(req.params.projectId, req.body.title || '') });
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/projects/:projectId', async (req, res, next) => {
    try {
      await deleteProject(req.params.projectId || '');
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/projects/:projectId/workflow', async (req: Request<{ projectId: string }, unknown, GenerateWorkflowRequest | unknown>, res, next) => {
    try {
      res.json({ project: await saveProjectWorkflow(req.params.projectId, workflowFromBody(req.body)) });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/projects/:projectId/workflows/:workflowId', async (req, res, next) => {
    try {
      res.json({ project: await loadProjectWorkflow(req.params.projectId || '', req.params.workflowId || '') });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/projects/:projectId/workflows', async (req: Request<{ projectId: string }, unknown, { title?: string }>, res, next) => {
    try {
      res.json({ project: await createProjectWorkflow(req.params.projectId, req.body.title || 'Untitled Workflow') });
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/projects/:projectId/workflows/:workflowId', async (req, res, next) => {
    try {
      res.json({ project: await deleteProjectWorkflow(req.params.projectId || '', req.params.workflowId || '') });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/projects/:projectId/assets', async (req, res, next) => {
    try {
      res.json({ assets: await listProjectAssets(req.params.projectId || '') });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/projects/:projectId/node-assets', async (req, res, next) => {
    try {
      res.json({ assets: await listProjectNodeAssets(req.params.projectId || '') });
    } catch (error) {
      next(error);
    }
  });

  app.post(
    '/api/projects/:projectId/node-assets',
    async (req: Request<{ projectId: string }, unknown, { name: string; rootNodeId: string; nodes: ImageXNode[]; edges: ImageXEdge[] }>, res, next) => {
      try {
        res.json({ assets: await createProjectNodeAsset(req.params.projectId, req.body) });
      } catch (error) {
        next(error);
      }
    }
  );

  app.patch('/api/projects/:projectId/node-assets/:assetId', async (req: Request<{ projectId: string; assetId: string }, unknown, { name?: string }>, res, next) => {
    try {
      res.json({ assets: await renameProjectNodeAsset(req.params.projectId || '', req.params.assetId || '', req.body.name || '') });
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/projects/:projectId/node-assets/:assetId', async (req, res, next) => {
    try {
      res.json({ assets: await deleteProjectNodeAsset(req.params.projectId || '', req.params.assetId || '') });
    } catch (error) {
      next(error);
    }
  });

  app.post(
    '/api/projects/:projectId/assets',
    async (req: Request<{ projectId: string }, unknown, { name: string; mimeType: string; dataBase64: string }>, res, next) => {
      try {
        res.json({ assets: await importProjectAsset(req.params.projectId, req.body) });
      } catch (error) {
        next(error);
      }
    }
  );

  app.patch('/api/projects/:projectId/assets/:assetId', async (req: Request<{ projectId: string; assetId: string }, unknown, { name: string }>, res, next) => {
    try {
      res.json({ assets: await renameProjectAsset(req.params.projectId, req.params.assetId, req.body.name || '') });
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/projects/:projectId/assets/:assetId', async (req, res, next) => {
    try {
      res.json({ assets: await deleteProjectAsset(req.params.projectId || '', req.params.assetId || '') });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/projects/:projectId/output-assets', async (req, res, next) => {
    try {
      res.json({ assets: await listProjectOutputAssets(req.params.projectId || '') });
    } catch (error) {
      next(error);
    }
  });

  app.patch('/api/projects/:projectId/output-assets/:assetId', async (req: Request<{ projectId: string; assetId: string }, unknown, { name?: string }>, res, next) => {
    try {
      const name = (req.body.name || '').trim();
      res.json(await updateOutputAsset(req.params.projectId || '', req.params.assetId || '', (image) => ({
        ...image,
        name: name || image.name || 'Output',
      })));
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/projects/:projectId/output-assets/:assetId', async (req, res, next) => {
    try {
      const projectId = req.params.projectId || '';
      const result = await updateOutputAsset(projectId, req.params.assetId || '', () => null);
      if (result.previous?.path) {
        const outputsRoot = resolve(projectOutputDir(projectId));
        const target = resolve(result.previous.path);
        if (!relative(outputsRoot, target).startsWith('..')) await rm(target, { force: true });
      }
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/projects/:projectId/asset-files/:assetId', async (req, res, next) => {
    try {
      const projectId = req.params.projectId || '';
      const target = resolve(await projectAssetPath(projectId, req.params.assetId || ''));
      const assetsRoot = resolve(projectAssetDir(projectId));
      if (relative(assetsRoot, target).startsWith('..')) {
        res.status(403).end();
        return;
      }
      const file = await readFile(target);
      res.type(extname(target) || 'application/octet-stream').send(file);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/projects/:projectId/generate', async (req: Request<{ projectId: string }, unknown, GenerateWorkflowRunRequest>, res, next) => {
    try {
      const projectId = req.params.projectId;
      if (activeJobs.get(projectId)?.job.status === 'running') {
        res.status(409).json({ error: 'A generation job is already running for this project.' });
        return;
      }

      let workflow = req.body.workflow;
      const mode = req.body.mode || 'selected';
      const requestedOutputNodeIds = req.body.outputNodeIds || [];
      const plan = planOutputRun(workflow, requestedOutputNodeIds, mode);
      if (plan.plannedOutputNodeIds.length === 0) {
        res.status(400).json({ error: 'Select at least one output node to run.' });
        return;
      }

      log('generate', 'starting workflow generation (SSE)', { projectId, mode, planned: plan.plannedOutputNodeIds });
      const bearerToken = await resolveCodexBearerToken();
      const controller = new AbortController();
      const now = new Date().toISOString();
      const job: DurableGenerationJob = {
        id: `gen-${randomUUID().slice(0, 12)}`,
        projectId,
        workflowId: workflow.id,
        mode,
        requestedOutputNodeIds,
        plannedOutputNodeIds: plan.plannedOutputNodeIds,
        status: 'running',
        outputs: {},
        results: [],
        createdAt: now,
        updatedAt: now,
      };

      for (const outputNodeId of plan.plannedOutputNodeIds) {
        const node = workflow.nodes.find((candidate) => candidate.id === outputNodeId);
        if (!node) continue;
        workflow = updateJobOutput(job, workflow, outputNodeId, {
          status: 'queued',
          images: [],
          expectedCount: expectedCountForOutput(node),
        });
      }
      await saveGenerationJob(job);
      await saveProjectWorkflow(projectId, workflow);
      activeJobs.set(projectId, { job, controller });

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      res.write(`data: ${JSON.stringify({ type: 'start', job: jobStatusPayload(job, true) })}\n\n`);

      const results = await executeWorkflowOutputNodes(
        workflow,
        bearerToken,
        projectId,
        plan.levels,
        plan.dependencies,
        job,
        async (nextWorkflow, outputNodeId, image, index) => {
          workflow = nextWorkflow;
          await saveGenerationJob(job);
          await saveProjectWorkflow(projectId, workflow);
          res.write(`data: ${JSON.stringify({ type: 'image', outputNodeId, image, index, job: jobStatusPayload(job, true) })}\n\n`);
        },
        controller.signal
      );

      job.status = 'done';
      job.results = results;
      log('generate', 'workflow generation complete', { projectId, results: results.length });
      await saveGenerationJob(job);
      await saveProjectWorkflow(projectId, workflow);

      res.write(`data: ${JSON.stringify({ type: 'done', results, job: jobStatusPayload(job, false) })}\n\n`);
      res.end();
      activeJobs.delete(projectId);
    } catch (error) {
      const projectId = req.params.projectId;
      const active = activeJobs.get(projectId);
      if (active) {
        active.job.status = active.controller.signal.aborted ? 'cancelled' : 'error';
        if (active.controller.signal.aborted) delete active.job.error;
        else active.job.error = String(error);
        await saveGenerationJob(active.job).catch(() => undefined);
        activeJobs.delete(projectId);
      }
      log('generate', 'workflow generation failed', { projectId, error: String(error) });
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify({ type: 'error', error: String(error) })}\n\n`);
        res.end();
      } else {
        next(error);
      }
    }
  });

  app.post('/api/projects/:projectId/generate/cancel', async (req, res, next) => {
    try {
      const active = activeJobs.get(req.params.projectId);
      if (!active) {
        res.json({ active: false });
        return;
      }
      active.controller.abort();
      active.job.status = 'cancelled';
      let project = await getProject(req.params.projectId);
      let workflow = project.workflow;
      for (const [outputNodeId, state] of Object.entries(active.job.outputs)) {
        if (state.status === 'queued' || state.status === 'running') {
          const nextState: OutputNodeGenerationState = {
            ...state,
            status: state.images.length > 0 ? 'partial' : 'cancelled',
            error: state.images.length > 0 ? 'Cancelled after partial output.' : 'Cancelled.',
            updatedAt: new Date().toISOString(),
          };
          active.job.outputs[outputNodeId] = nextState;
          workflow = patchWorkflowOutputGeneration(workflow, outputNodeId, nextState);
        }
      }
      await saveGenerationJob(active.job);
      await saveProjectWorkflow(req.params.projectId, workflow);
      res.json(jobStatusPayload(active.job, false));
    } catch (error) {
      next(error);
    }
  });

  // Status endpoint for reconnecting after page refresh
  app.get('/api/projects/:projectId/generate-status', async (req, res, next) => {
    try {
      const projectId = req.params.projectId;
      const active = activeJobs.get(projectId);
      if (active) {
        res.json(jobStatusPayload(active.job, active.job.status === 'running'));
        return;
      }

      const latest = latestGenerationJob(await readGenerationJobs(projectId));
      if (!latest) {
        res.json({ active: false });
        return;
      }

      if (latest.status === 'running') {
        latest.status = 'error';
        latest.error = 'The daemon stopped before this generation completed.';
        let project = await getProject(projectId);
        let workflow = project.workflow;
        for (const [outputNodeId, state] of Object.entries(latest.outputs)) {
          const failedState: OutputNodeGenerationState = {
            ...state,
            status: state.images.length > 0 ? 'partial' : 'error',
            error: state.images.length > 0 ? 'Daemon stopped after partial output.' : 'Daemon stopped before output was generated.',
            updatedAt: new Date().toISOString(),
          };
          latest.outputs[outputNodeId] = failedState;
          workflow = patchWorkflowOutputGeneration(workflow, outputNodeId, failedState);
        }
        await saveGenerationJob(latest);
        await saveProjectWorkflow(projectId, workflow);
      }

      res.json(jobStatusPayload(latest, false));
    } catch (error) {
      next(error);
    }
  });

  async function resolveImageReferences(
    projectId: string,
    references?: Array<{ name: string; role: string; notes: string; position: string }>,
    generatedResults?: Map<string, GeneratedImage[]>
  ): Promise<Array<{ name: string; role: string; notes: string; position: string; dataUrl: string }>> {
    if (!references || references.length === 0) return [];

    const assets = await listProjectAssets(projectId);
    const resolved: Array<{ name: string; role: string; notes: string; position: string; dataUrl: string }> = [];

    for (const ref of references) {
      // Handle output node references (__output:nodeId)
      if (ref.name.startsWith('__output:') && generatedResults) {
        const { outputNodeId, imageIndex } = parseOutputImageRef(ref.name);
        const images = generatedResults.get(outputNodeId) || [];
        if (images.length > 0) {
          const img = images[imageIndex] || images[0]!;
          const file = await readFile(img.path);
          const ext = extname(img.path).slice(1) || 'png';
          const mimeType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
          resolved.push({
            name: ref.name,
            role: ref.role,
            notes: ref.notes,
            position: ref.position,
            dataUrl: `data:${mimeType};base64,${file.toString('base64')}`,
          });
        }
        continue;
      }

      // Handle asset URL references (path starts with /api/)
      if (ref.name.startsWith('/api/')) {
        const outputPath = outputPathFromProjectUrl(ref.name);
        if (outputPath) {
          try {
            const file = await readFile(outputPath);
            const ext = extname(outputPath).slice(1) || 'png';
            const mimeType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
            resolved.push({
              name: ref.name,
              role: ref.role,
              notes: ref.notes,
              position: ref.position,
              dataUrl: `data:${mimeType};base64,${file.toString('base64')}`,
            });
          } catch {
            log('resolver', 'failed to read output file', { ref: ref.name, path: outputPath });
          }
          continue;
        }

        // Extract asset ID from URL like /api/projects/xxx/asset-files/asset-id
        const parts = ref.name.split('/');
        const assetId = parts[parts.length - 1] || '';
        const assetPath = await projectAssetPath(projectId, assetId);
        try {
          const file = await readFile(assetPath);
          const ext = extname(assetPath).slice(1) || 'png';
          const mimeType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
          resolved.push({
            name: ref.name,
            role: ref.role,
            notes: ref.notes,
            position: ref.position,
            dataUrl: `data:${mimeType};base64,${file.toString('base64')}`,
          });
        } catch {
          log('resolver', 'failed to read asset file', { assetId, path: assetPath });
        }
        continue;
      }

      // Handle asset name references
      const asset = assets.find((a) => a.name === ref.name || a.file === ref.name);
      if (!asset) continue;

      const assetPath = await projectAssetPath(projectId, asset.id);
      const file = await readFile(assetPath);
      const ext = extname(assetPath).slice(1) || 'png';
      const mimeType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
      const base64 = file.toString('base64');
      resolved.push({
        name: ref.name,
        role: ref.role,
        notes: ref.notes,
        position: ref.position,
        dataUrl: `data:${mimeType};base64,${base64}`,
      });
    }

    return resolved;
  }

  /**
   * Apply image editing transforms to resolved references using photon-node.
   * Traces the workflow graph to find editing nodes between image sources and the output node,
   * then processes each node's step sequentially to mirror the frontend WebGL operations.
   */
  async function applyImageEdits(
    references: Array<{ name: string; role: string; notes: string; position: string; dataUrl: string }>,
    workflow: ImageXWorkflow,
    outputNodeId: string
  ): Promise<Array<{ name: string; role: string; notes: string; position: string; dataUrl: string }>> {
    const nodesById = new Map(workflow.nodes.map((n) => [n.id, n]));
    const result: Array<{ name: string; role: string; notes: string; position: string; dataUrl: string }> = [];

    for (const ref of references) {
      const editingNodes = findEditingNodesForRef(ref.name, workflow, outputNodeId, nodesById);

      if (editingNodes.length === 0) {
        result.push(ref);
        continue;
      }

      // Load image into photon
      const b64Data = ref.dataUrl.split(',')[1] || '';
      let img = photon.PhotonImage.new_from_base64(b64Data);

      // Process node-by-node using the same operation semantics as the frontend WebGL path.
      for (const editNode of editingNodes) {
        img = applyNodeStep(img, editNode);
      }

      // Export back to base64
      const outputBase64 = img.get_base64();
      const outputData = outputBase64.replace(/^data:image\/\w+;base64,/, '');
      img.free();

      const dataUrl = `data:image/png;base64,${outputData}`;
      result.push({ ...ref, dataUrl });
    }

    return result;
  }

  /**
   * Apply a single editing node's operation to a PhotonImage at full resolution.
   */
  function applyNodeStep(img: InstanceType<typeof photon.PhotonImage>, node: ImageXNode): InstanceType<typeof photon.PhotonImage> {
    switch (node.type) {
      case 'rotate-flip': {
        const angle = ((Number(node.data.rotate) || 0) % 360 + 360) % 360;
        const doFlipH = Boolean(node.data.flipH);
        const doFlipV = Boolean(node.data.flipV);
        if (angle !== 0) {
          const rotated = photon.rotate(img, angle);
          img.free();
          img = rotated;
        }
        if (doFlipH) photon.fliph(img);
        if (doFlipV) photon.flipv(img);
        return img;
      }

      case 'blur': {
        const radius = Number(node.data.radius) || 0;
        if (radius > 0) photon.gaussian_blur(img, radius);
        return img;
      }

      case 'color-balance': {
        const r = Number(node.data.red) || 0;
        const g = Number(node.data.green) || 0;
        const b = Number(node.data.blue) || 0;
        if (r !== 0 || g !== 0 || b !== 0) {
          photon.alter_channels(img, r, g, b);
        }
        return img;
      }

      case 'crop': {
        const x = Math.round(Number(node.data.x) || 0);
        const y = Math.round(Number(node.data.y) || 0);
        const w = Math.round(Number(node.data.cropWidth) || 0);
        const h = Math.round(Number(node.data.cropHeight) || 0);
        if (w <= 0 || h <= 0) return img;
        const imgW = img.get_width();
        const imgH = img.get_height();
        if (x === 0 && y === 0 && w >= imgW && h >= imgH) return img;
        const x2 = Math.min(x + w, imgW);
        const y2 = Math.min(y + h, imgH);
        if (x2 <= x || y2 <= y) return img;
        const cropped = photon.crop(img, Math.max(0, x), Math.max(0, y), x2, y2);
        img.free();
        return cropped;
      }

      default:
        return img;
    }
  }

  /**
   * Find editing nodes in the path between an image source and the output node.
   */
  function findEditingNodesForRef(
    refName: string,
    workflow: ImageXWorkflow,
    outputNodeId: string,
    nodesById: Map<string, ImageXNode>
  ): ImageXNode[] {
    const editingTypes = new Set(['rotate-flip', 'color-balance', 'crop', 'blur']);
    const editingNodes: ImageXNode[] = [];

    function traceBack(nodeId: string, visited: Set<string>): boolean {
      if (visited.has(nodeId)) return false;
      visited.add(nodeId);

      const node = nodesById.get(nodeId);
      if (!node) return false;

      if (node.type === 'image') {
        const assetUrl = typeof node.data.assetUrl === 'string' ? node.data.assetUrl : '';
        const assetName = typeof node.data.assetName === 'string' ? node.data.assetName : '';
        if (refName === assetUrl || refName === assetName || refName === node.id) {
          return true;
        }
      }

      if (node.type === 'codex-output' && refName.startsWith('__output:')) {
        const { outputNodeId } = parseOutputImageRef(refName);
        if (outputNodeId === node.id) return true;
      }

      for (const edge of workflow.edges) {
        if (edge.target !== nodeId) continue;
        const found = traceBack(edge.source, visited);
        if (found) {
          if (editingTypes.has(node.type)) {
            editingNodes.push(node);
          }
          return true;
        }
      }

      return false;
    }

    traceBack(outputNodeId, new Set());
    return editingNodes;
  }

  app.post('/api/projects/:projectId/compile', async (req: Request<{ projectId: string }, unknown, GenerateWorkflowRequest & { outputNodeId?: string }>, res, next) => {
    try {
      await getProject(req.params.projectId);
      const { workflow, outputNodeId } = req.body;
      const compiled = outputNodeId
        ? compileOutputNodeWorkflow(workflow, outputNodeId)
        : compileWorkflow(workflow);
      if (!compiled) {
        res.status(400).json({ error: 'Output node not found or invalid' });
        return;
      }
      res.json({ prompt: compiled.prompt, options: compiled.options });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/workflows', async (req, res, next) => {
    try {
      res.json({ workflow: await saveWorkflow(req.body) });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/generate', async (req: Request<unknown, unknown, GenerateWorkflowRequest>, res, next) => {
    try {
      log('generate', 'starting non-project workflow generation');
      const bearerToken = await resolveCodexBearerToken();
      const results = await executeWorkflowOutputNodes(req.body.workflow, bearerToken);
      log('generate', 'non-project workflow generation complete', { results: results.length });
      await saveWorkflow(req.body.workflow);
      res.json({ results });
    } catch (error) {
      log('generate', 'non-project workflow generation failed', { error: String(error) });
      next(error);
    }
  });

  app.post('/api/compile', async (req: Request<unknown, unknown, GenerateWorkflowRequest & { outputNodeId?: string }>, res, next) => {
    try {
      const { workflow, outputNodeId } = req.body;
      const compiled = outputNodeId
        ? compileOutputNodeWorkflow(workflow, outputNodeId)
        : compileWorkflow(workflow);
      if (!compiled) {
        res.status(400).json({ error: 'Output node not found or invalid' });
        return;
      }
      res.json({ prompt: compiled.prompt, options: compiled.options });
    } catch (error) {
      next(error);
    }
  });

  app.get('/outputs/:workflow/:file', async (req, res, next) => {
    try {
      const workflow = decodeURIComponent(req.params.workflow || '');
      const file = decodeURIComponent(req.params.file || '');
      const outputsRoot = resolve(imagexPaths().outputsDir);
      const target = resolve(outputsRoot, workflow, file);
      if (relative(outputsRoot, target).startsWith('..')) {
        res.status(403).end();
        return;
      }
      await access(target);
      res.sendFile(target);
    } catch (error) {
      next(error);
    }
  });

  app.get(/^\/api\/projects\/([^/]+)\/outputs\/(.+)$/, async (req, res, next) => {
    let projectId = '';
    let file = '';
    try {
      projectId = decodeURIComponent(String(req.params[0] || ''));
      file = decodeURIComponent(String(req.params[1] || ''));
      const outputsRoot = resolve(projectOutputDir(projectId));
      const target = resolve(outputsRoot, file);
      log('outputs', 'serving file', { projectId, file, target, outputsRoot });
      if (relative(outputsRoot, target).startsWith('..')) {
        res.status(403).end();
        return;
      }
      const buffer = await readFile(target);
      const ext = extname(target).slice(1) || 'png';
      const mimeType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
      res.type(mimeType).send(buffer);
    } catch (error) {
      log('outputs', 'failed to serve file', { projectId, file, error: String(error) });
      next(error);
    }
  });

  app.get('/api/projects/:projectId/assets/:file', async (req, res, next) => {
    try {
      const projectId = decodeURIComponent(req.params.projectId || '');
      const file = decodeURIComponent(req.params.file || '');
      const assetsRoot = resolve(projectAssetDir(projectId));
      const target = resolve(assetsRoot, file);
      if (relative(assetsRoot, target).startsWith('..') || file === 'assets.json') {
        res.status(403).end();
        return;
      }
      const buffer = await readFile(target);
      const ext = extname(target).slice(1) || 'png';
      const mimeType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
      res.type(mimeType).send(buffer);
    } catch (error) {
      next(error);
    }
  });

  serveWebApp(app);
  app.use(errorHandler);

  async function executeWorkflowOutputNodes(
    workflow: ImageXWorkflow,
    bearerToken: string,
    projectId?: string,
    plannedLevels?: string[][],
    dependenciesOverride?: Map<string, Set<string>>,
    job?: DurableGenerationJob,
    onImage?: (workflow: ImageXWorkflow, outputNodeId: string, image: GeneratedImage, index: number) => Promise<void> | void,
    signal?: AbortSignal
  ): Promise<OutputNodeResult[]> {
    const outputNodes = workflow.nodes.filter((n) => n.type === 'codex-output');
    if (outputNodes.length === 0) {
      log('executor', 'no output nodes found');
      return [];
    }

    log('executor', 'discovered output nodes', { count: outputNodes.length, ids: outputNodes.map((n) => n.id) });

    const dependencies = dependenciesOverride || outputDependencies(workflow);
    const levels = plannedLevels || planOutputRun(workflow, outputNodes.map((node) => node.id), 'all').levels;
    log('executor', 'execution levels', { levels });

    const results = new Map<string, GeneratedImage[]>();
    for (const node of outputNodes) {
      const stored = storedImagesForOutput(node);
      if (stored.length > 0) results.set(node.id, stored);
    }
    const outputResults: OutputNodeResult[] = [];

    async function runOutputNode(outputNodeId: string): Promise<OutputNodeResult | null> {
      if (signal?.aborted) throw new Error('Generation cancelled');
      log('executor', 'compiling output node', { outputNodeId });
      const compiled = compileOutputNodeWorkflow(workflow, outputNodeId);
      if (!compiled) {
        log('executor', 'compilation returned null, skipping', { outputNodeId });
        return null;
      }

      const { prompt, options } = compiled;
      const outputNode = workflow.nodes.find((node) => node.id === outputNodeId);
      if (job && outputNode) {
        workflow = updateJobOutput(job, workflow, outputNodeId, {
          status: 'running',
          prompt,
          expectedCount: expectedCountForOutput(outputNode),
        });
      }
      log('executor', 'compiled output node', { outputNodeId, refs: options.references?.length || 0 });

      // Resolve static image references (assets) and output node references
      const upstreamIds = dependencies.get(outputNodeId) || new Set();
      if (projectId) {
        const resolved = await resolveImageReferences(projectId, options.references, results);
        // Apply image editing transforms (rotate/flip/color-balance) to resolved references
        const transformed = await applyImageEdits(resolved, workflow, outputNodeId);
        options.references = transformed;
        log('executor', 'resolved image references', { outputNodeId, resolved: resolved.length });
      }

      log('executor', 'generating images', { outputNodeId, count: options.count, upstreamOutputs: upstreamIds.size });
      const images = await generateCodexImages(
        options,
        bearerToken,
        projectId
          ? {
              outputDir: job
                ? generationOutputDir(projectId, job.id, outputNodeId)
                : projectOutputDir(projectId),
              urlBase: job
                ? generationOutputUrlBase(projectId, job.id, outputNodeId)
                : `/api/projects/${encodeURIComponent(projectId)}/outputs`,
            }
          : undefined,
        [],
        async (image, index) => {
          if (job) {
            const previous = job.outputs[outputNodeId];
            const nextImages = [...(previous?.images || [])];
            nextImages[index] = image;
            workflow = updateJobOutput(job, workflow, outputNodeId, {
              status: 'running',
              images: nextImages.filter(Boolean),
              prompt,
              expectedCount: options.count,
            });
          }
          await onImage?.(workflow, outputNodeId, image, index);
        },
        signal
      );
      log('executor', 'images generated', { outputNodeId, count: images.length, urls: images.map((i) => i.url) });

      results.set(outputNodeId, images);
      if (job) {
        const donePatch: Partial<OutputNodeGenerationState> = {
          status: images.length >= options.count ? 'done' : 'partial',
          images,
          prompt,
          expectedCount: options.count,
        };
        if (images.length < options.count) donePatch.error = 'Generation returned fewer images than requested.';
        workflow = updateJobOutput(job, workflow, outputNodeId, {
          ...donePatch,
        });
      }
      return { outputNodeId, prompt, images, status: images.length >= options.count ? 'done' : 'partial' };
    }

    for (const level of levels) {
      if (signal?.aborted) throw new Error('Generation cancelled');
      const settled = await Promise.allSettled(level.map((outputNodeId) => runOutputNode(outputNodeId)));
      const errors: string[] = [];
      for (let index = 0; index < settled.length; index += 1) {
        const outcome = settled[index]!;
        const outputNodeId = level[index]!;
        if (outcome.status === 'fulfilled') {
          if (outcome.value) outputResults.push(outcome.value);
          continue;
        }
        const message = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        errors.push(message);
        if (job) {
          const previous = job.outputs[outputNodeId];
          workflow = updateJobOutput(job, workflow, outputNodeId, {
            status: previous?.images.length ? 'partial' : signal?.aborted ? 'cancelled' : 'error',
            error: signal?.aborted ? 'Cancelled.' : message,
          });
        }
      }
      if (errors.length > 0) throw new Error(errors[0]);
    }

    return outputResults;
  }

  const server = createServer(app);
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(options.port, options.host, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });

  return server;
}

function serveWebApp(app: express.Express): void {
  const webRoot = findBuiltWebRoot();
  if (!webRoot) {
    app.get('/', (_req, res) => {
      res.status(503).send('imagex web UI is not built yet. Run `npm run build`, then start `imagex ui` again.');
    });
    return;
  }

  app.use(express.static(webRoot));
  app.get('*splat', (_req, res) => {
    res.sendFile(join(webRoot, 'index.html'));
  });
}

function findBuiltWebRoot(): string | null {
  const currentFile = fileURLToPath(import.meta.url);
  const candidates = [
    join(dirname(currentFile), '..', 'web'),
    join(process.cwd(), 'dist', 'web'),
  ];
  return candidates.find((candidate) => existsSync(join(candidate, 'index.html'))) || null;
}

function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const message = error instanceof Error ? error.message : String(error);
  res.status(500).json({ error: message });
}

function workflowFromBody(body: unknown): GenerateWorkflowRequest['workflow'] {
  if (body && typeof body === 'object' && 'workflow' in body) {
    return (body as GenerateWorkflowRequest).workflow;
  }
  return body as GenerateWorkflowRequest['workflow'];
}

function parseOutputImageRef(refName: string): { outputNodeId: string; imageIndex: number } {
  const value = refName.startsWith('__output:') ? refName.slice('__output:'.length) : refName;
  const separator = value.lastIndexOf(':');
  if (separator <= 0) return { outputNodeId: value, imageIndex: 0 };

  const possibleIndex = Number(value.slice(separator + 1));
  if (!Number.isInteger(possibleIndex) || possibleIndex < 0) {
    return { outputNodeId: value, imageIndex: 0 };
  }
  return { outputNodeId: value.slice(0, separator), imageIndex: possibleIndex };
}
