import * as fs from 'fs';
import { DockerExecutor } from '../../docker';
import {
  getDockerKeyRotationStatus,
  renderDockerKeyRotationBanner,
} from '../../docker/docker-key-rotation';
import { box, fail, header, info, initUI } from '../../utils/ui';
import { collectUnexpectedDockerArgs, parseDockerTarget } from './options';

const KNOWN_FLAGS = ['--host', '--full', '--container-scope', '--banner-only'] as const;

function shouldReadContainerVolume(args: string[]): boolean {
  return args.includes('--container-scope') || fs.existsSync('/.dockerenv');
}

export async function handleShowKey(args: string[]): Promise<void> {
  const bannerOnly = args.includes('--banner-only');
  if (!bannerOnly) {
    await initUI();
  }

  const parsed = parseDockerTarget(args, KNOWN_FLAGS);
  const remainingArgs = parsed.remainingArgs.filter(
    (arg) => arg !== '--full' && arg !== '--container-scope' && arg !== '--banner-only'
  );
  const errors = [
    ...parsed.errors,
    ...collectUnexpectedDockerArgs(remainingArgs, {
      knownFlags: [],
      maxPositionals: 0,
    }),
  ];

  if (errors.length > 0) {
    console.error(box(fail(errors.join('\n')), { title: 'Docker', padding: 1 }));
    process.exitCode = 1;
    return;
  }

  const full = args.includes('--full');
  if (!shouldReadContainerVolume(args)) {
    try {
      const output = new DockerExecutor().showKey({ host: parsed.host }, full);
      if (output.trim()) {
        console.log(output.trim());
      }
    } catch (error) {
      console.error(
        box(fail(error instanceof Error ? error.message : String(error)), {
          title: 'Docker',
          padding: 1,
        })
      );
      process.exitCode = 1;
    }
    return;
  }

  const status = getDockerKeyRotationStatus();
  if (bannerOnly) {
    const banner = renderDockerKeyRotationBanner(status);
    if (banner) {
      console.log(banner);
    }
    return;
  }

  const displayKey = full ? status.apiKey : status.maskedApiKey;
  console.log(header('Docker CLIProxy API Key'));
  console.log('');
  console.log(info(`API key: ${displayKey ?? '(not configured)'}`));
  if (status.legacyGraceActive && status.legacyGrace) {
    console.log(info(`Legacy key: ${status.legacyGrace.legacyKey}`));
    console.log(info(`Legacy key expires: ${status.legacyGrace.expiresAt}`));
  } else {
    console.log(info('Legacy key grace: inactive'));
  }
  if (status.stateCorrupted) {
    console.log(info(`State marker was unreadable and will be recreated: ${status.statePath}`));
  }
}
