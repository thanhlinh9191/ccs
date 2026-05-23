import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { getCompletionSuggestions } from '../../../src/commands/completion-backend';

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalCcsHome = process.env.CCS_HOME;
let tempHome = '';

function suggestionValues(
  tokensBeforeCurrent: string[],
  current = '',
  shell: 'bash' | 'fish' | 'powershell' | 'zsh' = 'bash'
): string[] {
  return getCompletionSuggestions({ tokensBeforeCurrent, current, shell }).map(
    (entry) => entry.value
  );
}

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-completion-'));
  fs.mkdirSync(path.join(tempHome, '.ccs'), { recursive: true });
  fs.writeFileSync(
    path.join(tempHome, '.ccs', 'config.json'),
    JSON.stringify(
      {
        profiles: {
          localglm: '~/.ccs/localglm.settings.json',
        },
        cliproxy: {
          'my-codex': {
            provider: 'codex',
            settings: '~/.ccs/my-codex.settings.json',
          },
        },
      },
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(tempHome, '.ccs', 'profiles.json'),
    JSON.stringify(
      {
        profiles: {
          work: { type: 'account', created: '2026-04-02T00:00:00.000Z' },
        },
        default: 'work',
      },
      null,
      2
    )
  );

  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  process.env.CCS_HOME = tempHome;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  if (originalCcsHome === undefined) delete process.env.CCS_HOME;
  else process.env.CCS_HOME = originalCcsHome;

  fs.rmSync(tempHome, { recursive: true, force: true });
});

describe('completion backend', () => {
  test('includes current root commands and dynamic profiles at the top level', () => {
    const values = suggestionValues([]);

    expect(values).toContain('config');
    expect(values).toContain('docker');
    expect(values).toContain('tokens');
    expect(values).toContain('migrate');
    expect(values).toContain('cursor');
    expect(values).toContain('copilot');
    expect(values).toContain('gemini');
    expect(values).toContain('gitlab');
    expect(values).toContain('codebuddy');
    expect(values).toContain('kilo');
    expect(values).toContain('localglm');
    expect(values).toContain('work');
    expect(values).toContain('my-codex');
    expect(values).not.toContain('__complete');
    expect(values).not.toContain('--install');
    expect(values).not.toContain('--uninstall');
  });

  test('suggests help topics from the help command', () => {
    const values = suggestionValues(['help']);
    expect(values).toContain('profiles');
    expect(values).toContain('providers');
    expect(values).toContain('completion');
    expect(values).toContain('targets');
    expect(values).not.toContain('api');
    expect(values).not.toContain('__complete');
  });

  test('suggests lifecycle subcommands for api', () => {
    const values = suggestionValues(['api']);
    expect(values).toEqual(
      expect.arrayContaining(['create', 'discover', 'copy', 'export', 'import', 'remove'])
    );
  });

  test('suggests account profiles for auth show', () => {
    const values = suggestionValues(['auth', 'show']);
    expect(values).toContain('work');
    expect(values).toContain('--json');
  });

  test('suggests default lane and account profiles for auth backup', () => {
    const values = suggestionValues(['auth', 'backup']);
    expect(values).toContain('default');
    expect(values).toContain('work');
    expect(values).toContain('--json');
  });

  test('suggests cliproxy variants for variant-scoped commands', () => {
    const values = suggestionValues(['cliproxy', 'edit']);
    expect(values).toContain('my-codex');
  });

  test('suggests the correct routing affinity completion shape', () => {
    expect(suggestionValues(['cliproxy', 'routing'])).toEqual(
      expect.arrayContaining(['set', 'explain', 'affinity'])
    );
    expect(suggestionValues(['cliproxy', 'routing', 'affinity'])).toEqual(
      expect.arrayContaining(['on', 'off'])
    );
    expect(suggestionValues(['cliproxy', 'routing', 'affinity', 'on'])).toEqual(
      expect.arrayContaining(['--ttl'])
    );
    expect(suggestionValues(['cliproxy', 'routing', 'affinity', 'off'])).toEqual(
      expect.arrayContaining(['--ttl'])
    );
    expect(suggestionValues(['cliproxy', 'routing', 'affinity', '--ttl'])).not.toContain('--ttl');
  });

  test('suggests env format values after the format flag', () => {
    const values = suggestionValues(['env', '--format']);
    expect(values).toEqual(
      expect.arrayContaining(['openai', 'anthropic', 'raw', 'claude-extension'])
    );
  });

  test('includes live doctor and cliproxy flags from the shared catalog', () => {
    expect(suggestionValues(['doctor'])).toEqual(expect.arrayContaining(['--fix', '-f']));
    expect(suggestionValues(['cliproxy'])).toEqual(expect.arrayContaining(['remove', '--backend']));
    expect(suggestionValues(['docker'])).toEqual(
      expect.arrayContaining(['show-key', 'finalize-key-rotation'])
    );
    expect(suggestionValues(['docker', 'show-key'])).toEqual(expect.arrayContaining(['--full']));
  });

  test('suggests browser subcommands and fix/setup flags', () => {
    expect(suggestionValues(['browser'])).toEqual(
      expect.arrayContaining(['setup', 'status', 'doctor', 'policy', 'enable', 'disable'])
    );
    expect(suggestionValues(['browser', 'setup'])).toEqual(expect.arrayContaining(['--help', '-h']));
    expect(suggestionValues(['browser', 'doctor'])).toEqual(
      expect.arrayContaining(['--help', '-h'])
    );
    expect(suggestionValues(['browser', 'enable'])).toEqual(
      expect.arrayContaining(['claude', 'codex', 'all'])
    );
    expect(suggestionValues(['browser', 'policy'])).toEqual(
      expect.arrayContaining(['--all', '--claude', '--codex'])
    );
    expect(suggestionValues(['browser', 'policy', '--all'])).toEqual(
      expect.arrayContaining(['auto', 'manual'])
    );
    expect(suggestionValues(['codex'])).toEqual(
      expect.arrayContaining(['--browser', '--no-browser'])
    );
  });

  test('treats cursor as a provider shortcut in completion', () => {
    const values = suggestionValues(['cursor']);
    expect(values).toEqual(
      expect.arrayContaining(['--auth', '--accounts', '--config', '--logout'])
    );
    expect(values).not.toContain('probe');
    expect(values).not.toContain('start');
  });

  test('filters suggestions by the current token prefix', () => {
    const values = suggestionValues([], 'do');
    expect(values).toEqual(expect.arrayContaining(['docker', 'doctor']));
    expect(values).not.toContain('tokens');
  });
});
