import { join, dirname, basename, extname, relative, resolve } from 'path';
import { unlink } from 'fs/promises';
import requireFresh from 'import-fresh';
import findUp from 'find-up';
import {
  map,
  flat,
  flatMap,
  wrap,
  asyncMap,
  asyncToArray,
  execPipe,
  takeLast,
} from 'iter-tools-es';
import Queue from '@iter-tools/queue';
import { Errawr, rawr } from 'errawr';

import { WatchmanClient, standaloneQuery } from './watchman.js';
import { Api, GeneratorApi, MapChangeApi } from './apis.js';
import { matches } from './matchable.js';
import { logger as baseLogger } from './utils/logger.js';
import { buildOptions } from './config.js';

import accessors from './accessors/index.js';
import { vcsConfigs } from './vcs-configs.js';
import { get } from './utils/map.js';
import { openKnownFileForReading } from './utils/fs.js';
import { timeout } from './utils/timer.js';

const logger = baseLogger.get('macrome');

// eslint-disable-next-line @typescript-eslint/naming-convention
const verbsByOp = { A: 'add', D: 'remove', M: 'update' };
const verbFor = (change) => verbsByOp[change.op];

export class Macrome {
  constructor(apiOptions = {}) {
    const options = buildOptions(apiOptions);

    this.options = options;

    const { root, quiet } = options;

    if (quiet) logger.notice.disable();

    const vcsDir = findUp.sync(
      vcsConfigs.map((c) => c.dir),
      {
        type: 'directory',
        cwd: root,
      },
    );

    this.root = root;
    this.watchRoot = dirname(vcsDir || root);
    this.api = new Api(this);
    this.generators = new Map();
    this.generatorsMeta = new WeakMap();
    this.state = new Map();

    if (vcsDir) {
      const vcsDirName = basename(vcsDir);
      const vcsConfig = vcsConfigs.find(({ dir }) => dir === vcsDirName) || null;

      this.vcsConfig = vcsConfig;
    }

    this.accessorsByFileType = new Map(
      // we do not yet have types for which more than one accessor may be valid
      flatMap((axr) => map((type) => [type, axr], axr.supportedFileTypes), accessors),
    );
  }

  get logger() {
    return logger;
  }

  async __initialize() {
    for (const generatorPath of this.options.generators.keys()) {
      await this.__instantiateGenerators(generatorPath);
    }

    this.initialized = true;
  }

  get generatorInstances() {
    return flat(1, this.generators.values());
  }

  async __instantiateGenerators(generatorPath) {
    const Generator = requireFresh(generatorPath);

    for (const generator of get(this.generators, generatorPath, [])) {
      const { api } = this.generatorsMeta.get(generator);
      await generator.destroy?.(api);
      api.__destroy();
    }

    this.generators.set(generatorPath, []);

    const stubs = this.options.generators.get(generatorPath);

    for (const { options, path } of stubs) {
      const mappings = new Map();
      const generator = new Generator(options);
      const api = GeneratorApi.fromApi(
        this.api,
        /^[./]/.test(path) ? `/${relative(this.watchRoot, generatorPath)}` : path,
      );

      await generator.initialize?.(api);

      this.generators.get(generatorPath).push(generator);
      this.generatorsMeta.set(generator, { mappings, api });
    }
  }

  async __forMatchingGenerators(path, cb) {
    const { generatorsMeta } = this;

    for (const generator of this.generatorInstances) {
      // Cache me!
      if (matches(path, generator)) {
        await cb(generator, generatorsMeta.get(generator));
      }
    }
  }

  __getBaseExpression() {
    const { alwaysExclude: exclude } = this.options;

    return {
      suffixes: [...this.accessorsByFileType.keys()],
      exclude,
    };
  }

  async __decorateChangeWithAnnotations(change) {
    const path = this.resolve(change.path);
    const accessor = this.accessorFor(path);

    if (change.op !== 'D') {
      let annotations = null;

      if (accessor) {
        const fd = await openKnownFileForReading(path, change.mtimeMs);

        try {
          annotations = await this.readAnnotations(path, { fd });
        } finally {
          await fd.close();
        }
      }
      return { op: change.op, reported: change, annotations };
    } else {
      return { op: change.op, reported: change, annotations: null };
    }
  }

  async __scanChanges() {
    const changes = await standaloneQuery(this.root, this.__getBaseExpression());

    return await asyncToArray(
      asyncMap((change) => this.__decorateChangeWithAnnotations(change), changes),
    );
  }

  accessorFor(path) {
    const ext = extname(path).slice(1);

    return this.accessorsByFileType.get(ext) || null;
  }

