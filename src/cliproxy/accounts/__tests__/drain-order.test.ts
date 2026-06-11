/**
 * Tests for drain order priority computation, write path, and attribution stability.
 */
import { describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runWithScopedCcsHome } from '../../../utils/config-manager';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withIsolatedHome<T>(fn: (homeDir: string) => Promise<T> | T): Promise<T> {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-drain-order-'));
  try {
    return await runWithScopedCcsHome(homeDir, () => fn(homeDir));
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

/** Create a minimal auth JSON file in the auth dir. */
function writeAuthFile(
  authDir: string,
  fileName: string,
  fields: Record<string, unknown> = {}
): void {
  fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
  const content = JSON.stringify({ type: 'antigravity', email: fileName, ...fields }, null, 2);
  fs.writeFileSync(path.join(authDir, fileName), content, { mode: 0o600 });
}

function readAuthFile(authDir: string, fileName: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(authDir, fileName), 'utf-8')) as Record<
    string,
    unknown
  >;
}

// ---------------------------------------------------------------------------
// Import helpers (avoid module-level imports that capture paths at load time)
// ---------------------------------------------------------------------------

async function loadDrainOrder() {
  return import(`../drain-order?drain-order=${Date.now()}`);
}

async function loadRegistry() {
  return import(`../registry?drain-order-registry=${Date.now()}`);
}

async function loadStatsTransformer() {
  return import(`../../../cliproxy/services/stats-fetcher?drain-order-stats-fetcher=${Date.now()}`);
}

async function loadOrderSubcommand() {
  return import(
    `../../../commands/cliproxy/order-subcommand?drain-order-order-subcommand=${Date.now()}`
  );
}

// ---------------------------------------------------------------------------
// Priority computation tests
// ---------------------------------------------------------------------------

