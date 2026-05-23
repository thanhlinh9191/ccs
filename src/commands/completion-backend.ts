import ProfileDetector from '../auth/profile-detector';
import {
  API_SUBCOMMANDS,
  AUTH_SUBCOMMANDS,
  BUILTIN_PROVIDER_SHORTCUTS,
  CLEANUP_FLAGS,
  COMMAND_FLAG_SUGGESTIONS,
  CONFIG_SUBCOMMANDS,
  COPILOT_COMPLETION_SUBCOMMANDS,
  DOCKER_SUBCOMMANDS,
  ROOT_COMMAND_FLAGS,
  ROOT_HELP_TOPICS,
  TOKENS_FLAGS,
  PROXY_SUBCOMMANDS,
  PROVIDER_FLAGS,
  uniqueStrings,
  getPublicRootCommandTokens,
  CLIPROXY_SUBCOMMANDS,
  MIGRATE_FLAGS,
  CURSOR_COMPLETION_SUBCOMMANDS,
} from './command-catalog';

export interface CompletionSuggestion {
  value: string;
  description?: string;
}

type CompletionShell = 'bash' | 'zsh' | 'fish' | 'powershell';

interface CompletionRequest {
  current: string;
  shell: CompletionShell;
  tokensBeforeCurrent: string[];
}

function suggestion(value: string, description?: string): CompletionSuggestion {
  return { value, description };
}

function filterSuggestions(
  suggestions: readonly CompletionSuggestion[],
  current: string
): CompletionSuggestion[] {
  const needle = current.trim().toLowerCase();
  const deduped = [...new Map(suggestions.map((entry) => [entry.value, entry])).values()];
  if (!needle) return deduped.sort((left, right) => left.value.localeCompare(right.value));
  return deduped
    .filter((entry) => entry.value.toLowerCase().startsWith(needle))
    .sort((left, right) => left.value.localeCompare(right.value));
}

function getDynamicProfileSuggestions(): CompletionSuggestion[] {
  const detector = new ProfileDetector();
  const profiles = detector.getAllProfiles();

  return uniqueStrings([
    ...profiles.settings,
    ...profiles.accounts,
    ...profiles.cliproxyVariants,
  ]).map((value) => suggestion(value));
}

function getTopLevelSuggestions(): CompletionSuggestion[] {
  return [
    ...getPublicRootCommandTokens().map((value) => suggestion(value)),
    ...ROOT_COMMAND_FLAGS.map((value) => suggestion(value)),
    ...BUILTIN_PROVIDER_SHORTCUTS.map((entry) => suggestion(entry.name, entry.summary)),
    ...getDynamicProfileSuggestions(),
  ];
}

function getProfileDetector(): ProfileDetector {
  return new ProfileDetector();
}

function getProfileNames(type: 'settings' | 'accounts' | 'cliproxyVariants'): string[] {
  return getProfileDetector().getAllProfiles()[type];
}

function completeSubcommands(
  values: readonly string[],
  flags: readonly string[] = ['--help', '-h']
): CompletionSuggestion[] {
  return uniqueStrings([...values, ...flags]).map((value) => suggestion(value));
}

function completeBrowserPolicyArgs(tokensBeforeCurrent: string[]): CompletionSuggestion[] {
  const lastToken = tokensBeforeCurrent[tokensBeforeCurrent.length - 1];
  if (lastToken === '--all' || lastToken === '--claude' || lastToken === '--codex') {
    return completeSubcommands(['auto', 'manual'], ['--help', '-h']);
  }

  return completeSubcommands(['--all', '--claude', '--codex'], ['--help', '-h']);
}

