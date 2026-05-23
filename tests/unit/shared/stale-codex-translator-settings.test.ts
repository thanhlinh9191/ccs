import { describe, expect, it } from 'bun:test';

import { findCodexTranslatorUrlPaths } from '../../../src/shared/stale-codex-translator-settings';

describe('stale Codex translator settings scanner', () => {
  it('reports nested object and array paths without returning sensitive values', () => {
    const settings = {
      env: {
        SAFE_VALUE: 'keep-me',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317/api/provider/codex',
      },
      hooks: {
        PostToolUse: [
          {
            matcher: 'Read',
            config: {
              headers: {
                Authorization: 'Bearer secret',
              },
              endpoint: 'https://proxy.example.com/api/provider/codex/v1/messages',
            },
          },
        ],
      },
      'custom-key': ['https://proxy.example.com/api/provider/codex'],
    };

    expect(findCodexTranslatorUrlPaths(settings)).toEqual([
      'env.ANTHROPIC_BASE_URL',
      'hooks.PostToolUse[0].config.endpoint',
      '["custom-key"][0]',
    ]);
  });
});
