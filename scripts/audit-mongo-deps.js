#!/usr/bin/env node
/**
 * Audit which services still depend on MongoDB.
 *
 *   node scripts/audit-mongo-deps.js            # scheduler/job services
 *   node scripts/audit-mongo-deps.js --all      # every service and controller
 *
 * WHY THIS EXISTS
 *
 * An earlier audit checked only `require('../models/X')` and whether X was
 * Prisma-backed. That declared ten schedulers Mongo-free while three were not:
 * one resolved models through `mongoose.models` (which returns bare
 * compatibility stubs, not the Prisma models), one shelled out to `mongodump`,
 * and one used a helper named after Mongo. A service can reach MongoDB without
 * importing a single model file, so the check has to cover every route.
 *
 * Comments are stripped before matching — otherwise a comment explaining that
 * code no longer uses `mongoose.models` trips the detector for `mongoose.models`.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** Strip line and block comments so prose cannot trigger a match. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:])\/\/.*$/gm, '$1');
}

/**
 * Models with their own Mongoose schema and no Prisma backing.
 * All three conditions are required: two obvious one-line tests each produced
 * false negatives (a whitespace-sensitive schema regex missed models that
 * declare it differently; an export-shape test missed models that assign to a
 * variable first).
 */
function findMongoOnlyModels() {
  const out = new Set();
  for (const dir of ['models', 'src/models']) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const file of fs.readdirSync(abs).filter((f) => f.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(abs, file), 'utf8');
      const definesSchema = /new\s+mongoose\.Schema\s*\(/.test(src);
      const exportsModel = /mongoose\.model\s*\(/.test(src) && /module\.exports/.test(src);
      const prismaBacked = /makeCompatModel|buildTenantModel|buildGlobalModel|buildDocumentModel|lib\/prisma|utils\/(masterDataCommon|salesApCommon|prismaCompat)/.test(src);
      if (definesSchema && exportsModel && !prismaBacked) out.add(path.basename(file, '.js'));
    }
  }
  return out;
}

const CHECKS = [
  { label: 'mongoose.models registry', test: (s) => /mongoose\.models/.test(s) },
  { label: 'mongoose connection', test: (s) => /mongoose\.(connection|connect)\b/.test(s) },
  { label: 'mongo shell tool', test: (s) => /\bmongodump\b|\bmongorestore\b|\bmongosh\b/.test(s) },
  { label: 'reads Mongo URI', test: (s) => /config\.db\.uri|MONGODB_URI/.test(s) },
  { label: 'mongo aggregation helper', test: (s) => /utils\/mongoAggregation/.test(s), soft: true },
  { label: 'mongo connection helper', test: (s) => /utils\/mongoConnection/.test(s), soft: true },
];

function auditFile(absPath, mongoOnly) {
  const raw = fs.readFileSync(absPath, 'utf8');
  const src = stripComments(raw);
  const hard = [];
  const soft = [];

  for (const m of src.match(/require\(['"][./]*models\/([A-Za-z]+)['"]\)/g) || []) {
    const name = m.match(/models\/([A-Za-z]+)/)[1];
    if (mongoOnly.has(name)) hard.push(`model:${name}`);
  }
  for (const check of CHECKS) {
    if (check.test(src)) (check.soft ? soft : hard).push(check.label);
  }
  return { hard: [...new Set(hard)], soft: [...new Set(soft)] };
}

const all = process.argv.includes('--all');
const mongoOnly = findMongoOnlyModels();

const dirs = all ? ['services', 'controllers'] : ['services'];
const files = [];
for (const dir of dirs) {
  const abs = path.join(ROOT, dir);
  for (const f of fs.readdirSync(abs).filter((x) => x.endsWith('.js'))) {
    if (!all && !/schedul|job|worker|sync|retry/i.test(f)) continue;
    files.push(path.join(dir, f));
  }
}

console.log(`Mongoose-only models: ${mongoOnly.size}`);
console.log(`Auditing ${files.length} file(s)\n`);

let blocked = 0;
const softOnly = [];
for (const rel of files.sort()) {
  const { hard, soft } = auditFile(path.join(ROOT, rel), mongoOnly);
  if (hard.length) {
    blocked++;
    console.log(`BLOCKED  ${rel}\n           ${hard.join(', ')}`);
  } else if (soft.length) {
    softOnly.push(`${rel} (${soft.join(', ')})`);
  }
}

if (softOnly.length) {
  console.log('\nUses a Mongo-named helper, but the helper supports Prisma —');
  console.log('verify behaviour before treating as a blocker:');
  softOnly.forEach((s) => console.log(`  ${s}`));
}

console.log(`\n${blocked} blocked, ${files.length - blocked} clear.`);
process.exit(blocked > 0 ? 1 : 0);
