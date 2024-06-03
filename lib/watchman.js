import { relative, join, dirname, extname } from 'path';
import findUp from 'find-up';
import { Errawr, invariant } from 'errawr';
import { Client as BaseWatchmanClient } from 'fb-watchman';
import mm from 'micromatch';
import sha1 from 'sha1';
import { when, map, asyncFlatMap, asyncToArray, execPipe } from 'iter-tools-es';

import { readFile, stat } from 'fs/promises';
import { recursiveReadFiles } from './utils/fs.js';

import { logger as baseLogger } from './utils/logger.js';
import { asArray, mergeMatchers, mergeExcludeMatchers } from './matchable.js';

const logger = baseLogger.get('macrome:watchman');

const makeMatcher = (expr) => {
  return expr ? mm.matcher(`(${asArray(expr).join('|')})`) : undefined;
};

const makeExcludeMatcher = (expr) => {
  // allow patterns with no trailing slash to exclude directories
  // patterns with trailing / still cannot exclude files though
  return expr
    ? mm.matcher(
        '(' +
          asArray(expr)
            .map((expr) => (expr.endsWith('/') ? expr : `${expr}?(\\/)`))
            .join('|') +
          ')',
      )
    : undefined;
};

const compoundExpr = (name, ...terms) => {
  return terms.length === 0 ? null : [name, terms.length === 1 ? terms[0] : ['anyof', ...terms]];
};

const watchmanChangeToMacromeChange = ({
  name: path,
  exists,
  new: new_,
  mtime_ms: mtimeMs,
  'content.sha1hex': sha1hex,
}) =>
  !sha1hex?.error
    ? [
        {
          op: !exists ? 'D' : new_ ? 'A' : 'M',
          path,
          mtimeMs,
          sha1hex,
        },
      ]
    : [];

export class WatchmanSubscription {
  constructor(expression, subscription, onEvent) {
    this.expression = expression;
    this.name = subscription.subscribe;
    this.onEvent = onEvent;

    this.__onEvent = this.__onEvent.bind(this);
  }

  async __onEvent(message) {
    try {
      const { files, subscription } = message;

      if (files) {
        const files_ = files.flatMap(watchmanChangeToMacromeChange);

        if (subscription && files && files.length) await this.onEvent(files_);
      }
    } catch (e) {
      // TODO use new EventEmitter({ captureRejections: true }) once stable
      logger.error('\n' + Errawr.print(e));
    }
  }
}

export class WatchmanClient extends BaseWatchmanClient {
  _capabilities = null;

  constructor(root) {
    super();
    this.root = root;
    this.watchRoot = null;
    this.subscriptions = new Map();

    this.on('subscription', (event) => {
      logger.debug('<-', event);
      const subscription = this.subscriptions.get(event.subscription);
      if (subscription) subscription.__onEvent(event);
    });
  }

  get rootRelative() {
    return this.watchRoot && relative(this.watchRoot, this.root);
  }

  get capabilities() {
    const capabilities = this._capabilities;
    if (capabilities == null) {
      throw new Error('You must call watchmanClient.version() with the capabilities you may need');
    }
    return capabilities;
  }

  __expressionFrom(asymmetric) {
    const { suffixSet } = this.capabilities;
    const { include, exclude, suffixes = [] } = asymmetric || {};
    const fileExpr = (glob) => ['pcre', mm.makeRe(glob).source, 'wholename'];
    // In macrome an excluded directory does not have its files traversed
    // Watchman doesn't work like that, but we can simulate it by matching prefixes
    // That is: if /foo/bar can match /foo/bar/baz, then the /foo/bar directory is fully excluded
    const dirExpr = (glob) => {
      const re = mm.makeRe(glob + '/**');
      return ['pcre', re.source, 'wholename'];
    };
    const excludeExpr = compoundExpr('not', ...map(dirExpr, asArray(exclude)));
    const includeExpr = [...map(fileExpr, asArray(include))];
    const suffixExpr = suffixSet
      ? ['suffix', suffixes]
      : suffixes.length
      ? ['anyof', ...suffixes.map((suffix) => ['suffix', suffix])]
      : null;

    return [
      'allof',
      ['type', 'f'],
      ...when(excludeExpr, [excludeExpr]),
      ...when(includeExpr, includeExpr),
      // See https://facebook.github.io/watchman/docs/expr/suffix.html#suffix-set
      ...when(suffixExpr, [suffixExpr]),
    ];
  }

