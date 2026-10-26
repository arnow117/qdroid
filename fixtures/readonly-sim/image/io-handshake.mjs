import readline from 'node:readline';

export function waitForIoStart(input) {
  const reader = readline.createInterface({
    crlfDelay: Infinity,
    input,
  });

  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (complete, value) => {
      if (settled) {
        return;
      }

      settled = true;
      reader.close();
      complete(value);
    };

    reader.once('line', (line) => {
      if (line === 'read') {
        finish(resolve);
        return;
      }

      finish(reject, new Error('The I/O probe received an invalid command.'));
    });
    reader.once('close', () => {
      finish(reject, new Error('The I/O probe did not receive a read command.'));
    });
  });
}

export function releaseIoInput(input) {
  if (!input.destroyed) {
    input.destroy();
  }
}
