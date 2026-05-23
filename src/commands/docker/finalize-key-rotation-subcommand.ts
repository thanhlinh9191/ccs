import * as fs from 'fs';
import { DockerExecutor } from '../../docker';
import { configExists, regenerateConfig } from '../../cliproxy/config/config-generator';
import { CLIPROXY_DEFAULT_PORT } from '../../cliproxy/config/port-manager';
import { finalizeDockerKeyRotation } from '../../docker/docker-key-rotation';
import { box, fail, info, initUI, ok } from '../../utils/ui';
import { collectUnexpectedDockerArgs, parseDockerTarget } from './options';

const KNOWN_FLAGS = ['--host', '--container-scope'] as const;

function shouldWriteContainerVolume(args: string[]): boolean {
  return args.includes('--container-scope') || fs.existsSync('/.dockerenv');
}

export async function handleFinalizeKeyRotation(args: string[]): Promise<void> {
  await initUI();

  const parsed = parseDockerTarget(args, KNOWN_FLAGS);
  const remainingArgs = parsed.remainingArgs.filter((arg) => arg !== '--container-scope');
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

  if (!shouldWriteContainerVolume(args)) {
    try {
      const output = new DockerExecutor().finalizeKeyRotation({ host: parsed.host });
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

  const status = finalizeDockerKeyRotation();
  if (configExists(CLIPROXY_DEFAULT_PORT)) {
    regenerateConfig(CLIPROXY_DEFAULT_PORT);
  }

  console.log(ok('Docker CLIProxy legacy API key grace period finalized.'));
  console.log(info(`Current API key: ${status.maskedApiKey ?? '(not configured)'}`));
  console.log(info('Restart CLIProxy if it is already running to reload the regenerated config.'));
}
