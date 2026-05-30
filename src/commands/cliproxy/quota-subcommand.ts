/**
 * CLIProxy Quota Management
 *
 * Handles:
 * - ccs cliproxy quota [--provider <name>]
 * - ccs cliproxy default <account>
 * - ccs cliproxy pause <account>
 * - ccs cliproxy resume <account>
 * - ccs cliproxy doctor
 */

import {
  getProviderAccounts,
  setDefaultAccount,
  pauseAccount,
  resumeAccount,
  findAccountByQuery,
} from '../../cliproxy/accounts/account-manager';
import { fetchAllProviderQuotas } from '../../cliproxy/quota/quota-fetcher';
import { fetchAllCodexQuotas } from '../../cliproxy/quota/quota-fetcher-codex';
import {
  sanitizeCodexFeatureLabel,
  sanitizeCodexFeatureLabelOrNull,
} from '../../cliproxy/quota/quota-label-sanitizer';
import { fetchAllClaudeQuotas } from '../../cliproxy/quota/quota-fetcher-claude';
import { pickMostRestrictiveClaudeWeeklyWindow } from '../../cliproxy/quota/quota-fetcher-claude-normalizer';
import { fetchAllGeminiCliQuotas } from '../../cliproxy/quota/quota-fetcher-gemini-cli';
import { fetchAllGhcpQuotas } from '../../cliproxy/quota/quota-fetcher-ghcp';
import type {
  CodexQuotaResult,
  ClaudeQuotaResult,
  GeminiCliQuotaResult,
  GhcpQuotaResult,
  QuotaErrorMetadata,
} from '../../cliproxy/quota/quota-types';
import { isOnCooldown } from '../../cliproxy/quota/quota-manager';
import { CLIProxyProvider } from '../../cliproxy/types';
import {
  QUOTA_SUPPORTED_PROVIDER_IDS,
  type QuotaSupportedProvider,
} from '../../cliproxy/provider-capabilities';
import { formatAccountDisplayName } from '../../cliproxy/accounts/email-account-identity';
import { initUI, header, subheader, color, dim, ok, fail, warn, info, table } from '../../utils/ui';

interface CliproxyProfileArgs {
  name?: string;
  provider?: string;
  model?: string;
  account?: string;
  force?: boolean;
  yes?: boolean;
}

function parseProfileArgs(args: string[]): CliproxyProfileArgs {
  const result: CliproxyProfileArgs = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--provider' && args[i + 1]) {
      result.provider = args[++i];
    } else if (arg === '--model' && args[i + 1]) {
      result.model = args[++i];
    } else if (arg === '--account' && args[i + 1]) {
      result.account = args[++i];
    } else if (arg === '--force') {
      result.force = true;
    } else if (arg === '--yes' || arg === '-y') {
      result.yes = true;
    } else if (!arg.startsWith('-') && !result.name) {
      result.name = arg;
    }
  }
  return result;
}

function formatQuotaBar(percentage: number): string {
  const width = 20;
  const clampedPct = Math.max(0, Math.min(100, percentage));
  const filled = Math.round((clampedPct / 100) * width);
  const empty = width - filled;
  const filledChar = clampedPct > 50 ? '█' : clampedPct > 10 ? '▓' : '░';
  return `[${filledChar.repeat(filled)}${' '.repeat(empty)}]`;
}

function formatResetTime(seconds: number): string {
  if (seconds <= 0) return 'now';
  if (seconds < 60) return `in ${seconds}s`;
  if (seconds < 3600) return `in ${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `in ${Math.round(seconds / 3600)}h`;

  const days = Math.floor(seconds / 86400);
  const hours = Math.round((seconds % 86400) / 3600);
  if (hours <= 0) return `in ${days}d`;
  if (hours >= 24) return `in ${days + 1}d`;
  return `in ${days}d ${hours}h`;
}

function formatResetTimeISO(isoTime: string): string {
  if (!isoTime) return 'unknown';
  const resetDate = new Date(isoTime);
  if (isNaN(resetDate.getTime())) return 'unknown';
  const seconds = Math.max(0, Math.round((resetDate.getTime() - Date.now()) / 1000));
  return formatResetTime(seconds);
}

function formatCliAccountLabel(account: { id: string; email?: string; nickname?: string }): string {
  const displayName = formatAccountDisplayName(account);
  return account.nickname ? `${account.nickname} (${displayName})` : displayName;
}

function resolveDisplayedTier(
  accountTier: string | undefined,
  liveTier: string | undefined
): string {
  return (liveTier && liveTier !== 'unknown' ? liveTier : accountTier) || 'unknown';
}

interface QuotaFailureDisplayEntry {
  tone: 'error' | 'info' | 'dim';
  text: string;
}

function getQuotaFailureDisplayEntries(
  quota: QuotaErrorMetadata & {
    error?: string;
  }
): QuotaFailureDisplayEntry[] {
  const entries: QuotaFailureDisplayEntry[] = [
    {
      tone: 'error',
      text: quota.error || 'Failed to fetch quota',
    },
  ];

  if (quota.actionHint) {
    entries.push({
      tone: 'info',
      text: quota.actionHint,
    });
  }

  const diagnostics: string[] = [];
  if (typeof quota.httpStatus === 'number') {
    diagnostics.push(`HTTP ${quota.httpStatus}`);
  }
  if (quota.errorCode) {
    diagnostics.push(`Code: ${quota.errorCode}`);
  }
  if (quota.retryable) {
    diagnostics.push('Retryable');
  }
  if (diagnostics.length > 0) {
    entries.push({
      tone: 'dim',
      text: diagnostics.join(' | '),
    });
  }

  const normalizedError = quota.error?.trim();
  const normalizedDetail = quota.errorDetail?.trim();
  if (normalizedDetail && normalizedDetail !== normalizedError) {
    entries.push({
      tone: 'dim',
      text: `Detail: ${normalizedDetail}`,
    });
  }

  return entries;
}

function displayQuotaFailure(
  quota: QuotaErrorMetadata & {
    error?: string;
  }
): void {
  for (const entry of getQuotaFailureDisplayEntries(quota)) {
    const rendered =
      entry.tone === 'error'
        ? color(entry.text, 'error')
        : entry.tone === 'info'
          ? info(entry.text)
          : dim(entry.text);
    console.log(`    ${rendered}`);
  }
}

function formatAbsoluteResetTime(isoTime: string): string | null {
  if (!isoTime) return null;
  const resetDate = new Date(isoTime);
  if (isNaN(resetDate.getTime())) return null;
  const date = resetDate.toLocaleDateString(undefined, {
    month: '2-digit',
    day: '2-digit',
  });
  const time = resetDate.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${date} ${time}`;
}

