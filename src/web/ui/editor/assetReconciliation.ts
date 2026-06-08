import type {
  ImageXAsset,
  ImageXEdge,
  ImageXOutputAsset,
  ImageXWorkflow,
  OutputNodeGenerationState,
} from '../../../shared/types.js';

export function scrubDeletedImageAssetFromWorkflow(
  workflow: ImageXWorkflow,
  asset: ImageXAsset,
  updatedAt = new Date().toISOString(),
): ImageXWorkflow {
  let changed = false;
  const nodes = workflow.nodes.map((node) => {
    const usesAsset = node.data.assetId === asset.id || node.data.assetUrl === asset.url;
    if (!usesAsset) return node;
    changed = true;
    const nextData = { ...node.data };
    delete nextData.assetId;
    delete nextData.assetUrl;
    delete nextData.assetName;
    for (const [key, value] of Object.entries(nextData)) {
      if (value === asset.file || value === asset.name || value === asset.url) nextData[key] = '';
    }
    return { ...node, data: nextData };
  });

  return changed ? { ...workflow, nodes, updatedAt } : workflow;
}

export function reflectRenamedImageAssetInWorkflow(
  workflow: ImageXWorkflow,
  asset: ImageXAsset,
  updatedAt = new Date().toISOString(),
): ImageXWorkflow {
  return renameReferencedAssetInWorkflow(workflow, asset, updatedAt);
}

export function reflectRenamedOutputAssetInWorkflow(
  workflow: ImageXWorkflow,
  asset: ImageXOutputAsset,
  updatedAt = new Date().toISOString(),
): ImageXWorkflow {
  return renameReferencedAssetInWorkflow(workflow, asset, updatedAt);
}

export function scrubDeletedOutputAssetFromWorkflow(
  workflow: ImageXWorkflow,
  asset: ImageXOutputAsset,
  updatedAt = new Date().toISOString(),
): ImageXWorkflow {
  let changed = false;
  const sourceNode = workflow.nodes.find((node) => node.id === asset.outputNodeId);
  const sourceUrls = Array.isArray(sourceNode?.data.previewUrls) ? sourceNode.data.previewUrls : [];
  const currentImageIndex = sourceUrls.findIndex((url) => url === asset.url);
  const deletedImageIndex = currentImageIndex >= 0 ? currentImageIndex : asset.imageIndex;

  const nodes = workflow.nodes.map((node) => {
    const data = node.data;
    if (node.id === asset.outputNodeId) {
      const previousPreviewUrls = Array.isArray(data.previewUrls) ? data.previewUrls : [];
      const previewUrls = previousPreviewUrls.filter((url) => url !== asset.url);
      const generation = generationWithDeletedUrl(data.generation, asset.url, updatedAt);
      changed = changed || previewUrls.length !== previousPreviewUrls.length || generation !== data.generation;

      const nextData: Record<string, unknown> = {
        ...data,
        previewUrl: previewUrls[0] || '',
        previewUrls,
        previewIndex: Math.min(Number(data.previewIndex) || 0, Math.max(0, previewUrls.length - 1)),
      };
      if (generation) nextData.generation = generation;
      return { ...node, data: nextData };
    }

    if (data.assetUrl === asset.url) {
      changed = true;
      const nextData = { ...data };
      delete nextData.assetId;
      delete nextData.assetUrl;
      delete nextData.assetName;
      for (const [key, value] of Object.entries(nextData)) {
        if (value === asset.url || value === asset.name) nextData[key] = '';
      }
      return { ...node, data: nextData };
    }

    return node;
  });

  const edges = workflow.edges.flatMap((edge) => reconcileDeletedOutputEdge(edge, asset.outputNodeId, deletedImageIndex, () => {
    changed = true;
  }));

  return changed ? { ...workflow, nodes, edges, updatedAt } : workflow;
}

export function generationWithDeletedUrl(
  value: unknown,
  url: string,
  updatedAt = new Date().toISOString(),
): OutputNodeGenerationState | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const generation = value as OutputNodeGenerationState;
  if (!Array.isArray(generation.images)) return undefined;
  const images = generation.images.filter((image) => image.url !== url);
  if (images.length === generation.images.length) return generation;
  const expectedCount = Math.max(1, Math.trunc(Number(generation.expectedCount) || 1));
  return {
    ...generation,
    images,
    status: images.length === 0 ? 'cancelled' : images.length >= expectedCount ? generation.status : 'partial',
    updatedAt,
  };
}

function renameReferencedAssetInWorkflow(
  workflow: ImageXWorkflow,
  asset: { id: string; url: string; name: string },
  updatedAt: string,
): ImageXWorkflow {
  let changed = false;
  const nodes = workflow.nodes.map((node) => {
    if (node.data.assetId !== asset.id && node.data.assetUrl !== asset.url) return node;
    changed = true;
    return { ...node, data: { ...node.data, assetName: asset.name } };
  });
  return changed ? { ...workflow, nodes, updatedAt } : workflow;
}

function reconcileDeletedOutputEdge(
  edge: ImageXEdge,
  outputNodeId: string,
  deletedImageIndex: number,
  onChange: () => void,
): ImageXEdge[] {
  if (edge.source !== outputNodeId) return [edge];
  const sourceIndex = outputIndexFromHandle(edge.sourceHandle);
  if (sourceIndex === deletedImageIndex) {
    onChange();
    return [];
  }
  if (sourceIndex > deletedImageIndex) {
    onChange();
    const sourceHandle = outputHandleForIndex(sourceIndex - 1);
    return [{ ...edge, sourceHandle, id: `${edge.source}-${sourceHandle}-${edge.target}-${edge.targetHandle || 'in'}` }];
  }
  return [edge];
}

function outputIndexFromHandle(handleId: string | undefined): number {
  if (!handleId || handleId === 'result-out') return 0;
  const match = handleId.match(/^result-out:(\d+)$/);
  if (!match) return 0;
  const index = Number(match[1]);
  return Number.isInteger(index) && index >= 0 ? index : 0;
}

function outputHandleForIndex(index: number): string {
  return index <= 0 ? 'result-out' : `result-out:${index}`;
}
