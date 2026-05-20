/**
 * CLIProxy provider, backend, and routing types
 */

/** Supported CLIProxy providers */
export type CLIProxyProvider =
  | 'gemini'
  | 'codex'
  | 'agy'
  | 'qwen'
  | 'iflow'
  | 'kiro'
  | 'ghcp'
  | 'claude'
  | 'kimi'
  | 'cursor'
  | 'gitlab'
  | 'codebuddy'
  | 'kilo'
  | 'qoder';

/** CLIProxy backend selection */
export type CLIProxyBackend = 'original' | 'plus';

/** Credential routing strategy for matching CLIProxy accounts */
export type CliproxyRoutingStrategy = 'round-robin' | 'fill-first';

/** Providers that require CLIProxyAPIPlus backend */
export const PLUS_ONLY_PROVIDERS: CLIProxyProvider[] = [
  'kiro',
  'ghcp',
  'cursor',
  'gitlab',
  'codebuddy',
  'kilo',
  'qoder',
];

/** Model mapping for each provider */
export interface ProviderModelMapping {
  defaultModel: string;
  claudeModel: string;
  opusModel?: string;
  sonnetModel?: string;
  haikuModel?: string;
}

/** Provider configuration */
export interface ProviderConfig {
  name: CLIProxyProvider;
  displayName: string;
  models: ProviderModelMapping;
  requiresOAuth: boolean;
}
