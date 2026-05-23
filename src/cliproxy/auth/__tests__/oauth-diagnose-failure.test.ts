import { describe, expect, test } from 'bun:test';
import { OAUTH_CONFIGS } from '../auth-types';
import { diagnoseFailure, formatErrorMessage } from '../oauth-trace/diagnose-failure';
import { OAuthTracePhase, type OAuthTraceEvent } from '../oauth-trace/trace-events';

let tCounter = 1000;
function ev(phase: OAuthTracePhase, over: Partial<OAuthTraceEvent> = {}): OAuthTraceEvent {
  tCounter += 10;
  return {
    sessionId: 's',
    provider: 'codex',
    phase,
    ts: tCounter,
    elapsedMs: tCounter - 1000,
    ...over,
  };
}

function reset() {
  tCounter = 1000;
}

describe('diagnoseFailure', () => {
  test('empty snapshot -> UNKNOWN', () => {
    expect(diagnoseFailure([]).branchId).toBe('UNKNOWN');
  });

  test('URL_NOT_DISPLAYED when no AuthUrlDisplayed and exit=0', () => {
    reset();
    const snap = [
      ev(OAuthTracePhase.BinarySpawn),
      ev(OAuthTracePhase.BinaryExit, { data: { code: 0 } }),
    ];
    expect(diagnoseFailure(snap).branchId).toBe('URL_NOT_DISPLAYED');
  });

  test('BROWSER_NOT_OPENED after URL displayed past heuristic window', () => {
    reset();
    const snap: OAuthTraceEvent[] = [
      { ...ev(OAuthTracePhase.AuthUrlDisplayed), ts: 1000 },
      { ...ev(OAuthTracePhase.BinaryStdout), ts: 1000 + 6000 },
    ];
    expect(diagnoseFailure(snap).branchId).toBe('BROWSER_NOT_OPENED');
  });

  test('CALLBACK_NEVER_OBSERVED when browser opened, exit=0, no callback heuristic', () => {
    reset();
    const snap = [
      ev(OAuthTracePhase.AuthUrlDisplayed),
      ev(OAuthTracePhase.BrowserOpened),
      ev(OAuthTracePhase.BinaryExit, { data: { code: 0 } }),
    ];
    expect(diagnoseFailure(snap).branchId).toBe('CALLBACK_NEVER_OBSERVED');
  });

  test('BINARY_ERROR_EXIT when exit code non-zero', () => {
    reset();
    const snap = [
      ev(OAuthTracePhase.BinarySpawn),
      ev(OAuthTracePhase.BinaryExit, { data: { code: 2, stderrTail: 'oops' } }),
    ];
    const r = diagnoseFailure(snap);
    expect(r.branchId).toBe('BINARY_ERROR_EXIT');
    expect(r.data['code']).toBe(2);
  });

  test('TOKEN_FILE_MISSING_POST_EXIT when token-missing event present', () => {
    reset();
    const snap = [
      ev(OAuthTracePhase.AuthUrlDisplayed),
      ev(OAuthTracePhase.BrowserOpened),
      ev(OAuthTracePhase.CallbackObservedHeuristic),
      ev(OAuthTracePhase.BinaryExit, { data: { code: 0 } }),
      ev(OAuthTracePhase.TokenFileMissing),
    ];
    expect(diagnoseFailure(snap).branchId).toBe('TOKEN_FILE_MISSING_POST_EXIT');
  });

  test('TIMEOUT when timeout event present', () => {
    reset();
    const snap = [
      ev(OAuthTracePhase.BinarySpawn),
      ev(OAuthTracePhase.Timeout, { data: { timeoutMs: 120000 } }),
    ];
    const r = diagnoseFailure(snap);
    expect(r.branchId).toBe('TIMEOUT');
    expect(r.data['timeoutMs']).toBe(120000);
  });

  test('SESSION_CANCELLED on cancel event', () => {
    reset();
    const snap = [ev(OAuthTracePhase.Cancelled)];
    expect(diagnoseFailure(snap).branchId).toBe('SESSION_CANCELLED');
  });

  test('TOKEN_EXCHANGE_REJECTED via Error code=CALLBACK_REJECTED', () => {
    reset();
    const snap = [
      ev(OAuthTracePhase.PasteCallbackSubmitted),
      ev(OAuthTracePhase.Error, {
        error: { code: 'CALLBACK_REJECTED', message: 'invalid_grant' },
      }),
    ];
    const r = diagnoseFailure(snap);
    expect(r.branchId).toBe('TOKEN_EXCHANGE_REJECTED');
    expect(r.data['upstreamError']).toBe('invalid_grant');
  });

  test('PASTE_INVALID from invalid event', () => {
    reset();
    const snap = [
      ev(OAuthTracePhase.PasteCallbackPrompted),
      ev(OAuthTracePhase.PasteCallbackInvalid, { data: { reason: 'missing_code' } }),
    ];
    const r = diagnoseFailure(snap);
    expect(r.branchId).toBe('PASTE_INVALID');
    expect(r.data['reason']).toBe('missing_code');
  });

  test('GEMINI_PLUS_MISSING_CRED from explicit error', () => {
    reset();
    const snap = [
      ev(OAuthTracePhase.Error, {
        error: { code: 'GEMINI_PLUS_MISSING_CRED', message: 'missing' },
      }),
    ];
    expect(diagnoseFailure(snap).branchId).toBe('GEMINI_PLUS_MISSING_CRED');
  });

  test('AGY_RESPONSIBILITY_DECLINED from explicit error', () => {
    reset();
    const snap = [
      ev(OAuthTracePhase.Error, {
        error: { code: 'AGY_RESPONSIBILITY_DECLINED', message: 'declined' },
      }),
    ];
    expect(diagnoseFailure(snap).branchId).toBe('AGY_RESPONSIBILITY_DECLINED');
  });

  test('diagnose is pure: same input -> same output, no side-effects', () => {
    reset();
    const snap = [ev(OAuthTracePhase.BinarySpawn), ev(OAuthTracePhase.Timeout)];
    const a = diagnoseFailure(snap);
    const b = diagnoseFailure(snap);
    expect(a).toEqual(b);
    // ensure snapshot wasn't mutated
    expect(snap).toHaveLength(2);
  });
});

