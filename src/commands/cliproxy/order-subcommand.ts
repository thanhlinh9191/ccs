/**
 * CLIProxy Accounts Drain Order Subcommand
 *
 * Handles:
 *   ccs cliproxy accounts order <provider>
 *   ccs cliproxy accounts order <provider> --by-tier
 *   ccs cliproxy accounts order <provider> --set a@x.com,b@y.com,...
 *   ccs cliproxy accounts order <provider> --reset
 */

import { initUI, header, subheader, color, dim, ok, fail, warn, info } from '../../utils/ui';
import { extractOption, hasAnyFlag } from '../arg-extractor';
import {
  saveDrainOrderConfig,
  loadDrainOrderConfig,
  clearDrainOrderConfig,
} from '../../cliproxy/accounts/registry';
import { getProviderAccounts } from '../../cliproxy/accounts/query';
import {
  computeManualDrainOrder,
  computeTierDrainOrder,
  applyDrainOrder,
  annotateCurrentPriorities,
  readAuthFilePriority,
  type DrainOrderEntry,
  type DrainOrderInput,
} from '../../cliproxy/accounts/drain-order';
import { detectRunningProxy } from '../../cliproxy/proxy/proxy-detector';
import { getProxyTarget } from '../../cliproxy/proxy/proxy-target-resolver';
import { mapExternalProviderName } from '../../cliproxy/provider-capabilities';
import type { CLIProxyProvider } from '../../cliproxy/types';
import type { AccountTier } from '../../cliproxy/accounts/types';
import { resolveLifecyclePort } from '../../cliproxy/config/port-manager';

/** Providers where tier metadata is expected and --by-tier is meaningful. */
const TIER_AWARE_PROVIDERS = new Set<CLIProxyProvider>(['agy', 'gemini']);

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

function formatTierLabel(tier: AccountTier | undefined, tierDerived: boolean): string {
  if (!tier || tier === 'unknown') {
    return dim('unknown');
  }
  const label =
    tier === 'ultra' ? color(tier, 'success') : tier === 'pro' ? color(tier, 'info') : dim(tier);
  return tierDerived ? label : dim(tier);
}

function printOrderTable(
  entries: DrainOrderEntry[],
  showCurrentPriority: boolean,
  sortByFilePriority: boolean = false
): void {
  const rows = entries.slice().sort((a, b) => {
    if (sortByFilePriority) {
      // Sort by currentPriority (the selector's actual input), treating undefined as 0.
      // This is the priority the selector actually sees on disk, not the computed config priority.
      const aCurrent = a.currentPriority ?? 0;
      const bCurrent = b.currentPriority ?? 0;
      return bCurrent - aCurrent || (tieBreakKey(a.tokenFile) < tieBreakKey(b.tokenFile) ? -1 : 1);
    }
    // Tie-break by tokenFile ascending, matching the Go selector. Upstream sorts
    // by Auth.ID byte order and only lowercases on Windows (see tieBreakKey).
    // localeCompare is intentionally avoided - Go sorts by byte value, not locale.
    return (
      b.priority - a.priority || (tieBreakKey(a.tokenFile) < tieBreakKey(b.tokenFile) ? -1 : 1)
    );
  });

  const maxId = Math.max(...rows.map((r) => r.accountId.length), 'Account'.length);
  const maxPri = Math.max(...rows.map((r) => String(r.priority).length), 'Priority'.length);

  console.log(
    `  ${'#'.padStart(3)}  ${color('Account'.padEnd(maxId), 'command')}  ${'Priority'.padStart(maxPri)}  Tier`
  );
  console.log(`  ${'---'}  ${'-'.repeat(maxId)}  ${'-'.repeat(maxPri)}  ----`);

  rows.forEach((entry, idx) => {
    const pos = String(idx + 1).padStart(3);
    const id = entry.accountId.padEnd(maxId);
    const pri = String(entry.priority).padStart(maxPri);
    const tierLabel = formatTierLabel(entry.tier, entry.tierDerived);
    const currentNote =
      showCurrentPriority && entry.currentPriority !== undefined
        ? dim(` (file: ${entry.currentPriority})`)
        : '';
    console.log(
      `  ${pos}  ${color(id, 'command')}  ${color(pri, 'info')}  ${tierLabel}${currentNote}`
    );
  });
}

