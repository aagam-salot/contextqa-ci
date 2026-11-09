import { openAsBlob } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { isApiToken } from './auth.js';
import { ContextQAClient, defaultSleep, type ClientDeps, type SleepFn } from './client.js';
import { AuthError, ConfigError, InfraError, RunTimeoutError } from './errors.js';
import {
  RUN_STATUS_COMPLETED,
  type BuildSource,
  type Reporter,
  type RunOptions,
  type RunResults,
  type RunSummary,
  type TestCaseOutcome,
} from './types.js';

const MS_PER_SECOND = 1_000;
const BYTES_PER_MB = 1024 * 1024;
const PASSING_RESULT = 'SUCCESS';
const PLAN_ID_PATTERN = /^\d+$/;
const NOT_PASSING = new Set(['FAILURE', 'ABORTED']);
/** Failure details cost two calls per failed test; past this many, the report link has the rest. */
const MAX_FAILURE_DETAILS = 50;

export interface RunDeps extends ClientDeps {
  now?: () => number;
  sleep?: SleepFn;
}

/**
 * Upload builds (if any), trigger the plan, wait for a verdict and collect
 * per-test results. Throws a `ContextQAError` when no verdict could be reached;
 * a completed-but-failed run is returned with `passed: false`, not thrown.
 */
export async function runTestPlan(options: RunOptions, reporter: Reporter, deps: RunDeps = {}): Promise<RunSummary> {
  validate(options);
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const client = new ContextQAClient(options.apiUrl, options.token, { ...deps, sleep });

  const apkBuildUrl = await resolveBuild(client, reporter, 'Android', options.androidBuild);
  const ipaBuildUrl = await resolveBuild(client, reporter, 'iOS', options.iosBuild);

  reporter.info(`Triggering test plan ${options.planId}`);
  const trigger = await client.trigger(options.planId, {
    environment: options.environment,
    apk_build_url: apkBuildUrl,
    ipa_build_url: ipaBuildUrl,
  });
  reporter.info(`Started run ${trigger.id}${trigger.url ? ` — ${trigger.url}` : ''}`);

  if (!options.wait) {
    return { runId: trigger.id, reportUrl: trigger.url, passed: true };
  }

  const results = await waitForCompletion(client, reporter, trigger.id, trigger.url, options, sleep, now);
  const reportUrl = results.reportFileUrl ?? trigger.url;
  const testCases = await collectTestCases(client, reporter, trigger.id, options.token);
  if (testCases) await addFailureDetails(client, reporter, testCases, options.screenshotDir);
  return {
    runId: trigger.id,
    reportUrl: reportUrl ?? undefined,
    results,
    testCases,
    passed: results.result === PASSING_RESULT,
  };
}

function validate(options: RunOptions): void {
  if (!options.token) {
    throw new ConfigError('ContextQA token is missing — pass it from a CI secret (CONTEXTQA_TOKEN)');
  }
  if (!PLAN_ID_PATTERN.test(options.planId)) {
    throw new ConfigError(`plan id must be a number, got "${options.planId}"`);
  }
  let parsed: URL;
  try {
    parsed = new URL(options.apiUrl);
  } catch (error) {
    throw new ConfigError(`API URL is not a valid URL: "${options.apiUrl}"`, { cause: error });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ConfigError(`API URL must be http(s), got "${options.apiUrl}"`);
  }
  if (!(options.pollIntervalSeconds > 0) || !(options.timeoutSeconds > 0)) {
    throw new ConfigError('poll interval and timeout must be positive numbers of seconds');
  }
}

/** Returns the value for `apk_build_url` / `ipa_build_url`, uploading a local file first. */
async function resolveBuild(
  client: ContextQAClient,
  reporter: Reporter,
  label: string,
  source: BuildSource | undefined,
): Promise<string | undefined> {
  if (!source) return undefined;
  if (source.kind === 'url') return source.url;

  const size = await fileSize(source.path, label);
  const fileName = basename(source.path);
  reporter.info(`Uploading ${label} build ${fileName} (${(size / BYTES_PER_MB).toFixed(1)} MB)`);
  const pair = await client.buildUploadUrl(fileName);
  await client.uploadBuild(pair.putUrl, await openAsBlob(source.path));
  reporter.info(`Uploaded ${fileName}`);
  return pair.key;
}

async function fileSize(path: string, label: string): Promise<number> {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new ConfigError(`${label} build ${path} is not a file`);
    return info.size;
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`no ${label} build at ${path}`, { cause: error });
  }
}

