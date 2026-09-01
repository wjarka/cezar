import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunnerModelCatalog } from '../core/runner-model-catalog.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

describe('workspace model catalog API', () => {
  let root: string;
  let store: RunStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-models-api-'));
    store = RunStore.open(join(root, '.ai/cezar'));
  });

  afterEach(() => {
    store.flush();
    rmSync(root, { recursive: true, force: true });
  });

  type Discover = () => Promise<Array<{ id: string; label: string; description: string }>>;

  const app = (discover: Discover, opencodeDiscover: Discover = discover, piDiscover?: Discover) =>
    createApp({
      repoRoot: root,
      store,
      manager: {} as RunManager,
      version: 'test',
      modelCatalog: new RunnerModelCatalog({
        adapters: {
          codex: { discover },
          opencode: { discover: opencodeDiscover },
          ...(piDiscover ? { pi: { discover: piDiscover } } : {}),
        },
      }),
    });

  it('returns the discovered catalog and reuses its cache', async () => {
    let calls = 0;
    const server = app(async () => {
      calls += 1;
      return [{ id: 'gpt-future', label: 'GPT Future', description: 'Newly available' }];
    });
    for (let i = 0; i < 2; i += 1) {
      const response = await apiRequest(server, '/api/v1/models?runner=codex');
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        runner: 'codex',
        models: [{ id: 'gpt-future' }],
        source: i === 0 ? 'live' : 'cache',
        stale: false,
      });
    }
    expect(calls).toBe(1);
  });

  it('degrades discovery failures to an unavailable 200 response', async () => {
    const response = await apiRequest(app(async () => { throw new Error('secret detail'); }), '/api/v1/models?runner=codex');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      runner: 'codex', models: [], source: 'unavailable', stale: false,
      reason: 'Codex model discovery is temporarily unavailable',
    });
  });

  it('answers the OpenCode catalog too — the runner that used to have no discovery path (#794)', async () => {
    const server = app(
      async () => [{ id: 'gpt-future', label: 'GPT Future', description: 'Newly available' }],
      async () => [{ id: 'openai/gpt-5.4', label: 'openai/gpt-5.4', description: 'via openai' }],
    );
    const response = await apiRequest(server, '/api/v1/models?runner=opencode');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      runner: 'opencode',
      models: [{ id: 'openai/gpt-5.4', description: 'via openai' }],
      source: 'live',
    });
  });

  it('degrades an OpenCode discovery failure the same way', async () => {
    const server = app(async () => [], async () => { throw new Error('secret detail'); });
    const response = await apiRequest(server, '/api/v1/models?runner=opencode');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      runner: 'opencode', models: [], source: 'unavailable', stale: false,
      reason: 'OpenCode model discovery is temporarily unavailable',
    });
  });

  it('answers the Pi catalog too — the runner that used to have hard-coded presets', async () => {
    const server = app(
      async () => [],
      async () => [],
      async () => [{ id: 'xai/grok-4.6', label: 'grok-4.6', description: 'via xai' }],
    );
    const response = await apiRequest(server, '/api/v1/models?runner=pi');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      runner: 'pi',
      models: [{ id: 'xai/grok-4.6', description: 'via xai' }],
      source: 'live',
    });
  });

  it('degrades a Pi discovery failure the same way', async () => {
    const server = app(async () => [], async () => [], async () => { throw new Error('secret detail'); });
    const response = await apiRequest(server, '/api/v1/models?runner=pi');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      runner: 'pi', models: [], source: 'unavailable', stale: false,
      reason: 'Pi model discovery is temporarily unavailable',
    });
  });

  it.each(['/api/v1/models', '/api/v1/models?runner=claude'])('rejects invalid query %s', async (path) => {
    const response = await apiRequest(app(async () => []), path);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'runner must be codex, opencode, or pi' });
  });

  it('is workspace-level rather than project-scoped', async () => {
    const response = await apiRequest(app(async () => []), '/api/v1/p/default/models?runner=codex');
    expect(response.status).toBe(404);
  });
});
