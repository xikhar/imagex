import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileStoppedGenerationJob, type RecoverableGenerationJob } from '../src/daemon/generationRecovery.js';
import type { OutputNodeGenerationState } from '../src/shared/types.js';

const now = '2026-01-01T00:00:00.000Z';
const recoveredAt = '2026-01-01T00:01:00.000Z';

function outputState(images: number, expectedCount: number): OutputNodeGenerationState {
  return {
    status: 'running',
    images: Array.from({ length: images }, (_, index) => ({
      id: `image-${index}`,
      path: `/tmp/image-${index}.png`,
      url: `/outputs/image-${index}.png`,
    })),
    expectedCount,
    updatedAt: now,
  };
}

function runningJob(outputs: Record<string, OutputNodeGenerationState>): RecoverableGenerationJob {
  return {
    status: 'running',
    outputs,
  };
}

test('recovery marks empty running outputs as errors', () => {
  const job = reconcileStoppedGenerationJob(runningJob({ output: outputState(0, 2) }), recoveredAt);

  assert.equal(job.status, 'error');
  assert.equal(job.error, 'The daemon stopped before this generation completed.');
  assert.equal(job.outputs.output?.status, 'error');
  assert.equal(job.outputs.output?.error, 'Daemon stopped before output was generated.');
  assert.equal(job.outputs.output?.updatedAt, recoveredAt);
});

test('recovery preserves fully generated outputs as done', () => {
  const job = reconcileStoppedGenerationJob(runningJob({ output: outputState(2, 2) }), recoveredAt);

  assert.equal(job.status, 'done');
  assert.equal(job.error, undefined);
  assert.equal(job.outputs.output?.status, 'done');
  assert.equal(job.outputs.output?.error, undefined);
  assert.equal(job.outputs.output?.images.length, 2);
});

test('recovery handles mixed complete, partial, and missing outputs', () => {
  const job = reconcileStoppedGenerationJob(
    runningJob({
      complete: outputState(2, 2),
      partial: outputState(1, 3),
      missing: outputState(0, 1),
    }),
    recoveredAt,
  );

  assert.equal(job.status, 'error');
  assert.equal(job.outputs.complete?.status, 'done');
  assert.equal(job.outputs.partial?.status, 'partial');
  assert.equal(job.outputs.partial?.error, 'Daemon stopped after partial output.');
  assert.equal(job.outputs.missing?.status, 'error');
});

test('recovery leaves non-running jobs unchanged', () => {
  const job: RecoverableGenerationJob = {
    status: 'cancelled',
    error: 'Cancelled.',
    outputs: { output: { ...outputState(0, 1), status: 'cancelled', error: 'Cancelled.' } },
  };

  assert.equal(reconcileStoppedGenerationJob(job, recoveredAt), job);
  assert.equal(job.status, 'cancelled');
  assert.equal(job.outputs.output?.updatedAt, now);
});