function formatCodexWindowReset(
  window: Pick<CodexQuotaResult['windows'][number], 'resetAfterSeconds' | 'resetAt'>
): string | null {
  if (typeof window.resetAfterSeconds === 'number' && isFinite(window.resetAfterSeconds)) {
    const relative = formatResetTime(Math.max(0, window.resetAfterSeconds));
    if (window.resetAfterSeconds >= 86400 && window.resetAt) {
      const absolute = formatAbsoluteResetTime(window.resetAt);
      return absolute ? `${relative} (${absolute})` : relative;
    }
    return relative;
  }

  if (window.resetAt) {
    return formatResetTimeISO(window.resetAt);
  }

  return null;
}

type CodexWindowKind =
  | 'usage-5h'
  | 'usage-weekly'
  | 'code-review-5h'
  | 'code-review-weekly'
  | 'code-review'
  | 'unknown';

function getCodexWindowKind(label: string): CodexWindowKind {
  const lower = (label || '').toLowerCase();
  const isCodeReview = lower.includes('code review') || lower.includes('code_review');
  const isPrimary = lower.includes('primary');
  const isSecondary = lower.includes('secondary');

  if (isCodeReview) {
    if (isPrimary) return 'code-review-5h';
    if (isSecondary) return 'code-review-weekly';
    return 'code-review';
  }

  if (isPrimary) return 'usage-5h';
  if (isSecondary) return 'usage-weekly';
  return 'unknown';
}

type CodexWindowSummary = Pick<
  CodexQuotaResult['windows'][number],
  'label' | 'resetAfterSeconds' | 'category' | 'cadence' | 'featureLabel'
>;

function inferCodeReviewCadence(
  window: CodexWindowSummary,
  allWindows: CodexWindowSummary[]
): '5h' | 'weekly' | null {
  const kind = getCodexWindowKind(window.label);
  if (kind === 'code-review-weekly') return 'weekly';

  const reset = window.resetAfterSeconds;
  if (typeof reset !== 'number' || !isFinite(reset) || reset <= 0) return null;

  const usage5h = allWindows.find(
    (w) =>
      getCodexWindowKind(w.label) === 'usage-5h' &&
      typeof w.resetAfterSeconds === 'number' &&
      isFinite(w.resetAfterSeconds) &&
      w.resetAfterSeconds > 0
  );
  const usageWeekly = allWindows.find(
    (w) =>
      getCodexWindowKind(w.label) === 'usage-weekly' &&
      typeof w.resetAfterSeconds === 'number' &&
      isFinite(w.resetAfterSeconds) &&
      w.resetAfterSeconds > 0
  );

  if (!usage5h || !usageWeekly) return null;

  const diffTo5h = Math.abs(reset - (usage5h.resetAfterSeconds as number));
  const diffToWeekly = Math.abs(reset - (usageWeekly.resetAfterSeconds as number));
  return diffToWeekly <= diffTo5h ? 'weekly' : '5h';
}

/**
 * Strip a leading "GPT-X.Y-Codex-" prefix from a feature label and turn the
 * remainder into a Codex-prefixed display name. Other labels pass through unchanged.
 */
function prettifyCodexFeatureLabel(featureLabel: unknown, fallbackLabel?: unknown): string {
  const trimmed =
    sanitizeCodexFeatureLabelOrNull(featureLabel) ??
    (fallbackLabel === undefined
      ? sanitizeCodexFeatureLabel(featureLabel)
      : sanitizeCodexFeatureLabel(fallbackLabel));
  const stripped = trimmed.replace(/^GPT-[\d.]+-Codex-/i, '');
  if (stripped !== trimmed && stripped.length > 0) {
    return `Codex ${stripped}`;
  }
  return trimmed;
}

