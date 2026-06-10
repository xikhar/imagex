import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  ConnectionLineType,
  type EdgeChange,
  MarkerType,
  type NodeChange,
  type NodeMouseHandler,
  type OnNodeDrag,
  type OnSelectionChangeFunc,
  SelectionMode,
  type ReactFlowInstance,
  type Viewport,
  ConnectionMode,
} from '@xyflow/react';
import './styles.css';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import type { NodeType } from '../../../../shared/types.js';
import { nodeMeta } from '../../flow/meta.js';
import { flowStore, useFlowNodes, useFlowEdges, useFlowGraphVersion, useFlowHasFrames } from '../../../state/flowStore.js';
import { edgeReferencesExistingPorts, isCompatibleConnection } from '../../flow/ports.js';
import type { UiEdge, UiNode } from '../../flow/types.js';
import {
  BlurNode,
  CodexOutputNode,
  ColorBalanceNode,
  ColorNode,
  CropNode,
  DownloadNode,
  FileNode,
  FrameNode,
  ImageNode,
  PromptNode,
  RotateFlipNode,
} from '../../flow/nodes/ImageXNode.js';
import { graphEngine } from '../../../state/graphEngine.js';
import { refreshPreviewSurfaces } from '../../flow/imaging/index.js';
import {
  hoveredFrameForNodeCenter,
  moveFrameWithMembers,
  refreshFrameSelectionState,
  restoreNodePositions,
  setHighlightedFrame,
  wrapFramesAroundMembers,
} from '../../graph/operations.js';

const nodeTypes = {
  prompt: PromptNode,
  image: ImageNode,
  color: ColorNode,
  file: FileNode,
  'codex-output': CodexOutputNode,
  'color-balance': ColorBalanceNode,
  'rotate-flip': RotateFlipNode,
  crop: CropNode,
  blur: BlurNode,
  download: DownloadNode,
  frame: FrameNode,
};

type FlowMouseEvent = MouseEvent | ReactMouseEvent;

