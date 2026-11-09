# ContextQA for GitLab CI/CD

A [CI/CD component](https://docs.gitlab.com/ci/components/) that runs a ContextQA test plan and fails the
pipeline unless it passes. Results show in the merge request's test summary and the pipeline's **Tests** tab.

```yaml
include:
  - component: gitlab.com/contextqa/contextqa-ci/run-test-plan@1
    inputs:
      plan-id: "827"
      android-build: build/app-release.apk   # optional, e.g. an artifact from your build job
```

1. Add `CONTEXTQA_TOKEN` under **Settings › CI/CD › Variables**, masked (and protected if only protected
   branches run it). Use an API token with `TEST_PLAN_EXECUTE` (which also covers build uploads) and `TEST_PLAN_RESULTS_READ`, plus `TEST_CASE_RESULTS_READ` for per-test results and failure details (optionally `TEST_STEP_RESULTS_READ` for older runs' failure details).
2. Include the component. It adds one job (default name `contextqa`, stage `test`).

All inputs are listed in [`templates/run-test-plan.yml`](templates/run-test-plan.yml).

## Self-managed GitLab

Mirror this directory into a project on your instance and include it as
`$CI_SERVER_FQDN/<group>/<project>/run-test-plan@1`, or skip the component and use the image directly:

```yaml
contextqa:
  image: { name: ghcr.io/indivatools/contextqa-cli:1, entrypoint: [''] }
  variables: { CONTEXTQA_PLAN_ID: "827", CONTEXTQA_JUNIT_PATH: contextqa-junit.xml }
  script: [contextqa run-plan]
  artifacts: { when: always, reports: { junit: contextqa-junit.xml } }
```

## Publishing

The CI/CD Catalog only lists components hosted on GitLab. The release workflow mirrors this directory to
the root of a gitlab.com project, where `templates/run-test-plan.yml` becomes the `run-test-plan` component.
