import { z } from 'zod';

/**
 * Canonical reasoning-effort pin (#45). Shared vocabulary the cockpit offers and each
 * runner maps onto its own flag/param. Absent/`auto`/unknown means "harness default"
 * and must never go on the wire.
 */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export const effortLevelSchema = z.enum(EFFORT_LEVELS);

/** Optional pin on create/continue/record. Empty string on continue clears the pin. */
export const effortFieldSchema = z.string().max(32).optional();

export function parseEffort(value: string | undefined | null): EffortLevel | undefined {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed || trimmed === 'auto') return undefined;
  const parsed = effortLevelSchema.safeParse(trimmed);
  return parsed.success ? parsed.data : undefined;
}
