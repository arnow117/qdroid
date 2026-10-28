process.on('message', (message: unknown) => {
  if (message === null || typeof message !== 'object') {
    return;
  }

  const record = message as { type?: unknown };
  if (record.type === 'cleanup') {
    // Deliberately retain the private IPC channel without reporting a result.
    // Linux recovery tests use this trusted fixture to prove that the backend
    // releases its SQLite lease while keeping the durable recovery writer.
    setInterval(() => undefined, 1_000);
  }
});

// Recovery may disconnect a writer before it has received a cleanup command.
// This trusted fixture mirrors the production guardian's idle path: it exits
// without running Docker or retaining its private IPC event loop.
process.once('disconnect', () => {
  process.exit(0);
});
