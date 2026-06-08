import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generationWithDeletedUrl,
  reflectRenamedImageAssetInWorkflow,
  reflectRenamedOutputAssetInWorkflow,
  scrubDeletedImageAssetFromWorkflow,
  scrubDeletedOutputAssetFromWorkflow,
} from '../src/web/ui/editor/assetReconciliation.js';
import { edgeReferencesExistingPorts } from '../src/web/ui/flow/ports.js';
import type {
  GeneratedImage,
  ImageXAsset,
  ImageXEdge,
  ImageXNode,
  ImageXOutputAsset,
  ImageXWorkflow,
  OutputNodeGenerationState,
} from '../src/shared/types.js';

const now = '2026-01-01T00:00:00.000Z';
const updatedAt = '2026-01-01T00:10:00.000Z';

function workflow(nodes: ImageXNode[], edges: ImageXEdge[] = []): ImageXWorkflow {
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

function outputNode(id: string, urls: string[]): ImageXNode {
  return {
    id,
    type: 'codex-output',
    position: { x: 0, y: 0 },
    data: {
      previewUrl: urls[0] || '',
      previewUrls: urls,
      previewIndex: 1,
      generation: generation(urls),
    },
  };
}

function imageNode(id: string, data: Record<string, unknown>): ImageXNode {
  return {
    id,
    type: 'image',
    position: { x: 0, y: 0 },
    data,
  };
}

function editNode(id: string): ImageXNode {
  return {
    id,
    type: 'blur',
    position: { x: 0, y: 0 },
    data: { radius: 10 },
  };
}

function generation(urls: string[]): OutputNodeGenerationState {
  return {
    status: 'done',
    images: urls.map((url, index) => image(url, index)),
    expectedCount: urls.length,
    updatedAt: now,
  };
}

function image(url: string, index: number): GeneratedImage {
  return {
    id: `image-${index}`,
    path: `/tmp/image-${index}.png`,
    url,
  };
}

function outputAsset(url: string, imageIndex: number): ImageXOutputAsset {
  return {
    id: `job~output~image-${imageIndex}`,
    name: `Output ${imageIndex + 1}`,
    type: 'output',
    jobId: 'job',
    outputNodeId: 'output',
    imageId: `image-${imageIndex}`,
    imageIndex,
    url,
    path: `/tmp/image-${imageIndex}.png`,
    createdAt: now,
    updatedAt: now,
  };
}

test('deleted imported image assets are scrubbed from workflow nodes', () => {
  const asset: ImageXAsset = {
    id: 'asset-1',
    name: 'Bottle.png',
    type: 'image',
    file: 'bottle.png',
    url: '/api/projects/project/asset-files/asset-1',
    createdAt: now,
    updatedAt: now,
  };
  const graph = workflow([
    imageNode('image', {
      assetId: asset.id,
      assetUrl: asset.url,
      assetName: asset.name,
      image: asset.url,
      description: asset.name,
    }),
  ]);

  const next = scrubDeletedImageAssetFromWorkflow(graph, asset, updatedAt);
  assert.notEqual(next, graph);
  assert.equal(next.updatedAt, updatedAt);
  assert.equal(next.nodes[0]?.data.assetId, undefined);
  assert.equal(next.nodes[0]?.data.assetUrl, undefined);
  assert.equal(next.nodes[0]?.data.assetName, undefined);
  assert.equal(next.nodes[0]?.data.image, '');
  assert.equal(next.nodes[0]?.data.description, '');
});

test('renamed image and output assets update referenced node names', () => {
  const imageAsset: ImageXAsset = {
    id: 'asset-1',
    name: 'New image name',
    type: 'image',
    file: 'image.png',
    url: '/api/projects/project/asset-files/asset-1',
    createdAt: now,
    updatedAt: now,
  };
  const output = outputAsset('/api/projects/project/outputs/runs/job/output/one.png', 0);
  const graph = workflow([
    imageNode('image', { assetId: imageAsset.id, assetUrl: imageAsset.url, assetName: 'Old' }),
    imageNode('output-image', { assetId: output.id, assetUrl: output.url, assetName: 'Old output' }),
  ]);

  const renamedImage = reflectRenamedImageAssetInWorkflow(graph, imageAsset, updatedAt);
  assert.equal(renamedImage.nodes[0]?.data.assetName, 'New image name');

  const renamedOutput = reflectRenamedOutputAssetInWorkflow(graph, { ...output, name: 'Hero output' }, updatedAt);
  assert.equal(renamedOutput.nodes[1]?.data.assetName, 'Hero output');
});

test('deleted output asset removes the selected output socket and shifts later handles', () => {
  const urls = ['u0.png', 'u1.png', 'u2.png'];
  const graph = workflow(
    [
      outputNode('output', urls),
      editNode('blur'),
      imageNode('consumer', { assetUrl: urls[1], assetName: 'Output 2' }),
      { id: 'dependent', type: 'codex-output', position: { x: 0, y: 0 }, data: {} },
    ],
    [
      { id: 'edge-0', source: 'output', sourceHandle: 'result-out', target: 'blur', targetHandle: 'image-in' },
      { id: 'edge-1', source: 'output', sourceHandle: 'result-out:1', target: 'dependent', targetHandle: 'input-in' },
      { id: 'edge-2', source: 'output', sourceHandle: 'result-out:2', target: 'consumer', targetHandle: 'field:image' },
    ],
  );

  const next = scrubDeletedOutputAssetFromWorkflow(graph, outputAsset(urls[1], 1), updatedAt);
  const output = next.nodes.find((node) => node.id === 'output');
  assert.deepEqual(output?.data.previewUrls, ['u0.png', 'u2.png']);
  assert.equal(output?.data.previewUrl, 'u0.png');
  assert.equal(output?.data.previewIndex, 1);
  assert.equal((output?.data.generation as OutputNodeGenerationState | undefined)?.status, 'partial');
  assert.deepEqual((output?.data.generation as OutputNodeGenerationState | undefined)?.images.map((img) => img.url), ['u0.png', 'u2.png']);
  assert.equal(next.nodes.find((node) => node.id === 'consumer')?.data.assetUrl, undefined);
  assert.deepEqual(
    next.edges.map((edge) => [edge.id, edge.sourceHandle, edge.target]),
    [
      ['edge-0', 'result-out', 'blur'],
      ['output-result-out:1-consumer-field:image', 'result-out:1', 'consumer'],
    ],
  );
  assert.equal(next.edges.every((edge) => edgeReferencesExistingPorts(edge, next.nodes)), true);
});

test('deleting the last output image cancels generation state and removes source edges', () => {
  const graph = workflow(
    [outputNode('output', ['only.png']), editNode('blur')],
    [{ id: 'edge-0', source: 'output', sourceHandle: 'result-out', target: 'blur', targetHandle: 'image-in' }],
  );

  const next = scrubDeletedOutputAssetFromWorkflow(graph, outputAsset('only.png', 0), updatedAt);
  const output = next.nodes.find((node) => node.id === 'output');
  assert.deepEqual(output?.data.previewUrls, []);
  assert.equal(output?.data.previewUrl, '');
  assert.equal((output?.data.generation as OutputNodeGenerationState | undefined)?.status, 'cancelled');
  assert.deepEqual((output?.data.generation as OutputNodeGenerationState | undefined)?.images, []);
  assert.deepEqual(next.edges, []);
});

test('generationWithDeletedUrl returns the same object when no image matches', () => {
  const state = generation(['u0.png']);
  assert.equal(generationWithDeletedUrl(state, 'missing.png', updatedAt), state);
});
