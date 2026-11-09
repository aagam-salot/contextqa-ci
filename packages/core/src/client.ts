import { authHeaders } from './auth.js';
import { AuthError, ConfigError, HttpError, InfraError } from './errors.js';
import type { FailedStep, RunResults, TestCaseOutcome, TriggerResponse, UploadPair } from './types.js';

const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1_000;
const ERROR_BODY_LIMIT = 500;
const TEST_CASE_PAGE_SIZE = 100;
/** A runaway pager must not spin forever; 100 pages is 10,000 test cases. */
const MAX_TEST_CASE_PAGES = 100;
/** Step results of one test case are read in a single page. */
const STEP_RESULT_PAGE_SIZE = 1000;
const FAILED_STEP_RESULTS = new Set(['FAILURE', 'ABORTED']);

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR_MIN = 500;

export type FetchFn = typeof fetch;
export type SleepFn = (ms: number) => Promise<void>;

export const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Screenshot URLs found in a response, kept beside the outcome instead of on it: they are short-lived
 * signed storage URLs, and the summary is written to disk (`--json`) and often uploaded.
 */
const screenshotUrls = new WeakMap<object, string>();

/** The screenshot URL the server sent for a failed test case or step, if any. */
export function screenshotUrlOf(holder: object | undefined): string | undefined {
  return holder ? screenshotUrls.get(holder) : undefined;
}

export interface ClientDeps {
  fetch?: FetchFn;
  sleep?: SleepFn;
}

type QueryParams = Record<string, string | undefined>;

/**
 * Thin client over the public CI endpoints documented in ts-portal-server
 * `docs/api/test-plan-ci-execution.md`. Every call that cannot start a run is
 * retried on network errors and 5xx/429; the trigger is not, because a retry
 * after the server received it would start a second billed run.
 */
export class ContextQAClient {
  private readonly apiUrl: string;
  private readonly fetchFn: FetchFn;
  private readonly sleep: SleepFn;

  constructor(
    apiUrl: string,
    private readonly token: string,
    deps: ClientDeps = {},
  ) {
    this.apiUrl = apiUrl.replace(/\/+$/, '');
    this.fetchFn = deps.fetch ?? globalThis.fetch;
    this.sleep = deps.sleep ?? defaultSleep;
  }

  async buildUploadUrl(fileName: string): Promise<UploadPair> {
    const body = await this.getJson('/test_plans/build_upload_url', { file_name: fileName }, true);
    const record = asRecord(body);
    const key = stringField(record, 'key');
    const putUrl = stringField(record, 'putUrl');
    if (!key || !putUrl) {
      // The body is deliberately not echoed: it carries a presigned URL.
      throw new InfraError('build upload response had no key/putUrl');
    }
    return { key, putUrl };
  }

  /** PUTs a build to a presigned URL. The URL is a credential, so it never appears in errors. */
  async uploadBuild(putUrl: string, body: Blob): Promise<void> {
    await this.withRetries('build upload', async () => {
      const response = await this.fetchFn(putUrl, { method: 'PUT', body });
      if (!response.ok) {
        throw new HttpError(response.status, 'build upload', '');
      }
    });
  }

  async trigger(planId: string, params: QueryParams): Promise<TriggerResponse> {
    const path = `/test_plans/${encodeURIComponent(planId)}/execution`;
    const body = await this.getJson(path, params, false);
    const record = asRecord(body);
    const id = numberField(record, 'id');
    if (id === undefined) {
      throw new InfraError(`trigger response had no run id: ${truncate(JSON.stringify(body))}`);
    }
    return { id, url: stringField(record, 'url') };
  }

