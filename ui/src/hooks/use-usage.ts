/**
 * React Query hooks for usage analytics
 * Phase 01: Analytics Page Implementation
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

// Types
export interface TokenCategoryCost {
  tokens: number;
  cost: number;
}

export interface TokenBreakdown {
  input: TokenCategoryCost;
  output: TokenCategoryCost;
  cacheCreation: TokenCategoryCost;
  cacheRead: TokenCategoryCost;
}

export interface UsageSummary {
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  totalCost: number;
  tokenBreakdown: TokenBreakdown;
  totalDays: number;
  averageTokensPerDay: number;
  averageCostPerDay: number;
}

export interface DailyUsage {
  date: string;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  cost: number;
  modelsUsed: number;
}

export interface HourlyUsage {
  hour: string;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  cost: number;
  modelsUsed: number;
  requests: number;
}

export interface ModelUsage {
  model: string;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cacheTokens: number;
  cost: number;
  percentage: number;
  costBreakdown: TokenBreakdown;
  ioRatio: number;
}

export type AnomalyType = 'high_input' | 'high_io_ratio' | 'cost_spike' | 'high_cache_read';

export interface Anomaly {
  date: string;
  type: AnomalyType;
  model?: string;
  value: number;
  threshold: number;
  message: string;
}

export interface AnomalySummary {
  totalAnomalies: number;
  highInputDays: number;
  highIoRatioDays: number;
  costSpikeDays: number;
  highCacheReadDays: number;
}

export interface UsageInsights {
  anomalies: Anomaly[];
  summary: AnomalySummary;
}

export interface Session {
  sessionId: string;
  projectPath: string;
  tokens?: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  lastActivity: string;
  modelsUsed: string[];
  /** Target CLI used (default: 'claude') */
  target?: string;
}

