/**
 * Pool State Resolver
 *
 * Resolves the observable state of an account pool for a provider, combining:
 * - effective drain order (Phase 4 resolver: manual / tier / file order)
 * - per-account state: available / cooling (quota cooldown, with reset time) / paused
 * - routing settings (strategy, session affinity) and pool routing mode
 *
 * These three account states map to DIFFERENT client-visible failure modes:
 * - paused  : the account is held out of rotation by the user or a safety guard
 * - cooling : the account hit a quota limit and is on a timed cooldown
 * - available: the account is eligible for selection
 *
 * They are named distinctly so visibility surfaces never conflate "I paused it"
 * with "it ran out of quota".
 *
 * Cooldown source precedence:
 * - The proxy/monitor process writes quota-paused.json (cross-process truth).
 *   When pool routing's cooling flip is OFF (stock disable-cooling: true) there
 *   is simply no cooldown data to show; this resolver reports that honestly.
 * - The in-memory quota-manager cooldown is process-local; it only contributes
 *   when this very process applied a cooldown. The persisted entry wins when
 *   both exist, because that is the routing truth across processes.
 */

import { resolveEffectiveDrainOrder, type DrainOrderInput } from './drain-order';
import { getProviderAccounts } from './query';
import { readQuotaCooldownEntries } from './account-safety';
import { getCooldownUntil } from '../quota/quota-manager';
import type { AccountInfo, AccountTier } from './types';
import type { CLIProxyProvider } from '../types';

/** Providers where tier metadata is tracked and tier-derived order is meaningful. */
export const POOL_TIER_AWARE_PROVIDERS = new Set<CLIProxyProvider>(['agy', 'gemini']);

/** Per-account pool state. */
export type PoolAccountStateKind = 'available' | 'cooling' | 'paused';

/** How the effective drain order was derived. */
export type PoolDrainOrderMode = 'manual' | 'tier' | 'file';

export interface PoolAccountState {
  accountId: string;
  tokenFile: string;
  tier?: AccountTier;
  /** Whether this account is the provider default. */
  isDefault: boolean;
  /** Resolved state. */
  state: PoolAccountStateKind;
  /**
   * For state 'cooling': epoch ms when the cooldown is eligible to lift.
   * Undefined for other states.
   */
  cooldownUntil?: number;
  /**
   * For state 'cooling': where the cooldown reading came from.
   * 'persisted' = quota-paused.json (cross-process), 'memory' = in-process map.
   */
  cooldownSource?: 'persisted' | 'memory';
  /** ISO timestamp the account was paused (manual pause), when state is 'paused'. */
  pausedAt?: string;
}

export interface PoolDrainOrderState {
  mode: PoolDrainOrderMode;
  /**
   * Accounts in effective drain order (first = drained first), as the selector
   * actually sees it: sorted by on-disk priority, not the intended config.
   * Paused accounts are excluded from the drain order (they are not in rotation)
   * but still surface in `states`.
   */
  order: string[];
  /**
   * True when the stored config order diverges from what is on disk (the
   * selector's real input). Surfaced so the quota pool section warns instead of
   * silently showing a "next account" that disagrees with the selector.
   */
  hasDrift: boolean;
}

export interface PoolRoutingSettings {
  /** Whether pool routing (fill-first + affinity + cooling) is enabled. */
  poolEnabled: boolean;
  strategy: string;
  sessionAffinityEnabled: boolean;
  sessionAffinityTtl: string;
  /** Max credentials tried per request before a 429, when pool routing is on. */
  maxRetryCredentials?: number;
}

export interface PoolState {
  provider: CLIProxyProvider;
  /** All accounts for the provider with resolved per-account state. */
  states: PoolAccountState[];
  drainOrder: PoolDrainOrderState;
  settings: PoolRoutingSettings;
}

export interface ResolvePoolStateInput {
  provider: CLIProxyProvider;
  settings: PoolRoutingSettings;
  /** Override for tests; defaults to getProviderAccounts(provider). */
  accounts?: AccountInfo[];
  /** Override for tests; defaults to Date.now(). */
  now?: number;
}

