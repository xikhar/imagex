import test from 'node:test';
import assert from 'node:assert/strict';
import type { ImageXNode, ImageXWorkflow } from '../src/shared/types.js';
import type { UiNode } from '../src/web/ui/flow/types.js';
import { moveFrameWithMembers, refreshFrameSelectionState, wrapWorkflowFramesAroundMembers } from '../src/web/ui/graph/operations.js';

function workflow(nodes: ImageXNode[]): ImageXWorkflow {
  return {
    version: 1,
    id: 'wf',
    name: 'Workflow',
    nodes,
    edges: [],
    settings: {},
  };
}

function workflowNode(id: string, type: ImageXNode['type'], position: { x: number; y: number }, data: Record<string, unknown> = {}): ImageXNode {
  return { id, type, position, data };
}

function uiNode(node: ImageXNode, selected = false): UiNode {
  const width = node.type === 'frame' ? Number(node.data.width) || 520 : Number(node.data.width) || 300;
  const height = node.type === 'frame' ? Number(node.data.height) || 360 : Number(node.data.height) || 160;
  return {
    id: node.id,
    type: node.type,
    position: node.position,
    data: {
      workflowNode: node,
      onChange: () => undefined,
      onMenu: () => undefined,
      connectedTargetHandles: [],
    },
    selected,
    width,
    height,
    style: { width, height },
  };
}

test('frame wrapping reserves a non-overlapping header band above members', () => {
  const frame = workflowNode('frame', 'frame', { x: 80, y: 80 }, { width: 520, height: 360 });
  const child = workflowNode('prompt', 'prompt', { x: 160, y: 200 }, { frameId: frame.id, width: 300, height: 160 });

  const wrapped = wrapWorkflowFramesAroundMembers(workflow([frame, child]));
  const wrappedFrame = wrapped.nodes.find((node) => node.id === frame.id)!;

  assert.equal(wrappedFrame.position.y, 136);
  assert.equal(Number(wrappedFrame.data.height), 248);
  assert.ok(child.position.y - wrappedFrame.position.y >= 64);
});

test('moving a frame updates the frame and unselected members as one mutation', () => {
  const frame = uiNode(workflowNode('frame', 'frame', { x: 80, y: 80 }, { width: 520, height: 360 }));
  const child = uiNode(workflowNode('child', 'prompt', { x: 160, y: 200 }, { frameId: frame.id, width: 300, height: 160 }));

  const moved = moveFrameWithMembers([frame, child], frame.id, { x: 110, y: 120 }, { x: 30, y: 40 });

  assert.equal(moved.changed, true);
  assert.deepEqual(moved.nodes.find((node) => node.id === frame.id)!.position, { x: 110, y: 120 });
  assert.deepEqual(moved.nodes.find((node) => node.id === child.id)!.position, { x: 190, y: 240 });
});

test('moving a frame does not double-move selected members already dragged by React Flow', () => {
  const frame = uiNode(workflowNode('frame', 'frame', { x: 80, y: 80 }, { width: 520, height: 360 }));
  const child = uiNode(workflowNode('child', 'prompt', { x: 190, y: 240 }, { frameId: frame.id, width: 300, height: 160 }), true);

  const moved = moveFrameWithMembers([frame, child], frame.id, { x: 110, y: 120 }, { x: 30, y: 40 });

  assert.equal(moved.changed, true);
  assert.deepEqual(moved.nodes.find((node) => node.id === frame.id)!.position, { x: 110, y: 120 });
  assert.deepEqual(moved.nodes.find((node) => node.id === child.id)!.position, { x: 190, y: 240 });
});

test('frame selection state follows selected members', () => {
  const frame = uiNode(workflowNode('frame', 'frame', { x: 80, y: 80 }, { width: 520, height: 360 }));
  const child = uiNode(workflowNode('child', 'prompt', { x: 160, y: 200 }, { frameId: frame.id, width: 300, height: 160 }), true);
  const outside = uiNode(workflowNode('outside', 'prompt', { x: 600, y: 200 }, { width: 300, height: 160 }), true);

  const active = refreshFrameSelectionState([frame, child, outside]);
  assert.equal(active.find((node) => node.id === frame.id)!.data.hasSelectedFrameMember, true);

  const inactive = refreshFrameSelectionState(active.map((node) => ({ ...node, selected: false })));
  assert.equal(inactive.find((node) => node.id === frame.id)!.data.hasSelectedFrameMember, false);
});
