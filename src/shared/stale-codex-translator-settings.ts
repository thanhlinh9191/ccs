export const CODEX_TRANSLATOR_URL_MARKER = '/api/provider/codex';

function formatSettingsPathSegment(basePath: string, segment: string | number): string {
  if (typeof segment === 'number') {
    return `${basePath}[${segment}]`;
  }

  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)) {
    return basePath ? `${basePath}.${segment}` : segment;
  }

  return `${basePath}[${JSON.stringify(segment)}]`;
}

export function findCodexTranslatorUrlPaths(value: unknown, path = ''): string[] {
  if (typeof value === 'string') {
    return value.includes(CODEX_TRANSLATOR_URL_MARKER) ? [path || '(root)'] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      findCodexTranslatorUrlPaths(item, formatSettingsPathSegment(path, index))
    );
  }

  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, item]) =>
      findCodexTranslatorUrlPaths(item, formatSettingsPathSegment(path, key))
    );
  }

  return [];
}

export function formatSettingsPathList(paths: string[]): string {
  const visiblePaths = paths.slice(0, 5);
  const remainingCount = paths.length - visiblePaths.length;
  return remainingCount > 0
    ? `${visiblePaths.join(', ')} (+${remainingCount} more)`
    : visiblePaths.join(', ');
}
