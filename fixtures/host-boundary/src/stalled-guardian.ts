process.on('message', (message: unknown) => {
  if (message === null || typeof message !== 'object') {
    return;
  }

  const record = message as { type?: unknown };
  if (record.type === 'start') {
    process.send?.({
      containerId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      type: 'created',
    });
    return;
  }

  if (record.type === 'input') {
    if (process.connected) {
      process.disconnect();
    }
    setInterval(() => undefined, 1_000);
  }
});
