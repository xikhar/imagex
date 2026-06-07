import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { readJsonFile, writeJsonFile } from '../config/jsonStore.js';
import { imagexPaths } from '../config/paths.js';
import type {
  ImageXProject,
  ImageXAsset,
  ImageXProjectMetadata,
  ImageXProjectSummary,
  ImageXTemplateSummary,
  ImageXWorkflow,
  ImageXNode,
  ImageXEdge,
  ImageXNodeAsset,
} from '../shared/types.js';
import { createDefaultWorkflow, createEmptyWorkflow } from '../workflows/defaults.js';

const metadataFile = 'imagex.project.json';
const workflowFile = 'workflow.imagex.json';
const assetsManifestFile = 'assets.json';
const nodeAssetsManifestFile = 'node-assets.json';

export type CreateProjectInput = {
  title: string;
  description?: string;
  templateId?: string;
};

export async function listProjects(): Promise<ImageXProjectSummary[]> {
  const root = imagexPaths().projectsDir;
  await mkdir(root, { recursive: true });
  const entries = await readdir(root, { withFileTypes: true });
  const projects = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => readProjectSummary(entry.name).catch(() => null))
  );
  return projects
    .filter((project): project is ImageXProjectSummary => Boolean(project))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function getProject(id: string): Promise<ImageXProject> {
  const dir = projectDir(id);
  let metadata = await readJsonFile<ImageXProjectMetadata>(join(dir, metadataFile));
  assertProjectMetadata(metadata);
  const activeWorkflowFile = metadata.workflows?.[0]?.file || metadata.workflowFile;
  const rawWorkflow = await readJsonFile<Partial<ImageXWorkflow>>(join(dir, activeWorkflowFile));
  const workflow = normalizeWorkflow(rawWorkflow, metadata);
  if (!metadata.workflows?.length || metadata.workflows[0]?.id === 'default') {
    metadata = {
      ...metadata,
      workflows: [{ id: workflow.id, title: workflow.name, file: activeWorkflowFile }],
    };
    await writeJsonFile(join(dir, metadataFile), metadata);
  }
  return { metadata, workflow };
}

export async function createProject(input: CreateProjectInput): Promise<ImageXProject> {
  const now = new Date().toISOString();
  const title = input.title.trim() || 'Untitled Project';
  const id = `${slugify(title)}-${randomUUID().slice(0, 8)}`;
  const dir = projectDir(id);
  const workflow = workflowForTemplate(input.templateId, title);
  const metadata: ImageXProjectMetadata = {
    app: 'imagex',
    schemaVersion: 1,
    id,
    title,
    createdAt: now,
    updatedAt: now,
    workflowFile,
    workflows: [{ id: workflow.id, title: workflow.name, file: workflowFile }],
    assetsDir: 'assets',
    outputsDir: 'outputs',
  };
  if (input.description?.trim()) metadata.description = input.description.trim();

  await mkdir(join(dir, metadata.assetsDir), { recursive: true });
  await mkdir(join(dir, metadata.outputsDir), { recursive: true });
  await writeJsonFile(join(dir, metadataFile), metadata);
  await writeJsonFile(join(dir, metadata.workflowFile), workflow);
  return { metadata, workflow };
}

export async function renameProject(projectId: string, title: string): Promise<ImageXProject> {
  const project = await getProject(projectId);
  const updatedAt = new Date().toISOString();
  const metadata: ImageXProjectMetadata = {
    ...project.metadata,
    title: title.trim() || project.metadata.title,
    updatedAt,
  };
  await writeJsonFile(join(projectDir(projectId), metadataFile), metadata);
  return { metadata, workflow: project.workflow };
}

export async function deleteProject(projectId: string): Promise<void> {
  await rm(projectDir(projectId), { recursive: true, force: true });
}