/**
 * Show effective drain order for a provider without making any changes.
 */
async function handleOrderShow(provider: CLIProxyProvider): Promise<void> {
  // Use getProviderAccounts() so auth files not yet in accounts.json
  // (e.g. file-copied fleets) are visible and tier metadata is preserved.
  const allAccounts = getProviderAccounts(provider);

  if (allAccounts.length === 0) {
    console.log(warn(`No accounts found for provider: ${provider}`));
    console.log('');
    return;
  }

  const accounts: DrainOrderInput[] = allAccounts
    .filter((a) => !a.paused)
    .map((a) => ({
      accountId: a.id,
      tokenFile: a.tokenFile,
      tier: a.tier,
    }));

  if (accounts.length === 0) {
    console.log(warn(`All accounts for ${provider} are paused.`));
    console.log('');
    return;
  }

  const drainCfg = loadDrainOrderConfig(provider);
  let entries: DrainOrderEntry[];
  let modeLabel: string;

  // Manual mode is only usable when at least one stored ID still maps to a live
  // account. If every stored ID is stale, fall back to the file-order view.
  let manualValidIds: string[] | undefined;
  if (drainCfg?.mode === 'manual' && drainCfg.orderedIds && drainCfg.orderedIds.length > 0) {
    const existingIds = new Set(accounts.map((a) => a.accountId));
    manualValidIds = drainCfg.orderedIds.filter((id) => existingIds.has(id));
  }

  if (manualValidIds && manualValidIds.length > 0) {
    entries = computeManualDrainOrder(manualValidIds, accounts);
    modeLabel = `manual (${color('--set', 'command')})`;
  } else if (drainCfg?.mode === 'tier') {
    entries = computeTierDrainOrder(accounts);
    modeLabel = `tier-derived (${color('--by-tier', 'command')})`;
  } else {
    // File order: no priority writes; show stable file order. Reached when no
    // config is stored, or when a stored manual order has only stale IDs.
    printFileOrderView(provider, accounts);
    return;
  }

  annotateCurrentPriorities(entries);

  // Detect drift: any account where the computed config priority does not match
  // what is actually on disk (the selector's real input). Missing file priority
  // (undefined) treated as 0 by the selector, so it also counts as drift when
  // the config says something higher.
  const hasDrift = entries.some((e) => (e.currentPriority ?? 0) !== e.priority);

  console.log(`  Mode:  ${modeLabel}`);
  if (hasDrift) {
    console.log('');
    console.log(
      warn(
        `Drift detected: stored order does not match auth files; re-run --set/--by-tier to re-apply.`
      )
    );
  }
  console.log('');
  // Show rows in selector pick order (currentPriority desc, tokenFile asc on tie).
  // This reflects what CLIProxy will actually drain, not just the intended config.
  console.log(subheader('Effective drain order (selector pick order, highest priority first):'));
  printOrderTable(entries, true, true);
  console.log('');
  console.log(
    dim(`  To update: ccs cliproxy accounts order ${provider} --set <comma-separated-ids>`)
  );
  if (TIER_AWARE_PROVIDERS.has(provider)) {
    console.log(dim(`  Tier-based: ccs cliproxy accounts order ${provider} --by-tier`));
  }
  console.log(dim(`  To reset:  ccs cliproxy accounts order ${provider} --reset`));
  console.log('');
}

function readFilePriorityNote(tokenFile: string): string {
  try {
    const p = readAuthFilePriority(tokenFile);
    return p !== undefined ? dim(` [priority: ${p}]`) : '';
  } catch {
    return '';
  }
}

/**
 * Render the stable file-order view (no priority writes). Used when no drain
 * order config is stored, or when a stored manual order has only stale IDs.
 */