function getCodexWindowDisplayLabel(
  window: CodexWindowSummary,
  allWindows: CodexWindowSummary[] = []
): string {
  const context = allWindows.length > 0 ? allWindows : [window];

  // Prefer explicit category metadata when present (post-2026-04 windows).
  if (window.category === 'usage') {
    if (window.cadence === '5h') return '5h usage limit';
    if (window.cadence === 'weekly') return 'Weekly usage limit';
  }

  if (window.category === 'additional') {
    const pretty = prettifyCodexFeatureLabel(window.featureLabel, window.label);
    if (window.cadence === '5h') return `${pretty} (5h)`;
    if (window.cadence === 'weekly') return `${pretty} (weekly)`;
    return pretty;
  }

  if (window.category === 'code-review') {
    if (window.cadence === '5h') return 'Code review (5h)';
    if (window.cadence === 'weekly') return 'Code review (weekly)';
    return 'Code review';
  }

  // Legacy fallback: classify via label sniffing for cached windows without metadata.
  switch (getCodexWindowKind(window.label)) {
    case 'usage-5h':
      return '5h usage limit';
    case 'usage-weekly':
      return 'Weekly usage limit';
    case 'code-review-5h':
    case 'code-review-weekly':
    case 'code-review': {
      const inferred = inferCodeReviewCadence(window, context);
      if (inferred === '5h') return 'Code review (5h)';
      if (inferred === 'weekly') return 'Code review (weekly)';
      return 'Code review';
    }
    case 'unknown':
      return window.label;
  }
}

function getCodexCoreUsageWindows(windows: CodexQuotaResult['windows']): {
  fiveHourWindow: CodexQuotaResult['windows'][number] | null;
  weeklyWindow: CodexQuotaResult['windows'][number] | null;
} {
  let fiveHourWindow: CodexQuotaResult['windows'][number] | null = null;
  let weeklyWindow: CodexQuotaResult['windows'][number] | null = null;
  const nonCodeReviewWindows: CodexQuotaResult['windows'] = [];

  // Prefer explicit category metadata when present so 'additional' windows
  // (e.g. GPT-5.3 Codex Spark) do not displace core usage windows in the summary.
  const hasCategoryMetadata = windows.some((window) => Boolean(window.category));

  if (hasCategoryMetadata) {
    for (const window of windows) {
      if (window.category === 'usage') {
        if (window.cadence === '5h' && !fiveHourWindow) fiveHourWindow = window;
        else if (window.cadence === 'weekly' && !weeklyWindow) weeklyWindow = window;
        nonCodeReviewWindows.push(window);
      }
      // 'code-review' and 'additional' are excluded from the core usage summary.
    }
  } else {
    for (const window of windows) {
      const kind = getCodexWindowKind(window.label);
      if (kind === 'usage-5h') {
        if (!fiveHourWindow) fiveHourWindow = window;
        nonCodeReviewWindows.push(window);
        continue;
      }
      if (kind === 'usage-weekly') {
        if (!weeklyWindow) weeklyWindow = window;
        nonCodeReviewWindows.push(window);
        continue;
      }
      if (kind === 'unknown') {
        nonCodeReviewWindows.push(window);
      }
    }
  }

  if ((!fiveHourWindow || !weeklyWindow) && nonCodeReviewWindows.length > 0) {
    const withReset = nonCodeReviewWindows
      .filter((w) => typeof w.resetAfterSeconds === 'number' && w.resetAfterSeconds >= 0)
      .sort((a, b) => (a.resetAfterSeconds || 0) - (b.resetAfterSeconds || 0));

    if (!fiveHourWindow) {
      fiveHourWindow = withReset[0] || nonCodeReviewWindows[0] || null;
    }

    if (!weeklyWindow) {
      weeklyWindow =
        withReset.length > 1
          ? withReset[withReset.length - 1]
          : nonCodeReviewWindows.find((w) => w !== fiveHourWindow) || null;
    }
  }

  return { fiveHourWindow, weeklyWindow };
}

function displayAntigravityQuotaSection(
  quotaResult: Awaited<ReturnType<typeof fetchAllProviderQuotas>>
): void {
  const provider: CLIProxyProvider = 'agy';
  const accounts = getProviderAccounts(provider);

  console.log(
    subheader(`Antigravity (${accounts.length} account${accounts.length !== 1 ? 's' : ''})`)
  );
  console.log('');

  const rows: string[][] = [];
  for (const account of accounts) {
    const quotaData = quotaResult.accounts.find((q) => q.account.id === account.id);
    const quota = quotaData?.quota;

    let avgQuota = 'N/A';
    if (quota?.success && quota.models.length > 0) {
      const avg = Math.round(
        quota.models.reduce((sum, m) => sum + m.percentage, 0) / quota.models.length
      );
      avgQuota = `${avg}%`;
    }

    const statusParts: string[] = [];
    if (account.paused) statusParts.push(color('PAUSED', 'warning'));
    if (isOnCooldown(provider, account.id)) statusParts.push(color('COOLDOWN', 'warning'));

    const defaultMark = account.isDefault ? color('*', 'success') : ' ';
    const tier = resolveDisplayedTier(account.tier, quota?.entitlement?.normalizedTier);
    const status = statusParts.join(', ');

    rows.push([defaultMark, formatCliAccountLabel(account), tier, avgQuota, status]);
  }

  console.log(
    table(rows, {
      head: ['', 'Account', 'Tier', 'Quota', 'Status'],
      colWidths: [3, 30, 10, 10, 20],
    })
  );
  console.log('');
}

