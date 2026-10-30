import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  FIXED_ASSEMBLY_PROTOCOL,
  SandboxGuardianClient,
} from '../../packages/supervisor/src/index.js';

const directory = requiredEnvironment('QDROID_TEST_ASSEMBLY_ROOT');
const copyLogPath = requiredEnvironment('QDROID_TEST_ASSEMBLY_LOG');
const resourceId = 'assembly-98c139d3-f6ed-4c4e-9a94-13e98e3ecdd8';
const candidateId = 'candidate-98c139d3-f6ed-4c4e-9a94-13e98e3ecdd8';
const sessionId = candidateId;
const containerName = `qdroid-t005-assembly-${resourceId.slice('assembly-'.length)}`;
const sourceImage = `sha256:${'a'.repeat(64)}`;
const packageDigest = 'b'.repeat(64);
const packageDirectory = join(directory, 'content', packageDigest);
const templateDirectory = join(
  directory,
  'runtime-sessions',
  sessionId,
  `assembly-template-${resourceId.slice('assembly-'.length)}`,
);
const terminalReceiptPath = join(
  dirname(templateDirectory),
  `${resourceId}.assembly-terminal.json`,
);
const creationReceiptPath = join(dirname(templateDirectory), `${resourceId}.assembly-created.json`);
const commitReceiptPath = join(dirname(templateDirectory), `${resourceId}.assembly-committed.json`);

void start();

async function start(): Promise<void> {
  const guardian = new SandboxGuardianClient();
  const guardianPid = guardian.pid;
  if (guardianPid === undefined) {
    throw new Error('The fixture guardian did not expose a process ID.');
  }

  await guardian.startAssembly({
    bootId: '12345678-1234-1234-1234-123456789abc',
    candidateId,
    commitReceiptPath,
    containerName,
    creationReceiptPath,
    deadlineMs: 30_000,
    journalKey: Buffer.alloc(32, 7),
    materialDigest: 'd'.repeat(64),
    ownerId: 'trusted-owner',
    packageDirectory,
    packageDigest,
    platform: 'linux/arm64',
    protocol: FIXED_ASSEMBLY_PROTOCOL,
    purpose: 'runtime',
    resourceId,
    sessionId,
    sourceImage,
    templateDirectory,
    terminalReceiptPath,
  });

  const copying = guardian.copyAssembly();
  void copying.catch(() => undefined);
  await waitForLogLine(copyLogPath, 'copy-start');
  process.stdout.write(`${JSON.stringify({ guardianPid, terminalReceiptPath })}\n`);

  // This is a real active handle before the parent reports copy admission.
  // The SIGKILL fixture intentionally terminates this parent, while the
  // detached guardian keeps its copy writer and cleanup responsibility.
  setInterval(() => undefined, 1_000);
  await copying;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required fixture environment ${name}.`);
  }
  return value;
}

async function waitForLogLine(path: string, line: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const contents = await readFile(path, 'utf8');
      if (contents.split('\n').includes(line)) {
        return;
      }
    } catch {
      // The controlled Docker helper has not reached its copy writer yet.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for the controlled Docker ${line} observation.`);
}
