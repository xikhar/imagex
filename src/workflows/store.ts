import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readJsonFile, writeJsonFile } from '../config/jsonStore.js';
import { imagexPaths } from '../config/paths.js';
import type { ImageXWorkflow } from '../shared/types.js';
import { createDefaultWorkflow } from './defaults.js';

export async function listWorkflows(): Promise<ImageXWorkflow[]> {
  const dir = imagexPaths().workflowsDir;
  await mkdir(dir, { recursive: true });
  const files = await readdir(dir);
  const workflows = await Promise.all(
    files
      .filter((file) => file.endsWith('.imagex.json'))
      .map(async (file) => readJsonFile<ImageXWorkflow>(join(dir, file)))
  );

  if (workflows.length > 0) return workflows;

  const workflow = createDefaultWorkflow();
  await saveWorkflow(workflow);
  return [workflow];
}

export async function saveWorkflow(workflow: ImageXWorkflow): Promise<ImageXWorkflow> {
  const dir = imagexPaths().workflowsDir;
  await mkdir(dir, { recursive: true });
  const updated: ImageXWorkflow = {
    ...workflow,
    updatedAt: new Date().toISOString(),
  };
  await writeJsonFile(join(dir, `${updated.id}.imagex.json`), updated);
  return updated;
}
