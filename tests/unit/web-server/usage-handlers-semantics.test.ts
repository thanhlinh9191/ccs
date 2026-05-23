import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type HandlersModule = typeof import('../../../src/web-server/usage/handlers');
type AggregatorModule = typeof import('../../../src/web-server/usage/aggregator');

interface AssistantFixture {
  project: string;
  sessionId: string;
  timestamp: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}

interface MockResponse {
  payload: unknown;
  statusCode: number;
  status: (code: number) => MockResponse;
  json: (body: unknown) => MockResponse;
}

let tempHome = '';
let claudeDir = '';
let codexDir = '';
let handlers: HandlersModule;
let aggregator: AggregatorModule;
let originalCcsHome: string | undefined;
let originalClaudeConfigDir: string | undefined;
let originalCodexHome: string | undefined;

function writeUnifiedConfigFixture(): void {
  const yaml = `version: 2
accounts: {}
profiles: {}
preferences:
  theme: system
  telemetry: false
  auto_update: true
cliproxy:
  oauth_accounts: {}
  providers:
    - gemini
    - codex
    - agy
  variants: {}
cliproxy_server:
  local:
    port: 65534
`;

  fs.mkdirSync(path.join(tempHome, '.ccs'), { recursive: true });
  fs.writeFileSync(path.join(tempHome, '.ccs', 'config.yaml'), yaml, 'utf-8');
}

function writeAssistantEntries(entries: AssistantFixture[]): void {
  writeAssistantEntriesToDir(claudeDir, entries);
}

function writeAssistantEntriesToDir(baseClaudeDir: string, entries: AssistantFixture[]): void {
  for (const entry of entries) {
    const projectDir = path.join(baseClaudeDir, 'projects', entry.project);
    fs.mkdirSync(projectDir, { recursive: true });

    const line = JSON.stringify({
      type: 'assistant',
      sessionId: entry.sessionId,
      timestamp: entry.timestamp,
      version: '1.0.0',
      cwd: `/tmp/${entry.project}`,
      message: {
        model: entry.model,
        usage: {
          input_tokens: entry.inputTokens ?? 0,
          output_tokens: entry.outputTokens ?? 0,
          cache_creation_input_tokens: entry.cacheCreationTokens ?? 0,
          cache_read_input_tokens: entry.cacheReadTokens ?? 0,
        },
      },
    });

    fs.writeFileSync(
      path.join(projectDir, `${entry.sessionId}.jsonl`),
      `${line}\n`,
      'utf-8'
    );
  }
}

function createMockResponse(): MockResponse {
  return {
    payload: undefined,
    statusCode: 200,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.payload = body;
      return this;
    },
  };
}

beforeEach(async () => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-usage-handlers-'));
  claudeDir = path.join(tempHome, '.claude');
  codexDir = path.join(tempHome, '.codex');

  originalCcsHome = process.env.CCS_HOME;
  originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  originalCodexHome = process.env.CODEX_HOME;
  process.env.CCS_HOME = tempHome;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  process.env.CODEX_HOME = codexDir;

  writeUnifiedConfigFixture();

  handlers = await import('../../../src/web-server/usage/handlers');
  aggregator = await import('../../../src/web-server/usage/aggregator');
  aggregator.shutdownUsageAggregator();
  aggregator.clearUsageCache();
});

afterEach(() => {
  aggregator.shutdownUsageAggregator();
  aggregator.clearUsageCache();

  if (originalCcsHome !== undefined) {
    process.env.CCS_HOME = originalCcsHome;
  } else {
    delete process.env.CCS_HOME;
  }

  if (originalClaudeConfigDir !== undefined) {
    process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  } else {
    delete process.env.CLAUDE_CONFIG_DIR;
  }

  if (originalCodexHome !== undefined) {
    process.env.CODEX_HOME = originalCodexHome;
  } else {
    delete process.env.CODEX_HOME;
  }

  fs.rmSync(tempHome, { recursive: true, force: true });
});

