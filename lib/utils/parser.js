import emptyStack from '@iter-tools/imm-stack';

const posAt = (text, newPos, { idx, line, column }) => {
  while (idx < newPos) {
    const ch = text[idx++];
    if (ch === '\n') {
      column = 1;
      line++;
    } else column++;
  }
  return { idx, line, column };
};

const isObject = (obj) => {
  return typeof obj === 'object' && obj !== null;
};

const _RegexToken = (pattern) => {
  const _pattern = new RegExp(`^(${pattern.source})`, pattern.flags);
  return {
    description: 'regex token',
    match($) {
      const { text, idx } = $;
      const match = _pattern.exec(text.substring(idx));
      if (match === null) return null;

      return {
        ...$,
        stack: $.stack.push(match[0]),
        idx: $.idx + match[0].length,
      };
    },
    pattern,
  };
};

const _StringToken = (pattern) => {
  return {
    description: 'string token',
    match($) {
      if ($.text.startsWith(pattern, $.idx)) {
        return {
          ...$,
          idx: $.idx + pattern.length,
        };
      } else {
        return null;
      }
    },
    pattern,
  };
};

const _Token = (rule) => {
  if (rule instanceof RegExp) return _RegexToken(rule);
  if (typeof rule === 'string') return _StringToken(rule);
  throw new Error('Invalid rule');
};

export const WrapToken = (tokenRule) => {
  return {
    description: 'token wrapper',
    match($) {
      // avoid creating empty string which can match unexpectedly
      if ($.text.length === $.idx) {
        return null;
      }

      let $next = $.ignore.match($);

      const { text, idx, highPos } = $next;

      if (idx > highPos.idx) {
        $next = {
          ...$next,
          highPos: posAt(text, idx, highPos),
        };
      }

      return tokenRule.match($next);
    },
    tokenRule,
  };
};

export const Token = (rule) => {
  return isObject(rule) && rule.description ? rule : WrapToken(_Token(rule));
};

const _Debug = (rule) => {
  return {
    description: 'debugged rule',
    match($) {
      // eslint-disable-next-line no-debugger
      debugger;
      return rule.match($);
    },
    rule,
  };
};
export const Debug = (rule) => _Debug(Token(rule));

const _Ignore = (rule) => {
  return {
    description: 'ignore',
    match($) {
      const $next = rule.match($);

      if ($next === null) return null;

      return {
        ...$next,
        stack: $.stack,
      };
    },
  };
};
export const Ignore = (rule) => _Ignore(Token(rule));

const _IgnoreBetween = (toIgnore, rule) => {
  const ignore = _Ignore(_Plus(toIgnore));
  return {
    description: 'ignore between',
    match($) {
      // At the boundaries both ignores run.
      // It should only be the outer I think...
      const outerIgnore = $.ignore;
      const $result = rule.match(outerIgnore.match({ ...$, ignore }));

      if ($result === null) {
        return $result;
      }

      const $next = {
        ...$result,
        ignore: outerIgnore,
      };

      // ignore any ignorable token left after running rule
      return ignore.match($next);
    },
  };
};
export const IgnoreBetween = (toIgnore, rule) =>
  _IgnoreBetween(_Token(toIgnore === '' ? /$^/ : toIgnore), Token(rule));

const _All = (rules) => {
  return {
    description: 'all',
    match($) {
      let $cur = $;
      for (const rule of rules) {
        const $next = rule.match($cur);
        if ($next === null) {
          return null;
        }
        $cur = $next;
      }
      return $cur;
    },
    rules,
  };
};
export const All = (...rules) => _All(rules.map(Token));

const _Any = (rules) => {
  return {
    description: 'any',
    match($) {
      // leftmost is first/best
      for (const rule of rules) {
        const $next = rule.match($);
        if ($next !== null) {
          return $next;
        }
      }
      return null;
    },
    rules,
  };
};
export const Any = (...rules) => _Any(rules.map(Token));

const _Plus = (rule) => {
  return {
    description: 'plus',
    match($) {
      let $next = $;
      while (true) {
        const $cur = $next;

        $next = rule.match($cur);

        if ($next === null) {
          return $cur;
        }
      }
    },
    rule,
  };
};
export const Plus = (rule) => _Plus(Token(rule));

const _Optional = (rule) => {
  return {
    description: 'optional',
    match($) {
      const $next = rule.match($);
      return $next === null ? $ : $next;
    },
    rule,
  };
};
export const Optional = (rule) => _Optional(Token(rule));

export const Node = (rule, reducer = (_) => _) => {
  rule = Token(rule);

  return {
    description: 'node builder',
    match($) {
      const initialSize = $.stack.size;
      const $next = rule.match($);
      if ($next === null) {
        return null;
      }

      let { stack } = $next;
      const stackVals = [];

      // slice the stack
      while (stack.size > initialSize) {
        stackVals.push(stack.value);
        stack = stack.prev;
      }

      stackVals.reverse();

      // We have a match
      const node = reducer(stackVals);

      if (node !== null) stack = stack.push(node);

      return {
        ...$next,
        stack,
      };
    },
    rule,
    reducer,
  };
};

export const Star = (rule) => Optional(Plus(rule));

// Y combinator: neccessary to define recursive grammars
export const Y = (proc) => {
  const newProc = (x) =>
    proc({
      description: 'Y',
      match($) {
        return x(x).match($);
      },
      x,
    });
  return newProc(newProc);
};

const defaultIgnore = {
  description: 'noop ignore',
  match($) {
    return $;
  },
};

const START = (text, idx = 0) => ({
  text,
  ignore: defaultIgnore,
  stack: emptyStack,
  highPos: posAt(text, idx, { idx: 0, line: 1, column: 1 }),
  idx,
});

export class Parser {
  constructor(grammar) {
    this._grammar = grammar;
  }

  parse(text, idx = 0, partial = false) {
    if (typeof text !== 'string') {
      throw new Error('Parsing function expects a string input');
    }

    const $ = START(text, idx);
    const $result = this._grammar.match($);

    if ($result === null || (!partial && $result.idx < text.length)) {
      // TODO better error by not discarding highPos
      throw new Error('Unexpected token.');
    } else {
      return $result.stack.value;
    }
  }
}