export function FlowEditor({
  onSelectNode,
  onNodeMenu,
  onBeforeChange,
  onPaneMenu,
  onSelectionMenu,
  onSelectionChangeIds,
  onNodeDragStopCheckFrames,
  onPaneClickClear,
  onCommitFlow,
  onFlowReady,
  placingNodeId,
  onPlacingMove,
  onPlacingDrop,
  showMinimap,
}: {
  onSelectNode: (nodeId: string | null) => void;
  onNodeMenu: (nodeId: string, position: { x: number; y: number }) => void;
  onBeforeChange: () => void;
  onPaneMenu: (position: { x: number; y: number }, flowPosition: { x: number; y: number }) => void;
  onSelectionMenu: (position: { x: number; y: number }) => void;
  onSelectionChangeIds: (nodeIds: string[], edgeIds: string[]) => void;
  onNodeDragStopCheckFrames: (nodeId: string) => void;
  onPaneClickClear: () => void;
  onCommitFlow: () => void;
  onFlowReady?: (api: {
    screenToFlowPosition: (p: { x: number; y: number }) => { x: number; y: number };
    zoomIn: () => void;
    zoomOut: () => void;
    fitView: () => void;
  }) => void;
  placingNodeId?: string | null;
  onPlacingMove?: (nodeId: string, position: { x: number; y: number }) => void;
  onPlacingDrop?: () => void;
  showMinimap?: boolean;
}) {
  // Read nodes/edges from FlowStore (not props) — avoids parent re-render cascades
  const nodes = useFlowNodes();
  const edges = useFlowEdges();
  const graphVersion = useFlowGraphVersion();
  const hasFrames = useFlowHasFrames();

  // Keep GraphEngine in sync with the current graph topology
  useEffect(() => {
    const workflowNodes = flowStore.getWorkflowNodes();
    const currentEdges = flowStore.getEdges();
    const validEdges = currentEdges.filter((edge) => edgeReferencesExistingPorts(edge, workflowNodes));
    if (validEdges.length !== currentEdges.length) {
      flowStore.setEdges(validEdges);
      return;
    }

    const workflowEdges = validEdges.map((e) => {
      const edge: import('../../../../shared/types.js').ImageXEdge = {
        id: e.id,
        source: e.source,
        target: e.target,
      };
      if (e.sourceHandle != null) edge.sourceHandle = e.sourceHandle;
      if (e.targetHandle != null) edge.targetHandle = e.targetHandle;
      return edge;
    });
    graphEngine.setGraph(workflowNodes, workflowEdges);
  }, [graphVersion]);

  const edgeReconnectSuccessful = useRef(true);
  const frameDragRef = useRef<{
    id: string;
    position: { x: number; y: number };
    memberIds: Set<string>;
    externalPositions: Map<string, { x: number; y: number }>;
  } | null>(null);
  const reactFlowRef = useRef<ReactFlowInstance<UiNode, UiEdge> | null>(null);
  const canvasRef = useRef<HTMLElement | null>(null);
  const lastViewportZoomRef = useRef<number | null>(null);
  const zoomingTimeoutRef = useRef<number | null>(null);
  const [flowReadyVersion, setFlowReadyVersion] = useState(0);

  useEffect(() => {
    return () => {
      if (zoomingTimeoutRef.current) window.clearTimeout(zoomingTimeoutRef.current);
    };
  }, []);

  // Stable change handlers — write to flowStore only (App subscribes via flowStore)
  const handleNodesChange = useCallback(
    (changes: NodeChange<UiNode>[]) => {
      if (changes.length === 0) return;
      const current = flowStore.getNodes();
      const next = refreshFrameSelectionState(applyNodeChanges(changes, current));
      const transient = changes.every((change) => change.type === 'position' && change.dragging);
      const graphChanged = changes.some((change) => change.type === 'add' || change.type === 'remove' || change.type === 'replace');
      flowStore.setNodes(next, { transient, graph: graphChanged });
    },
    []
  );
  const handleEdgesChange = useCallback(
    (changes: EdgeChange<UiEdge>[]) => {
      if (changes.length === 0) return;
      const current = flowStore.getEdges();
      const next = applyEdgeChanges(changes, current);
      const graphChanged = changes.some((change) => change.type !== 'select');
      flowStore.setEdges(next, { graph: graphChanged });
    },
    []
  );
  const handleConnect = useCallback(
    (connection: Connection) => {
      const currentNodes = flowStore.getNodes();
      const currentEdges = flowStore.getEdges();
      if (!isCompatibleConnection(connection, flowStore.getWorkflowNodes(), currentEdges)) return;
      onBeforeChange();
      const source = currentNodes.find((node) => node.id === connection.source);
      const target = currentNodes.find((node) => node.id === connection.target);
      const nextNodes = resetOutputPreviewForTarget(currentNodes, target);
      if (nextNodes !== currentNodes) flowStore.setNodes(nextNodes);
      const baseEdges = removeExistingSingleImageInputEdges(currentEdges, target, connection.targetHandle);
      const nextEdges = addEdge(styleConnection(connection, source, target), baseEdges);
      flowStore.setEdges(nextEdges);
    },
    [onBeforeChange]
  );

  const handleReconnect = useCallback(
    (oldEdge: UiEdge, newConnection: Connection) => {
      if (!newConnection.target || !newConnection.targetHandle) return;
      const currentNodes = flowStore.getNodes();
      const currentEdges = flowStore.getEdges();
      if (!isCompatibleConnection(newConnection, flowStore.getWorkflowNodes(), currentEdges)) return;
      onBeforeChange();
      edgeReconnectSuccessful.current = true;
      const source = currentNodes.find((node) => node.id === newConnection.source);
      const target = currentNodes.find((node) => node.id === newConnection.target);
      const nextNodes = resetOutputPreviewForTarget(currentNodes, target);
      if (nextNodes !== currentNodes) flowStore.setNodes(nextNodes);
      const baseEdges = removeExistingSingleImageInputEdges(currentEdges, target, newConnection.targetHandle, oldEdge.id);
      const nextEdges = baseEdges.map((edge) =>
        edge.id === oldEdge.id ? { ...styleConnection(newConnection, source, target), id: oldEdge.id } : edge
      );
      flowStore.setEdges(nextEdges);
    },
    [onBeforeChange]
  );
  const handleReconnectStart = useCallback(() => {
    edgeReconnectSuccessful.current = false;
  }, []);
  const handleReconnectEnd = useCallback(
    (_: MouseEvent | TouchEvent, edge: UiEdge) => {
      if (!edgeReconnectSuccessful.current) {
        onBeforeChange();
        const nextEdges = flowStore.getEdges().filter((candidate) => candidate.id !== edge.id);
        flowStore.setEdges(nextEdges);
      }
      edgeReconnectSuccessful.current = true;
    },
    [onBeforeChange]
  );

  const memoizedEdgeOptions = useMemo(
    () => ({ type: 'default' as const, reconnectable: true as const, zIndex: 5 }),
    []
  );
  const memoizedFitViewOptions = useMemo(() => ({ padding: 0.2 }), []);
  const memoizedPanOnDrag = useMemo(() => [1, 2] as [number, number], []);
  const handleInit = useCallback(
    (instance: ReactFlowInstance<UiNode, UiEdge>) => {
      reactFlowRef.current = instance;
      setFlowReadyVersion((version) => version + 1);
      onFlowReady?.({
        screenToFlowPosition: instance.screenToFlowPosition.bind(instance),
        zoomIn: instance.zoomIn.bind(instance),
        zoomOut: instance.zoomOut.bind(instance),
        fitView: instance.fitView.bind(instance),
      });
    },
    [onFlowReady]
  );
  const handleIsValidConnection = useCallback(
    (connection: Connection | UiEdge) => isCompatibleConnection(connection, flowStore.getWorkflowNodes(), flowStore.getEdges()),
    [],
  );
  const updateFrameStateForNodeDrag = useCallback((nodeId: string) => {
    const current = flowStore.getNodes();
    const dragged = current.find((candidate) => candidate.id === nodeId);
    if (!dragged || dragged.type === 'frame') return;

    const hoveredFrameId = hoveredFrameForNodeCenter(current, nodeId);
    let nextNodes = setHighlightedFrame(current, hoveredFrameId);
    const selectedDraggedNodes = current.filter((candidate) => candidate.selected && candidate.type !== 'frame');
    const impactedFrameIds = new Set<string>();
    for (const candidate of selectedDraggedNodes.length ? selectedDraggedNodes : [dragged]) {
      const frameId = candidate.data.workflowNode.data.frameId;
      if (typeof frameId === 'string') impactedFrameIds.add(frameId);
    }
    if (impactedFrameIds.size > 0) {
      nextNodes = wrapFramesAroundMembers(nextNodes, impactedFrameIds).nodes;
    }
    if (nextNodes !== current) flowStore.setNodes(nextNodes, { transient: true, graph: false });
  }, []);
  const handleNodeDragStart = useCallback<NodeMouseHandler<UiNode>>((_, node) => {
    if (placingNodeId) return;
    onBeforeChange();
    if (node.type === 'frame') {
      const current = flowStore.getNodes();
      const memberIds = new Set(
        current
          .filter((candidate) => candidate.type !== 'frame' && candidate.data.workflowNode.data.frameId === node.id)
          .map((candidate) => candidate.id)
      );
      const externalPositions = new Map(
        current
          .filter((candidate) => candidate.id !== node.id && !memberIds.has(candidate.id))
          .map((candidate) => [candidate.id, candidate.data.workflowNode.position])
      );
      frameDragRef.current = { id: node.id, position: node.position, memberIds, externalPositions };
    }
  }, [onBeforeChange, placingNodeId]);
  const handleNodeDrag = useCallback<OnNodeDrag<UiNode>>((_, node) => {
    const active = frameDragRef.current;
    if (node.type !== 'frame') {
      if (hasFrames) updateFrameStateForNodeDrag(node.id);
      return;
    }
    if (!active || node.id !== active.id) return;
    const delta = { x: node.position.x - active.position.x, y: node.position.y - active.position.y };
    const moved = moveFrameWithMembers(flowStore.getNodes(), node.id, node.position, delta);
    const restored = restoreNodePositions(moved.nodes, active.externalPositions);
    if (moved.changed || restored !== moved.nodes) {
      flowStore.setNodes(restored, { transient: true, graph: false });
    }
    frameDragRef.current = { ...active, position: node.position };
  }, [hasFrames, updateFrameStateForNodeDrag]);
  const handleNodeDragStop = useCallback<OnNodeDrag<UiNode>>((_, node, draggedNodes) => {
    // Persist final positions to the durable flow store after transient live drag updates.
    const finalPositions = new Map(draggedNodes.map((draggedNode) => [draggedNode.id, draggedNode.position]));
    const activeFrameDrag = frameDragRef.current;
    if (node.type === 'frame' && activeFrameDrag?.id === node.id) {
      const updatedNodes = flowStore.getNodes().map((currentNode) => {
        const externalPosition = activeFrameDrag.externalPositions.get(currentNode.id);
        if (externalPosition) return { ...currentNode, position: externalPosition };
        const finalPosition = currentNode.id === node.id || activeFrameDrag.memberIds.has(currentNode.id)
          ? finalPositions.get(currentNode.id)
          : undefined;
        return finalPosition ? { ...currentNode, position: finalPosition } : currentNode;
      });
      flowStore.setNodes(updatedNodes, { graph: false });
      frameDragRef.current = null;
      onCommitFlow();
      return;
    }

    const updatedNodes = flowStore.getNodes().map((currentNode) => {
      const position = finalPositions.get(currentNode.id);
      return position ? { ...currentNode, position } : currentNode;
    });
    flowStore.setNodes(updatedNodes, { graph: false });

    frameDragRef.current = null;
    if (node.type !== 'frame') {
      const settledNodeIds = new Set(draggedNodes.filter((draggedNode) => draggedNode.type !== 'frame').map((draggedNode) => draggedNode.id));
      if (settledNodeIds.size === 0) settledNodeIds.add(node.id);
      for (const nodeId of settledNodeIds) onNodeDragStopCheckFrames(nodeId);
      return;
    }
    onCommitFlow();
  }, [onCommitFlow, onNodeDragStopCheckFrames]);
  const handleNodeClick = useCallback<NodeMouseHandler<UiNode>>((_, node) => {
    if (placingNodeId) {
      onPlacingDrop?.();
      return;
    }
    onSelectNode(node.id);
  }, [onPlacingDrop, onSelectNode, placingNodeId]);
  const handleNodeContextMenu = useCallback<NodeMouseHandler<UiNode>>((event, node) => {
    event.preventDefault();
    onNodeMenu(node.id, { x: event.clientX, y: event.clientY });
  }, [onNodeMenu]);
  const handleSelectionContextMenu = useCallback((event: FlowMouseEvent) => {
    event.preventDefault();
    onSelectionMenu({ x: event.clientX, y: event.clientY });
  }, [onSelectionMenu]);
  const handlePaneContextMenu = useCallback((event: FlowMouseEvent) => {
    event.preventDefault();
    if (placingNodeId) {
      onPlacingDrop?.();
      return;
    }
    onPaneMenu(
      { x: event.clientX, y: event.clientY },
      reactFlowRef.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY }) || { x: 0, y: 0 }
    );
  }, [onPaneMenu, onPlacingDrop, placingNodeId]);
  const handleSelectionChange = useCallback<OnSelectionChangeFunc<UiNode, UiEdge>>(
    ({ nodes: selectedNodes, edges: selectedEdges }) => {
      onSelectionChangeIds(
        selectedNodes.map((node) => node.id),
        selectedEdges.map((edge) => edge.id)
      );
    },
    [onSelectionChangeIds]
  );
  const handleEdgeDoubleClick = useCallback((_: ReactMouseEvent, edge: UiEdge) => {
    onBeforeChange();
    const nextEdges = flowStore.getEdges().filter((candidate) => candidate.id !== edge.id);
    flowStore.setEdges(nextEdges);
  }, [onBeforeChange]);
  const handlePaneClick = useCallback(() => {
    if (placingNodeId) {
      onPlacingDrop?.();
      return;
    }
    onPaneClickClear();
  }, [onPaneClickClear, onPlacingDrop, placingNodeId]);
  const minimapNodeColor = useCallback((node: UiNode) => nodeMeta[node.type as NodeType].accent, []);
  const clearZoomingClass = useCallback(() => {
    zoomingTimeoutRef.current = null;
    canvasRef.current?.classList.remove('viewport-zooming');
  }, []);
  const handleMove = useCallback((_: MouseEvent | TouchEvent | null, viewport: Viewport) => {
    const previousZoom = lastViewportZoomRef.current;
    lastViewportZoomRef.current = viewport.zoom;
    if (previousZoom === null || Math.abs(previousZoom - viewport.zoom) < 0.0001) return;

    canvasRef.current?.classList.add('viewport-zooming');
    if (zoomingTimeoutRef.current) window.clearTimeout(zoomingTimeoutRef.current);
    zoomingTimeoutRef.current = window.setTimeout(clearZoomingClass, 140);
  }, [clearZoomingClass]);

  const mediaSurfacePlan = useMemo(
    () => ({
      key: mediaSurfaceKey(nodes, edges),
      expectedCanvasCount: expectedConnectedCanvasCount(nodes, edges),
    }),
    [nodes, edges]
  );

  useEffect(() => {
    if (!flowReadyVersion || !mediaSurfacePlan.key) return;
    const root = canvasRef.current;
    if (!root) return;
    const controller = new AbortController();

    void waitForMediaSurfaces(root, mediaSurfacePlan.expectedCanvasCount, controller.signal)
      .then(() => {
        if (!controller.signal.aborted) refreshPreviewSurfaces();
      })
      .catch(() => {
        // A newer workflow/media pass superseded this one.
      });

    return () => controller.abort();
  }, [flowReadyVersion, mediaSurfacePlan.key, mediaSurfacePlan.expectedCanvasCount]);

  useEffect(() => {
    const canvas = document.querySelector('.react-flow__pane') as HTMLElement | null;
    if (!canvas) return;
    if (placingNodeId) {
      canvas.style.cursor = 'crosshair';
    } else {
      canvas.style.cursor = '';
    }
  }, [placingNodeId]);

  useEffect(() => {
    if (!placingNodeId || !reactFlowRef.current || !onPlacingMove) return;
    const handleMouseMove = (event: MouseEvent) => {
      const position = reactFlowRef.current!.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      onPlacingMove(placingNodeId, position);
    };
    document.addEventListener('mousemove', handleMouseMove);
    return () => document.removeEventListener('mousemove', handleMouseMove);
  }, [placingNodeId, onPlacingMove]);

  return (
    <section className="canvas" ref={canvasRef}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onInit={handleInit}
        onConnect={handleConnect}
        onReconnect={handleReconnect}
        onReconnectStart={handleReconnectStart}
        onReconnectEnd={handleReconnectEnd}
        onNodeDragStart={handleNodeDragStart}
        onNodeDrag={handleNodeDrag}
        onNodeDragStop={handleNodeDragStop}
        edgesReconnectable
        reconnectRadius={16}
        connectionRadius={40}
        isValidConnection={handleIsValidConnection}
        onNodeClick={handleNodeClick}
        onNodeContextMenu={handleNodeContextMenu}
        onSelectionContextMenu={handleSelectionContextMenu}
        onPaneContextMenu={handlePaneContextMenu}
        onSelectionChange={handleSelectionChange}
        onEdgeDoubleClick={handleEdgeDoubleClick}
        onPaneClick={handlePaneClick}
        onMove={handleMove}
        fitView
        fitViewOptions={memoizedFitViewOptions}
        minZoom={0.25}
        maxZoom={2.5}
        selectionOnDrag
        selectionMode={SelectionMode.Partial}
        selectionKeyCode={null}
        panOnDrag={memoizedPanOnDrag}
        connectOnClick={false}
        connectionMode={ConnectionMode.Strict}
        connectionLineType={ConnectionLineType.Bezier}
        defaultEdgeOptions={memoizedEdgeOptions}
        elevateNodesOnSelect={false}
        nodeDragThreshold={1}
        deleteKeyCode={null}
        multiSelectionKeyCode={null}
        zoomOnDoubleClick={false}
      >
        <Background variant={BackgroundVariant.Dots} color="rgba(255,255,255,0.08)" gap={24} size={1} />
        {showMinimap !== false && (
          <MiniMap
            pannable
            zoomable
            nodeColor={minimapNodeColor}
            maskColor="rgba(2, 6, 23, 0.72)"
          />
        )}
      </ReactFlow>
    </section>
  );
}