  async readAnnotations(path, options) {
    const accessor = this.accessorsByFileType.get(extname(path).slice(1));

    if (!accessor) return null;

    logger.get('accessors').debug(`Reading annotations for {path: ${path}}`);

    return await accessor.readAnnotations(this.resolve(path), options);
  }

  enqueue(change) {
    const { op, reported } = change;
    const { path } = reported;
    const state = this.state.get(path);

    if (op === 'D') {
      if (!state) return;
    } else {
      if (state?.mtimeMs === reported.mtimeMs) {
        // This is an "echo" change: the watcher is reporting it but it was already enqueued synchronously
        return;
      }
    }

    this.__enqueue(change);
  }

  __enqueue(change) {
    const queue = this.queue;
    const { reported, annotations } = change;
    const { path } = reported;

    const prevState = this.state.get(path) || null;

    let enquedChange;
    if (change.op !== 'D') {
      const { reported, annotations = null } = change;
      const { mtimeMs, sha1hex } = reported;
      const generatedPaths = prevState ? prevState.generatedPaths : new Set();

      const state = { mtimeMs, sha1hex, annotations, generatedPaths };

      this.state.set(path, state);

      enquedChange = {
        op: change.op,
        path,
        reported,
        annotations,
        state,
        prevState,
      };
    } else {
      this.state.delete(path);

      enquedChange = {
        op: change.op,
        path,
        reported: change.reported,
        annotations: null,
        state: null,
        prevState,
      };
    }

    // We need to update state for these paths, but there's no point in allowing them as inputs
    if (!annotations?.has('generatefailed')) {
      logger.debug(
        `enqueueing ${verbFor(change)} {path: ${path}}` +
          (reported.op !== 'D' ? ` modified at {mtimeMs: ${reported.mtimeMs}}` : ''),
      );
      queue.push(enquedChange);
    }
  }

  // Where the magic happens.
  async processChanges() {
    const { queue, options, generatorsMeta } = this;
    const processedPaths = []; // just for debugging

    if (!queue) {
      throw new Error('processChanges() called with no queue');
    }

    const { settleTTL } = options;
    let ttl = settleTTL;
    // TODO parallelize
    // may want to factor out runners, parallel and non-parallel a la jest
    while (queue.size) {
      // Handle bouncing between states: map -> reduce -> map -> reduce
      if (ttl === 0) {
        this.queue = null;
        throw new Error(
          `Macrome state has not settled after ${settleTTL} cycles, likely indicating an infinite loop`,
        );
      }

      const generatorsToReduce = new Set();

      while (queue.size) {
        const change = queue.shift();

        const { reported, state, prevState } = change;
        const { path } = reported;
        const prevGeneratedPaths = prevState && prevState.generatedPaths;

        logger.debug(
          `executing ${verbFor(change)} {path: ${path}}` +
            (reported.op !== 'D' ? ` modified at {mtimeMs: ${reported.mtimeMs}}` : ''),
        );

        if (change.op !== 'D') {
          state.generatedPaths = new Set();

          await this.__forMatchingGenerators(path, async (generator, { mappings, api: genApi }) => {
            // Changes made through this api feed back into the queue
            const api = MapChangeApi.fromGeneratorApi(genApi, change);
            const info = { path, generator: api.generatorPath };

            try {
              // generator.map()
              let mapResult = generator.map(api, change);

              const controller = new AbortController();
              const { signal } = controller;

              if (mapResult instanceof Promise) {
                mapResult = await Promise.race([mapResult, timeout(5000, { signal })]);

                controller.abort();
              }

              mappings.set(path, mapResult);
            } catch (error) {
              const rootCause = takeLast(Errawr.chain(error));
              if (rootCause?.code === 'macrome_would_overwrite_source') {
                logger.warn(rootCause.message);
              } else {
                // Generators must contractually handle their own error conditions, e.g. with api.generate();
                // An unhandled exception is thus indicative of a programming error, and it is not safe to continue
                throw new Errawr(rawr(`Error mapping {path}`), {
                  code: 'map_unexpected_error',
                  info,
                  cause: error,
                });
              }
            } finally {
              api.__destroy();
              generatorsToReduce.add(generator);
            }
          });
        } else {
          await this.__forMatchingGenerators(path, async (generator, { mappings }) => {
            // Free any map results the file made
            mappings.delete(path);
            generatorsToReduce.add(generator);
          });
        }

        for (const path of wrap(prevGeneratedPaths)) {
          // Ensure the user hasn't deleted our annotations and started manually editing this file
          if (!state?.generatedPaths.has(path) && (await this.readAnnotations(path)) !== null) {
            logger.info(`removing {path: ${path}} which is no longer being generated`);

            await unlink(this.resolve(path));

            this.enqueue(
              await this.__decorateChangeWithAnnotations({ op: 'D', path, mtimeMs: null }),
            );
          }
        }

        processedPaths.push(path);
      }

      for (const generator of this.generatorInstances) {
        if (generatorsToReduce.has(generator) && generator.reduce) {
          const { mappings, api } = generatorsMeta.get(generator);

          try {
            const controller = new AbortController();
            const { signal } = controller;

            await Promise.race([generator.reduce(api, mappings), timeout(10000, { signal })]);

            controller.abort();
          } catch (error) {
            throw new Errawr(
              rawr(`Error reducing {generator}`)({
                generator: api.generatorPath,
              }),
              { cause: error },
            );
          }
        }
      }

      ttl--;
    }
  }

