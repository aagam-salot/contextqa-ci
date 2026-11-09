import type { RunSummary, TestCaseOutcome } from './types.js';

const MS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;
/** Keeps the job summary readable and well under GitHub's 1 MiB limit. */
const MAX_LISTED_TESTS = 50;
const NOT_PASSING = new Set(['FAILURE', 'ABORTED']);

/** Markdown run summary, rendered by GitHub's job summary and Azure DevOps' Extensions tab. */
export function renderSummary(summary: RunSummary, planId: string): string {
  const lines = [`### ContextQA · test plan ${planId}`, ''];
  const r = summary.results;

  if (!r) {
    lines.push(`Run ${summary.runId} started without waiting for the result.`);
    if (summary.reportUrl) lines.push('', `[Open the run in ContextQA](${summary.reportUrl})`);
    return lines.join('\n') + '\n';
  }

  lines.push(
    `${summary.passed ? '✅' : '❌'} **${r.result}** · run ${summary.runId}`,
    '',
    '| Total | Passed | Failed | Aborted | Stopped | Not run | Duration |',
    '|---:|---:|---:|---:|---:|---:|---:|',
    `| ${r.totalCount} | ${r.passedCount} | ${r.failedCount} | ${r.abortedCount} | ${r.stoppedCount} | ${r.notExecutedCount} | ${duration(r.wallClockMs ?? r.duration ?? 0)} |`,
  );
  if (summary.reportUrl) lines.push('', `[Open the full report in ContextQA](${summary.reportUrl})`);

  const failing = (summary.testCases ?? []).filter((t) => NOT_PASSING.has(t.result));
  if (failing.length > 0) {
    lines.push('', '#### Failing test cases', '', '| Test case | Suite | Result | Message |', '|---|---|---|---|');
    for (const t of failing.slice(0, MAX_LISTED_TESTS)) lines.push(row(t));
    if (failing.length > MAX_LISTED_TESTS) lines.push('', `…and ${failing.length - MAX_LISTED_TESTS} more in the report.`);
  } else if (!summary.testCases && !summary.passed) {
    lines.push('', '_Per-test results need an API token with the `TEST_CASE_RESULTS_READ` permission._');
  }
  return lines.join('\n') + '\n';
}

/** Test cases that deserve an inline error annotation. */
export function failingTests(summary: RunSummary): TestCaseOutcome[] {
  return (summary.testCases ?? []).filter((t) => NOT_PASSING.has(t.result));
}

function row(t: TestCaseOutcome): string {
  const name = t.traceViewerUrl ? `[${cell(t.name)}](${t.traceViewerUrl})` : cell(t.name);
  const step = t.failedStep;
  const message = [t.message || step?.message || '', step?.step ? `(failed step: ${step.step})` : '']
    .filter(Boolean)
    .join(' ');
  return `| ${name} | ${cell(t.suite)} | ${t.result} | ${cell(message)} |`;
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function duration(ms: number): string {
  const total = Math.round(ms / MS_PER_SECOND);
  const minutes = Math.floor(total / SECONDS_PER_MINUTE);
  return minutes > 0 ? `${minutes}m ${total % SECONDS_PER_MINUTE}s` : `${total}s`;
}