function resetOutputPreviewForTarget(nodes: UiNode[], target: UiNode | undefined): UiNode[] {
  if (!target || target.type !== 'codex-output') return nodes;
  const data = target.data.workflowNode.data;
  const hasGeneratedPreview =
    Boolean(data.previewUrl) ||
    (Array.isArray(data.previewUrls) && data.previewUrls.length > 0) ||
    Boolean(data.generation) ||
    Boolean(data.generating);
  if (!hasGeneratedPreview) return nodes;

  return nodes.map((node) => {
    if (node.id !== target.id) return node;
    const {
      previewUrl: _previewUrl,
      previewUrls: _previewUrls,
      previewIndex: _previewIndex,
      generation: _generation,
      generating: _generating,
      ...restData
    } = node.data.workflowNode.data;
    return {
      ...node,
      data: {
        ...node.data,
        workflowNode: {
          ...node.data.workflowNode,
          data: restData,
        },
      },
    };
  });
}

function removeExistingSingleImageInputEdges(
  edges: UiEdge[],
  target: UiNode | undefined,
  targetHandle: string | null | undefined,
  keepEdgeId?: string
): UiEdge[] {
  if (!target || targetHandle !== 'image-in' || !SINGLE_IMAGE_INPUT_NODE_TYPES.has(String(target.type))) {
    return edges;
  }
  return edges.filter((edge) => {
    if (edge.id === keepEdgeId) return true;
    return !(edge.target === target.id && edge.targetHandle === targetHandle);
  });
}

