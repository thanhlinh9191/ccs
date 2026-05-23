import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createLogger } from '../services/logging';

const logger = createLogger('codex-auth:resources');

export const SHARED_CODEX_RESOURCE_DIRS = ['agents', 'skills'] as const;

export interface EnsureCodexProfileResourcesOptions {
  sharedCodexHome?: string;
}

export function ensureCodexProfileResources(
  profileDir: string,
  options: EnsureCodexProfileResourcesOptions = {}
): void {
  const sharedCodexHome = options.sharedCodexHome ?? path.join(os.homedir(), '.codex');

  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(sharedCodexHome, { recursive: true, mode: 0o700 });

  for (const resourceName of SHARED_CODEX_RESOURCE_DIRS) {
    ensureSharedResourceDir(profileDir, sharedCodexHome, resourceName);
  }
}

function ensureSharedResourceDir(
  profileDir: string,
  sharedCodexHome: string,
  resourceName: (typeof SHARED_CODEX_RESOURCE_DIRS)[number]
): void {
  const targetPath = path.join(sharedCodexHome, resourceName);
  const linkPath = path.join(profileDir, resourceName);

  fs.mkdirSync(targetPath, { recursive: true, mode: 0o700 });

  let existingStat: fs.Stats | null = null;
  try {
    existingStat = fs.lstatSync(linkPath);
  } catch {
    // Missing resource path: create it below.
  }

  if (existingStat !== null) {
    if (existingStat.isSymbolicLink()) {
      const currentTarget = fs.readlinkSync(linkPath);
      if (currentTarget === targetPath) {
        return;
      }
      fs.unlinkSync(linkPath);
    } else if (existingStat.isDirectory()) {
      if (isDirectoryEmpty(linkPath)) {
        fs.rmSync(linkPath, { recursive: true, force: true });
      } else {
        copyMissingResourceEntries(targetPath, linkPath);
        return;
      }
    } else {
      process.stderr.write(
        `[!] codex-auth: preserving existing non-directory ${resourceName} at ${linkPath}\n`
      );
      return;
    }
  }

  try {
    fs.symlinkSync(targetPath, linkPath, 'dir');
    logger.stage('dispatch', 'codex.resource.symlink.created', 'Created shared resource symlink', {
      link: linkPath,
      target: targetPath,
      resource: resourceName,
    });
  } catch (err) {
    fs.mkdirSync(linkPath, { recursive: true, mode: 0o700 });
    copyMissingResourceEntries(targetPath, linkPath);
    process.stderr.write(
      `[!] codex-auth: symlink unavailable; copied shared ${resourceName} to ${linkPath}. ` +
        `Resource edits won't propagate automatically.\n`
    );
    logger.warn(
      'codex-auth.resource-copy-fallback',
      'Copied shared resource after symlink failure',
      {
        link: linkPath,
        target: targetPath,
        resource: resourceName,
        error: err instanceof Error ? err.message : String(err),
      }
    );
  }
}

function isDirectoryEmpty(dirPath: string): boolean {
  try {
    return fs.readdirSync(dirPath).length === 0;
  } catch {
    return false;
  }
}

function copyMissingResourceEntries(sourceDir: string, targetDir: string): void {
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (fs.existsSync(targetPath)) {
      continue;
    }
    fs.cpSync(sourcePath, targetPath, {
      recursive: true,
      force: false,
      errorOnExist: false,
      preserveTimestamps: true,
    });
  }
}
