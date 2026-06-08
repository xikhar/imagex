import { MarkerType, type Edge } from '@xyflow/react';
import type { CSSProperties } from 'react';
import type { ImageXEdge, ImageXNode, ImageXWorkflow, NodeType } from '../../../shared/types.js';
import { editableFieldDefinitionsFor } from './fields/definitions.js';
import { nodeMeta } from './meta.js';
import { inputPortsFor, outputPortsFor } from './ports.js';
import type { OpenNodeMenu, UiEdge, UiNode, UiNodeData, UpdateNodeData } from './types.js';

const NODE_WIDTH_EXTRA_REM = 3.25;
const MIN_FIELD_LABEL_WIDTH_REM = 7.5;
const MAX_FIELD_LABEL_WIDTH_REM = 16;
const DEFAULT_CONTROL_WIDTH_REM = 13.5;

export function nodeWidthRem(node: ImageXNode): number {
  if (node.type === 'frame') {
    return Number(node.data.width) / 16 || 32.5;
  }
  const fields = editableFieldDefinitionsFor(node);
  const longestLabel = Math.max(0, ...fields.map((field) => field.label.length));
  const fieldLabelWidth = Math.min(
    Math.max(MIN_FIELD_LABEL_WIDTH_REM, longestLabel * 0.72 + 2.75),
    MAX_FIELD_LABEL_WIDTH_REM
  );
  return fieldLabelWidth + DEFAULT_CONTROL_WIDTH_REM + NODE_WIDTH_EXTRA_REM;
}

export function workflowToFlow(
  workflow: ImageXWorkflow,
  onChange: UpdateNodeData,
  onMenu: OpenNodeMenu,
  onShowPrompt?: (nodeId: string) => void,
  onAddCustomField?: UiNodeData['onAddCustomField'],
  onUpdateCustomField?: UiNodeData['onUpdateCustomField'],
  onActivateCustomField?: UiNodeData['onActivateCustomField'],
  onOpenAssetPicker?: UiNodeData['onOpenAssetPicker']
): { nodes: UiNode[]; edges: UiEdge[] } {
  const workflowNodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const workflowEdges = Array.isArray(workflow.edges) ? workflow.edges : [];
  const normalizedEdges = workflowEdges.map((edge) => withInferredHandles(edge, workflowNodes));
  return {
    nodes: workflowNodes.map((node) => {
      const connectedTargetHandles = normalizedEdges
        .filter((edge) => edge.target === node.id && edge.targetHandle)
        .map((edge) => edge.targetHandle!);
      const data: UiNodeData = {
        workflowNode: node,
        onChange,
        onMenu,
        connectedTargetHandles,
      };
      if (onShowPrompt) data.onShowPrompt = onShowPrompt;
      if (onAddCustomField) data.onAddCustomField = onAddCustomField;
      if (onUpdateCustomField) data.onUpdateCustomField = onUpdateCustomField;
      if (onActivateCustomField) data.onActivateCustomField = onActivateCustomField;
      if (onOpenAssetPicker) data.onOpenAssetPicker = onOpenAssetPicker;
      const frameWidth = Number(node.data.width) || 520;
      const frameHeight = Number(node.data.height) || 360;
      const widthRem = nodeWidthRem(node);
      const nodeStyle: CSSProperties = { width: `${widthRem}rem`, '--node-width': `${widthRem}rem` } as CSSProperties;
      return {
        id: node.id,
        type: node.type,
        position: node.position,
        data,
        ...(node.type === 'frame'
          ? {
              zIndex: -1,
              selectable: true,
              width: frameWidth,
              height: frameHeight,
              initialWidth: frameWidth,
              initialHeight: frameHeight,
              style: { width: frameWidth, height: frameHeight },
            }
          : {
              zIndex: 10,
              style: nodeStyle,
            }),
      };
    }),
    edges: normalizedEdges.map((edge) => toFlowEdge(edge, workflowNodes)),
  };
}