function getSuggestionsForCommand(tokensBeforeCurrent: string[]): CompletionSuggestion[] {
  const [command, subcommand] = tokensBeforeCurrent;
  const lastToken = tokensBeforeCurrent[tokensBeforeCurrent.length - 1];

  switch (command) {
    case undefined:
      return getTopLevelSuggestions();
    case 'help':
      return completeSubcommands(ROOT_HELP_TOPICS.map((topic) => topic.name));
    case 'auth':
      if (!subcommand) return completeSubcommands(AUTH_SUBCOMMANDS);
      if (subcommand === 'backup')
        return completeSubcommands(['default', ...getProfileNames('accounts')], ['--json']);
      if (subcommand === 'show')
        return completeSubcommands(getProfileNames('accounts'), ['--json']);
      if (subcommand === 'resources')
        return completeSubcommands(getProfileNames('accounts'), [
          '--mode',
          '--mode=shared',
          '--mode=profile-local',
          '--json',
        ]);
      if (subcommand === 'remove')
        return completeSubcommands(getProfileNames('accounts'), ['--yes', '-y']);
      if (subcommand === 'default') return completeSubcommands(getProfileNames('accounts'));
      if (subcommand === 'create') {
        return completeSubcommands(
          [],
          ['--force', '--share-context', '--context-group', '--deeper-continuity', '--bare']
        );
      }
      if (subcommand === 'list') return completeSubcommands([], ['--verbose', '--json']);
      return completeSubcommands([], COMMAND_FLAG_SUGGESTIONS.auth);
    case 'api':
      if (!subcommand) return completeSubcommands(API_SUBCOMMANDS);
      if (subcommand === 'create') {
        return completeSubcommands(
          [],
          [
            '--preset',
            '--cliproxy-provider',
            '--base-url',
            '--api-key',
            '--model',
            '--1m',
            '--no-1m',
            '--target',
            '--force',
            '--yes',
            '-y',
          ]
        );
      }
      if (subcommand === 'discover')
        return completeSubcommands([], ['--register', '--json', '--force']);
      if (subcommand === 'copy')
        return completeSubcommands(getProfileNames('settings'), [
          '--target',
          '--force',
          '--yes',
          '-y',
        ]);
      if (subcommand === 'export')
        return completeSubcommands(getProfileNames('settings'), ['--out', '--include-secrets']);
      if (subcommand === 'import')
        return completeSubcommands([], ['--name', '--yes', '-y', '--force']);
      if (subcommand === 'remove')
        return completeSubcommands(getProfileNames('settings'), ['--yes', '-y']);
      return completeSubcommands([], COMMAND_FLAG_SUGGESTIONS.api);
    case 'cliproxy':
      if (!subcommand)
        return completeSubcommands(CLIPROXY_SUBCOMMANDS, [
          '--install',
          '--latest',
          '--update',
          '--backend',
          '--verbose',
          '-v',
          '--help',
          '-h',
        ]);
      if (subcommand === 'routing') {
        const routingSubcommand = tokensBeforeCurrent[2];
        const routingAffinityMode = tokensBeforeCurrent[3];
        if (lastToken === 'set') {
          return completeSubcommands(['round-robin', 'fill-first']);
        }
        if (routingSubcommand === 'affinity') {
          if (!routingAffinityMode || lastToken === 'affinity') {
            return completeSubcommands(['on', 'off']);
          }
          if (
            (routingAffinityMode === 'on' || routingAffinityMode === 'off') &&
            !tokensBeforeCurrent.includes('--ttl')
          ) {
            return completeSubcommands([], ['--ttl']);
          }
          if (lastToken === '--ttl') {
            return [];
          }
          return completeSubcommands([]);
        }
        return completeSubcommands(['set', 'explain', 'affinity']);
      }
      if (['remove', 'edit'].includes(subcommand)) {
        return completeSubcommands(getProfileNames('cliproxyVariants'), ['--yes', '-y']);
      }
      if (subcommand === 'create' && lastToken === '--provider') {
        return BUILTIN_PROVIDER_SHORTCUTS.map((entry) => suggestion(entry.name, entry.summary));
      }
      return completeSubcommands(
        [],
        ['--provider', '--model', '--target', '--backend', '--force', '--yes', '-y', '--help', '-h']
      );
    case 'config':
      if (!subcommand || subcommand.startsWith('-')) {
        return completeSubcommands(CONFIG_SUBCOMMANDS, COMMAND_FLAG_SUGGESTIONS.config);
      }
      return [];
    case 'docker':
      if (!subcommand || subcommand.startsWith('-')) {
        return completeSubcommands(DOCKER_SUBCOMMANDS, COMMAND_FLAG_SUGGESTIONS.docker);
      }
      if (subcommand === 'up')
        return completeSubcommands([], ['--port', '--proxy-port', '--host', '--help', '-h']);
      if (subcommand === 'logs')
        return completeSubcommands([], ['--follow', '--service', '--host', '--help', '-h']);
      if (subcommand === 'show-key')
        return completeSubcommands([], ['--full', '--host', '--help', '-h']);
      return completeSubcommands([], COMMAND_FLAG_SUGGESTIONS.docker);
    case 'browser':
      if (!subcommand || subcommand.startsWith('-')) {
        return completeSubcommands(
          ['setup', 'status', 'doctor', 'policy', 'enable', 'disable'],
          ['--help', '-h']
        );
      }
      if (subcommand === 'enable' || subcommand === 'disable') {
        return completeSubcommands(['claude', 'codex', 'all'], ['--help', '-h']);
      }
      if (subcommand === 'policy') {
        return completeBrowserPolicyArgs(tokensBeforeCurrent);
      }
      if (subcommand === 'setup' || subcommand === 'doctor') {
        return completeSubcommands([], ['--help', '-h']);
      }
      return completeSubcommands([], ['--help', '-h']);
    case 'cursor':
      return completeSubcommands(CURSOR_COMPLETION_SUBCOMMANDS);
    case 'proxy':
      if (lastToken === '--shell')
        return completeSubcommands(['auto', 'bash', 'zsh', 'fish', 'powershell']);
      return completeSubcommands(
        [...PROXY_SUBCOMMANDS],
        ['--port', '--shell', '--insecure', '--help', '-h']
      );
    case 'copilot':
      return completeSubcommands(COPILOT_COMPLETION_SUBCOMMANDS);
    case 'env':
      if (lastToken === '--format')
        return completeSubcommands(['openai', 'anthropic', 'raw', 'claude-extension']);
      if (lastToken === '--shell')
        return completeSubcommands(['auto', 'bash', 'zsh', 'fish', 'powershell']);
      if (lastToken === '--ide') return completeSubcommands(['vscode', 'cursor', 'windsurf']);
      return completeSubcommands(
        uniqueStrings([
          ...getProfileNames('settings'),
          ...getProfileNames('accounts'),
          ...BUILTIN_PROVIDER_SHORTCUTS.map((entry) => entry.name),
        ]),
        COMMAND_FLAG_SUGGESTIONS.env
      );
    case 'tokens':
      if (lastToken === '--variant')
        return completeSubcommands(getProfileNames('cliproxyVariants'));
      return completeSubcommands([], TOKENS_FLAGS);
    case 'migrate':
      return completeSubcommands([], MIGRATE_FLAGS);
    case 'cleanup':
      return completeSubcommands([], CLEANUP_FLAGS);
    case '--shell-completion':
    case '-sc':
      return completeSubcommands(
        [],
        ['--bash', '--zsh', '--fish', '--powershell', '--force', '-f']
      );
    default:
      if (BUILTIN_PROVIDER_SHORTCUTS.some((entry) => entry.name === command)) {
        if (command === 'agy')
          return completeSubcommands([], [...PROVIDER_FLAGS, '--accept-agr-risk']);
        if (command === 'kiro') {
          return completeSubcommands(
            [],
            [
              ...PROVIDER_FLAGS,
              '--kiro-auth-method',
              '--kiro-idc-start-url',
              '--kiro-idc-region',
              '--kiro-idc-flow',
              '--import',
              '--incognito',
            ]
          );
        }
        return completeSubcommands([], PROVIDER_FLAGS);
      }
      return completeSubcommands([], COMMAND_FLAG_SUGGESTIONS[command] || []);
  }
}

