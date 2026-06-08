import type { ImageXEdge, ImageXNode, ImageXWorkflow } from '../../../shared/types.js';
import type { UiEdge, UiNode } from '../flow/types.js';
import { containsPoint, nodeRect } from './geometry.js';

const FRAME_PADDING = 24;
const FRAME_HEADER_HEIGHT = 44;
const FRAME_HEADER_GAP = 20;

export type GraphMutation<T = undefined> = {
  nodes: UiNode[];
  edges?: UiEdge[];
  changed: boolean;
  value?: T;
};

export function cloneWorkflow(workflow: ImageXWorkflow): ImageXWorkflow {
  return {
    ...workflow,
    nodes: workflow.nodes.map((node) => cloneWorkflowNode(node)),
    edges: workflow.edges.map((edge) => ({ ...edge })),
    settings: { ...workflow.settings },
  };
}

export function cloneWorkflowNode(node: ImageXNode): ImageXNode {
  return {
    ...node,
    position: { ...node.position },
    data: structuredClone(node.data),
  };
}

export function snapshotsEqual<T>(left: T, right: T): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function refreshConnectedTargetHandles(nodes: UiNode[], edges: UiEdge[]): UiNode[] {
  const targetHandlesByNode = new Map<string, string[]>();
  for (const edge of edges) {
    if (!edge.target || !edge.targetHandle) continue;
    const handles = targetHandlesByNode.get(edge.target) ?? [];
    handles.push(edge.targetHandle);
    targetHandlesByNode.set(edge.target, handles);
  }
  return nodes.map((node) => ({
    ...node,
    data: {
      ...node.data,
      connectedTargetHandles: targetHandlesByNode.get(node.id) ?? [],
    },
  }));
}

export function refreshFrameSelectionState(nodes: UiNode[]): UiNode[] {
  const selectedFrameIds = new Set(
    nodes
      .filter((node) => node.selected && node.type !== 'frame')
      .map((node) => node.data.workflowNode.data.frameId)
      .filter((frameId): frameId is string => typeof frameId === 'string')
  );
  let changed = false;
  const nextNodes = nodes.map((node) => {
    if (node.type !== 'frame') return node;
    const hasSelectedFrameMember = selectedFrameIds.has(node.id);
    if (Boolean(node.data.hasSelectedFrameMember) === hasSelectedFrameMember) return node;
    changed = true;
    return {
      ...node,
      data: {
        ...node.data,
        hasSelectedFrameMember,
      },
    };
  });
  return changed ? nextNodes : nodes;
}

export function updateNodeWorkflowData(nodes: UiNode[], nodeId: string, patch: Record<string, unknown>): GraphMutation {
  let changed = false;
  const nextNodes = nodes.map((node) => {
    if (node.id !== nodeId) return node;
    changed = true;
    const workflowNode = {
      ...node.data.workflowNode,
      data: { ...node.data.workflowNode.data, ...patch },
    };
    return { ...node, data: { ...node.data, workflowNode } };
  });
  return { nodes: nextNodes, changed };
}

export function frameMembers(frameId: string, nodes: UiNode[]): UiNode[] {
  return nodes.filter((node) => node.id !== frameId && node.type !== 'frame' && node.data.workflowNode.data.frameId === frameId);
}

export function selectedNodeIds(nodes: UiNode[]): string[] {
  return nodes.filter((node) => node.selected).map((node) => node.id);
}

export function selectedEdgeIds(edges: UiEdge[]): string[] {
  return edges.filter((edge) => edge.selected).map((edge) => edge.id);
}

export function expandSelectionWithFrameMembers(selected: Set<string>, nodes: UiNode[]): Set<string> {
  const expanded = new Set(selected);
  for (const node of nodes) {
    if (node.type !== 'frame' || !expanded.has(node.id)) continue;
    for (const member of frameMembers(node.id, nodes)) expanded.add(member.id);
  }
  return expanded;
}

export function moveFrameMembers(nodes: UiNode[], frameId: string, delta: { x: number; y: number }): GraphMutation {
  const memberIds = new Set(frameMembers(frameId, nodes).filter((node) => !node.selected).map((node) => node.id));
  if (memberIds.size === 0) return { nodes, changed: false };
  return {
    changed: true,
    nodes: nodes.map((node) => {
      if (!memberIds.has(node.id)) return node;
      return {
        ...node,
        position: { x: node.position.x + delta.x, y: node.position.y + delta.y },
      };
    }),
  };
}

