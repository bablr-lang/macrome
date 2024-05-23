import { hasOutput } from './utils/shell.js';

export const vcsConfigs = [
  {
    name: 'git',
    dir: '.git',
    lock: 'index.lock',
    isDirty: (dir) => hasOutput('git', ['status', '-s', '--porcelain'], dir),
  },
  {
    name: 'hg',
    dir: '.hg',
    lock: 'wlock',
    isDirty: (dir) => hasOutput('hg', ['status', '--color=never', '--pager=never'], dir),
  },
];
