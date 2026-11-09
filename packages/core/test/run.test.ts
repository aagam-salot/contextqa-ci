import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { authHeaders } from '../src/auth.js';
import { AuthError, ConfigError, InfraError, RunTimeoutError } from '../src/errors.js';
import { runTestPlan } from '../src/run.js';
import type { RunOptions } from '../src/types.js';
import { FakeServer, fakeTime, json, recordingReporter, results, text } from './fake-server.js';

const API_TOKEN = 'token_acme.secret123';
const CI_TOKEN = 'b64-ci-token==';
const PUT_URL = 'https://uploads.example.com/acme/builds/x-app.apk?X-Amz-Signature=SECRET';

function options(overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    apiUrl: 'https://api.example.com/',
    token: API_TOKEN,
    planId: '827',
    wait: true,
    pollIntervalSeconds: 15,
    timeoutSeconds: 3600,
    ...overrides,
  };
}

function testCaseRow(id: number, result: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    testCaseId: id + 1000,
    result,
    duration: 1500,
    shortMessage: result === 'FAILURE' ? 'Element not found: #submit' : null,
    testCaseDetails: { name: `Case ${id}` },
    testSuite: { name: 'Checkout' },
    ...extra,
  };
}

describe('authHeaders', () => {
  it('sends an API token as a Bearer credential', () => {
    expect(authHeaders(API_TOKEN)).toEqual({ Authorization: `Bearer ${API_TOKEN}` });
  });

  it('sends a legacy CI token in the token header', () => {
    expect(authHeaders(CI_TOKEN)).toEqual({ token: CI_TOKEN });
  });
});