function printFileOrderView(provider: CLIProxyProvider, accounts: DrainOrderInput[]): void {
  if (!TIER_AWARE_PROVIDERS.has(provider)) {
    console.log(
      info(
        `Tier unknown for ${provider} accounts - using file order.\n` +
          `    Use --set to specify manual order.`
      )
    );
  }
  console.log(`  Mode:  ${dim('file order (no priority set)')}`);
  console.log('');
  console.log(subheader('Active accounts (file order):'));
  // Sort by tokenFile ascending to match the Go selector's stable order.
  // Upstream sorts by Auth.ID byte order and only lowercases on Windows (see tieBreakKey).
  const sortedByFile = accounts
    .slice()
    .sort((a, b) => (tieBreakKey(a.tokenFile) < tieBreakKey(b.tokenFile) ? -1 : 1));
  sortedByFile.forEach((a, idx) => {
    const pri = readFilePriorityNote(a.tokenFile);
    console.log(`  ${String(idx + 1).padStart(3)}  ${color(a.accountId, 'command')}${pri}`);
  });
  console.log('');
  console.log(
    dim(`  To set manual order:    ccs cliproxy accounts order ${provider} --set a@x.com,b@y.com`)
  );
  if (TIER_AWARE_PROVIDERS.has(provider)) {
    console.log(
      dim(`  To use tier-based order: ccs cliproxy accounts order ${provider} --by-tier`)
    );
  }
  console.log('');
}

/**
 * Apply tier-derived drain order for a provider.
 */
async function handleOrderByTier(provider: CLIProxyProvider): Promise<void> {
  if (!TIER_AWARE_PROVIDERS.has(provider)) {
    console.log(
      warn(
        `Tier metadata is not available for ${provider} accounts.\n` +
          `    Tier is tracked for: ${[...TIER_AWARE_PROVIDERS].join(', ')}\n` +
          `    Use --set for manual order instead.`
      )
    );
    console.log('');
    process.exitCode = 1;
    return;
  }

  // Use getProviderAccounts() so auth files not yet in accounts.json
  // (e.g. file-copied fleets) are visible and tier metadata is preserved.
  const allProviderAccounts = getProviderAccounts(provider);

  if (allProviderAccounts.length === 0) {
    console.log(warn(`No accounts found for provider: ${provider}`));
    console.log('');
    process.exitCode = 1;
    return;
  }

  const accounts: DrainOrderInput[] = allProviderAccounts
    .filter((a) => !a.paused)
    .map((a) => ({
      accountId: a.id,
      tokenFile: a.tokenFile,
      tier: a.tier,
    }));

  if (accounts.length === 0) {
    console.log(warn(`All ${provider} accounts are paused.`));
    console.log('');
    process.exitCode = 1;
    return;
  }

  const allUnknown = accounts.every((a) => !a.tier || a.tier === 'unknown');
  if (allUnknown) {
    console.log(
      warn(
        `All ${provider} accounts have unknown tier.\n` +
          `    Run quota to populate tier metadata, or use --set for manual order.`
      )
    );
    console.log('');
    process.exitCode = 1;
    return;
  }

  const entries = computeTierDrainOrder(accounts);

  console.log(subheader('Computed tier-based drain order:'));
  printOrderTable(entries, false);
  console.log('');

  // Check proxy state for write path selection.
  // Use the configured local port (not the hardcoded default) for detection.
  // Remote targets: refuse with guidance - detection and current-priority reads
  // require management API access that is not wired in v1.
  const proxyTarget = getProxyTarget();
  if (proxyTarget.isRemote) {
    console.log(
      warn(
        `Remote proxy target detected. Drain order management for remote proxies is not\n` +
          `    supported in v1. Run this command on the host running CLIProxy instead.`
      )
    );
    console.log('');
    process.exitCode = 1;
    return;
  }

  const localPort = resolveLifecyclePort();
  const proxyStatus = await detectRunningProxy(localPort);

  // Ambiguous state: proxy process is alive but not yet responding to HTTP.
  // A direct file write while CLIProxy is serving could be silently clobbered
  // by the MarkResult-persist path. Refuse rather than risk priority loss.
  if (proxyStatus.running && !proxyStatus.verified) {
    console.log(fail('Proxy state ambiguous - retry in a moment or stop the proxy first.'));
    console.log('');
    process.exitCode = 1;
    return;
  }

  const proxyRunning = proxyStatus.running && proxyStatus.verified;

  if (proxyRunning) {
    console.log(info('Proxy is running - writing via management API (avoids clobber race).'));
  } else {
    console.log(info('Proxy is stopped - writing directly to auth files.'));
  }
  console.log('');

  const result = await applyDrainOrder(entries, proxyRunning);

  if (result.written.length > 0) {
    console.log(ok(`Set priorities for ${result.written.length} account(s).`));
  }
  if (result.skipped.length > 0) {
    console.log(info(`Skipped ${result.skipped.length} account(s) (priority already correct).`));
  }
  if (result.failed.length > 0) {
    for (const f of result.failed) {
      console.log(fail(`Failed to set priority for ${f.entry.accountId}: ${f.reason}`));
    }
    process.exitCode = 1;
  }

  if (result.failed.length === 0) {
    // Persist mode
    const persisted = saveDrainOrderConfig(provider, { mode: 'tier' });
    if (persisted) {
      console.log(
        ok(
          `Drain order mode saved as "tier". Re-run "ccs cliproxy accounts order ${provider} --by-tier" after adding or re-authing accounts to re-apply.`
        )
      );
    } else {
      console.log(
        warn(
          `Order applied to auth files but mode not persisted - no registered accounts for ${provider}; run ccs cliproxy quota to register, then re-run`
        )
      );
    }
  }
  console.log('');
}

