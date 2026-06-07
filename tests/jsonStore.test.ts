import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readJsonFile, writeJsonFile } from '../src/config/jsonStore.js';

test('readJsonFile returns a default for missing files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imagex-json-store-'));
  try {
    const value = await readJsonFile(join(dir, 'missing.json'), { ok: true });
    assert.deepEqual(value, { ok: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writeJsonFile writes atomically and recovers from backup after primary corruption', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imagex-json-store-'));
  const file = join(dir, 'state.json');
  try {
    await writeJsonFile(file, { version: 1 });
    await writeJsonFile(file, { version: 2 }, { mode: 0o600 });

    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 2 });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.ok(existsSync(`${file}.bak`));

    await writeFile(file, '{not-json', 'utf8');
    assert.deepEqual(await readJsonFile(file), { version: 1 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
