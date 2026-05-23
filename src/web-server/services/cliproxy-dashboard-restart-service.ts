import { resolveLifecyclePort } from '../../cliproxy/config/port-manager';
import { ensureCliproxyService, type ServiceStartResult } from '../../cliproxy/service-manager';
import { waitForProxyHealthy } from '../../cliproxy/proxy/proxy-detector';
import { stopProxy } from '../../cliproxy/session-tracker';
import {
  isRunningUnderSupervisord,
  restartCliproxyViaSupervisord,
} from '../../docker/supervisord-lifecycle';

export interface CliproxyDashboardRestartResult {
  success: boolean;
  port?: number;
  error?: string;
}

export interface CliproxyDashboardRestartDeps {
  resolveLifecyclePortFn?: typeof resolveLifecyclePort;
  isRunningUnderSupervisordFn?: typeof isRunningUnderSupervisord;
  restartCliproxyViaSupervisordFn?: typeof restartCliproxyViaSupervisord;
  waitForProxyHealthyFn?: typeof waitForProxyHealthy;
  stopProxyFn?: typeof stopProxy;
  ensureCliproxyServiceFn?: typeof ensureCliproxyService;
  delayFn?: (ms: number) => Promise<void>;
}

const RESTART_SETTLE_MS = 500;
const SUPERVISOR_HEALTH_TIMEOUT_MS = 10_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startResultToRestartResult(
  startResult: ServiceStartResult
): CliproxyDashboardRestartResult {
  if (startResult.started || startResult.alreadyRunning) {
    return { success: true, port: startResult.port };
  }

  return { success: false, error: startResult.error || 'Failed to start proxy' };
}

export async function restartDashboardCliproxy(
  deps: CliproxyDashboardRestartDeps = {}
): Promise<CliproxyDashboardRestartResult> {
  const resolveLifecyclePortFn = deps.resolveLifecyclePortFn ?? resolveLifecyclePort;
  const isRunningUnderSupervisordFn = deps.isRunningUnderSupervisordFn ?? isRunningUnderSupervisord;
  const restartCliproxyViaSupervisordFn =
    deps.restartCliproxyViaSupervisordFn ?? restartCliproxyViaSupervisord;
  const waitForProxyHealthyFn = deps.waitForProxyHealthyFn ?? waitForProxyHealthy;
  const stopProxyFn = deps.stopProxyFn ?? stopProxy;
  const ensureCliproxyServiceFn = deps.ensureCliproxyServiceFn ?? ensureCliproxyService;
  const delayFn = deps.delayFn ?? delay;

  const port = resolveLifecyclePortFn();

  if (isRunningUnderSupervisordFn()) {
    const supervisorResult = restartCliproxyViaSupervisordFn();
    if (!supervisorResult.success) {
      return supervisorResult;
    }

    const healthy = await waitForProxyHealthyFn(port, SUPERVISOR_HEALTH_TIMEOUT_MS);
    if (!healthy) {
      return {
        success: false,
        error: 'CLIProxy did not become healthy after supervisor restart',
      };
    }

    return { success: true, port: supervisorResult.port ?? port };
  }

  await stopProxyFn(port);
  await delayFn(RESTART_SETTLE_MS);

  const startResult = await ensureCliproxyServiceFn(port);
  return startResultToRestartResult(startResult);
}
