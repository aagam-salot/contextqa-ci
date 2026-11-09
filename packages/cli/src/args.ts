import { parseArgs } from 'node:util';
import { ConfigError, FAIL_ON_VALUES, screenshotDirFor, toBuildSource, type FailOn, type RunOptions } from '@contextqa/ci-core';

export const DEFAULT_API_URL = 'https://server.contextqa.com';
const DEFAULT_TIMEOUT_SECONDS = 3600;
const DEFAULT_POLL_INTERVAL_SECONDS = 15;

export interface CliConfig {
  run: RunOptions;
  failOn: FailOn;
  junitPath?: string;
  jsonPath?: string;
}

export type ParsedCommand = { kind: 'help' } | { kind: 'version' } | { kind: 'run-plan'; config: CliConfig };

export const HELP = `Usage: contextqa run-plan --plan-id <id> [options]

Trigger a ContextQA test plan, wait for it to finish, and exit non-zero unless it passed.
Every option can also be set through the environment variable shown.

Credentials
  CONTEXTQA_TOKEN                 API token (token_…) or legacy CI token. Environment only.

Options
  --plan-id <id>                  CONTEXTQA_PLAN_ID       Test plan to run (required)
  --api-url <url>                 CONTEXTQA_API_URL       Default ${DEFAULT_API_URL}
  --environment <value>           CONTEXTQA_ENVIRONMENT   Override the plan's environment
  --android-build <path|url>      CONTEXTQA_ANDROID_BUILD Local file is uploaded; a URL is passed through
  --ios-build <path|url>          CONTEXTQA_IOS_BUILD     Same, for iOS
  --timeout <seconds>             CONTEXTQA_TIMEOUT       Default ${DEFAULT_TIMEOUT_SECONDS}
  --poll-interval <seconds>       CONTEXTQA_POLL_INTERVAL Default ${DEFAULT_POLL_INTERVAL_SECONDS}
  --junit <path>                  CONTEXTQA_JUNIT_PATH    Write JUnit XML here
  --json <path>                   CONTEXTQA_JSON_PATH     Write a JSON summary here
  --fail-on <failure|never>       CONTEXTQA_FAIL_ON       Default failure
  --no-wait                       CONTEXTQA_WAIT=false    Trigger and exit without waiting

Exit codes: 0 passed · 1 tests failed · 2 configuration/auth error · 3 infrastructure error or timeout
`;

type Env = Record<string, string | undefined>;

export function parseCommand(argv: string[], env: Env): ParsedCommand {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      'plan-id': { type: 'string' },
      'api-url': { type: 'string' },
      environment: { type: 'string' },
      'android-build': { type: 'string' },
      'ios-build': { type: 'string' },
      timeout: { type: 'string' },
      'poll-interval': { type: 'string' },
      junit: { type: 'string' },
      json: { type: 'string' },
      'fail-on': { type: 'string' },
      'no-wait': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });

  if (values.version) return { kind: 'version' };
  const command = positionals[0];
  if (values.help || command === undefined || command === 'help') return { kind: 'help' };
  if (command !== 'run-plan') throw new ConfigError(`unknown command "${command}" — try "contextqa --help"`);

  const pick = (flag: string | undefined, name: string): string | undefined => nonEmpty(flag) ?? nonEmpty(env[name]);
  const planId = pick(values['plan-id'], 'CONTEXTQA_PLAN_ID');
  if (!planId) throw new ConfigError('--plan-id (or CONTEXTQA_PLAN_ID) is required');

  const failOn = pick(values['fail-on'], 'CONTEXTQA_FAIL_ON') ?? 'failure';
  if (!isFailOn(failOn)) throw new ConfigError(`--fail-on must be one of ${FAIL_ON_VALUES.join(', ')}`);

  const junitPath = pick(values.junit, 'CONTEXTQA_JUNIT_PATH');
  return {
    kind: 'run-plan',
    config: {
      run: {
        apiUrl: pick(values['api-url'], 'CONTEXTQA_API_URL') ?? DEFAULT_API_URL,
        token: env['CONTEXTQA_TOKEN']?.trim() ?? '',
        planId,
        environment: pick(values.environment, 'CONTEXTQA_ENVIRONMENT'),
        androidBuild: toBuildSource(pick(values['android-build'], 'CONTEXTQA_ANDROID_BUILD')),
        iosBuild: toBuildSource(pick(values['ios-build'], 'CONTEXTQA_IOS_BUILD')),
        wait: !(values['no-wait'] ?? isFalse(env['CONTEXTQA_WAIT'])),
        timeoutSeconds: toSeconds(pick(values.timeout, 'CONTEXTQA_TIMEOUT'), DEFAULT_TIMEOUT_SECONDS, '--timeout'),
        pollIntervalSeconds: toSeconds(
          pick(values['poll-interval'], 'CONTEXTQA_POLL_INTERVAL'),
          DEFAULT_POLL_INTERVAL_SECONDS,
          '--poll-interval',
        ),
        screenshotDir: junitPath ? screenshotDirFor(junitPath) : undefined,
      },
      failOn,
      junitPath,
      jsonPath: pick(values.json, 'CONTEXTQA_JSON_PATH'),
    },
  };
}

function toSeconds(value: string | undefined, fallback: number, flag: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new ConfigError(`${flag} must be a positive number of seconds`);
  return parsed;
}

function isFailOn(value: string): value is FailOn {
  return (FAIL_ON_VALUES as readonly string[]).includes(value);
}

function isFalse(value: string | undefined): boolean {
  return value !== undefined && ['false', '0', 'no'].includes(value.trim().toLowerCase());
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
