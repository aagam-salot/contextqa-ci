# Changelog

Changes to the ContextQA CI integrations: the GitHub Action, the `contextqa` CLI and container image, and
the GitLab, CircleCI, Azure DevOps, Bitbucket and Jenkins wrappers. `@v1`, `:1` and `@1` always point to
the latest 1.x release, so these updates reach existing pipelines without any change on your side.

## 1.1.0 — 2026-11-11

Clearer CI reports: the right run time, the test names you see in ContextQA, and what failed, without
opening ContextQA.

### Improved

- **Run time matches ContextQA.** The job summary's *Duration* and the JUnit report's run time now show how
  long the run actually took, from start to finish. Test cases run in parallel, so this used to be reported
  as the sum of every test's time — a 22-minute run could show as 59 minutes. A new *Test execution time*
  column keeps that sum, as ContextQA's *Actual TC Execution Time* does.
- **Test names match ContextQA.** Each test is reported under its current name, as in the ContextQA run
  report, instead of the name saved when the run started.
- **Failures say what went wrong.** For each failed test, the JUnit report and the job summary show the
  step that failed, its error, the expected result and the failure type, with a link to the full ContextQA
  report. GitHub and Azure DevOps annotations show the error too, instead of only `FAILURE`.

### Added

- **Failed-step screenshots.** When you write a JUnit report (`junit-path` in the GitHub Action, `--junit`
  in the CLI), the failed step's screenshot is saved to a `contextqa-screenshots` folder beside it and
  attached to the test in Jenkins and GitLab. Upload that folder with the report to keep them. See
  *Keeping the JUnit report and its screenshots* in the [README](README.md).

### Permissions

- Run time, names and failure details work with the permissions you already have
  (`TEST_CASE_RESULTS_READ`).
- **Optional:** add `TEST_STEP_RESULTS_READ` to the token for every screenshot, and for failure details of
  runs from older ContextQA versions. Without it, the report is otherwise complete and only notes what it
  skipped.
- Mobile build uploads only need `TEST_PLAN_EXECUTE`; the docs no longer ask for a separate upload
  permission.

### Compatibility

- No change to inputs, outputs or exit codes, and a run's pass or fail verdict is decided exactly as
  before. Everything new is best effort: if ContextQA can't provide a detail, the report says so and the
  job continues.
- Screenshot links are short-lived and never written to logs, the job summary or `--json` output.

## 1.0.0 — 2026-10-16

First release: run a ContextQA test plan from CI and fail the job when it fails.

- GitHub Action, `contextqa` CLI and container image (`ghcr.io/indivatools/contextqa-cli`), GitLab
  component, CircleCI orb, Azure DevOps task, Bitbucket pipe and Jenkins shared library.
- Waits for the run and prints a summary with a link to the ContextQA report.
- Writes results as JUnit XML for your CI's test tab.
- Uploads a mobile build before the run.
