/**
 * Read-only dashboard card displaying codex-auth profile state.
 *
 * Distinct from codex-profiles-card.tsx (which edits config.toml [profiles]).
 * This card shows CCS-side shell profiles: active account, email, plan tier,
 * last-used timestamp, and auth validity.
 *
 * All mutating actions (switch, remove) are disabled with a terminal redirect
 * tooltip per the read-only dashboard spec (D5).
 */

import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useCodexAuthProfiles } from '@/hooks/use-codex-auth-profiles';
import type { CodexAuthProfileEntry } from '@/hooks/use-codex-auth-profiles';

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatLastUsed(iso: string | null): string {
  if (!iso) return 'never';
  try {
    const d = new Date(iso);
    const diffMs = Date.now() - d.getTime();
    const diffMin = Math.floor(diffMs / 60_000);
    if (diffMin < 2) return 'just now';
    if (diffMin < 60) return `${diffMin} min ago`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH}h ago`;
    const diffD = Math.floor(diffH / 24);
    if (diffD === 1) return 'yesterday';
    return `${diffD}d ago`;
  } catch {
    return iso;
  }
}

function sourceLabel(source: 'default' | 'env' | 'explicit-codex-home'): string {
  switch (source) {
    case 'default':
      return 'default';
    case 'env':
      return '$CCS_CODEX_PROFILE';
    case 'explicit-codex-home':
      return '$CODEX_HOME';
  }
}

// ── Disabled action button with terminal-redirect tooltip ───────────────────

function TerminalOnlyButton({ label }: { label: string }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* span wrapper needed — disabled buttons don't trigger mouse events */}
          <span tabIndex={0} className="inline-block">
            <Button variant="outline" size="sm" disabled className="pointer-events-none">
              {label}
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {/* TODO i18n: missing key codex.auth.terminalOnlyTooltip */}
          Use <code>ccsx auth switch &lt;name&gt;</code> or{' '}
          <code>ccsx auth remove &lt;name&gt;</code> in terminal.
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// ── Profile table row ────────────────────────────────────────────────────────

function ProfileRow({
  entry,
  isActive,
  activeSource,
}: {
  entry: CodexAuthProfileEntry;
  isActive: boolean;
  activeSource?: 'default' | 'env' | 'explicit-codex-home';
}) {
  return (
    <TableRow className={isActive ? 'bg-muted/40' : undefined}>
      <TableCell className="font-medium">
        <span className="flex items-center gap-2">
          {entry.name}
          {isActive && activeSource && (
            <Badge variant="secondary" className="text-xs">
              {/* TODO i18n: missing key codex.auth.activeSourceBadge */}
              {sourceLabel(activeSource)}
            </Badge>
          )}
        </span>
      </TableCell>
      <TableCell>{entry.email ?? '—'}</TableCell>
      <TableCell>{entry.plan ?? '—'}</TableCell>
      <TableCell>{formatLastUsed(entry.lastUsed)}</TableCell>
      <TableCell>
        {entry.authValid ? (
          <Badge variant="secondary" className="text-xs text-green-700 dark:text-green-400">
            {/* TODO i18n: missing key codex.auth.statusOk */}
            OK
          </Badge>
        ) : (
          <Badge variant="destructive" className="text-xs">
            {/* TODO i18n: missing key codex.auth.statusInvalid */}
            [!] auth invalid
          </Badge>
        )}
      </TableCell>
      <TableCell>
        <span className="flex gap-1">
          <TerminalOnlyButton label="Switch" />
          <TerminalOnlyButton label="Remove" />
        </span>
      </TableCell>
    </TableRow>
  );
}

// ── Main card ────────────────────────────────────────────────────────────────

export function CodexAuthProfilesCard() {
  const { data, isLoading, error } = useCodexAuthProfiles();

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground p-4">
        <Loader2 className="h-4 w-4 animate-spin" />
        {/* TODO i18n: missing key codex.auth.loading */}
        Loading auth profiles...
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
        {/* TODO i18n: missing key codex.auth.loadError */}
        [!] Failed to load codex-auth profiles.
      </div>
    );
  }

  // Empty registry — no profiles at all
  if (data.profiles.length === 0) {
    return (
      <div className="rounded-md border bg-muted/30 px-4 py-3 text-sm text-muted-foreground space-y-1">
        <p>
          {/* TODO i18n: missing key codex.auth.emptyRegistry */}
          [i] No codex-auth profiles. Run{' '}
          <code className="rounded bg-muted px-1">ccsx auth create &lt;name&gt;</code> to create
          one.
        </p>
        <p>Codex will use the default ~/.codex location.</p>
      </div>
    );
  }

  // Legacy mode — profiles exist but none active
  if (!data.active) {
    return (
      <div className="space-y-3">
        <div className="rounded-md border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
          {/* TODO i18n: missing key codex.auth.legacyMode */}
          [i] No active profile. Using ~/.codex (legacy). Run{' '}
          <code className="rounded bg-muted px-1">ccsx auth switch &lt;name&gt;</code> in terminal
          to activate one.
        </div>
        <ProfileTable data={data} />
      </div>
    );
  }

  // External CODEX_HOME with no registry match
  if (data.active.source === 'explicit-codex-home' && data.active.name === null) {
    return (
      <div className="space-y-3">
        <div className="rounded-md border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
          {/* TODO i18n: missing key codex.auth.externalCodexHome */}
          [i] $CODEX_HOME set externally to{' '}
          <code className="rounded bg-muted px-1">{data.active.codexHome}</code>. Profile registry
          not in use for this session.
        </div>
        <ProfileTable data={data} />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <ActiveBanner name={data.active.name} source={data.active.source} profiles={data.profiles} />
      <ProfileTable data={data} />
    </div>
  );
}

// ── Active profile highlight banner ─────────────────────────────────────────

function ActiveBanner({
  name,
  source,
  profiles,
}: {
  name: string | null;
  source: 'default' | 'env' | 'explicit-codex-home';
  profiles: CodexAuthProfileEntry[];
}) {
  const activeEntry = profiles.find((p) => p.name === name);

  return (
    <div className="rounded-md border bg-muted/20 px-4 py-3 text-sm space-y-1">
      <div className="flex items-center gap-2 font-medium">
        {/* TODO i18n: missing key codex.auth.activeProfile */}
        Active profile:
        <span>{name ?? '(unknown)'}</span>
        <Badge variant="secondary" className="text-xs">
          {sourceLabel(source)}
        </Badge>
      </div>
      {activeEntry && (
        <div className="text-muted-foreground text-xs space-x-3">
          {activeEntry.email && <span>{activeEntry.email}</span>}
          {activeEntry.plan && (
            <span>
              Plan: <strong>{activeEntry.plan}</strong>
            </span>
          )}
          {!activeEntry.authValid && <span className="text-destructive">[!] auth invalid</span>}
        </div>
      )}
    </div>
  );
}

// ── Profile table ────────────────────────────────────────────────────────────

function ProfileTable({
  data,
}: {
  data: {
    active: { name: string | null; source: 'default' | 'env' | 'explicit-codex-home' } | null;
    profiles: CodexAuthProfileEntry[];
  };
}) {
  return (
    <div className="rounded-md border overflow-auto">
      <Table>
        <TableHeader>
          <TableRow>
            {/* TODO i18n: missing keys codex.auth.col.name/email/plan/lastUsed/status/actions */}
            <TableHead>Name</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Plan</TableHead>
            <TableHead>Last used</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.profiles.map((entry) => (
            <ProfileRow
              key={entry.name}
              entry={entry}
              isActive={data.active?.name === entry.name}
              activeSource={data.active?.name === entry.name ? data.active.source : undefined}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