/**
 * Apply manual drain order specified as comma-separated account IDs.
 */
async function handleOrderSet(provider: CLIProxyProvider, setArg: string): Promise<void> {
  const orderedIds = setArg
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (orderedIds.length === 0) {
    console.log(fail('--set requires a comma-separated list of account IDs.'));
    console.log('');
    process.exitCode = 1;
    return;
  }

  // Use getProviderAccounts() so auth files not yet in accounts.json
  // (e.g. file-copied fleets) are visible and tier metadata is preserved.
  const allProviderAccounts = getProviderAccounts(provider);

  if (allProviderAccounts.length === 0) {
    console.log(warn(`No accounts found for provider: ${provider}`));
    console.log('');
    process.exitCode = 1;
    return;
  }

  const allAccounts: DrainOrderInput[] = allProviderAccounts
    .filter((a) => !a.paused)
    .map((a) => ({
      accountId: a.id,
      tokenFile: a.tokenFile,
      tier: a.tier,
    }));

  let entries: DrainOrderEntry[];
  try {
    entries = computeManualDrainOrder(orderedIds, allAccounts);
  } catch (err) {
    console.log(fail(`${(err as Error).message}`));
    console.log('');
    process.exitCode = 1;
    return;
  }

  console.log(subheader('Computed manual drain order:'));
  printOrderTable(entries, false);
  console.log('');

  // Use the configured local port (not the hardcoded default) for detection.
  // Remote targets: refuse with guidance.
  const proxyTarget = getProxyTarget();
  if (proxyTarget.isRemote) {
    console.log(
      warn(
        `Remote proxy target detected. Drain order management for remote proxies is not\n` +
          `    supported in v1. Run this command on the host running CLIProxy instead.`
      )
    );
    console.log('');
    process.exitCode = 1;
    return;
  }

  const localPort = resolveLifecyclePort();
  const proxyStatus = await detectRunningProxy(localPort);

  // Ambiguous state: proxy process is alive but not yet responding to HTTP.
  // A direct file write while CLIProxy is serving could be silently clobbered
  // by the MarkResult-persist path. Refuse rather than risk priority loss.
  if (proxyStatus.running && !proxyStatus.verified) {
    console.log(fail('Proxy state ambiguous - retry in a moment or stop the proxy first.'));
    console.log('');
    process.exitCode = 1;
    return;
  }

  const proxyRunning = proxyStatus.running && proxyStatus.verified;

  if (proxyRunning) {
    console.log(info('Proxy is running - writing via management API (avoids clobber race).'));
  } else {
    console.log(info('Proxy is stopped - writing directly to auth files.'));
  }
  console.log('');

  const result = await applyDrainOrder(entries, proxyRunning);

  if (result.written.length > 0) {
    console.log(ok(`Set priorities for ${result.written.length} account(s).`));
  }
  if (result.skipped.length > 0) {
    console.log(info(`Skipped ${result.skipped.length} account(s) (priority already correct).`));
  }
  if (result.failed.length > 0) {
    for (const f of result.failed) {
      console.log(fail(`Failed to set priority for ${f.entry.accountId}: ${f.reason}`));
    }
    process.exitCode = 1;
  }

  if (result.failed.length === 0) {
    const persisted = saveDrainOrderConfig(provider, { mode: 'manual', orderedIds });
    if (persisted) {
      console.log(
        ok(
          `Drain order mode saved as "manual". Re-run "ccs cliproxy accounts order ${provider} --set <ids>" after adding or re-authing accounts to re-apply.`
        )
      );
    } else {
      console.log(
        warn(
          `Order applied to auth files but mode not persisted - no registered accounts for ${provider}; run ccs cliproxy quota to register, then re-run`
        )
      );
    }
  }
  console.log('');
}

