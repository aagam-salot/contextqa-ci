import { ConfigError, FAIL_ON_VALUES, screenshotDirFor, toBuildSource, type FailOn, type RunOptions } from '@contextqa/ci-core';

export const DEFAULT_API_URL = 'https://server.contextqa.com';
const DEFAULT_TIMEOUT_SECONDS = 3600;
const DEFAULT_POLL_INTERVAL_SECONDS = 15;

export interface ActionConfig {
  run: RunOptions;
  failOn: FailOn;
  junitPath?: string;
}

/** Reads the inputs declared in action.yml. `getInput` returns '' for an unset input. */
export function readInputs(getInput: (name: string) => string): ActionConfig {
  const value = (name: string): string | undefined => getInput(name).trim() || undefined;

  const failOn = value('fail-on') ?? 'failure';
  if (!(FAIL_ON_VALUES as readonly string[]).includes(failOn)) {
    throw new ConfigError(`fail-on must be one of ${FAIL_ON_VALUES.join(', ')}`);
  }

  const junitPath = value('junit-path');
  return {
    run: {
      apiUrl: value('api-url') ?? DEFAULT_API_URL,
      token: value('token') ?? '',
      planId: value('plan-id') ?? '',
      environment: value('environment'),
      androidBuild: toBuildSource(value('android-build')),
      iosBuild: toBuildSource(value('ios-build')),
      wait: (value('wait') ?? 'true').toLowerCase() !== 'false',
      timeoutSeconds: seconds(value('timeout'), DEFAULT_TIMEOUT_SECONDS, 'timeout'),
      pollIntervalSeconds: seconds(value('poll-interval'), DEFAULT_POLL_INTERVAL_SECONDS, 'poll-interval'),
      screenshotDir: junitPath ? screenshotDirFor(junitPath) : undefined,
    },
    failOn: failOn as FailOn,
    junitPath,
  };
}

function seconds(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new ConfigError(`${name} must be a positive number of seconds`);
  return parsed;
}
