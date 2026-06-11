/**
 * Tests for the CLI pool-state renderer helpers: state labels (the three
 * account states must be NAMED differently because they map to different client
 * failure modes), reset formatting, and drain-order mode labels.
 */
import { describe, expect, it } from 'bun:test';
import { describeAccountState, formatCooldownReset, modeLabel } from '../pool-state-renderer';
import type { PoolAccountState } from '../../../cliproxy/accounts/pool-state';

function state(
  partial: Partial<PoolAccountState> & { state: PoolAccountState['state'] }
): PoolAccountState {
  return {
    accountId: 'a@x.com',
    tokenFile: 'a.json',
    isDefault: false,
    ...partial,
  } as PoolAccountState;
}

describe('describeAccountState', () => {
  it('names available, cooling, and paused states distinctly', () => {
    const now = 1_000_000;
    const available = describeAccountState(state({ state: 'available' }), now);
    const paused = describeAccountState(state({ state: 'paused' }), now);
    const cooling = describeAccountState(
      state({ state: 'cooling', cooldownUntil: now + 5 * 60 * 1000, cooldownSource: 'persisted' }),
      now
    );

    expect(available.label).toBe('available');
    expect(available.tone).toBe('available');
    expect(paused.label).toContain('paused');
    expect(paused.tone).toBe('paused');
    expect(cooling.label).toContain('cooling until');
    expect(cooling.tone).toBe('cooling');

    // The three labels must be mutually distinct (no conflation).
    const labels = new Set([available.label, paused.label, cooling.label]);
    expect(labels.size).toBe(3);
  });

  it('annotates an in-process (memory) cooldown source', () => {
    const now = 1_000_000;
    const cooling = describeAccountState(
      state({ state: 'cooling', cooldownUntil: now + 60_000, cooldownSource: 'memory' }),
      now
    );
    expect(cooling.label).toContain('[in-process]');
  });

  it('shows unknown when a cooling account has no reset time', () => {
    const cooling = describeAccountState(state({ state: 'cooling' }), 1_000_000);
    expect(cooling.label).toContain('unknown');
  });
});

describe('formatCooldownReset', () => {
  it('returns now for a non-positive delta', () => {
    expect(formatCooldownReset(1_000_000, 1_000_000)).toContain('now');
  });

  it('uses minute granularity within the hour', () => {
    const now = 1_000_000;
    expect(formatCooldownReset(now + 5 * 60 * 1000, now)).toContain('5m');
  });

  it('uses hour granularity within the day', () => {
    const now = 1_000_000;
    expect(formatCooldownReset(now + 3 * 3600 * 1000, now)).toContain('3h');
  });
});

describe('modeLabel', () => {
  it('maps each drain order mode to a stable label', () => {
    expect(modeLabel('manual')).toBe('manual (--set)');
    expect(modeLabel('tier')).toBe('tier-derived (--by-tier)');
    expect(modeLabel('file')).toBe('file order');
  });
});