export function moveFrameWithMembers(
  nodes: UiNode[],
  frameId: string,
  framePosition: { x: number; y: number },
  delta: { x: number; y: number }
): GraphMutation {
  const memberIds = new Set(frameMembers(frameId, nodes).filter((node) => !node.selected).map((node) => node.id));
  let changed = false;
  const nextNodes = nodes.map((node) => {
    if (node.id === frameId) {
      if (node.position.x === framePosition.x && node.position.y === framePosition.y) return node;
      changed = true;
      return { ...node, position: framePosition };
    }
    if (!memberIds.has(node.id)) return node;
    if (!delta.x && !delta.y) return node;
    changed = true;
    return {
      ...node,
      position: { x: node.position.x + delta.x, y: node.position.y + delta.y },
    };
  });
  return { nodes: changed ? nextNodes : nodes, changed };
}

export function attachNodeToFrameAtCenter(nodes: UiNode[], nodeId: string): GraphMutation<{ frameId: string | null }> {
  const dragged = nodes.find((node) => node.id === nodeId);
  if (!dragged || dragged.type === 'frame') return { nodes, changed: false };

  const draggedBounds = nodeRect(dragged);
  const center = {
    x: draggedBounds.left + draggedBounds.width / 2,
    y: draggedBounds.top + draggedBounds.height / 2,
  };
  const targetFrame = nodes
    .filter((node) => node.type === 'frame')
    .filter((frame) => containsPoint(nodeRect(frame), center))
    .sort((left, right) => rectArea(nodeRect(left)) - rectArea(nodeRect(right)))[0];
  const targetFrameId = targetFrame?.id;
  const previousFrameId = typeof dragged.data.workflowNode.data.frameId === 'string' ? dragged.data.workflowNode.data.frameId : undefined;
  if (!targetFrameId) return { nodes, changed: false, value: { frameId: null } };
  if (previousFrameId === targetFrameId) return wrapFramesAroundMembers(nodes, new Set([targetFrameId]), { frameId: targetFrameId });

  const nextNodes = nodes.map((node) => {
    if (node.id !== dragged.id) return node;
    const data = { ...node.data.workflowNode.data };
    data.frameId = targetFrameId;
    return withWorkflowData(node, data);
  });

  return wrapFramesAroundMembers(nextNodes, new Set([targetFrameId, previousFrameId].filter(Boolean) as string[]), { frameId: targetFrameId });
}

export function detachNodesFromFrames(nodes: UiNode[], nodeIds: Set<string>): GraphMutation {
  const affectedFrames = new Set<string>();
  let changed = false;
  const nextNodes = nodes.map((node) => {
    const currentFrameId = typeof node.data.workflowNode.data.frameId === 'string' ? node.data.workflowNode.data.frameId : undefined;
    if (!nodeIds.has(node.id) || !currentFrameId) return node;
    affectedFrames.add(currentFrameId);
    changed = true;
    const data = { ...node.data.workflowNode.data };
    delete data.frameId;
    return withWorkflowData(node, data);
  });
  if (!changed) return { nodes, changed: false };
  return wrapFramesAroundMembers(nextNodes, affectedFrames);
}

export function wrapFramesAroundMembers<T = undefined>(nodes: UiNode[], frameIds?: Set<string>, value?: T): GraphMutation<T> {
  const targetFrameIds = frameIds ?? new Set(nodes.filter((node) => node.type === 'frame').map((node) => node.id));
  let changed = false;
  const nextNodes = nodes.map((node) => {
    if (node.type !== 'frame' || !targetFrameIds.has(node.id)) return node;
    const members = frameMembers(node.id, nodes);
    if (members.length === 0) return node;
    const bounds = boundsForNodes(members, FRAME_PADDING);
    if (!bounds) return node;
    const current = nodeRect(node);
    if (
      Math.round(current.left) === Math.round(bounds.x) &&
      Math.round(current.top) === Math.round(bounds.y) &&
      Math.round(current.width) === Math.round(bounds.width) &&
      Math.round(current.height) === Math.round(bounds.height)
    ) {
      return node;
    }
    changed = true;
    return frameWithBounds(node, bounds);
  });
  const mutation: GraphMutation<T> = { nodes: changed ? nextNodes : nodes, changed };
  if (value !== undefined) mutation.value = value;
  return mutation;
}