describe('formatErrorMessage', () => {
  const baseOpts = {
    verbose: false,
    platform: 'linux' as NodeJS.Platform,
    callbackPort: 1455,
    provider: 'codex',
  };

  test('UNKNOWN preserves backward-compat 3-bullet feel and ends with verbose hint', () => {
    const lines = formatErrorMessage({ branchId: 'UNKNOWN', data: {} }, baseOpts);
    expect(lines.some((l) => l.includes('Token not found'))).toBe(true);
    expect(lines.some((l) => l.startsWith('Try: ccs codex --auth --verbose'))).toBe(true);
    // body lines (excluding trailing remediation) ≤ 5 -> not exploding
    expect(lines.length).toBeLessThanOrEqual(6);
  });

  test('CALLBACK_NEVER_OBSERVED includes paste-callback hint with provider', () => {
    const lines = formatErrorMessage({ branchId: 'CALLBACK_NEVER_OBSERVED', data: {} }, baseOpts);
    expect(lines.some((l) => l.includes('--no-browser'))).toBe(true);
  });

  test('CALLBACK_NEVER_OBSERVED on win32 appends netsh hint', () => {
    const lines = formatErrorMessage(
      { branchId: 'CALLBACK_NEVER_OBSERVED', data: {} },
      { ...baseOpts, platform: 'win32' }
    );
    expect(lines.some((l) => l.includes('netsh advfirewall'))).toBe(true);
  });

  test('contains no emoji and no sensitive keys', () => {
    const lines = formatErrorMessage(
      { branchId: 'BINARY_ERROR_EXIT', data: { code: 7, stderrTail: 'fail' } },
      baseOpts
    );
    const blob = lines.join('\n');
    // No common emoji ranges
    expect(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(blob)).toBe(false);
    expect(blob).not.toMatch(/access_token|refresh_token|id_token|client_secret/i);
  });

  test('verbose mode appends trace hint line', () => {
    const lines = formatErrorMessage(
      { branchId: 'UNKNOWN', data: {} },
      { ...baseOpts, verbose: true }
    );
    expect(lines.some((l) => l.includes('--verbose'))).toBe(true);
  });
});

