const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const scanRoots = ['controllers', 'services', 'models', 'utils', 'lib'];
const oversized = /(?:limit\s*\(|limit\s*:\s*|take\s*:\s*)(?:10000|[1-9]\d{4,})/g;
const files = [];

function walk(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(filePath);
    else if (entry.isFile() && filePath.endsWith('.js')) files.push(filePath);
  }
}
scanRoots.forEach((directory) => walk(path.join(root, directory)));

const violations = [];
for (const filePath of files) {
  const source = fs.readFileSync(filePath, 'utf8');
  for (const match of source.matchAll(oversized)) {
    const line = source.slice(0, match.index).split(/\r?\n/).length;
    violations.push(`${path.relative(root, filePath)}:${line}`);
  }
}

const requiredMarkers = [
  ['utils/querySafety.js', 'parseBoundedPage'],
  ['lib/readContext.js', 'readContextMiddleware'],
  ['utils/prismaCompat.js', 'assertReadLimit'],
  ['lib/prisma.js', 'assertReadLimit'],
];
for (const [relative, marker] of requiredMarkers) {
  const filePath = path.join(root, relative);
  if (!fs.existsSync(filePath) || !fs.readFileSync(filePath, 'utf8').includes(marker)) {
    violations.push(`${relative}: missing ${marker}`);
  }
}

if (violations.length) {
  console.error('Query safety check failed:');
  violations.forEach((violation) => console.error(` - ${violation}`));
  process.exitCode = 1;
} else {
  console.log(`Query safety check passed (${files.length} backend JavaScript files scanned).`);
}