  async results(runId: number): Promise<RunResults> {
    const body = await this.getJson(`/test_plan_results/${runId}/results`, {}, true);
    const record = asRecord(body);
    const startTime = timestampField(record, 'startTime');
    const endTime = timestampField(record, 'endTime');
    return {
      status: stringField(record, 'status') ?? '',
      result: stringField(record, 'result') ?? '',
      duration: numberField(record, 'duration'),
      startTime,
      endTime,
      wallClockMs: elapsedMs(startTime, endTime),
      totalCount: numberField(record, 'totalCount') ?? 0,
      passedCount: numberField(record, 'passedCount') ?? 0,
      failedCount: numberField(record, 'failedCount') ?? 0,
      abortedCount: numberField(record, 'abortedCount') ?? 0,
      stoppedCount: numberField(record, 'stoppedCount') ?? 0,
      notExecutedCount: numberField(record, 'notExecutedCount') ?? 0,
      reportFileUrl: stringField(record, 'reportFileUrl'),
    };
  }

  /**
   * Per-test rows of a run, as listed on the run report page. Prerequisite rows
   * are dropped, matching the run's own counts.
   */
  async testCaseResults(runId: number): Promise<TestCaseOutcome[]> {
    const outcomes: TestCaseOutcome[] = [];
    for (let page = 0; page < MAX_TEST_CASE_PAGES; page++) {
      const body = await this.getJson(
        '/test_case_results',
        {
          query: `testPlanResultId:${runId},iteration:null`,
          page: String(page),
          size: String(TEST_CASE_PAGE_SIZE),
          sort: 'id,asc',
        },
        true,
      );
      const record = asRecord(body);
      const content = Array.isArray(record['content']) ? record['content'] : [];
      for (const row of content) {
        const outcome = toOutcome(asRecord(row));
        if (outcome) outcomes.push(outcome);
      }
      if (record['last'] !== false || content.length === 0) return outcomes;
    }
    return outcomes;
  }

  /**
   * The first failed or aborted step of a test case result, or undefined when every step passed.
   * Needs the `TEST_STEP_RESULTS_READ` permission.
   */
  async failedStep(testCaseResultId: number): Promise<FailedStep | undefined> {
    const body = await this.getJson(
      '/test_step_results',
      { query: `testCaseResultId:${testCaseResultId}`, page: '0', size: String(STEP_RESULT_PAGE_SIZE), sort: 'id,asc' },
      true,
    );
    const record = asRecord(body);
    const content = Array.isArray(record['content']) ? record['content'] : [];
    const failed = content.map(asRecord).find((row) => FAILED_STEP_RESULTS.has(stringField(row, 'result') ?? ''));
    return failed ? toFailedStep(failed) : undefined;
  }

  /**
   * A step's screenshot. The server hands out a short-lived signed storage URL, which is a credential:
   * it is fetched without our token and never appears in a message.
   */
  async stepScreenshot(stepResultId: number): Promise<Uint8Array | undefined> {
    const body = await this.getJson(`/test_step_results/${stepResultId}`, {}, true);
    const signedUrl = stringField(asRecord(body), 'screenShotURL');
    return signedUrl ? this.downloadImage(signedUrl) : undefined;
  }

  /** Downloads an image from a signed storage URL: without our token, and never naming the URL. */
  async downloadImage(signedUrl: string): Promise<Uint8Array> {
    return this.withRetries('screenshot download', async () => {
      const response = await this.fetchFn(signedUrl);
      if (!response.ok) {
        throw new HttpError(response.status, 'screenshot download', '');
      }
      return new Uint8Array(await response.arrayBuffer());
    });
  }

