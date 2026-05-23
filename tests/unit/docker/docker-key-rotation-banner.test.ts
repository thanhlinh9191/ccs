import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'bun:test';
import { ensureDockerCliproxyAuth } from '../../../src/docker/docker-bootstrap';
import { mutateConfig } from '../../../src/config/config-loader-facade';
import { CCS_INTERNAL_API_KEY } from '../../../src/cliproxy/config/config-generator';
import {
  maskDockerApiKey,
  readDockerBootstrapState,
  renderDockerKeyRotationBanner,
} from '../../../src/docker/docker-key-rotation';

const originalCcsHome = process.env.CCS_HOME;
const tempDirs: string[] = [];

function useTempCcsHome(): void {
  const dir = mkdtempSync(join(tmpdir(), 'ccs-rotation-banner-'));
  tempDirs.push(dir);
  process.env.CCS_HOME = dir;
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

describe('renderDockerKeyRotationBanner - key masking', () => {
  it('does not leak the full replacement API key into the banner', () => {
    useTempCcsHome();
    mutateConfig((config) => {
      config.cliproxy.auth = { api_key: CCS_INTERNAL_API_KEY };
    });
    ensureDockerCliproxyAuth();

    const replacementKey = readDockerBootstrapState().state?.legacyKeyGrace?.replacementKey;
    expect(replacementKey).toBeTruthy();

    const banner = renderDockerKeyRotationBanner();
    expect(banner).not.toBe('');
    expect(banner).not.toContain(replacementKey ?? '');
  });

  it('shows the masked replacement key in the banner', () => {
    useTempCcsHome();
    mutateConfig((config) => {
      config.cliproxy.auth = { api_key: CCS_INTERNAL_API_KEY };
    });
    ensureDockerCliproxyAuth();

    const replacementKey = readDockerBootstrapState().state?.legacyKeyGrace?.replacementKey;
    const masked = maskDockerApiKey(replacementKey);
    expect(masked).toBeTruthy();

    const banner = renderDockerKeyRotationBanner();
    expect(banner).toContain(masked!);
  });

  it('points at `ccs docker show-key --full` to reveal the key', () => {
    useTempCcsHome();
    mutateConfig((config) => {
      config.cliproxy.auth = { api_key: CCS_INTERNAL_API_KEY };
    });
    ensureDockerCliproxyAuth();

    const banner = renderDockerKeyRotationBanner();
    expect(banner).toContain('ccs docker show-key --full');
  });

  it('still shows the legacy key value (it is the public-known default, not a secret)', () => {
    useTempCcsHome();
    mutateConfig((config) => {
      config.cliproxy.auth = { api_key: CCS_INTERNAL_API_KEY };
    });
    ensureDockerCliproxyAuth();

    const banner = renderDockerKeyRotationBanner();
    expect(banner).toContain(CCS_INTERNAL_API_KEY);
  });

  it('returns empty when grace is not active', () => {
    useTempCcsHome();
    const banner = renderDockerKeyRotationBanner();
    expect(banner).toBe('');
  });
});
