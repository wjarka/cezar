const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflowPath = path.join(__dirname, '..', 'workflows', 'issue-intake.yml');
const schemaPath = path.join(__dirname, '..', 'schemas', 'issue-intake.schema.json');
const promptPath = path.join(__dirname, '..', 'codex', 'prompts', 'issue-intake.md');

function assertCodexEnvironment(prompt) {
  assert.match(prompt, /read-only sandbox/i);
  assert.match(prompt, /`\/tmp`/);
  assert.match(prompt, /`\/var\/tmp`/);
  assert.match(prompt, /`\/usr\/tmp`/);
  assert.match(prompt, /unwritable/i);
  assert.match(prompt, /`pytest` and `uv`[\s\S]*exit 127/i);
  assert.match(prompt, /npm run <script>.*node_modules.*tsx: not found/is);
  assert.match(prompt, /python -m unittest.*No usable temporary directory/is);
  assert.match(prompt, /do not repeatedly probe.*python.*suite/is);
  assert.match(prompt, /node --test/);
  assert.match(prompt, /python 3\.12\.3.*node\s+v24\.19\.0.*npm 11\.17\.0/is);
  assert.match(prompt, /git.*rg.*sed.*nl.*jq.*find.*yamllint.*python -c.*compile/is);
}

function job(source, name) {
  const match = source.match(new RegExp(`^  ${name}:\\n[\\s\\S]*?(?=^  [\\w-]+:\\n|(?![\\s\\S]))`, 'm'));
  assert.ok(match, `expected ${name} job`);
  return match[0];
}

