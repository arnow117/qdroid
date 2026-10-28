const requiredImages = ['QDROID_T002_IMAGE', 'QDROID_T004_IMAGE'];
const missing = requiredImages.filter((name) => {
  const value = process.env[name];
  return value === undefined || value.length === 0;
});

if (missing.length > 0) {
  console.error(`${missing.join(', ')} is required for the real Linux fixture suite.`);
  process.exitCode = 1;
}
