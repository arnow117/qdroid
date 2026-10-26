if (process.env.QDROID_T002_IMAGE === undefined || process.env.QDROID_T002_IMAGE.length === 0) {
  console.error('QDROID_T002_IMAGE is required for the real Linux fixture suite.');
  process.exitCode = 1;
}
