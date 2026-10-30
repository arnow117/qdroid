import type { SandboxLimits, SandboxProfileId } from '../../contracts/src/index.js';

/**
 * The fixed qualification programs and profile catalog are shared by the
 * trusted OCI adapter and its guardian. They are not part of the workload
 * surface: callers select a named profile probe and never provide a program,
 * Docker arguments, host path, or network target.
 */
export interface OfflineSandboxProfile {
  readonly featureSet: Readonly<{
    readonly chromium: boolean;
    readonly packageFetch: boolean;
  }>;
  readonly id: SandboxProfileId;
  readonly limits: SandboxLimits;
  readonly network: 'none';
  readonly readOnlyRoot: true;
  readonly runtime: 'qdroid-runsc';
}

export const MAX_PROFILE_LIMITS: SandboxLimits = Object.freeze({
  cpu: 1,
  deadlineMs: 120_000,
  guestNproc: 32,
  hostPids: 256,
  ioBytesPerSecond: 1_048_576,
  maxInputBytes: 1_048_576,
  maxOutputBytes: 16 * 1024 * 1024,
  memoryMiB: 1024,
  scratchMiB: 128,
  sharedMemoryMiB: 128,
});

function profile(
  id: SandboxProfileId,
  featureSet: OfflineSandboxProfile['featureSet'],
  memoryMiB: number,
): OfflineSandboxProfile {
  return Object.freeze({
    featureSet: Object.freeze({ ...featureSet }),
    id,
    limits: Object.freeze({ ...MAX_PROFILE_LIMITS, memoryMiB }),
    network: 'none',
    readOnlyRoot: true,
    runtime: 'qdroid-runsc',
  });
}

/**
 * The catalog is code-owned and immutable. JSON files under profiles/hosts
 * are documentation for operators; they are never a workload-controlled input.
 */
export const SANDBOX_PROFILE_CATALOG: Readonly<Record<SandboxProfileId, OfflineSandboxProfile>> =
  Object.freeze({
    'build-restricted': profile('build-restricted', { chromium: false, packageFetch: false }, 1024),
    'render-offline': profile('render-offline', { chromium: false, packageFetch: false }, 1024),
    'tool-offline': profile('tool-offline', { chromium: false, packageFetch: false }, 768),
  });

export const PROFILE_CPU_PROBE_DEADLINE_MS = 10_000;
export const PROFILE_CPU_PROBE_SOURCE = [
  'let phase = "ready";',
  'process.stdout.write("ready\\n");',
  'process.stdin.on("data", (chunk) => {',
  '  const command = chunk.toString("utf8").trim();',
  '  if (command === "start" && phase === "ready") {',
  '    phase = "computing";',
  '    const startedAt = process.hrtime.bigint();',
  '    while (process.hrtime.bigint() - startedAt < 2_000_000_000n) { Math.sqrt(Math.random()); }',
  '    process.stdout.write(JSON.stringify({ completed: true }) + "\\n");',
  '    phase = "complete";',
  '    return;',
  '  }',
  '  if (command === "cancel" || (command === "release" && phase === "complete")) { process.exit(0); }',
  '});',
].join('\n');

export const PROFILE_IO_PROBE_FILE_BYTES = 16 * 1024 * 1024;
export const PROFILE_IO_MIN_DURATION_MS = 12_000;
export const PROFILE_IO_PROBE_DEADLINE_MS = 30_000;
export const PROFILE_IO_DEVICE_MAJOR_MINOR = '253:16';
export const PROFILE_IO_PROBE_SOURCE = [
  'const { spawn } = require("node:child_process");',
  'let phase = "ready";',
  'process.stdout.write("ready\\n");',
  'process.stdin.on("data", (chunk) => {',
  '  const command = chunk.toString("utf8").trim();',
  '  if (command === "read" && phase === "ready") {',
  '    phase = "reading";',
  '    const startedAt = process.hrtime.bigint();',
  '    const reader = spawn("/usr/bin/dd", ["if=/opt/qdroid/io-probe.bin", "of=/dev/null", "bs=1M", "count=16", "status=none"]);',
  '    reader.once("close", (code) => {',
  '      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;',
  '      process.stdout.write(JSON.stringify({ code, elapsedMs }) + "\\n");',
  '      phase = "complete";',
  '    });',
  '    return;',
  '  }',
  '  if (command === "release" && phase === "complete") { process.exit(0); }',
  '});',
].join('\n');

