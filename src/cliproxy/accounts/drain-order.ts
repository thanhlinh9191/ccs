/**
 * Drain Order Management
 *
 * Manages CLIProxy account drain order via top-level "priority" field in auth JSONs.
 *
 * Architecture:
 * - Priority >= 1 always (management layer treats 0 as delete-the-attribute)
 * - Write path is dual: management API when proxy running, direct file when stopped
 * - Tier-aware defaults only where AccountTier metadata exists (agy/gemini)
 * - Claude pools: tier is unknown -> stable file order + manual --set required
 * - Selector drain order: priority bucket desc, then Auth.ID asc
 */

import * as fs from 'fs';
import * as path from 'path';
import { getAuthDir } from '../config/config-generator';
import {
  getProxyTarget,
  buildProxyUrl,
  buildManagementHeaders,
} from '../proxy/proxy-target-resolver';
import { loadDrainOrderConfig } from './registry';
import type { AccountTier } from './types';
import type { CLIProxyProvider } from '../types';

/** Minimum valid priority value. Management layer treats 0 as delete. */
export const MIN_PRIORITY = 1;

/** Management API path for patching auth file fields */
const AUTH_FILES_FIELDS_PATH = '/v0/management/auth-files/fields';

/** Timeout for management API calls in ms */
const MGMT_TIMEOUT_MS = 5000;

/**
 * Tier rank for priority derivation.
 * Higher rank = higher priority = drained first.
 * ultra > pro > free, unknown = no rank (returns undefined).
 */
const TIER_RANK: Record<Exclude<AccountTier, 'unknown'>, number> = {
  ultra: 3,
  pro: 2,
  free: 1,
};

/**
 * Compute 1-based priority from a 0-based rank among N accounts.
 * Rank 0 = highest priority = assigned priority N.
 * Rank N-1 = lowest priority = assigned priority 1.
 *
 * Never returns 0 (management layer treats 0 as delete).
 */
export function rankToPriority(rank: number, total: number): number {
  const raw = total - rank;
  return Math.max(MIN_PRIORITY, raw);
}

/** Tier rank for a known tier, undefined for unknown. */
export function tierRank(tier: AccountTier | undefined): number | undefined {
  if (!tier || tier === 'unknown') return undefined;
  return TIER_RANK[tier];
}

/**
 * Result of drain order computation for a single account.
 */
export interface DrainOrderEntry {
  /** Account ID */
  accountId: string;
  /** Token file name (without directory) */
  tokenFile: string;
  /** Computed priority (>= 1, higher = drained earlier) */
  priority: number;
  /** Tier if known */
  tier?: AccountTier;
  /** Whether tier was used to derive this priority */
  tierDerived: boolean;
  /** Current priority read from auth file (undefined = not yet set) */
  currentPriority: number | undefined;
}

/**
 * Input record for priority computation.
 */
export interface DrainOrderInput {
  accountId: string;
  tokenFile: string;
  tier?: AccountTier;
}

/**
 * Compute drain order priorities for a list of accounts using manual ordering.
 *
 * @param orderedIds Account IDs in desired drain order (first = highest priority)
 * @param allAccounts All accounts for the provider (some may not be in orderedIds)
 * @returns DrainOrderEntry array ordered by resulting priority desc
 */
export function computeManualDrainOrder(
  orderedIds: string[],
  allAccounts: DrainOrderInput[]
): DrainOrderEntry[] {
  const accountMap = new Map(allAccounts.map((a) => [a.accountId, a]));
  const result: DrainOrderEntry[] = [];

  // Reject duplicate IDs: a repeated account in --set is ambiguous and would
  // otherwise be assigned two different priorities.
  const seen = new Set<string>();
  for (const id of orderedIds) {
    if (seen.has(id)) {
      throw new Error(`Duplicate account ID in order: ${id}`);
    }
    seen.add(id);
  }

  // Validate that all specified IDs exist
  for (const id of orderedIds) {
    if (!accountMap.has(id)) {
      throw new Error(`Account ID not found: ${id}`);
    }
  }

  const specifiedSet = new Set(orderedIds);
  // Use total + 1 so rank (N-1) maps to priority 2, keeping every specified
  // account strictly above the MIN_PRIORITY floor assigned to unspecified ones.
  const total = orderedIds.length + 1;

  // Assign priorities to specified accounts (first = highest priority)
  for (let rank = 0; rank < orderedIds.length; rank++) {
    const id = orderedIds[rank];
    const account = accountMap.get(id);
    if (!account) continue;

    result.push({
      accountId: id,
      tokenFile: account.tokenFile,
      priority: rankToPriority(rank, total),
      tier: account.tier,
      tierDerived: false,
      currentPriority: undefined,
    });
  }

  // Remaining accounts not in the specified list get priority 1 (lowest)
  for (const account of allAccounts) {
    if (!specifiedSet.has(account.accountId)) {
      result.push({
        accountId: account.accountId,
        tokenFile: account.tokenFile,
        priority: MIN_PRIORITY,
        tier: account.tier,
        tierDerived: false,
        currentPriority: undefined,
      });
    }
  }

  return result;
}