export async function saveProjectWorkflow(id: string, workflow: ImageXWorkflow): Promise<ImageXProject> {
  const project = await getProject(id);
  const normalized = normalizeWorkflow(workflow, project.metadata);
  const workflowEntry = workflowEntryFor(project.metadata, normalized);
  const updatedWorkflow: ImageXWorkflow = {
    ...normalized,
    updatedAt: new Date().toISOString(),
  };
  const updatedMetadata: ImageXProjectMetadata = {
    ...project.metadata,
    title: updatedWorkflow.name || project.metadata.title,
    updatedAt: updatedWorkflow.updatedAt,
    workflows: upsertWorkflowEntry(project.metadata, workflowEntry, updatedWorkflow.name),
  };
  const dir = projectDir(id);
  await writeJsonFile(join(dir, workflowEntry.file), updatedWorkflow);
  await writeJsonFile(join(dir, metadataFile), updatedMetadata);
  return { metadata: updatedMetadata, workflow: updatedWorkflow };
}

export async function createProjectWorkflow(projectId: string, title = 'Untitled Workflow'): Promise<ImageXProject> {
  const project = await getProject(projectId);
  const workflow = createEmptyWorkflow(title);
  const file = `workflow-${workflow.id}.imagex.json`;
  const metadata: ImageXProjectMetadata = {
    ...project.metadata,
    updatedAt: new Date().toISOString(),
    workflows: [...workflowEntries(project.metadata), { id: workflow.id, title: workflow.name, file }],
  };
  const dir = projectDir(projectId);
  await writeJsonFile(join(dir, file), workflow);
  await writeJsonFile(join(dir, metadataFile), metadata);
  return { metadata, workflow };
}

export async function loadProjectWorkflow(projectId: string, workflowId: string): Promise<ImageXProject> {
  const project = await getProject(projectId);
  const entry = workflowEntries(project.metadata).find((candidate) => candidate.id === workflowId);
  if (!entry) throw new Error('Workflow not found.');
  const rawWorkflow = await readJsonFile<Partial<ImageXWorkflow>>(join(projectDir(projectId), entry.file));
  return { metadata: project.metadata, workflow: normalizeWorkflow(rawWorkflow, project.metadata) };
}

export async function deleteProjectWorkflow(projectId: string, workflowId: string): Promise<ImageXProject> {
  const project = await getProject(projectId);
  const entries = workflowEntries(project.metadata);
  if (entries.length <= 1) throw new Error('Cannot delete the only workflow in a project.');
  const nextEntries = entries.filter((entry) => entry.id !== workflowId);
  const metadata = { ...project.metadata, workflows: nextEntries, updatedAt: new Date().toISOString() };
  await writeJsonFile(join(projectDir(projectId), metadataFile), metadata);
  return loadProjectWorkflow(projectId, nextEntries[0]!.id);
}

export async function listProjectAssets(projectId: string): Promise<ImageXAsset[]> {
  const project = await getProject(projectId);
  return readAssetsManifest(project.metadata);
}

export async function listProjectNodeAssets(projectId: string): Promise<ImageXNodeAsset[]> {
  const project = await getProject(projectId);
  return readNodeAssetsManifest(project.metadata);
}

export async function createProjectNodeAsset(
  projectId: string,
  input: { name: string; rootNodeId: string; nodes: ImageXNode[]; edges: ImageXEdge[] }
): Promise<ImageXNodeAsset[]> {
  const project = await getProject(projectId);
  const assets = await readNodeAssetsManifest(project.metadata);
  const projectAssets = await readAssetsManifest(project.metadata);
  const sanitized = sanitizeNodeAssetPayload(input, new Set(projectAssets.map((asset) => asset.id)));
  const root = sanitized.nodes.find((node) => node.id === sanitized.rootNodeId) || sanitized.nodes[0];
  if (!root) throw new Error('Node asset requires at least one node.');
  const now = new Date().toISOString();
  const asset: ImageXNodeAsset = {
    id: `node-asset-${randomUUID().slice(0, 10)}`,
    name: input.name.trim() || root.type,
    type: 'node',
    schemaVersion: 1,
    nodeType: root.type,
    rootNodeId: root.id,
    nodes: sanitized.nodes,
    edges: sanitized.edges,
    createdAt: now,
    updatedAt: now,
  };
  const nextAssets = [...assets, asset];
  await writeNodeAssetsManifest(project.metadata, nextAssets);
  return nextAssets;
}

