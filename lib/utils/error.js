export function truncateStack(error, frames = 1) {
  error.stack = error.stack && error.stack.split('\n').slice(frames).join('\n');
  return error;
}

export function printError(error) {
  let printed = '';
  let error_ = error;

  while (error_) {
    if (printed !== '') {
      printed += 'Caused by: \n';
    }
    printed += error.stack ? error.stack : error;
    error_ = error_.cause;
  }

  return printed;
}