function displayCodexQuotaSection(results: { account: string; quota: CodexQuotaResult }[]): void {
  console.log(subheader(`Codex (${results.length} account${results.length !== 1 ? 's' : ''})`));
  console.log('');

  for (const { account, quota } of results) {
    const accountInfo = findAccountByQuery('codex', account);
    const accountLabel = accountInfo ? formatCliAccountLabel(accountInfo) : account;
    const defaultMark = accountInfo?.isDefault ? color(' (default)', 'info') : '';

    if (!quota.success) {
      console.log(`  ${fail(accountLabel)}${defaultMark}`);
      displayQuotaFailure(quota);
      console.log('');
      continue;
    }

    const { fiveHourWindow, weeklyWindow } = getCodexCoreUsageWindows(quota.windows);
    const coreUsageWindows = [fiveHourWindow, weeklyWindow].filter(
      (w, index, arr): w is NonNullable<typeof w> => !!w && arr.indexOf(w) === index
    );
    const statusWindows = coreUsageWindows.length > 0 ? coreUsageWindows : quota.windows;

    const avgQuota =
      statusWindows.length > 0
        ? statusWindows.reduce((sum, w) => sum + w.remainingPercent, 0) / statusWindows.length
        : 0;
    const statusIcon = avgQuota > 50 ? ok('') : avgQuota > 10 ? warn('') : fail('');
    const planBadge = quota.planType ? color(` [${quota.planType}]`, 'info') : '';

    console.log(`  ${statusIcon}${accountLabel}${defaultMark}${planBadge}`);

    const coreUsageSummary = quota.coreUsage ?? {
      fiveHour: fiveHourWindow
        ? {
            label: fiveHourWindow.label,
            remainingPercent: fiveHourWindow.remainingPercent,
            resetAfterSeconds: fiveHourWindow.resetAfterSeconds,
            resetAt: fiveHourWindow.resetAt,
          }
        : null,
      weekly: weeklyWindow
        ? {
            label: weeklyWindow.label,
            remainingPercent: weeklyWindow.remainingPercent,
            resetAfterSeconds: weeklyWindow.resetAfterSeconds,
            resetAt: weeklyWindow.resetAt,
          }
        : null,
    };
    const resetParts: string[] = [];
    const fiveHourReset = coreUsageSummary.fiveHour
      ? formatCodexWindowReset(coreUsageSummary.fiveHour)
      : null;
    const weeklyReset = coreUsageSummary.weekly
      ? formatCodexWindowReset(coreUsageSummary.weekly)
      : null;
    if (fiveHourReset) resetParts.push(`5h ${fiveHourReset}`);
    if (weeklyReset) resetParts.push(`weekly ${weeklyReset}`);
    if (resetParts.length > 0) {
      console.log(`    ${dim(`Reset schedule: ${resetParts.join(' | ')}`)}`);
    }

    const orderedWindows = [fiveHourWindow, weeklyWindow, ...quota.windows].filter(
      (w, index, arr): w is NonNullable<typeof w> => !!w && arr.indexOf(w) === index
    );

    for (const window of orderedWindows) {
      const bar = formatQuotaBar(window.remainingPercent);
      const resetValue = formatCodexWindowReset(window);
      const resetLabel = resetValue ? dim(` Resets ${resetValue}`) : '';
      console.log(
        `    ${getCodexWindowDisplayLabel(window, orderedWindows).padEnd(24)} ${bar} ${window.remainingPercent.toFixed(0)}%${resetLabel}`
      );
    }
    console.log('');
  }
}

interface ClaudeDisplayWindow {
  rateLimitType: string;
  label: string;
  remainingPercent: number;
  resetAt: string | null;
  status: string;
}

function getClaudeWindowDisplayLabel(
  window: Pick<ClaudeDisplayWindow, 'rateLimitType' | 'label'>
): string {
  switch (window.rateLimitType) {
    case 'five_hour':
      return '5h usage limit';
    case 'seven_day':
      return 'Weekly usage limit';
    case 'seven_day_opus':
      return 'Weekly usage (Opus)';
    case 'seven_day_sonnet':
      return 'Weekly usage (Sonnet)';
    case 'seven_day_oauth_apps':
      return 'Weekly usage (OAuth apps)';
    case 'seven_day_cowork':
      return 'Weekly usage (Cowork)';
    case 'overage':
      return 'Extra usage';
    default:
      return window.label;
  }
}

function toClaudeDisplayWindow(window: ClaudeQuotaResult['windows'][number]): ClaudeDisplayWindow {
  return {
    rateLimitType: window.rateLimitType,
    label: window.label,
    remainingPercent: window.remainingPercent,
    resetAt: window.resetAt,
    status: window.status,
  };
}

function toClaudeCoreDisplayWindow(
  window: NonNullable<ClaudeQuotaResult['coreUsage']>['fiveHour']
): ClaudeDisplayWindow | null {
  if (!window) return null;
  return {
    rateLimitType: window.rateLimitType,
    label: window.label,
    remainingPercent: window.remainingPercent,
    resetAt: window.resetAt,
    status: window.status,
  };
}

