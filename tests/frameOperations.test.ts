import test from 'node:test';
import assert from 'node:assert/strict';
import type { ImageXNode, ImageXWorkflow } from '../src/shared/types.js';
import type { UiNode } from '../src/web/ui/flow/types.js';
import { syncFlowToWorkflow } from '../src/web/ui/flow/adapters.js';
import {
  addSelectionToFrame,
  attachNodeToFrameAtCenter,
  moveFrameWithMembers,
  refreshFrameSelectionState,
  wrapWorkflowFramesAroundMembers,
} from '../src/web/ui/graph/operations.js';

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

test('adding unframed selected nodes creates a frame without moving members', () => {
  const a = workflowNode('a', 'prompt', { x: 160, y: 200 }, { width: 300, height: 160 });
  const b = workflowNode('b', 'image', { x: 520, y: 240 }, { width: 300, height: 160 });

  const framed = addSelectionToFrame(workflow([a, b]), new Set([a.id, b.id]));
  const frame = framed.nodes.find((node) => node.type === 'frame')!;
  const framedA = framed.nodes.find((node) => node.id === a.id)!;
  const framedB = framed.nodes.find((node) => node.id === b.id)!;

  assert.ok(frame);
  assert.equal(framedA.data.frameId, frame.id);
  assert.equal(framedB.data.frameId, frame.id);
  assert.deepEqual(framedA.position, a.position);
  assert.deepEqual(framedB.position, b.position);
  assert.ok(a.position.y - frame.position.y >= 64);
});

test('adding a mixed selection to an existing frame keeps member positions', () => {
  const frame = workflowNode('frame', 'frame', { x: 100, y: 120 }, { width: 520, height: 360 });
  const inside = workflowNode('inside', 'prompt', { x: 160, y: 220 }, { frameId: frame.id, width: 300, height: 160 });
  const outside = workflowNode('outside', 'image', { x: 560, y: 260 }, { width: 300, height: 160 });

  const framed = addSelectionToFrame(workflow([frame, inside, outside]), new Set([inside.id, outside.id]));
  const framedOutside = framed.nodes.find((node) => node.id === outside.id)!;

  assert.equal(framed.nodes.filter((node) => node.type === 'frame').length, 1);
  assert.equal(framedOutside.data.frameId, frame.id);
  assert.deepEqual(framedOutside.position, outside.position);
});

test('adding selected nodes from different frames merges the frames', () => {
  const frameA = workflowNode('frame-a', 'frame', { x: 100, y: 120 }, { width: 520, height: 360 });
  const frameB = workflowNode('frame-b', 'frame', { x: 600, y: 160 }, { width: 520, height: 360 });
  const a = workflowNode('a', 'prompt', { x: 160, y: 220 }, { frameId: frameA.id, width: 300, height: 160 });
  const b = workflowNode('b', 'image', { x: 660, y: 260 }, { frameId: frameB.id, width: 300, height: 160 });

  const framed = addSelectionToFrame(workflow([frameA, a, frameB, b]), new Set([a.id, b.id]));
  const frames = framed.nodes.filter((node) => node.type === 'frame');
  const framedA = framed.nodes.find((node) => node.id === a.id)!;
  const framedB = framed.nodes.find((node) => node.id === b.id)!;

  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.id, frameA.id);
  assert.equal(framedA.data.frameId, frameA.id);
  assert.equal(framedB.data.frameId, frameA.id);
  assert.deepEqual(framedA.position, a.position);
  assert.deepEqual(framedB.position, b.position);
});

test('measured node dimensions are persisted before workflow frame operations', () => {
  const tall = workflowNode('tall', 'prompt', { x: 160, y: 200 }, {});
  const tallUiNode = {
    ...uiNode(tall),
    measured: { width: 336, height: 360 },
  };

  const synced = syncFlowToWorkflow(workflow([tall]), [tallUiNode], []);
  const syncedTall = synced.nodes.find((node) => node.id === tall.id)!;
  assert.equal(syncedTall.data.width, 336);
  assert.equal(syncedTall.data.height, 360);

  const framed = addSelectionToFrame(synced, new Set([tall.id]));
  const frame = framed.nodes.find((node) => node.type === 'frame')!;
  assert.equal(Number(frame.data.height), 448);
  assert.ok(frame.position.y + Number(frame.data.height) >= tall.position.y + 360 + 24);
});

test('dropping a frame member outside current bounds preserves membership', () => {
  const frame = uiNode(workflowNode('frame', 'frame', { x: 100, y: 100 }, { width: 520, height: 360 }));
  const child = uiNode(workflowNode('child', 'prompt', { x: 760, y: 520 }, { frameId: frame.id, width: 300, height: 160 }));

  const attached = attachNodeToFrameAtCenter([frame, child], child.id);
  assert.equal(attached.changed, false);
  assert.equal(attached.nodes.find((node) => node.id === child.id)!.data.workflowNode.data.frameId, frame.id);
});

test('dropping a node mostly inside a frame attaches even when its center is near the edge', () => {
  const frame = uiNode(workflowNode('frame', 'frame', { x: 100, y: 100 }, { width: 520, height: 360 }));
  const child = uiNode(workflowNode('child', 'prompt', { x: 480, y: 220 }, { width: 300, height: 160 }));

  const attached = attachNodeToFrameAtCenter([frame, child], child.id);
  assert.equal(attached.changed, true);
  assert.equal(attached.nodes.find((node) => node.id === child.id)!.data.workflowNode.data.frameId, frame.id);
});

test('detached nodes can remain outside or reattach by dropping over a frame', () => {
  const frame = uiNode(workflowNode('frame', 'frame', { x: 100, y: 100 }, { width: 520, height: 360 }));
  const outside = uiNode(workflowNode('outside', 'prompt', { x: 760, y: 520 }, { width: 300, height: 160 }));
  const inside = uiNode(workflowNode('inside', 'prompt', { x: 220, y: 240 }, { width: 300, height: 160 }));

  const remainsDetached = attachNodeToFrameAtCenter([frame, outside], outside.id);
  assert.equal(remainsDetached.changed, false);
  assert.equal(remainsDetached.nodes.find((node) => node.id === outside.id)!.data.workflowNode.data.frameId, undefined);

  const reattached = attachNodeToFrameAtCenter([frame, inside], inside.id);
  assert.equal(reattached.changed, true);
  assert.equal(reattached.nodes.find((node) => node.id === inside.id)!.data.workflowNode.data.frameId, frame.id);
});