/**
 * Classify a single account's pool state.
 *
 * Precedence:
 * 1. A persisted quota cooldown whose pausedAt matches the account's pausedAt is
 *    a quota cooldown -> 'cooling' (cross-process truth wins).
 * 2. A paused account without a matching cooldown record is a manual/safety pause
 *    -> 'paused'.
 * 3. An unpaused account with an in-memory cooldown still in effect -> 'cooling'.
 * 4. Otherwise -> 'available'.
 */
function classifyAccount(
  provider: CLIProxyProvider,
  account: AccountInfo,
  cooldownByAccount: Map<string, { until: number; pausedAt: string }>,
  now: number
): PoolAccountState {
  const base: PoolAccountState = {
    accountId: account.id,
    tokenFile: account.tokenFile,
    tier: account.tier,
    isDefault: account.isDefault,
    state: 'available',
  };

  const persisted = cooldownByAccount.get(account.id);

  if (account.paused) {
    // A persisted quota cooldown that matches this pause is a cooldown, not a
    // manual pause. Match on pausedAt so a manual pause layered over a stale
    // cooldown record is not mislabelled.
    if (persisted && persisted.pausedAt === account.pausedAt && persisted.until > now) {
      return {
        ...base,
        state: 'cooling',
        cooldownUntil: persisted.until,
        cooldownSource: 'persisted',
      };
    }
    return { ...base, state: 'paused', pausedAt: account.pausedAt };
  }

  // Unpaused: a persisted cooldown still in effect is the routing truth.
  if (persisted && persisted.until > now) {
    return {
      ...base,
      state: 'cooling',
      cooldownUntil: persisted.until,
      cooldownSource: 'persisted',
    };
  }

  // Fall back to the process-local cooldown map.
  const memoryUntil = getCooldownUntil(provider, account.id);
  if (memoryUntil !== undefined && memoryUntil > now) {
    return {
      ...base,
      state: 'cooling',
      cooldownUntil: memoryUntil,
      cooldownSource: 'memory',
    };
  }

  return base;
}

/**
 * Compute the effective drain order for the active (non-paused) accounts,
 * mirroring the selector's pick order used by `ccs cliproxy accounts order`.
 *
 * Delegates to the shared resolveEffectiveDrainOrder() so the quota Pool
 * section, the `accounts order` show, and the selector all agree: the order is
 * sorted by ON-DISK priority (the selector's real input), and any drift between
 * the stored config and the auth files is surfaced rather than hidden.
 */
function resolveDrainOrder(
  provider: CLIProxyProvider,
  activeAccounts: DrainOrderInput[]
): PoolDrainOrderState {
  const effective = resolveEffectiveDrainOrder(provider, activeAccounts);
  return {
    mode: effective.mode,
    order: effective.entries.map((e) => e.accountId),
    hasDrift: effective.hasDrift,
  };
}

/**
 * Resolve the full observable pool state for a provider.
 */
export function resolvePoolState(input: ResolvePoolStateInput): PoolState {
  const { provider, settings } = input;
  const now = input.now ?? Date.now();
  const accounts = input.accounts ?? getProviderAccounts(provider);

  // Index persisted quota cooldowns for this provider by account id.
  const cooldownByAccount = new Map<string, { until: number; pausedAt: string }>();
  for (const entry of readQuotaCooldownEntries()) {
    if (entry.provider !== provider) continue;
    cooldownByAccount.set(entry.accountId, { until: entry.until, pausedAt: entry.pausedAt });
  }

  const states = accounts.map((account) =>
    classifyAccount(provider, account, cooldownByAccount, now)
  );

  // Drain order is computed over accounts that are in rotation (not paused).
  // Cooling accounts remain in the order: cooling is transient and the selector
  // still considers them in priority terms once the window lifts.
  const activeAccounts: DrainOrderInput[] = accounts
    .filter((a) => !a.paused)
    .map((a) => ({ accountId: a.id, tokenFile: a.tokenFile, tier: a.tier }));

  const drainOrder = resolveDrainOrder(provider, activeAccounts);

  return { provider, states, drainOrder, settings };
}
