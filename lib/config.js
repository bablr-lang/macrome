import { dirname, resolve } from 'path';
import findUp from 'find-up';
import requireFresh from 'import-fresh';
import { map, concat, execPipe } from 'iter-tools-es';

import { logger as baseLogger } from './utils/logger.js';
import { groupBy } from './utils/map.js';
import { expressionMerger, asArray } from './matchable.js';

const logger = baseLogger.get('macrome:config');

const alwaysExclude = ['.git/', 'node_modules/'];

export function buildOptions(apiOptions) {
  let root = apiOptions.root ? resolve(apiOptions.root) : null;

  let configPath = apiOptions.configPath || null;

  if (configPath === null) {
    logger.debug(`Searching for config starting from {path: ${root || process.cwd()}}`);
    const foundConfig = findUp.sync(['macrome.config.js', 'macrome.config.cjs'], {
      cwd: root || process.cwd(),
    });
    if (foundConfig) {
      configPath = foundConfig;
      logger.debug(`Located config at {path: ${configPath}}`);
    }
  }

  const configOptions = configPath === null ? {} : requireFresh(configPath);

  if (configOptions.configPath) {
    throw new Error('configPath is not a valid option in a config file');
  }

  root = root || (configPath && dirname(configPath));

  if (!root) {
    throw new Error('No root specified and none could be inferred');
  }

  const stubs = execPipe(
    concat(configOptions.generators, apiOptions.generators),
    map((path) => (Array.isArray(path) ? path : [path, {}])),
    map(([path, options]) => {
      const _options = { ...options, logger };

      const resolvedPath = path;

      return { options: _options, path, resolvedPath };
    }),
  );

  const generators = groupBy((stub) => stub.resolvedPath, stubs);

  return {
    quiet: false,
    settleTTL: 20,
    ...configOptions,
    ...apiOptions,
    generators,
    alwaysExclude: asArray(
      [alwaysExclude, configOptions.alwaysExclude, apiOptions.alwaysExclude].reduce((a, b) =>
        expressionMerger(a, b),
      ),
    ),
    root,
    configPath,
  };
}
