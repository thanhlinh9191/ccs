import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usageApi } from '@/hooks/use-usage';

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('analytics usage API contract', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ data: {} }))) as typeof fetch
    );
  });

  it('serializes only the supported analytics query params', async () => {
    const startDate = new Date(2026, 3, 1);
    const endDate = new Date(2026, 3, 30);

    await usageApi.summary({ startDate, endDate });
    await usageApi.trends({ startDate, endDate });
    await usageApi.models({ startDate, endDate });
    await usageApi.sessions({ startDate, endDate, limit: 50, offset: 10 });
    await usageApi.insights({ startDate, endDate });
    await usageApi.monthly({ startDate, endDate });

    const urls = vi.mocked(global.fetch).mock.calls.map(([url]) => String(url));

    expect(urls).toContain('/api/usage/summary?since=20260401&until=20260430');
    expect(urls).toContain('/api/usage/daily?since=20260401&until=20260430');
    expect(urls).toContain('/api/usage/models?since=20260401&until=20260430');
    expect(urls).toContain('/api/usage/sessions?since=20260401&until=20260430&limit=50&offset=10');
    expect(urls).toContain('/api/usage/insights?since=20260401&until=20260430');
    expect(urls).toContain('/api/usage/monthly?since=20260401&until=20260430');
    expect(urls.every((url) => !url.includes('months='))).toBe(true);
  });

  it('serializes the selected profile for every profile-scoped usage endpoint', async () => {
    const startDate = new Date(2026, 3, 1);
    const endDate = new Date(2026, 3, 30);
    const options = { startDate, endDate, profile: 'work' };

    await usageApi.summary(options);
    await usageApi.trends(options);
    await usageApi.hourly(options);
    await usageApi.models(options);
    await usageApi.sessions({ ...options, limit: 50 });
    await usageApi.insights(options);
    await usageApi.monthly(options);

    const urls = vi.mocked(global.fetch).mock.calls.map(([url]) => String(url));

    expect(urls).toContain('/api/usage/summary?since=20260401&until=20260430&profile=work');
    expect(urls).toContain('/api/usage/daily?since=20260401&until=20260430&profile=work');
    expect(urls).toContain('/api/usage/hourly?since=20260401&until=20260430&profile=work');
    expect(urls).toContain('/api/usage/models?since=20260401&until=20260430&profile=work');
    expect(urls).toContain(
      '/api/usage/sessions?since=20260401&until=20260430&limit=50&profile=work'
    );
    expect(urls).toContain('/api/usage/insights?since=20260401&until=20260430&profile=work');
    expect(urls).toContain('/api/usage/monthly?since=20260401&until=20260430&profile=work');
  });
});