function styleConnection(connection: Connection, source: UiNode | undefined, target: UiNode | undefined): UiEdge {
  const accent = source ? nodeMeta[source.type as NodeType].accent : '#7a7a7a';
  return {
    id: `${connection.source}-${connection.sourceHandle}-${connection.target}-${connection.targetHandle}`,
    source: connection.source || '',
    target: connection.target || '',
    sourceHandle: connection.sourceHandle ?? null,
    targetHandle: connection.targetHandle ?? null,
    type: 'default',
    reconnectable: true,
    markerEnd: {
      type: MarkerType.ArrowClosed,
      width: 14,
      height: 14,
      color: accent,
    },
    style: {
      stroke: accent,
      strokeWidth: 2,
    },
  };
}

const CANVAS_PREVIEW_NODE_TYPES = new Set(['rotate-flip', 'color-balance', 'crop', 'blur', 'download']);
const MEDIA_SURFACE_NODE_TYPES = new Set(['image', 'codex-output', ...CANVAS_PREVIEW_NODE_TYPES]);
const SINGLE_IMAGE_INPUT_NODE_TYPES = new Set(['rotate-flip', 'color-balance', 'crop', 'blur', 'download']);

function mediaSurfaceKey(nodes: UiNode[], edges: UiEdge[]): string {
  const mediaNodes = nodes
    .filter((node) => MEDIA_SURFACE_NODE_TYPES.has(String(node.type)))
    .map((node) => {
      const data = node.data.workflowNode.data;
      return {
        id: node.id,
        type: node.type,
        assetUrl: data.assetUrl,
        image: data.image,
        previewUrl: data.previewUrl,
        previewUrls: data.previewUrls,
      };
    });
  if (mediaNodes.length === 0) return '';

  const mediaNodeIds = new Set(mediaNodes.map((node) => node.id));
  const mediaEdges = edges
    .filter((edge) => mediaNodeIds.has(edge.source) || mediaNodeIds.has(edge.target))
    .map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
    }));

  return JSON.stringify({ mediaNodes, mediaEdges });
}

