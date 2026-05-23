import { describe, expect, it } from 'bun:test';
import {
  renderCapturedLines,
  useDockerSubcommandConsoleCapture,
} from './docker-subcommand-test-helpers';

const capture = useDockerSubcommandConsoleCapture();

async function loadHandleUp() {
  const mod = await import(
    `../../../src/commands/docker/up-subcommand?test=${Date.now()}-${Math.random()}`
  );
  return mod.handleUp;
}

describe('docker up subcommand', () => {
  it('prints the success summary with the requested host and port mappings', async () => {
    const calls: Array<{ host?: string; port: number; proxyPort: number }> = [];
    const dockerModule = (await import(
      '../../../src/docker'
    )) as typeof import('../../../src/docker');
    const originalUp = dockerModule.DockerExecutor.prototype.up;
    const originalGetKeyRotationBanner = dockerModule.DockerExecutor.prototype.getKeyRotationBanner;
    dockerModule.DockerExecutor.prototype.up = function (options: {
      host?: string;
      port: number;
      proxyPort: number;
    }) {
      calls.push(options);
    };
    dockerModule.DockerExecutor.prototype.getKeyRotationBanner = function () {
      return [
        '[!] Docker CLIProxy API key rotation grace period is active.',
        '[i] New CLIProxy API key: new-...cret',
        '[i] Legacy key ccs-internal-managed remains valid until 2026-06-05T00:00:00.000Z.',
        '[i] Reveal the full key with `ccs docker show-key --full`.',
      ].join('\n');
    };

    try {
      const handleUp = await loadHandleUp();
      await handleUp(['--host', 'docker-box', '--port', '4000', '--proxy-port', '9317']);

      const rendered = renderCapturedLines(capture.logLines);
      expect(calls).toEqual([{ host: 'docker-box', port: 4000, proxyPort: 9317 }]);
      expect(rendered).toContain('Starting integrated Docker stack on docker-box');
      expect(rendered).toContain('Docker stack is running on docker-box.');
      expect(rendered).toContain('Dashboard port: 4000');
      expect(rendered).toContain('CLIProxy port: 9317');
      expect(rendered).toContain('Full remote management requires dashboard auth');
      expect(rendered).toContain('Without it, remote access stays read-only.');
      expect(renderCapturedLines(capture.errorLines)).toContain(
        'Docker CLIProxy API key rotation grace period is active'
      );
      expect(renderCapturedLines(capture.errorLines)).toContain('New CLIProxy API key: new-...cret');
      expect(renderCapturedLines(capture.errorLines)).toContain('ccs docker show-key --full');
      expect(process.exitCode).toBe(0);
    } finally {
      dockerModule.DockerExecutor.prototype.up = originalUp;
      dockerModule.DockerExecutor.prototype.getKeyRotationBanner = originalGetKeyRotationBanner;
    }
  });

  it('renders boxed validation errors without invoking the executor', async () => {
    const handleUp = await loadHandleUp();
    await handleUp(['--port', '70000']);

    const rendered = renderCapturedLines(capture.errorLines);
    expect(rendered).toContain('Invalid value for --port');
    expect(process.exitCode).toBe(1);
  });
});