export async function renameProjectNodeAsset(projectId: string, assetId: string, name: string): Promise<ImageXNodeAsset[]> {
  const project = await getProject(projectId);
  const assets = await readNodeAssetsManifest(project.metadata);
  const now = new Date().toISOString();
  const nextAssets = assets.map((asset) =>
    asset.id === assetId ? { ...asset, name: name.trim() || asset.name, updatedAt: now } : asset
  );
  await writeNodeAssetsManifest(project.metadata, nextAssets);
  return nextAssets;
}

export async function deleteProjectNodeAsset(projectId: string, assetId: string): Promise<ImageXNodeAsset[]> {
  const project = await getProject(projectId);
  const assets = await readNodeAssetsManifest(project.metadata);
  const nextAssets = assets.filter((asset) => asset.id !== assetId);
  await writeNodeAssetsManifest(project.metadata, nextAssets);
  return nextAssets;
}

export async function importProjectAsset(
  projectId: string,
  input: { name: string; mimeType: string; dataBase64: string }
): Promise<ImageXAsset[]> {
  const project = await getProject(projectId);
  const assets = await readAssetsManifest(project.metadata);
  const now = new Date().toISOString();
  const id = `asset-${randomUUID().slice(0, 10)}`;
  const extension = extensionForMime(input.mimeType) || extname(input.name).slice(1) || 'png';
  const safeName = slugify(input.name.replace(/\.[^.]+$/, '') || 'image');
  const file = `${id}-${safeName}.${extension}`;
  const asset: ImageXAsset = {
    id,
    name: input.name.trim() || file,
    type: 'image',
    file,
    url: assetUrl(projectId, id),
    createdAt: now,
    updatedAt: now,
  };
  await mkdir(join(projectDir(projectId), project.metadata.assetsDir), { recursive: true });
  await writeFile(join(projectDir(projectId), project.metadata.assetsDir, file), Buffer.from(input.dataBase64, 'base64'));
  await writeAssetsManifest(project.metadata, [...assets, asset]);
  return [...assets, asset];
}

export async function renameProjectAsset(projectId: string, assetId: string, name: string): Promise<ImageXAsset[]> {
  const project = await getProject(projectId);
  const assets = await readAssetsManifest(project.metadata);
  const now = new Date().toISOString();
  const nextAssets = assets.map((asset) =>
    asset.id === assetId ? { ...asset, name: name.trim() || asset.name, updatedAt: now } : asset
  );
  await writeAssetsManifest(project.metadata, nextAssets);
  return nextAssets;
}

export async function deleteProjectAsset(projectId: string, assetId: string): Promise<ImageXAsset[]> {
  const project = await getProject(projectId);
  const assets = await readAssetsManifest(project.metadata);
  const asset = assets.find((candidate) => candidate.id === assetId);
  const nextAssets = assets.filter((candidate) => candidate.id !== assetId);
  if (asset) await rm(join(projectDir(projectId), project.metadata.assetsDir, asset.file), { force: true });
  await writeAssetsManifest(project.metadata, nextAssets);
  return nextAssets;
}

export function projectAssetDir(projectId: string): string {
  return join(projectDir(projectId), 'assets');
}

export async function projectAssetPath(projectId: string, assetId: string): Promise<string> {
  const project = await getProject(projectId);
  const asset = (await readAssetsManifest(project.metadata)).find((candidate) => candidate.id === assetId);
  if (!asset) throw new Error('Asset not found.');
  return join(projectDir(projectId), project.metadata.assetsDir, asset.file);
}

function normalizeWorkflow(workflow: Partial<ImageXWorkflow> | undefined, metadata: ImageXProjectMetadata): ImageXWorkflow {
  const fallback = createEmptyWorkflow(metadata.title);
  return {
    ...fallback,
    ...workflow,
    id: typeof workflow?.id === 'string' ? workflow.id : fallback.id,
    version: '0.1',
    name: typeof workflow?.name === 'string' && workflow.name.trim() ? workflow.name : metadata.title,
    createdAt: typeof workflow?.createdAt === 'string' ? workflow.createdAt : metadata.createdAt,
    updatedAt: typeof workflow?.updatedAt === 'string' ? workflow.updatedAt : metadata.updatedAt,
    settings: workflow?.settings?.provider ? workflow.settings : fallback.settings,
    nodes: Array.isArray(workflow?.nodes) ? workflow.nodes : [],
    edges: Array.isArray(workflow?.edges) ? workflow.edges : [],
  };
}

