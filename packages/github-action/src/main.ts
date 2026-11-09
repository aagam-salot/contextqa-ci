import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  ContextQAError,
  ExitCode,
  RunTimeoutError,
  exitCodeFor,
  failingTests,
  failureText,
  renderSummary,
  runTestPlan,
  toJUnitXml,
  type RunDeps,
  type RunSummary,
} from '@contextqa/ci-core';
import { readInputs } from './inputs.js';

/** GitHub caps error annotations per step at 10; more are dropped silently. */
const MAX_ANNOTATIONS = 10;

/** The slice of `@actions/core` this action uses, so it can be faked in tests. */
export interface ActionIo {
  getInput(name: string): string;
  setOutput(name: string, value: string | number): void;
  setSecret(value: string): void;
  info(message: string): void;
  warning(message: string): void;
  error(message: string, properties?: { title?: string }): void;
  setFailed(message: string): void;
  writeSummary(markdown: string): Promise<void>;
}

export async function runAction(io: ActionIo, deps: RunDeps = {}): Promise<void> {
  try {
    const config = readInputs((name) => io.getInput(name));
    if (config.run.token) io.setSecret(config.run.token);

    const summary = await runTestPlan(config.run, { info: io.info, warn: io.warning }, deps);
    setOutputs(io, summary);
    await io.writeSummary(renderSummary(summary, config.run.planId));
    if (!config.run.wait) return;

    if (config.junitPath) {
      await mkdir(dirname(config.junitPath), { recursive: true });
      await writeFile(config.junitPath, toJUnitXml(summary, config.run.planId), 'utf8');
    }
    for (const t of failingTests(summary).slice(0, MAX_ANNOTATIONS)) {
      io.error(failureText(t), { title: `ContextQA: ${t.suite} › ${t.name}` });
    }

    if (exitCodeFor(summary, config.failOn) !== ExitCode.PASSED) {
      io.setFailed(`Test plan ${config.run.planId} result was ${summary.results?.result ?? 'unknown'}`);
    }
  } catch (error) {
    io.setFailed(failureMessage(error));
  }
}

function setOutputs(io: ActionIo, summary: RunSummary): void {
  io.setOutput('run-id', summary.runId);
  io.setOutput('report-url', summary.reportUrl ?? '');
  const r = summary.results;
  if (!r) return;
  io.setOutput('result', r.result);
  io.setOutput('passed', String(summary.passed));
  io.setOutput('total-count', r.totalCount);
  io.setOutput('passed-count', r.passedCount);
  io.setOutput('failed-count', r.failedCount);
}

function failureMessage(error: unknown): string {
  if (error instanceof RunTimeoutError && error.reportUrl) {
    return `${error.message}. It is still running: ${error.reportUrl}`;
  }
  if (error instanceof ContextQAError) return error.message;
  return `Unexpected failure: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`;
}
