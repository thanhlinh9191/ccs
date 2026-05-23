import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tempDir: string;
let profileDir: string;
let sharedCodexHome: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-resources-test-'));
  profileDir = path.join(tempDir, 'profile');
  sharedCodexHome = path.join(tempDir, 'shared-codex');
  fs.mkdirSync(path.join(sharedCodexHome, 'agents'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(sharedCodexHome, 'agents', 'brainstormer.toml'),
    'name = "brainstormer"\n'
  );
  fs.mkdirSync(path.join(sharedCodexHome, 'skills'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(sharedCodexHome, 'skills', 'review.md'), '# Review\n');
});

afterEach(() => {
  mock.restore();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('ensureCodexProfileResources', () => {
  it('links shared agents and skills into a fresh Codex profile', async () => {
    const { ensureCodexProfileResources } = await import(
      '../../../src/codex-auth/codex-profile-resources'
    );

    ensureCodexProfileResources(profileDir, { sharedCodexHome });

    for (const resourceName of ['agents', 'skills']) {
      const resourcePath = path.join(profileDir, resourceName);
      expect(fs.lstatSync(resourcePath).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(resourcePath)).toBe(path.join(sharedCodexHome, resourceName));
    }
  });

  it('repairs a missing resource link without changing existing shared files', async () => {
    const { ensureCodexProfileResources } = await import(
      '../../../src/codex-auth/codex-profile-resources'
    );

    ensureCodexProfileResources(profileDir, { sharedCodexHome });
    fs.unlinkSync(path.join(profileDir, 'agents'));

    ensureCodexProfileResources(profileDir, { sharedCodexHome });

    const agentsPath = path.join(profileDir, 'agents');
    expect(fs.lstatSync(agentsPath).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(agentsPath, 'brainstormer.toml'))).toBe(true);
  });

  it('is idempotent for repeated repair calls', async () => {
    const { ensureCodexProfileResources } = await import(
      '../../../src/codex-auth/codex-profile-resources'
    );

    ensureCodexProfileResources(profileDir, { sharedCodexHome });
    const firstTarget = fs.readlinkSync(path.join(profileDir, 'agents'));

    ensureCodexProfileResources(profileDir, { sharedCodexHome });

    expect(fs.readlinkSync(path.join(profileDir, 'agents'))).toBe(firstTarget);
    expect(fs.readFileSync(path.join(profileDir, 'agents', 'brainstormer.toml'), 'utf8')).toContain(
      'brainstormer'
    );
  });

  it('copies missing resource files into an existing profile-local directory', async () => {
    const { ensureCodexProfileResources } = await import(
      '../../../src/codex-auth/codex-profile-resources'
    );
    const agentsPath = path.join(profileDir, 'agents');
    fs.mkdirSync(agentsPath, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(agentsPath, 'local.toml'), 'name = "local"\n');

    ensureCodexProfileResources(profileDir, { sharedCodexHome });

    expect(fs.lstatSync(agentsPath).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(agentsPath, 'local.toml'))).toBe(true);
    expect(fs.existsSync(path.join(agentsPath, 'brainstormer.toml'))).toBe(true);
  });

  it('falls back to copying resources when directory symlinks are unavailable', async () => {
    const { ensureCodexProfileResources } = await import(
      '../../../src/codex-auth/codex-profile-resources'
    );
    const symlinkSpy = spyOn(fs, 'symlinkSync').mockImplementation(() => {
      throw Object.assign(new Error('simulated symlink failure'), { code: 'EPERM' });
    });
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;

    try {
      ensureCodexProfileResources(profileDir, { sharedCodexHome });
    } finally {
      process.stderr.write = origWrite;
      symlinkSpy.mockRestore();
    }

    const agentsPath = path.join(profileDir, 'agents');
    expect(fs.lstatSync(agentsPath).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(agentsPath, 'brainstormer.toml'))).toBe(true);
  });
});
