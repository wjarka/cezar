import { describe, expect, it } from 'vitest'

import type { GithubItem } from '@open-mercato/cezar-api-client'

import { allLabels, filterGithubItems, labelChipStyle } from './github-filter'

const item = (over: Partial<GithubItem> & Pick<GithubItem, 'number' | 'title'>): GithubItem => ({
  kind: 'issue',
  author: 'octocat',
  createdAt: '2026-07-01T00:00:00Z',
  labels: [],
  body: '',
  url: `https://github.com/o/r/issues/${over.number}`,
  comments: 0,
  ...over,
})

const items = [
  item({ number: 142, title: 'Login drops session', labels: ['bug', 'auth'], author: 'alice' }),
  item({ number: 139, title: 'Add --json flag', labels: ['enhancement', 'cli'], body: 'machine-readable' }),
  item({ number: 135, title: 'Flaky e2e cleanup', labels: ['bug', 'flaky-test'] }),
]

describe('filterGithubItems', () => {
  it('matches a bare number or #id against the item number', () => {
    expect(filterGithubItems(items, { query: '142' }).map((i) => i.number)).toEqual([142])
    expect(filterGithubItems(items, { query: '#139' }).map((i) => i.number)).toEqual([139])
    // Partial numeric match is allowed (13 → 139 and 135).
    expect(filterGithubItems(items, { query: '13' }).map((i) => i.number)).toEqual([139, 135])
  })

  it('matches free text across title, author and body (case-insensitive)', () => {
    expect(filterGithubItems(items, { query: 'login' }).map((i) => i.number)).toEqual([142])
    expect(filterGithubItems(items, { query: 'ALICE' }).map((i) => i.number)).toEqual([142])
    expect(filterGithubItems(items, { query: 'machine-readable' }).map((i) => i.number)).toEqual([139])
  })

  it('ANDs multiple selected labels, like GitHub', () => {
    expect(filterGithubItems(items, { labels: ['bug'] }).map((i) => i.number)).toEqual([142, 135])
    expect(filterGithubItems(items, { labels: ['bug', 'auth'] }).map((i) => i.number)).toEqual([142])
    expect(filterGithubItems(items, { labels: ['bug', 'cli'] })).toEqual([])
  })

  it('combines search and labels', () => {
    expect(filterGithubItems(items, { query: 'flaky', labels: ['bug'] }).map((i) => i.number)).toEqual([135])
  })

  it('empty filter returns everything', () => {
    expect(filterGithubItems(items, {})).toHaveLength(3)
  })
})

describe('allLabels', () => {
  it('returns the sorted distinct label set', () => {
    expect(allLabels(items)).toEqual(['auth', 'bug', 'cli', 'enhancement', 'flaky-test'])
  })
})

describe('labelChipStyle', () => {
  it('tints from a 6-hex color', () => {
    const style = labelChipStyle('d73a4a')
    expect(style.backgroundColor).toBe('#d73a4a22')
    expect(style.borderColor).toBe('#d73a4a66')
  })

  it('falls back to neutral tokens when the color is missing or malformed', () => {
    expect(labelChipStyle(undefined).color).toBe('var(--muted-foreground)')
    expect(labelChipStyle('nothex').color).toBe('var(--muted-foreground)')
  })

  it('blends the ink toward the theme foreground so it reads in both light and dark', () => {
    // No fixed hex: the color mixes toward `--foreground`, which flips per theme.
    expect(labelChipStyle('000000').color).toBe('color-mix(in srgb, #000000 50%, var(--foreground))')
  })
})

describe('issue assignment and project filters', () => {
  const rows = [
    item({ number: 1, title: 'Fix login', labels: ['bug'], assignees: ['Alice'], projectIds: ['P1'] }),
    item({ number: 2, title: 'Fix logout', labels: ['bug'], assignees: ['bob'], projectIds: ['P2'] }),
    item({ number: 3, title: 'Docs', assignees: [], projectIds: [] }),
    item({ number: 4, title: 'Legacy' }),
  ]
  it('matches any selected login case-insensitively, excluding unassigned and legacy rows', () => {
    expect(filterGithubItems(rows, { assignees: ['alice', 'BOB'] }).map(i => i.number)).toEqual([1, 2])
  })
  it('ANDs project membership with assignees, labels and search', () => {
    expect(filterGithubItems(rows, { assignees: ['alice', 'bob'], projectId: 'P2', labels: ['bug'], query: 'fix' }).map(i => i.number)).toEqual([2])
    expect(filterGithubItems(rows, { projectId: 'missing' })).toEqual([])
    expect(filterGithubItems(rows, { projectId: 'P1', query: 'docs' })).toEqual([])
  })
  it('keeps legacy and unassigned rows with no filters', () => {
    expect(filterGithubItems(rows)).toEqual(rows)
  })
})
