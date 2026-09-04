import { describe, expect, it } from 'vitest';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import {
  allowedToolsForStep,
  DEFAULT_ALLOWED_TOOLS,
  HARNESS_EXTRA_TOOLS,
} from './types.ts';

describe('allowedToolsForStep', () => {
  it('unions Pi extras onto the default list when the step does not set allowedTools', () => {
    expect(allowedToolsForStep(undefined, 'pi')).toEqual([
      ...DEFAULT_ALLOWED_TOOLS,
      'Subagent',
      'SubagentSupervisor',
      'SubagentWait',
    ]);
    expect(allowedToolsForStep({ allowedTools: undefined }, 'pi')).toEqual([
      ...DEFAULT_ALLOWED_TOOLS,
      'Subagent',
      'SubagentSupervisor',
      'SubagentWait',
    ]);
  });

  it('leaves Claude/Codex/OpenCode on the default list only', () => {
    for (const backend of ['claude', 'claude-cli', 'codex', 'opencode'] as const) {
      expect(allowedToolsForStep(undefined, backend)).toEqual(DEFAULT_ALLOWED_TOOLS);
    }
    expect(allowedToolsForStep(undefined, undefined)).toEqual(DEFAULT_ALLOWED_TOOLS);
  });

  it('returns an explicit allowedTools list unchanged, including empty', () => {
    const narrowed = ['Read', 'Bash'];
    expect(allowedToolsForStep({ allowedTools: narrowed }, 'pi')).toEqual(narrowed);
    expect(allowedToolsForStep({ allowedTools: [] }, 'pi')).toEqual([]);
    expect(allowedToolsForStep({ allowedTools: [...DEFAULT_ALLOWED_TOOLS, 'Subagent'] }, 'claude')).toEqual([
      ...DEFAULT_ALLOWED_TOOLS,
      'Subagent',
    ]);
  });

  it('does not mutate DEFAULT_ALLOWED_TOOLS', () => {
    const before = [...DEFAULT_ALLOWED_TOOLS];
    allowedToolsForStep(undefined, 'pi').push('nope');
    expect(DEFAULT_ALLOWED_TOOLS).toEqual(before);
  });

  it('has an extras row for every selectable runner', () => {
    expect(Object.keys(HARNESS_EXTRA_TOOLS).sort()).toEqual([...RUNNER_IDS].sort());
    expect(HARNESS_EXTRA_TOOLS.pi).toEqual(['Subagent', 'SubagentSupervisor', 'SubagentWait']);
    expect(HARNESS_EXTRA_TOOLS.claude).toEqual([]);
  });
});