describe('runTestPlan', () => {
  it('triggers, polls to completion and collects per-test results', async () => {
    const server = new FakeServer()
      .on('GET', '/test_plans/827/execution', () => json({ id: 77, url: 'https://app.example.com/td/runs/77' }))
      .on(
        'GET',
        '/test_plan_results/77/results',
        () => json(results({ status: 'STATUS_IN_PROGRESS', result: 'IN_PROGRESS', passedCount: 1 })),
        () => json(results()),
      )
      .on('GET', '/test_case_results', () =>
        json({ content: [testCaseRow(1, 'SUCCESS'), testCaseRow(2, 'SUCCESS'), testCaseRow(3, 'SUCCESS', { isPrerequisite: true })], last: true }),
      );
    const time = fakeTime();
    const reporter = recordingReporter();

    const summary = await runTestPlan(options({ environment: '2' }), reporter, { fetch: server.fetch, ...time });

    expect(summary.passed).toBe(true);
    expect(summary.runId).toBe(77);
    expect(summary.reportUrl).toBe('https://app.example.com/td/runs/77');
    expect(summary.testCases?.map((t) => t.name)).toEqual(['Case 1', 'Case 2']);

    const trigger = server.calls('/test_plans/827/execution')[0]!;
    expect(trigger.url.origin).toBe('https://api.example.com');
    expect(trigger.url.searchParams.get('environment')).toBe('2');
    expect(trigger.url.searchParams.has('apk_build_url')).toBe(false);
    expect(trigger.headers.get('authorization')).toBe(`Bearer ${API_TOKEN}`);

    const listing = server.calls('/test_case_results')[0]!;
    expect(listing.url.searchParams.get('query')).toBe('testPlanResultId:77,iteration:null');
    expect(time.slept).toEqual([15_000, 15_000]);
  });

  it('returns a failed verdict without throwing', async () => {
    const server = new FakeServer()
      .on('GET', '/test_plans/827/execution', () => json({ id: 77 }))
      .on('GET', '/test_plan_results/77/results', () => json(results({ result: 'FAILURE', passedCount: 1, failedCount: 1 })))
      .on('GET', '/test_case_results', () => json({ content: [testCaseRow(1, 'SUCCESS'), testCaseRow(2, 'FAILURE')], last: true }));

    const summary = await runTestPlan(options(), recordingReporter(), { fetch: server.fetch, ...fakeTime() });

    expect(summary.passed).toBe(false);
    expect(summary.testCases?.[1]?.message).toBe('Element not found: #submit');
  });

  it('does not treat a stopped run with zero failures as a pass', async () => {
    const server = new FakeServer()
      .on('GET', '/test_plans/827/execution', () => json({ id: 77 }))
      .on('GET', '/test_plan_results/77/results', () => json(results({ result: 'STOPPED', passedCount: 0, stoppedCount: 2 })))
      .on('GET', '/test_case_results', () => json({ content: [], last: true }));

    const summary = await runTestPlan(options(), recordingReporter(), { fetch: server.fetch, ...fakeTime() });

    expect(summary.passed).toBe(false);
  });

  it('pages through test case results', async () => {
    const server = new FakeServer()
      .on('GET', '/test_plans/827/execution', () => json({ id: 77 }))
      .on('GET', '/test_plan_results/77/results', () => json(results()))
      .on(
        'GET',
        '/test_case_results',
        () => json({ content: [testCaseRow(1, 'SUCCESS')], last: false }),
        () => json({ content: [testCaseRow(2, 'SUCCESS')], last: true }),
      );

    const summary = await runTestPlan(options(), recordingReporter(), { fetch: server.fetch, ...fakeTime() });

    expect(summary.testCases).toHaveLength(2);
    expect(server.calls('/test_case_results').map((r) => r.url.searchParams.get('page'))).toEqual(['0', '1']);
  });

  it('skips per-test results for a legacy CI token and sends it in the token header', async () => {
    const server = new FakeServer()
      .on('GET', '/test_plans/827/execution', () => json({ id: 77 }))
      .on('GET', '/test_plan_results/77/results', () => json(results()));
    const reporter = recordingReporter();

    const summary = await runTestPlan(options({ token: CI_TOKEN }), reporter, { fetch: server.fetch, ...fakeTime() });

    expect(summary.passed).toBe(true);
    expect(summary.testCases).toBeUndefined();
    expect(server.calls('/test_case_results')).toHaveLength(0);
    expect(server.requests[0]!.headers.get('token')).toBe(CI_TOKEN);
    expect(server.requests[0]!.headers.has('authorization')).toBe(false);
  });

  it('keeps the verdict when the token lacks TEST_CASE_RESULTS_READ', async () => {
    const server = new FakeServer()
      .on('GET', '/test_plans/827/execution', () => json({ id: 77 }))
      .on('GET', '/test_plan_results/77/results', () => json(results()))
      .on('GET', '/test_case_results', () => text('Token does not have required permission', 403));
    const reporter = recordingReporter();

    const summary = await runTestPlan(options(), reporter, { fetch: server.fetch, ...fakeTime() });

    expect(summary.passed).toBe(true);
    expect(summary.testCases).toBeUndefined();
    expect(reporter.lines.some((l) => l.includes('TEST_CASE_RESULTS_READ'))).toBe(true);
  });

  it('rides out poll failures until the run completes', async () => {
    const server = new FakeServer()
      .on('GET', '/test_plans/827/execution', () => json({ id: 77 }))
      .on(
        'GET',
        '/test_plan_results/77/results',
        () => text('bad gateway', 502),
        () => text('bad gateway', 502),
        () => text('bad gateway', 502),
        () => json(results()),
      )
      .on('GET', '/test_case_results', () => json({ content: [], last: true }));
    const reporter = recordingReporter();

    const summary = await runTestPlan(options(), reporter, { fetch: server.fetch, ...fakeTime() });

    expect(summary.passed).toBe(true);
    expect(reporter.lines.some((l) => l.startsWith('WARN Polling run 77 failed'))).toBe(true);
  });

  it('fails fast when the token is refused while polling', async () => {
    const server = new FakeServer()
      .on('GET', '/test_plans/827/execution', () => json({ id: 77 }))
      .on('GET', '/test_plan_results/77/results', () => text('Token is not found', 401));

    await expect(runTestPlan(options(), recordingReporter(), { fetch: server.fetch, ...fakeTime() })).rejects.toBeInstanceOf(
      AuthError,
    );
    expect(server.calls('/test_plan_results/77/results')).toHaveLength(1);
  });

  it('times out with the run link when the plan never completes', async () => {
    const server = new FakeServer()
      .on('GET', '/test_plans/827/execution', () => json({ id: 77, url: 'https://app.example.com/td/runs/77' }))
      .on('GET', '/test_plan_results/77/results', () => json(results({ status: 'STATUS_IN_PROGRESS', result: 'IN_PROGRESS' })));

    const error = await runTestPlan(options({ timeoutSeconds: 60 }), recordingReporter(), {
      fetch: server.fetch,
      ...fakeTime(),
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RunTimeoutError);
    expect((error as RunTimeoutError).reportUrl).toBe('https://app.example.com/td/runs/77');
  });

  it('does not retry the trigger on a server error, since that could start a second run', async () => {
    const server = new FakeServer().on('GET', '/test_plans/827/execution', () => text('boom', 500));

    await expect(runTestPlan(options(), recordingReporter(), { fetch: server.fetch, ...fakeTime() })).rejects.toBeInstanceOf(
      InfraError,
    );
    expect(server.calls('/test_plans/827/execution')).toHaveLength(1);
  });

  it('reports an unknown plan as a configuration error', async () => {
    const server = new FakeServer().on('GET', '/test_plans/827/execution', () => text('', 404));

    await expect(runTestPlan(options(), recordingReporter(), { fetch: server.fetch, ...fakeTime() })).rejects.toBeInstanceOf(
      ConfigError,
    );
  });

  it('returns right after triggering when not waiting', async () => {
    const server = new FakeServer().on('GET', '/test_plans/827/execution', () => json({ id: 77, url: 'u' }));

    const summary = await runTestPlan(options({ wait: false }), recordingReporter(), { fetch: server.fetch, ...fakeTime() });

    expect(summary).toEqual({ runId: 77, reportUrl: 'u', passed: true });
    expect(server.requests).toHaveLength(1);
  });

  it('uploads a local build and triggers with the object key, never logging the presigned URL', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cqa-'));
    const apk = join(dir, 'app release.apk');
    await writeFile(apk, 'APK-BYTES');
    const server = new FakeServer()
      .on('GET', '/test_plans/build_upload_url', () => json({ key: 'acme/builds/x-app.apk', putUrl: PUT_URL }))
      .on('PUT', 'upload', () => new Response(null, { status: 200 }))
      .on('GET', '/test_plans/827/execution', () => json({ id: 77 }))
      .on('GET', '/test_plan_results/77/results', () => json(results()))
      .on('GET', '/test_case_results', () => json({ content: [], last: true }));
    const reporter = recordingReporter();

    await runTestPlan(
      options({ androidBuild: { kind: 'file', path: apk }, iosBuild: { kind: 'url', url: 'https://cdn.example.com/a.ipa?x=1&y=2' } }),
      reporter,
      { fetch: server.fetch, ...fakeTime() },
    );

    expect(server.calls('/test_plans/build_upload_url')[0]!.url.searchParams.get('file_name')).toBe('app release.apk');
    const put = server.requests.find((r) => r.method === 'PUT')!;
    expect(new TextDecoder().decode(put.body)).toBe('APK-BYTES');
    expect(put.headers.has('authorization')).toBe(false);
    const trigger = server.calls('/test_plans/827/execution')[0]!;
    expect(trigger.url.searchParams.get('apk_build_url')).toBe('acme/builds/x-app.apk');
    expect(trigger.url.searchParams.get('ipa_build_url')).toBe('https://cdn.example.com/a.ipa?x=1&y=2');
    expect(reporter.lines.join('\n')).not.toContain('SECRET');
  });

  it('keeps the presigned URL out of upload errors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cqa-'));
    const apk = join(dir, 'app.apk');
    await writeFile(apk, 'x');
    const server = new FakeServer()
      .on('GET', '/test_plans/build_upload_url', () => json({ key: 'k', putUrl: PUT_URL }))
      .on('PUT', 'upload', () => text('AccessDenied', 403));

    const error = await runTestPlan(options({ androidBuild: { kind: 'file', path: apk } }), recordingReporter(), {
      fetch: server.fetch,
      ...fakeTime(),
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InfraError);
    expect(String((error as Error).message)).not.toContain('SECRET');
  });

  it('rejects a missing build file before calling the server', async () => {
    const server = new FakeServer();

    await expect(
      runTestPlan(options({ androidBuild: { kind: 'file', path: '/nope/app.apk' } }), recordingReporter(), {
        fetch: server.fetch,
        ...fakeTime(),
      }),
    ).rejects.toThrow('no Android build at /nope/app.apk');
    expect(server.requests).toHaveLength(0);
  });

  it.each([
    [{ token: '' }, 'ContextQA token is missing'],
    [{ planId: '82 7' }, 'plan id must be a number'],
    [{ apiUrl: 'server.contextqa.com' }, 'API URL is not a valid URL'],
    [{ pollIntervalSeconds: 0 }, 'positive'],
  ])('validates options %o', async (override, message) => {
    await expect(runTestPlan(options(override), recordingReporter(), { fetch: new FakeServer().fetch })).rejects.toThrow(
      message,
    );
  });
});