  private async getJson(path: string, params: QueryParams, retry: boolean): Promise<unknown> {
    const url = new URL(this.apiUrl + path);
    for (const [name, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') url.searchParams.set(name, value);
    }
    const call = async (): Promise<unknown> => {
      const response = await this.fetchFn(url, { headers: { ...authHeaders(this.token), Accept: 'application/json' } });
      if (!response.ok) {
        throw toHttpFailure(response.status, path, truncate(await response.text()));
      }
      return response.json();
    };
    return retry ? this.withRetries(path, call) : this.withConnectRetries(path, call);
  }

  private async withRetries<T>(label: string, call: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await call();
      } catch (error) {
        if (attempt >= MAX_ATTEMPTS || !isRetryable(error)) throw wrapNetworkError(label, error);
        await this.sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      }
    }
  }

  /** Retries only a refused connection, which guarantees the server never saw the request. */
  private async withConnectRetries<T>(label: string, call: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await call();
      } catch (error) {
        if (attempt >= MAX_ATTEMPTS || !isConnectionRefused(error)) throw wrapNetworkError(label, error);
        await this.sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      }
    }
  }
}

function toHttpFailure(status: number, path: string, body: string): Error {
  if (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN) {
    return new AuthError(`${path} refused the token (HTTP ${status})${body ? `: ${body}` : ''}`);
  }
  if (status === HTTP_NOT_FOUND) {
    return new ConfigError(`${path} not found (HTTP ${status}) — check the plan id and API URL`);
  }
  return new HttpError(status, path, body);
}

function isRetryable(error: unknown): boolean {
  if (error instanceof HttpError) {
    return error.status === HTTP_TOO_MANY_REQUESTS || error.status >= HTTP_SERVER_ERROR_MIN;
  }
  // fetch rejects with a TypeError for network failures; anything else is ours.
  return error instanceof TypeError;
}

function isConnectionRefused(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  const cause = (error as { cause?: unknown }).cause;
  return typeof cause === 'object' && cause !== null && (cause as { code?: unknown }).code === 'ECONNREFUSED';
}

function wrapNetworkError(label: string, error: unknown): unknown {
  if (error instanceof TypeError) {
    return new InfraError(`${label}: network error (${error.message})`, { cause: error });
  }
  return error;
}

function toOutcome(row: Record<string, unknown>): TestCaseOutcome | undefined {
  const id = numberField(row, 'id');
  if (id === undefined || row['isPrerequisite'] === true) return undefined;
  const testCaseId = numberField(row, 'testCaseId');
  // The test case's current name first, as the run report shows it; the name the result row saved
  // at run time is only a fallback (it can be stale or a placeholder).
  const name =
    stringField(asRecord(row['testCase']), 'name') ??
    stringField(asRecord(row['testCaseDetails']), 'name') ??
    `Test case ${testCaseId ?? id}`;
  const outcome: TestCaseOutcome = {
    id,
    name,
    suite: stringField(asRecord(row['testSuite']), 'name') ?? 'ContextQA',
    result: stringField(row, 'result') ?? '',
    durationMs: numberField(row, 'duration') ?? 0,
    message: stringField(row, 'shortMessage') ?? stringField(row, 'message') ?? '',
    traceViewerUrl: stringField(row, 'traceViewerUrl'),
  };
  const executedResult = asRecord(parseJsonField(row['executedResult']));
  const failedStep = embeddedFailedStep(executedResult);
  if (failedStep) {
    outcome.failedStep = failedStep.step;
    if (failedStep.screenshotUrl) screenshotUrls.set(outcome, failedStep.screenshotUrl);
  }
  return outcome;
}

/**
 * The failed step the current execution engine records on the result row itself
 * (`executedResult.failed_test_steps`, with `cqa_failureContext` as the fallback for the error).
 */
function embeddedFailedStep(executedResult: Record<string, unknown>): { step: FailedStep; screenshotUrl?: string } | undefined {
  const failedSteps = Array.isArray(executedResult['failed_test_steps']) ? executedResult['failed_test_steps'] : [];
  const first = asRecord(failedSteps[0]);
  const failureContext = asRecord(executedResult['cqa_failureContext']);
  const contextError = stringField(asRecord(failureContext['error']), 'outputMessage');
  const message = stringField(first, 'reason') ?? stringField(first, 'actual_result') ?? contextError;
  const step = stringField(first, 'humanReadableText') ?? firstString(first['steps']) ?? '';
  if (!message && !step) return undefined;
  const screenshotUrl = httpUrl(stringField(first, 'stepScreenshotUrl'));
  return {
    step: {
      stepIndex: integerField(first, 'failed_step_index'),
      step,
      message: message ?? '',
      expected: stringField(first, 'expected_result'),
      type: stringField(first, 'type') ?? stringField(asRecord(failureContext['failure_classification']), 'category'),
      hasScreenshot: screenshotUrl !== undefined,
    },
    screenshotUrl,
  };
}