describe('cross-profile OAuth failure matrix', () => {
  const providers = Object.keys(OAUTH_CONFIGS);
  const matrix = [
    {
      name: 'url-not-displayed',
      expectedBranch: 'URL_NOT_DISPLAYED',
      snapshot: () => [
        ev(OAuthTracePhase.BinarySpawn),
        ev(OAuthTracePhase.BinaryExit, { data: { code: 0 } }),
      ],
      hint: '--verbose',
    },
    {
      name: 'callback-not-observed',
      expectedBranch: 'CALLBACK_NEVER_OBSERVED',
      snapshot: () => [
        ev(OAuthTracePhase.AuthUrlDisplayed),
        ev(OAuthTracePhase.BrowserOpened),
        ev(OAuthTracePhase.BinaryExit, { data: { code: 0 } }),
      ],
      hint: '--no-browser',
    },
    {
      name: 'binary-error',
      expectedBranch: 'BINARY_ERROR_EXIT',
      snapshot: () => [
        ev(OAuthTracePhase.BinarySpawn),
        ev(OAuthTracePhase.BinaryExit, { data: { code: 2, stderrTail: 'boom' } }),
      ],
      hint: '--verbose',
    },
    {
      name: 'token-exchange-error',
      expectedBranch: 'TOKEN_EXCHANGE_REJECTED',
      snapshot: () => [
        ev(OAuthTracePhase.PasteCallbackSubmitted),
        ev(OAuthTracePhase.Error, {
          error: { code: 'CALLBACK_REJECTED', message: 'invalid_grant' },
        }),
      ],
      hint: '--verbose',
    },
    {
      name: 'session-expired',
      expectedBranch: 'TIMEOUT',
      snapshot: () => [
        ev(OAuthTracePhase.PasteCallbackPrompted),
        ev(OAuthTracePhase.Timeout, { data: { timeoutMs: 600000 } }),
      ],
      hint: '--auth',
    },
    {
      name: 'token-file-missing',
      expectedBranch: 'TOKEN_FILE_MISSING_POST_EXIT',
      snapshot: () => [
        ev(OAuthTracePhase.AuthUrlDisplayed),
        ev(OAuthTracePhase.BrowserOpened),
        ev(OAuthTracePhase.CallbackObservedHeuristic),
        ev(OAuthTracePhase.BinaryExit, { data: { code: 0 } }),
        ev(OAuthTracePhase.TokenFileMissing),
      ],
      hint: 'ccs update',
    },
  ] as const;

  test.each(providers.flatMap((provider) => matrix.map((scenario) => ({ provider, scenario }))))(
    '$provider $scenario.name emits branch identifier and remediation hint',
    ({ provider, scenario }) => {
      reset();
      const diagnosis = diagnoseFailure(scenario.snapshot());
      expect(diagnosis.branchId).toBe(scenario.expectedBranch);

      const message = formatErrorMessage(diagnosis, {
        verbose: false,
        platform: 'linux',
        callbackPort: 1455,
        provider,
      }).join('\n');
      expect(message).toContain(scenario.hint);
      expect(message.includes(`ccs ${provider}`) || message.includes('ccs update')).toBe(true);
    }
  );
});