describe('runTestPlan reports for CI (CON-6433)', () => {
  function server(caseRows: Record<string, unknown>[], extraResults: Record<string, unknown> = {}): FakeServer {
    return new FakeServer()
      .on('GET', '/test_plans/827/execution', () => json({ id: 77 }))
      .on('GET', '/test_plan_results/77/results', () => json(results(extraResults)))
      .on('GET', '/test_case_results', () => json({ content: caseRows, last: true }));
  }

  it("works out the run's wall-clock from its start and end", async () => {
    const fake = server([], { startTime: '2026-01-10T10:00:00.000+00:00', endTime: '2026-01-10T10:22:30.000+00:00', duration: 3_600_000 });

    const summary = await runTestPlan(options(), recordingReporter(), { fetch: fake.fetch, ...fakeTime() });

    expect(summary.results?.wallClockMs).toBe(1_350_000);
    expect(summary.results?.duration).toBe(3_600_000);
  });

  it('reads start and end sent as epoch millis too', async () => {
    const fake = server([], { startTime: 1_768_039_200_000, endTime: 1_768_040_550_000 });

    const summary = await runTestPlan(options(), recordingReporter(), { fetch: fake.fetch, ...fakeTime() });

    expect(summary.results?.wallClockMs).toBe(1_350_000);
  });

  it('leaves the wall-clock undefined without a start or an end', async () => {
    const fake = server([], { startTime: '2026-01-10T10:00:00Z', endTime: null });

    const summary = await runTestPlan(options(), recordingReporter(), { fetch: fake.fetch, ...fakeTime() });

    expect(summary.results?.wallClockMs).toBeUndefined();
  });

  it("names each test after the test case's current name, falling back to the saved one", async () => {
    const fake = server([
      testCaseRow(1, 'SUCCESS', { testCaseDetails: { name: 'Placeholder name' }, testCase: { name: 'TC-12 Checkout with saved card' } }),
      testCaseRow(2, 'SUCCESS', { testCaseDetails: { name: 'Saved name' }, testCase: null }),
      testCaseRow(3, 'SUCCESS', { testCaseDetails: null, testCase: null }),
    ]);

    const summary = await runTestPlan(options(), recordingReporter(), { fetch: fake.fetch, ...fakeTime() });

    expect(summary.testCases?.map((t) => t.name)).toEqual(['TC-12 Checkout with saved card', 'Saved name', 'Test case 1003']);
  });

  it('adds the failed step and saves its screenshot without sending the token to storage', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'cqa-shots-')), 'contextqa-screenshots');
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const fake = server([testCaseRow(1, 'SUCCESS'), testCaseRow(2, 'FAILURE')], { result: 'FAILURE' })
      .on('GET', '/test_step_results', () =>
        json({
          content: [
            { id: 500, result: 'SUCCESS', stepDetails: { action: 'Open login' } },
            { id: 501, result: 'FAILURE', message: 'Timed out after 30s', webDriverException: 'NoSuchElementException', screenshotName: '501.png', stepDetails: { action: 'Click on Submit' } },
            { id: 502, result: 'FAILURE', message: 'later', stepDetails: { action: 'Later step' } },
          ],
        }),
      )
      .on('GET', '/test_step_results/501', () => json({ id: 501, screenShotURL: 'https://storage.example.com/shots/501.png?X-Amz-Signature=SECRET' }))
      .on('GET', '/shots/501.png', () => new Response(png, { status: 200 }));
    const reporter = recordingReporter();

    const summary = await runTestPlan(options({ screenshotDir: dir }), reporter, { fetch: fake.fetch, ...fakeTime() });

    expect(summary.passed).toBe(false);
    const failed = summary.testCases?.find((t) => t.id === 2);
    expect(failed?.failedStep).toEqual({
      stepResultId: 501,
      step: 'Click on Submit',
      message: 'Timed out after 30s',
      exception: 'NoSuchElementException',
      hasScreenshot: true,
    });
    expect(failed?.screenshotPath).toBe(join(dir, '2.png'));
    expect(new Uint8Array(await readFile(join(dir, '2.png')))).toEqual(png);
    expect(summary.testCases?.find((t) => t.id === 1)?.failedStep).toBeUndefined();

    const listing = fake.calls('/test_step_results')[0]!;
    expect(listing.url.searchParams.get('query')).toBe('testCaseResultId:2');
    const download = fake.calls('/shots/501.png')[0]!;
    expect(download.headers.get('authorization')).toBeNull();
    expect(reporter.lines.join('\n')).not.toContain('SECRET');
  });

  it('keeps the short message when the token may not read step results', async () => {
    const fake = server([testCaseRow(2, 'FAILURE'), testCaseRow(3, 'FAILURE')], { result: 'FAILURE' }).on(
      'GET',
      '/test_step_results',
      () => text('Forbidden', 403),
    );
    const reporter = recordingReporter();

    const summary = await runTestPlan(options({ screenshotDir: '/tmp/never' }), reporter, { fetch: fake.fetch, ...fakeTime() });

    expect(summary.passed).toBe(false);
    expect(summary.testCases?.every((t) => t.failedStep === undefined && t.screenshotPath === undefined)).toBe(true);
    expect(summary.testCases?.[0]?.message).toBe('Element not found: #submit');
    expect(fake.calls('/test_step_results')).toHaveLength(1);
    expect(reporter.lines).toContain('WARN Failure details skipped: the token lacks the TEST_STEP_RESULTS_READ permission.');
  });

  it('adds the failed step but downloads nothing when no screenshot folder is given', async () => {
    const fake = server([testCaseRow(2, 'FAILURE')], { result: 'FAILURE' }).on('GET', '/test_step_results', () =>
      json({ content: [{ id: 501, result: 'FAILURE', message: 'Timed out', screenshotName: '501.png', stepDetails: { action: 'Click' } }] }),
    );

    const summary = await runTestPlan(options(), recordingReporter(), { fetch: fake.fetch, ...fakeTime() });

    expect(summary.testCases?.[0]?.failedStep?.step).toBe('Click');
    expect(summary.testCases?.[0]?.screenshotPath).toBeUndefined();
    expect(fake.calls('/test_step_results/501')).toHaveLength(0);
  });

  it('still reports the step when its screenshot cannot be fetched', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'cqa-shots-')), 'contextqa-screenshots');
    const fake = server([testCaseRow(2, 'FAILURE')], { result: 'FAILURE' })
      .on('GET', '/test_step_results', () =>
        json({ content: [{ id: 501, result: 'FAILURE', message: 'Timed out', screenshotName: '501.png', stepDetails: { action: 'Click' } }] }),
      )
      .on('GET', '/test_step_results/501', () => json({ id: 501, screenShotURL: 'https://storage.example.com/shots/501.png?sig=SECRET' }))
      .on('GET', '/shots/501.png', () => text('expired', 403));
    const reporter = recordingReporter();

    const summary = await runTestPlan(options({ screenshotDir: dir }), reporter, { fetch: fake.fetch, ...fakeTime() });

    expect(summary.testCases?.[0]?.failedStep?.step).toBe('Click');
    expect(summary.testCases?.[0]?.screenshotPath).toBeUndefined();
    expect(reporter.lines.some((l) => l.startsWith('WARN Screenshot for test case result 2 not saved'))).toBe(true);
    expect(reporter.lines.join('\n')).not.toContain('SECRET');
  });

  it('makes no step-result calls for a passing run', async () => {
    const fake = server([testCaseRow(1, 'SUCCESS')]);

    await runTestPlan(options({ screenshotDir: '/tmp/never' }), recordingReporter(), { fetch: fake.fetch, ...fakeTime() });

    expect(fake.calls('/test_step_results')).toHaveLength(0);
  });
});