export function hoveredFrameForNodeCenter(nodes: UiNode[], nodeId: string): string | null {
  const node = nodes.find((candidate) => candidate.id === nodeId);
  if (!node || node.type === 'frame') return null;
  const bounds = nodeRect(node);
  const center = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
  const frame = nodes
    .filter((candidate) => candidate.type === 'frame')
    .filter((candidate) => containsPoint(nodeRect(candidate), center))
    .sort((left, right) => rectArea(nodeRect(left)) - rectArea(nodeRect(right)))[0];
  return frame?.id ?? null;
}

export function setHighlightedFrame(nodes: UiNode[], frameId: string | null): UiNode[] {
  let changed = false;
  const nextNodes = nodes.map((node) => {
    if (node.type !== 'frame') return node;
    const highlighted = node.id === frameId;
    if (Boolean(node.data.isDropTargetFrame) === highlighted) return node;
    changed = true;
    return {
      ...node,
      data: {
        ...node.data,
        isDropTargetFrame: highlighted,
      },
    };
  });
  return changed ? nextNodes : nodes;
}

function boundsForNodes(nodes: UiNode[], padding: number): { x: number; y: number; width: number; height: number } | null {
  if (nodes.length === 0) return null;
  const rects = nodes.map((node) => nodeRect(node));
  const left = Math.min(...rects.map((rect) => rect.left)) - padding;
  const top = Math.min(...rects.map((rect) => rect.top)) - frameTopPadding();
  const right = Math.max(...rects.map((rect) => rect.right)) + padding;
  const bottom = Math.max(...rects.map((rect) => rect.bottom)) + padding;
  return { x: left, y: top, width: Math.max(260, right - left), height: Math.max(frameMinHeight(), bottom - top) };
}

function frameWithBounds(node: UiNode, bounds: { x: number; y: number; width: number; height: number }): UiNode {
  const width = Math.round(bounds.width);
  const height = Math.round(bounds.height);
  const workflowNode = {
    ...node.data.workflowNode,
    position: { x: Math.round(bounds.x), y: Math.round(bounds.y) },
    data: {
      ...node.data.workflowNode.data,
      width,
      height,
    },
  };
  return {
    ...node,
    position: workflowNode.position,
    width,
    height,
    style: { ...node.style, width, height },
    data: { ...node.data, workflowNode },
  };
}

function rectArea(rect: { width: number; height: number }): number {
  return rect.width * rect.height;
}

export function deleteNodes(workflow: ImageXWorkflow, nodeIds: Set<string>, edgeIds = new Set<string>()): ImageXWorkflow {
  const affectedFrames = new Set(
    workflow.nodes
      .filter((node) => nodeIds.has(node.id) && typeof node.data.frameId === 'string')
      .map((node) => String(node.data.frameId))
  );
  return wrapWorkflowFramesAroundMembers({
    ...workflow,
    nodes: workflow.nodes.filter((node) => !nodeIds.has(node.id)),
    edges: workflow.edges.filter((edge) => !edgeIds.has(edge.id) && !nodeIds.has(edge.source) && !nodeIds.has(edge.target)),
  }, affectedFrames);
}

export function disconnectNodes(workflow: ImageXWorkflow, nodeIds: Set<string>): ImageXWorkflow {
  return {
    ...workflow,
    edges: workflow.edges.filter((edge) => !nodeIds.has(edge.source) && !nodeIds.has(edge.target)),
  };
}

export function removeFrameOnly(workflow: ImageXWorkflow, frameId: string): ImageXWorkflow {
  return {
    ...workflow,
    nodes: workflow.nodes
      .filter((node) => node.id !== frameId)
      .map((node) => {
        if (node.data.frameId !== frameId) return node;
        const data = { ...node.data };
        delete data.frameId;
        return { ...node, data };
      }),
    edges: workflow.edges.filter((edge) => edge.source !== frameId && edge.target !== frameId),
  };
}