/**
 * Compute drain order priorities for accounts using tier metadata.
 * Only valid where tier metadata exists (agy/gemini providers).
 *
 * Accounts with unknown tier are sorted last (priority MIN_PRIORITY).
 * Accounts within the same tier bucket are given equal priorities.
 *
 * @param accounts Accounts with optional tier metadata
 * @returns DrainOrderEntry array
 */
export function computeTierDrainOrder(accounts: DrainOrderInput[]): DrainOrderEntry[] {
  // Group by tier rank
  const withRank: Array<{ input: DrainOrderInput; rank: number }> = accounts.map((a) => ({
    input: a,
    rank: tierRank(a.tier) ?? 0,
  }));

  // Get unique ranks descending
  const uniqueRanks = [...new Set(withRank.map((x) => x.rank))].sort((a, b) => b - a);
  const numRanks = uniqueRanks.length;

  // Assign priority buckets: highest rank -> highest priority (numRanks), lowest -> MIN_PRIORITY
  const rankToPriorityMap = new Map<number, number>();
  uniqueRanks.forEach((rank, idx) => {
    // idx 0 = highest rank, gets highest priority
    const priority = Math.max(MIN_PRIORITY, numRanks - idx);
    rankToPriorityMap.set(rank, priority);
  });

  return withRank.map(({ input, rank }) => ({
    accountId: input.accountId,
    tokenFile: input.tokenFile,
    priority: rankToPriorityMap.get(rank) ?? MIN_PRIORITY,
    tier: input.tier,
    tierDerived: rank > 0, // only true when tier contributed a real rank
    currentPriority: undefined,
  }));
}

/**
 * Read the current priority from an auth JSON file.
 * Returns undefined if file missing, unreadable, or has no priority field.
 */