function getClaudeCoreUsageWindows(quota: ClaudeQuotaResult): {
  fiveHourWindow: ClaudeDisplayWindow | null;
  weeklyWindow: ClaudeDisplayWindow | null;
} {
  const coreUsage = quota.coreUsage;
  const fiveHourFromCore = toClaudeCoreDisplayWindow(coreUsage?.fiveHour ?? null);
  const weeklyFromCore = toClaudeCoreDisplayWindow(coreUsage?.weekly ?? null);
  if (fiveHourFromCore || weeklyFromCore) {
    return {
      fiveHourWindow: fiveHourFromCore,
      weeklyWindow: weeklyFromCore,
    };
  }

  const fiveHourPolicy =
    quota.windows.find((window) => window.rateLimitType === 'five_hour') ?? null;
  const weeklyPolicy = pickMostRestrictiveClaudeWeeklyWindow(quota.windows);

  return {
    fiveHourWindow: fiveHourPolicy ? toClaudeDisplayWindow(fiveHourPolicy) : null,
    weeklyWindow: weeklyPolicy ? toClaudeDisplayWindow(weeklyPolicy) : null,
  };
}

function displayClaudeQuotaSection(results: { account: string; quota: ClaudeQuotaResult }[]): void {
  console.log(subheader(`Claude (${results.length} account${results.length !== 1 ? 's' : ''})`));
  console.log('');

  for (const { account, quota } of results) {
    const accountInfo = findAccountByQuery('claude', account);
    const accountLabel = accountInfo ? formatCliAccountLabel(accountInfo) : account;
    const defaultMark = accountInfo?.isDefault ? color(' (default)', 'info') : '';

    if (!quota.success) {
      console.log(`  ${fail(accountLabel)}${defaultMark}`);
      displayQuotaFailure(quota);
      console.log('');
      continue;
    }

    const { fiveHourWindow, weeklyWindow } = getClaudeCoreUsageWindows(quota);
    const coreWindows = [fiveHourWindow, weeklyWindow].filter(
      (window, index, arr): window is ClaudeDisplayWindow =>
        !!window && arr.indexOf(window) === index
    );
    const statusWindows =
      coreWindows.length > 0 ? coreWindows : quota.windows.map(toClaudeDisplayWindow);
    const minQuota =
      statusWindows.length > 0
        ? Math.min(...statusWindows.map((window) => window.remainingPercent))
        : null;
    const statusIcon =
      minQuota === null ? info('') : minQuota > 50 ? ok('') : minQuota > 10 ? warn('') : fail('');

    console.log(`  ${statusIcon}${accountLabel}${defaultMark}`);

    const resetParts: string[] = [];
    if (fiveHourWindow?.resetAt)
      resetParts.push(`5h ${formatResetTimeISO(fiveHourWindow.resetAt)}`);
    if (weeklyWindow?.resetAt)
      resetParts.push(`weekly ${formatResetTimeISO(weeklyWindow.resetAt)}`);
    if (resetParts.length > 0) {
      console.log(`    ${dim(`Reset schedule: ${resetParts.join(' | ')}`)}`);
    }

    const orderedWindows = [...coreWindows, ...quota.windows.map(toClaudeDisplayWindow)].filter(
      (window, index, arr) =>
        arr.findIndex(
          (candidate) =>
            candidate.rateLimitType === window.rateLimitType &&
            candidate.resetAt === window.resetAt &&
            candidate.status === window.status
        ) === index
    );

    if (orderedWindows.length === 0) {
      console.log(`    ${dim('Policy limits unavailable for this account')}`);
      console.log('');
      continue;
    }

    for (const window of orderedWindows) {
      const bar = formatQuotaBar(window.remainingPercent);
      const resetLabel = window.resetAt ? dim(` Resets ${formatResetTimeISO(window.resetAt)}`) : '';
      const statusLabel =
        window.status === 'rejected'
          ? dim(' [blocked]')
          : window.status === 'allowed_warning'
            ? dim(' [warning]')
            : '';
      console.log(
        `    ${getClaudeWindowDisplayLabel(window).padEnd(24)} ${bar} ${window.remainingPercent.toFixed(0)}%${statusLabel}${resetLabel}`
      );
    }
    console.log('');
  }
}

