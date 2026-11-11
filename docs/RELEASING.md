# Releasing

One tag publishes every channel. `v*` tags are restricted to org admins.

Before tagging, add the release to [CHANGELOG.md](../CHANGELOG.md) in the PR that lands it. Write it for
customers: what changes in their pipeline and report, and any permission they may want to add, not a list of
commits. After the workflow runs, replace the generated GitHub release notes with that section
(`gh release edit v1.2.3 --notes-file notes.md`).

```sh
git checkout main && git pull
git tag v1.2.3 && git push origin v1.2.3
```

`.github/workflows/release.yml` then:

| Channel | What it publishes | Needs |
|---|---|---|
| npm | `@contextqa/ci-core`, `@contextqa/cli` with provenance | secret `NPM_TOKEN` (automation token for the `@contextqa` org) |
| GHCR | `ghcr.io/indivatools/contextqa-cli:{1.2.3,1.2,1,latest}`, amd64 + arm64 | nothing (uses `GITHUB_TOKEN`) |
| GitLab CI/CD Catalog | mirrors `providers/gitlab/` to a gitlab.com project and tags `1.2.3`; that project's pipeline creates the release | secret `GITLAB_TOKEN` (project access token, `write_repository`), variable `GITLAB_PROJECT` |
| CircleCI | orb `<namespace>/run-test-plan@1.2.3` | secret `CIRCLECI_TOKEN`, variable `CIRCLECI_ORB` |
| Azure DevOps | extension + task version 1.2.3 | secret `AZURE_MARKETPLACE_TOKEN` (PAT, *Marketplace: Publish*), variable `AZURE_PUBLISHER` |
| GitHub | release with generated notes | nothing |

A channel without its secret or variable is skipped with a notice, so a release still ships the rest.

## After the workflow

1. **Move the Action's major tag.** Customers use `@v1`, and only admins can move a `v*` tag:
   `git fetch --tags && git tag -f v1 v1.2.3 && git push -f origin v1`
   The Jenkins library's `@Library('contextqa@v1')` follows the same tag.
2. **First release only:**
   - Make the GHCR package public: *Package settings › Change visibility*. It is created private.
   - Publish the Action to the Marketplace: edit the GitHub release and tick *Publish this Action to the
     GitHub Marketplace* (needs the Marketplace developer agreement accepted for the org).
   - Create the orb once: `circleci namespace create <ns>` and `circleci orb create <ns>/run-test-plan`.
   - In the GitLab project, enable *Settings › General › CI/CD Catalog project*.
   - Share or make public the Azure extension from the Marketplace publisher page, and swap
     `providers/azure-devops/images/icon.png` for the brand mark before making it public.

## Versioning

Package versions in the repo stay at their placeholder; `scripts/set-version.mjs` stamps the tag's version
into every package and manifest inside the release jobs. Breaking changes to inputs, outputs or exit codes
need a new major, since every snippet pins `@1` / `:1` / `@v1`.
