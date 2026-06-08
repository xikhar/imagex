import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  CustomFieldDefinition,
  CustomFieldKind,
  GenerateWorkflowResponse,
  GenerationJobStatus,
  GenerationRunMode,
  ImageXAsset,
  ImageXEdge,
  ImageXNode,
  ImageXNodeAsset,
  ImageXOutputAsset,
  ImageXProject,
  ImageXWorkflow,
  NodeType,
  OutputNodeResult,
} from '../../../shared/types.js';
import { createUiWorkflowNode, syncFlowToWorkflow, workflowToFlow } from '../flow/adapters.js';
import { fieldDefinitionsFor } from '../flow/fields/definitions.js';
import { nodeMeta } from '../flow/meta.js';
import type { UiEdge, UiNode } from '../flow/types.js';
import { flowStore } from '../../state/flowStore.js';
import {
  attachNodeToFrameAtCenter,
  cloneWorkflow,
  cloneWorkflowNode,
  deleteNodes as deleteWorkflowNodes,
  detachNodesFromFrames,
  disconnectNodes,
  duplicateWorkflowNodes,
  expandSelectionWithFrameMembers,
  frameMembers,
  hoveredFrameForNodeCenter,
  moveFrameMembers,
  refreshConnectedTargetHandles,
  removeFrameOnly as removeFrameOnlyFromWorkflow,
  selectedEdgeIds as graphSelectedEdgeIds,
  selectedNodeIds as graphSelectedNodeIds,
  setHighlightedFrame,
  snapshotsEqual,
  updateNodeWorkflowData,
  wrapFramesAroundMembers,
} from '../graph/operations.js';
import { outputNodePatchesFromGenerationStatus } from './generationStatus.js';

// ─── Types ───────────────────────────────────────────────────────────────────

type EditorSnapshot = {
  workflow: ImageXWorkflow;
  selectedId: string | null;
};