export const PROFILE_NETWORK_PROBE_DEADLINE_MS = 1_000;
export const PROFILE_NETWORK_PROBE_SOURCE = [
  'const dgram = require("node:dgram");',
  'const dns = require("node:dns");',
  'const net = require("node:net");',
  'const targets = JSON.parse(process.argv[1]);',
  'const blockedTcp = (host, port) => new Promise((resolve) => {',
  '  const socket = net.connect({ host, port });',
  '  let settled = false;',
  '  let timer;',
  '  const finish = (value) => {',
  '    if (!settled) {',
  '      settled = true;',
  '      if (timer !== undefined) { clearTimeout(timer); }',
  '      resolve(value);',
  '    }',
  '  };',
  '  timer = setTimeout(() => { socket.destroy(); finish(true); }, 300);',
  '  socket.once("connect", () => { socket.destroy(); finish(false); });',
  '  socket.once("error", () => finish(true));',
  '});',
  'const sendUdp = (host, port, type) => new Promise((resolve) => {',
  '  const socket = dgram.createSocket(type);',
  '  let settled = false;',
  '  let timer;',
  '  const finish = () => {',
  '    if (!settled) {',
  '      settled = true;',
  '      if (timer !== undefined) { clearTimeout(timer); }',
  '      socket.close();',
  '      resolve(true);',
  '    }',
  '  };',
  '  timer = setTimeout(finish, 300);',
  '  socket.once("error", finish);',
  '  socket.send(Buffer.from([0x51]), port, host, finish);',
  '});',
  'const blockedDns = (host, port) => new Promise((resolve) => {',
  '  const resolver = new dns.Resolver();',
  '  const resolverHost = host.includes(":") ? `[${host}]` : host;',
  '  resolver.setServers([`${resolverHost}:${port}`]);',
  '  let settled = false;',
  '  let timer;',
  '  const finish = (value) => {',
  '    if (!settled) {',
  '      settled = true;',
  '      if (timer !== undefined) { clearTimeout(timer); }',
  '      resolve(value);',
  '    }',
  '  };',
  '  timer = setTimeout(() => { resolver.cancel(); finish(true); }, 300);',
  '  resolver.resolve4("metadata.qdroid.invalid", (error) => finish(error !== null));',
  '});',
  'if (!Array.isArray(targets) || targets.length === 0) { throw new Error("missing trusted network targets"); }',
  'Promise.all(targets.map(async (target) => {',
  '  if (!target || typeof target.host !== "string" || !Number.isInteger(target.tcpPort) || !Number.isInteger(target.udpPort) || !Number.isInteger(target.dnsPort) || (target.family !== "ipv4" && target.family !== "ipv6")) {',
  '    throw new Error("invalid trusted network target");',
  '  }',
  '  const udpType = target.family === "ipv6" ? "udp6" : "udp4";',
  '  const [tcpBlocked, udpAttemptCompleted, dnsBlocked] = await Promise.all([',
  '    blockedTcp(target.host, target.tcpPort),',
  '    sendUdp(target.host, target.udpPort, udpType),',
  '    blockedDns(target.host, target.dnsPort),',
  '  ]);',
  '  return { dnsBlocked, tcpBlocked, udpAttemptCompleted };',
  '})).then((results) => {',
  '  process.stdout.write(JSON.stringify({',
  '    dnsBlocked: results.every((result) => result.dnsBlocked),',
  '    tcpBlocked: results.every((result) => result.tcpBlocked),',
  '    udpAttemptsCompleted: results.every((result) => result.udpAttemptCompleted),',
  '  }));',
  '});',
].join('\n');

export type FixedProfileProbeSelector =
  | 'cgroup-limits'
  | 'controls'
  | 'cpu'
  | 'host-boundary'
  | 'io'
  | 'memory'
  | 'network'
  | 'pids'
  | 'scratch-limit'
  | 'shared-memory-limit';

const FIXED_PROFILE_PROBE_SELECTORS = new Set<FixedProfileProbeSelector>([
  'cgroup-limits',
  'controls',
  'cpu',
  'host-boundary',
  'io',
  'memory',
  'network',
  'pids',
  'scratch-limit',
  'shared-memory-limit',
]);

export interface FixedProfileProbeDefinition {
  readonly deadlineMs: number;
  readonly requiresInput: boolean;
  readonly selector: FixedProfileProbeSelector;
}

/**
 * Builds only the control envelope for a named, trusted probe. The guardian
 * supplies the actual code-owned program and validates any opaque fixture
 * binding itself, so this cannot transport Docker arguments or host paths.
 */
