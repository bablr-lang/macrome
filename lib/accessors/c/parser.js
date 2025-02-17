import { map, joinWithSeq, execPipe, str } from 'iter-tools-es';
import { Parser, All, Star, Optional, Ignore, Node } from '../../utils/parser.js';

const defaultContent = [
  'This file is autogenerated. Please do not edit it directly.',
  'When editing run `npx macrome watch` then change the file this is generated from.',
].join('\n');

const _ = Optional(Ignore(/[ \t]+/));

const key = /[a-zA-Z-]+/;
const value = /([^*\n]|\*(?!\/))*/;
const annotation = Node(
  All(_, Optional('*'), _, '@', key, _, Optional(value), _, Optional('\n')),
  ([key, value]) => [key, value.trimEnd() || true],
);
const annotations = Node(Star(annotation), (entries) => new Map(entries));
const commentLinePrefix = / *\* ?/;
const commentLineContent = /([^*\n]|\*(?!\/))*/; // allow * but not */
const commentLine = All(Optional(Ignore(commentLinePrefix)), commentLineContent, '\n');
const commentLines = Node(All(Star(commentLine)), (commentLines) => commentLines);

const comment = Node(
  All(_, '/*', annotations, commentLines, Optional(/ */), '*/', _),
  ([annotations, commentLines]) => ({ annotations, content: commentLines.join('\n') }),
);

function renderAnnotation([key, value]) {
  return `@${key}${value === true ? '' : ` ${value}`}`;
}

export class CCommentParser {
  constructor() {
    this._parser = new Parser(comment);
  }

  parse(text) {
    return this._parser.parse(text);
  }

  print({ annotations, content = defaultContent }) {
    const body = execPipe(
      annotations,
      map((ann) => ` * ${renderAnnotation(ann)}`),
      joinWithSeq('\n'),
      str,
    );

    const comments = content.length
      ? '\n' +
        content
          .split('\n')
          .map((l) => ` * ${l}`)
          .join('\n')
      : '';

    return `/${body.slice(1)}${comments}\n */`;
  }
}