export type EditorActionsDeps = {
  workflow: ImageXWorkflow | null;
  setWorkflow: (wf: ImageXWorkflow | null) => void;
  project: ImageXProject | null;
  setStatus: (s: string) => void;
  showNotification: (msg: string) => void;
  setOutputResults: (r: Map<string, OutputNodeResult>) => void;
  setAssetPicker: (p: { nodeId: string; fieldId: string } | null) => void;
  setActiveSidePanel: (p: string | null) => void;
  setPromptOverlay: (p: { prompt: string } | null) => void;
  onNodeMenu: (nodeId: string, position: { x: number; y: number }) => void;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clampHistoryLimit(value: number): number {
  if (!Number.isFinite(value)) return 50;
  return Math.max(10, Math.min(200, Math.round(value)));
}

function normalizeCustomFieldValue(value: unknown): string | number | boolean {
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return value === undefined || value === null ? '' : String(value);
}

function createCustomFieldDefinition(kind: CustomFieldKind): CustomFieldDefinition {
  const id = `field-${crypto.randomUUID().slice(0, 8)}`;
  switch (kind) {
    case 'textarea':
      return { id, label: 'Text', kind, value: '' };
    case 'select':
      return { id, label: 'Selector', kind, value: 'option 1', options: ['option 1', 'option 2'] };
    case 'slider':
      return { id, label: 'Slider', kind, value: 0.5, min: 0, max: 1, step: 0.05 };
    case 'number':
      return { id, label: 'Number', kind, value: 0 };
    case 'toggle':
      return { id, label: 'Toggle', kind, value: false };
    case 'text':
    default:
      return { id, label: 'Text', kind: 'text', value: '' };
  }
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useEditorActions(deps: EditorActionsDeps) {
  const {
    workflow,
    setWorkflow,
    project,
    setStatus,
    showNotification: _showNotification,
    setOutputResults,
    setAssetPicker,
    setActiveSidePanel,
  } = deps;

  // ─── Nodes / Edges state (synced with flowStore) ───────────────────────────

  const [nodes, setNodesRaw] = useState<UiNode[]>([]);
  const [edges, setEdgesRaw] = useState<UiEdge[]>([]);

  const setNodes = (next: UiNode[] | ((prev: UiNode[]) => UiNode[])) => {
    if (typeof next === 'function') {
      setNodesRaw((prev) => {
        const result = next(prev);
        queueMicrotask(() => flowStore.setNodes(result));
        return result;
      });
    } else {
      setNodesRaw(next);
      flowStore.setNodes(next);
    }
  };

  const setEdges = (next: UiEdge[] | ((prev: UiEdge[]) => UiEdge[])) => {
    if (typeof next === 'function') {
      setEdgesRaw((prev) => {
        const result = next(prev);
        queueMicrotask(() => flowStore.setEdges(result));
        return result;
      });
    } else {
      setEdgesRaw(next);
      flowStore.setEdges(next);
    }
  };

  // ─── Selection ─────────────────────────────────────────────────────────────

  const [selectedId, setSelectedId] = useState<string | null>(null);

  // ─── Placing node ──────────────────────────────────────────────────────────

  const [placingNodeId, setPlacingNodeId] = useState<string | null>(null);
  const placingNodeIdRef = useRef<string | null>(null);
  const placingNodeOffsetsRef = useRef<Array<{ id: string; dx: number; dy: number }>>([]);

  // ─── Active custom field ───────────────────────────────────────────────────

  const [activeCustomField, setActiveCustomField] = useState<{ nodeId: string; fieldId: string } | null>(null);
  const activeCustomFieldRef = useRef<{ nodeId: string; fieldId: string } | null>(null);

  // ─── Refs ──────────────────────────────────────────────────────────────────

  const nodesRef = useRef<UiNode[]>([]);
  const edgesRef = useRef<UiEdge[]>([]);
  const selectedIdRef = useRef<string | null>(null);
  const workflowRef = useRef<ImageXWorkflow | null>(workflow);
  const projectRef = useRef<ImageXProject | null>(project);

  // ─── Undo / Redo ───────────────────────────────────────────────────────────

  const [historyLimit, setHistoryLimit] = useState(() => clampHistoryLimit(Number(localStorage.getItem('imagex.historyLimit')) || 50));
  const [historyVersion, setHistoryVersion] = useState(0);
  const historyLimitRef = useRef(historyLimit);
  const undoStackRef = useRef<EditorSnapshot[]>([]);
  const redoStackRef = useRef<EditorSnapshot[]>([]);
  const isRestoringHistory = useRef(false);
  const activeEditHistoryKeyRef = useRef<string | null>(null);
  const activeEditHistoryTimerRef = useRef<number | null>(null);

  // ─── Frame animation ───────────────────────────────────────────────────────

  const frameWrapRafRef = useRef<number | null>(null);

  // ─── Flow API ref ──────────────────────────────────────────────────────────

  const flowApiRef = useRef<{
    screenToFlowPosition: (p: { x: number; y: number }) => { x: number; y: number };
    zoomIn: () => void;
    zoomOut: () => void;
    fitView: () => void;
  } | null>(null);

  const lastMousePosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // ─── Sync effects ─────────────────────────────────────────────────────────

  useEffect(() => {
    placingNodeIdRef.current = placingNodeId;
  }, [placingNodeId]);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  useEffect(() => {
    edgesRef.current = edges;
  }, [edges]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    workflowRef.current = workflow;
  }, [workflow]);

  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  // ─── History limit persistence ─────────────────────────────────────────────

  useEffect(() => {
    const nextLimit = clampHistoryLimit(historyLimit);
    historyLimitRef.current = nextLimit;
    localStorage.setItem('imagex.historyLimit', String(nextLimit));
    if (undoStackRef.current.length > nextLimit) {
      undoStackRef.current = undoStackRef.current.slice(-nextLimit);
      setHistoryVersion((version) => version + 1);
    }
  }, [historyLimit]);

  // ─── FlowStore subscription ────────────────────────────────────────────────

  useEffect(() => {
    const unsubNodes = flowStore.subscribeNodes(() => {
      const next = flowStore.getNodes();
      nodesRef.current = next;
      setNodesRaw(next);
    });
    const unsubEdges = flowStore.subscribeEdges(() => {
      const next = flowStore.getEdges();
      edgesRef.current = next;
      setEdgesRaw(next);
      // Refresh connected target handles on nodes (for inspector panel)
      const currentNodes = flowStore.getNodes();
      const nextNodes = refreshConnectedTargetHandles(currentNodes, next);
      // Only write back if handles actually changed (avoid infinite notification cycle)
      const handlesChanged = nextNodes.some((n, i) => {
        const prev = currentNodes[i];
        if (!prev) return true;
        const a = n.data.connectedTargetHandles;
        const b = prev.data.connectedTargetHandles;
        return a.length !== b.length || a.some((h, j) => h !== b[j]);
      });
      if (handlesChanged) {
        nodesRef.current = nextNodes;
        flowStore.setNodes(nextNodes);
      }
      // Sync workflow
      const nextWorkflow = syncLatestWorkflow(nodesRef.current, next);
      if (nextWorkflow) {
        workflowRef.current = nextWorkflow;
        setWorkflow(nextWorkflow);
      }
    });
    return () => { unsubNodes(); unsubEdges(); };
  }, []);

  // ─── Mouse position tracking ───────────────────────────────────────────────

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      lastMousePosRef.current = { x: event.clientX, y: event.clientY };
    };
    document.addEventListener('mousemove', onMove);
    return () => document.removeEventListener('mousemove', onMove);
  }, []);

  // ─── Placing node escape key ───────────────────────────────────────────────

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && placingNodeIdRef.current) {
        placingNodeOffsetsRef.current = [];
        setPlacingNodeId(null);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  // ─── Autosave effect ───────────────────────────────────────────────────────

  useEffect(() => {
    if (!project || !workflow) return;
    const handle = window.setTimeout(() => {
      const wrapped = wrapFramesAroundMembers(nodes);
      const synced = syncFlowToWorkflow(workflow, wrapped.nodes, edges);
      if (wrapped.changed) {
        nodesRef.current = wrapped.nodes;
        setNodes(wrapped.nodes);
        workflowRef.current = synced;
        setWorkflow(synced);
      }
      void fetch(`/api/projects/${encodeURIComponent(project.metadata.id)}/workflow`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflow: synced }),
      });
    }, 700);
    return () => window.clearTimeout(handle);
  }, [project, workflow, nodes, edges]);

  // ─── Selected node (derived) ───────────────────────────────────────────────

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedId)?.data.workflowNode || null,
    [nodes, selectedId]
  );

  // ─── Core workflow functions ───────────────────────────────────────────────

  function restoreWorkflowSnapshot(nextWorkflow: ImageXWorkflow, nextSelectedId: string | null) {
    const flow = workflowToFlow(
      nextWorkflow,
      updateNodeData,
      openNodeMenu,
      showCompiledPrompt,
      addCustomField,
      updateCustomFieldValue,
      activateCustomField,
      openAssetPickerForField
    );
    const nextNodes = refreshConnectedTargetHandles(
      flow.nodes.map((node) => ({ ...node, selected: node.id === nextSelectedId })),
      flow.edges
    );
    workflowRef.current = nextWorkflow;
    nodesRef.current = nextNodes;
    edgesRef.current = flow.edges;
    selectedIdRef.current = nextSelectedId;
    setWorkflow(nextWorkflow);
    setNodes(nextNodes);
    setEdges(flow.edges);
    setSelectedId(nextSelectedId);
  }

  function applyWorkflow(nextWorkflow: ImageXWorkflow) {
    restoreWorkflowSnapshot(nextWorkflow, selectedIdRef.current);
  }

  function syncLatestWorkflow(nextNodes = nodesRef.current, nextEdges = edgesRef.current) {
    const current = workflowRef.current;
    if (!current) return null;
    const wrapped = wrapFramesAroundMembers(nextNodes);
    if (wrapped.changed) {
      nodesRef.current = wrapped.nodes;
      setNodes(wrapped.nodes);
    }
    return syncFlowToWorkflow(current, wrapped.nodes, nextEdges);
  }

  function commitFlowToWorkflow(nextNodes = nodesRef.current, nextEdges = edgesRef.current) {
    const nextWorkflow = syncLatestWorkflow(nextNodes, nextEdges);
    if (!nextWorkflow) return null;
    workflowRef.current = nextWorkflow;
    setWorkflow(nextWorkflow);
    return nextWorkflow;
  }

  // ─── History ───────────────────────────────────────────────────────────────

  function currentSnapshot(): EditorSnapshot | null {
    const synced = syncLatestWorkflow();
    if (!synced) return null;
    return { workflow: cloneWorkflow(synced), selectedId: selectedIdRef.current };
  }

  function recordHistory() {
    if (isRestoringHistory.current) return;
    const snapshot = currentSnapshot();
    if (!snapshot) return;
    const previous = undoStackRef.current.at(-1);
    if (previous && snapshotsEqual(previous, snapshot)) return;
    undoStackRef.current = [...undoStackRef.current, snapshot].slice(-historyLimitRef.current);
    redoStackRef.current = [];
    setHistoryVersion((version) => version + 1);
  }

  function recordEditHistory(key: string) {
    if (activeEditHistoryKeyRef.current !== key) {
      recordHistory();
      activeEditHistoryKeyRef.current = key;
    }
    if (activeEditHistoryTimerRef.current) window.clearTimeout(activeEditHistoryTimerRef.current);
    activeEditHistoryTimerRef.current = window.setTimeout(() => {
      activeEditHistoryKeyRef.current = null;
    }, 900);
  }

  function clearHistory() {
    activeEditHistoryKeyRef.current = null;
    if (activeEditHistoryTimerRef.current) window.clearTimeout(activeEditHistoryTimerRef.current);
    undoStackRef.current = [];
    redoStackRef.current = [];
    setHistoryVersion((version) => version + 1);
  }

  function undo() {
    const snapshot = undoStackRef.current.pop();
    if (!snapshot) return;
    const current = currentSnapshot();
    if (current) redoStackRef.current = [...redoStackRef.current, current].slice(-historyLimitRef.current);
    isRestoringHistory.current = true;
    restoreWorkflowSnapshot(cloneWorkflow(snapshot.workflow), snapshot.selectedId);
    isRestoringHistory.current = false;
    setStatus('Undo');
    setHistoryVersion((version) => version + 1);
  }

  function redo() {
    const snapshot = redoStackRef.current.pop();
    if (!snapshot) return;
    const current = currentSnapshot();
    if (current) undoStackRef.current = [...undoStackRef.current, current].slice(-historyLimitRef.current);
    isRestoringHistory.current = true;
    restoreWorkflowSnapshot(cloneWorkflow(snapshot.workflow), snapshot.selectedId);
    isRestoringHistory.current = false;
    setStatus('Redo');
    setHistoryVersion((version) => version + 1);
  }

  // ─── Node data manipulation ────────────────────────────────────────────────

  function updateNodeData(nodeId: string, key: string, value: unknown) {
    recordEditHistory(`${nodeId}:${key}`);
    const patch = key === 'fields' ? { fields: value, fieldsMode: 'managed' } : { [key]: value };
    const { nodes: nextNodes } = updateNodeWorkflowData(nodesRef.current, nodeId, patch);
    const nextWorkflow = syncLatestWorkflow(nextNodes, edgesRef.current);
    nodesRef.current = nextNodes;
    if (nextWorkflow) workflowRef.current = nextWorkflow;
    setNodes(nextNodes);
    if (nextWorkflow) setWorkflow(nextWorkflow);
  }

  function openAssetPickerForField(nodeId: string, fieldId: string) {
    setAssetPicker({ nodeId, fieldId });
  }

  function openAssetLibrary() {
    setActiveSidePanel('assets');
  }

  function selectAssetForField(asset: ImageXAsset) {
    recordHistory();
    const picker = /* get from outside */ { nodeId: '', fieldId: '' };
    // Note: the assetPicker state lives outside this hook — the caller passes the
    // relevant asset info through selectAssetForField. We work with the asset
    // picker state via the deps.
    // Actually the function in App.tsx reads from `assetPicker` closure variable.
    // We'll accept nodeId/fieldId as extra params to make this self-contained.
    void picker;
    // This function will be overridden below with the correct implementation.
  }

  function selectAssetForFieldImpl(asset: ImageXAsset | ImageXOutputAsset, picker: { nodeId: string; fieldId: string }) {
    recordHistory();
    const { nodeId, fieldId } = picker;
    const { nodes: nextNodes } = updateNodeWorkflowData(nodesRef.current, nodeId, {
      [fieldId]: asset.type === 'image' ? asset.file : asset.url,
      assetId: asset.id,
      assetUrl: asset.url,
      assetName: asset.name,
    });
    const nextWorkflow = syncLatestWorkflow(nextNodes, edgesRef.current);
    nodesRef.current = nextNodes;
    if (nextWorkflow) workflowRef.current = nextWorkflow;
    setNodes(nextNodes);
    if (nextWorkflow) setWorkflow(nextWorkflow);
    setAssetPicker(null);
  }

  // ─── Custom fields ─────────────────────────────────────────────────────────

  function setActiveFieldRef(active: { nodeId: string; fieldId: string }) {
    activeCustomFieldRef.current = active;
    setActiveCustomField(active);
  }

  function addCustomField(nodeId: string, preset: string) {
    const field = createCustomFieldDefinition(preset as CustomFieldKind);
    setActiveFieldRef({ nodeId, fieldId: field.id });
    updateCustomFields(nodeId, (fields) => [...fields, field]);
  }

  function updateCustomFieldValue(nodeId: string, fieldId: string, value: unknown) {
    updateCustomFields(nodeId, (fields) =>
      fields.map((field) => (field.id === fieldId ? { ...field, value: normalizeCustomFieldValue(value) } : field))
    );
  }

  function duplicateCustomField(nodeId: string, fieldId: string) {
    updateCustomFields(nodeId, (fields) => {
      const index = fields.findIndex((field) => field.id === fieldId);
      if (index === -1) return fields;
      const source = fields[index]!;
      const copyId = `field-${crypto.randomUUID().slice(0, 8)}`;
      // Guard against double-invocation
      if (fields.some((f) => f.id === copyId)) return fields;
      const copy: CustomFieldDefinition = {
        ...source,
        id: copyId,
        label: `${source.label} Copy`,
      };
      setActiveFieldRef({ nodeId, fieldId: copy.id });
      return [...fields.slice(0, index + 1), copy, ...fields.slice(index + 1)];
    });
  }

  function duplicateActiveCustomField() {
    if (selectedNodeIds().length > 0 || selectedIdRef.current) {
      duplicateSelection();
      return;
    }
    const active = activeCustomFieldRef.current || activeCustomField;
    if (!active) {
      duplicateSelection();
      return;
    }
    duplicateCustomField(active.nodeId, active.fieldId);
  }

  function activateCustomField(nodeId: string, fieldId: string) {
    setActiveFieldRef({ nodeId, fieldId });
  }

  function updateCustomFields(nodeId: string, updater: (fields: CustomFieldDefinition[]) => CustomFieldDefinition[]) {
    recordEditHistory(`custom-fields:${nodeId}`);
    const nextNodes = nodesRef.current.map((node) => {
      if (node.id !== nodeId) return node;
      const fields = fieldDefinitionsFor(node.data.workflowNode);
      const workflowNode = {
        ...node.data.workflowNode,
        data: { ...node.data.workflowNode.data, fields: updater(fields), fieldsMode: 'managed' },
      };
      return { ...node, data: { ...node.data, workflowNode } };
    });
    const nextWorkflow = syncLatestWorkflow(nextNodes, edgesRef.current);
    const nextEdges = edgesRef.current;
    const nextConnectedNodes = refreshConnectedTargetHandles(nextNodes, nextEdges);
    nodesRef.current = nextConnectedNodes;
    if (nextWorkflow) workflowRef.current = nextWorkflow;
    setNodes(nextConnectedNodes);
    if (nextWorkflow) setWorkflow(nextWorkflow);
  }

  // ─── Flow node/edge updates ────────────────────────────────────────────────

  function updateFlowNodes(nextNodes: UiNode[]) {
    nodesRef.current = nextNodes;
    setNodes(nextNodes);
  }

  function updateFlowEdges(nextEdges: UiEdge[]) {
    edgesRef.current = nextEdges;
    setEdges(nextEdges);
    const nextNodes = refreshConnectedTargetHandles(nodesRef.current, nextEdges);
    nodesRef.current = nextNodes;
    setNodes(nextNodes);
    const nextWorkflow = syncLatestWorkflow(nextNodes, nextEdges);
    if (nextWorkflow) {
      workflowRef.current = nextWorkflow;
      setWorkflow(nextWorkflow);
    }
  }

  function openNodeMenu(nodeId: string, position: { x: number; y: number }) {
    selectedIdRef.current = nodeId;
    setSelectedId(nodeId);
    const nextNodes = nodesRef.current.map((node) => ({ ...node, selected: node.id === nodeId }));
    nodesRef.current = nextNodes;
    setNodes(nextNodes);
    deps.onNodeMenu(nodeId, position);
  }

  // ─── Selection ─────────────────────────────────────────────────────────────

  function handleSelectionChange(nodeIds: string[], edgeIds: string[]) {
    selectedIdRef.current = nodeIds.length === 1 ? nodeIds[0]! : null;
    setSelectedId(nodeIds.length === 1 ? nodeIds[0]! : null);
    const nodeSet = new Set(nodeIds);
    const edgeSet = new Set(edgeIds);
    const nextNodes = nodesRef.current.map((node) => ({ ...node, selected: nodeSet.has(node.id) }));
    const nextEdges = edgesRef.current.map((edge) => ({ ...edge, selected: edgeSet.has(edge.id) }));
    nodesRef.current = nextNodes;
    edgesRef.current = nextEdges;
  }

  function selectedNodeIds(): string[] {
    return graphSelectedNodeIds(nodesRef.current);
  }

  function selectedEdgeIds(): string[] {
    return graphSelectedEdgeIds(edgesRef.current);
  }

  function expandFrameSelection(selected: Set<string>): Set<string> {
    return expandSelectionWithFrameMembers(selected, nodesRef.current);
  }

  function clearSelection() {
    setSelectedId(null);
    selectedIdRef.current = null;
    const nextNodes = nodesRef.current.map((node) => ({ ...node, selected: false }));
    const nextEdges = edgesRef.current.map((edge) => ({ ...edge, selected: false }));
    nodesRef.current = nextNodes;
    edgesRef.current = nextEdges;
    setNodes(nextNodes);
    setEdges(nextEdges);
  }

  // ─── Add nodes ─────────────────────────────────────────────────────────────

  function addNode(type: Parameters<typeof createUiWorkflowNode>[0], position?: { x: number; y: number }) {
    if (!workflow) return;
    recordHistory();
    const currentWithLayout = syncLatestWorkflow() || syncFlowToWorkflow(workflow, nodesRef.current, edgesRef.current);
    const center = flowApiRef.current?.screenToFlowPosition({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    });
    const nextNode = createUiWorkflowNode(
      type,
      position || center || {
        x: 160 + currentWithLayout.nodes.length * 28,
        y: 140 + currentWithLayout.nodes.length * 34,
      }
    );
    const nextWorkflow = {
      ...currentWithLayout,
      nodes: [...currentWithLayout.nodes, nextNode],
    };
    selectedIdRef.current = nextNode.id;
    placingNodeOffsetsRef.current = [{ id: nextNode.id, dx: 0, dy: 0 }];
    applyWorkflow(nextWorkflow);
    setSelectedId(nextNode.id);
    setPlacingNodeId(nextNode.id);
    setActiveSidePanel(null);
  }

  function addWorkflowNodesForPlacement(newNodes: ImageXNode[], newEdges: ImageXEdge[], rootNodeId: string) {
    if (!workflow || newNodes.length === 0) return;
    recordHistory();
    const currentWithLayout = syncLatestWorkflow() || syncFlowToWorkflow(workflow, nodesRef.current, edgesRef.current);
    const nextWorkflow = {
      ...currentWithLayout,
      nodes: [...currentWithLayout.nodes, ...newNodes],
      edges: [...currentWithLayout.edges, ...newEdges],
    };
    selectedIdRef.current = rootNodeId;
    const root = newNodes.find((node) => node.id === rootNodeId) || newNodes[0]!;
    placingNodeOffsetsRef.current = newNodes.map((node) => ({
      id: node.id,
      dx: node.position.x - root.position.x,
      dy: node.position.y - root.position.y,
    }));
    applyWorkflow(nextWorkflow);
    setSelectedId(rootNodeId);
    setPlacingNodeId(rootNodeId);
    setActiveSidePanel(null);
  }

  function addImageAssetNode(asset: ImageXAsset | ImageXOutputAsset) {
    const position = flowApiRef.current?.screenToFlowPosition(lastMousePosRef.current) || { x: 160, y: 140 };
    const node = createUiWorkflowNode('image', position);
    node.data = {
      ...node.data,
      path: asset.type === 'image' ? asset.file : asset.url,
      assetId: asset.id,
      assetUrl: asset.url,
      assetName: asset.name,
    };
    addWorkflowNodesForPlacement([node], [], node.id);
    setActiveSidePanel(null);
  }

  function addNodeAsset(asset: ImageXNodeAsset) {
    const root = asset.nodes.find((node) => node.id === asset.rootNodeId) || asset.nodes[0];
    if (!root) return;
    const idMap = new Map(asset.nodes.map((node) => [node.id, `${node.type}-${crypto.randomUUID().slice(0, 8)}`]));
    const rootNewId = idMap.get(root.id)!;
    const rootPosition = flowApiRef.current?.screenToFlowPosition(lastMousePosRef.current) || root.position;
    const offset = { x: rootPosition.x - root.position.x, y: rootPosition.y - root.position.y };
    const newNodes = asset.nodes.map((node) => {
      const copy = sanitizeNodeAssetNodeForInsert(cloneWorkflowNode(node));
      copy.id = idMap.get(node.id)!;
      copy.position = { x: node.position.x + offset.x, y: node.position.y + offset.y };
      if (typeof copy.data.frameId === 'string' && idMap.has(copy.data.frameId)) copy.data.frameId = idMap.get(copy.data.frameId);
      else delete copy.data.frameId;
      return copy;
    });
    const newEdges = asset.edges
      .filter((edge) => idMap.has(edge.source) && idMap.has(edge.target))
      .map((edge) => {
        const nextEdge: ImageXEdge = {
          id: `${idMap.get(edge.source)}-${edge.sourceHandle || 'out'}-${idMap.get(edge.target)}-${edge.targetHandle || 'in'}`,
          source: idMap.get(edge.source)!,
          target: idMap.get(edge.target)!,
        };
        if (edge.sourceHandle) nextEdge.sourceHandle = edge.sourceHandle;
        if (edge.targetHandle) nextEdge.targetHandle = edge.targetHandle;
        return nextEdge;
      });
    addWorkflowNodesForPlacement(newNodes, newEdges, rootNewId);
    setActiveSidePanel(null);
  }

  // ─── Placing node movement ─────────────────────────────────────────────────

  function handlePlacingMove(nodeId: string, position: { x: number; y: number }) {
    const current = nodesRef.current;
    const offsets = placingNodeOffsetsRef.current.length
      ? placingNodeOffsetsRef.current
      : [{ id: nodeId, dx: 0, dy: 0 }];
    const positions = new Map(offsets.map((item) => [item.id, { x: position.x + item.dx, y: position.y + item.dy }]));
    const next = current.map((node) => {
      const nextPosition = positions.get(node.id);
      return nextPosition ? { ...node, position: nextPosition } : node;
    });
    nodesRef.current = next;
    setNodes(next);
  }

  function handlePlacingDrop() {
    const id = placingNodeIdRef.current;
    if (!id) return;
    placingNodeOffsetsRef.current = [];
    setPlacingNodeId(null);
    commitFlowToWorkflow();
  }

  // ─── Delete / Disconnect ───────────────────────────────────────────────────

  function deleteNode(nodeId: string) {
    if (!workflow) return;
    recordHistory();
    const currentWithLayout = syncLatestWorkflow() || workflow;
    const node = nodesRef.current.find((candidate) => candidate.id === nodeId);
    const idsToDelete =
      node?.type === 'frame'
        ? new Set([nodeId, ...frameMembers(nodeId, nodesRef.current).map((inside) => inside.id)])
        : new Set([nodeId]);
    const nextWorkflow = deleteWorkflowNodes(currentWithLayout, idsToDelete);
    setSelectedId(null);
    applyWorkflow(nextWorkflow);
  }

  function removeFrameOnlyAction(nodeId: string) {
    if (!workflow) return;
    const node = nodesRef.current.find((candidate) => candidate.id === nodeId);
    if (!node || node.type !== 'frame') return;
    recordHistory();
    const currentWithLayout = syncLatestWorkflow() || workflow;
    setSelectedId(null);
    applyWorkflow(removeFrameOnlyFromWorkflow(currentWithLayout, nodeId));
  }

  function disconnectHandle(nodeId: string, handleId: string) {
    recordEditHistory(`disconnect:${nodeId}:${handleId}`);
    const nextEdges = edgesRef.current.filter(
      (edge) => !(edge.target === nodeId && edge.targetHandle === handleId)
    );
    edgesRef.current = nextEdges;
    setEdges(nextEdges);
    const nextNodes = refreshConnectedTargetHandles(nodesRef.current, nextEdges);
    nodesRef.current = nextNodes;
    setNodes(nextNodes);
    const nextWorkflow = syncLatestWorkflow(nextNodes, nextEdges);
    if (nextWorkflow) { workflowRef.current = nextWorkflow; setWorkflow(nextWorkflow); }
  }

  function deleteSelection() {
    if (!workflow) return;
    const selectedNodes = expandFrameSelection(new Set(selectedNodeIds()));
    const selectedEdges = new Set(selectedEdgeIds());
    if (selectedNodes.size === 1 && selectedEdges.size === 0) {
      deleteNode([...selectedNodes][0]!);
      return;
    }
    if (selectedNodes.size === 0 && selectedEdges.size === 0) return;
    recordHistory();
    const currentWithLayout = syncLatestWorkflow() || syncFlowToWorkflow(workflow, nodesRef.current, edgesRef.current);
    applyWorkflow(deleteWorkflowNodes(currentWithLayout, selectedNodes, selectedEdges));
  }

  function disconnectSelection() {
    if (!workflow) return;
    const selectedNodes = expandFrameSelection(new Set(selectedNodeIds()));
    if (!selectedNodes.size) return;
    recordHistory();
    const currentWithLayout = syncLatestWorkflow() || syncFlowToWorkflow(workflow, nodesRef.current, edgesRef.current);
    applyWorkflow(disconnectNodes(currentWithLayout, selectedNodes));
  }

  function detachSelectionFromFrames() {
    const ids = new Set(selectedNodeIds());
    if (ids.size === 0 && selectedIdRef.current) ids.add(selectedIdRef.current);
    detachNodesFromFrameIds(ids);
  }

  function detachNodesFromFrameIds(nodeIds: Set<string>) {
    if (!workflow || nodeIds.size === 0) return;
    const result = detachNodesFromFrames(nodesRef.current, nodeIds);
    if (!result.changed) return;
    recordHistory();
    updateFlowNodesAndCommit(result.nodes, false);
  }

  // ─── Duplicate ─────────────────────────────────────────────────────────────

  function duplicateNode(nodeId: string) {
    if (!workflow) return;
    recordHistory();
    const currentWithLayout = syncLatestWorkflow() || workflow;
    const node = currentWithLayout.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) return;
    if (node.type === 'frame') {
      const selected = new Set([nodeId, ...frameMembers(nodeId, nodesRef.current).map((inside) => inside.id)]);
      const duplicated = duplicateWorkflowNodes(currentWithLayout, selected, 48);
      applyWorkflow(duplicated.workflow);
      return;
    }
    const duplicated = duplicateWorkflowNodes(currentWithLayout, new Set([nodeId]), 36);
    const copyId = duplicated.copyIds[0] ?? null;
    const underCursor = flowApiRef.current?.screenToFlowPosition(lastMousePosRef.current);
    if (underCursor && copyId) {
      const copy = duplicated.workflow.nodes.find((n) => n.id === copyId);
      if (copy) copy.position = underCursor;
    }
    selectedIdRef.current = copyId;
    setSelectedId(copyId);
    setPlacingNodeId(copyId);
    applyWorkflow(duplicated.workflow);
  }

  function duplicateSelection() {
    if (!workflow) return;
    const ids = [...expandFrameSelection(new Set(selectedNodeIds()))];
    if (ids.length === 0 && selectedIdRef.current) ids.push(selectedIdRef.current);
    if (ids.length === 0) return;
    if (ids.length === 1) {
      duplicateNode(ids[0]!);
      return;
    }
    recordHistory();
    const currentWithLayout = syncLatestWorkflow() || workflow;
    const duplicated = duplicateWorkflowNodes(currentWithLayout, new Set(ids), 44);
    applyWorkflow(duplicated.workflow);
    const copyIds = new Set(duplicated.copyIds);
    setNodes((current) => {
      const next = current.map((node) => ({ ...node, selected: copyIds.has(node.id) }));
      nodesRef.current = next;
      return next;
    });
  }

  function disconnectNode(nodeId: string) {
    if (!workflow) return;
    recordHistory();
    const currentWithLayout = syncLatestWorkflow() || syncFlowToWorkflow(workflow, nodesRef.current, edgesRef.current);
    applyWorkflow(disconnectNodes(currentWithLayout, new Set([nodeId])));
  }

  // ─── Frame operations ──────────────────────────────────────────────────────

  function moveFrameContents(frameId: string, delta: { x: number; y: number }) {
    const moved = moveFrameMembers(nodesRef.current, frameId, delta);
    if (!moved.changed) return;
    updateFlowNodes(moved.nodes);
  }

  function expandFramesForNode(nodeId: string) {
    if (frameWrapRafRef.current) {
      window.cancelAnimationFrame(frameWrapRafRef.current);
      frameWrapRafRef.current = null;
    }
    const attached = attachNodeToFrameAtCenter(nodesRef.current, nodeId);
    const cleared = setHighlightedFrame(attached.nodes, null);
    const wrapped = wrapFramesAroundMembers(cleared);
    const nextNodes = wrapped.nodes;
    if (attached.changed || wrapped.changed) updateFlowNodesAndCommit(nextNodes, false);
    else {
      updateFlowNodes(cleared);
      commitFlowToWorkflow(cleared, edgesRef.current);
    }
  }

  function handleNodeDragFrameState(nodeId: string, position: { x: number; y: number }) {
    const current = nodesRef.current;
    const withPosition = current.map((node) => (node.id === nodeId ? { ...node, position } : node));
    const frameId = hoveredFrameForNodeCenter(withPosition, nodeId);
    const highlighted = setHighlightedFrame(withPosition, frameId);
    const dragged = withPosition.find((node) => node.id === nodeId);
    const memberFrameId = typeof dragged?.data.workflowNode.data.frameId === 'string' ? dragged.data.workflowNode.data.frameId : null;
    if (!memberFrameId) {
      if (highlighted !== current) updateFlowNodes(highlighted);
      return;
    }
    if (frameWrapRafRef.current) window.cancelAnimationFrame(frameWrapRafRef.current);
    frameWrapRafRef.current = window.requestAnimationFrame(() => {
      frameWrapRafRef.current = null;
      const wrapped = wrapFramesAroundMembers(highlighted, new Set([memberFrameId]));
      updateFlowNodes(wrapped.nodes);
    });
  }

  function updateFlowNodesAndCommit(nextNodes: UiNode[], shouldRecordHistory = true) {
    if (shouldRecordHistory) recordHistory();
    updateFlowNodes(nextNodes);
    commitFlowToWorkflow(nextNodes, edgesRef.current);
  }

  // ─── Run / Compile ─────────────────────────────────────────────────────────

  const abortRef = useRef<AbortController | null>(null);

  /** Batch-update only specific data fields on output nodes without touching positions or triggering full workflow restore */
  function patchOutputNodes(patches: Map<string, Record<string, unknown>>) {
    let nextNodes = nodesRef.current;
    for (const [nodeId, patch] of patches) {
      const { nodes: updated } = updateNodeWorkflowData(nextNodes, nodeId, patch);
      nextNodes = updated;
    }
    nodesRef.current = nextNodes;
    setNodes(nextNodes);
  }

  function applyGenerationStatus(job: GenerationJobStatus) {
    const patches = outputNodePatchesFromGenerationStatus(job);
    if (patches.size > 0) patchOutputNodes(patches);

    if (job.results?.length) {
      setOutputResults(new Map(job.results.map((result) => [result.outputNodeId, result])));
    }

    if (job.active || job.status === 'running') {
      setStatus('Generating...');
      return;
    }
    if (job.status === 'cancelled') {
      setStatus('Cancelled');
      return;
    }
    if (job.status === 'error') {
      setStatus(job.error || 'Something went wrong');
      return;
    }
    if (job.results?.length) {
      const totalImages = job.results.reduce((sum, result) => sum + result.images.length, 0);
      setStatus(`Generated ${totalImages} image${totalImages === 1 ? '' : 's'}`);
    }
  }

  async function consumeGenerationStream(response: Response) {
    if (!response.body) {
      const text = await response.text();
      for (const event of parseSseEvents(text)) handleGenerationEvent(event);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';
      for (const part of parts) {
        for (const event of parseSseEvents(part)) handleGenerationEvent(event);
      }
    }
    buffer += decoder.decode();
    for (const event of parseSseEvents(buffer)) handleGenerationEvent(event);
  }

  function parseSseEvents(text: string): any[] {
    const events: any[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (!data) continue;
      try {
        events.push(JSON.parse(data));
      } catch {
        // Ignore malformed chunks; the final status poll reconciles state.
      }
    }
    return events;
  }

  function handleGenerationEvent(event: any) {
    if (event?.job) applyGenerationStatus(event.job as GenerationJobStatus);
    if (event?.type === 'done') {
      const results = Array.isArray(event.results) ? event.results as OutputNodeResult[] : [];
      const newResults = new Map<string, OutputNodeResult>();
      let totalImages = 0;
      for (const result of results) {
        newResults.set(result.outputNodeId, result);
        totalImages += result.images.length;
      }
      setOutputResults(newResults);
      setStatus(`Generated ${totalImages} image${totalImages === 1 ? '' : 's'}`);
    } else if (event?.type === 'error') {
      setStatus(event.error || 'Something went wrong');
    }
  }

  async function runWorkflow(mode: GenerationRunMode = 'selected') {
    if (!workflow || !project) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const nextWorkflow = syncFlowToWorkflow(workflow, nodes, edges);
    setWorkflow(nextWorkflow);

    const selectedOutputs = selectedNodeIds().filter((id) =>
      nextWorkflow.nodes.some((node) => node.id === id && node.type === 'codex-output')
    );
    if (mode !== 'all' && selectedOutputs.length === 0) {
      setStatus('Select an output node to run');
      abortRef.current = null;
      return;
    }
    setStatus('Generating...');

    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(project.metadata.id)}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflow: nextWorkflow,
          outputNodeIds: mode === 'all' ? [] : selectedOutputs,
          mode,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        setStatus(body || 'Generation failed');
        return;
      }

      await consumeGenerationStream(response);
      abortRef.current = null;

      // Save workflow with final state
      const savedWorkflow = syncFlowToWorkflow(workflowRef.current!, nodesRef.current, edgesRef.current);
      void fetch(`/api/projects/${encodeURIComponent(project.metadata.id)}/workflow`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflow: savedWorkflow }),
      });
    } catch (err) {
      abortRef.current = null;
      if ((err as Error)?.name === 'AbortError') return; // User cancelled
      setStatus(`Generation failed: ${err}`);
      void refreshGenerationStatus();
    }
  }

  async function refreshGenerationStatus() {
    const currentProject = projectRef.current;
    if (!currentProject) return;
    const response = await fetch(`/api/projects/${encodeURIComponent(currentProject.metadata.id)}/generate-status`);
    if (!response.ok) return;
    applyGenerationStatus(await response.json() as GenerationJobStatus);
  }

  async function cancelWorkflow() {
    const currentProject = projectRef.current;
    if (currentProject) {
      await fetch(`/api/projects/${encodeURIComponent(currentProject.metadata.id)}/generate/cancel`, {
        method: 'POST',
      }).then(async (response) => {
        if (response.ok) applyGenerationStatus(await response.json() as GenerationJobStatus);
      }).catch(() => undefined);
    }
    abortRef.current?.abort();
    abortRef.current = null;
    setStatus('Cancelled');
    // Clear generating state on all output nodes
    const patches = new Map<string, Record<string, unknown>>();
    for (const node of nodesRef.current) {
      if (node.data.workflowNode.type === 'codex-output' && node.data.workflowNode.data.generating) {
        patches.set(node.id, { generating: false });
      }
    }
    if (patches.size > 0) patchOutputNodes(patches);
  }

  async function showCompiledPrompt(nodeId?: string) {
    const currentProject = projectRef.current;
    const currentWorkflow = workflowRef.current;
    if (!currentWorkflow || !currentProject) {
      setStatus('Open a project before compiling the prompt');
      return;
    }
    try {
      const nextWorkflow = syncFlowToWorkflow(currentWorkflow, nodesRef.current, edgesRef.current);
      const response = await fetch(`/api/projects/${encodeURIComponent(currentProject.metadata.id)}/compile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflow: nextWorkflow, outputNodeId: nodeId }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: response.statusText }));
        setStatus(body.error || 'Failed to compile prompt');
        return;
      }
      const data = (await response.json()) as { prompt?: string };
      const prompt = data.prompt ?? '';
      deps.setPromptOverlay({ prompt });
      return prompt;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to compile prompt');
      return undefined;
    }
  }

  // ─── Return ────────────────────────────────────────────────────────────────

  return {
    // State
    nodes,
    edges,
    selectedId,
    selectedNode,
    placingNodeId,
    activeCustomField,
    nodesRef,
    edgesRef,
    flowApiRef,
    lastMousePosRef,

    // Setters
    setNodes,
    setEdges,
    setSelectedId,

    // Actions
    addNode,
    deleteNode,
    deleteSelection,
    duplicateSelection,
    disconnectHandle,
    disconnectSelection,
    detachSelectionFromFrames,
    addCustomField,
    updateCustomFieldValue,
    duplicateActiveCustomField,
    updateNodeData,
    openNodeMenu,
    clearSelection,
    recordHistory,
    undo,
    redo,
    clearHistory,
    runWorkflow,
    cancelWorkflow,
    refreshGenerationStatus,
    showCompiledPrompt,
    updateFlowNodes,
    updateFlowEdges,
    moveFrameContents,
    handleNodeDragFrameState,
    expandFramesForNode,
    handleSelectionChange,
    handlePlacingMove,
    handlePlacingDrop,
    applyWorkflow,
    patchOutputNodes,
    restoreWorkflowSnapshot,
    commitFlowToWorkflow,
    selectAssetForField: selectAssetForFieldImpl,
    openAssetPickerForField,
    openAssetLibrary,
    addImageAssetNode,
    addNodeAsset,
    addWorkflowNodesForPlacement,
    removeFrameOnly: removeFrameOnlyAction,
    duplicateNode,
    disconnectNode,
    selectedNodeIds,
    selectedEdgeIds,
    expandFrameSelection,

    // History info
    historyLimit,
    setHistoryLimit,
    historyVersion,
    undoCount: undoStackRef.current.length,
    redoCount: redoStackRef.current.length,
  };
}

function sanitizeNodeAssetNodeForInsert(node: ImageXNode): ImageXNode {
  const data = { ...node.data };
  delete data.isDropTargetFrame;
  if (node.type === 'codex-output') {
    delete data.previewUrl;
    delete data.previewUrls;
    delete data.previewIndex;
    delete data.generating;
    delete data.generation;
  }
  const assetUrl = typeof data.assetUrl === 'string' ? data.assetUrl : '';
  if (assetUrl.includes('/outputs/runs/')) {
    delete data.assetId;
    delete data.assetUrl;
    delete data.assetName;
    for (const [key, value] of Object.entries(data)) {
      if (value === assetUrl) data[key] = '';
    }
  }
  return { ...node, data };
}
