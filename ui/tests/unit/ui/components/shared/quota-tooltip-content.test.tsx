import { render, screen } from '@tests/setup/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { QuotaTooltipContent } from '@/components/shared/quota-tooltip-content';
import type { GeminiCliQuotaResult } from '@/lib/api-client';

function createGeminiQuotaResult(
  overrides: Partial<GeminiCliQuotaResult> = {}
): GeminiCliQuotaResult {
  return {
    success: true,
    buckets: [
      {
        id: 'gemini-flash-lite-series::combined',
        label: 'Gemini Flash Lite Series',
        tokenType: 'requests',
        remainingFraction: 1,
        remainingPercent: 100,
        remainingAmount: 100,
        resetTime: '2026-01-30T09:00:00Z',
        modelIds: ['gemini-2.5-flash-lite', 'gemini-3.1-flash-lite-preview'],
      },
      {
        id: 'gemini-flash-series::combined',
        label: 'Gemini Flash Series',
        tokenType: 'requests',
        remainingFraction: 0.82,
        remainingPercent: 82,
        remainingAmount: 82,
        resetTime: '2026-01-30T14:00:00Z',
        modelIds: ['gemini-3-flash-preview', 'gemini-3.1-flash-preview', 'gemini-2.5-flash'],
      },
    ],
    projectId: 'cloudaicompanion-test-123',
    tierLabel: 'Pro',
    tierId: 'g1-pro-tier',
    creditBalance: 12,
    entitlement: {
      normalizedTier: 'pro',
      rawTierId: 'g1-pro-tier',
      rawTierLabel: 'Pro',
      source: 'runtime_api',
      confidence: 'high',
      accessState: 'entitled',
      capacityState: 'available',
      lastVerifiedAt: Date.now(),
      notes: null,
    },
    lastUpdated: Date.now(),
    ...overrides,
  };
}

describe('QuotaTooltipContent', () => {
  it('renders Gemini tier, model coverage, and clearer bucket wording', () => {
    const quota = createGeminiQuotaResult();
    const expectedReset = new Date('2026-01-30T14:00:00Z').toLocaleString(undefined, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });

    render(<QuotaTooltipContent quota={quota} resetTime={quota.buckets[0].resetTime} />);

    expect(screen.getByText('Tier')).toBeInTheDocument();
    expect(screen.getByText('Pro')).toBeInTheDocument();
    expect(screen.getByText('Tier ID')).toBeInTheDocument();
    expect(screen.getByText('g1-pro-tier')).toBeInTheDocument();
    expect(screen.getByText('Credits')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('Model quotas:')).toBeInTheDocument();
    expect(screen.getByText('All buckets report Requests')).toBeInTheDocument();
    expect(screen.getByText('Flash Lite')).toBeInTheDocument();
    expect(
      screen.getByText('gemini-2.5-flash-lite, gemini-3.1-flash-lite-preview')
    ).toBeInTheDocument();
    expect(screen.getByText('100 requests remaining')).toBeInTheDocument();
    expect(
      screen.getByText('gemini-3-flash-preview, gemini-3.1-flash-preview, gemini-2.5-flash')
    ).toBeInTheDocument();
    expect(screen.getByText('82 requests remaining')).toBeInTheDocument();
    expect(screen.getByText(expectedReset)).toBeInTheDocument();
  });

  it('renders the Gemini tier label when entitlement evidence is absent', () => {
    const quota = createGeminiQuotaResult({
      entitlement: undefined,
      tierLabel: 'Legacy Pro',
      tierId: null,
      creditBalance: null,
    });

    render(<QuotaTooltipContent quota={quota} resetTime={null} />);

    expect(screen.getByText('Tier')).toBeInTheDocument();
    expect(screen.getByText('Legacy Pro')).toBeInTheDocument();
  });

  it('falls back to the shared reset indicator when Gemini buckets omit reset timestamps', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-29T00:00:00Z'));

    const quota = createGeminiQuotaResult({
      buckets: [
        {
          id: 'gemini-flash-series::combined',
          label: 'Gemini Flash Series',
          tokenType: null,
          remainingFraction: 0.75,
          remainingPercent: 75,
          remainingAmount: 75,
          resetTime: null,
          modelIds: ['gemini-3-flash-preview'],
        },
      ],
      creditBalance: null,
      tierLabel: null,
      tierId: null,
    });

    render(<QuotaTooltipContent quota={quota} resetTime="2026-01-29T03:00:00Z" />);

    expect(screen.getByText(/Resets/i)).toBeInTheDocument();

    vi.useRealTimers();
  });

  it('renders failure summaries, action hints, and raw details with readable structure', () => {
    const quota = createGeminiQuotaResult({
      success: false,
      buckets: [],
      error: 'Request had invalid authentication credentials.',
      httpStatus: 401,
      errorCode: 'UNAUTHENTICATED',
      errorDetail:
        '{"error":{"code":401,"message":"Request had invalid authentication credentials.","status":"UNAUTHENTICATED"}}',
      actionHint: 'Run ccs gemini --auth to reconnect this account.',
      needsReauth: true,
    });

    const { container } = render(<QuotaTooltipContent quota={quota} resetTime={null} />);

    expect(screen.getByText('Reauth')).toBeInTheDocument();
    expect(screen.getByText('Request had invalid authentication credentials.')).toBeInTheDocument();
    expect(
      screen.getByText('Run ccs gemini --auth to reconnect this account.')
    ).toBeInTheDocument();
    expect(screen.getByText('HTTP 401 | UNAUTHENTICATED')).toBeInTheDocument();
    expect(screen.getByText(/"status":"UNAUTHENTICATED"/)).toBeInTheDocument();
    expect(container.firstChild).not.toHaveClass('min-w-[16rem]');
  });
});
