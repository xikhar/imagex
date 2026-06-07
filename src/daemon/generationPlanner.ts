import { existsSync } from 'node:fs';
import type {
  GeneratedImage,
  GenerationRunMode,
  ImageXNode,
  ImageXWorkflow,
  OutputNodeGenerationState,
} from '../shared/types.js';

export type OutputRunPlan = {
  plannedOutputNodeIds: string[];
  levels: string[][];
  dependencies: Map<string, Set<string>>;
};

export type StoredOutputOptions = {
  imageExists?: (path: string) => boolean;
  outputPathFromProjectUrl?: (url: string) => string;
};

export function outputGenerationState(node: ImageXNode): OutputNodeGenerationState | null {
  const value = node.data.generation;
  if (!value || typeof value !== 'object') return null;
  const state = value as OutputNodeGenerationState;
  return Array.isArray(state.images) ? state : null;
}

export function storedImagesForOutput(node: ImageXNode, options: StoredOutputOptions = {}): GeneratedImage[] {
  const imageExists = options.imageExists || existsSync;
  const outputPathFromProjectUrl = options.outputPathFromProjectUrl || (() => '');
  const generation = outputGenerationState(node);
  if (generation?.images.length) return generation.images.filter((image) => imageExists(image.path));

  const urls = Array.isArray(node.data.previewUrls) ? node.data.previewUrls : [];
  return urls
    .filter((url): url is string => typeof url === 'string' && url.length > 0)
    .map((url, index) => ({
      id: `${node.id}-stored-${index}`,
      path: outputPathFromProjectUrl(String(url)),
      url,
    }))
    .filter((image) => Boolean(image.path) && imageExists(image.path));
}

export function outputDependencies(workflow: ImageXWorkflow): Map<string, Set<string>> {
  const outputIds = new Set(workflow.nodes.filter((node) => node.type === 'codex-output').map((node) => node.id));
  const dependencies = new Map<string, Set<string>>();

  function trace(nodeId: string, visited: Set<string>): string[] {
    if (visited.has(nodeId)) return [];
    visited.add(nodeId);
    const found: string[] = [];
    for (const edge of workflow.edges) {
      if (edge.target !== nodeId) continue;
      if (outputIds.has(edge.source)) {
        found.push(edge.source);
      } else {
        found.push(...trace(edge.source, visited));
      }
    }
    return found;
  }

  for (const id of outputIds) {
    dependencies.set(id, new Set(trace(id, new Set())));
  }
  return dependencies;
}

export function planOutputRun(
  workflow: ImageXWorkflow,
  requestedOutputNodeIds: string[] | undefined,
  mode: GenerationRunMode,
  options: StoredOutputOptions = {},
): OutputRunPlan {
  const outputNodes = workflow.nodes.filter((node) => node.type === 'codex-output');
  const outputIds = new Set(outputNodes.map((node) => node.id));
  const nodesById = new Map(outputNodes.map((node) => [node.id, node]));
  const dependencies = outputDependencies(workflow);
  const requested = mode === 'all'
    ? outputNodes.map((node) => node.id)
    : (requestedOutputNodeIds || []).filter((id) => outputIds.has(id));
  const requestedSet = new Set(requested);
  const planned = new Set<string>();

  function includeWithDeps(id: string, visiting = new Set<string>()): void {
    if (!outputIds.has(id) || planned.has(id)) return;
    if (visiting.has(id)) throw new Error('Circular dependency detected between output nodes');
    const nextVisiting = new Set(visiting);
    nextVisiting.add(id);
    const deps = dependencies.get(id) || new Set<string>();
    for (const depId of deps) {
      const dep = nodesById.get(depId);
      const hasStored = dep ? storedImagesForOutput(dep, options).length > 0 : false;
      if (mode === 'selected' && hasStored && !requestedSet.has(depId)) continue;
      includeWithDeps(depId, nextVisiting);
    }
    planned.add(id);
  }

  for (const id of requested) includeWithDeps(id);

  const plannedDependencies = new Map<string, Set<string>>();
  for (const id of planned) {
    plannedDependencies.set(id, new Set([...(dependencies.get(id) || [])].filter((depId) => planned.has(depId))));
  }

  const remaining = new Set(planned);
  const levels: string[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter((id) => {
      const deps = plannedDependencies.get(id) || new Set<string>();
      return [...deps].every((depId) => !remaining.has(depId));
    });
    if (ready.length === 0) throw new Error('Circular dependency detected between output nodes');
    levels.push(ready);
    for (const id of ready) remaining.delete(id);
  }

  return { plannedOutputNodeIds: [...planned], levels, dependencies };
}
