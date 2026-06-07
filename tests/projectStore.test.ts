import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createProject,
  createProjectWorkflow,
  deleteProject,
  getProject,
  listProjectAssets,
  listProjects,
  loadProjectWorkflow,
  renameProject,
  saveProjectWorkflow,
} from '../src/projects/store.js';

test('project store persists projects and workflows under a temp IMAGEX_HOME', async () => {
  const previousHome = process.env.IMAGEX_HOME;
  const home = await mkdtemp(join(tmpdir(), 'imagex-project-store-'));
  process.env.IMAGEX_HOME = home;

  try {
    const created = await createProject({ title: 'Launch Kit', description: 'Demo project' });
    assert.equal(created.metadata.title, 'Launch Kit');
    assert.equal(created.workflow.name, 'Launch Kit');

    const loaded = await getProject(created.metadata.id);
    assert.equal(loaded.metadata.id, created.metadata.id);

    const workflowProject = await createProjectWorkflow(created.metadata.id, 'Second Workflow');
    assert.equal(workflowProject.workflow.name, 'Second Workflow');
    assert.equal(workflowProject.metadata.workflows?.length, 2);

    const savedWorkflow = {
      ...workflowProject.workflow,
      name: 'Second Workflow Renamed',
      nodes: [
        {
          id: 'prompt',
          type: 'prompt' as const,
          position: { x: 0, y: 0 },
          data: { fieldsMode: 'managed', fields: [{ id: 'text', label: 'Text', kind: 'textarea', value: 'hello' }] },
        },
      ],
    };
    await saveProjectWorkflow(created.metadata.id, savedWorkflow);

    const reloadedWorkflow = await loadProjectWorkflow(created.metadata.id, workflowProject.workflow.id);
    assert.equal(reloadedWorkflow.workflow.name, 'Second Workflow Renamed');
    assert.equal(reloadedWorkflow.workflow.nodes[0]?.id, 'prompt');

    const renamed = await renameProject(created.metadata.id, 'Renamed Project');
    assert.equal(renamed.metadata.title, 'Renamed Project');

    const projects = await listProjects();
    assert.deepEqual(projects.map((project) => project.id), [created.metadata.id]);
    assert.deepEqual(await listProjectAssets(created.metadata.id), []);

    const projectDir = join(home, 'projects', created.metadata.id);
    assert.ok(existsSync(join(projectDir, 'imagex.project.json.bak')));
    assert.match(await readFile(join(projectDir, 'imagex.project.json'), 'utf8'), /Renamed Project/);

    await deleteProject(created.metadata.id);
    assert.deepEqual(await listProjects(), []);
  } finally {
    if (previousHome === undefined) delete process.env.IMAGEX_HOME;
    else process.env.IMAGEX_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});