/**
 * Reset drain order to file order (removes persisted config, no priority writes).
 */
async function handleOrderReset(provider: CLIProxyProvider): Promise<void> {
  const cleared = clearDrainOrderConfig(provider);
  if (cleared) {
    console.log(ok(`Drain order reset to file order for ${provider}.`));
    console.log(
      dim(
        '  Note: existing priority values in auth files are not removed.\n' +
          '  CLIProxy will continue using them until they are overwritten or files are re-created.'
      )
    );
  } else {
    console.log(info(`No drain order config found for ${provider}. Already in file order.`));
  }
  console.log('');
}

function printOrderHelp(provider?: string): void {
  const prov = provider ?? '<provider>';
  console.log(subheader('Usage:'));
  console.log(`  ${color(`ccs cliproxy accounts order ${prov}`, 'command')}`);
  console.log(`  ${color(`ccs cliproxy accounts order ${prov} --by-tier`, 'command')}`);
  console.log(`  ${color(`ccs cliproxy accounts order ${prov} --set a@x.com,b@y.com`, 'command')}`);
  console.log(`  ${color(`ccs cliproxy accounts order ${prov} --reset`, 'command')}`);
  console.log('');
  console.log(subheader('Options:'));
  console.log(`  ${dim('(no flags)')}   Show effective drain order`);
  console.log(
    `  ${color('--by-tier', 'command')}    Derive order from tier metadata (ultra > pro > free)`
  );
  console.log(
    `  ${color('--set', 'command')} <ids>  Set manual order (comma-separated account IDs)`
  );
  console.log(`  ${color('--reset', 'command')}      Revert to stable file order`);
  console.log('');
  console.log(dim('  Tier-based ordering is available for: agy, gemini'));
  console.log(dim('  Claude accounts have unknown tier; use --set for manual order.'));
  console.log('');
}

/**
 * Main handler for `ccs cliproxy accounts order <provider> [flags]`
 */
export async function handleOrderSubcommand(args: string[]): Promise<void> {
  await initUI();
  console.log('');
  console.log(header('CLIProxy Drain Order'));
  console.log('');

  if (hasAnyFlag(args, ['--help', '-h']) || args.length === 0) {
    printOrderHelp();
    return;
  }

  // First positional arg is provider name
  const providerRaw = args[0];
  if (!providerRaw || providerRaw.startsWith('-')) {
    console.log(fail('Provider name required. Usage: ccs cliproxy accounts order <provider>'));
    console.log('');
    printOrderHelp();
    process.exitCode = 1;
    return;
  }

  const provider = mapExternalProviderName(providerRaw) as CLIProxyProvider | null;
  if (!provider) {
    console.log(fail(`Unknown provider: ${providerRaw}`));
    console.log('');
    process.exitCode = 1;
    return;
  }

  const subArgs = args.slice(1);

  if (hasAnyFlag(subArgs, ['--reset'])) {
    await handleOrderReset(provider);
    return;
  }

  if (hasAnyFlag(subArgs, ['--by-tier'])) {
    await handleOrderByTier(provider);
    return;
  }

  const extracted = extractOption(subArgs, ['--set']);
  if (extracted.found) {
    if (extracted.missingValue || !extracted.value) {
      console.log(fail('--set requires a value: --set a@x.com,b@y.com,...'));
      console.log('');
      process.exitCode = 1;
      return;
    }
    await handleOrderSet(provider, extracted.value);
    return;
  }

  // Default: show current order
  await handleOrderShow(provider);
}