test('issue intake workflow keeps its provider, permission, and fail-closed contract', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');

  assert.match(workflow, /^name: Issue Intake$/m);
  assert.match(workflow, /issues:\n    types: \[opened\]/);
  assert.match(workflow, /ISSUE_INTAKE_PROVIDER: \$\{\{ vars\.ISSUE_INTAKE_PROVIDER \}\}/);
  assert.match(workflow, /openai\/codex-action@[0-9a-f]{40} {2}# v[0-9.]+\n/, 'codex-action must be pinned to a commit SHA, not a floating tag (openai/codex-action#150)');
  assert.match(workflow, /sandbox: read-only/);

  const validator = job(workflow, 'validate-provider');
  assert.match(validator, /permissions: \{\}/);
  assert.match(validator, /case "\$ISSUE_INTAKE_PROVIDER" in/);
  assert.match(validator, /claude\|codex\)/);
  assert.match(validator, /ISSUE_INTAKE_PROVIDER must be set to claude or codex/);
  assert.match(validator, /Unsupported ISSUE_INTAKE_PROVIDER/);
  assert.doesNotMatch(validator, /ANTHROPIC_API_KEY|OPENAI_API_KEY/);

  const claude = job(workflow, 'claude-intake');
  assert.match(claude, /needs: validate-provider/);
  assert.match(claude, /if: needs\.validate-provider\.outputs\.provider == 'claude'/);
  assert.match(claude, /permissions:\n      contents: read\n      issues: write\n      id-token: write/);
  assert.match(claude, /anthropics\/claude-code-action@[0-9a-f]{40}/);
  assert.match(claude, /anthropic_api_key: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/);
  // Public-repo default: inline prompt, no private marketplace plugin.
  assert.doesNotMatch(claude, /plugin_marketplaces:/);
  assert.doesNotMatch(claude, /plugins:/);
  assert.match(claude, /Triage newly opened issue/);
  assert.match(claude, /Bash\(gh issue close \$\{.*github\.event\.issue\.number \}\}:\*\)/);
  assert.match(claude, /Bash\(gh issue edit \$\{.*github\.event\.issue\.number \}\}:\*\)/);
  assert.match(claude, /Bash\(gh label list:\*\)/);
  assert.doesNotMatch(claude, /Bash\(gh label \*\)/);
  assert.doesNotMatch(claude, /Bash\(gh issue comment/);
  assert.doesNotMatch(claude, /OPENAI_API_KEY/);
  assert.doesNotMatch(claude, /vars\.ISSUE_INTAKE_CODEX_/);

  const codex = job(workflow, 'codex-intake');
  assert.match(codex, /needs: validate-provider/);
  assert.match(codex, /if: needs\.validate-provider\.outputs\.provider == 'codex'/);
  assert.match(codex, /permissions:\n      contents: read\n      issues: read/);
  assert.doesNotMatch(codex, /issues: write/);
  assert.doesNotMatch(codex, /id-token: write/);
  assert.match(codex, /openai-api-key: \$\{\{ secrets\.OPENAI_API_KEY \}\}/);
  assert.doesNotMatch(codex, /ANTHROPIC_API_KEY/);
  assert.match(codex, /prompt-file: .*\.github\/codex\/prompts\/issue-intake\.md/);
  assert.match(codex, /output-schema-file: .*\.github\/schemas\/issue-intake\.schema\.json/);
  assert.match(codex, /name: Fetch issue context/);
  assert.match(codex, /gh api --paginate/);
  assert.doesNotMatch(codex, /--limit 50/);
  assert.match(codex, /name: Reject untrusted bot actors/);
  assert.match(codex, /\[\[ "\$ACTOR" == \*'\[bot\]' && "\$ACTOR" != 'claude\[bot\]' \]\]/);
  assert.ok(codex.indexOf('name: Reject untrusted bot actors') < codex.indexOf('openai/codex-action@'), 'bot guard must run before Codex');
  assert.match(codex, /allow-users: '\*'/);
  assert.match(codex, /allow-bot-users: 'claude\[bot\]'/);
  assert.doesNotMatch(codex, /allow-bots: true/);
  assert.doesNotMatch(job(workflow, 'claude-intake'), /Reject untrusted bot actors/);
  assert.doesNotMatch(codex, /vars\.ISSUE_INTAKE_CLAUDE_/);

  const apply = job(workflow, 'apply-intake');
  assert.match(apply, /needs: \[validate-provider, codex-intake\]/);
  assert.match(apply, /permissions:\n      contents: read\n      issues: write/);
  assert.doesNotMatch(apply, /ANTHROPIC_API_KEY|OPENAI_API_KEY/);
  assert.match(apply, /require\('\.\/\.github\/scripts\/apply-issue-intake\.cjs'\)/);
  assert.match(apply, /github\.event\.issue\.number/);

  const aggregate = job(workflow, 'issue-intake');
  assert.match(aggregate, /if: \$\{\{ always\(\) \}\}/);
  assert.match(aggregate, /\[ "\$VALIDATE_RESULT" = 'success' \] \|\| exit 1/);
  assert.match(aggregate, /\[ "\$CLAUDE_RESULT" = 'success' \] \|\| exit 1/);
  assert.match(aggregate, /\[ "\$CODEX_RESULT" = 'success' \] \|\| exit 1/);
  assert.match(aggregate, /\[ "\$APPLY_RESULT" = 'success' \] \|\| exit 1/);
  assert.match(aggregate, /permissions: \{\}/);

  assert.equal((workflow.match(/ANTHROPIC_API_KEY/g) || []).length, 1, 'only the Claude job may reference ANTHROPIC_API_KEY');
  assert.equal((workflow.match(/OPENAI_API_KEY/g) || []).length, 1, 'only the Codex job may reference OPENAI_API_KEY');
  assert.ok(fs.existsSync(schemaPath), 'Codex intake schema must exist');
  assertCodexEnvironment(fs.readFileSync(promptPath, 'utf8'));
});

test('each issue-intake provider interpolates only its own model and effort variables', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const claude = job(workflow, 'claude-intake');
  const codex = job(workflow, 'codex-intake');

  assert.match(claude, /--model \$\{.*vars\.ISSUE_INTAKE_CLAUDE_MODEL \|\| 'sonnet'/);
  assert.match(
    claude,
    /vars\.ISSUE_INTAKE_CLAUDE_EFFORT && format\('--effort \{0\}', vars\.ISSUE_INTAKE_CLAUDE_EFFORT\) \|\| ''/,
  );
  assert.doesNotMatch(claude, /^\s*--effort\s+\S/m, 'Claude --effort is omitted unless ISSUE_INTAKE_CLAUDE_EFFORT is set');

  assert.match(codex, /model: \$\{.*vars\.ISSUE_INTAKE_CODEX_MODEL \|\| 'gpt-5\.6-luna'/);
  assert.match(codex, /effort: \$\{.*vars\.ISSUE_INTAKE_CODEX_EFFORT \|\| 'max'/);
});