  async command(command, ...args) {
    const fullCommand = [command, ...args];

    return await new Promise((resolve, reject) => {
      try {
        logger.debug('->', fullCommand);
        super.command(fullCommand, (err, resp) => {
          if (err) {
            reject(
              new Error(
                `watchman returned an error response. Response:\n${JSON.stringify(
                  err.watchmanResponse,
                  null,
                  2,
                )}\nCommand: ${JSON.stringify(fullCommand, null, 2)}`,
              ),
            );
          } else {
            logger.debug('<-', resp);

            resolve(resp);
          }
        });
      } catch (e) {
        e.message += `\nCommand: ${JSON.stringify(fullCommand, null, 2)}`;
        throw e;
      }
    });
  }

  async watchProject(path) {
    const resp = await this.command('watch-project', path);
    this.watchRoot = resp.watch;
    return resp;
  }

  async version(options = {}) {
    const resp = await this.command('version', options);
    this._capabilities = resp.capabilities;
    return resp;
  }

  async clock() {
    return await this.command('clock', this.watchRoot);
  }

  async query(path, expression, options) {
    invariant(this.watchRoot, 'You must call watchman.watchProject() before watchman.query()');

    const resp = await this.command('query', this.watchRoot, {
      ...options,
      relative_root: relative(this.watchRoot, join(this.root, path)),
      ...when(expression, { expression: this.__expressionFrom(expression) }),
    });

    return {
      ...resp,
      files: resp.files.flatMap(watchmanChangeToMacromeChange),
    };
  }

  async subscribe(path, subscriptionName, expression, options, onEvent) {
    invariant(this.watchRoot, 'You must call watchman.watchProject() before watchman.subscribe()');

    const response = await this.command('subscribe', this.watchRoot, subscriptionName, {
      ...options,
      relative_root: relative(this.watchRoot, join(this.root, path)),
      ...when(expression, () => ({ expression: this.__expressionFrom(expression) })),
    });

    const subscription = new WatchmanSubscription(expression, response, onEvent);

    this.subscriptions.set(subscriptionName, subscription);

    return subscription;
  }
}

const getWatchmanIgnoreDirs = async (root) => {
  const watchmanConfigPath = await findUp('.watchmanconfig', { cwd: root });

  if (!watchmanConfigPath) return;

  const watchmanConfig = JSON.parse(await readFile(watchmanConfigPath, 'utf-8'));
  const ignoreDirs = watchmanConfig.ignore_dirs;
  const rootRelative = relative(dirname(watchmanConfigPath), root);

  if (!ignoreDirs || !ignoreDirs.length) return;

  return new Set(
    ignoreDirs.map((path) => join(rootRelative, path.endsWith('/') ? path : `${path}/`)),
  );
};

// Mimic behavior of watchman's initial build so that `macrome build` does not rely on the watchman service
export async function standaloneQuery(root, expression) {
  const { include, exclude, suffixes } = expression || {};
  const suffixSet = new Set(suffixes);

  const watchmanIgnoreDirs = await getWatchmanIgnoreDirs(root);
  const watchmanIgnoreMatcher = watchmanIgnoreDirs && ((path) => watchmanIgnoreDirs.has(path));

  const shouldInclude = mergeMatchers(
    (path) => suffixSet.has(extname(path).slice(1)),
    makeMatcher(include),
  );
  const shouldExclude = mergeExcludeMatchers(watchmanIgnoreMatcher, makeExcludeMatcher(exclude));

  return await execPipe(
    recursiveReadFiles(root, { shouldInclude, shouldExclude }),
    asyncFlatMap(async (path) => {
      try {
        const stats = await stat(join(root, path));
        return [
          {
            op: 'A',
            path,
            mtimeMs: Math.floor(stats.mtimeMs),
            sha1hex: sha1(await readFile(join(root, path))),
          },
        ];
      } catch (e) {
        return [];
      }
    }),
    asyncToArray,
  );
}
