import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = process.env.QDROID_PUBLICATION_HOLDER_ROOT;
if (root === undefined) {
  throw new Error(
    'QDROID_PUBLICATION_HOLDER_ROOT is required for the publication authority holder.',
  );
}

const authorityDirectory = join(root, 'content-publication');
await mkdir(authorityDirectory, { mode: 0o700, recursive: true });

const database = new DatabaseSync(join(authorityDirectory, 'authority.sqlite'));
await chmod(join(authorityDirectory, 'authority.sqlite'), 0o600);
try {
  database.exec('PRAGMA busy_timeout = 0');
  database.exec(`
    CREATE TABLE IF NOT EXISTS content_publication_metadata (
      schema_name TEXT PRIMARY KEY,
      schema_version TEXT NOT NULL
    ) STRICT;
  `);
  database
    .prepare(
      'INSERT OR IGNORE INTO content_publication_metadata (schema_name, schema_version) VALUES (?, ?)',
    )
    .run('schema', 'qdroid.content-publication/v1');
  database.exec('BEGIN IMMEDIATE');
  process.stdout.write('ready\n');
  process.stdin.resume();
  await new Promise<void>((resolve, reject) => {
    process.stdin.once('end', resolve);
    process.stdin.once('error', reject);
  });
  database.exec('COMMIT');
} finally {
  database.close();
}
