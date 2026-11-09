import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeServer, fakeTime, json, results, text } from '../../core/test/fake-server.js';
import { runAction, type ActionIo } from '../src/main.js';
import { renderSummary } from '@contextqa/ci-core';

const TOKEN = 'token_acme.secret';

function fakeIo(inputs: Record<string, string>) {
  const outputs: Record<string, string | number> = {};
  const errors: { message: string; title?: string }[] = [];
  const failed: string[] = [];
  const secrets: string[] = [];
  const summaries: string[] = [];
  const io: ActionIo = {
    getInput: (name) => inputs[name] ?? '',
    setOutput: (name, value) => {
      outputs[name] = value;
    },
    setSecret: (value) => secrets.push(value),
    info: () => undefined,
    warning: () => undefined,
    error: (message, properties) => errors.push({ message, title: properties?.title }),
    setFailed: (message) => failed.push(message),
    writeSummary: async (markdown) => {
      summaries.push(markdown);
    },
  };
  return { io, outputs, errors, failed, secrets, summaries };
}

function failingServer(): FakeServer {
  return new FakeServer()
    .on('GET', '/test_plans/827/execution', () => json({ id: 77 }))
    .on('GET', '/test_plan_results/77/results', () => json(results({ result: 'FAILURE', passedCount: 1, failedCount: 1 })))
    .on('GET', '/test_case_results', () =>
      json({
        content: [
          { id: 1, result: 'SUCCESS', testCaseDetails: { name: 'Guest checkout' }, testSuite: { name: 'Checkout' } },
          {
            id: 2,
            result: 'FAILURE',
            shortMessage: 'Element not found: #submit',
            traceViewerUrl: 'https://trace/2',
            testCaseDetails: { name: 'Pay | saved card' },
            testSuite: { name: 'Checkout' },
          },
        ],
        last: true,
      }),
    );
}

describe('runAction', () => {
  it('passes, sets outputs and masks the token', async () => {
    const server = new FakeServer()
      .on('GET', '/test_plans/827/execution', () => json({ id: 77 }))
      .on('GET', '/test_plan_results/77/results', () => json(results()))
      .on('GET', '/test_case_results', () => json({ content: [], last: true }));
    const f = fakeIo({ 'plan-id': '827', token: TOKEN });

    await runAction(f.io, { fetch: server.fetch, ...fakeTime() });

    expect(f.failed).toEqual([]);
    expect(f.secrets).toEqual([TOKEN]);
    expect(f.outputs).toMatchObject({ 'run-id': 77, result: 'SUCCESS', passed: 'true', 'total-count': 2, 'failed-count': 0 });
    expect(f.summaries[0]).toContain('✅ **SUCCESS** · run 77');
    expect(server.requests[0]!.url.origin).toBe('https://server.contextqa.com');
  });

  it('fails the step, annotates failing tests and writes JUnit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cqa-action-'));
    const f = fakeIo({ 'plan-id': '827', token: TOKEN, 'junit-path': join(dir, 'reports/junit.xml') });

    await runAction(f.io, { fetch: failingServer().fetch, ...fakeTime() });

    expect(f.failed).toEqual(['Test plan 827 result was FAILURE']);
    expect(f.errors).toEqual([{ message: 'Element not found: #submit', title: 'ContextQA: Checkout › Pay | saved card' }]);
    expect(await readFile(join(dir, 'reports/junit.xml'), 'utf8')).toContain('failures="1"');
  });

  it('saves the failed step and its screenshot beside the JUnit report (CON-6433)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cqa-action-'));
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9]);
    const server = failingServer()
      .on('GET', '/test_step_results', () =>
        json({ content: [{ id: 501, result: 'FAILURE', message: 'Timed out', screenshotName: '501.png', stepDetails: { action: 'Click on Pay' } }] }),
      )
      .on('GET', '/test_step_results/501', () => json({ id: 501, screenShotURL: 'https://storage.example.com/shots/501.png?sig=x' }))
      .on('GET', '/shots/501.png', () => new Response(png, { status: 200 }));
    const junitPath = join(dir, 'reports/junit.xml');
    const f = fakeIo({ 'plan-id': '827', token: TOKEN, 'junit-path': junitPath });

    await runAction(f.io, { fetch: server.fetch, ...fakeTime() });

    const screenshot = join(dir, 'reports/contextqa-screenshots/2.png');
    expect(new Uint8Array(await readFile(screenshot))).toEqual(png);
    const xml = await readFile(junitPath, 'utf8');
    expect(xml).toContain('Failed step: Click on Pay');
    expect(xml).toContain(`[[ATTACHMENT|${screenshot}]]`);
    expect(f.summaries[0]).toContain('Element not found: #submit (failed step: Click on Pay)');
  });

  it('only reports when fail-on is never', async () => {
    const f = fakeIo({ 'plan-id': '827', token: TOKEN, 'fail-on': 'never' });

    await runAction(f.io, { fetch: failingServer().fetch, ...fakeTime() });

    expect(f.failed).toEqual([]);
    expect(f.outputs['passed']).toBe('false');
  });

  it('returns after triggering when wait is false', async () => {
    const server = new FakeServer().on('GET', '/test_plans/827/execution', () => json({ id: 77, url: 'https://r/77' }));
    const f = fakeIo({ 'plan-id': '827', token: TOKEN, wait: 'false' });

    await runAction(f.io, { fetch: server.fetch, ...fakeTime() });

    expect(f.failed).toEqual([]);
    expect(f.outputs).toEqual({ 'run-id': 77, 'report-url': 'https://r/77' });
    expect(f.summaries[0]).toContain('started without waiting');
  });

  it.each([
    [{ 'plan-id': '827' }, 'ContextQA token is missing'],
    [{ 'plan-id': 'abc', token: TOKEN }, 'plan id must be a number'],
    [{ 'plan-id': '827', token: TOKEN, 'fail-on': 'often' }, 'fail-on must be one of'],
    [{ 'plan-id': '827', token: TOKEN, timeout: '0' }, 'timeout must be a positive'],
  ])('fails cleanly on bad input %j', async (inputs, message) => {
    const f = fakeIo(inputs);
    await runAction(f.io, { fetch: new FakeServer().fetch, ...fakeTime() });
    expect(f.failed[0]).toContain(message);
  });

  it('reports a refused token as a failure, not a crash', async () => {
    const server = new FakeServer().on('GET', '/test_plans/827/execution', () => text('API Token is invalid or expired', 401));
    const f = fakeIo({ 'plan-id': '827', token: TOKEN });

    await runAction(f.io, { fetch: server.fetch, ...fakeTime() });

    expect(f.failed[0]).toContain('refused the token (HTTP 401)');
  });
});

