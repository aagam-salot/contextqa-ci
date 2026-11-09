# ContextQA for Azure Pipelines

A pipeline task that runs a ContextQA test plan, publishes the results to the run's **Tests** tab, adds a
summary to the **Extensions** tab, and fails unless the run passed.

```yaml
steps:
  - task: ContextQARunTestPlan@1
    inputs:
      planId: '827'
      token: $(CONTEXTQA_TOKEN)
      androidBuild: $(Build.ArtifactStagingDirectory)/app-release.apk   # optional
```

## Setup

1. Install the **ContextQA Test Plan** extension from the Visual Studio Marketplace into your organization.
2. Add `CONTEXTQA_TOKEN` as a **secret** pipeline variable (or in a variable group). Use an API token with
   `TEST_PLAN_EXECUTE` (which also covers build uploads) and `TEST_PLAN_RESULTS_READ`, plus `TEST_CASE_RESULTS_READ` for per-test results and `TEST_STEP_RESULTS_READ` for each failure's step and error. Azure does not expose secret variables to tasks on its
   own; the `token` input (or an `env:` mapping) is what passes it in.

## Inputs

| Input | Default | |
|---|---|---|
| `planId` | | required |
| `token` | `$(CONTEXTQA_TOKEN)` | |
| `androidBuild` / `iosBuild` | | path to upload, or an https URL; paths are relative to the sources directory |
| `environment` | the plan's own | |
| `failOn` | `failure` | `never` reports without failing |
| `apiUrl` | `https://server.contextqa.com` | |
| `timeout` | `3600` | seconds |
| `wait` | `true` | |
| `publishTestResults` | `true` | |
| `junitPath` | agent temp directory | |

Output variables: `runId`, `reportUrl`, `result`, `passed`, `totalCount`, `passedCount`, `failedCount`.
Give the step a `name:` to read them in later steps, e.g. `$(contextqa.result)`.
