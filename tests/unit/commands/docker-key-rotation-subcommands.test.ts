import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  renderCapturedLines,
  useDockerSubcommandConsoleCapture,
} from './docker-subcommand-test-helpers';
import { ensureDockerCliproxyAuth } from '../../../src/docker/docker-bootstrap';
import { mutateConfig } from '../../../src/config/config-loader-facade';
import {
  CCS_INTERNAL_API_KEY,
  regenerateConfig,
} from '../../../src/cliproxy/config/config-generator';
import { CLIPROXY_DEFAULT_PORT } from '../../../src/cliproxy/config/port-manager';
import { readDockerBootstrapState } from '../../../src/docker/docker-key-rotation';

const capture = useDockerSubcommandConsoleCapture();
const originalCcsHome = process.env.CCS_HOME;
const tempDirs: string[] = [];

function useTempCcsHome(): void {
  const dir = mkdtempSync(join(tmpdir(), 'ccs-docker-key-command-'));
  tempDirs.push(dir);
  process.env.CCS_HOME = dir;
}

async function loadHandleShowKey() {
  const mod = await import(
    `../../../src/commands/docker/show-key-subcommand?test=${Date.now()}-${Math.random()}`
  );
  return mod.handleShowKey;
}

async function loadHandleFinalizeKeyRotation() {
  const mod = await import(
    `../../../src/commands/docker/finalize-key-rotation-subcommand?test=${Date.now()}-${Math.random()}`
  );
  return mod.handleFinalizeKeyRotation;
}

afterEach(() => {
  if (originalCcsHome === undefined) {
    delete process.env.CCS_HOME;
  } else {
    process.env.CCS_HOME = originalCcsHome;
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('docker key rotation subcommands', () => {
  it('shows the Docker API key masked by default and full with --full', async () => {
    useTempCcsHome();
    mutateConfig((config) => {
      config.cliproxy.auth = { api_key: CCS_INTERNAL_API_KEY };
    });
    ensureDockerCliproxyAuth();
    const replacementKey = readDockerBootstrapState().state?.legacyKeyGrace?.replacementKey;

    const handleShowKey = await loadHandleShowKey();
    await handleShowKey(['--container-scope']);
    const maskedOutput = renderCapturedLines(capture.logLines);
    capture.logLines.length = 0;
    await handleShowKey(['--container-scope', '--full']);
    const fullOutput = renderCapturedLines(capture.logLines);

    expect(replacementKey).toBeTruthy();
    expect(maskedOutput).toContain('API key:');
    expect(maskedOutput).not.toContain(replacementKey ?? '');
    expect(fullOutput).toContain(`API key: ${replacementKey}`);
    expect(fullOutput).toContain('Legacy key expires:');
  });

  it('finalizes active legacy-key grace immediately', async () => {
    useTempCcsHome();
    mutateConfig((config) => {
      config.cliproxy.auth = { api_key: CCS_INTERNAL_API_KEY };
    });
    ensureDockerCliproxyAuth();
    const configPath = regenerateConfig(CLIPROXY_DEFAULT_PORT);

    const handleFinalize = await loadHandleFinalizeKeyRotation();
    await handleFinalize(['--container-scope']);

    const state = readDockerBootstrapState().state;
    const content = readFileSync(configPath, 'utf8');
    expect(state?.legacyKeyGrace?.finalizedAt).toBeTruthy();
    expect(content).not.toContain(`"${CCS_INTERNAL_API_KEY}"`);
    expect(renderCapturedLines(capture.logLines)).toContain(
      'Docker CLIProxy legacy API key grace period finalized.'
    );
  });
});
