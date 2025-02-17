import { join } from 'path';
import Queue from '@iter-tools/queue';
import { opendir, open } from 'fs/promises';

export function buildOptions(options) {
  const options_ = typeof options === 'string' ? { encoding: options } : options || {};

  // TODO maybe don't force this.
  return { ...options_, encoding: 'utf8' };
}

export async function* recursiveReadFiles(root, options = {}) {
  const { shouldInclude = () => true, shouldExclude = () => false } = options;
  const dirQueue = new Queue(['']);

  for (const dir of dirQueue) {
    const files = await opendir(join(root, dir));

    for await (const ent of files) {
      const path = join(dir, ent.name);
      const isDir = ent.isDirectory();
      const isFile = ent.isFile();

      if ((!isDir && !isFile) || shouldExclude(isDir ? `${path}/` : path)) {
        continue;
      }

      if (isDir) {
        dirQueue.push(path);
      } else {
        if (shouldInclude(path) && !shouldExclude(path)) {
          yield path;
        }
      }
    }
  }
}

// Make sure we're reading the right version of the right file
export async function openKnownFileForReading(path, expectedMtimeMs) {
  const handle = await open(path, 'r');
  const stats = await handle.stat();
  const mtimeMs = Math.floor(stats.mtimeMs);

  if (mtimeMs !== expectedMtimeMs) {
    throw new Error(
      `Unable to read additional info about file \`${path}\`.\nExpected mtimeMs: ${expectedMtimeMs}\nmtimeMs: ${stats.mtimeMs}`,
    );
  }

  return handle;
}