describe('usage handlers semantics', () => {
  it('includes cache tokens in summary totals and uses calendar-day averages', async () => {
    writeAssistantEntries([
      {
        project: 'project-one',
        sessionId: 'session-a',
        timestamp: '2026-03-02T10:00:00.000Z',
        model: 'claude-sonnet-4-5',
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheCreationTokens: 100_000,
        cacheReadTokens: 200_000,
      },
    ]);

    const res = createMockResponse();
    await handlers.handleSummary(
      { query: { since: '20260301', until: '20260303' } } as never,
      res as never
    );

    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({
      success: true,
      data: {
        totalTokens: 1_400_000,
        totalCacheTokens: 300_000,
        totalDays: 3,
        activeDays: 1,
        averageTokensPerDay: 466_667,
        averageTokensPerActiveDay: 1_400_000,
        averageCostPerDay: 1.65,
        averageCostPerActiveDay: 4.93,
      },
    });
  });

  it('counts hourly requests from raw entries instead of distinct models', async () => {
    writeAssistantEntries([
      {
        project: 'project-one',
        sessionId: 'session-a',
        timestamp: '2026-03-02T10:05:00.000Z',
        model: 'claude-sonnet-4-5',
        inputTokens: 100,
        outputTokens: 10,
      },
      {
        project: 'project-two',
        sessionId: 'session-b',
        timestamp: '2026-03-02T10:15:00.000Z',
        model: 'claude-sonnet-4-5',
        inputTokens: 120,
        outputTokens: 15,
      },
      {
        project: 'project-three',
        sessionId: 'session-c',
        timestamp: '2026-03-02T10:30:00.000Z',
        model: 'gemini-2.5-pro',
        inputTokens: 80,
        outputTokens: 20,
      },
    ]);

    const res = createMockResponse();
    await handlers.handleHourly(
      { query: { since: '20260302', until: '20260302' } } as never,
      res as never
    );

    const payload = res.payload as { success: boolean; data: Array<{ hour: string; requests: number }> };
    const targetHour = payload.data.find((row) => row.hour === '2026-03-02 10:00');

    expect(targetHour?.requests).toBe(3);
  });

  it('uses overlapping months for monthly filtering', async () => {
    writeAssistantEntries([
      {
        project: 'march-project',
        sessionId: 'session-march',
        timestamp: '2026-03-20T10:00:00.000Z',
        model: 'claude-sonnet-4-5',
        inputTokens: 100,
        outputTokens: 10,
      },
      {
        project: 'april-project',
        sessionId: 'session-april',
        timestamp: '2026-04-05T10:00:00.000Z',
        model: 'claude-sonnet-4-5',
        inputTokens: 200,
        outputTokens: 20,
      },
    ]);

    const res = createMockResponse();
    await handlers.handleMonthly(
      { query: { since: '20260315', until: '20260410' } } as never,
      res as never
    );

    expect(res.payload).toMatchObject({
      success: true,
      data: [
        expect.objectContaining({ month: '2026-03' }),
        expect.objectContaining({ month: '2026-04' }),
      ],
    });
  });

  it('reports actual cache size after warming the usage cache', async () => {
    writeAssistantEntries([
      {
        project: 'project-one',
        sessionId: 'session-a',
        timestamp: '2026-03-02T10:00:00.000Z',
        model: 'claude-sonnet-4-5',
        inputTokens: 100,
        outputTokens: 10,
      },
    ]);

    await aggregator.getCachedDailyData();

    const res = createMockResponse();
    handlers.handleStatus({} as never, res as never);

    const payload = res.payload as {
      success: boolean;
      data: { lastFetch: number | null; cacheSize: unknown };
    };
    expect(payload.success).toBe(true);
    expect(payload.data.lastFetch).not.toBeNull();
    expect(payload.data.cacheSize).toBe(aggregator.getUsageCacheSize());
    expect(aggregator.getUsageCacheSize()).toBeGreaterThan(0);
  });

  it('includes cache-only model activity in model token percentages', async () => {
    writeAssistantEntries([
      {
        project: 'project-one',
        sessionId: 'session-a',
        timestamp: '2026-03-02T10:00:00.000Z',
        model: 'claude-sonnet-4-5',
        inputTokens: 100,
        outputTokens: 0,
      },
      {
        project: 'project-two',
        sessionId: 'session-b',
        timestamp: '2026-03-02T11:00:00.000Z',
        model: 'gemini-2.5-pro',
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 100,
      },
    ]);

    const res = createMockResponse();
    await handlers.handleModels(
      { query: { since: '20260302', until: '20260302' } } as never,
      res as never
    );

    expect(res.payload).toMatchObject({
      success: true,
      data: expect.arrayContaining([
        expect.objectContaining({ model: 'claude-sonnet-4-5', tokens: 100, percentage: 50 }),
        expect.objectContaining({ model: 'gemini-2.5-pro', tokens: 100, percentage: 50 }),
      ]),
    });
  });

  it('filters summary totals to the selected stable account profile', async () => {
    writeAssistantEntries([
      {
        project: 'default-project',
        sessionId: 'session-default',
        timestamp: '2026-03-02T10:00:00.000Z',
        model: 'claude-sonnet-4-5',
        inputTokens: 100,
        outputTokens: 10,
      },
    ]);
    writeAssistantEntriesToDir(path.join(tempHome, '.ccs', 'instances', 'work'), [
      {
        project: 'work-project',
        sessionId: 'session-work',
        timestamp: '2026-03-02T11:00:00.000Z',
        model: 'claude-sonnet-4-5',
        inputTokens: 300,
        outputTokens: 30,
      },
    ]);

    const allProfilesRes = createMockResponse();
    await handlers.handleSummary(
      { query: { since: '20260302', until: '20260302' } } as never,
      allProfilesRes as never
    );

    expect(allProfilesRes.payload).toMatchObject({
      success: true,
      data: {
        totalInputTokens: 400,
        totalOutputTokens: 40,
      },
    });

    aggregator.clearUsageCache();
    const workProfileRes = createMockResponse();
    await handlers.handleSummary(
      { query: { since: '20260302', until: '20260302', profile: 'work' } } as never,
      workProfileRes as never
    );

    expect(workProfileRes.payload).toMatchObject({
      success: true,
      data: {
        totalInputTokens: 300,
        totalOutputTokens: 30,
      },
    });
  });

  it('filters sessions to the default profile without including account sessions', async () => {
    writeAssistantEntries([
      {
        project: 'default-project',
        sessionId: 'session-default',
        timestamp: '2026-03-02T10:00:00.000Z',
        model: 'claude-sonnet-4-5',
        inputTokens: 100,
        outputTokens: 10,
      },
    ]);
    writeAssistantEntriesToDir(path.join(tempHome, '.ccs', 'instances', 'work'), [
      {
        project: 'work-project',
        sessionId: 'session-work',
        timestamp: '2026-03-02T11:00:00.000Z',
        model: 'claude-sonnet-4-5',
        inputTokens: 300,
        outputTokens: 30,
      },
    ]);

    const res = createMockResponse();
    await handlers.handleSessions(
      { query: { since: '20260302', until: '20260302', profile: 'default' } } as never,
      res as never
    );

    expect(res.payload).toMatchObject({
      success: true,
      data: {
        total: 1,
        sessions: [expect.objectContaining({ sessionId: 'session-default' })],
      },
    });
  });

  it('rejects reversed date ranges before computing summary totals', async () => {
    const res = createMockResponse();

    await handlers.handleSummary(
      { query: { since: '20260410', until: '20260401' } } as never,
      res as never
    );

    expect(res.statusCode).toBe(400);
    expect(res.payload).toMatchObject({
      success: false,
      error: 'The "since" date must be earlier than or equal to "until"',
    });
  });
});
