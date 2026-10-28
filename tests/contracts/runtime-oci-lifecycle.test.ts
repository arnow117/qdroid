import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DockerSandboxManager } from '../../packages/runtime-oci/src/index.js';

interface AttachCapableManager {
  attachToContainer(
    name: string,
    onStdout: (chunk: Buffer, stdin: NodeJS.WritableStream) => void,
    deadlineMs: number,
    maxOutputBytes: number,
    observeDescendants: boolean,
  ): Promise<unknown>;
}

interface AttachResult {
  descendantObservation: {
    attempts: number;
    lastExecExitCode: number | null;
    lastObservedChild: {
      pid: number;
      ppid: number;
    } | null;
    lastObserverPid: number | null;
    observerExcluded: boolean;
    observed: boolean;
  };
  descendantsObserved: boolean;
}

interface StreamingCapableManager {
  runStreamingContainer(
    name: string,
    workloadArguments: string[],
    onStdout: (chunk: Buffer, stdin: NodeJS.WritableStream) => void,
    deadlineMs: number,
    maxOutputBytes: number,
    observeDescendants: boolean,
    options?: { entrypoint?: string },
    image?: string,
  ): Promise<unknown>;
}

test('the Docker attach lifecycle handles early exit, pipe errors, and stop failure', async () => {
  const toolDirectory = await mkdtemp(join(tmpdir(), 'qdroid-fake-docker-'));
  const noDockerDirectory = await mkdtemp(join(tmpdir(), 'qdroid-no-docker-'));
  const dockerPath = join(toolDirectory, 'docker');
  const originalPath = process.env.PATH;
  const originalMode = process.env.QDROID_FAKE_DOCKER_MODE;
  const originalLogPath = process.env.QDROID_FAKE_DOCKER_LOG;
  const originalObserverCountPath = process.env.QDROID_FAKE_DOCKER_OBSERVER_COUNT;
  const originalObserverLogPath = process.env.QDROID_FAKE_DOCKER_OBSERVER_LOG;

  await writeFile(
    dockerPath,
    `#!/bin/sh
case "$1" in
  create)
    case "$QDROID_FAKE_DOCKER_MODE" in
      create-failure-after-create)
        exit 23
        ;;
    esac
    ;;
  start)
    case "$QDROID_FAKE_DOCKER_MODE" in
      early)
        exit 0
        ;;
      pipe-error)
        exec 0<&-
        printf 'frame\\n'
        sleep 0.1
        exit 0
        ;;
      stop-failure)
        sleep 0.1
        exit 0
        ;;
      stop-failure-hang)
        sleep 30
        exit 0
        ;;
      stop-success-hang)
        sleep 30
        exit 0
        ;;
      output-limit-stall|output-limit-absent)
        printf 'output-that-exceeds-the-limit'
        sleep 30
        exit 0
        ;;
      pipe-error-force-failure)
        exec 0<&-
        printf 'frame\\n'
        sleep 30
        exit 0
        ;;
      observer-only)
        sleep 30
        exit 0
        ;;
      late-child)
        sleep 30
        exit 0
        ;;
      observer-invalid-json|observer-output-overflow)
        sleep 0.1
        exit 0
        ;;
    esac
    ;;
  exec)
    if [ -n "$QDROID_FAKE_DOCKER_OBSERVER_LOG" ]; then
      printf '%s\\n' "$*" >> "$QDROID_FAKE_DOCKER_OBSERVER_LOG"
    fi

    if [ "$QDROID_FAKE_DOCKER_MODE" = "late-child" ]; then
      count_file="$QDROID_FAKE_DOCKER_OBSERVER_COUNT"
      count=0
      if [ -f "$count_file" ]; then
        count=$(cat "$count_file")
      fi
      count=$((count + 1))
      printf '%s\\n' "$count" > "$count_file"
      if [ "$count" -ge 10 ]; then
        printf '%s\\n' '{"observerPid":2,"processes":[{"pid":1,"ppid":0},{"pid":2,"ppid":1},{"pid":3,"ppid":1}]}'
        exit 0
      fi
    fi

    case "$QDROID_FAKE_DOCKER_MODE" in
      observer-invalid-json)
        printf '%s\\n' '{invalid-json'
        exit 0
        ;;
      observer-output-overflow)
        printf '%16384s' ''
        exit 0
        ;;
    esac

    printf '%s\\n' '{"observerPid":2,"processes":[{"pid":1,"ppid":0},{"pid":2,"ppid":1}]}'
    exit 0
    ;;
  inspect)
    if [ "$QDROID_FAKE_DOCKER_MODE" = "pipe-error-force-failure" ]; then
      printf 'true 0\\n'
      exit 0
    fi
    printf 'false 0\\n'
    exit 0
    ;;
  stop)
    if [ -n "$QDROID_FAKE_DOCKER_LOG" ]; then
      printf '%s\\n' "$*" >> "$QDROID_FAKE_DOCKER_LOG"
    fi
    case "$QDROID_FAKE_DOCKER_MODE" in
      stop-failure|stop-failure-hang)
        exit 23
        ;;
    esac
    exit 0
    ;;
  rm)
    if [ -n "$QDROID_FAKE_DOCKER_LOG" ]; then
      printf '%s\\n' "$*" >> "$QDROID_FAKE_DOCKER_LOG"
    fi
    case "$QDROID_FAKE_DOCKER_MODE" in
      output-limit-absent)
        printf '%s\\n' "Error response from daemon: No such container: $3" >&2
        exit 1
        ;;
      output-limit-force-failure|pipe-error-force-failure)
        printf '%s\\n' "Error response from daemon: unable to remove task-owned container" >&2
        exit 23
        ;;
    esac
    exit 0
    ;;
esac
exit 0
`,
    { mode: 0o700 },
  );
  await chmod(dockerPath, 0o700);

  process.env.PATH = `${toolDirectory}:${originalPath ?? ''}`;

  try {
    const manager = new DockerSandboxManager({ image: 'not-used-in-lifecycle-tests' });
    const attach = (manager as unknown as AttachCapableManager).attachToContainer.bind(manager);
    const stream = (manager as unknown as StreamingCapableManager).runStreamingContainer.bind(
      manager,
    );

    process.env.QDROID_FAKE_DOCKER_MODE = 'early';
    const earlyExit = await completesWithin(
      attach('early-exit', () => undefined, 1_000, 1_024, false),
      900,
    );
    assert.deepEqual(earlyExit, {
      cleanupConfirmed: true,
      descendantObservation: {
        attempts: 0,
        lastExecExitCode: null,
        lastObservedChild: null,
        lastObserverPid: null,
        observerExcluded: false,
        observed: false,
      },
      descendantsObserved: false,
      exitCode: 0,
      outputLimited: false,
      stderr: '',
      stopReason: 'completed',
      stdout: '',
    });

    process.env.QDROID_FAKE_DOCKER_MODE = 'pipe-error';
    await assert.rejects(
      () => attach('pipe-error', (_chunk, stdin) => stdin.write('response\n'), 1_000, 1_024, false),
      /EPIPE/,
    );

    process.env.QDROID_FAKE_DOCKER_MODE = 'stop-failure';
    const deadlineForceRemoved = await attach('stop-failure', () => undefined, 25, 1_024, false);
    assert.equal((deadlineForceRemoved as { cleanupConfirmed: boolean }).cleanupConfirmed, true);

    const cleanupLogPath = join(toolDirectory, 'cleanup.log');
    process.env.QDROID_FAKE_DOCKER_MODE = 'stop-failure-hang';
    process.env.QDROID_FAKE_DOCKER_LOG = cleanupLogPath;
    const stalledDeadlineForceRemoved = await completesWithin(
      stream('stop-failure-hang', [], () => undefined, 25, 1_024, false),
      900,
    );
    assert.equal(
      (stalledDeadlineForceRemoved as { cleanupConfirmed: boolean }).cleanupConfirmed,
      true,
    );
    const stalledCleanupLog = await readFile(cleanupLogPath, 'utf8');
    assert.match(stalledCleanupLog, /rm --force stop-failure-hang/);
    assert.doesNotMatch(stalledCleanupLog, /stop --time 1 stop-failure-hang/);

    process.env.QDROID_FAKE_DOCKER_MODE = 'stop-success-hang';
    await completesWithin(
      stream('stop-success-hang', [], () => undefined, 25, 1_024, false),
      900,
    );
    assert.match(await readFile(cleanupLogPath, 'utf8'), /rm --force stop-success-hang/);

    await writeFile(cleanupLogPath, '');
    process.env.QDROID_FAKE_DOCKER_MODE = 'output-limit-stall';
    const outputLimited = (await completesWithin(
      stream('output-limit-stall', [], () => undefined, 1_000, 8, false),
      900,
    )) as { cleanupConfirmed: boolean; outputLimited: boolean; stopReason: string };
    assert.equal(outputLimited.outputLimited, true);
    assert.equal(outputLimited.stopReason, 'output-limit');
    assert.equal(outputLimited.cleanupConfirmed, true);
    const forceCleanupLog = await readFile(cleanupLogPath, 'utf8');
    assert.match(forceCleanupLog, /rm --force output-limit-stall/);
    assert.doesNotMatch(forceCleanupLog, /stop --time 1 output-limit-stall/);

    await writeFile(cleanupLogPath, '');
    process.env.QDROID_FAKE_DOCKER_MODE = 'output-limit-absent';
    const absentAfterForceRemoval = (await completesWithin(
      stream('output-limit-absent', [], () => undefined, 1_000, 8, false),
      900,
    )) as { cleanupConfirmed: boolean; outputLimited: boolean };
    assert.equal(absentAfterForceRemoval.outputLimited, true);
    assert.equal(absentAfterForceRemoval.cleanupConfirmed, true);
    const absenceLog = await readFile(cleanupLogPath, 'utf8');
    assert.match(absenceLog, /rm --force output-limit-absent/);
    assert.doesNotMatch(absenceLog, /stop --time 1 output-limit-absent/);

    await writeFile(cleanupLogPath, '');
    process.env.QDROID_FAKE_DOCKER_MODE = 'pipe-error-force-failure';
    await assert.rejects(
      () =>
        completesWithin(
          stream(
            'pipe-error-force-failure',
            [],
            (_chunk, stdin) => stdin.write('reply\\n'),
            1_000,
            1_024,
            false,
          ),
          900,
        ),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /cleanup is unconfirmed/);
        const messages = collectErrorMessages(error);
        assert.ok(messages.some((message) => /EPIPE/.test(message)));
        assert.ok(messages.some((message) => /could not be removed/.test(message)));
        return true;
      },
    );

    const observerCountPath = join(toolDirectory, 'observer-count');
    const observerLogPath = join(toolDirectory, 'observer.log');
    process.env.QDROID_FAKE_DOCKER_MODE = 'observer-only';
    process.env.QDROID_FAKE_DOCKER_OBSERVER_LOG = observerLogPath;
    const observerOnly = (await completesWithin(
      attach('observer-only', () => undefined, 250, 1_024, true),
      900,
    )) as AttachResult;
    assert.equal(observerOnly.descendantsObserved, false);
    assert.equal(observerOnly.descendantObservation.observed, false);
    assert.equal(observerOnly.descendantObservation.lastObservedChild, null);
    assert.equal(observerOnly.descendantObservation.observerExcluded, true);
    assert.ok(observerOnly.descendantObservation.attempts >= 1);
    assert.match(
      await readFile(observerLogPath, 'utf8'),
      /exec --user 65532:65532 observer-only \/usr\/local\/bin\/node \/opt\/qdroid\/probe\.mjs process-table/,
    );

    process.env.QDROID_FAKE_DOCKER_MODE = 'late-child';
    process.env.QDROID_FAKE_DOCKER_OBSERVER_COUNT = observerCountPath;
    const lateChild = (await completesWithin(
      attach('late-child', () => undefined, 900, 1_024, true),
      1_700,
    )) as AttachResult;
    assert.equal(lateChild.descendantsObserved, true);
    assert.equal(lateChild.descendantObservation.observed, true);
    assert.ok(lateChild.descendantObservation.attempts >= 10);
    assert.deepEqual(lateChild.descendantObservation.lastObservedChild, { pid: 3, ppid: 1 });
    assert.equal(lateChild.descendantObservation.lastExecExitCode, 0);
    assert.equal(lateChild.descendantObservation.lastObserverPid, 2);
    assert.equal(lateChild.descendantObservation.observerExcluded, true);

    process.env.QDROID_FAKE_DOCKER_MODE = 'observer-invalid-json';
    await assert.rejects(
      () =>
        completesWithin(
          attach('observer-invalid-json', () => undefined, 900, 1_024, true),
          900,
        ),
      /did not return valid JSON/,
    );

    process.env.QDROID_FAKE_DOCKER_MODE = 'observer-output-overflow';
    await assert.rejects(
      () =>
        completesWithin(
          attach('observer-output-overflow', () => undefined, 900, 1_024, true),
          900,
        ),
      /exceeded its output limit/,
    );

    process.env.QDROID_FAKE_DOCKER_MODE = 'create-failure-after-create';
    await assert.rejects(
      () => stream('create-failure-after-create', [], () => undefined, 25, 1_024, false),
      /could not be created/,
    );
    assert.match(await readFile(cleanupLogPath, 'utf8'), /rm --force create-failure-after-create/);

    process.env.PATH = noDockerDirectory;
    delete process.env.QDROID_FAKE_DOCKER_MODE;
    delete process.env.QDROID_FAKE_DOCKER_LOG;
    delete process.env.QDROID_FAKE_DOCKER_OBSERVER_COUNT;
    delete process.env.QDROID_FAKE_DOCKER_OBSERVER_LOG;
    await assert.rejects(
      () => attach('spawn-error', () => undefined, 1_000, 1_024, false),
      /ENOENT/,
    );
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }

    if (originalMode === undefined) {
      delete process.env.QDROID_FAKE_DOCKER_MODE;
    } else {
      process.env.QDROID_FAKE_DOCKER_MODE = originalMode;
    }

    if (originalLogPath === undefined) {
      delete process.env.QDROID_FAKE_DOCKER_LOG;
    } else {
      process.env.QDROID_FAKE_DOCKER_LOG = originalLogPath;
    }

    if (originalObserverCountPath === undefined) {
      delete process.env.QDROID_FAKE_DOCKER_OBSERVER_COUNT;
    } else {
      process.env.QDROID_FAKE_DOCKER_OBSERVER_COUNT = originalObserverCountPath;
    }

    if (originalObserverLogPath === undefined) {
      delete process.env.QDROID_FAKE_DOCKER_OBSERVER_LOG;
    } else {
      process.env.QDROID_FAKE_DOCKER_OBSERVER_LOG = originalObserverLogPath;
    }

    await Promise.all([
      rm(toolDirectory, { force: true, recursive: true }),
      rm(noDockerDirectory, { force: true, recursive: true }),
    ]);
  }
});

async function completesWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error('The attach lifecycle did not observe an early process exit.'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function collectErrorMessages(error: unknown): readonly string[] {
  if (error instanceof AggregateError) {
    return error.errors.flatMap((member) => collectErrorMessages(member));
  }

  return error instanceof Error ? [error.message] : [];
}
