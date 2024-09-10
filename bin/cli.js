#!/usr/bin/env node
'use strict';

import { dirname, parse } from 'node:path';
import parseArgs from 'minimist';
import camelize from 'camelize';
import { Errawr } from 'errawr';
import requireFresh from 'import-fresh';
import findUp from 'find-up';
import { standaloneQuery } from '../lib/watchman.js';

import { Macrome } from '../lib/macrome.js';
import { logger as baseLogger } from '../lib/utils/logger.js';

const logger = baseLogger.get('macrome');
const { isArray } = Array;

const ensureArray = (value) => (isArray(value) ? value : [value]);

const argv = camelize(
  parseArgs(process.argv.slice(2), {
    alias: {
      q: 'quiet',
      h: 'help',
    },
  }),
);

process.on('unhandledRejection', (error) => {
  logger.error(`Unhandled rejection: ${Errawr.print(error)}`);
  process.exit(1);
});

function runCommand(macrome, command, argv) {
  try {
    switch (command) {
      case 'watch':
        return macrome.watch();
      case 'clean':
        return macrome.clean();
      case 'build':
        return macrome.build();
      case 'check': {
        const clean = macrome.check();

        if (!clean && !argv.quiet) {
          logger.warn(
            'Building the project resulted in file changes.\n' +
              'This probably means that the `npx macrome build` command was not run.',
          );
        }
        process.exit(clean ? 0 : 3);
      }
      default:
        console.error(`Macrome: unknown command ${command}`);
        process.exit(2);
    }
  } catch (e) {
    logger.error(Errawr.print(e));
  }
}

if (!argv.help) {
  const projectConfigPath = findUp.sync([
    'macrome.config.cjs',
    'macrome.config.js',
    'macrome.project-config.cjs',
    'macrome.project-config.js',
  ]);

  const command = argv[''][0] || 'build';

  if (projectConfigPath && parse(projectConfigPath).name.startsWith('macrome.project-config')) {
    const projectConfig = requireFresh(projectConfigPath);

    const projects = await standaloneQuery(dirname(projectConfigPath), {
      include: ensureArray(projectConfig.projects).map((project) => `${project}/macrome.config.*`),
      suffixes: ['cjs', 'js'],
    });

    for (const { path } of projects) {
      const root = `${dirname(projectConfigPath)}/${dirname(path)}`;

      runCommand(new Macrome({ ...argv, root }), command, argv);
    }
  } else {
    runCommand(new Macrome({ ...argv }), command, argv);
  }
} else {
  const usage = `Generates in-tree files tagged with @macrome.
Usage: npx macrome [command] [options]

Commands:
  build                     Run macrome generators (the default)
  watch                     Build then then perform incremental rebuilds on changes
  clean                     Delete files create by macrome generators
  check                     Builds then exits with 0 if no files were changed

Options:
  -q, --quiet               Only log errors
  -h, --help                Print this message

Exit codes:
  0 Success
  1 Unknown error
  2 Unknown command
  3 \`check\` command found changed files

Watching options
  --watchman-path           Path to a watchman binary
`;

  console.log(usage);
}
