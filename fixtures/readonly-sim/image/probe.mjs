import { spawn } from 'node:child_process';
import { promises as fs, openSync, writeSync, closeSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { createSocket } from 'node:dgram';
import { isAbsolute } from 'node:path';
import { releaseIoInput, waitForIoStart } from './io-handshake.mjs';

const ROOT_WRITE_CONTROL_DIRECTORY = '/opt/qdroid/root-write-control';
const MAX_PROCESS_TABLE_ENTRIES = 64;
const [mode, ...argumentsValue] = process.argv.slice(2);

switch (mode) {
  case 'filesystem':
    await filesystemProbe(...argumentsValue);
    break;
  case 'path-controls':
    await pathControlsProbe(...argumentsValue);
    break;
  case 'root-write-control':
    await rootWriteControlProbe(argumentsValue[0]);
    break;
  case 'process-table':
    await processTableProbe();
    break;
  case 'scratch-write':
    await scratchWrite(argumentsValue[0]);
    break;
  case 'scratch-read':
    await scratchRead(argumentsValue[0]);
    break;
  case 'network':
    await networkProbe(argumentsValue[0]);
    break;
  case 'dns-query':
    emit({ packet: dnsQuery().toString('hex') });
    break;
  case 'cpu':
    cpuProbe();
    break;
  case 'pids':
    await pidProbe();
    break;
  case 'scratch-enospc':
    scratchEnospcProbe();
    break;
  case 'memory':
    memoryProbe();
    break;
  case 'io':
    await ioProbe();
    break;
  default:
    process.exitCode = 2;
}

async function filesystemProbe(canaryPath, secretPath, storePath) {
  const pathControls = await readPathControls(canaryPath, secretPath, storePath);
  const rootWrite = await rootWriteControlProbe(ROOT_WRITE_CONTROL_DIRECTORY, false);
  const dockerSocketStatus = await unixSocketStatus('/var/run/docker.sock');
  const readableControlReadFails = await readFails('/opt/qdroid/readable-control.txt');
  const syntheticSocketReachable = await verifySyntheticSocketReachable().catch(() => false);
  const mounts = await fs.readFile('/proc/mounts', 'utf8');
  const status = await fs.readFile('/proc/self/status', 'utf8');
  const capEff = /^CapEff:\s*0+$/m.test(status);
  const noNewPrivileges = /^NoNewPrivs:\s*1$/m.test(status);
  const rootMountReadOnly = mounts
    .split('\n')
    .map((line) => line.split(' '))
    .some((fields) => fields[1] === '/' && fields[3]?.split(',').includes('ro'));

  emit({
    ...pathControls,
    capEff,
    dockerSocketStatus,
    noNewPrivileges,
    nonRoot: process.getuid() !== 0 && process.getgid() !== 0,
    ...rootWrite,
    readableControlReadFails,
    rootMountReadOnly,
    syntheticSocketReachable,
  });
}

async function pathControlsProbe(canaryPath, secretPath, storePath) {
  emit(await readPathControls(canaryPath, secretPath, storePath));
}

async function rootWriteControlProbe(directory, emitResult = true) {
  const controlDirectory = requiredAbsolutePath(directory, 'root write control directory');
  const metadata = await fs.stat(controlDirectory);

  if (!metadata.isDirectory() || (metadata.mode & 0o777) !== 0o777) {
    throw new Error('The root write control directory is not a writable synthetic rootfs path.');
  }

  const probePath = `${controlDirectory}/root-write-probe-${process.pid}`;
  const rootWriteError = (await writeFailureCode(probePath)) ?? 'none';

  if (rootWriteError === 'none') {
    await fs.rm(probePath, { force: true });
  }

  const result = {
    readOnlyRoot: rootWriteError === 'EROFS',
    rootWriteError,
  };

  if (emitResult) {
    emit(result);
  }

  return result;
}

async function processTableProbe() {
  const entries = await fs.readdir('/proc', { withFileTypes: true });
  const processIds = entries
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => Number.parseInt(entry.name, 10))
    .sort((left, right) => left - right);

  if (processIds.length > MAX_PROCESS_TABLE_ENTRIES) {
    throw new Error('The guest process table exceeds the fixed observer bound.');
  }

  const processes = [];

  for (const processId of processIds) {
    const status = await fs.readFile(`/proc/${processId}/status`, 'utf8');
    const pid = readStatusProcessId(status, 'Pid');
    const ppid = readStatusProcessId(status, 'PPid');

    if (pid !== processId) {
      throw new Error('The guest process table changed while the observer was reading it.');
    }

    processes.push({ pid, ppid });
  }

  if (!processes.some((entry) => entry.pid === process.pid)) {
    throw new Error('The guest process observer cannot find itself in /proc.');
  }

  emit({ observerPid: process.pid, processes });
}