export function readAuthFilePriority(tokenFile: string): number | undefined {
  try {
    const authDir = getAuthDir();
    const filePath = path.join(authDir, tokenFile);
    const content = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(content) as { priority?: unknown };
    if (typeof data.priority === 'number' && Number.isFinite(data.priority) && data.priority >= 1) {
      return data.priority;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write priority directly to an auth JSON file (proxy must be stopped).
 * Validates priority >= MIN_PRIORITY before writing.
 * Preserves all other fields; uses atomic temp-rename.
 */
export function writeAuthFilePriorityDirect(tokenFile: string, priority: number): void {
  if (priority < MIN_PRIORITY) {
    throw new Error(`Priority must be >= ${MIN_PRIORITY}, got ${priority}`);
  }

  const authDir = getAuthDir();
  const filePath = path.join(authDir, tokenFile);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Auth file not found: ${tokenFile}`);
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(content) as Record<string, unknown>;

  data.priority = priority;

  const tempPath = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

/**
 * Write priority via CLIProxy management API (proxy must be running).
 * Uses PATCH /v0/management/auth-files/fields.
 *
 * @param tokenFile File name (basename, e.g. "antigravity-foo.json")
 * @param priority Priority value >= MIN_PRIORITY
 * @returns true on success, false on failure
 */
export async function writeAuthFilePriorityViaApi(
  tokenFile: string,
  priority: number
): Promise<boolean> {
  if (priority < MIN_PRIORITY) {
    throw new Error(`Priority must be >= ${MIN_PRIORITY}, got ${priority}`);
  }

  const target = getProxyTarget();
  const url = buildProxyUrl(target, AUTH_FILES_FIELDS_PATH);
  const headers = buildManagementHeaders(target, { 'Content-Type': 'application/json' });

  const body = JSON.stringify({ name: tokenFile, priority });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), MGMT_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'PATCH',
      headers,
      body,
      signal: controller.signal,
    });

    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Result of a drain order apply operation.
 */
export interface ApplyDrainOrderResult {
  /** Entries that were written successfully */
  written: DrainOrderEntry[];
  /** Entries that were skipped (priority unchanged) */
  skipped: DrainOrderEntry[];
  /** Entries that failed to write */
  failed: Array<{ entry: DrainOrderEntry; reason: string }>;
  /** Whether the proxy was running during the write (management API path) */
  usedManagementApi: boolean;
}

/**
 * Apply drain order priorities to auth files.
 *
 * Write path selection:
 * - Proxy running (HTTP health check passes): use management API
 * - Proxy stopped: direct file write
 *
 * Idempotent: skips entries where priority already equals the target value.
 *
 * @param entries Drain order entries with target priorities
 * @param proxyRunning Whether the proxy is currently running
 * @returns Result summary
 */
export async function applyDrainOrder(
  entries: DrainOrderEntry[],
  proxyRunning: boolean
): Promise<ApplyDrainOrderResult> {
  const result: ApplyDrainOrderResult = {
    written: [],
    skipped: [],
    failed: [],
    usedManagementApi: proxyRunning,
  };

  for (const entry of entries) {
    // Idempotency: read current value and skip if already set
    const currentPriority = readAuthFilePriority(entry.tokenFile);
    if (currentPriority === entry.priority) {
      result.skipped.push({ ...entry, currentPriority });
      continue;
    }

    if (proxyRunning) {
      const ok = await writeAuthFilePriorityViaApi(entry.tokenFile, entry.priority);
      if (ok) {
        result.written.push({ ...entry, currentPriority });
      } else {
        result.failed.push({
          entry: { ...entry, currentPriority },
          reason: 'management API PATCH failed',
        });
      }
    } else {
      try {
        writeAuthFilePriorityDirect(entry.tokenFile, entry.priority);
        result.written.push({ ...entry, currentPriority });
      } catch (err) {
        result.failed.push({
          entry: { ...entry, currentPriority },
          reason: (err as Error).message,
        });
      }
    }
  }

  return result;
}

/**
 * Read current drain order priorities for a set of accounts.
 * Annotates each DrainOrderEntry with its current priority from disk.
 *
 * @param entries Entries to annotate (modifies currentPriority in-place)
 */
export function annotateCurrentPriorities(entries: DrainOrderEntry[]): void {
  for (const entry of entries) {
    entry.currentPriority = readAuthFilePriority(entry.tokenFile);
  }
}

/**
 * Tie-break key for a token file, matching the upstream Go selector.
 * The selector breaks priority ties by Auth.ID asc. Upstream (synthesizer
 * file.go:120-122) lowercases Auth.ID only on Windows; on other platforms it
 * compares by raw byte order. We mirror that platform-conditional behaviour so
 * the displayed order matches what CLIProxy actually drains.
 *
 * @param platform process.platform; defaults to the current platform. Exposed
 *   for tests so non-Windows byte-order behaviour can be asserted deterministically.
 */
export function tieBreakKey(
  tokenFile: string,
  platform: NodeJS.Platform = process.platform
): string {
  return platform === 'win32' ? tokenFile.toLowerCase() : tokenFile;
}

/** How the effective drain order was derived. */
export type EffectiveDrainOrderMode = 'manual' | 'tier' | 'file';

/**
 * Effective drain order as the selector actually sees it: computed from the
 * stored config mode, then sorted by the on-disk priority each auth file
 * carries (the selector's real input), not by the intended config priority.
 */
export interface EffectiveDrainOrder {
  /** How the stored config intended to derive order. */
  mode: EffectiveDrainOrderMode;
  /**
   * Entries in selector pick order (first = drained first), annotated with the
   * on-disk priority via annotateCurrentPriorities().
   */
  entries: DrainOrderEntry[];
  /**
   * True when the computed config priority diverges from what is actually on
   * disk for any account. Drift happens because re-auth rewrites the auth JSON
   * and drops the priority attribute, and --reset leaves residual file
   * priorities; under drift the selector follows the file, not the config.
   */
  hasDrift: boolean;
}

/**
 * Resolve the effective drain order for a provider's active (non-paused)
 * accounts, mirroring what `ccs cliproxy accounts order` shows and what the
 * selector actually drains.
 *
 * Semantics (shared by the order subcommand and the quota pool section):
 * 1. Pick the config mode (manual when stored ids still resolve, else tier when
 *    stored, else file order).
 * 2. annotateCurrentPriorities() to read the on-disk priority for each account.
 * 3. Sort by currentPriority desc (undefined treated as 0, matching the
 *    selector), tie-break by tieBreakKey(tokenFile) asc.
 * 4. Flag drift when the computed config priority != on-disk priority anywhere.
 *
 * File mode never writes priorities, but it still honours any residual on-disk
 * priority the selector reads (e.g. left by `order --reset`): it sorts by that
 * priority desc then tieBreakKey asc, and flags drift when any residual is
 * non-zero. With no residuals all priorities are 0 and it falls back to plain
 * tieBreakKey order with no drift.
 *
 * @param activeAccounts Accounts in rotation (callers exclude paused accounts).
 */
export function resolveEffectiveDrainOrder(
  provider: CLIProxyProvider,
  activeAccounts: DrainOrderInput[]
): EffectiveDrainOrder {
  if (activeAccounts.length === 0) {
    return { mode: 'file', entries: [], hasDrift: false };
  }

  const drainCfg = loadDrainOrderConfig(provider);

  // Manual mode is only usable when at least one stored ID still maps to a live
  // account. If every stored ID is stale, fall back to the file-order view.
  let manualValidIds: string[] | undefined;
  if (drainCfg?.mode === 'manual' && drainCfg.orderedIds && drainCfg.orderedIds.length > 0) {
    const existingIds = new Set(activeAccounts.map((a) => a.accountId));
    manualValidIds = drainCfg.orderedIds.filter((id) => existingIds.has(id));
  }

  let entries: DrainOrderEntry[];
  let mode: EffectiveDrainOrderMode;

  if (manualValidIds && manualValidIds.length > 0) {
    entries = computeManualDrainOrder(manualValidIds, activeAccounts);
    mode = 'manual';
  } else if (drainCfg?.mode === 'tier') {
    entries = computeTierDrainOrder(activeAccounts);
    mode = 'tier';
  } else {
    // File order: config never writes priorities, so entries carry no computed
    // priority. The selector still reads any residual on-disk priority (e.g.
    // left behind by `order --reset`), so annotate, sort by that priority like
    // the other modes, and flag drift when any residual is non-zero.
    entries = activeAccounts.map((a) => ({
      accountId: a.accountId,
      tokenFile: a.tokenFile,
      priority: MIN_PRIORITY,
      tier: a.tier,
      tierDerived: false,
      currentPriority: undefined,
    }));
    annotateCurrentPriorities(entries);
    const fileHasDrift = entries.some((e) => (e.currentPriority ?? 0) !== 0);
    entries.sort(
      (a, b) =>
        (b.currentPriority ?? 0) - (a.currentPriority ?? 0) ||
        (tieBreakKey(a.tokenFile) < tieBreakKey(b.tokenFile) ? -1 : 1)
    );
    return { mode: 'file', entries, hasDrift: fileHasDrift };
  }

  // Annotate on-disk priorities (the selector's real input) before sorting.
  annotateCurrentPriorities(entries);

  // Drift: computed config priority diverges from on-disk anywhere. Missing
  // file priority (undefined) is treated as 0, matching the selector.
  const hasDrift = entries.some((e) => (e.currentPriority ?? 0) !== e.priority);

  // Sort by on-disk priority desc (undefined as 0), tie-break by tokenFile asc.
  entries.sort(
    (a, b) =>
      (b.currentPriority ?? 0) - (a.currentPriority ?? 0) ||
      (tieBreakKey(a.tokenFile) < tieBreakKey(b.tokenFile) ? -1 : 1)
  );

  return { mode, entries, hasDrift };
}