function displayGeminiCliQuotaSection(
  results: { account: string; quota: GeminiCliQuotaResult }[]
): void {
  console.log(
    subheader(`Gemini CLI (${results.length} account${results.length !== 1 ? 's' : ''})`)
  );
  console.log('');

  for (const { account, quota } of results) {
    const accountInfo = findAccountByQuery('gemini', account);
    const accountLabel = accountInfo ? formatCliAccountLabel(accountInfo) : account;
    const defaultMark = accountInfo?.isDefault ? color(' (default)', 'info') : '';

    if (!quota.success) {
      console.log(`  ${fail(accountLabel)}${defaultMark}`);
      displayQuotaFailure(quota);
      console.log('');
      continue;
    }

    const avgQuota =
      quota.buckets.length > 0
        ? quota.buckets.reduce((sum, b) => sum + b.remainingPercent, 0) / quota.buckets.length
        : 0;
    const statusIcon = avgQuota > 50 ? ok('') : avgQuota > 10 ? warn('') : fail('');

    console.log(`  ${statusIcon}${accountLabel}${defaultMark}`);
    if (quota.projectId) {
      console.log(`    Project: ${dim(quota.projectId)}`);
    }
    if (quota.tierLabel) {
      console.log(`    Tier: ${dim(quota.tierLabel)}`);
    }
    if (quota.entitlement?.rawTierId) {
      console.log(`    Tier ID: ${dim(quota.entitlement.rawTierId)}`);
    }
    if (quota.creditBalance !== null && quota.creditBalance !== undefined) {
      console.log(`    Credits: ${dim(quota.creditBalance.toLocaleString())}`);
    }

    for (const bucket of quota.buckets) {
      const bar = formatQuotaBar(bucket.remainingPercent);
      const tokenLabel = bucket.tokenType ? dim(` (${bucket.tokenType})`) : '';
      const amountLabel =
        bucket.remainingAmount !== null && bucket.remainingAmount !== undefined
          ? dim(` ${bucket.remainingAmount.toLocaleString()} left`)
          : '';
      const resetLabel = bucket.resetTime
        ? dim(` Resets ${formatResetTimeISO(bucket.resetTime)}`)
        : '';
      console.log(
        `    ${bucket.label.padEnd(24)} ${bar} ${bucket.remainingPercent.toFixed(0)}%${tokenLabel}${amountLabel}${resetLabel}`
      );
    }
    console.log('');
  }
}

function formatSnapshotLabel(
  snapshot: GhcpQuotaResult['snapshots'][keyof GhcpQuotaResult['snapshots']]
): string {
  if (snapshot.unlimited) {
    return `${snapshot.percentUsed.toFixed(0)}% used (unlimited)`;
  }
  return `${snapshot.used}/${snapshot.entitlement} used`;
}

function displayGhcpQuotaSection(results: { account: string; quota: GhcpQuotaResult }[]): void {
  console.log(
    subheader(`GitHub Copilot (${results.length} account${results.length !== 1 ? 's' : ''})`)
  );
  console.log('');

  for (const { account, quota } of results) {
    const accountInfo = findAccountByQuery('ghcp', account);
    const accountLabel = accountInfo ? formatCliAccountLabel(accountInfo) : account;
    const defaultMark = accountInfo?.isDefault ? color(' (default)', 'info') : '';

    if (!quota.success) {
      console.log(`  ${fail(accountLabel)}${defaultMark}`);
      displayQuotaFailure(quota);
      console.log('');
      continue;
    }

    const reportedSnapshots = [
      quota.snapshots.premiumInteractions,
      quota.snapshots.chat,
      quota.snapshots.completions,
    ].filter((snapshot) => snapshot.reported !== false);
    const rows = reportedSnapshots.map((snapshot) =>
      snapshot.unlimited ? 100 : snapshot.percentRemaining
    );
    const minQuota = rows.length > 0 ? Math.min(...rows) : null;
    const statusIcon =
      minQuota === null ? info('') : minQuota > 50 ? ok('') : minQuota > 10 ? warn('') : fail('');
    const planBadge = quota.planType ? color(` [${quota.planType}]`, 'info') : '';

    console.log(`  ${statusIcon}${accountLabel}${defaultMark}${planBadge}`);
    if (quota.quotaResetDate) {
      console.log(`    ${dim(`Resets ${formatResetTimeISO(quota.quotaResetDate)}`)}`);
    }

    const allItems: Array<
      [string, GhcpQuotaResult['snapshots'][keyof GhcpQuotaResult['snapshots']]]
    > = [
      ['Premium interactions', quota.snapshots.premiumInteractions],
      ['Chat', quota.snapshots.chat],
      ['Completions', quota.snapshots.completions],
    ];
    const items = allItems.filter(([, snapshot]) => snapshot.reported !== false);

    for (const [label, snapshot] of items) {
      const bar = formatQuotaBar(snapshot.percentRemaining);
      const usageLabel = dim(` ${formatSnapshotLabel(snapshot)}`);
      console.log(
        `    ${label.padEnd(24)} ${bar} ${snapshot.percentRemaining.toFixed(0)}%${usageLabel}`
      );
    }

    console.log('');
  }
}

interface QuotaProviderRuntime {
  fetch: (verbose: boolean) => Promise<unknown>;
  hasData: (result: unknown) => boolean;
  render: (result: unknown) => void;
  emptyTitle: string;
  emptyMessage: string;
  authCommand: string;
}