  async clean() {
    const changes = await this.__scanChanges();

    for (const change of changes) {
      if (change.op !== 'D' && change.annotations != null) {
        await unlink(this.resolve(change.reported.path));
      }
    }
  }

  async __build(changes) {
    if (!this.initialized) await this.__initialize();

    this.queue = new Queue();

    for (const change of changes) {
      if (change.op !== 'D' && !change.annotations) {
        this.enqueue(change);
      }
    }

    await this.processChanges();

    for (const change of changes) {
      const { reported } = change;
      // remove @generated state which were not generated
      if (change.op !== 'D' && change.annotations) {
        if (!this.state.has(reported.path)) {
          logger.warn(`Removing stale generated file {path: ${reported.path}}`);
          await unlink(this.resolve(reported.path));
        }
      }
    }

    await this.processChanges();

    this.queue = null;
  }

  async build() {
    await this.__build(await this.__scanChanges());
  }

  async watch() {
    const { root, vcsConfig, watchRoot } = this;
    const client = new WatchmanClient(root);

    this.watchClient = client;

    await client.version({
      required: [
        'cmd-watch-project',
        'cmd-subscribe',
        'cmd-state-enter',
        'cmd-state-leave',
        'cmd-clock',
        'cmd-flush-subscriptions',
        'term-allof',
        'term-anyof',
        'term-not',
        'term-pcre',
        'field-name',
        'field-exists',
        'field-new',
        'field-type',
        'field-mtime_ms',
        'field-content.sha1hex',
        'relative_root',
      ],
      optional: ['suffix-set'],
    });

    await client.watchProject(watchRoot);

    const fields = ['name', 'mtime_ms', 'content.sha1hex', 'exists', 'type', 'new'];

    const expression = this.__getBaseExpression();

    const { files: changes, clock: start } = await client.query('/', expression, { fields });

    await this.__build(
      await execPipe(
        changes,
        asyncMap(async (change) => await this.__decorateChangeWithAnnotations(change)),
        asyncToArray,
      ),
    );

    this.progressive = true;
    logger.notice('Initial generation completed; watching for changes...');

    if (vcsConfig) {
      await client.subscribe(
        '/',
        'macrome-vcs-lock',
        { include: ['name', join(vcsConfig.dir, vcsConfig.lock)] },
        {
          fields: ['name', 'exists'],
          defer_vcs: false,
        },
        async (state) => {
          const [lock] = state;

          return await client.command(
            lock.op !== 'D' ? 'state-enter' : 'state-leave',
            watchRoot,
            'vcs_lock_held',
          );
        },
      );
    }

    // Establish one watch for all changes. Separate watches per generator would cause each
    // generator to run on all its inputs before another generator could begin.
    // This would prevent parallelization.
    await client.subscribe(
      '/',
      'macrome-main',
      expression,
      {
        drop: ['vcs_lock_held'],
        defer_vcs: false, // for consistency use our version
        fields,
        since: start,
      },
      async (changes) => {
        const noQueue = this.queue === null;
        if (noQueue) {
          this.queue = new Queue();
        }
        for (const change of changes) {
          this.enqueue(await this.__decorateChangeWithAnnotations(change));
        }
        if (noQueue) {
          await this.processChanges();
          this.queue = null;
        }
      },
    );
  }

  stopWatching() {
    if (this.watchClient) {
      this.watchClient.end();
      this.watchClient = null;
    }
  }

  async check() {
    if (!this.vcsConfig) {
      throw new Error('macrome.check requires a version controlled project to work');
    }

    if (this.vcsConfig.isDirty(this.root)) {
      logger.warn('Check was run with vcs changes in the working dir and cannot succeed');
      return false;
    }

    await this.build();

    return !this.vcsConfig.isDirty(this.root);
  }

  relative(path) {
    return relative(this.root, this.resolve(path));
  }

  prefixRelative(path) {
    return join(this.options.prefix || '', relative(this.root, this.resolve(path)));
  }

  resolve(path) {
    return path.startsWith('/') ? path : resolve(this.root, path);
  }
}