function toFailedStep(row: Record<string, unknown>): FailedStep | undefined {
  const stepResultId = numberField(row, 'id');
  if (stepResultId === undefined) return undefined;
  const details = asRecord(row['stepDetails']);
  const screenshotName = stringField(row, 'screenshotName');
  // Newer runs store a ready signed URL here (or in `screenshots`) instead of a file name.
  const screenshotUrl =
    httpUrl(screenshotName) ??
    httpUrl(stringField(asRecord(parseJsonField(row['screenshots'])), 'after')) ??
    httpUrl(stringField(asRecord(parseJsonField(row['screenshots'])), 'before'));
  const failedStep: FailedStep = {
    stepResultId,
    step: stringField(details, 'action') ?? stringField(details, 'stepDescription') ?? '',
    message: stringField(row, 'message') ?? failedLogText(row['logsList']) ?? '',
    exception: stringField(row, 'webDriverException'),
    hasScreenshot: screenshotName !== undefined || screenshotUrl !== undefined,
  };
  if (screenshotUrl) screenshotUrls.set(failedStep, screenshotUrl);
  return failedStep;
}

/** The text of the last failed entry in a step's `logsList`, where newer runs record the error. */
function failedLogText(logsList: unknown): string | undefined {
  const parsed = parseJsonField(logsList);
  const entries = Array.isArray(parsed) ? parsed : Array.isArray(asRecord(parsed)['logs']) ? (asRecord(parsed)['logs'] as unknown[]) : [];
  const failed = entries.map(asRecord).filter((entry) => stringField(entry, 'status') === 'failed');
  const last = failed[failed.length - 1];
  if (!last) return undefined;
  return meaningful(stringField(last, 'text')) ?? meaningful(stringField(last, 'value'));
}

/** The engine writes the string "None" for an empty log field. */
function meaningful(value: string | undefined): string | undefined {
  return value && value !== 'None' ? value : undefined;
}

function parseJsonField(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function firstString(value: unknown): string | undefined {
  return Array.isArray(value) && typeof value[0] === 'string' && value[0] !== '' ? value[0] : undefined;
}

function httpUrl(value: string | undefined): string | undefined {
  return value && /^https?:\/\//i.test(value) ? value : undefined;
}

/** `end - start` in ms for two server timestamps; undefined when either is missing or unparseable. */
function elapsedMs(start: string | undefined, end: string | undefined): number | undefined {
  if (!start || !end) return undefined;
  const elapsed = Date.parse(end) - Date.parse(start);
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(record: Record<string, unknown>, name: string): string | undefined {
  const value = record[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** A server timestamp as ISO-8601, whether it was sent as text or as epoch millis. */
function timestampField(record: Record<string, unknown>, name: string): string | undefined {
  const millis = numberField(record, name);
  return millis === undefined ? stringField(record, name) : new Date(millis).toISOString();
}

/** A whole number sent either as a JSON number or as text (`"3"`). */
function integerField(record: Record<string, unknown>, name: string): number | undefined {
  const value = record[name];
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof parsed === 'number' && Number.isInteger(parsed) ? parsed : undefined;
}

function numberField(record: Record<string, unknown>, name: string): number | undefined {
  const value = record[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function truncate(text: string): string {
  return text.length > ERROR_BODY_LIMIT ? `${text.slice(0, ERROR_BODY_LIMIT)}…` : text;
}
