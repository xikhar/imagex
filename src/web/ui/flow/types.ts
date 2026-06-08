import type { Edge, Node } from '@xyflow/react';
import type { ImageXNode, NodeType } from '../../../shared/types.js';

export type UpdateNodeData = (nodeId: string, key: string, value: unknown) => void;
export type OpenNodeMenu = (nodeId: string, position: { x: number; y: number }) => void;

export type UiNodeData = {
  workflowNode: ImageXNode;
  onChange: UpdateNodeData;
  onMenu: OpenNodeMenu;
  onShowPrompt?: (nodeId: string) => void;
  onAddCustomField?: (nodeId: string, preset: string) => void;
  onUpdateCustomField?: (nodeId: string, fieldId: string, value: unknown) => void;
  onActivateCustomField?: (nodeId: string, fieldId: string) => void;
  onOpenAssetPicker?: (nodeId: string, fieldId: string) => void;
  isDropTargetFrame?: boolean;
  hasSelectedFrameMember?: boolean;
  connectedTargetHandles: string[];
};

export type UiNode = Node<UiNodeData, NodeType>;
export type UiEdge = Edge;
