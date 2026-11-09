# ContextQA for Jenkins

A [shared library](https://www.jenkins.io/doc/book/pipeline/shared-libraries/) step, `contextqaRunPlan`, that
runs a ContextQA test plan, publishes its JUnit results, and fails the build unless the run passed.

```groovy
@Library('contextqa@v1') _

pipeline {
  agent any
  stages {
    stage('ContextQA') {
      steps {
        contextqaRunPlan planId: '827',
                         credentialsId: 'contextqa-token',
                         androidBuild: 'app/build/outputs/apk/release/app-release.apk'  // optional
      }
    }
  }
}
```

## Setup

1. **Add the library once:** *Manage Jenkins › System › Global Trusted Pipeline Libraries*, name
   `contextqa`, default version `v1`, retrieval *Modern SCM › Git*, repository
   `https://github.com/indivatools/contextqa-ci.git`, **Library Path** `providers/jenkins/`.
2. **Add the token** as a *Secret text* credential (ID `contextqa-token` above). Use an API token with
   `TEST_PLAN_EXECUTE` (which also covers build uploads) and `TEST_PLAN_RESULTS_READ`, plus `TEST_CASE_RESULTS_READ` for per-test results and `TEST_STEP_RESULTS_READ` for each failure's step and error.
3. **The agent needs Node or Docker.** The step runs `npx @contextqa/cli@1`, or the
   `ghcr.io/indivatools/contextqa-cli:1` image when there is no Node. Force one with `runner: 'npx'` or
   `runner: 'docker'`.

All options are listed in [`vars/contextqaRunPlan.txt`](vars/contextqaRunPlan.txt).

## Results

| CLI exit | Build |
|---|---|
| 0 | passes |
| 1 | fails: the plan did not pass (JUnit still published) |
| 2 | fails: configuration or token problem |
| 3 | fails: server, network or timeout |

`failOn: 'never'` reports without failing. With the Docker runner and an agent that is itself a container,
the workspace path must exist on the Docker host, since the step mounts `$PWD` at the same path.

## Without the library

```groovy
withCredentials([string(credentialsId: 'contextqa-token', variable: 'CONTEXTQA_TOKEN')]) {
  sh 'npx --yes @contextqa/cli@1 run-plan --plan-id 827 --junit contextqa-junit.xml'
}
junit 'contextqa-junit.xml'
```