export interface PaginatedSessions {
  sessions: Session[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface MonthlyUsage {
  month: string;
  tokens: number;
  cost: number;
  requests: number;
}

export interface UsageQueryOptions {
  startDate?: Date;
  endDate?: Date;
  profile?: string;
  limit?: number;
  offset?: number;
}

export interface UsageStatus {
  lastFetch: number | null;
  cacheSize: number;
}

// API
const BASE_URL = '/api';

/**
 * Convert Date to YYYYMMDD format for API
 */
function formatDateForApi(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function buildUsageUrl(path: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

function appendDateParams(params: URLSearchParams, options?: UsageQueryOptions): void {
  if (options?.startDate) params.append('since', formatDateForApi(options.startDate));
  if (options?.endDate) params.append('until', formatDateForApi(options.endDate));
}

function appendProfileParam(params: URLSearchParams, options?: UsageQueryOptions): void {
  if (options?.profile) params.append('profile', options.profile);
}

export const usageApi = {
  summary: (options?: UsageQueryOptions) => {
    const params = new URLSearchParams();
    appendDateParams(params, options);
    appendProfileParam(params, options);
    return request<UsageSummary>(buildUsageUrl('/usage/summary', params));
  },
  trends: (options?: UsageQueryOptions) => {
    const params = new URLSearchParams();
    appendDateParams(params, options);
    appendProfileParam(params, options);
    return request<DailyUsage[]>(buildUsageUrl('/usage/daily', params));
  },
  hourly: (options?: UsageQueryOptions) => {
    const params = new URLSearchParams();
    appendDateParams(params, options);
    appendProfileParam(params, options);
    return request<HourlyUsage[]>(buildUsageUrl('/usage/hourly', params));
  },
  models: (options?: UsageQueryOptions) => {
    const params = new URLSearchParams();
    appendDateParams(params, options);
    appendProfileParam(params, options);
    return request<ModelUsage[]>(buildUsageUrl('/usage/models', params));
  },
  sessions: (options?: UsageQueryOptions) => {
    const params = new URLSearchParams();
    appendDateParams(params, options);
    if (options?.limit) params.append('limit', options.limit.toString());
    if (options?.offset) params.append('offset', options.offset.toString());
    appendProfileParam(params, options);
    return request<PaginatedSessions>(buildUsageUrl('/usage/sessions', params));
  },
  monthly: (options?: UsageQueryOptions) => {
    const params = new URLSearchParams();
    appendDateParams(params, options);
    appendProfileParam(params, options);
    return request<MonthlyUsage[]>(buildUsageUrl('/usage/monthly', params));
  },
  /** Clear server-side usage cache and force fresh data fetch */
  refresh: async (): Promise<void> => {
    const res = await fetch(`${BASE_URL}/usage/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      throw new Error('Failed to refresh usage cache');
    }
  },
  /** Get cache status including last fetch timestamp */
  status: () => request<UsageStatus>('/usage/status'),
  /** Get usage insights including anomaly detection */
  insights: (options?: UsageQueryOptions) => {
    const params = new URLSearchParams();
    appendDateParams(params, options);
    appendProfileParam(params, options);
    return request<UsageInsights>(buildUsageUrl('/usage/insights', params));
  },
};

// Helper function to match existing API client pattern
async function request<T>(url: string): Promise<T> {
  const BASE_URL = '/api';
  const res = await fetch(`${BASE_URL}${url}`, {
    headers: { 'Content-Type': 'application/json' },
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || res.statusText);
  }

  const result = await res.json();
  return result.data || result; // Extract data property if it exists
}

// Hooks
export function useUsageSummary(options?: UsageQueryOptions) {
  return useQuery({
    queryKey: ['usage', 'summary', options],
    queryFn: () => usageApi.summary(options),
    staleTime: 60 * 1000, // 1 minute
  });
}

export function useUsageTrends(options?: UsageQueryOptions) {
  return useQuery({
    queryKey: ['usage', 'trends', options],
    queryFn: () => usageApi.trends(options),
    staleTime: 60 * 1000, // 1 minute
  });
}

export function useHourlyUsage(options?: UsageQueryOptions) {
  return useQuery({
    queryKey: ['usage', 'hourly', options],
    queryFn: () => usageApi.hourly(options),
    staleTime: 60 * 1000, // 1 minute
  });
}

export function useModelUsage(options?: UsageQueryOptions) {
  return useQuery({
    queryKey: ['usage', 'models', options],
    queryFn: () => usageApi.models(options),
    staleTime: 60 * 1000, // 1 minute
  });
}

/**
 * Hook to refresh all usage data
 * Clears server-side cache and invalidates React Query cache
 */
export function useRefreshUsage() {
  const queryClient = useQueryClient();

  const refresh = useCallback(async () => {
    // Clear server-side cache
    await usageApi.refresh();
    // Invalidate all usage queries in React Query
    await queryClient.invalidateQueries({ queryKey: ['usage'] });
  }, [queryClient]);

  return refresh;
}

/**
 * Hook to get usage cache status
 * Returns last fetch timestamp for "Last updated" UI indicator
 */
export function useUsageStatus() {
  return useQuery({
    queryKey: ['usage', 'status'],
    queryFn: () => usageApi.status(),
    staleTime: 10 * 1000, // 10 seconds - poll frequently for updates
    refetchInterval: 30 * 1000, // Auto-refetch every 30 seconds
  });
}

/**
 * Hook to get usage insights with anomaly detection
 * Returns detected anomalies and summary statistics
 */
export function useUsageInsights(options?: UsageQueryOptions) {
  return useQuery({
    queryKey: ['usage', 'insights', options],
    queryFn: () => usageApi.insights(options),
    staleTime: 60 * 1000, // 1 minute
  });
}

export function useSessions(options?: UsageQueryOptions) {
  return useQuery({
    queryKey: ['usage', 'sessions', options],
    queryFn: () => usageApi.sessions(options),
    staleTime: 60 * 1000, // 1 minute
  });
}
