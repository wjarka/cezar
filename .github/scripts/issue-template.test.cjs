const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const AREA_LABELS = [
  'area-cezar',
  'area-web',
  'area-contract',
  'area-api-client',
  'area-ci',
  'area-docs',
];

test('task issue form requires an area dropdown whose options are the area labels', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'ISSUE_TEMPLATE', 'task.yml'), 'utf8');
  const match = source.match(/- type: dropdown\n[\s\S]*?id: area\n[\s\S]*?(?=\n  - type:|\s*$)/);
  assert.ok(match, 'expected a required area dropdown');
  const block = match[0];
  assert.match(block, /validations:\n\s+required: true/);
  const options = [...block.matchAll(/^\s+- (\S+)$/gm)].map((entry) => entry[1]);
  assert.deepEqual(options, AREA_LABELS);
});