function expectedConnectedCanvasCount(nodes: UiNode[], edges: UiEdge[]): number {
  const connectedTargets = new Set(edges.map((edge) => edge.target));
  return nodes.filter((node) => CANVAS_PREVIEW_NODE_TYPES.has(String(node.type)) && connectedTargets.has(node.id)).length;
}

function waitForMediaSurfaces(root: HTMLElement, expectedCanvasCount: number, signal: AbortSignal): Promise<void> {
  const quietMs = 180;
  const maxMs = 6_000;

  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    let animationFrame = 0;
    let readySince = 0;
    const startedAt = performance.now();
    const observer = new ResizeObserver(() => {
      readySince = 0;
    });

    const cleanup = () => {
      observer.disconnect();
      if (animationFrame) cancelAnimationFrame(animationFrame);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const finish = () => {
      cleanup();
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    };

    signal.addEventListener('abort', onAbort, { once: true });
    observeMediaLayoutTargets(root, observer);

    const check = () => {
      const now = performance.now();
      if (mediaSurfacesReady(root, expectedCanvasCount)) {
        readySince ||= now;
        if (now - readySince >= quietMs || now - startedAt >= maxMs) {
          finish();
          return;
        }
      } else {
        readySince = 0;
      }

      if (now - startedAt >= maxMs) {
        finish();
        return;
      }

      animationFrame = requestAnimationFrame(check);
    };

    animationFrame = requestAnimationFrame(check);
  });
}

function observeMediaLayoutTargets(root: HTMLElement, observer: ResizeObserver): void {
  const targets = root.querySelectorAll(
    '.react-flow__renderer, .react-flow__node, .ix-edit-preview, .ix-output-preview, .ix-asset-preview, .ix-crop-area'
  );
  for (const target of targets) observer.observe(target);
}

function mediaSurfacesReady(root: HTMLElement, expectedCanvasCount: number): boolean {
  const canvases = [...root.querySelectorAll('canvas.ix-canvas-preview')] as HTMLCanvasElement[];
  const readyCanvases = canvases.filter((canvas) => {
    const rect = canvas.getBoundingClientRect();
    return getComputedStyle(canvas).display !== 'none' && canvas.width > 0 && canvas.height > 0 && rect.width > 0 && rect.height > 0;
  });
  if (readyCanvases.length < expectedCanvasCount) return false;

  const images = [...root.querySelectorAll('.ix-output-preview img, .ix-asset-preview img')] as HTMLImageElement[];
  return images.every((image) => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0);
}
