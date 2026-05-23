import type { DailyUsage, HourlyUsage, MonthlyUsage, SessionUsage } from './types';

export interface ProfileScopedUsageData {
  daily: DailyUsage[];
  hourly: HourlyUsage[];
  monthly: MonthlyUsage[];
  session: SessionUsage[];
}

const PROFILE_NAME_REGEX = /^[A-Za-z0-9._-]+$/;

export function normalizeProfileQuery(profile?: string): string | undefined {
  const value = profile?.trim();
  if (!value || value === 'all') return undefined;
  if (!PROFILE_NAME_REGEX.test(value)) {
    throw new Error('Invalid profile filter');
  }
  return value;
}

export function annotateUsageProfile(
  data: ProfileScopedUsageData,
  profile: string
): ProfileScopedUsageData {
  return {
    daily: data.daily.map((item) => ({ ...item, profile })),
    hourly: data.hourly.map((item) => ({ ...item, profile })),
    monthly: data.monthly.map((item) => ({ ...item, profile })),
    session: data.session.map((item) => ({ ...item, profile })),
  };
}

export function filterByProfile<T extends { profile?: string }>(data: T[], profile?: string): T[] {
  if (!profile) return data;
  return data.filter((item) => item.profile === profile);
}
