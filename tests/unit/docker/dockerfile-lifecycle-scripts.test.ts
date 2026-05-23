import { readFileSync } from 'fs';
import { describe, expect, it } from 'bun:test';

const dockerfile = readFileSync('docker/Dockerfile', 'utf8');
const entrypoint = readFileSync('docker/entrypoint.sh', 'utf8');

describe('legacy Dockerfile lifecycle scripts', () => {
  it('skips package lifecycle scripts for every CCS install during image build', () => {
    const ccsInstallCommands = dockerfile
      .split('\n')
      .filter((line) => line.includes('npm install') && line.includes('@kaitranntt/ccs'));

    expect(ccsInstallCommands.length).toBeGreaterThan(0);
    for (const command of ccsInstallCommands) {
      expect(command).toContain('--ignore-scripts');
    }
  });

  it('creates the runtime CCS home directory from the entrypoint instead', () => {
    expect(entrypoint).toContain('ccs_home_dir="${CCS_HOME_DIR:-/home/node/.ccs}"');
    expect(entrypoint).toContain('mkdir -p "$ccs_home_dir"');
  });
});
