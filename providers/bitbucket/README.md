# ContextQA for Bitbucket Pipelines

Bitbucket runs any public image as a pipe, so the ContextQA CLI image is the pipe. Options are passed as
pipe variables, which the CLI reads as `CONTEXTQA_*` environment variables.

```yaml
pipelines:
  branches:
    main:
      - step:
          name: ContextQA
          script:
            - pipe: docker://ghcr.io/indivatools/contextqa-cli:1
              variables:
                CONTEXTQA_TOKEN: $CONTEXTQA_TOKEN
                CONTEXTQA_PLAN_ID: '827'
                CONTEXTQA_ANDROID_BUILD: build/app-release.apk   # optional
                CONTEXTQA_JUNIT_PATH: test-results/contextqa.xml
```

1. Add `CONTEXTQA_TOKEN` as a **secured** repository or deployment variable. Use an API token with
   `TEST_PLAN_EXECUTE` (which also covers build uploads) and `TEST_PLAN_RESULTS_READ`, plus `TEST_CASE_RESULTS_READ` for per-test results and `TEST_STEP_RESULTS_READ` for each failure's step and error.
2. Keep `CONTEXTQA_JUNIT_PATH` under `test-results/`. Bitbucket reads JUnit from there automatically and
   shows failures on the step's **Tests** tab.

The step fails unless the run passes. Set `CONTEXTQA_FAIL_ON: never` to only report.

| Variable | Required | Default |
|---|---|---|
| `CONTEXTQA_TOKEN` | yes | |
| `CONTEXTQA_PLAN_ID` | yes | |
| `CONTEXTQA_API_URL` | | `https://server.contextqa.com` |
| `CONTEXTQA_ENVIRONMENT` | | the plan's own |
| `CONTEXTQA_ANDROID_BUILD` / `CONTEXTQA_IOS_BUILD` | | path to upload, or an https URL |
| `CONTEXTQA_TIMEOUT` | | `3600` seconds |
| `CONTEXTQA_JUNIT_PATH` | | none |
| `CONTEXTQA_FAIL_ON` | | `failure` |

Bitbucket's step limit is 120 minutes by default; raise `max-time` on the step if `CONTEXTQA_TIMEOUT` is
longer.