describe('renderSummary', () => {
  it('escapes table cells and links failing tests to their trace', () => {
    const md = renderSummary(
      {
        runId: 7,
        passed: false,
        reportUrl: 'https://r/7',
        results: {
          status: 'STATUS_COMPLETED',
          result: 'FAILURE',
          duration: 408_000,
          totalCount: 2,
          passedCount: 1,
          failedCount: 1,
          abortedCount: 0,
          stoppedCount: 0,
          notExecutedCount: 0,
        },
        testCases: [
          { id: 1, name: 'a|b', suite: 'S', result: 'FAILURE', durationMs: 1, message: 'line1\nline2', traceViewerUrl: 'https://t/1' },
        ],
      },
      '827',
    );
    expect(md).toContain('| 2 | 1 | 1 | 0 | 0 | 0 | 6m 48s |');
    expect(md).toContain('| [a\\|b](https://t/1) | S | FAILURE | line1 line2 |');
    expect(md).toContain('[Open the full report in ContextQA](https://r/7)');
  });

  it('shows the run time and the test execution time side by side, rounded down like ContextQA (CON-6433)', () => {
    const markdown = renderSummary(
      {
        runId: 7,
        passed: false,
        results: {
          status: 'STATUS_COMPLETED',
          result: 'FAILURE',
          duration: 295_340,
          wallClockMs: 610_946,
          totalCount: 7,
          passedCount: 4,
          failedCount: 3,
          abortedCount: 0,
          stoppedCount: 0,
          notExecutedCount: 0,
        },
      },
      '2',
    );

    expect(markdown).toContain('| Total | Passed | Failed | Aborted | Stopped | Not run | Duration | Test execution time |');
    expect(markdown).toContain('| 7 | 4 | 3 | 0 | 0 | 0 | 10m 10s | 4m 55s |');
  });

  it('shows a dash for the test execution time when the server sends none', () => {
    const markdown = renderSummary(
      {
        runId: 7,
        passed: true,
        results: {
          status: 'STATUS_COMPLETED',
          result: 'SUCCESS',
          duration: null,
          wallClockMs: 5_000,
          totalCount: 1,
          passedCount: 1,
          failedCount: 0,
          abortedCount: 0,
          stoppedCount: 0,
          notExecutedCount: 0,
        },
      },
      '2',
    );

    expect(markdown).toContain('| 1 | 1 | 0 | 0 | 0 | 0 | 5s | — |');
  });

  it("annotates a failing test with its failed step's error when it has no short message (CON-6433)", async () => {
    const server = new FakeServer()
      .on('GET', '/test_plans/827/execution', () => json({ id: 77 }))
      .on('GET', '/test_plan_results/77/results', () => json(results({ result: 'FAILURE', passedCount: 0, failedCount: 1 })))
      .on('GET', '/test_case_results', () =>
        json({
          content: [
            {
              id: 3,
              result: 'FAILURE',
              shortMessage: null,
              testCase: { name: 'Reject short password' },
              testSuite: { name: 'Signup' },
              executedResult: { failed_test_steps: [{ humanReadableText: 'Verify the hint', reason: 'The hint is not shown' }] },
            },
          ],
          last: true,
        }),
      );
    const f = fakeIo({ 'plan-id': '827', token: TOKEN });

    await runAction(f.io, { fetch: server.fetch, ...fakeTime() });

    expect(f.errors).toEqual([{ message: 'The hint is not shown', title: 'ContextQA: Signup › Reject short password' }]);
  });

  it("shows the run's wall-clock as its duration (CON-6433)", () => {
    const markdown = renderSummary(
      {
        runId: 4512,
        passed: true,
        results: {
          status: 'STATUS_COMPLETED',
          result: 'SUCCESS',
          duration: 3_600_000,
          wallClockMs: 1_350_000,
          totalCount: 5,
          passedCount: 5,
          failedCount: 0,
          abortedCount: 0,
          stoppedCount: 0,
          notExecutedCount: 0,
        },
      },
      '15',
    );

    expect(markdown).toContain('| 22m 30s |');
    expect(markdown).not.toContain('59m');
  });

  it('explains missing per-test detail on a failed run', () => {
    const md = renderSummary(
      {
        runId: 7,
        passed: false,
        results: {
          status: 'STATUS_COMPLETED',
          result: 'FAILURE',
          totalCount: 1,
          passedCount: 0,
          failedCount: 1,
          abortedCount: 0,
          stoppedCount: 0,
          notExecutedCount: 0,
        },
      },
      '827',
    );
    expect(md).toContain('TEST_CASE_RESULTS_READ');
  });
});
