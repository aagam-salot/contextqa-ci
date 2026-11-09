import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  ConfigError,
  ContextQAError,
  ExitCode,
  FAIL_ON_VALUES,
  RunTimeoutError,
  exitCodeFor,
  failingTests,
  failureText,
  renderSummary,
  runTestPlan,
  toBuildSource,
  toJUnitXml,
  type FailOn,
  type RunDeps,
  type RunOptions,
  type RunSummary,
} from '@contextqa/ci-core';

const DEFAULT_API_URL = 'https://server.contextqa.com';
const DEFAULT_TIMEOUT_SECONDS = 3600;
const DEFAULT_POLL_INTERVAL_SECONDS = 15;
/** Keeps the run's Errors list readable; the full list is on the Tests tab. */
const MAX_ISSUES = 10;

/** What the task needs from the agent; implemented with logging commands in index.ts. */
export interface TaskIo {
  /** Value of a task.json input, '' when unset. */
  getInput(name: string): string;
  /** Agent or pipeline variable read from the environment, e.g. AGENT_TEMPDIRECTORY. */
  getEnv(name: string): string | undefined;
  info(message: string): void;
  warning(message: string): void;
  error(message: string): void;
  setSecret(value: string): void;
  setOutput(name: string, value: string): void;
  publishJUnit(path: string, title: string): void;
  uploadSummary(path: string): void;
  fail(message: string): void;
}

interface TaskConfig {
  run: RunOptions;
  failOn: FailOn;
  junitPath: string;
  publish: boolean;
}

export async function runTask(io: TaskIo, deps: RunDeps = {}): Promise<void> {
  try {
    const config = readConfig(io);
    if (config.run.token) io.setSecret(config.run.token);

    const summary = await runTestPlan(config.run, { info: io.info, warn: io.warning }, deps);
    setOutputs(io, summary);
    await writeSummary(io, summary, config);
    if (!config.run.wait) return;

    await mkdir(dirname(config.junitPath), { recursive: true });
    await writeFile(config.junitPath, toJUnitXml(summary, config.run.planId), 'utf8');
    if (config.publish) io.publishJUnit(config.junitPath, `ContextQA test plan ${config.run.planId}`);
    for (const t of failingTests(summary).slice(0, MAX_ISSUES)) {
      io.error(`ContextQA: ${t.suite} › ${t.name}: ${failureText(t)}`);
    }

    if (exitCodeFor(summary, config.failOn) !== ExitCode.PASSED) {
      io.fail(`Test plan ${config.run.planId} result was ${summary.results?.result ?? 'unknown'}`);
    }
  } catch (error) {
    io.fail(failureMessage(error));
  }
}

function readConfig(io: TaskIo): TaskConfig {
  const input = (name: string): string | undefined => io.getInput(name).trim() || undefined;

  const failOn = input('failOn') ?? 'failure';
  if (!(FAIL_ON_VALUES as readonly string[]).includes(failOn)) {
    throw new ConfigError(`failOn must be one of ${FAIL_ON_VALUES.join(', ')}`);
  }
  // A secret pipeline variable is only visible to a task through an input or an
  // explicit env: mapping, so accept either.
  const token = input('token') ?? io.getEnv('CONTEXTQA_TOKEN')?.trim() ?? '';
  const workDir = io.getEnv('SYSTEM_DEFAULTWORKINGDIRECTORY') ?? process.cwd();
  const tempDir = io.getEnv('AGENT_TEMPDIRECTORY') ?? workDir;

  return {
    run: {
      apiUrl: input('apiUrl') ?? DEFAULT_API_URL,
      token,
      planId: input('planId') ?? '',
      environment: input('environment'),
      androidBuild: resolveBuild(input('androidBuild'), workDir),
      iosBuild: resolveBuild(input('iosBuild'), workDir),
      wait: (input('wait') ?? 'true').toLowerCase() !== 'false',
      timeoutSeconds: seconds(input('timeout'), DEFAULT_TIMEOUT_SECONDS, 'timeout'),
      pollIntervalSeconds: seconds(input('pollInterval'), DEFAULT_POLL_INTERVAL_SECONDS, 'pollInterval'),
    },
    failOn: failOn as FailOn,
    junitPath: resolve(workDir, input('junitPath') ?? join(tempDir, 'contextqa', 'contextqa-junit.xml')),
    publish: (input('publishTestResults') ?? 'true').toLowerCase() !== 'false',
  };
}

/** Relative build paths are relative to the sources directory, as in other Azure tasks. */
function resolveBuild(value: string | undefined, workDir: string): RunOptions['androidBuild'] {
  const source = toBuildSource(value);
  return source?.kind === 'file' ? { kind: 'file', path: resolve(workDir, source.path) } : source;
}

function seconds(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new ConfigError(`${name} must be a positive number of seconds`);
  return parsed;
}

function setOutputs(io: TaskIo, summary: RunSummary): void {
  io.setOutput('runId', String(summary.runId));
  io.setOutput('reportUrl', summary.reportUrl ?? '');
  const r = summary.results;
  if (!r) return;
  io.setOutput('result', r.result);
  io.setOutput('passed', String(summary.passed));
  io.setOutput('totalCount', String(r.totalCount));
  io.setOutput('passedCount', String(r.passedCount));
  io.setOutput('failedCount', String(r.failedCount));
}

async function writeSummary(io: TaskIo, summary: RunSummary, config: TaskConfig): Promise<void> {
  const path = join(dirname(config.junitPath), 'contextqa-summary.md');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, renderSummary(summary, config.run.planId), 'utf8');
  io.uploadSummary(path);
}

function failureMessage(error: unknown): string {
  if (error instanceof RunTimeoutError && error.reportUrl) {
    return `${error.message}. It is still running: ${error.reportUrl}`;
  }
  if (error instanceof ContextQAError) return error.message;
  return `Unexpected failure: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`;
}
