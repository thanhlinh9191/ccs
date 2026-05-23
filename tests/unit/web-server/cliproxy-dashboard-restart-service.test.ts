import { describe, expect, it } from 'bun:test';

import {
  restartDashboardCliproxy,
  type CliproxyDashboardRestartDeps,
} from '../../../src/web-server/services/cliproxy-dashboard-restart-service';

function createDeps(overrides: Partial<CliproxyDashboardRestartDeps> = {}) {
  const calls: string[] = [];
  const deps: CliproxyDashboardRestartDeps = {
    resolveLifecyclePortFn: () => 8317,
    isRunningUnderSupervisordFn: () => false,
    restartCliproxyViaSupervisordFn: () => {
      calls.push('supervisor-restart');
      return { success: true, port: 8317 };
    },
    waitForProxyHealthyFn: async () => {
      calls.push('wait-healthy');
      return true;
    },
    stopProxyFn: async () => {
      calls.push('stop');
      return { stopped: true, port: 8317, pid: 1234, sessionCount: 1 };
    },
    ensureCliproxyServiceFn: async () => {
      calls.push('start');
      return { started: true, alreadyRunning: false, port: 8317 };
    },
    delayFn: async () => {
      calls.push('delay');
    },
    ...overrides,
  };

  return { calls, deps };
}

describe('cliproxy dashboard restart service', () => {
  it('performs a local restart as stop then start, not stop only', async () => {
    const { calls, deps } = createDeps();

    const result = await restartDashboardCliproxy(deps);

    expect(result).toEqual({ success: true, port: 8317 });
    expect(calls).toEqual(['stop', 'delay', 'start']);
  });

  it('starts a local instance even when stop finds no active session', async () => {
    const { calls, deps } = createDeps({
      stopProxyFn: async () => {
        calls.push('stop');
        return { stopped: false, port: 8317, error: 'No active CLIProxy session found' };
      },
    });

    const result = await restartDashboardCliproxy(deps);

    expect(result).toEqual({ success: true, port: 8317 });
    expect(calls).toEqual(['stop', 'delay', 'start']);
  });

  it('returns failure when local restart cannot start after stopping', async () => {
    const { calls, deps } = createDeps({
      ensureCliproxyServiceFn: async () => {
        calls.push('start');
        return { started: false, alreadyRunning: false, port: 8317, error: 'port blocked' };
      },
    });

    const result = await restartDashboardCliproxy(deps);

    expect(result).toEqual({ success: false, error: 'port blocked' });
    expect(calls).toEqual(['stop', 'delay', 'start']);
  });

  it('waits for Docker supervisor restart to become healthy before reporting success', async () => {
    const { calls, deps } = createDeps({
      isRunningUnderSupervisordFn: () => true,
    });

    const result = await restartDashboardCliproxy(deps);

    expect(result).toEqual({ success: true, port: 8317 });
    expect(calls).toEqual(['supervisor-restart', 'wait-healthy']);
  });

  it('reports Docker supervisor restart as failed when the proxy never becomes healthy', async () => {
    const { calls, deps } = createDeps({
      isRunningUnderSupervisordFn: () => true,
      waitForProxyHealthyFn: async () => {
        calls.push('wait-healthy');
        return false;
      },
    });

    const result = await restartDashboardCliproxy(deps);

    expect(result).toEqual({
      success: false,
      error: 'CLIProxy did not become healthy after supervisor restart',
    });
    expect(calls).toEqual(['supervisor-restart', 'wait-healthy']);
  });
});
