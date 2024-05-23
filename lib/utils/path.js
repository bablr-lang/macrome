export const printRelative = (path) => (path.startsWith('.') ? path : `./${path}`);