function readStatusProcessId(status, field) {
  const match = new RegExp(`^${field}:\\s*(\\d+)$`, 'm').exec(status);
  const value = match === null ? Number.NaN : Number.parseInt(match[1], 10);

  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`The guest process status has no valid ${field} value.`);
  }

  return value;
}

async function readPathControls(canaryPath, secretPath, storePath) {
  const hostCanaryPath = requiredAbsolutePath(canaryPath, 'canary path');
  const syntheticSecretPath = requiredAbsolutePath(secretPath, 'secret path');
  const trustedStorePath = requiredAbsolutePath(storePath, 'store path');
  const canaryUnreadable = await readFails(hostCanaryPath);
  const canaryWriteRejected = await writeFails(hostCanaryPath);
  const syntheticSecretUnreadable = await readFails(syntheticSecretPath);
  const trustedStoreUnreadable = await readFails(trustedStorePath);

  return {
    canaryUnreadable,
    canaryWriteAttempted: true,
    canaryWriteRejected,
    syntheticSecretUnreadable,
    trustedStoreUnreadable,
  };
}

async function scratchWrite(marker) {
  await fs.writeFile(`/tmp/${marker}`, 'private-scratch', { mode: 0o600 });
  emit({ wrote: true });
}

async function scratchRead(marker) {
  try {
    await fs.access(`/tmp/${marker}`);
    emit({ present: true });
  } catch {
    emit({ present: false });
  }
}

async function networkProbe(serializedTarget) {
  const target = JSON.parse(serializedTarget);
  await Promise.all([
    connectFails(target.host, target.tcpPort),
    udpSend(target.host, target.udpPort, Buffer.from('udp-probe')),
    udpSend(target.host, target.dnsPort, dnsQuery()),
    connectFails('::1', target.ipv6Port),
  ]);
  emit({ attempted: 4 });
}

function cpuProbe() {
  const startWall = process.hrtime.bigint();
  const startCpu = process.cpuUsage();
  const durationNs = 2_000_000_000n;

  while (process.hrtime.bigint() - startWall < durationNs) {
    Math.sqrt(Math.random());
  }

  const cpu = process.cpuUsage(startCpu);
  const elapsedMs = Number(process.hrtime.bigint() - startWall) / 1_000_000;
  const cpuMs = (cpu.user + cpu.system) / 1_000;
  emit({ cpuToWallRatio: cpuMs / elapsedMs });
}

async function pidProbe() {
  const children = [];
  let forkDenied = false;

  for (let index = 0; index < 40; index += 1) {
    const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    children.push(child);
    child.on('error', (error) => {
      if (error.code === 'EAGAIN') {
        forkDenied = true;
      }
    });
  }

  await delay(150);

  for (const child of children) {
    child.kill('SIGKILL');
  }

  emit({ forkDenied });
}

function scratchEnospcProbe() {
  let enospc = false;
  const file = openSync('/tmp/exhaust-scratch', 'w');

  try {
    for (let index = 0; index < 20; index += 1) {
      writeSync(file, Buffer.alloc(1024 * 1024, index));
    }
  } catch (error) {
    enospc = error?.code === 'ENOSPC';
  } finally {
    closeSync(file);
  }

  emit({ enospc });
}

function memoryProbe() {
  const allocations = [];

  for (let index = 0; index < 768; index += 1) {
    const allocation = Buffer.allocUnsafe(1024 * 1024);

    for (let offset = 0; offset < allocation.length; offset += 4_096) {
      allocation[offset] = index;
    }

    allocations.push(allocation);
  }

  emit({ allocationCompleted: true });
}

