export function groupBy(getKey, iterable) {
  const grouped = new Map();
  for (const value of iterable) {
    const key = getKey(value);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(value);
  }
  return grouped;
}

export function get(map, key, whenNotHas) {
  return map.has(key) ? map.get(key) : whenNotHas;
}
