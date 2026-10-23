const requiredNodeVersion = '24.16.x';
const [major, minor] = process.versions.node.split('.').map(Number);

if (major !== 24 || minor !== 16) {
  console.error(
    `qdroid T001 requires Node ${requiredNodeVersion}; received v${process.versions.node}.`,
  );
  process.exitCode = 1;
}
