import type { GenerationJobStatus } from '../../../shared/types.js';

export function outputNodePatchesFromGenerationStatus(job: GenerationJobStatus): Map<string, Record<string, unknown>> {
  const patches = new Map<string, Record<string, unknown>>();
  for (const [nodeId, state] of Object.entries(job.outputs || {})) {
    patches.set(nodeId, {
      previewUrl: state.images[0]?.url || '',
      previewUrls: state.images.map((image) => image.url),
      previewIndex: 0,
      generating: state.status === 'queued' || state.status === 'running',
      generation: state,
    });
  }
  return patches;
}
