'use strict';

const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const aiDir = path.join(rootDir, 'ai-engine');
const sourceExtensions = new Set(['.js', '.cjs', '.mjs', '.ts', '.tsx']);

const forbiddenImports = [
  {
    name: 'Prisma client',
    matches: (target) => target === '@prisma/client' || /(^|\/)lib\/prisma$/.test(target),
    reason: 'AI modules must read ERP data through existing services, not Prisma directly.',
  },
  {
    name: 'raw SQL utilities',
    matches: (target) => /(^|\/)utils\/(sqlQuery|prismaTenant|prismaCompat|prismaAggregate)$/.test(target),
    reason: 'AI modules must not bypass service-level provenance and tenant filtering.',
  },
  {
    name: 'Mongo connection',
    matches: (target) => target === 'mongoose' || /(^|\/)utils\/mongo(Connection|Aggregation)$/.test(target),
    reason: 'AI modules must not use Mongo directly outside AI-specific persistence modules.',
  },
  {
    name: 'ERP Mongoose model',
    matches: (target) => /(^|\/)models\/(?!AI[A-Za-z0-9_-]*$)/.test(target),
    reason: 'AI modules must not import existing ERP models directly.',
  },
];

function toPosix(value) {
  return value.replace(/\\/g, '/');
}

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walk(fullPath, files);
      continue;
    }

    if (sourceExtensions.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }

  return files;
}

function extractImportTargets(source) {
  const targets = [];
  const patterns = [
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) {
      targets.push(match[1]);
    }
  }

  return targets;
}

function resolveTarget(file, target) {
  if (!target.startsWith('.')) return target;
  const resolved = path.resolve(path.dirname(file), target);
  return toPosix(path.relative(rootDir, resolved)).replace(/\.(js|cjs|mjs|ts|tsx)$/, '');
}

function checkFile(file) {
  const source = fs.readFileSync(file, 'utf8');
  const relativeFile = toPosix(path.relative(rootDir, file));
  const targets = extractImportTargets(source);
  const violations = [];

  for (const target of targets) {
    const resolvedTarget = resolveTarget(file, target);

    for (const rule of forbiddenImports) {
      if (rule.matches(resolvedTarget)) {
        violations.push({
          file: relativeFile,
          importTarget: target,
          resolvedTarget,
          rule: rule.name,
          reason: rule.reason,
        });
      }
    }

    if (
      relativeFile.startsWith('ai-engine/action-engine/') &&
      /(^|\/)services\//.test(resolvedTarget)
    ) {
      violations.push({
        file: relativeFile,
        importTarget: target,
        resolvedTarget,
        rule: 'Action Engine service import',
        reason: 'Action Engine must stage proposals and must not import ERP service methods directly in Phase 0.',
      });
    }
  }

  return violations;
}

function main() {
  const files = walk(aiDir);
  const violations = files.flatMap(checkFile);

  if (violations.length > 0) {
    console.error('AI dependency boundary check failed:');
    for (const violation of violations) {
      console.error(`- ${violation.file} imports "${violation.importTarget}" (${violation.rule})`);
      console.error(`  ${violation.reason}`);
    }
    process.exit(1);
  }

  console.log(`AI dependency boundary check passed (${files.length} source files scanned).`);
}

main();

