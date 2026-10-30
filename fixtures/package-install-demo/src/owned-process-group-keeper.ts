import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

const [modeOrEvidencePath, descendantEvidencePath] = process.argv.slice(2);
const fixtureEntrypoint = requireFixtureEntrypoint(process.argv[1]);

if (modeOrEvidencePath === '--descendant') {
  await runFiniteDescendant(descendantEvidencePath);
} else {
  await startFiniteDescendant(modeOrEvidencePath);
}

async function startFiniteDescendant(evidencePath: string | undefined): Promise<void> {
  if (evidencePath === undefined) {
    throw new Error('The owned process-group fixture requires an evidence path.');
  }

  const descendant: ChildProcess = spawn(
    process.execPath,
    [fixtureEntrypoint, '--descendant', evidencePath],
    {
      detached: false,
      stdio: 'ignore',
    },
  );
  descendant.unref();
  process.stdout.write(`${JSON.stringify({ descendantPid: descendant.pid })}\n`);
}

async function runFiniteDescendant(evidencePath: string | undefined): Promise<void> {
  if (evidencePath === undefined) {
    throw new Error('The owned process-group descendant requires an evidence path.');
  }

  process.on('SIGTERM', () => {
    // The parent test intentionally verifies that a descendant can outlive its
    // leader. This fixture exits on its own finite timer instead of accepting a
    // signal against a process group whose ownership can no longer be proven.
  });
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 500);
  });
  await writeFile(evidencePath, 'finite descendant exited\n', 'utf8');
}

function requireFixtureEntrypoint(value: string | undefined): string {
  if (value === undefined) {
    throw new Error('The owned process-group fixture has no entrypoint.');
  }
  return value;
}
