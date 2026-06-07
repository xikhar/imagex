import { copyFile, mkdir, readFile, rename, rm, writeFile, chmod } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

export async function readJsonFile<T>(file: string, defaultValue?: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (error) {
    if (isMissingFile(error) && arguments.length >= 2) return defaultValue as T;
    if (isJsonParseError(error)) {
      try {
        return JSON.parse(await readFile(backupFile(file), 'utf8')) as T;
      } catch {
        // Keep the original parse error because it points at the primary file.
      }
    }
    throw error;
  }
}

export async function writeJsonFile(file: string, value: unknown, options: { mode?: number } = {}): Promise<void> {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true });

  const tempFile = join(dir, `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  const payload = `${JSON.stringify(value, null, 2)}\n`;

  try {
    await copyFile(file, backupFile(file)).catch((error: unknown) => {
      if (!isMissingFile(error)) throw error;
    });
    const writeOptions: Parameters<typeof writeFile>[2] = { encoding: 'utf8' };
    if (options.mode !== undefined) writeOptions.mode = options.mode;
    await writeFile(tempFile, payload, writeOptions);
    await rename(tempFile, file);
    if (options.mode !== undefined) await chmod(file, options.mode);
  } catch (error) {
    await rm(tempFile, { force: true }).catch(() => undefined);
    throw error;
  }
}

function backupFile(file: string): string {
  return `${file}.bak`;
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function isJsonParseError(error: unknown): boolean {
  return error instanceof SyntaxError;
}
