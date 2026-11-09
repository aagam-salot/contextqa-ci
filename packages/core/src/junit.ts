import { dirname, join } from 'node:path';
import type { RunSummary, TestCaseOutcome } from './types.js';

const MS_PER_SECOND = 1_000;
const DEFAULT_SUITE = 'ContextQA';
const FAILED_RESULTS = new Set(['FAILURE']);
const ERRORED_RESULTS = new Set(['ABORTED']);
const PASSED_RESULT = 'SUCCESS';
const SCREENSHOT_DIR_NAME = 'contextqa-screenshots';

/** Where failed-step screenshots go for a JUnit report at `junitPath`: a folder beside it. */
export function screenshotDirFor(junitPath: string): string {
  return join(dirname(junitPath), SCREENSHOT_DIR_NAME);
}

/**
 * JUnit XML that GitLab, CircleCI, Azure DevOps, Bitbucket and Jenkins all
 * render natively. Without per-test detail (CI token), the whole run becomes a
 * single test case so the CI test tab still shows the verdict.
 *
 * Times: each test case carries its own duration. The run's `time` is its
 * wall-clock (cases run in parallel, so the sum of their durations overstates
 * it); a suite only knows its sum, unless it is the run's only suite.
 */
export function toJUnitXml(summary: RunSummary, planId: string): string {
  const cases = summary.testCases ?? [syntheticCase(summary, planId)];
  const suites = groupBySuite(cases);
  const wallClockMs = summary.results?.wallClockMs;
  const reportUrl = summary.reportUrl;

  const totals = tally(cases);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="ContextQA test plan ${xmlAttr(planId)}" tests="${cases.length}" failures="${totals.failures}" errors="${totals.errors}" skipped="${totals.skipped}" time="${seconds(wallClockMs ?? totals.durationMs)}">`,
  ];
  const onlySuite = suites.size === 1;
  for (const [suite, suiteCases] of suites) {
    const t = tally(suiteCases);
    const suiteMs = onlySuite ? (wallClockMs ?? t.durationMs) : t.durationMs;
    lines.push(
      `  <testsuite name="${xmlAttr(suite)}" tests="${suiteCases.length}" failures="${t.failures}" errors="${t.errors}" skipped="${t.skipped}" time="${seconds(suiteMs)}">`,
    );
    if (reportUrl) {
      lines.push('    <properties>', `      <property name="contextqa.report" value="${xmlAttr(reportUrl)}"/>`, '    </properties>');
    }
    for (const testCase of suiteCases) lines.push(...renderCase(suite, testCase, reportUrl));
    lines.push('  </testsuite>');
  }
  lines.push('</testsuites>', '');
  return lines.join('\n');
}

function renderCase(suite: string, testCase: TestCaseOutcome, reportUrl: string | undefined): string[] {
  const open = `    <testcase name="${xmlAttr(testCase.name)}" classname="${xmlAttr(suite)}" time="${seconds(testCase.durationMs)}"`;
  if (testCase.result === PASSED_RESULT) return [`${open}/>`];

  const step = testCase.failedStep;
  const message = testCase.message || step?.message || testCase.result || 'no result';
  const detail = [
    testCase.message,
    step?.step ? `Failed step: ${step.step}` : '',
    step?.message && step.message !== testCase.message ? `Error: ${step.message}` : '',
    step?.exception ? `Exception: ${step.exception}` : '',
    testCase.traceViewerUrl ? `Trace: ${testCase.traceViewerUrl}` : '',
    step && reportUrl ? `Report: ${reportUrl}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const tag = FAILED_RESULTS.has(testCase.result) ? 'failure' : ERRORED_RESULTS.has(testCase.result) ? 'error' : 'skipped';
  const lines = [
    `${open}>`,
    `      <${tag} message="${xmlAttr(message)}" type="${xmlAttr(testCase.result)}">${xmlText(detail)}</${tag}>`,
  ];
  if (testCase.screenshotPath) {
    // The attachment convention Jenkins (junit-attachments) and GitLab read. The path is relative to
    // the working directory, like the report's own path; the screenshot must be uploaded with it.
    lines.push(`      <system-out>${xmlText(`[[ATTACHMENT|${testCase.screenshotPath}]]`)}</system-out>`);
  }
  lines.push('    </testcase>');
  return lines;
}

function syntheticCase(summary: RunSummary, planId: string): TestCaseOutcome {
  const results = summary.results;
  const verdict = results?.result ?? 'NOT_EXECUTED';
  const message = results
    ? `${verdict}: ${results.passedCount} passed, ${results.failedCount} failed of ${results.totalCount}`
    : verdict;
  return {
    id: summary.runId,
    name: `Test plan ${planId} (run ${summary.runId})`,
    suite: DEFAULT_SUITE,
    // Without detail, any non-pass must surface as a failure, or the test tab hides it.
    result: summary.passed ? PASSED_RESULT : 'FAILURE',
    durationMs: results?.wallClockMs ?? results?.duration ?? 0,
    message,
    traceViewerUrl: summary.reportUrl,
  };
}

function groupBySuite(cases: TestCaseOutcome[]): Map<string, TestCaseOutcome[]> {
  const suites = new Map<string, TestCaseOutcome[]>();
  for (const testCase of cases) {
    const suite = testCase.suite || DEFAULT_SUITE;
    suites.set(suite, [...(suites.get(suite) ?? []), testCase]);
  }
  return suites;
}

function tally(cases: TestCaseOutcome[]): { failures: number; errors: number; skipped: number; durationMs: number } {
  let failures = 0;
  let errors = 0;
  let skipped = 0;
  let durationMs = 0;
  for (const testCase of cases) {
    durationMs += testCase.durationMs;
    if (testCase.result === PASSED_RESULT) continue;
    if (FAILED_RESULTS.has(testCase.result)) failures++;
    else if (ERRORED_RESULTS.has(testCase.result)) errors++;
    else skipped++;
  }
  return { failures, errors, skipped, durationMs };
}

function seconds(ms: number): string {
  return (ms / MS_PER_SECOND).toFixed(3);
}

// XML 1.0 forbids most control characters even when escaped.
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

function xmlText(value: string): string {
  return value
    .replace(INVALID_XML_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function xmlAttr(value: string): string {
  return xmlText(value).replace(/"/g, '&quot;').replace(/\n/g, '&#10;');
}
