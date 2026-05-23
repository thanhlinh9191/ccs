/**
 * Analytics Header Component
 *
 * Title, date filter, 24H button, and refresh controls.
 */

import type { DateRange } from 'react-day-picker';
import { subDays, startOfMonth } from 'date-fns';
import { Button } from '@/components/ui/button';
import { DateRangeFilter } from '@/components/analytics/date-range-filter';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AnalyticsProfileOption } from '../hooks';

interface AnalyticsHeaderProps {
  dateRange: DateRange | undefined;
  onDateRangeChange: (range: DateRange | undefined) => void;
  onTodayClick: () => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  lastUpdatedText: string | null;
  viewMode: 'daily' | 'hourly';
  selectedProfile: string;
  profileOptions: AnalyticsProfileOption[];
  onProfileChange: (profile: string) => void;
}

export function AnalyticsHeader({
  dateRange,
  onDateRangeChange,
  onTodayClick,
  onRefresh,
  isRefreshing,
  lastUpdatedText,
  viewMode,
  selectedProfile,
  profileOptions,
  onProfileChange,
}: AnalyticsHeaderProps) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-3 shrink-0 xl:flex-row xl:items-center xl:justify-between">
      <div>
        <h1 className="text-xl font-semibold">{t('analytics.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('analytics.subtitle')}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2 xl:justify-end">
        <Select value={selectedProfile} onValueChange={onProfileChange}>
          <SelectTrigger className="h-8 w-[190px]" aria-label="Analytics profile">
            <SelectValue placeholder="All profiles" />
          </SelectTrigger>
          <SelectContent>
            {profileOptions.map((option) => (
              <SelectItem key={option.value} value={option.value} disabled={!option.supported}>
                <span className="flex flex-col">
                  <span>{option.label}</span>
                  <span className="text-xs text-muted-foreground">{option.description}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant={viewMode === 'hourly' ? 'default' : 'outline'}
          size="sm"
          className="h-8"
          onClick={onTodayClick}
        >
          24H
        </Button>
        <DateRangeFilter
          className="flex-wrap"
          value={dateRange}
          onChange={onDateRangeChange}
          presets={[
            { label: '7D', range: { from: subDays(new Date(), 7), to: new Date() } },
            { label: '30D', range: { from: subDays(new Date(), 30), to: new Date() } },
            {
              label: t('analytics.month'),
              range: { from: startOfMonth(new Date()), to: new Date() },
            },
            { label: t('analytics.allTime'), range: { from: undefined, to: new Date() } },
          ]}
        />

        {lastUpdatedText && (
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            {t('analytics.updated', { value: lastUpdatedText })}
          </span>
        )}
        <Button
          variant="outline"
          size="sm"
          className="gap-2 h-8"
          onClick={onRefresh}
          disabled={isRefreshing}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
        </Button>
      </div>
      {selectedProfile !== 'all' && (
        <p className="text-xs text-muted-foreground xl:text-right">
          Selected-profile analytics include only default/account data with stable profile
          attribution. CLIProxy and native runtime snapshots remain in All profiles.
        </p>
      )}
    </div>
  );
}