const QUOTA_PROVIDER_RUNTIME: Record<QuotaSupportedProvider, QuotaProviderRuntime> = {
  agy: {
    fetch: (verbose) => fetchAllProviderQuotas('agy', verbose),
    hasData: (result) =>
      (result as Awaited<ReturnType<typeof fetchAllProviderQuotas>>).accounts.length > 0,
    render: (result) =>
      displayAntigravityQuotaSection(result as Awaited<ReturnType<typeof fetchAllProviderQuotas>>),
    emptyTitle: 'Antigravity (0 accounts)',
    emptyMessage: 'No Antigravity accounts configured',
    authCommand: 'ccs agy --auth',
  },
  codex: {
    fetch: (verbose) => fetchAllCodexQuotas(verbose),
    hasData: (result) => (result as { account: string; quota: CodexQuotaResult }[]).length > 0,
    render: (result) =>
      displayCodexQuotaSection(result as { account: string; quota: CodexQuotaResult }[]),
    emptyTitle: 'Codex (0 accounts)',
    emptyMessage: 'No Codex accounts configured',
    authCommand: 'ccs codex --auth',
  },
  claude: {
    fetch: (verbose) => fetchAllClaudeQuotas(verbose),
    hasData: (result) => (result as { account: string; quota: ClaudeQuotaResult }[]).length > 0,
    render: (result) =>
      displayClaudeQuotaSection(result as { account: string; quota: ClaudeQuotaResult }[]),
    emptyTitle: 'Claude (0 accounts)',
    emptyMessage: 'No Claude accounts configured',
    authCommand: 'ccs claude --auth',
  },
  gemini: {
    fetch: (verbose) => fetchAllGeminiCliQuotas(verbose),
    hasData: (result) => (result as { account: string; quota: GeminiCliQuotaResult }[]).length > 0,
    render: (result) =>
      displayGeminiCliQuotaSection(result as { account: string; quota: GeminiCliQuotaResult }[]),
    emptyTitle: 'Gemini CLI (0 accounts)',
    emptyMessage: 'No Gemini CLI accounts configured',
    authCommand: 'ccs gemini --auth',
  },
  ghcp: {
    fetch: (verbose) => fetchAllGhcpQuotas(verbose),
    hasData: (result) => (result as { account: string; quota: GhcpQuotaResult }[]).length > 0,
    render: (result) =>
      displayGhcpQuotaSection(result as { account: string; quota: GhcpQuotaResult }[]),
    emptyTitle: 'GitHub Copilot (0 accounts)',
    emptyMessage: 'No GitHub Copilot accounts configured',
    authCommand: 'ccs ghcp --auth',
  },
};

export const __testExports = {
  getCodexWindowDisplayLabel,
  getQuotaFailureDisplayEntries,
  prettifyCodexFeatureLabel,
  resolveDisplayedTier,
};

export async function handleQuotaStatus(
  verbose = false,
  providerFilter: QuotaSupportedProvider | 'all' = 'all'
): Promise<void> {
  await initUI();
  console.log(header('Quota Status'));
  console.log('');

  const requestedProviders = new Set<QuotaSupportedProvider>(
    providerFilter === 'all' ? QUOTA_SUPPORTED_PROVIDER_IDS : [providerFilter]
  );
  const shouldFetch = (provider: QuotaSupportedProvider): boolean =>
    requestedProviders.has(provider);

  console.log(dim('Fetching quotas...'));

  const providerResults = new Map<QuotaSupportedProvider, unknown | null>(
    await Promise.all(
      QUOTA_SUPPORTED_PROVIDER_IDS.map(async (provider) => {
        if (!shouldFetch(provider)) {
          return [provider, null] as const;
        }
        return [provider, await QUOTA_PROVIDER_RUNTIME[provider].fetch(verbose)] as const;
      })
    )
  );

  console.log('');

  for (const provider of QUOTA_SUPPORTED_PROVIDER_IDS) {
    if (!shouldFetch(provider)) {
      continue;
    }

    const runtime = QUOTA_PROVIDER_RUNTIME[provider];
    const result = providerResults.get(provider) ?? null;
    if (result !== null && runtime.hasData(result)) {
      runtime.render(result);
      continue;
    }

    console.log(subheader(runtime.emptyTitle));
    console.log(info(runtime.emptyMessage));
    console.log(`  Run: ${color(runtime.authCommand, 'command')} to authenticate`);
    console.log('');
  }
}