export function getCompletionSuggestions(request: CompletionRequest): CompletionSuggestion[] {
  return filterSuggestions(getSuggestionsForCommand(request.tokensBeforeCurrent), request.current);
}

function parseCompletionArgs(args: string[]): CompletionRequest {
  const shellIndex = args.indexOf('--shell');
  const currentIndex = args.indexOf('--current');
  const separatorIndex = args.indexOf('--');
  const shell = (shellIndex !== -1 ? args[shellIndex + 1] : 'bash') as CompletionShell;
  const current = currentIndex !== -1 ? args[currentIndex + 1] || '' : '';
  const tokensBeforeCurrent = separatorIndex === -1 ? [] : args.slice(separatorIndex + 1);
  return { shell, current, tokensBeforeCurrent };
}

function formatForShell(
  shell: CompletionShell,
  suggestions: readonly CompletionSuggestion[]
): string[] {
  if (shell === 'fish' || shell === 'powershell') {
    return suggestions.map((entry) =>
      entry.description ? `${entry.value}\t${entry.description}` : entry.value
    );
  }
  return suggestions.map((entry) => entry.value);
}

export async function handleCompletionCommand(args: string[]): Promise<void> {
  try {
    const request = parseCompletionArgs(args);
    const suggestions = getCompletionSuggestions(request);
    process.stdout.write(formatForShell(request.shell, suggestions).join('\n'));
  } catch {
    // Completion must fail closed and quietly so shell TAB does not surface stack traces.
  }
}