async function ioProbe() {
  emit({ phase: 'ready' });
  try {
    await waitForIoStart(process.stdin);
  } finally {
    releaseIoInput(process.stdin);
  }

  ioStatus('read-command-accepted');
  const startedAt = process.hrtime.bigint();
  const completed = await runBoundedRead();
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

  if (completed.exitCode !== 0) {
    throw new Error(`The bounded I/O reader exited with ${completed.exitCode}.`);
  }

  emit({ elapsedMs, phase: 'read-complete' });
  await delay(2_000);
  ioStatus('capture-wait-complete');
}

async function runBoundedRead() {
  const reader = spawn('/usr/bin/dd', [
    'if=/opt/qdroid/io-probe.bin',
    'of=/dev/null',
    'bs=1M',
    'count=16',
    'status=none',
  ]);
  ioStatus('dd-spawned');

  return new Promise((resolve, reject) => {
    reader.once('error', reject);
    reader.once('exit', (exitCode, signal) => {
      ioStatus(`dd-exit code=${exitCode ?? 'null'} signal=${signal ?? 'null'}`);
    });
    reader.once('close', (exitCode, signal) => {
      ioStatus(`dd-close code=${exitCode ?? 'null'} signal=${signal ?? 'null'}`);
      resolve({ exitCode, signal });
    });
  });
}

function ioStatus(phase) {
  const stdin = process.stdin;
  const state =
    `flowing=${stdin.readableFlowing === true} ` +
    `destroyed=${stdin.destroyed} ended=${stdin.readableEnded}`;
  process.stderr.write(`io-phase=${phase} stdin-${state}\n`);
}

async function writeFails(path) {
  try {
    await fs.writeFile(path, 'must-not-write');
    return false;
  } catch {
    return true;
  }
}

async function writeFailureCode(path) {
  try {
    await fs.writeFile(path, 'must-not-write');
    return undefined;
  } catch (error) {
    return error?.code;
  }
}

async function readFails(path) {
  try {
    await fs.readFile(path, 'utf8');
    return false;
  } catch (error) {
    if (isExpectedAccessFailure(error)) {
      return true;
    }

    throw error;
  }
}

function isExpectedAccessFailure(error) {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === 'EACCES' || error.code === 'ENOENT' || error.code === 'EPERM')
  );
}

async function unixSocketStatus(path) {
  requiredAbsolutePath(path, 'Unix socket path');

  return new Promise((resolve) => {
    let settled = false;
    const socket = connect(path);
    const timeout = setTimeout(() => {
      socket.destroy();
      settle('unknown');
    }, 300);

    const settle = (status) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      resolve(status);
    };

    socket.once('connect', () => {
      socket.end();
      settle('connected');
    });
    socket.once('error', (error) => {
      switch (error.code) {
        case 'EACCES':
        case 'EPERM':
          settle('permission-denied');
          break;
        case 'ECONNREFUSED':
          settle('refused');
          break;
        case 'ENOENT':
          settle('missing');
          break;
        default:
          settle('unknown');
      }
    });
  });
}

async function verifySyntheticSocketReachable() {
  const path = `/tmp/qdroid-probe-${process.pid}-${Date.now()}.sock`;
  const server = createServer((socket) => socket.end());

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, resolve);
    });

    return (await unixSocketStatus(path)) === 'connected';
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(path, { force: true });
  }
}

function requiredAbsolutePath(value, name) {
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) {
    throw new Error(`The ${name} must be a non-empty absolute path.`);
  }

  return value;
}

async function connectFails(host, port) {
  await new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 300 });
    socket.once('connect', () => {
      socket.end();
      resolve(false);
    });
    socket.once('error', () => resolve(true));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(true);
    });
  });
}

async function udpSend(host, port, message) {
  await new Promise((resolve) => {
    const socket = createSocket('udp4');
    socket.send(message, port, host, () => {
      socket.close();
      resolve();
    });
  });
}

function dnsQuery() {
  return Buffer.from([
    0x00,
    0x01,
    0x01,
    0x00,
    0x00,
    0x01,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x06,
    ...Buffer.from('qdroid'),
    0x07,
    ...Buffer.from('invalid'),
    0x00,
    0x00,
    0x01,
    0x00,
    0x01,
  ]);
}

function delay(timeoutMs) {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