export async function handleDoctor(verbose = false): Promise<void> {
  await initUI();
  console.log(header('CLIProxy Quota Diagnostics'));
  console.log('');

  const provider: CLIProxyProvider = 'agy';
  const accounts = getProviderAccounts(provider);

  if (accounts.length === 0) {
    console.log(info('No Antigravity accounts configured'));
    console.log(`    Run: ${color('ccs agy --auth', 'command')} to authenticate`);
    return;
  }

  console.log(subheader(`Antigravity Accounts (${accounts.length})`));
  console.log('');

  console.log(dim('Fetching quotas...'));
  const quotaResult = await fetchAllProviderQuotas(provider, verbose);

  for (const { account, quota } of quotaResult.accounts) {
    const accountLabel = formatCliAccountLabel(account);
    const defaultBadge = account.isDefault ? color(' (default)', 'info') : '';

    if (!quota.success) {
      console.log(`  ${fail(accountLabel)}${defaultBadge}`);
      displayQuotaFailure(quota);
      if (quota.isUnprovisioned) {
        console.log(
          `    ${warn('Account not provisioned - open Gemini Code Assist in IDE first')}`
        );
      }
      console.log('');
      continue;
    }

    const avgQuota =
      quota.models.length > 0
        ? quota.models.reduce((sum, m) => sum + m.percentage, 0) / quota.models.length
        : 0;
    const statusIcon = avgQuota > 50 ? ok('') : avgQuota > 10 ? warn('') : fail('');

    console.log(`  ${statusIcon}${accountLabel}${defaultBadge}`);
    if (quota.projectId) {
      console.log(`    Project: ${dim(quota.projectId)}`);
    }

    for (const model of quota.models) {
      const bar = formatQuotaBar(model.percentage);
      console.log(`    ${model.name.padEnd(20)} ${bar} ${model.percentage.toFixed(0)}%`);
    }
    console.log('');
  }

  const sharedProjects = Object.entries(quotaResult.projectGroups).filter(
    ([, accountIds]) => accountIds.length > 1
  );

  if (sharedProjects.length > 0) {
    console.log('');
    console.log(subheader('Shared Project Warning'));
    console.log('');
    for (const [projectId, accountIds] of sharedProjects) {
      console.log(
        fail(`Project ${projectId.substring(0, 20)}... shared by ${accountIds.length} accounts:`)
      );
      for (const accountId of accountIds) {
        console.log(`    - ${accountId}`);
      }
      console.log('');
      console.log(warn('These accounts share the same quota pool!'));
      console.log(warn('Failover between them will NOT help when quota is exhausted.'));
      console.log(info('Solution: Use accounts from different GCP projects.'));
    }
  }

  console.log('');
  console.log(subheader('Summary'));
  const healthyAccounts = quotaResult.accounts.filter(
    ({ quota }) => quota.success && quota.models.some((m) => m.percentage > 5)
  );
  console.log(`  Accounts with quota: ${healthyAccounts.length}/${accounts.length}`);
  if (sharedProjects.length > 0) {
    console.log(`  ${fail(`Shared projects: ${sharedProjects.length} (failover limited)`)}`);
  } else if (accounts.length > 1) {
    console.log(`  ${ok('No shared projects (failover fully operational)')}`);
  }
  console.log('');
}

export async function handleSetDefault(args: string[]): Promise<void> {
  await initUI();
  const parsed = parseProfileArgs(args);

  if (!parsed.name) {
    console.log(fail('Usage: ccs cliproxy default <account> [--provider <provider>]'));
    console.log('');
    console.log('Examples:');
    console.log('  ccs cliproxy default ultra@gmail.com');
    console.log('  ccs cliproxy default john --provider agy');
    process.exit(1);
  }

  const provider = (parsed.provider || 'agy') as CLIProxyProvider;
  const account = findAccountByQuery(provider, parsed.name);

  if (!account) {
    console.log(fail(`Account not found: ${parsed.name}`));
    console.log('');
    const accounts = getProviderAccounts(provider);
    if (accounts.length > 0) {
      console.log('Available accounts:');
      for (const acc of accounts) {
        const badge = acc.isDefault ? color(' (current default)', 'info') : '';
        console.log(`  - ${formatCliAccountLabel(acc)}${badge}`);
      }
    } else {
      console.log(`No accounts found for provider: ${provider}`);
      console.log(`Run: ccs ${provider} --auth`);
    }
    process.exit(1);
  }

  const success = setDefaultAccount(provider, account.id);

  if (success) {
    console.log(ok(`Default account set to: ${formatCliAccountLabel(account)}`));
    console.log(info(`Provider: ${provider}`));
  } else {
    console.log(fail('Failed to set default account'));
    process.exit(1);
  }
}

export async function handlePauseAccount(args: string[]): Promise<void> {
  await initUI();
  const parsed = parseProfileArgs(args);

  if (!parsed.name) {
    console.log(fail('Usage: ccs cliproxy pause <account> [--provider <provider>]'));
    console.log('');
    console.log('Pauses an account so it will be skipped in quota rotation.');
    process.exit(1);
  }

  const provider = (parsed.provider || 'agy') as CLIProxyProvider;
  const account = findAccountByQuery(provider, parsed.name);

  if (!account) {
    console.log(fail(`Account not found: ${parsed.name}`));
    process.exit(1);
  }

  if (account.paused) {
    console.log(warn(`Account already paused: ${formatCliAccountLabel(account)}`));
    console.log(info(`Paused at: ${account.pausedAt || 'unknown'}`));
    return;
  }

  const success = pauseAccount(provider, account.id);

  if (success) {
    console.log(ok(`Account paused: ${formatCliAccountLabel(account)}`));
    console.log(info('Account will be skipped in quota rotation'));
  } else {
    console.log(fail('Failed to pause account'));
    process.exit(1);
  }
}

export async function handleResumeAccount(args: string[]): Promise<void> {
  await initUI();
  const parsed = parseProfileArgs(args);

  if (!parsed.name) {
    console.log(fail('Usage: ccs cliproxy resume <account> [--provider <provider>]'));
    console.log('');
    console.log('Resumes a paused account for quota rotation.');
    process.exit(1);
  }

  const provider = (parsed.provider || 'agy') as CLIProxyProvider;
  const account = findAccountByQuery(provider, parsed.name);

  if (!account) {
    console.log(fail(`Account not found: ${parsed.name}`));
    process.exit(1);
  }

  if (!account.paused) {
    console.log(warn(`Account is not paused: ${formatCliAccountLabel(account)}`));
    return;
  }

  const success = resumeAccount(provider, account.id);

  if (success) {
    console.log(ok(`Account resumed: ${formatCliAccountLabel(account)}`));
    console.log(info('Account is now active in quota rotation'));
  } else {
    console.log(fail('Failed to resume account'));
    process.exit(1);
  }
}
