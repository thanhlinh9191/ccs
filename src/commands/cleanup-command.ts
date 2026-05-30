/**
 * Cleanup Command Handler
 *
 * Removes old CCS and CLIProxy logs to free up disk space.
 * Supports both main logs and error request logs with age-based filtering.
 * Logs can accumulate to several GB without user awareness.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getCliproxyDir } from '../cliproxy/config/config-generator';
import { getLogArchiveDir, getNativeLogsDir } from '../services/logging';
import { info, ok, warn } from '../utils/ui';

/** Default age in days for error log cleanup */
const DEFAULT_ERROR_LOG_AGE_DAYS = 7;

/** Get the CLIProxy logs directory */
function getLogsDir(): string {
  return path.join(getCliproxyDir(), 'logs');
}

function getCcsLogsDir(): string {
  return getNativeLogsDir();
}

function getCcsLogArchiveDir(): string {
  return getLogArchiveDir();
}

/** Format bytes to human-readable size */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

interface DirectorySummary {
  fileCount: number;
  size: number;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function pathExistsForCleanup(dirPath: string): boolean {
  try {
    fs.lstatSync(dirPath);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

/** Return entries for a real directory, rejecting symlinked directory targets. */
function readRealDirectory(dirPath: string): string[] {
  let stats: fs.Stats;

  try {
    stats = fs.lstatSync(dirPath);
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }

  if (!stats.isDirectory() || stats.isSymbolicLink()) return [];
  return fs.readdirSync(dirPath);
}

/** Summarize regular top-level files in a real directory */
function summarizeDirectory(dirPath: string): DirectorySummary {
  const summary = { fileCount: 0, size: 0 };
  const entries = readRealDirectory(dirPath);

  for (const entry of entries) {
    const filePath = path.join(dirPath, entry);
    try {
      const stats = fs.lstatSync(filePath);
      if (stats.isFile() && !stats.isSymbolicLink()) {
        summary.fileCount++;
        summary.size += stats.size;
      }
    } catch {
      // File may have been deleted between readdir and stat - skip
    }
  }

  return summary;
}

/** Delete all regular files in a real directory (skips symlinks for safety) */
function cleanDirectory(dirPath: string): { deleted: number; freedBytes: number } {
  let deleted = 0;
  let freedBytes = 0;
  const files = readRealDirectory(dirPath);

  for (const file of files) {
    const filePath = path.join(dirPath, file);
    try {
      const stats = fs.lstatSync(filePath);

      // Only delete regular files, skip symlinks for security
      if (stats.isFile() && !stats.isSymbolicLink()) {
        freedBytes += stats.size;
        fs.unlinkSync(filePath);
        deleted++;
      }
    } catch {
      // File may have been deleted or inaccessible - skip
    }
  }

  return { deleted, freedBytes };
}

/** Error log file info */
interface ErrorLogInfo {
  name: string;
  path: string;
  size: number;
  mtime: Date;
  ageInDays: number;
}

/** Get error log files with metadata */
function getErrorLogFiles(logsDir: string): ErrorLogInfo[] {
  const now = Date.now();
  const files: ErrorLogInfo[] = [];
  const entries = readRealDirectory(logsDir);

  for (const entry of entries) {
    // Only process error-*.log files
    if (!entry.startsWith('error-') || !entry.endsWith('.log')) continue;

    const filePath = path.join(logsDir, entry);
    try {
      const stats = fs.lstatSync(filePath);
      if (stats.isFile() && !stats.isSymbolicLink()) {
        const ageMs = now - stats.mtime.getTime();
        files.push({
          name: entry,
          path: filePath,
          size: stats.size,
          mtime: stats.mtime,
          ageInDays: Math.floor(ageMs / (1000 * 60 * 60 * 24)),
        });
      }
    } catch {
      // File may have been deleted - skip
    }
  }

  // Sort by age, oldest first
  return files.sort((a, b) => b.ageInDays - a.ageInDays);
}

/** Delete error logs older than specified days */
function cleanErrorLogs(
  files: ErrorLogInfo[],
  maxAgeDays: number
): { deleted: number; freedBytes: number; kept: number } {
  let deleted = 0;
  let freedBytes = 0;
  let kept = 0;

  for (const file of files) {
    if (file.ageInDays >= maxAgeDays) {
      try {
        fs.unlinkSync(file.path);
        deleted++;
        freedBytes += file.size;
      } catch {
        // File may be locked or already deleted
      }
    } else {
      kept++;
    }
  }

  return { deleted, freedBytes, kept };
}

/** Print help for cleanup command */
function printHelp(): void {
  console.log('');
  console.log('Usage: ccs cleanup [options]');
  console.log('');
  console.log('Remove old CCS and CLIProxy logs to free up disk space.');
  console.log('');
  console.log('Options:');
  console.log('  --errors      Clean legacy CLIProxy error request logs (error-*.log files)');
  console.log('  --days=N      Delete error logs older than N days (default: 7)');
  console.log('  --dry-run     Show what would be deleted without deleting');
  console.log('  --force       Skip confirmation prompt');
  console.log('  --help, -h    Show this help message');
  console.log('');
  console.log('Examples:');
  console.log('  ccs cleanup              Interactive CCS + CLIProxy log cleanup');
  console.log('  ccs cleanup --errors     Clean legacy CLIProxy error logs older than 7 days');
  console.log('  ccs cleanup --errors --days=3   Clean error logs older than 3 days');
  console.log('  ccs cleanup --errors --dry-run  Preview error log cleanup');
  console.log('  ccs cleanup --dry-run    Preview main log cleanup');
  console.log('  ccs cleanup --force      Clean main logs without confirmation');
  console.log('');
}

/**
 * Handle cleanup command
 */
export async function handleCleanupCommand(args: string[]): Promise<void> {
  // Handle help
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');
  const cleanErrors = args.includes('--errors');
  const logsDir = getLogsDir();
  const ccsLogsDir = getCcsLogsDir();
  const ccsArchiveDir = getCcsLogArchiveDir();

  // Parse --days=N option
  let maxAgeDays = DEFAULT_ERROR_LOG_AGE_DAYS;
  const daysArg = args.find((arg) => arg.startsWith('--days='));
  if (daysArg) {
    const parsed = parseInt(daysArg.split('=')[1], 10);
    if (isNaN(parsed) || parsed < 1) {
      console.log(warn('Invalid --days value. Must be a positive integer.'));
      return;
    }
    maxAgeDays = parsed;
  }

  // Route to error log cleanup or main log cleanup
  if (cleanErrors) {
    await handleErrorLogCleanup(logsDir, maxAgeDays, dryRun, force);
  } else {
    await handleMainLogCleanup({
      cliproxyLogsDir: logsDir,
      ccsLogsDir,
      ccsArchiveDir,
      dryRun,
      force,
    });
  }
}

/**
 * Handle error log cleanup (error-*.log files)
 */
async function handleErrorLogCleanup(
  logsDir: string,
  maxAgeDays: number,
  dryRun: boolean,
  force: boolean
): Promise<void> {
  try {
    if (!pathExistsForCleanup(logsDir)) {
      console.log(info('No CLIProxy logs directory found.'));
      return;
    }
  } catch (error) {
    console.log(warn(`Could not inspect CLIProxy logs: ${getErrorMessage(error)}`));
    return;
  }

  let errorLogs: ErrorLogInfo[];
  try {
    errorLogs = getErrorLogFiles(logsDir);
  } catch (error) {
    console.log(warn(`Could not read CLIProxy logs: ${getErrorMessage(error)}`));
    return;
  }
  if (errorLogs.length === 0) {
    console.log(info('No error logs found.'));
    return;
  }

  // Calculate what would be deleted
  const toDelete = errorLogs.filter((f) => f.ageInDays >= maxAgeDays);
  const toKeep = errorLogs.filter((f) => f.ageInDays < maxAgeDays);
  const totalDeleteSize = toDelete.reduce((sum, f) => sum + f.size, 0);

  console.log('');
  console.log(`Error Logs: ${logsDir}`);
  console.log(`  Total:    ${errorLogs.length} files`);
  console.log(
    `  To delete: ${toDelete.length} files older than ${maxAgeDays} days (${formatBytes(totalDeleteSize)})`
  );
  console.log(`  To keep:   ${toKeep.length} files newer than ${maxAgeDays} days`);
  console.log('');

  if (toDelete.length === 0) {
    console.log(info(`No error logs older than ${maxAgeDays} days.`));
    return;
  }

  // Show oldest files in dry-run or verbose mode
  if (dryRun || toDelete.length <= 5) {
    console.log('Files to delete:');
    for (const file of toDelete.slice(0, 10)) {
      console.log(`  ${file.name} (${file.ageInDays}d old, ${formatBytes(file.size)})`);
    }
    if (toDelete.length > 10) {
      console.log(`  ... and ${toDelete.length - 10} more`);
    }
    console.log('');
  }

  if (dryRun) {
    console.log(info('Dry run - no files deleted.'));
    return;
  }

  // Confirm unless --force
  if (!force) {
    const readline = await import('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const answer = await new Promise<string>((resolve) => {
      rl.question(
        `Delete ${toDelete.length} error logs older than ${maxAgeDays} days (${formatBytes(totalDeleteSize)})? [y/N] `,
        resolve
      );
    });
    rl.close();

    if (answer.toLowerCase() !== 'y') {
      console.log('Cancelled.');
      return;
    }
  }

  // Perform cleanup
  let result: { deleted: number; freedBytes: number; kept: number };
  try {
    result = cleanErrorLogs(errorLogs, maxAgeDays);
  } catch (error) {
    console.log(warn(`Could not clean CLIProxy logs: ${getErrorMessage(error)}`));
    return;
  }
  const { deleted, freedBytes, kept } = result;
  console.log(ok(`Deleted ${deleted} error logs, freed ${formatBytes(freedBytes)}`));
  if (kept > 0) {
    console.log(info(`Kept ${kept} recent error logs (less than ${maxAgeDays} days old)`));
  }
}

/**
 * Handle main log cleanup (main.log and rotated files)
 */
async function handleMainLogCleanup(options: {
  cliproxyLogsDir: string;
  ccsLogsDir: string;
  ccsArchiveDir: string;
  dryRun: boolean;
  force: boolean;
}): Promise<void> {
  const targets: Array<{ label: string; dir: string } & DirectorySummary> = [];
  const unreadableTargets: Array<{ label: string; dir: string; error: unknown }> = [];
  for (const target of [
    { label: 'CCS Logs', dir: options.ccsLogsDir },
    { label: 'CCS Log Archives', dir: options.ccsArchiveDir },
    { label: 'CLIProxy Logs', dir: options.cliproxyLogsDir },
  ]) {
    try {
      targets.push({
        ...target,
        ...summarizeDirectory(target.dir),
      });
    } catch (error) {
      unreadableTargets.push({ ...target, error });
    }
  }

  if (unreadableTargets.length > 0) {
    for (const target of unreadableTargets) {
      console.log(warn(`Could not read ${target.label}: ${getErrorMessage(target.error)}`));
      console.log(`     ${target.dir}`);
    }
    return;
  }
  const activeTargets = targets.filter((target) => target.fileCount > 0);

  if (activeTargets.length === 0) {
    console.log(info('No CCS or CLIProxy logs found.'));
    return;
  }

  const currentSize = activeTargets.reduce((sum, target) => sum + target.size, 0);
  const fileCount = activeTargets.reduce((sum, target) => sum + target.fileCount, 0);

  console.log('');
  console.log('Log Cleanup Targets:');
  for (const target of activeTargets) {
    console.log(`  ${target.label}: ${target.fileCount} files (${formatBytes(target.size)})`);
    console.log(`    ${target.dir}`);
  }
  console.log('');

  if (options.dryRun) {
    console.log(info('Dry run - no files deleted.'));
    console.log(`Would delete ${fileCount} files (${formatBytes(currentSize)})`);
    return;
  }

  // Confirm unless --force
  if (!options.force) {
    const readline = await import('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const answer = await new Promise<string>((resolve) => {
      rl.question(`Delete ${fileCount} log files (${formatBytes(currentSize)})? [y/N] `, resolve);
    });
    rl.close();

    if (answer.toLowerCase() !== 'y') {
      console.log('Cancelled.');
      return;
    }
  }

  // Perform cleanup
  let deleted = 0;
  let freedBytes = 0;
  for (const target of activeTargets) {
    try {
      const result = cleanDirectory(target.dir);
      deleted += result.deleted;
      freedBytes += result.freedBytes;
    } catch (error) {
      console.log(warn(`Could not clean ${target.label}: ${getErrorMessage(error)}`));
    }
  }
  console.log(ok(`Deleted ${deleted} files, freed ${formatBytes(freedBytes)}`));

  // Suggest disabling logging if it was enabled
  if (deleted > 0) {
    console.log('');
    console.log(warn('Tip: CCS logging is bounded by retention, but you can lower it further.'));
    console.log('     Open `ccs config` and review the Logs settings.');
  }
}