async function waitForCompletion(
  client: ContextQAClient,
  reporter: Reporter,
  runId: number,
  triggerUrl: string | undefined,
  options: RunOptions,
  sleep: SleepFn,
  now: () => number,
): Promise<RunResults> {
  const deadline = now() + options.timeoutSeconds * MS_PER_SECOND;
  let lastProgress = '';
  for (;;) {
    if (now() >= deadline) {
      throw new RunTimeoutError(runId, options.timeoutSeconds, triggerUrl);
    }
    await sleep(options.pollIntervalSeconds * MS_PER_SECOND);

    let results: RunResults;
    try {
      results = await client.results(runId);
    } catch (error) {
      // A credential problem will not fix itself; a blip must not kill a long run.
      if (error instanceof InfraError) {
        reporter.warn(`Polling run ${runId} failed, retrying: ${error.message}`);
        continue;
      }
      throw error;
    }

    const progress = formatProgress(results);
    if (progress !== lastProgress) {
      reporter.info(progress);
      lastProgress = progress;
    }
    if (results.status === RUN_STATUS_COMPLETED) return results;
  }
}

function formatProgress(results: RunResults): string {
  const done =
    results.passedCount + results.failedCount + results.abortedCount + results.stoppedCount + results.notExecutedCount;
  return `${results.status} | ${done}/${results.totalCount} done | passed ${results.passedCount} | failed ${results.failedCount}`;
}

/** Per-test detail is best-effort: the run verdict never depends on it. */
async function collectTestCases(
  client: ContextQAClient,
  reporter: Reporter,
  runId: number,
  token: string,
): Promise<TestCaseOutcome[] | undefined> {
  if (!isApiToken(token)) {
    reporter.info('Per-test results need a ContextQA API token; the CI token only reports counts.');
    return undefined;
  }
  try {
    return await client.testCaseResults(runId);
  } catch (error) {
    if (error instanceof AuthError) {
      reporter.warn('Per-test results skipped: the token lacks the TEST_CASE_RESULTS_READ permission.');
      return undefined;
    }
    if (error instanceof ConfigError || error instanceof InfraError) {
      reporter.warn(`Per-test results unavailable: ${error.message}`);
      return undefined;
    }
    throw error;
  }
}

/**
 * The failed step, its error and its screenshot for each failed test. Best-effort like the per-test
 * results: nothing here can change the verdict, and without `TEST_STEP_RESULTS_READ` the report
 * keeps the short message it had.
 */
async function addFailureDetails(
  client: ContextQAClient,
  reporter: Reporter,
  testCases: TestCaseOutcome[],
  screenshotDir: string | undefined,
): Promise<void> {
  const failing = testCases.filter((t) => NOT_PASSING.has(t.result)).slice(0, MAX_FAILURE_DETAILS);
  for (const testCase of failing) {
    try {
      testCase.failedStep = await client.failedStep(testCase.id);
    } catch (error) {
      if (error instanceof AuthError) {
        reporter.warn('Failure details skipped: the token lacks the TEST_STEP_RESULTS_READ permission.');
      } else {
        reporter.warn(`Failure details unavailable: ${errorText(error)}`);
      }
      return;
    }
    const step = testCase.failedStep;
    if (screenshotDir && step?.hasScreenshot) {
      testCase.screenshotPath = await saveScreenshot(client, reporter, screenshotDir, testCase.id, step.stepResultId);
    }
  }
}

async function saveScreenshot(
  client: ContextQAClient,
  reporter: Reporter,
  dir: string,
  testCaseResultId: number,
  stepResultId: number,
): Promise<string | undefined> {
  try {
    const image = await client.stepScreenshot(stepResultId);
    if (!image) return undefined;
    const path = join(dir, `${testCaseResultId}${imageExtension(image)}`);
    await mkdir(dir, { recursive: true });
    await writeFile(path, image);
    return path;
  } catch (error) {
    reporter.warn(`Screenshot for test case result ${testCaseResultId} not saved: ${errorText(error)}`);
    return undefined;
  }
}

function imageExtension(image: Uint8Array): string {
  const isPng = image[0] === 0x89 && image[1] === 0x50 && image[2] === 0x4e && image[3] === 0x47;
  if (isPng) return '.png';
  const isJpeg = image[0] === 0xff && image[1] === 0xd8;
  return isJpeg ? '.jpg' : '.img';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