export function fixedProfileProbeDefinition(
  profileId: SandboxProfileId,
  selector: FixedProfileProbeSelector,
): FixedProfileProbeDefinition {
  // Resolving the immutable catalog entry is intentional even though the
  // selected program is shared by the three closed profiles. It rejects an
  // impossible profile identifier before a guardian can construct Docker
  // arguments from it.
  const profile = SANDBOX_PROFILE_CATALOG[profileId];
  if (profile === undefined || profile.id !== profileId) {
    throw new Error('The fixed profile probe does not support this sandbox profile.');
  }

  switch (selector) {
    case 'cpu':
      return Object.freeze({
        deadlineMs: PROFILE_CPU_PROBE_DEADLINE_MS,
        requiresInput: true,
        selector,
      });
    case 'io':
      return Object.freeze({
        deadlineMs: PROFILE_IO_PROBE_DEADLINE_MS,
        requiresInput: true,
        selector,
      });
    case 'network':
      return Object.freeze({
        deadlineMs: PROFILE_NETWORK_PROBE_DEADLINE_MS,
        requiresInput: false,
        selector,
      });
    case 'cgroup-limits':
    case 'controls':
    case 'host-boundary':
    case 'memory':
    case 'pids':
    case 'scratch-limit':
    case 'shared-memory-limit':
      return Object.freeze({ deadlineMs: 10_000, requiresInput: false, selector });
  }
}

export function isFixedProfileProbeSelector(value: unknown): value is FixedProfileProbeSelector {
  return (
    typeof value === 'string' &&
    FIXED_PROFILE_PROBE_SELECTORS.has(value as FixedProfileProbeSelector)
  );
}

/**
 * These programs are fixed qualification leaves for the one profile the
 * managed installer currently supports. Selectors requiring a registered
 * boundary, network, or I/O fixture intentionally have no program here: the
 * guardian must first receive that opaque dependency from ResourceOps.
 */
export function fixedProfileProgram(
  selector: FixedProfileProbeSelector,
): readonly ['-e', string] | readonly ['/opt/qdroid/probe.mjs', 'pids'] | undefined {
  switch (selector) {
    case 'controls':
      return [
        '-e',
        [
          "const fs = require('fs');",
          "let rootError = '';",
          "try { fs.writeFileSync('/opt/qdroid/root-write-control/t004-root-write', 'x'); } catch (error) { rootError = error.code; }",
          "const status = fs.readFileSync('/proc/self/status', 'utf8');",
          'process.stdout.write(JSON.stringify({',
          'nonRoot: process.getuid() !== 0 && process.getgid() !== 0,',
          'noNewPrivileges: /^NoNewPrivs:\\s*1$/m.test(status),',
          "rootReadOnly: rootError === 'EROFS'",
          '}));',
        ].join(' '),
      ];
    case 'cgroup-limits':
      return ['-e', 'setInterval(() => {}, 1_000)'];
    case 'cpu':
      return ['-e', PROFILE_CPU_PROBE_SOURCE];
    case 'memory':
      return [
        '-e',
        [
          'const blocks = [];',
          'for (let index = 0; index < 864; index += 1) {',
          '  const block = Buffer.allocUnsafe(1024 * 1024);',
          '  for (let offset = 0; offset < block.length; offset += 4096) { block[offset] = index; }',
          '  blocks.push(block);',
          '}',
          "process.stdout.write('memory-limit-missed');",
        ].join(' '),
      ];
    case 'pids':
      return ['/opt/qdroid/probe.mjs', 'pids'];
    case 'scratch-limit':
      return [
        '-e',
        [
          "const fs = require('fs');",
          "const fd = fs.openSync('/tmp/t004-scratch-limit', 'w');",
          'let enospc = false;',
          'const block = Buffer.alloc(1024 * 1024, 7);',
          'try { for (let index = 0; index < 144; index += 1) { fs.writeSync(fd, block); } }',
          "catch (error) { enospc = error.code === 'ENOSPC'; }",
          'finally { fs.closeSync(fd); }',
          'process.stdout.write(JSON.stringify({ enospc }));',
        ].join(' '),
      ];
    case 'shared-memory-limit':
      return [
        '-e',
        [
          "const fs = require('fs');",
          'const path = `/dev/shm/t004-shared-memory-${process.pid}`;',
          "const fd = fs.openSync(path, 'w');",
          'let enospc = false;',
          'const block = Buffer.alloc(1024 * 1024, 9);',
          'try { for (let index = 0; index < 144; index += 1) { fs.writeSync(fd, block); } }',
          "catch (error) { enospc = error.code === 'ENOSPC'; }",
          'finally { fs.closeSync(fd); fs.rmSync(path, { force: true }); }',
          'process.stdout.write(JSON.stringify({ enospc }));',
        ].join(' '),
      ];
    case 'host-boundary':
    case 'io':
    case 'network':
      return undefined;
  }
}
