import { pipeline as pipelineCb } from 'stream';

import { createReadStream, createWriteStream } from 'fs';
import { promisify } from 'util';
import { readFile } from 'fs/promises';
import { first, firstOr } from 'iter-tools-es';
import { parse, exec } from '@iter-tools/regex/async/chunked';
import { CCommentParser } from './parser.js';
import { buildOptions } from '../../utils/fs.js';

const prefixExp = /^#![^\r\n]*\r?\n/s;
const firstCommentExp = /\s*\/\*\s*@macrome\b.*?\*\//s;
const headerExp = parse(`^(${prefixExp.source})?(${firstCommentExp.source})`, 's');

const supportedFileTypes = ['js', 'jsx', 'ts', 'tsx', 'cjs', 'mjs'];

const pipeline = promisify(pipelineCb);

export class CAccessor {
  supportedFileTypes = supportedFileTypes;
  commentParser = new CCommentParser();

  async readAnnotations(path, options) {
    const match = await exec(headerExp, await createReadStream(path, buildOptions(options)));
    return match && this.commentParser.parse(match[2]).annotations;
  }

  async read(path, options) {
    const content = await readFile(path, buildOptions(options));

    const match = await exec(headerExp, content);

    if (!match) return { header: null, content };

    const [, prefix = '', comment] = match;

    return (
      match && {
        header: this.commentParser.parse(comment),
        content: prefix + content.slice(match[0].length),
      }
    );
  }

  async write(path, file, options) {
    const { header, content } = file;
    if (header && (!header.annotations || first(header.annotations.keys()) !== 'macrome')) {
      throw new Error('macrome annotation must be first');
    }

    const prefix = firstOr('', prefixExp.exec(content));
    const headerText = header ? this.commentParser.print(header) : '';

    const stream = createWriteStream(path, buildOptions(options));

    await pipeline(`${prefix}${headerText}\n${content.slice(prefix.length)}`, stream);
  }
}
