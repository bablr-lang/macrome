import { relative, resolve, dirname, extname } from 'path';
import { mkdir, open, readFile } from 'fs/promises';
import { Errawr, invariant, rawr } from 'errawr';
import { objectEntries, objectValues } from 'iter-tools-es';
import stripAnsi from 'strip-ansi';
import sha1 from 'sha1';
import { buildOptions } from './utils/fs.js';
import { printRelative } from './utils/path.js';
import { logger as baseLogger } from './utils/logger.js';

const _ = Symbol.for('private members');

const logger = baseLogger.get('macrome:api');

export class ApiError extends Errawr {
  get name() {
    return 'ApiError';
  }
}

const asError = (e) => {
  if (e instanceof Error) return e;
  else {
    const error = new Error(e);
    // We don't know where this came from, but it wasn't really here
    error.stack = undefined;
    return error;
  }
};

/**
 * Api is a facade over the Macrome class which exposes the functionality which should be accessible to generators
 */
export class Api {
  constructor(macrome) {
    this[_] = { macrome, destroyed: false };
  }

  __assertNotDestroyed(methodName) {
    if (this[_].destroyed) {
      throw new Error(`api.${methodName} cannot be called outside the hook providing the api`);
    }
  }

  get destroyed() {
    return this[_].destroyed;
  }

  __destroy() {
    this[_].destroyed = true;
  }

  __decorateError(error, verb) {
    return new ApiError(`macrome ${verb} failed`, { cause: error });
  }

  buildAnnotations(_destPath) {
    return new Map([['macrome', true]]);
  }

  buildErrorAnnotations(_destPath) {
    return new Map([
      ['macrome', true],
      ['generatefailed', true],
    ]);
  }

