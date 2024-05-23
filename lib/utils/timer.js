import Errawr from 'errawr';

export const wait = (ms, options = {}) => {
  const { signal } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }

    const id = setTimeout(resolve, ms);

    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(id);

        reject(signal.reason);
      });
    }
  });
};

export const timeout = (ms, options = {}) => {
  return wait(ms, options).then(() => {
    throw new Errawr('Timeout expired', {
      code: 'timeout',
    });
  });
};
