import test from 'node:test';
import assert from 'node:assert/strict';
import { compileOutputNodeWorkflow } from '../src/workflows/compiler.js';
import type { CustomFieldDefinition, ImageXEdge, ImageXNode, ImageXWorkflow } from '../src/shared/types.js';

const now = '2026-01-01T00:00:00.000Z';

function workflow(nodes: ImageXNode[], edges: ImageXEdge[]): ImageXWorkflow {
  return {
    id: 'workflow',
    version: '0.1',
    name: 'Compiler Test',
    createdAt: now,
    updatedAt: now,
    settings: { provider: 'openai-codex', useCase: 'product-shot' },
    nodes,
    edges,
  };
}

function outputNode(id: string, data: Record<string, unknown> = {}): ImageXNode {
  return {
    id,
    type: 'codex-output',
    position: { x: 0, y: 0 },
    data: { count: 2, size: '1024x1024', model: 'gpt-image-2', ...data },
  };
}

function primitiveNode(type: 'prompt' | 'image', id: string, fields: CustomFieldDefinition[], data: Record<string, unknown> = {}): ImageXNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: { fieldsMode: 'managed', fields, ...data },
  };
}

test('compiler preserves duplicate managed field labels as arrays', () => {
  const prompt = primitiveNode('prompt', 'prompt', [
    { id: 'headline', label: 'Text', kind: 'textarea', value: 'Minimal logo mark' },
    { id: 'constraints', label: 'Text', kind: 'textarea', value: 'No mockups or shadows' },
  ]);
  const output = outputNode('output');
  const graph = workflow(
    [prompt, output],
    [{ id: 'prompt-output', source: 'prompt', sourceHandle: 'text-out', target: 'output', targetHandle: 'input-in' }],
  );

  const compiled = compileOutputNodeWorkflow(graph, 'output');
  assert.ok(compiled);
  const promptJson = JSON.parse(compiled.prompt);
  assert.deepEqual(promptJson.outputs[0].request.Text, ['Minimal logo mark', 'No mockups or shadows']);
  assert.equal(compiled.options.count, 2);
  assert.deepEqual(compiled.options.references, []);
});

test('compiler emits image references and output image handle references', () => {
  const reference = primitiveNode(
    'image',
    'reference',
    [
      { id: 'image', label: 'Image', kind: 'image', value: '' },
      { id: 'description', label: 'Description', kind: 'textarea', value: 'Glass cosmetic bottle' },
    ],
    { assetUrl: '/api/projects/project/asset-files/asset-1', assetName: 'bottle.png' },
  );
  const logoOutput = outputNode('logo');
  const productOutput = outputNode('product', { count: 1 });
  const graph = workflow(
    [reference, logoOutput, productOutput],
    [
      { id: 'image-product', source: 'reference', sourceHandle: 'image-out', target: 'product', targetHandle: 'input-in' },
      { id: 'logo-product', source: 'logo', sourceHandle: 'result-out:2', target: 'product', targetHandle: 'input-in' },
    ],
  );

  const compiled = compileOutputNodeWorkflow(graph, 'product');
  assert.ok(compiled);
  const promptJson = JSON.parse(compiled.prompt);

  assert.equal(promptJson.outputs[0].request[0].Image, '[image-1]');
  assert.equal(promptJson.outputs[0].request[0].Description, 'Glass cosmetic bottle');
  assert.equal(promptJson.outputs[0].request[1].image, '[image-2]');
  assert.deepEqual(compiled.options.references?.map((reference) => reference.name), [
    '/api/projects/project/asset-files/asset-1',
    '__output:logo:2',
  ]);
});

test('compiler passes edit nodes through to their source reference', () => {
  const reference = primitiveNode(
    'image',
    'reference',
    [{ id: 'image', label: 'Image', kind: 'image', value: '' }],
    { assetUrl: '/api/projects/project/asset-files/asset-1' },
  );
  const edit: ImageXNode = {
    id: 'blur',
    type: 'blur',
    position: { x: 0, y: 0 },
    data: { radius: 20 },
  };
  const output = outputNode('output', { count: 1 });
  const graph = workflow(
    [reference, edit, output],
    [
      { id: 'image-edit', source: 'reference', sourceHandle: 'image-out', target: 'blur', targetHandle: 'image-in' },
      { id: 'edit-output', source: 'blur', sourceHandle: 'image-out', target: 'output', targetHandle: 'input-in' },
    ],
  );

  const compiled = compileOutputNodeWorkflow(graph, 'output');
  assert.ok(compiled);
  const promptJson = JSON.parse(compiled.prompt);
  assert.equal(promptJson.outputs[0].request.Image, '[image-1]');
  assert.deepEqual(compiled.options.references?.map((reference) => reference.name), ['/api/projects/project/asset-files/asset-1']);
});
