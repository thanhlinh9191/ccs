import { describe, expect, it } from 'bun:test';

async function loadQuotaCommandTestExports() {
  const moduleId = Date.now() + Math.random();
  const mod = await import(
    `../../../src/commands/cliproxy/quota-subcommand?cliproxy-quota-subcommand=${moduleId}`
  );
  return mod.__testExports;
}

describe('cliproxy quota subcommand failure formatting', () => {
  it('builds Gemini failure lines with the remediation hint, code, and detail', async () => {
    const { getQuotaFailureDisplayEntries } = await loadQuotaCommandTestExports();

    const entries = getQuotaFailureDisplayEntries({
      error: 'Google requires you to verify this account before using Gemini CLI quota.',
      actionHint:
        'Complete the Google account verification mentioned above, then retry quota refresh.',
      httpStatus: 403,
      errorCode: 'PERMISSION_DENIED',
      errorDetail: 'ACCOUNT_VERIFICATION_REQUIRED',
      retryable: false,
    });

    expect(entries).toEqual([
      {
        tone: 'error',
        text: 'Google requires you to verify this account before using Gemini CLI quota.',
      },
      {
        tone: 'info',
        text: 'Complete the Google account verification mentioned above, then retry quota refresh.',
      },
      {
        tone: 'dim',
        text: 'HTTP 403 | Code: PERMISSION_DENIED',
      },
      {
        tone: 'dim',
        text: 'Detail: ACCOUNT_VERIFICATION_REQUIRED',
      },
    ]);
  });

  it('marks retryable failures in the CLI diagnostics line', async () => {
    const { getQuotaFailureDisplayEntries } = await loadQuotaCommandTestExports();

    const entries = getQuotaFailureDisplayEntries({
      error: 'Gemini quota service unavailable (HTTP 503)',
      actionHint: 'Retry later. This looks like a temporary Google upstream problem.',
      httpStatus: 503,
      errorCode: 'provider_unavailable',
      errorDetail: 'Service temporarily unavailable',
      retryable: true,
    });

    expect(entries[2]).toEqual({
      tone: 'dim',
      text: 'HTTP 503 | Code: provider_unavailable | Retryable',
    });
  });

  it('suppresses duplicate error detail lines', async () => {
    const { getQuotaFailureDisplayEntries } = await loadQuotaCommandTestExports();

    const entries = getQuotaFailureDisplayEntries({
      error: 'Internal Server Error',
      errorDetail: 'Internal Server Error',
    });

    expect(entries).toEqual([
      {
        tone: 'error',
        text: 'Internal Server Error',
      },
    ]);
  });

  it('prefers live quota tier over stale account tier', async () => {
    const { resolveDisplayedTier } = await loadQuotaCommandTestExports();

    expect(resolveDisplayedTier('unknown', 'pro')).toBe('pro');
    expect(resolveDisplayedTier('pro', 'ultra')).toBe('ultra');
    expect(resolveDisplayedTier('pro', 'unknown')).toBe('pro');
  });
});

describe('cliproxy quota subcommand Codex label formatting', () => {
  it('falls back to the cached window label for invalid Codex feature labels', async () => {
    const { getCodexWindowDisplayLabel } = await loadQuotaCommandTestExports();

    const cases = [
      { featureLabel: '', cadence: '5h', expected: 'Codex Spark (5h)' },
      { featureLabel: '   ', cadence: 'weekly', expected: 'Codex Spark (weekly)' },
      {
        featureLabel: '\u001b[2J\u001b]52;c;payload\u0007',
        cadence: '5h',
        expected: 'Codex Spark (5h)',
      },
      { featureLabel: { unexpected: true }, cadence: '5h', expected: 'Codex Spark (5h)' },
    ] as const;

    for (const { featureLabel, cadence, expected } of cases) {
      const label = getCodexWindowDisplayLabel({
        label: 'GPT-5.3-Codex-Spark',
        resetAfterSeconds: 3600,
        category: 'additional',
        cadence,
        featureLabel,
      } as never);

      expect(label).toBe(expected);
    }
  });

  it('removes terminal control characters from cached Codex feature labels', async () => {
    const { getCodexWindowDisplayLabel } = await loadQuotaCommandTestExports();

    const label = getCodexWindowDisplayLabel({
      label: 'ignored',
      resetAfterSeconds: 3600,
      category: 'additional',
      cadence: 'weekly',
      featureLabel: '\u001b[2JGPT-5.3-Codex-Spark\u001b]52;c;payload\u0007',
    });

    expect(label).toBe('Codex Spark (weekly)');
    expect(label).not.toContain('\u001b');
    expect(label).not.toContain('\u0007');
  });
});