export function wrapWorkflowFramesAroundMembers(workflow: ImageXWorkflow, frameIds?: Set<string>): ImageXWorkflow {
  const targetFrameIds = frameIds ?? new Set(workflow.nodes.filter((node) => node.type === 'frame').map((node) => node.id));
  if (targetFrameIds.size === 0) return workflow;
  let changed = false;
  const nextNodes = workflow.nodes.map((node) => {
    if (node.type !== 'frame' || !targetFrameIds.has(node.id)) return node;
    const members = workflow.nodes.filter((candidate) => candidate.type !== 'frame' && candidate.data.frameId === node.id);
    const bounds = workflowBoundsForNodes(members, FRAME_PADDING);
    if (!bounds) return node;
    if (
      Math.round(node.position.x) === Math.round(bounds.x) &&
      Math.round(node.position.y) === Math.round(bounds.y) &&
      Math.round(Number(node.data.width) || 0) === Math.round(bounds.width) &&
      Math.round(Number(node.data.height) || 0) === Math.round(bounds.height)
    ) {
      return node;
    }
    changed = true;
    return {
      ...node,
      position: { x: Math.round(bounds.x), y: Math.round(bounds.y) },
      data: {
        ...node.data,
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      },
    };
  });
  return changed ? { ...workflow, nodes: nextNodes } : workflow;
}

export function duplicateWorkflowNodes(workflow: ImageXWorkflow, nodeIds: Set<string>, offset = 44): { workflow: ImageXWorkflow; copyIds: string[] } {
  const idMap = new Map<string, string>();
  for (const id of nodeIds) idMap.set(id, `${id}-copy-${crypto.randomUUID().slice(0, 5)}`);

  const copies = workflow.nodes
    .filter((node) => nodeIds.has(node.id))
    .map((node) => {
      const copied = cloneWorkflowNode(node);
      copied.id = idMap.get(node.id)!;
      copied.position = { x: node.position.x + offset, y: node.position.y + offset };
      const originalFrameId = typeof copied.data.frameId === 'string' ? copied.data.frameId : undefined;
      if (originalFrameId) {
        const copiedFrameId = idMap.get(originalFrameId);
        if (copiedFrameId) copied.data.frameId = copiedFrameId;
        else delete copied.data.frameId;
      }
      return copied;
    });

  const copiedEdges: ImageXEdge[] = workflow.edges
    .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
    .map((edge) => ({
      ...edge,
      id: `${idMap.get(edge.source)}-${edge.sourceHandle ?? 'out'}-${idMap.get(edge.target)}-${edge.targetHandle ?? 'in'}`,
      source: idMap.get(edge.source)!,
      target: idMap.get(edge.target)!,
    }));

  return {
    workflow: {
      ...workflow,
      nodes: [...workflow.nodes, ...copies],
      edges: [...workflow.edges, ...copiedEdges],
    },
    copyIds: copies.map((node) => node.id),
  };
}

function withWorkflowData(node: UiNode, data: Record<string, unknown>): UiNode {
  return {
    ...node,
    data: {
      ...node.data,
      workflowNode: {
        ...node.data.workflowNode,
        data,
      },
    },
  };
}

function workflowBoundsForNodes(nodes: ImageXNode[], padding: number): { x: number; y: number; width: number; height: number } | null {
  if (nodes.length === 0) return null;
  const rects = nodes.map((node) => workflowNodeRect(node));
  const left = Math.min(...rects.map((rect) => rect.left)) - padding;
  const top = Math.min(...rects.map((rect) => rect.top)) - frameTopPadding();
  const right = Math.max(...rects.map((rect) => rect.right)) + padding;
  const bottom = Math.max(...rects.map((rect) => rect.bottom)) + padding;
  return { x: left, y: top, width: Math.max(260, right - left), height: Math.max(frameMinHeight(), bottom - top) };
}

function frameTopPadding(): number {
  return FRAME_HEADER_HEIGHT + FRAME_HEADER_GAP;
}

function frameMinHeight(): number {
  return FRAME_HEADER_HEIGHT + FRAME_HEADER_GAP + FRAME_PADDING;
}

function workflowNodeRect(node: ImageXNode): { left: number; top: number; right: number; bottom: number } {
  const width = Number(node.data.width) || (node.type === 'frame' ? 520 : 300);
  const height = Number(node.data.height) || (node.type === 'frame' ? 360 : 160);
  return {
    left: node.position.x,
    top: node.position.y,
    right: node.position.x + width,
    bottom: node.position.y + height,
  };
}
