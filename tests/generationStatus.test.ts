import test from 'node:test';
import assert from 'node:assert/strict';
import { outputNodePatchesFromGenerationStatus } from '../src/web/ui/editor/generationStatus.js';
import type { GenerationJobStatus, OutputNodeGenerationState } from '../src/shared/types.js';

const now = '2026-01-01T00:00:00.000Z';

function outputState(status: OutputNodeGenerationState['status'], images: string[] = [], error?: string): OutputNodeGenerationState {
  const state: OutputNodeGenerationState = {
    status,
    images: images.map((url, index) => ({ id: `image-${index}`, path: `/tmp/image-${index}.png`, url })),
    expectedCount: Math.max(1, images.length || 1),
    updatedAt: now,
  };
  if (error) state.error = error;
  return state;
}

function job(outputs: Record<string, OutputNodeGenerationState>): GenerationJobStatus {
  return {
    active: false,
    jobId: 'job',
    status: 'error',
    mode: 'selected',
    requestedOutputNodeIds: Object.keys(outputs),
    plannedOutputNodeIds: Object.keys(outputs),
    outputs,
    results: [],
  };
}

test('generation status patches keep generating true only for queued or running nodes', () => {
  const patches = outputNodePatchesFromGenerationStatus(job({
    queued: outputState('queued'),
    running: outputState('running'),
    done: outputState('done', ['done.png']),
    partial: outputState('partial', ['partial.png'], 'Short result'),
    error: outputState('error', [], 'Provider failed'),
    cancelled: outputState('cancelled', [], 'Cancelled'),
  }));

  assert.equal(patches.get('queued')?.generating, true);
  assert.equal(patches.get('running')?.generating, true);
  assert.equal(patches.get('done')?.generating, false);
  assert.equal(patches.get('partial')?.generating, false);
  assert.equal(patches.get('error')?.generating, false);
  assert.equal(patches.get('cancelled')?.generating, false);
});

test('generation status patches preserve previews and node-level errors', () => {
  const state = outputState('error', [], 'Codex image generation failed: quota exceeded');
  const patches = outputNodePatchesFromGenerationStatus(job({ output: state }));
  const patch = patches.get('output');

  assert.equal(patch?.previewUrl, '');
  assert.deepEqual(patch?.previewUrls, []);
  assert.equal(patch?.previewIndex, 0);
  assert.equal((patch?.generation as OutputNodeGenerationState | undefined)?.error, 'Codex image generation failed: quota exceeded');
});
