import {
  PersistentCounterSimulator,
  ReferenceSimulator,
} from '../../../adapters/reference-simulator/src/index.js';
import { RuntimeCore } from '../../../packages/core/src/index.js';
import { PolicyAuthority } from '../../../packages/policy/src/index.js';
import type { BoundWorkloadIdentity } from '../../../packages/supervisor/src/index.js';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [policyPath, providerPath, serializedIdentity, taskId, readyDirectory, releasePath, role] =
  process.argv.slice(2);

if (
  policyPath === undefined ||
  providerPath === undefined ||
  serializedIdentity === undefined ||
  taskId === undefined ||
  readyDirectory === undefined ||
  releasePath === undefined
) {
  throw new Error('The race worker requires policy, provider, identity, and task arguments.');
}

const identity = JSON.parse(serializedIdentity) as BoundWorkloadIdentity;
const precheck = new DatabaseSync(policyPath);
try {
  const row = precheck
    .prepare('SELECT task_id FROM counter_tasks WHERE task_id = ?')
    .get(taskId) as { task_id: string } | undefined;
  if (row === undefined) {
    throw new Error('The prechecked task is missing.');
  }
  const budget = precheck
    .prepare(
      `SELECT COUNT(*) AS count FROM counter_grants
       WHERE active = 1 AND effect = 'allow' AND remaining_uses > 0`,
    )
    .get() as { count: number };
  if (budget.count === 0) {
    throw new Error('The prechecked one-use budget is not available.');
  }
  const approvalRequirement = precheck
    .prepare(
      `SELECT COUNT(*) AS count FROM counter_grants
       WHERE active = 1 AND effect = 'allow' AND requires_approval = 1`,
    )
    .get() as { count: number };
  if (approvalRequirement.count > 0) {
    const approval = precheck
      .prepare(
        `SELECT approval_id FROM counter_approvals
         WHERE task_id = ? AND used = 0 AND expires_at > ?`,
      )
      .get(taskId, Date.now()) as { approval_id: string } | undefined;
    if (approval === undefined) {
      throw new Error('The prechecked approval is not available.');
    }
  }
  writeFileSync(join(readyDirectory, `${process.pid}.ready`), 'prechecked');
  await waitForRelease(releasePath);
  const policy = new PolicyAuthority(policyPath);
  try {
    if (role === 'cancel') {
      policy.requestCancellation(identity, taskId, 'independent cancellation race');
    } else {
      const provider = new PersistentCounterSimulator({ databasePath: providerPath });
      try {
        const core = new RuntimeCore({
          counterProvider: provider,
          policy,
          provider: new ReferenceSimulator(),
        });
        core.dispatchQueuedCounterTask(identity, taskId);
      } finally {
        provider.close();
      }
    }
  } finally {
    policy.close();
  }
} finally {
  precheck.close();
}

function waitForRelease(releasePath: string): Promise<void> {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (existsSync(releasePath)) {
        clearInterval(timer);
        resolve();
      }
    }, 5);
  });
}
