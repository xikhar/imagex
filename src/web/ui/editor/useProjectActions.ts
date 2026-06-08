import { useState } from 'react';
import type {
  GenerationJobStatus,
  ImageXAsset,
  ImageXEdge,
  ImageXNode,
  ImageXNodeAsset,
  ImageXOutputAsset,
  ImageXProject,
  ImageXProjectSummary,
  ImageXTemplateSummary,
  ImageXWorkflow,
  OutputNodeResult,
} from '../../../shared/types.js';
import { cloneWorkflowNode } from '../graph/operations.js';
import { nodeMeta } from '../flow/meta.js';
import type { UiEdge, UiNode } from '../flow/types.js';
import { fileToBase64 } from '../utils/files.js';
import { pushProjectRoute } from '../utils/routing.js';
import { outputNodePatchesFromGenerationStatus } from './generationStatus.js';
import {
  reflectRenamedImageAssetInWorkflow,
  reflectRenamedOutputAssetInWorkflow,
  scrubDeletedImageAssetFromWorkflow,
  scrubDeletedOutputAssetFromWorkflow,
} from './assetReconciliation.js';
import type { ConfirmDialogState, TextDialogState } from './types.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ProjectActionsDeps = {
  project: ImageXProject | null;
  setProject: (p: ImageXProject | null) => void;
  workflow: ImageXWorkflow | null;
  setStatus: (s: string) => void;
  showNotification: (msg: string) => void;
  // From useEditorActions:
  loadWorkflow: (wf: ImageXWorkflow, selectedId: string | null) => void;
  applyWorkflow: (wf: ImageXWorkflow) => void;
  patchOutputNodes: (patches: Map<string, Record<string, unknown>>) => void;
  clearHistory: () => void;
  recordHistory: () => void;
  syncLatestWorkflow: () => ImageXWorkflow | null;
  nodesRef: React.MutableRefObject<UiNode[]>;
  edgesRef: React.MutableRefObject<UiEdge[]>;
  // For dialogs:
  setTextDialog: (d: TextDialogState) => void;
  setConfirmDialog: (d: ConfirmDialogState) => void;
  // Additional UI state:
  setShowNewProject: (show: boolean) => void;
  setActiveSidePanel: (panel: string | null) => void;
  setOutputResults: (r: Map<string, OutputNodeResult>) => void;
};

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useProjectActions(deps: ProjectActionsDeps) {
  const {
    project,
    setProject,
    workflow,
    setStatus,
    showNotification,
    loadWorkflow,
    applyWorkflow,
    patchOutputNodes,
    clearHistory,
    recordHistory,
    syncLatestWorkflow,
    nodesRef,
    edgesRef,
    setTextDialog,
    setConfirmDialog,
    setShowNewProject,
    setActiveSidePanel,
    setOutputResults,
  } = deps;

  // ─── State ─────────────────────────────────────────────────────────────────

  const [projects, setProjects] = useState<ImageXProjectSummary[]>([]);
  const [templates, setTemplates] = useState<ImageXTemplateSummary[]>([]);
  const [assets, setAssets] = useState<ImageXAsset[]>([]);
  const [outputAssets, setOutputAssets] = useState<ImageXOutputAsset[]>([]);
  const [nodeAssets, setNodeAssets] = useState<ImageXNodeAsset[]>([]);

  // ─── Internal helpers ──────────────────────────────────────────────────────

  function showDashboard(options: { navigate?: boolean; replace?: boolean } = {}) {
    clearHistory();
    setProject(null);
    setOutputResults(new Map());
    setStatus('Dashboard');
    if (options.navigate !== false && window.location.pathname !== '/') {
      if (options.replace) window.history.replaceState({}, '', '/');
      else window.history.pushState({}, '', '/');
    }
  }

  function loadProject(nextProject: ImageXProject) {
    clearHistory();
    setProject(nextProject);
    loadWorkflow(nextProject.workflow, nextProject.workflow.nodes[0]?.id ?? null);
    void refreshAssets(nextProject.metadata.id);
    void refreshOutputAssets(nextProject.metadata.id);
    void refreshNodeAssets(nextProject.metadata.id);
    setOutputResults(new Map());
    setStatus('Ready');

    // Check if there's an active generation job for this project
    void checkActiveGeneration(nextProject);
  }

  async function checkActiveGeneration(proj: ImageXProject) {
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(proj.metadata.id)}/generate-status`);
      if (!res.ok) return;
      const data = await res.json() as GenerationJobStatus;
      applyGenerationStatus(data);
      if (!data.active && data.status !== 'running') return;

      // Poll until done (every 5s)
      const pollInterval = setInterval(async () => {
        try {
          const pollRes = await fetch(`/api/projects/${encodeURIComponent(proj.metadata.id)}/generate-status`);
          if (!pollRes.ok) { clearInterval(pollInterval); return; }
          const pollData = await pollRes.json() as GenerationJobStatus;
          applyGenerationStatus(pollData);

          if (pollData.status !== 'running') {
            clearInterval(pollInterval);
          }
        } catch {
          clearInterval(pollInterval);
        }
      }, 5000);
    } catch { /* ignore */ }
  }

  function applyGenerationStatus(data: GenerationJobStatus) {
    const patches = outputNodePatchesFromGenerationStatus(data);
    if (patches.size > 0) patchOutputNodes(patches);
    if (data.results?.length) {
      setOutputResults(new Map(data.results.map((result) => [result.outputNodeId, result])));
    }
    if (data.active || data.status === 'running') {
      setStatus('Generating...');
    } else if (data.status === 'error') {
      setStatus(data.error || 'Something went wrong');
    } else if (data.status === 'cancelled') {
      setStatus('Cancelled');
    } else if (data.results?.length) {
      const totalImages = data.results.reduce((sum, result) => sum + result.images.length, 0);
      setStatus(`Generated ${totalImages} image${totalImages === 1 ? '' : 's'}`);
      void refreshOutputAssets();
    }
  }

  function nodeAssetPayload(rootNodeId: string): { rootNodeId: string; nodes: ImageXNode[]; edges: ImageXEdge[] } | null {
    const selectedIds = new Set(nodesRef.current.filter((node) => node.selected).map((node) => node.id));
    const selectionMode = rootNodeId === '__selection__';
    const root = selectionMode
      ? nodesRef.current.find((node) => selectedIds.has(node.id) && node.type !== 'frame')
      : nodesRef.current.find((node) => node.id === rootNodeId);
    if (!root) return null;
    const included = selectionMode ? new Set(selectedIds) : new Set<string>([root.id]);
    if (selectionMode) {
      for (const node of nodesRef.current) {
        if (node.type !== 'frame') continue;
        if (nodesRef.current.some((candidate) => included.has(candidate.id) && candidate.data.workflowNode.data.frameId === node.id)) {
          included.add(node.id);
        }
      }
    } else {
      let changed = true;
      while (changed) {
        changed = false;
        for (const edge of edgesRef.current) {
          if (!edge.target || !edge.source) continue;
          if (included.has(edge.target) && !included.has(edge.source)) {
            included.add(edge.source);
            changed = true;
          }
        }
      }
    }
    const nodes = nodesRef.current
      .filter((node) => included.has(node.id))
      .map((node) => cloneWorkflowNode(node.data.workflowNode));
    const edges = edgesRef.current
      .filter((edge) => included.has(edge.source) && included.has(edge.target))
      .map((edge) => {
        const nextEdge: ImageXEdge = { id: edge.id, source: edge.source, target: edge.target };
        if (edge.sourceHandle) nextEdge.sourceHandle = edge.sourceHandle;
        if (edge.targetHandle) nextEdge.targetHandle = edge.targetHandle;
        return nextEdge;
      });
    return { rootNodeId: root.id, nodes, edges };
  }

  // ─── Bootstrap ─────────────────────────────────────────────────────────────

  async function bootstrap() {
    const [projectsResponse, templatesResponse] = await Promise.all([
      fetch('/api/projects'),
      fetch('/api/templates'),
    ]);
    const projectData = (await projectsResponse.json()) as { projects: ImageXProjectSummary[] };
    const templateData = (await templatesResponse.json()) as { templates: ImageXTemplateSummary[] };
    setProjects(projectData.projects);
    setTemplates(templateData.templates);
  }

  // ─── Project CRUD ──────────────────────────────────────────────────────────

  async function refreshProjects() {
    const response = await fetch('/api/projects');
    const data = (await response.json()) as { projects: ImageXProjectSummary[] };
    setProjects(data.projects);
  }

  async function openProject(projectId: string, options: { navigate?: boolean } = {}) {
    setStatus('Opening project...');
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}`);
    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: response.statusText }));
      showDashboard({ navigate: true, replace: true });
      showNotification(body.error || `Project not found: ${projectId}`);
      return;
    }
    const data = (await response.json()) as { project: ImageXProject };
    loadProject(data.project);
    if (options.navigate !== false) pushProjectRoute(data.project);
  }

  async function createProjectFromModal(input: { title: string; description: string; templateId: string }) {
    setStatus('Creating project...');
    const response = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: response.statusText }));
      setStatus(body.error || 'Failed to create project');
      return;
    }
    const data = (await response.json()) as { project: ImageXProject };
    setShowNewProject(false);
    await refreshProjects();
    loadProject(data.project);
    pushProjectRoute(data.project);
  }

  function closeProject() {
    showDashboard({ navigate: true });
    void refreshProjects();
  }

  // ─── Workflow CRUD ─────────────────────────────────────────────────────────

  async function selectWorkflow(workflowId: string) {
    if (!project || workflow?.id === workflowId) return;
    const response = await fetch(`/api/projects/${encodeURIComponent(project.metadata.id)}/workflows/${encodeURIComponent(workflowId)}`);
    if (!response.ok) {
      showNotification('Workflow not found.');
      return;
    }
    const data = (await response.json()) as { project: ImageXProject };
    loadProject(data.project);
  }

  async function createWorkflow() {
    if (!project) return;
    const response = await fetch(`/api/projects/${encodeURIComponent(project.metadata.id)}/workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Untitled Workflow' }),
    });
    if (!response.ok) {
      showNotification('Failed to create workflow.');
      return;
    }
    const data = (await response.json()) as { project: ImageXProject };
    loadProject(data.project);
  }

  async function deleteWorkflow(workflowId: string) {
    if (!project) return;
    const response = await fetch(`/api/projects/${encodeURIComponent(project.metadata.id)}/workflows/${encodeURIComponent(workflowId)}`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: 'Failed to delete workflow.' }));
      showNotification(body.error || 'Failed to delete workflow.');
      return;
    }
    const data = (await response.json()) as { project: ImageXProject };
    loadProject(data.project);
  }

  // ─── Workflow rename ───────────────────────────────────────────────────────

  function renameWorkflowFromMenu(workflowId: string) {
    if (!project) return;
    const entry = project.metadata.workflows?.find((candidate) => candidate.id === workflowId);
    setTextDialog({
      type: 'rename-workflow',
      id: workflowId,
      title: 'Rename workflow',
      label: 'Name',
      initialValue: entry?.title || workflow?.name || 'Untitled Workflow',
    });
  }

  async function submitRenameWorkflow(workflowId: string, name: string) {
    if (!project) return;
    if (workflow?.id === workflowId) {
      // Rename the currently loaded workflow in-place
      recordHistory();
      const synced = syncLatestWorkflow();
      if (!synced) return;
      const renamed = { ...synced, name };
      loadWorkflow(renamed, null);
      const nextMetadata = { ...project.metadata };
      if (nextMetadata.workflows?.length) {
        nextMetadata.workflows = nextMetadata.workflows.map((w) =>
          w.id === workflowId ? { ...w, title: name } : w
        );
      }
      setProject({ ...project, metadata: nextMetadata, workflow: renamed });
      return;
    }
    // Rename a non-active workflow via API
    const response = await fetch(`/api/projects/${encodeURIComponent(project.metadata.id)}/workflows/${encodeURIComponent(workflowId)}`);
    if (!response.ok) return;
    const data = (await response.json()) as { project: ImageXProject };
    const renamed = { ...data.project.workflow, name };
    const saveResponse = await fetch(`/api/projects/${encodeURIComponent(project.metadata.id)}/workflow`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflow: renamed }),
    });
    if (saveResponse.ok) {
      const saved = (await saveResponse.json()) as { project: ImageXProject };
      setProject({ ...project, metadata: saved.project.metadata });
    }
  }

  // ─── Project rename / delete ───────────────────────────────────────────────

  function renameProjectFromMenu(projectId: string) {
    const item = projects.find((candidate) => candidate.id === projectId);
    setTextDialog({
      type: 'rename-project',
      id: projectId,
      title: 'Rename project',
      label: 'Name',
      initialValue: item?.title || 'Untitled Project',
    });
  }

  async function submitRenameProject(projectId: string, name: string) {
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: name }),
    });
    if (response.ok) {
      const data = (await response.json()) as { project: ImageXProject };
      await refreshProjects();
      if (project?.metadata.id === projectId) {
        setProject(data.project);
      }
    }
  }

  function deleteProjectFromMenu(projectId: string) {
    const item = projects.find((candidate) => candidate.id === projectId);
    setConfirmDialog({
      type: 'delete-project',
      id: projectId,
      title: 'Delete project',
      message: `Delete "${item?.title || 'this project'}" and all of its files? This cannot be undone.`,
      confirmLabel: 'Delete Project',
    });
  }

  async function submitDeleteProject(projectId: string) {
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' });
    if (response.ok) {
      if (project?.metadata.id === projectId) showDashboard({ navigate: true });
      await refreshProjects();
    }
  }

  // ─── Assets ────────────────────────────────────────────────────────────────

  async function refreshAssets(projectId = project?.metadata.id) {
    if (!projectId) return;
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/assets`);
    if (!response.ok) return;
    const data = (await response.json()) as { assets: ImageXAsset[] };
    setAssets(data.assets);
  }

  async function refreshNodeAssets(projectId = project?.metadata.id) {
    if (!projectId) return;
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/node-assets`);
    if (!response.ok) return;
    const data = (await response.json()) as { assets: ImageXNodeAsset[] };
    setNodeAssets(data.assets);
  }

  async function refreshOutputAssets(projectId = project?.metadata.id) {
    if (!projectId) return;
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/output-assets`);
    if (!response.ok) return;
    const data = (await response.json()) as { assets: ImageXOutputAsset[] };
    setOutputAssets(data.assets);
  }

  async function importAssets(files: FileList | null) {
    if (!project || !files?.length) return;
    let nextAssets = assets;
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue;
      const dataBase64 = await fileToBase64(file);
      const response = await fetch(`/api/projects/${encodeURIComponent(project.metadata.id)}/assets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name, mimeType: file.type, dataBase64 }),
      });
      if (response.ok) {
        const data = (await response.json()) as { assets: ImageXAsset[] };
        nextAssets = data.assets;
      }
    }
    setAssets(nextAssets);
  }

  function renameAsset(assetId: string) {
    const asset = assets.find((candidate) => candidate.id === assetId);
    setTextDialog({
      type: 'rename-asset',
      id: assetId,
      title: 'Rename asset',
      label: 'Name',
      initialValue: asset?.name || 'Asset',
    });
  }

  async function submitRenameAsset(assetId: string, name: string) {
    if (!project) return;
    const response = await fetch(`/api/projects/${encodeURIComponent(project.metadata.id)}/assets/${encodeURIComponent(assetId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!response.ok) return;
    const data = (await response.json()) as { assets: ImageXAsset[] };
    setAssets(data.assets);
    const renamed = data.assets.find((asset) => asset.id === assetId);
    if (renamed) reflectRenamedAsset(renamed);
  }

  async function deleteAsset(assetId: string) {
    if (!project) return;
    const deleted = assets.find((candidate) => candidate.id === assetId);
    const response = await fetch(`/api/projects/${encodeURIComponent(project.metadata.id)}/assets/${encodeURIComponent(assetId)}`, {
      method: 'DELETE',
    });
    if (!response.ok) return;
    setAssets(((await response.json()) as { assets: ImageXAsset[] }).assets);
    if (deleted) scrubDeletedImageAsset(deleted);
  }

  function renameOutputAsset(assetId: string) {
    const asset = outputAssets.find((candidate) => candidate.id === assetId);
    setTextDialog({
      type: 'rename-output-asset',
      id: assetId,
      title: 'Rename output',
      label: 'Name',
      initialValue: asset?.name || 'Output',
    });
  }

  async function submitRenameOutputAsset(assetId: string, name: string) {
    if (!project) return;
    const response = await fetch(`/api/projects/${encodeURIComponent(project.metadata.id)}/output-assets/${encodeURIComponent(assetId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!response.ok) return;
    const data = (await response.json()) as { assets: ImageXOutputAsset[] };
    setOutputAssets(data.assets);
    const renamed = data.assets.find((asset) => asset.id === assetId);
    if (renamed) reflectRenamedOutputAsset(renamed);
  }

  async function deleteOutputAsset(assetId: string) {
    if (!project) return;
    const deleted = outputAssets.find((candidate) => candidate.id === assetId);
    const response = await fetch(`/api/projects/${encodeURIComponent(project.metadata.id)}/output-assets/${encodeURIComponent(assetId)}`, {
      method: 'DELETE',
    });
    if (!response.ok) return;
    const data = (await response.json()) as { assets: ImageXOutputAsset[]; deletedUrl?: string };
    setOutputAssets(data.assets);
    if (deleted) scrubDeletedOutputAsset(deleted);
  }

  function renameNodeAsset(assetId: string) {
    const asset = nodeAssets.find((candidate) => candidate.id === assetId);
    setTextDialog({
      type: 'rename-node-asset',
      id: assetId,
      title: 'Rename node asset',
      label: 'Name',
      initialValue: asset?.name || 'Node asset',
    });
  }

  async function submitRenameNodeAsset(assetId: string, name: string) {
    if (!project) return;
    const response = await fetch(`/api/projects/${encodeURIComponent(project.metadata.id)}/node-assets/${encodeURIComponent(assetId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (response.ok) setNodeAssets(((await response.json()) as { assets: ImageXNodeAsset[] }).assets);
  }

  async function deleteNodeAsset(assetId: string) {
    if (!project) return;
    const response = await fetch(`/api/projects/${encodeURIComponent(project.metadata.id)}/node-assets/${encodeURIComponent(assetId)}`, {
      method: 'DELETE',
    });
    if (response.ok) setNodeAssets(((await response.json()) as { assets: ImageXNodeAsset[] }).assets);
  }

  function scrubDeletedImageAsset(asset: ImageXAsset) {
    const current = syncLatestWorkflow();
    if (!current) return;
    const next = scrubDeletedImageAssetFromWorkflow(current, asset);
    if (next === current) return;
    recordHistory();
    applyWorkflow(next);
  }

  function reflectRenamedAsset(asset: ImageXAsset) {
    const current = syncLatestWorkflow();
    if (!current) return;
    const next = reflectRenamedImageAssetInWorkflow(current, asset);
    if (next === current) return;
    recordHistory();
    applyWorkflow(next);
  }

  function reflectRenamedOutputAsset(asset: ImageXOutputAsset) {
    const current = syncLatestWorkflow();
    if (!current) return;
    const next = reflectRenamedOutputAssetInWorkflow(current, asset);
    if (next === current) return;
    recordHistory();
    applyWorkflow(next);
  }

  function scrubDeletedOutputAsset(asset: ImageXOutputAsset) {
    const current = syncLatestWorkflow();
    if (!current) return;
    const next = scrubDeletedOutputAssetFromWorkflow(current, asset);
    if (next === current) return;
    recordHistory();
    applyWorkflow(next);
  }

  // ─── Node assets ───────────────────────────────────────────────────────────

  function openCreateNodeAssetDialog(nodeId: string) {
    const payload = nodeAssetPayload(nodeId);
    const root = payload?.nodes.find((candidate) => candidate.id === payload.rootNodeId);
    if (!payload || !root || root.type === 'frame') return;
    const meta = nodeMeta[root.type];
    const defaultName =
      nodeId === '__selection__'
        ? `${meta.label} snippet`
        : (typeof root.data.name === 'string' && root.data.name.trim()) ||
          (typeof root.data.title === 'string' && root.data.title.trim()) ||
          meta.label;
    setTextDialog({
      type: 'create-node-asset',
      id: nodeId,
      title: 'Create node asset',
      label: 'Name',
      initialValue: defaultName,
    });
  }

  async function createNodeAssetFromNode(nodeId: string, name: string) {
    if (!project) return;
    const payload = nodeAssetPayload(nodeId);
    if (!payload) return;
    const response = await fetch(`/api/projects/${encodeURIComponent(project.metadata.id)}/node-assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, ...payload }),
    });
    if (response.ok) {
      const data = (await response.json()) as { assets: ImageXNodeAsset[] };
      setNodeAssets(data.assets);
      setActiveSidePanel('assets');
    }
  }

  // ─── Return ────────────────────────────────────────────────────────────────

  return {
    projects,
    templates,
    assets,
    outputAssets,
    nodeAssets,
    bootstrap,
    refreshProjects,
    refreshAssets,
    refreshOutputAssets,
    refreshNodeAssets,
    openProject,
    closeProject,
    createProjectFromModal,
    selectWorkflow,
    createWorkflow,
    deleteWorkflow,
    importAssets,
    renameAsset,
    submitRenameAsset,
    deleteAsset,
    renameOutputAsset,
    submitRenameOutputAsset,
    deleteOutputAsset,
    renameNodeAsset,
    submitRenameNodeAsset,
    deleteNodeAsset,
    renameWorkflowFromMenu,
    submitRenameWorkflow,
    renameProjectFromMenu,
    submitRenameProject,
    deleteProjectFromMenu,
    submitDeleteProject,
    openCreateNodeAssetDialog,
    createNodeAssetFromNode,
  };
}
