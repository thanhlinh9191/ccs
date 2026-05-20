import { describe, expect, test } from 'bun:test';

import {
  handleHelpCommand,
  handleHelpRoute,
  getRootHelpVisibleCommands,
} from '../../../src/commands/help-command';

function stripAnsi(input: string): string {
  return input.replace(/\u001b\[[0-9;]*m/g, '');
}

async function renderLines(
  render: (writeLine: (line: string) => void) => Promise<void>
): Promise<string> {
  const lines: string[] = [];
  await render((line) => lines.push(line));
  return stripAnsi(lines.join('\n'));
}

describe('help command parity', () => {
  test('root help stays within the compact line budget', async () => {
    const rendered = await renderLines((writeLine) => handleHelpCommand(writeLine));
    const visibleLines = rendered.split('\n').filter((line) => line.trim().length > 0);

    expect(visibleLines.length).toBeLessThanOrEqual(90);
    expect(rendered.includes('ccs help <topic>')).toBe(true);
    expect(rendered.includes('ccs help browser')).toBe(true);
    expect(rendered.includes('ccs help completion')).toBe(true);
  });

  test('root help covers every public root command once the catalog is updated', async () => {
    const rendered = await renderLines((writeLine) => handleHelpCommand(writeLine));

    for (const command of getRootHelpVisibleCommands()) {
      expect(rendered.includes(command)).toBe(true);
    }
  });

  test('root help no longer markets deprecated glmt directly', async () => {
    const rendered = await renderLines((writeLine) => handleHelpCommand(writeLine));
    expect(rendered.includes('ccs glmt')).toBe(false);
  });

  test('root help documents native Claude session effort override', async () => {
    const rendered = await renderLines((writeLine) => handleHelpCommand(writeLine));

    expect(rendered.includes('ccs --effort high "debug this"')).toBe(true);
    expect(rendered.includes('Use a native Claude effort override for one session')).toBe(true);
  });

  test('providers topic lists built-in OAuth provider shortcuts', async () => {
    const rendered = await renderLines((writeLine) => handleHelpRoute(['providers'], writeLine));

    expect(rendered.includes('Built-in OAuth Providers')).toBe(true);
    expect(rendered.includes('ccs cliproxy --help')).toBe(true);
    expect(rendered.includes('ccs help kiro')).toBe(true);
    expect(rendered.includes('gemini')).toBe(true);
    expect(rendered.includes('codex')).toBe(true);
    expect(rendered.includes('ghcp')).toBe(true);
    expect(rendered.includes('gitlab')).toBe(true);
    expect(rendered.includes('codebuddy')).toBe(true);
    expect(rendered.includes('kilo')).toBe(true);
    expect(rendered.includes('qoder')).toBe(true);
    expect(rendered.includes('--gitlab-token-login')).toBe(true);
    expect(rendered.includes('--token-login')).toBe(true);
    expect(rendered.includes('--gitlab-url <url>')).toBe(true);
  });

  test('kiro topic documents IDC and callback flags', async () => {
    const rendered = await renderLines((writeLine) => handleHelpRoute(['kiro'], writeLine));

    expect(rendered.includes('CCS Kiro Help')).toBe(true);
    expect(rendered.includes('--kiro-idc-start-url <url>')).toBe(true);
    expect(rendered.includes('--kiro-idc-region <region>')).toBe(true);
    expect(rendered.includes('--kiro-idc-flow <authcode|device>')).toBe(true);
    expect(rendered.includes('--paste-callback')).toBe(true);
    expect(rendered.includes('GitHub OAuth is dashboard-only')).toBe(true);
  });

  test('browser topic explains Claude attach versus Codex browser tools', async () => {
    const rendered = await renderLines((writeLine) => handleHelpRoute(['browser'], writeLine));

    expect(rendered.includes('CCS Browser Help')).toBe(true);
    expect(rendered.includes('Claude Browser Attach reuses a local Chrome session')).toBe(true);
    expect(rendered.includes('Codex Browser Tools inject managed Playwright MCP overrides')).toBe(
      true
    );
    expect(rendered.includes('ccs browser setup')).toBe(true);
    expect(rendered.includes('ccs browser status')).toBe(true);
    expect(rendered.includes('ccs browser doctor')).toBe(true);
    expect(rendered.includes('ccs browser policy')).toBe(true);
    expect(rendered.includes('--browser')).toBe(true);
  });

  test('completion topic documents install and verification paths', async () => {
    const rendered = await renderLines((writeLine) => handleHelpRoute(['completion'], writeLine));

    expect(rendered.includes('ccs --shell-completion')).toBe(true);
    expect(rendered.includes('ccs help <TAB>')).toBe(true);
    expect(rendered.includes('--force')).toBe(true);
  });

  test('api topic delegates to command-specific help', async () => {
    const rendered = await renderLines((writeLine) => handleHelpRoute(['api'], writeLine));

    expect(rendered.includes('CCS API Management')).toBe(true);
    expect(rendered.includes('ccs api create --preset anthropic --1m')).toBe(true);
    expect(rendered.includes('ccs api discover --register')).toBe(true);
  });

  test('unknown help target shows an actionable fallback', async () => {
    const rendered = await renderLines((writeLine) => handleHelpRoute(['unknown-topic'], writeLine));

    expect(rendered.includes('Unknown help topic or command: unknown-topic')).toBe(true);
    expect(rendered.includes('Available help topics:')).toBe(true);
    process.exitCode = 0;
  });
});
