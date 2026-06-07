import type { OutputNodeGenerationState } from '../shared/types.js';

export type RecoverableGenerationJob = {
  status: 'running' | 'done' | 'error' | 'cancelled';
  error?: string;
  outputs: Record<string, OutputNodeGenerationState>;
};

export function reconcileStoppedGenerationJob<T extends RecoverableGenerationJob>(
  job: T,
  updatedAt = new Date().toISOString(),
): T {
  if (job.status !== 'running') return job;

  const outputs = Object.entries(job.outputs || {});
  const nextOutputs: Record<string, OutputNodeGenerationState> = {};

  for (const [outputNodeId, state] of outputs) {
    const expectedCount = Math.max(1, Math.trunc(Number(state.expectedCount) || 1));
    const imageCount = state.images.length;

    if (imageCount >= expectedCount) {
      const { error: _error, ...doneState } = state;
      nextOutputs[outputNodeId] = {
        ...doneState,
        status: 'done',
        updatedAt,
      };
      continue;
    }

    nextOutputs[outputNodeId] = {
      ...state,
      status: imageCount > 0 ? 'partial' : 'error',
      error: imageCount > 0 ? 'Daemon stopped after partial output.' : 'Daemon stopped before output was generated.',
      updatedAt,
    };
  }

  job.outputs = nextOutputs;
  const recoveredStates = Object.values(nextOutputs);
  if (recoveredStates.length > 0 && recoveredStates.every((state) => state.status === 'done')) {
    job.status = 'done';
    delete job.error;
  } else {
    job.status = 'error';
    job.error = 'The daemon stopped before this generation completed.';
  }

  return job;
}
