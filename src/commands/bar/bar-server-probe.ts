/**
 * CCS Bar — server liveness probe utilities.
 *
 * Shared by launch-subcommand.ts and serve-subcommand.ts so neither imports
 * from the other (which would create a cross-module dependency that breaks
 * Bun's test module isolation when cache-busting URLs are used).
 */

import * as fs from 'fs';
import * as path from 'path';

export interface DashboardInfo {
  port: number;
  baseUrl: string;
}

/**
 * Read the port recorded in an existing bar.json.
 * Returns null when the file is absent or malformed.
 */
export function resolveBarPort(ccsDir: string): number | null {
  const barJsonPath = path.join(ccsDir, 'bar.json');
  try {
    const raw = fs.readFileSync(barJsonPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<{ port: number }>;
    return typeof parsed.port === 'number' ? parsed.port : null;
  } catch {
    return null;
  }
}

/**
 * Probe candidate ports for a running CCS server.
 *
 * Both IPv4 (127.0.0.1) and IPv6 (::1) loopback addresses are probed for each
 * port. All probes are fired concurrently so worst-case latency is ~1.5 s
 * (one timeout) rather than N × 1.5 s sequentially. Priority selection is
 * applied after all results are in: the bar.json port is preferred over the
 * defaults, and within a port 127.0.0.1 is preferred over [::1].
 */
export async function defaultFindRunningServer(ccsDir: string): Promise<DashboardInfo | null> {
  const { request } = await import('undici');

  async function probe(url: string): Promise<{ ok: boolean }> {
    try {
      const { statusCode, body } = await request(url, {
        method: 'GET',
        headersTimeout: 1500,
        bodyTimeout: 1500,
      });
      await body.text();
      return { ok: statusCode === 200 };
    } catch {
      return { ok: false };
    }
  }

  const barJsonPort = resolveBarPort(ccsDir);
  const base = [3000, 3001, 3002, 8000, 8080];
  const candidates: number[] =
    barJsonPort !== null ? [barJsonPort, ...base.filter((p) => p !== barJsonPort)] : base;

  const probeTargets = candidates.flatMap((port) => [
    { port, baseUrl: `http://127.0.0.1:${port}`, url: `http://127.0.0.1:${port}/api/bar/summary` },
    { port, baseUrl: `http://[::1]:${port}`, url: `http://[::1]:${port}/api/bar/summary` },
  ]);

  const results = await Promise.all(probeTargets.map((t) => probe(t.url)));

  for (let i = 0; i < probeTargets.length; i++) {
    if (results[i].ok) {
      const { port, baseUrl } = probeTargets[i];
      return { port, baseUrl };
    }
  }
  return null;
}
