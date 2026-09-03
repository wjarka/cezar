const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflowPath = path.join(__dirname, '..', 'workflows', 'release.yml');

function job(source, name) {
  const match = source.match(new RegExp(`^  ${name}:\\n[\\s\\S]*?(?=^  [\\w-]+:\\n|(?![\\s\\S]))`, 'm'));
  assert.ok(match, `expected ${name} job`);
  return match[0];
}

function step(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(
    new RegExp(`- name: ${escaped}\\n[\\s\\S]*?(?=\\n      - name: |\\n      - id: |(?![\\s\\S]))`),
  );
  assert.ok(match, `expected step "${name}"`);
  return match[0];
}

test('the version-bump commit stages every stamped manifest and a regenerated lockfile', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const bump = step(job(workflow, 'release'), 'Open version-bump PR (patch/minor/major only)');

  assert.match(
    bump,
    /npm install --package-lock-only --ignore-scripts/,
    'the lockfile must be regenerated from the stamped manifests so npm ci can install the bump branch',
  );
  assert.match(bump, /git add[^\n]*packages\/\*\/package\.json/, 'every workspace manifest must be staged');
  assert.match(bump, /git add[^\n]*alias-cezarion\/package\.json/, 'the alias manifest must be staged');
  assert.match(bump, /git add[^\n]*package-lock\.json/, 'the regenerated lockfile must be staged');
});

test('the publish step has no npm credential and authenticates via OIDC', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  assert.match(workflow, /id-token: write/, 'trusted publishing needs the job OIDC token');
  assert.match(workflow, /environment: production/, 'the trusted publisher is pinned to production');

  const publish = step(job(workflow, 'release'), 'Publish release');
  assert.doesNotMatch(
    publish,
    /NODE_AUTH_TOKEN:/,
    'a stable release must not set NODE_AUTH_TOKEN; npm authenticates with the job OIDC token',
  );
  assert.doesNotMatch(publish, /secrets\.NPM_TOKEN/);
});

test('snapshots, nightlies, and dist-tag cleanup still pass NPM_TOKEN', () => {
  const workflows = path.join(__dirname, '..', 'workflows');
  for (const file of ['ci.yml', 'nightly.yml', 'npm-preview-cleanup.yml']) {
    const source = fs.readFileSync(path.join(workflows, file), 'utf8');
    assert.ok(
      source.includes('NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}'),
      `${file} must keep the token: OIDC cannot cover dist-tag rm, and one trusted publisher cannot cover three workflows`,
    );
  }
});

test('the GitHub Release body lists only packages that were actually published', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const release = step(job(workflow, 'release'), 'Create GitHub Release');

  assert.ok(
    release.includes('steps.release.outputs.publishedNames'),
    'the table must be built from the names the orchestrator actually published',
  );
  assert.match(release, /process\.env\.PUBLISHED_NAMES/);
  assert.doesNotMatch(
    release,
    /API_CLIENT_NAME/,
    'the private api-client must not be listed as a published package',
  );
});