export function listTemplates(): ImageXTemplateSummary[] {
  return [
    {
      id: 'scratch',
      title: 'Blank Project',
      description: 'Start with an empty canvas.',
    },
    {
      id: 'starter',
      title: 'Starter Workflow',
      description: 'Text, style, scene, and output nodes wired together.',
    },
  ];
}

export function projectOutputDir(projectId: string): string {
  return join(projectDir(projectId), 'outputs');
}

function workflowForTemplate(templateId: string | undefined, title: string): ImageXWorkflow {
  const workflow = templateId === 'starter' ? createDefaultWorkflow() : createEmptyWorkflow(title);
  return {
    ...workflow,
    name: title,
  };
}

const NODE_TYPES = new Set(['prompt', 'image', 'color', 'file', 'codex-output', 'color-balance', 'rotate-flip', 'crop', 'blur', 'download', 'frame']);

function sanitizeNodeAssetPayload(
  input: { rootNodeId: string; nodes: ImageXNode[]; edges: ImageXEdge[] },
  validAssetIds: Set<string>,
): { rootNodeId: string; nodes: ImageXNode[]; edges: ImageXEdge[] } {
  const rawNodes = Array.isArray(input.nodes) ? input.nodes : [];
  const seen = new Set<string>();
  const nodes = rawNodes
    .filter((node) => node && typeof node.id === 'string' && NODE_TYPES.has(node.type) && !seen.has(node.id) && (seen.add(node.id), true))
    .map((node) => sanitizeNodeAssetNode(node, validAssetIds));

  const firstNonFrame = nodes.find((node) => node.type !== 'frame');
  if (!firstNonFrame) throw new Error('Node asset requires at least one non-frame node.');
  const rootNodeId = nodes.some((node) => node.id === input.rootNodeId && node.type !== 'frame') ? input.rootNodeId : firstNonFrame.id;
  const edges = sanitizeNodeAssetEdges(Array.isArray(input.edges) ? input.edges : [], nodes);
  return { rootNodeId, nodes, edges };
}

function sanitizeNodeAssetNode(node: ImageXNode, validAssetIds?: Set<string>): ImageXNode {
  const data = { ...node.data };
  delete data.isDropTargetFrame;
  if (node.type === 'codex-output') {
    delete data.previewUrl;
    delete data.previewUrls;
    delete data.previewIndex;
    delete data.generating;
    delete data.generation;
  }

  const assetId = typeof data.assetId === 'string' ? data.assetId : '';
  const assetUrl = typeof data.assetUrl === 'string' ? data.assetUrl : '';
  const shouldDropAsset =
    assetUrl.includes('/outputs/runs/') ||
    (validAssetIds && assetId && !validAssetIds.has(assetId));
  if (shouldDropAsset) {
    delete data.assetId;
    delete data.assetUrl;
    delete data.assetName;
    for (const [key, value] of Object.entries(data)) {
      if (value === assetUrl) data[key] = '';
    }
  }

  const next: ImageXNode = {
    id: node.id,
    type: node.type,
    position: {
      x: Number.isFinite(node.position?.x) ? node.position.x : 0,
      y: Number.isFinite(node.position?.y) ? node.position.y : 0,
    },
    data,
  };
  return next;
}