describe('rankToPriority', () => {
  it('maps rank 0 (highest) to total priority', async () => {
    const { rankToPriority } = await loadDrainOrder();
    expect(rankToPriority(0, 3)).toBe(3);
  });

  it('maps last rank to MIN_PRIORITY (1)', async () => {
    const { rankToPriority, MIN_PRIORITY } = await loadDrainOrder();
    expect(rankToPriority(2, 3)).toBe(MIN_PRIORITY);
    expect(rankToPriority(2, 3)).toBeGreaterThanOrEqual(1);
  });

  it('never returns 0', async () => {
    const { rankToPriority } = await loadDrainOrder();
    for (let total = 1; total <= 5; total++) {
      for (let rank = 0; rank < total; rank++) {
        expect(rankToPriority(rank, total)).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('single account gets priority 1', async () => {
    const { rankToPriority } = await loadDrainOrder();
    expect(rankToPriority(0, 1)).toBe(1);
  });
});

describe('computeManualDrainOrder', () => {
  it('assigns descending priorities to specified accounts', async () => {
    const { computeManualDrainOrder } = await loadDrainOrder();
    const accounts = [
      { accountId: 'a@x.com', tokenFile: 'a.json' },
      { accountId: 'b@x.com', tokenFile: 'b.json' },
      { accountId: 'c@x.com', tokenFile: 'c.json' },
    ];
    const entries = computeManualDrainOrder(['a@x.com', 'b@x.com', 'c@x.com'], accounts);
    const byId = new Map(
      entries.map((e: { accountId: string; priority: number }) => [e.accountId, e.priority])
    );
    expect(byId.get('a@x.com')).toBeGreaterThan(byId.get('b@x.com'));
    expect(byId.get('b@x.com')).toBeGreaterThan(byId.get('c@x.com'));
    expect(byId.get('c@x.com')).toBeGreaterThanOrEqual(1);
  });

  it('throws for unknown account ID', async () => {
    const { computeManualDrainOrder } = await loadDrainOrder();
    const accounts = [{ accountId: 'a@x.com', tokenFile: 'a.json' }];
    expect(() => computeManualDrainOrder(['z@x.com'], accounts)).toThrow();
  });

  it('throws for duplicate account ID in the order list', async () => {
    const { computeManualDrainOrder } = await loadDrainOrder();
    const accounts = [
      { accountId: 'a@x.com', tokenFile: 'a.json' },
      { accountId: 'b@x.com', tokenFile: 'b.json' },
    ];
    expect(() => computeManualDrainOrder(['a@x.com', 'b@x.com', 'a@x.com'], accounts)).toThrow(
      /[Dd]uplicate/
    );
  });

  it('unspecified accounts get MIN_PRIORITY', async () => {
    const { computeManualDrainOrder, MIN_PRIORITY } = await loadDrainOrder();
    const accounts = [
      { accountId: 'a@x.com', tokenFile: 'a.json' },
      { accountId: 'b@x.com', tokenFile: 'b.json' },
    ];
    const entries = computeManualDrainOrder(['a@x.com'], accounts);
    const bEntry = entries.find((e: { accountId: string }) => e.accountId === 'b@x.com');
    expect(bEntry?.priority).toBe(MIN_PRIORITY);
  });

  it('is idempotent - same inputs produce same priorities', async () => {
    const { computeManualDrainOrder } = await loadDrainOrder();
    const accounts = [
      { accountId: 'a@x.com', tokenFile: 'a.json' },
      { accountId: 'b@x.com', tokenFile: 'b.json' },
    ];
    const entries1 = computeManualDrainOrder(['a@x.com', 'b@x.com'], accounts);
    const entries2 = computeManualDrainOrder(['a@x.com', 'b@x.com'], accounts);
    expect(JSON.stringify(entries1)).toBe(JSON.stringify(entries2));
  });

  it('partial --set: every specified account has strictly higher priority than every unspecified account', async () => {
    // Regression for the tie at priority 1 when last specified == MIN_PRIORITY == unspecified.
    // With a pool of 5, specifying 2 should give the last specified priority > 1.
    const { computeManualDrainOrder, MIN_PRIORITY } = await loadDrainOrder();
    const accounts = [
      { accountId: 'a@x.com', tokenFile: 'a.json' },
      { accountId: 'b@x.com', tokenFile: 'b.json' },
      { accountId: 'c@x.com', tokenFile: 'c.json' },
      { accountId: 'd@x.com', tokenFile: 'd.json' },
      { accountId: 'e@x.com', tokenFile: 'e.json' },
    ];
    const entries = computeManualDrainOrder(['a@x.com', 'b@x.com'], accounts);
    const byId = new Map(
      entries.map((e: { accountId: string; priority: number }) => [e.accountId, e.priority])
    );
    const specifiedPriorities = ['a@x.com', 'b@x.com'].map((id) => byId.get(id) as number);
    const unspecifiedPriorities = ['c@x.com', 'd@x.com', 'e@x.com'].map(
      (id) => byId.get(id) as number
    );
    const minSpecified = Math.min(...specifiedPriorities);
    const maxUnspecified = Math.max(...unspecifiedPriorities);
    expect(minSpecified).toBeGreaterThan(maxUnspecified);
    // Unspecified accounts still get MIN_PRIORITY
    for (const p of unspecifiedPriorities) {
      expect(p).toBe(MIN_PRIORITY);
    }
  });
});

describe('computeTierDrainOrder', () => {
  it('ultra > pro > free priority ordering', async () => {
    const { computeTierDrainOrder } = await loadDrainOrder();
    const accounts = [
      { accountId: 'free@x.com', tokenFile: 'free.json', tier: 'free' as const },
      { accountId: 'ultra@x.com', tokenFile: 'ultra.json', tier: 'ultra' as const },
      { accountId: 'pro@x.com', tokenFile: 'pro.json', tier: 'pro' as const },
    ];
    const entries = computeTierDrainOrder(accounts);
    const byId = new Map(
      entries.map((e: { accountId: string; priority: number }) => [e.accountId, e.priority])
    );
    expect(byId.get('ultra@x.com')).toBeGreaterThan(byId.get('pro@x.com'));
    expect(byId.get('pro@x.com')).toBeGreaterThan(byId.get('free@x.com'));
    expect(byId.get('free@x.com')).toBeGreaterThanOrEqual(1);
  });

  it('unknown tier gets lowest priority (MIN_PRIORITY)', async () => {
    const { computeTierDrainOrder, MIN_PRIORITY } = await loadDrainOrder();
    const accounts = [
      { accountId: 'ultra@x.com', tokenFile: 'ultra.json', tier: 'ultra' as const },
      { accountId: 'unknown@x.com', tokenFile: 'unknown.json', tier: 'unknown' as const },
    ];
    const entries = computeTierDrainOrder(accounts);
    const unknownEntry = entries.find(
      (e: { accountId: string }) => e.accountId === 'unknown@x.com'
    );
    expect(unknownEntry?.priority).toBe(MIN_PRIORITY);
  });

  it('accounts with same tier get equal priority', async () => {
    const { computeTierDrainOrder } = await loadDrainOrder();
    const accounts = [
      { accountId: 'a@x.com', tokenFile: 'a.json', tier: 'pro' as const },
      { accountId: 'b@x.com', tokenFile: 'b.json', tier: 'pro' as const },
    ];
    const entries = computeTierDrainOrder(accounts);
    const [a, b] = entries as Array<{ accountId: string; priority: number }>;
    expect(a.priority).toBe(b.priority);
  });

  it('tie-break by tokenFile (plain byte order, not locale) matches selector contract', async () => {
    // The upstream Go selector breaks priority ties by Auth.ID asc (lowercased file path).
    // For the agy prefix-named fleet, file names differ from emails, so verify we sort
    // by tokenFile not accountId.
    const { computeTierDrainOrder } = await loadDrainOrder();
    const accounts = [
      { accountId: 'z@x.com', tokenFile: 'antigravity-aaa.json', tier: 'pro' as const },
      { accountId: 'a@x.com', tokenFile: 'antigravity-zzz.json', tier: 'pro' as const },
    ];
    // Both same tier -> same priority; sort by tokenFile should put 'aaa' before 'zzz'
    const entries = computeTierDrainOrder(accounts) as Array<{
      accountId: string;
      tokenFile: string;
      priority: number;
    }>;
    // Confirm equal priorities
    expect(entries[0].priority).toBe(entries[1].priority);
    // Sort as the display layer does: priority desc, tokenFile lowercase asc
    const sorted = entries
      .slice()
      .sort(
        (a, b) =>
          b.priority - a.priority ||
          (a.tokenFile.toLowerCase() < b.tokenFile.toLowerCase() ? -1 : 1)
      );
    // antigravity-aaa.json sorts before antigravity-zzz.json (byte/file order)
    expect(sorted[0].tokenFile).toBe('antigravity-aaa.json');
    expect(sorted[1].tokenFile).toBe('antigravity-zzz.json');
    // accountId order is the reverse, confirming file order != email order for this fleet
    expect(sorted[0].accountId).toBe('z@x.com');
    expect(sorted[1].accountId).toBe('a@x.com');
  });

  it('tierDerived is true only for accounts with a real tier rank', async () => {
    const { computeTierDrainOrder } = await loadDrainOrder();
    const accounts = [
      { accountId: 'ultra@x.com', tokenFile: 'ultra.json', tier: 'ultra' as const },
      { accountId: 'unknown@x.com', tokenFile: 'unknown.json', tier: 'unknown' as const },
    ];
    const entries = computeTierDrainOrder(accounts) as Array<{
      accountId: string;
      tierDerived: boolean;
    }>;
    const ultraEntry = entries.find((e) => e.accountId === 'ultra@x.com');
    const unknownEntry = entries.find((e) => e.accountId === 'unknown@x.com');
    expect(ultraEntry?.tierDerived).toBe(true);
    expect(unknownEntry?.tierDerived).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tie-break key (platform-conditional, mirrors upstream synthesizer)
// ---------------------------------------------------------------------------

describe('tieBreakKey', () => {
  it('preserves case on non-Windows (byte order, upper before lower)', async () => {
    const { tieBreakKey } = await loadOrderSubcommand();
    // On non-Windows the selector compares raw Auth.ID bytes: 'B' (0x42) < 'a' (0x61).
    const files = ['antigravity-aaa.json', 'antigravity-Bbb.json'];
    const sorted = files
      .slice()
      .sort((a, b) => (tieBreakKey(a, 'linux') < tieBreakKey(b, 'linux') ? -1 : 1));
    expect(sorted).toEqual(['antigravity-Bbb.json', 'antigravity-aaa.json']);
  });

  it('lowercases on Windows so mixed case sorts case-insensitively', async () => {
    const { tieBreakKey } = await loadOrderSubcommand();
    const files = ['antigravity-aaa.json', 'antigravity-Bbb.json'];
    const sorted = files
      .slice()
      .sort((a, b) => (tieBreakKey(a, 'win32') < tieBreakKey(b, 'win32') ? -1 : 1));
    expect(sorted).toEqual(['antigravity-aaa.json', 'antigravity-Bbb.json']);
  });
});

// ---------------------------------------------------------------------------
// Direct file write tests
// ---------------------------------------------------------------------------

describe('writeAuthFilePriorityDirect', () => {
  it('writes priority field to auth JSON', async () => {
    await withIsolatedHome(async (homeDir) => {
      const authDir = path.join(homeDir, '.ccs', 'cliproxy', 'auth');
      writeAuthFile(authDir, 'test.json', { email: 'test@x.com' });

      const { writeAuthFilePriorityDirect } = await loadDrainOrder();
      writeAuthFilePriorityDirect('test.json', 3);

      const data = readAuthFile(authDir, 'test.json');
      expect(data.priority).toBe(3);
    });
  });

  it('preserves all other fields', async () => {
    await withIsolatedHome(async (homeDir) => {
      const authDir = path.join(homeDir, '.ccs', 'cliproxy', 'auth');
      writeAuthFile(authDir, 'test.json', { email: 'test@x.com', token: 'abc123' });

      const { writeAuthFilePriorityDirect } = await loadDrainOrder();
      writeAuthFilePriorityDirect('test.json', 2);

      const data = readAuthFile(authDir, 'test.json');
      expect(data.email).toBe('test@x.com');
      expect(data.token).toBe('abc123');
      expect(data.priority).toBe(2);
    });
  });

  it('rejects priority 0 (management layer treats 0 as delete)', async () => {
    await withIsolatedHome(async (homeDir) => {
      const authDir = path.join(homeDir, '.ccs', 'cliproxy', 'auth');
      writeAuthFile(authDir, 'test.json');

      const { writeAuthFilePriorityDirect } = await loadDrainOrder();
      expect(() => writeAuthFilePriorityDirect('test.json', 0)).toThrow();
    });
  });

  it('rejects negative priority', async () => {
    await withIsolatedHome(async (homeDir) => {
      const authDir = path.join(homeDir, '.ccs', 'cliproxy', 'auth');
      writeAuthFile(authDir, 'test.json');

      const { writeAuthFilePriorityDirect } = await loadDrainOrder();
      expect(() => writeAuthFilePriorityDirect('test.json', -1)).toThrow();
    });
  });

  it('throws when file does not exist', async () => {
    await withIsolatedHome(async (_homeDir) => {
      const { writeAuthFilePriorityDirect } = await loadDrainOrder();
      expect(() => writeAuthFilePriorityDirect('nonexistent.json', 1)).toThrow();
    });
  });
});

describe('readAuthFilePriority', () => {
  it('returns the priority from a file that has one', async () => {
    await withIsolatedHome(async (homeDir) => {
      const authDir = path.join(homeDir, '.ccs', 'cliproxy', 'auth');
      writeAuthFile(authDir, 'test.json', { priority: 5 });

      const { readAuthFilePriority } = await loadDrainOrder();
      expect(readAuthFilePriority('test.json')).toBe(5);
    });
  });

  it('returns undefined for file with no priority', async () => {
    await withIsolatedHome(async (homeDir) => {
      const authDir = path.join(homeDir, '.ccs', 'cliproxy', 'auth');
      writeAuthFile(authDir, 'test.json', { email: 'x@y.com' });

      const { readAuthFilePriority } = await loadDrainOrder();
      expect(readAuthFilePriority('test.json')).toBeUndefined();
    });
  });

  it('returns undefined for missing file', async () => {
    await withIsolatedHome(async (_homeDir) => {
      const { readAuthFilePriority } = await loadDrainOrder();
      expect(readAuthFilePriority('ghost.json')).toBeUndefined();
    });
  });

  it('returns undefined for priority 0 (invalid sentinel)', async () => {
    await withIsolatedHome(async (homeDir) => {
      const authDir = path.join(homeDir, '.ccs', 'cliproxy', 'auth');
      writeAuthFile(authDir, 'test.json', { priority: 0 });

      const { readAuthFilePriority } = await loadDrainOrder();
      expect(readAuthFilePriority('test.json')).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// applyDrainOrder (direct write path, proxy stopped)
// ---------------------------------------------------------------------------

describe('applyDrainOrder - direct write path (proxy stopped)', () => {
  it('writes priorities to all files when proxy stopped', async () => {
    await withIsolatedHome(async (homeDir) => {
      const authDir = path.join(homeDir, '.ccs', 'cliproxy', 'auth');
      writeAuthFile(authDir, 'a.json', { email: 'a@x.com' });
      writeAuthFile(authDir, 'b.json', { email: 'b@x.com' });

      const { applyDrainOrder } = await loadDrainOrder();
      const entries = [
        {
          accountId: 'a@x.com',
          tokenFile: 'a.json',
          priority: 2,
          tierDerived: false,
          currentPriority: undefined,
        },
        {
          accountId: 'b@x.com',
          tokenFile: 'b.json',
          priority: 1,
          tierDerived: false,
          currentPriority: undefined,
        },
      ];
      const result = await applyDrainOrder(entries, false);

      expect(result.usedManagementApi).toBe(false);
      expect(result.written).toHaveLength(2);
      expect(result.failed).toHaveLength(0);

      const a = readAuthFile(authDir, 'a.json');
      const b = readAuthFile(authDir, 'b.json');
      expect(a.priority).toBe(2);
      expect(b.priority).toBe(1);
    });
  });

  it('skips entries where priority already matches (idempotency)', async () => {
    await withIsolatedHome(async (homeDir) => {
      const authDir = path.join(homeDir, '.ccs', 'cliproxy', 'auth');
      writeAuthFile(authDir, 'a.json', { email: 'a@x.com', priority: 3 });

      const { applyDrainOrder } = await loadDrainOrder();
      const entries = [
        {
          accountId: 'a@x.com',
          tokenFile: 'a.json',
          priority: 3,
          tierDerived: false,
          currentPriority: undefined,
        },
      ];
      const result = await applyDrainOrder(entries, false);

      expect(result.skipped).toHaveLength(1);
      expect(result.written).toHaveLength(0);
    });
  });

  it('records failures for missing files', async () => {
    await withIsolatedHome(async (_homeDir) => {
      const { applyDrainOrder } = await loadDrainOrder();
      const entries = [
        {
          accountId: 'ghost@x.com',
          tokenFile: 'ghost.json',
          priority: 2,
          tierDerived: false,
          currentPriority: undefined,
        },
      ];
      const result = await applyDrainOrder(entries, false);
      expect(result.failed).toHaveLength(1);
      expect(result.written).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Registry drain order persistence
// ---------------------------------------------------------------------------

describe('registry drain order persistence', () => {
  it('saveDrainOrderConfig persists and loadDrainOrderConfig retrieves', async () => {
    await withIsolatedHome(async (homeDir) => {
      const authDir = path.join(homeDir, '.ccs', 'cliproxy', 'auth');
      writeAuthFile(authDir, 'antigravity-a.json', { email: 'a@x.com', type: 'antigravity' });

      const { registerAccount } = await loadRegistry();
      registerAccount('agy', 'antigravity-a.json', 'a@x.com');

      const { saveDrainOrderConfig, loadDrainOrderConfig } = await loadRegistry();
      const config = { mode: 'manual' as const, orderedIds: ['a@x.com'] };
      const saved = saveDrainOrderConfig('agy', config);
      expect(saved).toBe(true);

      const loaded = loadDrainOrderConfig('agy');
      expect(loaded?.mode).toBe('manual');
      expect(loaded?.orderedIds).toEqual(['a@x.com']);
    });
  });

  it('clearDrainOrderConfig removes persisted config', async () => {
    await withIsolatedHome(async (homeDir) => {
      const authDir = path.join(homeDir, '.ccs', 'cliproxy', 'auth');
      writeAuthFile(authDir, 'antigravity-a.json', { email: 'a@x.com', type: 'antigravity' });

      const { registerAccount } = await loadRegistry();
      registerAccount('agy', 'antigravity-a.json', 'a@x.com');

      const { saveDrainOrderConfig, loadDrainOrderConfig, clearDrainOrderConfig } =
        await loadRegistry();
      saveDrainOrderConfig('agy', { mode: 'tier' });
      const cleared = clearDrainOrderConfig('agy');
      expect(cleared).toBe(true);

      expect(loadDrainOrderConfig('agy')).toBeUndefined();
    });
  });

  it('returns false for saveDrainOrderConfig when provider not in registry', async () => {
    await withIsolatedHome(async (_homeDir) => {
      const { saveDrainOrderConfig } = await loadRegistry();
      // No accounts registered for 'gemini' -> returns false
      const result = saveDrainOrderConfig('gemini', { mode: 'tier' });
      expect(result).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Attribution stability: auth_index ordering survives priority rewrite
// ---------------------------------------------------------------------------

describe('attribution stability - auth_index unaffected by priority rewrite', () => {
  it('buildAuthIndexToAccountMap produces stable output regardless of priority values', async () => {
    // Simulate the auth files list returned by /v0/management/auth-files with various priorities.
    // auth_index is assigned by CLIProxy at load time based on file discovery order,
    // NOT by priority. So priority rewrites must not change auth_index values.
    const { buildAuthIndexToAccountMap } = await loadStatsTransformer();

    const authFilesBeforeRewrite = [
      { auth_index: 0, email: 'a@x.com', provider: 'antigravity' },
      { auth_index: 1, email: 'b@x.com', provider: 'antigravity' },
      { auth_index: 2, email: 'c@x.com', provider: 'antigravity' },
    ];

    const authFilesAfterRewrite = [
      // Priority changed but auth_index values are assigned by CLIProxy independently
      { auth_index: 0, email: 'a@x.com', provider: 'antigravity', priority: 3 },
      { auth_index: 1, email: 'b@x.com', provider: 'antigravity', priority: 2 },
      { auth_index: 2, email: 'c@x.com', provider: 'antigravity', priority: 1 },
    ];

    const mapBefore = buildAuthIndexToAccountMap(authFilesBeforeRewrite);
    const mapAfter = buildAuthIndexToAccountMap(authFilesAfterRewrite);

    // auth_index -> email mapping must be identical after priority rewrite
    expect(mapBefore.get('0')).toBe('a@x.com');
    expect(mapBefore.get('1')).toBe('b@x.com');
    expect(mapBefore.get('2')).toBe('c@x.com');

    expect(mapAfter.get('0')).toBe(mapBefore.get('0'));
    expect(mapAfter.get('1')).toBe(mapBefore.get('1'));
    expect(mapAfter.get('2')).toBe(mapBefore.get('2'));
  });

  it('buildAuthIndexToAccountMap skips entries without auth_index', async () => {
    const { buildAuthIndexToAccountMap } = await loadStatsTransformer();

    const authFiles = [
      { email: 'no-index@x.com', provider: 'antigravity' }, // no auth_index
      { auth_index: 5, email: 'has-index@x.com', provider: 'antigravity' },
    ];

    const map = buildAuthIndexToAccountMap(authFiles);
    expect(map.size).toBe(1);
    expect(map.get('5')).toBe('has-index@x.com');
    expect(map.has('undefined')).toBe(false);
  });

  it('buildAuthIndexToAccountMap handles both numeric and string auth_index keys', async () => {
    const { buildAuthIndexToAccountMap } = await loadStatsTransformer();

    const authFiles = [
      { auth_index: 0, email: 'numeric@x.com', provider: 'antigravity' },
      { auth_index: '1', email: 'string@x.com', provider: 'antigravity' },
    ];

    const map = buildAuthIndexToAccountMap(authFiles);
    // Both stored as String(auth_index)
    expect(map.get('0')).toBe('numeric@x.com');
    expect(map.get('1')).toBe('string@x.com');
  });
});
