/**
 * Dashboard service for codex-auth profile summary.
 *
 * Reads the profile registry, decodes each profile's auth.json JWT,
 * resolves the active profile via env precedence, and returns the
 * API response shape for GET /api/codex/profiles.
 *
 * Security: tokens NEVER appear in the returned object. Only display-safe
 * fields (email, plan, accountId) are extracted from JWT. auth.json is
 * read/decoded and then discarded.
 *
 * Cache: 5-second in-memory single-key cache reduces fs reads during
 * dashboard polling. Out-of-process callers rely on the TTL. In-process
 * callers (Phase 2 CLI commands running in dev-server context) can call
 * invalidateCodexAuthProfilesCache() to force an immediate re-read.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { createLogger } from '../services/logging';
import { decodeAccountIdentity } from './codex-account-identity';
import { getCodexAuthRegistryPath, getCodexInstancesDir } from './codex-profile-paths';
import type { CodexProfileData } from './types';

const logger = createLogger('codex-auth:dashboard');

// ── Response types ──────────────────────────────────────────────────────────

export interface CodexAuthProfileEntry {
  name: string;
  codexHome: string;
  email: string | null;
  plan: string | null;
  accountId: string | null;
  lastUsed: string | null;
  authValid: boolean;
}

export interface CodexAuthActiveProfile {
  name: string | null;
  source: 'default' | 'env' | 'explicit-codex-home';
  codexHome: string;
}

export interface CodexAuthProfilesSummary {
  active: CodexAuthActiveProfile | null;
  default: string | null;
  profiles: CodexAuthProfileEntry[];
}

// ── Cache ───────────────────────────────────────────────────────────────────

let cache: { value: CodexAuthProfilesSummary; expiresAt: number } | null = null;
const TTL_MS = 5000;

/**
 * Invalidate the in-process cache so the next call re-reads from disk.
 * Useful for Phase 2 CLI commands running in the same process as the dashboard.
 * Out-of-process invocations rely on the 5s TTL.
 */
export function invalidateCodexAuthProfilesCache(): void {
  cache = null;
}

// ── Registry helpers ────────────────────────────────────────────────────────

function readRegistry(): CodexProfileData {
  const registryPath = getCodexAuthRegistryPath();
  if (!fs.existsSync(registryPath)) {
    return { version: '1.0', default: null, profiles: {} };
  }
  try {
    const raw = fs.readFileSync(registryPath, 'utf8');
    const parsed = yaml.load(raw) as CodexProfileData | null;
    if (!parsed || typeof parsed !== 'object' || !parsed.profiles) {
      return { version: '1.0', default: null, profiles: {} };
    }
    return parsed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('codex-auth.dashboard.registry-read-failed', `Registry read failed: ${msg}`);
    return { version: '1.0', default: null, profiles: {} };
  }
}

// ── Profile entry builder ───────────────────────────────────────────────────

function buildProfileEntry(name: string): CodexAuthProfileEntry {
  const codexHome = path.join(getCodexInstancesDir(), name);
  const authJsonPath = path.join(codexHome, 'auth.json');

  let authValid = false;
  let email: string | null = null;
  let plan: string | null = null;
  let accountId: string | null = null;

  try {
    if (fs.existsSync(authJsonPath)) {
      // decodeAccountIdentity never throws; returns {} on any error
      const identity = decodeAccountIdentity(authJsonPath);
      authValid = Object.keys(identity).length > 0 || _hasValidStructure(authJsonPath);
      email = identity.email ?? null;
      plan = identity.plan_type ?? null;
      accountId = identity.account_id ?? null;
      logger.debug(
        'codex-auth.dashboard.decoded',
        `Decoded auth for profile=${name} email=${email ?? '(none)'}`
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      'codex-auth.dashboard.decode-error',
      `Failed to decode auth for profile=${name}: ${msg}`
    );
  }

  return {
    name,
    codexHome,
    email,
    plan,
    accountId,
    // lastUsed is set below by caller from registry metadata
    lastUsed: null,
    authValid,
  };
}

/**
 * Check whether auth.json has the expected structure (tokens.id_token present),
 * even if decoding yielded no display fields (e.g. no email in JWT).
 * This sets authValid=true for valid-but-sparse tokens.
 */
function _hasValidStructure(authJsonPath: string): boolean {
  try {
    const raw = fs.readFileSync(authJsonPath, 'utf8');
    const parsed = JSON.parse(raw) as { tokens?: { id_token?: string } };
    return typeof parsed?.tokens?.id_token === 'string' && parsed.tokens.id_token.length > 0;
  } catch {
    return false;
  }
}

// ── Active resolution ───────────────────────────────────────────────────────

function resolveActive(registry: CodexProfileData): CodexAuthActiveProfile | null {
  const instancesDir = getCodexInstancesDir();

  // Precedence 1: explicit $CODEX_HOME set by env (ccsxp, manual)
  const codexHome = (process.env.CODEX_HOME ?? '').trim();
  if (codexHome) {
    // Attempt reverse-map: does any registered profile's codexHome match?
    const matchedName =
      Object.keys(registry.profiles).find((name) => path.join(instancesDir, name) === codexHome) ??
      null;
    return {
      name: matchedName,
      source: 'explicit-codex-home',
      codexHome,
    };
  }

  // Precedence 2: $CCS_CODEX_PROFILE env var
  const profileEnv = (process.env.CCS_CODEX_PROFILE ?? '').trim();
  if (profileEnv) {
    return {
      name: profileEnv,
      source: 'env',
      codexHome: path.join(instancesDir, profileEnv),
    };
  }

  // Precedence 3: registry default
  const defaultProfile = registry.default;
  if (defaultProfile) {
    return {
      name: defaultProfile,
      source: 'default',
      codexHome: path.join(instancesDir, defaultProfile),
    };
  }

  // Precedence 4: no active profile (legacy ~/.codex mode)
  return null;
}

// ── Core builder ────────────────────────────────────────────────────────────

async function buildSummary(): Promise<CodexAuthProfilesSummary> {
  const registry = readRegistry();
  const active = resolveActive(registry);

  const profiles: CodexAuthProfileEntry[] = Object.entries(registry.profiles).map(
    ([name, meta]) => {
      const entry = buildProfileEntry(name);
      entry.lastUsed = meta.last_used ?? null;
      return entry;
    }
  );

  return {
    active,
    default: registry.default,
    profiles,
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Returns the codex-auth profiles summary, using a 5s in-memory cache.
 * Tokens are never included in the returned object.
 */
export async function getCodexAuthProfilesSummary(): Promise<CodexAuthProfilesSummary> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return cache.value;
  }
  const value = await buildSummary();
  cache = { value, expiresAt: now + TTL_MS };
  return value;
}