function sanitizeNodeAssetEdges(edges: ImageXEdge[], nodes: ImageXNode[]): ImageXEdge[] {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const seen = new Set<string>();
  return edges
    .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target) && edge.source !== edge.target)
    .map((edge) => {
      const next: ImageXEdge = {
        id: edge.id || `${edge.source}-${edge.sourceHandle || 'out'}-${edge.target}-${edge.targetHandle || 'in'}`,
        source: edge.source,
        target: edge.target,
      };
      if (edge.sourceHandle) next.sourceHandle = edge.sourceHandle;
      if (edge.targetHandle) next.targetHandle = edge.targetHandle;
      return next;
    })
    .filter((edge) => {
      const key = `${edge.source}:${edge.sourceHandle || ''}->${edge.target}:${edge.targetHandle || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function readAssetsManifest(metadata: ImageXProjectMetadata): Promise<ImageXAsset[]> {
  const manifestPath = join(projectDir(metadata.id), metadata.assetsDir, assetsManifestFile);
  const assets = await readJsonFile<ImageXAsset[]>(manifestPath, []);
  return Array.isArray(assets)
    ? assets.map((asset) => ({
        ...asset,
        url: assetUrl(metadata.id, asset.id),
      }))
    : [];
}

async function readNodeAssetsManifest(metadata: ImageXProjectMetadata): Promise<ImageXNodeAsset[]> {
  const manifestPath = join(projectDir(metadata.id), metadata.assetsDir, nodeAssetsManifestFile);
  const assets = await readJsonFile<ImageXNodeAsset[]>(manifestPath, []);
  return Array.isArray(assets)
    ? assets
        .map((asset) => {
          const nodes = Array.isArray(asset.nodes) ? asset.nodes.map((node) => sanitizeNodeAssetNode(node)) : [];
          return {
            ...asset,
            schemaVersion: 1 as const,
            nodes,
            edges: Array.isArray(asset.edges) ? sanitizeNodeAssetEdges(asset.edges, nodes) : [],
          };
        })
        .filter((asset) => asset.nodes.length > 0)
    : [];
}

function assetUrl(projectId: string, assetId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/asset-files/${encodeURIComponent(assetId)}`;
}

async function writeAssetsManifest(metadata: ImageXProjectMetadata, assets: ImageXAsset[]): Promise<void> {
  await mkdir(join(projectDir(metadata.id), metadata.assetsDir), { recursive: true });
  await writeJsonFile(join(projectDir(metadata.id), metadata.assetsDir, assetsManifestFile), assets);
}

async function writeNodeAssetsManifest(metadata: ImageXProjectMetadata, assets: ImageXNodeAsset[]): Promise<void> {
  await mkdir(join(projectDir(metadata.id), metadata.assetsDir), { recursive: true });
  await writeJsonFile(join(projectDir(metadata.id), metadata.assetsDir, nodeAssetsManifestFile), assets);
}

function extensionForMime(mimeType: string): string | null {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  if (mimeType === 'image/gif') return 'gif';
  return null;
}

function workflowEntries(metadata: ImageXProjectMetadata): Array<{ id: string; title: string; file: string }> {
  return metadata.workflows?.length
    ? metadata.workflows
    : [{ id: 'default', title: metadata.title, file: metadata.workflowFile }];
}

function workflowEntryFor(metadata: ImageXProjectMetadata, workflow: ImageXWorkflow): { id: string; title: string; file: string } {
  const entries = workflowEntries(metadata);
  const existing = entries.find((entry) => entry.id === workflow.id);
  const legacyOnly = entries.length === 1 && entries[0]?.file === metadata.workflowFile;
  return existing
    ? existing
    : { id: workflow.id, title: workflow.name, file: legacyOnly ? metadata.workflowFile : `workflow-${workflow.id}.imagex.json` };
}

function upsertWorkflowEntry(
  metadata: ImageXProjectMetadata,
  entry: { id: string; title: string; file: string },
  title: string
): Array<{ id: string; title: string; file: string }> {
  const entries = workflowEntries(metadata);
  const next = { ...entry, title };
  return entries.some((candidate) => candidate.id === entry.id)
    ? entries.map((candidate) => (candidate.id === entry.id ? next : candidate))
    : [...entries, next];
}

async function readProjectSummary(id: string): Promise<ImageXProjectSummary> {
  const dir = projectDir(id);
  const metadata = await readJsonFile<ImageXProjectMetadata>(join(dir, metadataFile));
  assertProjectMetadata(metadata);
  const summary: ImageXProjectSummary = {
    id: metadata.id,
    title: metadata.title,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    path: dir,
  };
  if (metadata.description) summary.description = metadata.description;
  return summary;
}

function assertProjectMetadata(metadata: ImageXProjectMetadata): void {
  if (metadata.app !== 'imagex' || metadata.schemaVersion !== 1 || !metadata.id || !metadata.workflowFile) {
    throw new Error('Invalid imagex project metadata.');
  }
}

function projectDir(id: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(id)) throw new Error('Invalid project id.');
  return join(imagexPaths().projectsDir, id);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'project';
}
