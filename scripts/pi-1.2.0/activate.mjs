import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const REVIEW_BRANCH = 'review/pi-1.2.0-prep-20261013';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function checkCandidate({ rootDir = ROOT, now = Date.now() } = {}) {
  const metadata = JSON.parse(fs.readFileSync(path.join(rootDir, 'scripts/pi-1.2.0/candidate.json'), 'utf8'));
  assert.ok(now >= Date.parse(metadata.earliestActivation), `Candidate remains cooled until ${metadata.earliestActivation}`);
  assert.match(fs.readFileSync(path.join(rootDir, '.npmrc'), 'utf8'), /^min-release-age=1$/m);
  const patchFile = path.join(rootDir, 'scripts/pi-1.2.0/candidate.patch');
  assert.equal(hash(fs.readFileSync(patchFile)), metadata.patchSha256, 'Candidate patch checksum mismatch');
  const states = Object.entries(metadata.files).map(([file, hashes]) => {
    const digest = hash(fs.readFileSync(path.join(rootDir, file)));
    assert.ok(digest === hashes.before || digest === hashes.after, `Unreviewed edit in ${file}`);
    return digest === hashes.after ? 'after' : 'before';
  });
  assert.equal(new Set(states).size, 1, 'Candidate is only partially applied');
  return { patchFile, metadata, applied: states[0] === 'after' };
}

export function activateCandidate(rootDir = ROOT) {
  const checked = checkCandidate({ rootDir });
  const git = args => {
    const result = spawnSync('git', args, { cwd: rootDir, encoding: 'utf8' });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || `git ${args[0]} failed`);
    return result.stdout.trim();
  };
  assert.equal(git(['branch', '--show-current']), REVIEW_BRANCH, 'Activate only on the isolated review branch');
  if (checked.applied) return 'Candidate code already applied; dependency validation is still required.';
  git(['apply', '--check', checked.patchFile]);
  git(['apply', checked.patchFile]);
  assert.equal(checkCandidate({ rootDir }).applied, true);
  return 'Candidate code applied. No dependencies installed. Continue with the README lock/install/validation gates.';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv.length === 3 && ['--check', '--apply'].includes(process.argv[2]), 'Use --check or --apply');
  console.log(process.argv[2] === '--apply' ? activateCandidate() : checkCandidate().applied ? 'Already applied' : 'Eligible and checksummed');
}