export function syncFlowToWorkflow(workflow: ImageXWorkflow, nodes: UiNode[], edges: UiEdge[]): ImageXWorkflow {
  const workflowNodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  return {
    ...workflow,
    nodes: workflowNodes.map((workflowNode) => {
      const flowNode = nodes.find((node) => node.id === workflowNode.id);
      const data = flowNode ? { ...flowNode.data.workflowNode.data } : workflowNode.data;
      if (flowNode) {
        const style = flowNode.style as { width?: number | string; height?: number | string } | undefined;
        data.width =
          numericDimension(flowNode.measured?.width) ??
          numericDimension(flowNode.width) ??
          numericDimension(style?.width) ??
          numericDimension(data.width) ??
          (flowNode.type === 'frame' ? 520 : undefined);
        data.height =
          numericDimension(flowNode.measured?.height) ??
          numericDimension(flowNode.height) ??
          numericDimension(style?.height) ??
          numericDimension(data.height) ??
          (flowNode.type === 'frame' ? 360 : undefined);
      }
      return flowNode
        ? {
            ...workflowNode,
            position: flowNode.position,
            data,
          }
        : workflowNode;
    }),
    edges: edges.map((edge) => {
      const workflowEdge: ImageXEdge = {
        id: edge.id,
        source: edge.source,
        target: edge.target,
      };
      if (edge.sourceHandle) workflowEdge.sourceHandle = edge.sourceHandle;
      if (edge.targetHandle) workflowEdge.targetHandle = edge.targetHandle;
      return workflowEdge;
    }),
  };
}

function numericDimension(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value !== 'string') return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : undefined;
}

export function toFlowEdge(edge: ImageXEdge, nodes: ImageXNode[]): Edge {
  const source = nodes.find((node) => node.id === edge.source);
  const accent = source ? nodeMeta[source.type].accent : '#8b5cf6';
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? null,
    targetHandle: edge.targetHandle ?? null,
    type: 'default',
    animated: false,
    reconnectable: true,
    markerEnd: {
      type: MarkerType.ArrowClosed,
      width: 14,
      height: 14,
      color: accent,
    },
    style: {
      stroke: accent,
      strokeWidth: 2.5,
    },
  };
}

function withInferredHandles(edge: ImageXEdge, nodes: ImageXNode[]): ImageXEdge {
  if (edge.sourceHandle && edge.targetHandle) return edge;
  const source = nodes.find((node) => node.id === edge.source);
  const target = nodes.find((node) => node.id === edge.target);
  if (!source || !target) return edge;
  const sourceHandle = edge.sourceHandle || outputPortsFor(source)[0]?.id;
  const sourceKind = outputPortsFor(source).find((port) => port.id === sourceHandle)?.kind;
  const targetHandle =
    edge.targetHandle ||
    inputPortsFor(target).find((port) => sourceKind && (port.accepts || [port.kind]).includes(sourceKind))?.id ||
    inputPortsFor(target)[0]?.id;
  const inferred: ImageXEdge = {
    ...edge,
  };
  if (sourceHandle) inferred.sourceHandle = sourceHandle;
  if (targetHandle) inferred.targetHandle = targetHandle;
  return inferred;
}

export function createUiWorkflowNode(type: NodeType, position: { x: number; y: number }): ImageXNode {
  return {
    id: `${type}-${crypto.randomUUID().slice(0, 8)}`,
    type,
    position,
    data: defaultDataFor(type),
  };
}

function defaultDataFor(type: NodeType): Record<string, unknown> {
  switch (type) {
    case 'prompt':
      return {
        title: 'Prompt',
        text: '',
        fields: [],
      };
    case 'image':
      return {
        title: 'Image',
        description: '',
        fields: [],
      };
    case 'color':
      return {
        title: 'Color',
        color: '#ffffff',
      };
    case 'file':
      return {
        title: 'File',
        filename: '',
        content: '',
      };
    case 'codex-output':
      return {
        title: 'Output',
        size: '1024x1024',
        quality: 'auto',
        format: 'png',
        background: 'auto',
        count: 1,
      };
    case 'color-balance':
      return {
        title: 'Color Balance',
        red: 0,
        green: 0,
        blue: 0,
      };
    case 'rotate-flip':
      return {
        title: 'Rotate & Flip',
        rotate: '0',
        flipH: false,
        flipV: false,
      };
    case 'crop':
      return { title: 'Crop', x: 0, y: 0, cropWidth: 0, cropHeight: 0 };
    case 'blur':
      return { title: 'Blur', radius: 0 };
    case 'download':
      return { title: 'Download' };
    case 'frame':
      return {
        title: 'Frame',
        notes: '',
        width: 520,
        height: 360,
      };
    default:
      return {};
  }
}
