import test from 'node:test';
import assert from 'node:assert/strict';
import { planOutputRun, storedImagesForOutput } from '../src/daemon/generationPlanner.js';
import type { ImageXEdge, ImageXNode, ImageXWorkflow, OutputNodeGenerationState } from '../src/shared/types.js';

const now = '2026-01-01T00:00:00.000Z';

function outputNode(id: string, generation?: OutputNodeGenerationState): ImageXNode {
  const data: Record<string, unknown> = { count: 1 };
  if (generation) data.generation = generation;
  return { id, type: 'codex-output', position: { x: 0, y: 0 }, data };
}

function promptNode(id: string): ImageXNode {
  return {
    id,
    type: 'prompt',
    position: { x: 0, y: 0 },
    data: { fieldsMode: 'managed', fields: [{ id: 'text', label: 'Text', kind: 'textarea', value: 'prompt' }] },
  };
}

function workflow(nodes: ImageXNode[], edges: ImageXEdge[]): ImageXWorkflow {
  return {
    id: 'workflow',
    version: '0.1',
    name: 'Workflow',
    createdAt: now,
    updatedAt: now,
    settings: { provider: 'openai-codex' },
    nodes,
    edges,
  };
}

function storedGeneration(path = '/tmp/generated.png'): OutputNodeGenerationState {
  return {
    status: 'done',
    images: [{ id: 'image-1', path, url: '/api/projects/project/outputs/runs/job/out/image.png' }],
    expectedCount: 1,
    updatedAt: now,
  };
}

test('selected mode runs empty upstream output dependencies first', () => {
  const graph = workflow(
    [promptNode('prompt'), outputNode('upstream'), outputNode('target')],
    [
      { id: 'prompt-target', source: 'prompt', target: 'target', sourceHandle: 'text-out', targetHandle: 'input-in' },
      { id: 'upstream-target', source: 'upstream', target: 'target', sourceHandle: 'result-out', targetHandle: 'input-in' },
    ],
  );

  const plan = planOutputRun(graph, ['target'], 'selected', { imageExists: () => false });
  assert.deepEqual(plan.plannedOutputNodeIds, ['upstream', 'target']);
  assert.deepEqual(plan.levels, [['upstream'], ['target']]);
});

test('selected mode reuses stored upstream output dependencies unless selected directly', () => {
  const graph = workflow(
    [outputNode('upstream', storedGeneration()), outputNode('target')],
    [{ id: 'upstream-target', source: 'upstream', target: 'target', sourceHandle: 'result-out', targetHandle: 'input-in' }],
  );

  const reused = planOutputRun(graph, ['target'], 'selected', { imageExists: () => true });
  assert.deepEqual(reused.plannedOutputNodeIds, ['target']);
  assert.deepEqual(reused.levels, [['target']]);

  const selectedDependency = planOutputRun(graph, ['upstream', 'target'], 'selected', { imageExists: () => true });
  assert.deepEqual(selectedDependency.plannedOutputNodeIds, ['upstream', 'target']);
  assert.deepEqual(selectedDependency.levels, [['upstream'], ['target']]);
});

test('forced and all modes run dependencies in topological levels', () => {
  const graph = workflow(
    [outputNode('brand', storedGeneration()), outputNode('product'), outputNode('background')],
    [{ id: 'brand-product', source: 'brand', target: 'product', sourceHandle: 'result-out', targetHandle: 'input-in' }],
  );

  const forced = planOutputRun(graph, ['product'], 'forced', { imageExists: () => true });
  assert.deepEqual(forced.plannedOutputNodeIds, ['brand', 'product']);
  assert.deepEqual(forced.levels, [['brand'], ['product']]);

  const all = planOutputRun(graph, undefined, 'all', { imageExists: () => true });
  assert.deepEqual(all.plannedOutputNodeIds, ['brand', 'product', 'background']);
  assert.deepEqual(all.levels, [['brand', 'background'], ['product']]);
});

test('run planning rejects circular output dependencies', () => {
  const graph = workflow(
    [outputNode('a'), outputNode('b')],
    [
      { id: 'a-b', source: 'a', target: 'b', sourceHandle: 'result-out', targetHandle: 'input-in' },
      { id: 'b-a', source: 'b', target: 'a', sourceHandle: 'result-out', targetHandle: 'input-in' },
    ],
  );

  assert.throws(
    () => planOutputRun(graph, ['a'], 'forced', { imageExists: () => false }),
    /Circular dependency detected between output nodes/,
  );
});

test('storedImagesForOutput resolves legacy preview URLs through project output paths', () => {
  const node: ImageXNode = {
    id: 'out',
    type: 'codex-output',
    position: { x: 0, y: 0 },
    data: { previewUrls: ['/api/projects/project/outputs/runs/job/out/image.png'] },
  };

  const images = storedImagesForOutput(node, {
    imageExists: (path) => path === '/resolved/image.png',
    outputPathFromProjectUrl: () => '/resolved/image.png',
  });

  assert.deepEqual(images, [
    {
      id: 'out-stored-0',
      path: '/resolved/image.png',
      url: '/api/projects/project/outputs/runs/job/out/image.png',
    },
  ]);
});