  buildErrorContent(error) {
    const stack = error.stack || String(error);
    const escaped = stripAnsi(stack.replace(/\\/g, '\\\\').replace(/`/g, '\\`'));
    return `throw new Error(\`${escaped}\`);`;
  }

  resolve(path) {
    return this[_].macrome.resolve(path);
  }

  async readAnnotations(path, options) {
    return await this[_].macrome.readAnnotations(path, options);
  }

  async read(path, options) {
    const { macrome } = this[_];
    this.__assertNotDestroyed('read');

    const { encoding = 'utf8', ..._options } = buildOptions(options);
    const accessor = macrome.accessorFor(path);

    try {
      const result = await accessor.read(this.resolve(path), { encoding, ..._options });

      return result.content;
    } catch (e) {
      throw this.__decorateError(e, 'read');
    }
  }

  async write(path, content, options) {
    const { macrome } = this[_];
    this.__assertNotDestroyed('write');

    const relPath = macrome.relative(path);
    const absPath = macrome.resolve(path);

    const annotations =
      content instanceof Error
        ? this.buildErrorAnnotations(relPath)
        : this.buildAnnotations(relPath);

    const accessor = macrome.accessorFor(relPath);

    if (!accessor) {
      throw new Errawr(rawr('macrome has no accessor for writing to {ext} files'), {
        info: { ext: extname(relPath), relPath },
      });
    }

    await mkdir(dirname(relPath), { recursive: true });

    const file = {
      header: {
        annotations,
      },
      content: content instanceof Error ? this.buildErrorContent(content) : content,
    };
    const before = Date.now();

    let fd;
    try {
      fd = await open(absPath, 'a+');
      const mtimeMs = Math.floor((await fd.stat()).mtimeMs);
      // -100 because Travis showed a 3ms discrepancy for reasons unknown
      // Is there a better way to implement this?
      const new_ = mtimeMs >= before - 100;

      let annotations = null;
      if (!new_) {
        annotations = await macrome.readAnnotations(relPath, { fd });
        if (annotations === null) {
          throw new Errawr(rawr('macrome cannot overwrite non-generated {path}'), {
            code: 'macrome_would_overwrite_source',
            info: { path: relPath, mtimeMs, before },
          });
        }
      }

      await fd.truncate();

      await accessor.write(absPath, file, { ...buildOptions(options), fd });

      await fd.close();

      // TODO hash what we write as we write it
      const sha1hex = sha1(await readFile(absPath));

      // We could wait for the watcher to do this, but there are two reasons we don't:
      // First there may not be a watcher, and we want things to work basically the same way when
      // the watcher is and is not present. Second we want to ensure that our causally linked
      // changes are always batched so that we can detect non-terminating cycles.
      const op = new_ ? 'A' : 'M';
      macrome.enqueue({
        op,
        reported: {
          op,
          path: relPath,
          mtimeMs,
          sha1hex,
        },
        annotations,
      });
    } catch (e) {
      await fd?.close();
      throw this.__decorateError(e, 'write');
    }
  }

  async generate(path, ...args) {
    let deps = {};
    let cb;
    if (args.length <= 1) {
      cb = args[0];
    } else {
      deps = args[0];
      cb = args[1];
    }

    await this.__generate(path, deps, cb);
  }

  async __generate(destPath, deps, cb) {
    const { macrome } = this[_];
    for (const dep of objectValues(deps)) {
      invariant(dep instanceof Promise, 'deps argument to api.generate must be {[key] => Promise}');
    }

    let content = null;
    try {
      const props = { destPath };
      for (const [name, dep] of objectEntries(deps)) {
        props[name] = await dep;
      }

      content = await cb(props);
    } catch (e) {
      logger.warn(`Failed generating {destPath: ${macrome.prefixRelative(destPath)}}`);
      content = asError(e);
    }
    if (content != null) {
      await this.write(destPath, content);
    }
  }
}

export class GeneratorApi extends Api {
  static fromApi(api, generatorPath) {
    const { macrome } = api[_];
    return new GeneratorApi(macrome, generatorPath);
  }

  constructor(macrome, generatorPath) {
    super(macrome);
    this[_].generatorPath = generatorPath;
  }

  get generatorPath() {
    return this[_].generatorPath;
  }

  buildAnnotations(_destPath) {
    const { generatorPath } = this[_];

    return new Map([...super.buildAnnotations(), ['generatedby', generatorPath]]);
  }

  buildErrorAnnotations(_destPath) {
    const { generatorPath } = this[_];

    return new Map([...super.buildErrorAnnotations(), ['generatedby', generatorPath]]);
  }
}

export class MapChangeApi extends GeneratorApi {
  static fromGeneratorApi(generatorApi, change) {
    const { macrome, generatorPath } = generatorApi[_];
    return new MapChangeApi(macrome, generatorPath, change);
  }

  constructor(macrome, generatorPath, change) {
    super(macrome, generatorPath);
    this[_].change = change;
  }

  get change() {
    return this[_].change;
  }

  get version() {
    return String(this.change.reported.sha1hex);
  }

  __decorateError(error, verb) {
    const { generatorPath, change } = this[_];

    return new ApiError(rawr('macrome {verb} failed', { rest: true }), {
      cause: error,
      info: { verb, generator: generatorPath, change: change.reported },
    });
  }

  buildAnnotations(destPath) {
    const { path } = this.change;
    const relPath = printRelative(relative(dirname(destPath), path));

    return new Map([
      ...super.buildAnnotations(destPath),
      ['generatedfrom', `${relPath}#${this.version}`],
    ]);
  }

  buildErrorAnnotations(destPath) {
    const { path } = this.change;
    const relPath = printRelative(relative(dirname(destPath), path));

    return new Map([
      ...super.buildErrorAnnotations(destPath),
      ['generatedfrom', `${relPath}#${this.version}`],
    ]);
  }

  async write(path, content, options) {
    const { state } = this.change;

    await super.write(path, content, options);

    state.generatedPaths.add(path);
  }

  async __generate(destPath, deps, cb) {
    const { macrome, change } = this[_];

    let handle;
    try {
      handle = await open(destPath, 'r');
      const stats = await handle.stat();
      const targetMtime = Math.floor(stats.mtimeMs);
      const targetAnnotations = await this.readAnnotations(destPath, { fd: handle });

      const targetGeneratedFrom = targetAnnotations?.get('generatedfrom');

      change.state.generatedPaths.add(destPath);

      if (targetGeneratedFrom) {
        const [fromPath, version] = targetGeneratedFrom.split('#');
        if (
          this.resolve(change.path) === resolve(dirname(this.resolve(destPath)), fromPath) &&
          String(change.reported.sha1hex) === version
        ) {
          // The target is already generated from this version of this source
          if (change.op === 'A') {
            // Since we are not generating the target, make sure its info is loaded
            macrome.state.set(destPath, {
              mtimeMs: targetMtime,
              sha1hex: version,
              annotations: targetAnnotations,
              generatedPaths: new Set(),
            });
          }
          return;
        }
      }
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    } finally {
      handle?.close();
    }

    const destPath_ = destPath.startsWith('.')
      ? resolve(dirname(this.change.path), destPath)
      : destPath;

    return super.__generate(destPath_, deps, cb);
  }
}
