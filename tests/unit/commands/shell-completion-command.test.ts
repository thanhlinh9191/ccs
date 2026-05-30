import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect, beforeAll, beforeEach, afterEach, mock } from 'bun:test';

type ShellTarget = 'bash' | 'zsh' | 'fish' | 'powershell' | null;

interface InstallResult {
  success: boolean;
  alreadyInstalled?: boolean;
  message?: string;
  reload?: string;
}

interface InstallCall {
  shell: ShellTarget;
  options: { force: boolean };
}

const installCalls: InstallCall[] = [];
let installResult: InstallResult = {
  success: true,
  message: 'Added to ~/.zshrc',
  reload: 'source ~/.zshrc',
};
let installError: Error | null = null;

mock.module('../../../src/utils/shell-completion', () => ({
  ShellCompletionInstaller: class {
    install(shell: ShellTarget, options: { force: boolean }): InstallResult {
      installCalls.push({ shell, options });
      if (installError) {
        throw installError;
      }
      return installResult;
    }
  },
}));

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

let handleShellCompletionCommand: (args: string[]) => Promise<void>;
let parseShellCompletionArgs: (args: string[]) => { targetShell: ShellTarget; force: boolean };
let originalConsoleLog: typeof console.log;
let originalConsoleError: typeof console.error;
let originalProcessExit: typeof process.exit;
let logLines: string[] = [];
let errorLines: string[] = [];

beforeAll(async () => {
  const mod = await import('../../../src/commands/shell-completion-command');
  handleShellCompletionCommand = mod.handleShellCompletionCommand;
  parseShellCompletionArgs = mod.parseShellCompletionArgs;
});

beforeEach(() => {
  installCalls.length = 0;
  installError = null;
  installResult = {
    success: true,
    message: 'Added to ~/.zshrc',
    reload: 'source ~/.zshrc',
  };

  logLines = [];
  errorLines = [];

  originalConsoleLog = console.log;
  originalConsoleError = console.error;
  originalProcessExit = process.exit;

  console.log = (...args: unknown[]) => {
    logLines.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    errorLines.push(args.map(String).join(' '));
  };
  process.exit = ((code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as typeof process.exit;
});

afterEach(() => {
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
  process.exit = originalProcessExit;
});

describe('shell-completion command', () => {
  it('parses shell flags and force flag', () => {
    const parsed = parseShellCompletionArgs(['--zsh', '--force']);
    expect(parsed).toEqual({ targetShell: 'zsh', force: true });
  });

  it('preserves existing priority when multiple shell flags are present', () => {
    const parsed = parseShellCompletionArgs(['--zsh', '--bash']);
    expect(parsed).toEqual({ targetShell: 'bash', force: false });
  });

  it('executes installer with parsed args and renders success output', async () => {
    await handleShellCompletionCommand(['--zsh', '--force']);

    expect(installCalls).toHaveLength(1);
    expect(installCalls[0]).toEqual({
      shell: 'zsh',
      options: { force: true },
    });

    expect(logLines.some((line) => line.includes('Shell completion installed successfully!'))).toBe(
      true
    );
    expect(logLines.some((line) => line.includes('source ~/.zshrc'))).toBe(true);
  });

  it('renders already-installed output without forcing reinstall', async () => {
    installResult = {
      success: true,
      alreadyInstalled: true,
      message: 'Updated completion files',
      reload: 'source ~/.zshrc',
    };

    await handleShellCompletionCommand(['--zsh']);

    const plainLogLines = logLines.map(stripAnsi);
    expect(plainLogLines.some((line) => line.includes('Shell completion already installed'))).toBe(
      true
    );
    expect(plainLogLines.some((line) => line.includes('Use --force to reinstall'))).toBe(true);
    expect(plainLogLines.some((line) => line.includes('installed successfully!'))).toBe(false);
  });

  it('prints usage and exits with code 1 on installer error', async () => {
    installError = new Error('boom');

    await expect(handleShellCompletionCommand([])).rejects.toThrow('process.exit(1)');
    const plainErrorLines = errorLines.map(stripAnsi);
    expect(plainErrorLines.some((line) => line.includes('Error: boom'))).toBe(true);
    expect(plainErrorLines.some((line) => line.includes('ccs --shell-completion --zsh'))).toBe(
      true
    );
  });

  it('completion adapters only delegate to the ccs command on PATH', () => {
    const completionScripts = [
      '../../../scripts/completion/ccs.bash',
      '../../../scripts/completion/ccs.zsh',
      '../../../scripts/completion/ccs.fish',
      '../../../scripts/completion/ccs.ps1',
    ];

    for (const scriptPath of completionScripts) {
      const script = readFileSync(join(import.meta.dir, scriptPath), 'utf8');

      expect(script).not.toContain('../..');
      expect(script).not.toContain('repo_root');
      expect(script).not.toContain('repoRoot');
      expect(script).not.toContain('repo_cli');
      expect(script).not.toContain('repoCli');
      expect(script).not.toContain('node ');
      expect(script).not.toContain('& node');
    }
  });

  it('fish completion strips a duplicated partial token before delegating to __complete', () => {
    const fishScript = readFileSync(
      join(import.meta.dir, '../../../scripts/completion/ccs.fish'),
      'utf8'
    );

    expect(fishScript).toContain('set -l current (commandline -ct)');
    expect(fishScript).toContain('test "$tokens_before_current[-1]" = "$current"');
    expect(fishScript).toContain('set -e tokens_before_current[-1]');
  });
});
