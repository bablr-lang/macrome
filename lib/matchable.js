import picomatch from 'picomatch';
import { notNil } from 'iter-tools-es';

export const defaultMatchers = {
  include: () => true,
  exclude: () => false,
};

const { isArray } = Array;
const isString = (value) => typeof value === 'string';

export const asArray = (value) =>
  value == null ? [] : !isArray(value) ? [value] : value.filter(notNil);

export function expressionMatcher(expr, type) {
  let isMatch;

  if (expr == null || (isArray(expr) && !expr.length)) isMatch = defaultMatchers[type];
  else if (isString(expr)) isMatch = picomatch(expr);
  else if (isArray(expr)) {
    isMatch = picomatch(expr.filter(notNil));
  } else throw new Error('file matching pattern was not a string, Array, or null');

  return isMatch;
}

export const mergeMatchers = (a, b) => {
  return a && b ? (path) => a(path) && b(path) : a || b;
};

export const mergeExcludeMatchers = (a, b) => {
  return a && b ? (path) => a(path) || b(path) : a || b;
};

export function expressionMerger(exprA, exprB) {
  if (exprB == null) return exprA;
  if (exprA == null) return exprB;

  return [...asArray(exprA), ...asArray(exprB)];
}

const matchableMatchers = new WeakMap();

export function matcher(matchable) {
  if (!matchableMatchers.has(matchable)) {
    const includeMatcher = expressionMatcher(matchable.include, 'include');
    const excludeMatcher = expressionMatcher(matchable.exclude, 'exclude');

    matchableMatchers.set(matchable, (path) => includeMatcher(path) && !excludeMatcher(path));
  }
  return matchableMatchers.get(matchable);
}

export function matches(path, matchable) {
  return matcher(matchable)(path);
}
