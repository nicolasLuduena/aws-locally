import type { CheckContext, Module } from "../types.ts";

// ---------------------------------------------------------------- helpers

const OIDC_HOST = "token.actions.githubusercontent.com";

const asList = (x: any): any[] => (x === undefined || x === null ? [] : Array.isArray(x) ? x : [x]);

/** Parse a trust policy (the CLI already URL-decodes it) and check it is a tight GitHub OIDC trust. */
function trustProblems(doc: any, account: string, wantSub: string): string | null {
  const provider = `arn:aws:iam::${account}:oidc-provider/${OIDC_HOST}`;
  const stmts = asList(doc?.Statement).filter((s: any) => s.Effect === "Allow");
  if (!stmts.length) return "The trust policy has no Allow statement.";
  for (const s of stmts) {
    const p = s.Principal ?? {};
    if (p === "*" || p.AWS || p.Service) return "The trust policy allows a principal other than the GitHub OIDC provider. Only `Principal.Federated` should be present.";
    const fed = asList(p.Federated);
    if (fed.length !== 1 || fed[0] !== provider) return `\`Principal.Federated\` is ${JSON.stringify(p.Federated)}; expected exactly \`${provider}\`.`;
    const actions = asList(s.Action);
    if (!actions.includes("sts:AssumeRoleWithWebIdentity")) return "The trust statement must allow `sts:AssumeRoleWithWebIdentity`.";
    const extra = actions.filter((a: string) => a !== "sts:AssumeRoleWithWebIdentity" && a !== "sts:TagSession");
    if (extra.length) return `The trust statement also allows ${extra.join(", ")}. Allow only \`sts:AssumeRoleWithWebIdentity\`.`;
    const c = s.Condition ?? {};
    for (const op of Object.keys(c)) {
      if (/StringLike/.test(op) && Object.keys(c[op]).some((k) => k.startsWith(OIDC_HOST)))
        return `The trust policy uses \`${op}\` on a GitHub claim. Pin the subject with \`StringEquals\`: a wildcard is how other branches, tags, PRs or forks get in.`;
    }
    const eq = c.StringEquals ?? {};
    const aud = asList(eq[`${OIDC_HOST}:aud`]);
    if (aud.length !== 1 || aud[0] !== "sts.amazonaws.com")
      return `Missing or wrong audience condition: expected \`StringEquals\` \`${OIDC_HOST}:aud\` = \`sts.amazonaws.com\` (found ${JSON.stringify(eq[`${OIDC_HOST}:aud`])}).`;
    const sub = asList(eq[`${OIDC_HOST}:sub`]);
    if (sub.length !== 1 || sub[0] !== wantSub)
      return `Missing or wrong subject condition: expected \`StringEquals\` \`${OIDC_HOST}:sub\` = \`${wantSub}\` (found ${JSON.stringify(eq[`${OIDC_HOST}:sub`])}).`;
  }
  return null;
}

async function simulate(ctx: CheckContext, role: string, action: string, resource?: string): Promise<string> {
  const args = ["iam", "simulate-principal-policy", "--policy-source-arn", `arn:aws:iam::${ctx.account}:role/${role}`, "--action-names", action];
  if (resource) args.push("--resource-arns", resource);
  const r = await ctx.aws(args);
  return r.EvaluationResults?.[0]?.EvalDecision ?? "unknown";
}

/** Invoke a Lambda qualifier and return the raw payload (invocations don't change resource state). */
async function invoke(ctx: CheckContext, fn: string, qualifier: string): Promise<string | null> {
  const r = await ctx.sh(`f=$(mktemp); aws lambda invoke --function-name ${fn} --qualifier '${qualifier}' "$f" >/dev/null && cat "$f"; rm -f "$f"`);
  return r.code === 0 ? r.stdout.trim() : null;
}

// ---------------------------------------------------------------- module

export const cicd: Module = {
  id: "cicd",
  number: "13",
  title: "CI/CD & deployment strategies",
  summary:
    "Build pipelines that promote one immutable artifact, authenticate to AWS with OIDC instead of keys, test infrastructure against the emulator in CI, and release with canaries that roll back on alarms.",
  services: ["IAM", "STS", "Lambda", "CloudWatch", "CodePipeline", "CodeBuild", "CodeDeploy", "ECS"],
  lessons: [
    {
      id: "pipelines",
      kind: "reading",
      title: "Pipeline anatomy and artifact promotion",
      minutes: 14,
      body: String.raw`
A deployment pipeline is the only path to production. Not the fastest path or the recommended one: the only one. When that's true, every change to production is reviewed, built the same way, tested, and recorded. When it isn't true (someone can still \`zip && aws lambda update-function-code\` from a laptop), the pipeline is a suggestion, and the next incident will start with "what's actually running?"

## The five stages

<figure class="diagram">
<svg viewBox="0 0 640 230" role="img" aria-label="Pipeline stages source, build, test, deploy, verify; one artifact promoted from dev to staging to prod">
  <rect x="10" y="20" width="110" height="56" rx="8" class="d-box"/><text x="65" y="44" text-anchor="middle" class="d-label">Source</text><text x="65" y="62" text-anchor="middle" class="d-small">commit on main</text>
  <rect x="137" y="20" width="110" height="56" rx="8" class="d-box"/><text x="192" y="44" text-anchor="middle" class="d-label">Build</text><text x="192" y="62" text-anchor="middle" class="d-small">once, versioned</text>
  <rect x="264" y="20" width="110" height="56" rx="8" class="d-box"/><text x="319" y="44" text-anchor="middle" class="d-label">Test</text><text x="319" y="62" text-anchor="middle" class="d-small">unit + emulator</text>
  <rect x="391" y="20" width="110" height="56" rx="8" class="d-box"/><text x="446" y="44" text-anchor="middle" class="d-label">Deploy</text><text x="446" y="62" text-anchor="middle" class="d-small">gradual</text>
  <rect x="518" y="20" width="110" height="56" rx="8" class="d-box"/><text x="573" y="44" text-anchor="middle" class="d-label">Verify</text><text x="573" y="62" text-anchor="middle" class="d-small">smoke + alarms</text>
  <path d="M120 48 H135" class="d-arrow"/><path d="M247 48 H262" class="d-arrow"/><path d="M374 48 H389" class="d-arrow"/><path d="M501 48 H516" class="d-arrow"/>
  <rect x="137" y="110" width="110" height="44" rx="8" class="d-box d-accent"/><text x="192" y="130" text-anchor="middle" class="d-label">app-1f3c9e2.zip</text><text x="192" y="146" text-anchor="middle" class="d-small">sha256 recorded</text>
  <path d="M192 76 V108" class="d-arrow d-dashed"/>
  <rect x="300" y="100" width="100" height="40" rx="6" class="d-box d-dim"/><text x="350" y="125" text-anchor="middle" class="d-label">dev acct</text>
  <rect x="415" y="100" width="100" height="40" rx="6" class="d-box d-dim"/><text x="465" y="125" text-anchor="middle" class="d-label">staging acct</text>
  <rect x="530" y="100" width="100" height="40" rx="6" class="d-box d-ok"/><text x="580" y="125" text-anchor="middle" class="d-label">prod acct</text>
  <path d="M247 125 H298" class="d-arrow"/><path d="M400 120 H413" class="d-arrow"/><path d="M515 120 H528" class="d-arrow"/>
  <text x="320" y="180" class="d-small">The same bytes move between accounts. Only configuration differs.</text>
  <text x="320" y="198" class="d-small">Each promotion is gated: tests, alarms, sometimes a human approval.</text>
</svg>
<figcaption>Build once, promote the identical artifact. Each environment is a separate AWS account with its own deploy role.</figcaption>
</figure>

| Stage | What happens | What fails here |
|---|---|---|
| **Source** | A merge to \`main\` (or a tag) triggers the pipeline. Branch protection makes review mandatory. | Unreviewed changes, force pushes |
| **Build** | Compile, resolve dependencies from a lockfile, package a zip/image, tag it with the commit SHA, record its digest, push it to S3/ECR. Synthesise IaC (\`cdk synth\`, \`terraform plan\`). | Non-reproducible builds, unpinned deps |
| **Test** | Unit tests, static analysis, IaC linting (\`cfn-lint\`, \`tflint\`, \`checkov\`), integration tests against the emulator or an ephemeral environment. | Logic bugs, invalid templates, missing permissions in integrations |
| **Deploy** | Roll the artifact out to an environment with a strategy (rolling, blue/green, canary). | Bad config, capacity, a dependency down |
| **Verify** | Smoke tests against the real endpoint, then watch alarms for a bake period. Roll back automatically if they fire. | Everything the tests couldn't see |

The **verify** stage is the one teams skip, and it's the one that decides whether a bad deploy is a five-minute blip or a two-hour outage.

## Build once, promote everywhere

The artifact you tested must be the artifact you ship. If the staging deploy runs \`npm install && zip\` and the prod deploy runs it again an hour later, you have shipped two different builds. A transitive dependency can publish a new patch release in between; a base image tag can move; the build machine can have a different toolchain. You tested one thing and released another.

So a senior pipeline:

1. **Builds exactly once**, on a clean ephemeral runner, from a lockfile.
2. **Names the artifact immutably**: \`app-1f3c9e2.zip\`, or an ECR image referenced by **digest** (\`@sha256:…\`), never by a moving tag like \`latest\`. Turn on ECR tag immutability so a tag can't be overwritten.
3. **Stores it once**, in an artifact bucket or registry in a shared "tooling" account. Other accounts get read access through a bucket policy or an ECR repository policy (plus the KMS key policy if the bucket is encrypted with a customer-managed key, which is the cross-account step people forget).
4. **Promotes by reference**: the staging and prod jobs receive the artifact's S3 key or image digest as an input. They never rebuild.
5. **Injects configuration at deploy time**: endpoints, feature flags and sizing come from parameters, SSM Parameter Store or AppConfig per environment. If an artifact embeds "prod" anywhere, it can't be promoted.

Immutability also gives you **rollback for free**: the previous version is still in the registry, byte for byte, so rolling back is a pointer change, not a rebuild under pressure.

## Accounts per environment

Run dev, staging and prod in **separate accounts** (module 00 explained why the account is the strongest boundary). The pipeline lives in a tooling account and assumes a **deploy role in each target account**. Each role trusts only the pipeline's identity, and each is scoped to what that environment's deploy needs. A compromised dev pipeline job then can't touch prod: the prod role simply won't trust it.

## The AWS-native toolchain, briefly

| Service | Role | Notes |
|---|---|---|
| **CodePipeline** | Orchestrates stages and actions; passes artifacts between them through S3. | V2 pipelines support triggers on Git tags and branches, pipeline variables, and stage-level rollback. |
| **CodeBuild** | Runs a build in a fresh container from \`buildspec.yml\`. | Each project has a service role, so no keys. Can run inside your VPC to reach private resources. Supports GitHub Actions self-hosted runners. |
| **CodeDeploy** | Shifts traffic for **Lambda** (alias weights) and **ECS** (target groups), or rolls EC2 fleets. | Built-in canary/linear configs, lifecycle hook Lambdas, and automatic rollback on CloudWatch alarms. |
| **CloudFormation** | Deploys infrastructure; change sets act as the "plan". | Stack-level rollback triggers can watch alarms during a stack update. |

Plenty of teams use GitHub Actions, GitLab CI or Buildkite as the orchestrator and still call CodeDeploy or CloudFormation for the actual rollout. The principles are the same; only the YAML changes.

\`\`\`yaml
# buildspec.yml (CodeBuild): build once, publish an immutable artifact
version: 0.2
phases:
  install:
    runtime-versions: { python: 3.12 }
  build:
    commands:
      - pip install -r requirements.txt --target build/ --require-hashes
      - cp -r src/* build/ && (cd build && zip -qr ../app-$CODEBUILD_RESOLVED_SOURCE_VERSION.zip .)
      - aws s3 cp app-$CODEBUILD_RESOLVED_SOURCE_VERSION.zip s3://$ARTIFACT_BUCKET/app/
artifacts:
  files: [app-*.zip]
\`\`\`

> **On real AWS:** the emulator implements CodeBuild, CodePipeline and CodeDeploy APIs (CodeDeploy even refuses a service role whose trust policy doesn't allow it), but this module's labs drive the underlying primitives directly (Lambda aliases, IAM, CloudWatch) so you see exactly what CodeDeploy does on your behalf.

## Pitfalls

- **Pipelines with admin rights.** The deploy role is the most powerful identity in the account. Scope it, put a permissions boundary on any roles it can create, and alert on its unusual use (CloudTrail).
- **"Manual approval" as the only safety net.** Humans approve without reading. Automated gates (tests, alarms, bake time) catch more.
- **Drift.** A hotfix applied by hand is reverted by the next deploy. Every fix goes through the pipeline, or it gets ported into the code immediately.
- **Coupling infra and app releases.** A change that both reshapes the database and deploys code that needs the new shape can't be rolled back cleanly. See expand/contract later in this module.
`,
    },
    {
      id: "ci-credentials",
      kind: "reading",
      title: "Credentials in CI: OIDC, never long-lived keys",
      minutes: 15,
      body: String.raw`
The classic way to let CI deploy to AWS is an IAM user with an access key stored as a repository secret. It's also the classic way to get breached. The key never expires, it gets copied into forks, logs and other tools, nobody rotates it, and a leaked key works from anywhere in the world. **Don't create IAM users for CI.**

The replacement is **OpenID Connect (OIDC) federation**. GitHub Actions (also GitLab, Buildkite, CircleCI, Terraform Cloud and Bitbucket) can mint a short-lived, signed **JSON Web Token** for each job that describes *who* is running: which repository, branch, environment and workflow. AWS STS checks the signature and the claims against a role's trust policy and returns credentials that expire in an hour or less. There's no secret to leak.

<figure class="diagram">
<svg viewBox="0 0 640 230" role="img" aria-label="GitHub job gets a JWT from GitHub's OIDC issuer, exchanges it with STS for temporary credentials, then calls AWS APIs">
  <rect x="10" y="20" width="170" height="70" rx="8" class="d-box"/><text x="95" y="48" text-anchor="middle" class="d-label">GitHub Actions job</text><text x="95" y="68" text-anchor="middle" class="d-small">permissions: id-token: write</text>
  <rect x="10" y="140" width="170" height="70" rx="8" class="d-box d-dim"/><text x="95" y="168" text-anchor="middle" class="d-label">GitHub OIDC issuer</text><text x="95" y="188" text-anchor="middle" class="d-small">token.actions.githubusercontent.com</text>
  <rect x="250" y="20" width="160" height="70" rx="8" class="d-box d-accent"/><text x="330" y="48" text-anchor="middle" class="d-label">AWS STS</text><text x="330" y="68" text-anchor="middle" class="d-small">AssumeRoleWithWebIdentity</text>
  <rect x="250" y="140" width="160" height="70" rx="8" class="d-box"/><text x="330" y="168" text-anchor="middle" class="d-label">IAM role trust policy</text><text x="330" y="188" text-anchor="middle" class="d-small">aud + sub conditions</text>
  <rect x="480" y="20" width="150" height="70" rx="8" class="d-box d-ok"/><text x="555" y="48" text-anchor="middle" class="d-label">AWS APIs</text><text x="555" y="68" text-anchor="middle" class="d-small">deploy with temp creds</text>
  <path d="M70 90 V138" class="d-arrow"/><text x="40" y="118" class="d-small">1 JWT</text>
  <path d="M120 138 V92" class="d-arrow d-dashed"/>
  <path d="M180 55 H248" class="d-arrow"/><text x="214" y="46" text-anchor="middle" class="d-small">2 token</text>
  <path d="M330 90 V138" class="d-arrow d-dashed"/><text x="338" y="118" class="d-small">3 evaluate</text>
  <path d="M410 55 H478" class="d-arrow"/><text x="444" y="46" text-anchor="middle" class="d-small">4 creds</text>
</svg>
<figcaption>The job proves its identity with a signed token; STS checks the signature against the issuer's published keys and the claims against the trust policy.</figcaption>
</figure>

## The token

A GitHub OIDC token for a push to \`main\` carries claims like:

\`\`\`json
{
  "iss": "https://token.actions.githubusercontent.com",
  "aud": "sts.amazonaws.com",
  "sub": "repo:acme/app:ref:refs/heads/main",
  "repository": "acme/app",
  "ref": "refs/heads/main",
  "environment": null,
  "job_workflow_ref": "acme/app/.github/workflows/deploy.yml@refs/heads/main",
  "event_name": "push",
  "exp": 1763190000
}
\`\`\`

The **\`sub\`** (subject) claim is what you pin in the trust policy. Its format depends on the trigger:

| Trigger | \`sub\` |
|---|---|
| Push to a branch | \`repo:acme/app:ref:refs/heads/main\` |
| Tag | \`repo:acme/app:ref:refs/tags/v1.4.0\` |
| Job with \`environment: production\` | \`repo:acme/app:environment:production\` |
| Pull request | \`repo:acme/app:pull_request\` |

Using a **GitHub environment** for production deploys is the strongest option: environments can require reviewers and restrict which branches may deploy, and the trust policy pins \`environment:production\`, so only a job that passed those protections gets the prod role.

## The AWS side

One-time setup per account: register GitHub as an identity provider.

\`\`\`text
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com
\`\`\`

Then a role whose trust policy names that provider and pins **both** the audience and the subject:

\`\`\`json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        "token.actions.githubusercontent.com:sub": "repo:acme/app:ref:refs/heads/main"
      }
    }
  }]
}
\`\`\`

Condition keys are the provider's host name plus the claim (\`…:aud\`, \`…:sub\`). The \`aud\` check makes sure the token was minted *for AWS*; the \`sub\` check makes sure it came from *your repo and branch*.

## The workflow

\`\`\`yaml
# .github/workflows/deploy.yml
name: deploy
on:
  push:
    branches: [main]

permissions:
  id-token: write   # allow this job to request an OIDC token
  contents: read    # and nothing else from GITHUB_TOKEN

concurrency:
  group: deploy-prod
  cancel-in-progress: false   # never cancel a deploy halfway

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4   # pin to a full commit SHA in real repos
        with:
          role-to-assume: arn:aws:iam::111122223333:role/gha-deploy-app
          role-session-name: gha-\${{ github.run_id }}
          aws-region: us-east-1
      - run: aws sts get-caller-identity
      - run: ./scripts/deploy.sh "\${{ github.sha }}"
\`\`\`

Under the hood, \`configure-aws-credentials\` calls GitHub's token endpoint with \`audience=sts.amazonaws.com\`, then \`sts:AssumeRoleWithWebIdentity\`, and exports the temporary credentials as environment variables for later steps. The session name shows up in CloudTrail, so put the run ID in it: during an incident you can map every API call back to a workflow run.

> **Note:** with \`environment: production\` in the job, the \`sub\` becomes \`repo:acme/app:environment:production\`. Pin that instead of the branch.

## Pitfalls that become breaches

- **Wildcard subjects.** \`"StringLike": {"…:sub": "repo:acme/*"}\` lets *every* repo in the org deploy, and \`repo:acme/app:*\` lets any branch, tag or pull request deploy. Use \`StringEquals\` with exact values. If you need several, list them.
- **Missing \`sub\` condition entirely.** Then *any GitHub repository in the world* can assume your role, because the provider is GitHub-wide. Security audits keep finding roles like this, often created by copying an old blog post. Check every role that trusts the GitHub provider.
- **Fork pull requests.** Never give the PR role write access. Workflows triggered by \`pull_request_target\` run with secrets in the context of the base repo while checking out attacker code. Keep PR jobs on \`pull_request\` with a read-only (plan-only) role.
- **One role for everything.** Use separate roles: \`gha-plan-app\` (read-only, trusted for PRs) and \`gha-deploy-app\` (scoped write, trusted only for \`main\` or the production environment), per account.
- **Over-broad deploy permissions.** \`AdministratorAccess\` on a deploy role means a compromised workflow owns the account. Scope to the resources the deploy touches (\`function:app-*\`, \`arn:aws:s3:::acme-artifacts/app/*\`). If the deploy creates IAM roles (CloudFormation often does), require a **permissions boundary** on them so the pipeline can't mint an admin role.
- **Long sessions.** Keep \`MaxSessionDuration\` at the default hour; deploys rarely need more.
- **Thumbprints.** Old guides tell you to pin the provider's TLS thumbprint. For GitHub, AWS now validates the issuer against its own trusted root CAs and ignores the thumbprint; it's optional on the API.

STS really does verify the token. Try sending it something that isn't a signed JWT:

\`\`\`bash
aws sts assume-role-with-web-identity --role-arn arn:aws:iam::000000000000:role/demo-nobody \
  --role-session-name demo --web-identity-token not-a-jwt
\`\`\`

> **On real AWS:** STS fetches the issuer's signing keys (JWKS) from \`https://token.actions.githubusercontent.com/.well-known/jwks\`. The emulator runs offline, so it can't fetch them, and even a well-formed GitHub-style token fails with \`InvalidIdentityToken: Couldn't retrieve verification key\`. In the lab you build the provider and roles exactly as on AWS, and the checks verify the trust policy and simulate the permissions instead of performing the exchange.
`,
    },
    {
      id: "testing-in-ci",
      kind: "reading",
      title: "Testing infrastructure against the emulator in CI",
      minutes: 13,
      body: String.raw`
Infrastructure code fails in ways unit tests don't see: a queue policy that doesn't let EventBridge deliver, an event source mapping without SQS permissions, a CloudFormation \`!GetAtt\` on an attribute that doesn't exist, a waiter you forgot so the next step races a \`CREATING\` table. The traditional answer is a shared "dev" AWS account that every pull request deploys into. It's slow (minutes per stack), flaky (PRs collide on names and quotas), costs money, and needs AWS credentials for every PR, including ones from forks.

Running the same tests against a local emulator in CI gives you most of that signal in seconds, with no account and no credentials.

## The testing pyramid for infrastructure

| Layer | Tools | Catches | Speed |
|---|---|---|---|
| Static | \`cfn-lint\`, \`tflint\`, \`terraform validate\`, \`checkov\`, policy-as-code (OPA, cfn-guard) | Schema errors, insecure defaults (public buckets, \`*\` actions) | Seconds |
| Unit | Your handler tests, CDK assertions, \`terraform test\` with mocks | Logic, template shape | Seconds |
| **Integration (emulator)** | Deploy the real template/plan to the emulator, drive it through its API, assert end state | Wiring: permissions on integrations, event patterns, DLQs, async waits, ordering | Tens of seconds |
| Smoke (real AWS) | A short test suite against staging after deploy | Real IAM enforcement, quotas, networking, performance | Minutes |

The emulator layer is where you test **behaviour of the wiring**: "a POST to the API ends with the order FULFILLED", "a poison message ends up in the DLQ after three receives", "the stack deletes cleanly". You'll do exactly that in the capstone.

## The pattern: one throwaway emulator per job

This repo ships \`scripts/with-emulator.sh\`, which is the pattern in about 30 lines:

1. Pick a free port and a temporary \`HOME\` (the emulator writes fresh credentials, config and a CA certificate there on each start).
2. Start \`aws-emulator --telemetry off -p $PORT\` in the background and trap \`EXIT\` to kill it, so state is always discarded.
3. Poll \`/__admin/health\` until it answers.
4. Export the standard variables: \`AWS_ENDPOINT_URL\`, \`AWS_SHARED_CREDENTIALS_FILE\`, \`AWS_CONFIG_FILE\`, \`AWS_CA_BUNDLE\`, region, and \`unset\` any real \`AWS_ACCESS_KEY_ID\`.
5. Run the command you were given.

\`\`\`text
scripts/with-emulator.sh bash tests/integration.sh
scripts/with-emulator.sh npx vitest run tests/integration
EMU_PORT=9400 scripts/with-emulator.sh terraform -chdir=infra apply -auto-approve
\`\`\`

Because every SDK and the CLI honour \`AWS_ENDPOINT_URL\`, the code under test doesn't need emulator-specific branches. If you find yourself writing \`if (process.env.CI) endpoint = …\`, stop: the environment variable already does it.

## A GitHub Actions job

\`\`\`yaml
# .github/workflows/integration.yml
name: integration
on: [pull_request]

permissions:
  contents: read        # no id-token: this job never touches real AWS

jobs:
  emulator-tests:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4

      - name: Install AWS Emulator
        run: |
          # The official Debian package. Pin a specific version for reproducible
          # builds: see "Finding and installing a specific version" in the user guide.
          curl -fsSLo aws-emulator.deb https://downloads.aws.com/aws-emulator/packages/aws-emulator/LTS/latest/aws-emulator_amd64.deb
          sudo apt-get install -y -qq ./aws-emulator.deb
          aws-emulator -v

      - name: Lint templates
        run: pipx run cfn-lint infra/*.yaml

      - name: Integration tests against a throwaway emulator
        run: scripts/with-emulator.sh bash tests/integration.sh

      - name: Upload logs on failure
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: integration-logs
          path: tests/out/
\`\`\`

Things to notice:

- **No AWS credentials and no \`id-token: write\`.** The job can't reach real AWS even if a test is wrong or a PR is malicious, so it's safe to run on fork PRs.
- **Pin the emulator version** for anything you depend on. An unpinned test dependency is a flaky build waiting to happen, and the emulator ships many releases a day. The example installs \`LTS/latest\` for brevity.
- **One emulator per job**, killed on exit. Parallel jobs get independent state, so there are no name collisions.
- \`scripts/with-emulator.sh\` looks for \`aws-emulator\` on \`PATH\` when the project-local copy isn't there, and the Debian package installs it to \`/usr/bin\`.

A minimal \`tests/integration.sh\` looks like the lab solutions you've been writing: deploy, act, poll for the async outcome with a timeout, assert, exit non-zero on failure.

\`\`\`text
set -euo pipefail
aws cloudformation deploy --stack-name it --template-file infra/platform.yaml --capabilities CAPABILITY_NAMED_IAM
API=$(aws cloudformation describe-stacks --stack-name it --query "Stacks[0].Outputs[?OutputKey=='ApiId'].OutputValue" --output text)
ID=$(curl -sS --cacert "$AWS_CA_BUNDLE" -H "Host: $API.execute-api.us-east-1.amazonaws.com" \
       -d '{"items":[{"sku":"A","qty":1}]}' "$AWS_ENDPOINT_URL/orders" | jq -r .orderId)
for _ in $(seq 30); do
  S=$(aws dynamodb get-item --table-name it-orders --key "{\"orderId\":{\"S\":\"$ID\"}}" --query Item.status.S --output text)
  [ "$S" = FULFILLED ] && exit 0; sleep 1
done
echo "order $ID never reached FULFILLED (last: $S)" >&2; exit 1
\`\`\`

## Know what the emulator can't prove

A green emulator run is strong evidence about wiring, not a guarantee about production. In particular:

- **IAM identity policies aren't fully enforced** on ordinary calls here. Test least privilege with \`iam simulate-principal-policy\` (or IAM Access Analyzer's policy checks) in CI, and keep a real-account smoke test.
- **Quotas, throttling, latency and cold starts** are real-AWS properties.
- **Networking** (VPC endpoints, NAT, security groups at the packet level) isn't simulated: instances don't boot.
- **Unimplemented operations** return HTTP 501 \`NotImplemented\`. Treat that as a known gap, not a test failure to retry, and cover that piece with a real-account test.

A senior setup runs the emulator suite on every PR (fast, free, safe), deploys merged changes to a real staging account through the OIDC deploy role, runs smoke tests there, and only then promotes the same artifact to prod.
`,
    },
    {
      id: "strategies",
      kind: "reading",
      title: "Deployment strategies: rolling, blue/green, canary, flags",
      minutes: 15,
      body: String.raw`
Every deployment strategy answers one question: **when this version is bad, how many users notice, and how fast can you undo it?** Pick the strategy per service based on its blast radius and how good your signals are.

<figure class="diagram">
<svg viewBox="0 0 640 260" role="img" aria-label="Share of traffic on the new version over time for all-at-once, blue/green, canary and linear deployments">
  <rect x="10" y="10" width="620" height="240" rx="10" class="d-box d-outer"/>
  <text x="24" y="34" class="d-label">Traffic on the new version over time</text>
  <text x="24" y="70" class="d-label">All-at-once</text>
  <rect x="150" y="56" width="20" height="20" class="d-box d-dim"/><rect x="170" y="56" width="440" height="20" class="d-box d-danger"/>
  <text x="380" y="70" text-anchor="middle" class="d-small">100% instantly (bad version hits everyone)</text>
  <text x="24" y="114" class="d-label">Blue/green</text>
  <rect x="150" y="100" width="200" height="20" class="d-box d-dim"/><text x="250" y="114" text-anchor="middle" class="d-small">green built + tested</text>
  <rect x="350" y="100" width="260" height="20" class="d-box d-ok"/><text x="480" y="114" text-anchor="middle" class="d-small">switch 100%, blue kept warm</text>
  <text x="24" y="158" class="d-label">Canary 10%</text>
  <rect x="150" y="144" width="260" height="20" class="d-box d-accent"/><text x="280" y="158" text-anchor="middle" class="d-small">10% for the bake time</text>
  <rect x="410" y="144" width="200" height="20" class="d-box d-ok"/><text x="510" y="158" text-anchor="middle" class="d-small">then 100%</text>
  <text x="24" y="202" class="d-label">Linear 10%/min</text>
  <rect x="150" y="196" width="46" height="10" class="d-box d-accent"/><rect x="196" y="192" width="46" height="14" class="d-box d-accent"/>
  <rect x="242" y="188" width="46" height="18" class="d-box d-accent"/><rect x="288" y="184" width="46" height="22" class="d-box d-accent"/>
  <rect x="334" y="180" width="46" height="26" class="d-box d-accent"/><rect x="380" y="176" width="230" height="30" class="d-box d-ok"/>
  <text x="495" y="196" text-anchor="middle" class="d-small">steps until 100%</text>
  <path d="M150 230 H612" class="d-arrow"/><text x="600" y="224" text-anchor="end" class="d-small">time</text>
</svg>
<figcaption>Gradual strategies trade deploy speed for a smaller blast radius and a chance for alarms to fire before everyone is affected.</figcaption>
</figure>

| Strategy | How it works | Blast radius | Rollback | Cost | Use when |
|---|---|---|---|---|---|
| **All-at-once** | Replace everything in place | 100% | Redeploy the old version (slow) | Lowest | Dev/test, internal batch jobs |
| **Rolling** | Replace instances/tasks in batches (\`minimumHealthyPercent\`, \`maxSurge\`) | Grows batch by batch; mixed versions run together | Roll forward/back batch by batch | Low | Stateless fleets, ECS default |
| **Blue/green** | Stand up a full new environment (green), test it, flip the router | 100% at the flip, but tested first | Flip back: seconds | 2× capacity during deploy | Big-bang changes needing instant rollback |
| **Canary** | Send a small slice (5–10%) to the new version for a bake period, then the rest | The slice | Shift the slice back: seconds | ~1× | Customer-facing APIs with good metrics |
| **Linear** | Shift in equal steps (10% every minute) | Grows over time | Shift back | ~1× | Like canary, when you want several checkpoints |
| **Feature flags** | Ship code dark; turn behaviour on per user/percentage at runtime | Chosen cohort | Toggle off: instant, no deploy | Flag system + code complexity | Decoupling *release* from *deploy*; risky product changes |

Two things make gradual strategies work: **good signals** (alarms on error rate and latency that actually move when the new version misbehaves) and **automatic rollback** wired to those signals. A canary that nobody watches is just a slow all-at-once.

## Lambda canaries with weighted aliases

A Lambda **version** is an immutable snapshot of code and configuration (\`app-api:7\`). An **alias** is a named pointer (\`app-api:live\`) that callers use: API Gateway integrations, event source mappings and other services reference the alias ARN, never \`$LATEST\`. An alias can split traffic between two versions:

\`\`\`json
{
  "Name": "live",
  "FunctionVersion": "7",
  "RoutingConfig": { "AdditionalVersionWeights": { "8": 0.1 } }
}
\`\`\`

Here 90% of invocations run version 7 and 10% run version 8. Each invocation reports which version actually ran (\`ExecutedVersion\` in the invoke response), and CloudWatch publishes metrics per alias with an \`ExecutedVersion\` dimension, so you can alarm on *the canary's* error rate specifically.

The canary loop is:

1. \`update-function-code\`, wait for \`LastUpdateStatus=Successful\`, then \`publish-version\` (8).
2. \`update-alias --routing-config '{"AdditionalVersionWeights":{"8":0.1}}'\`.
3. Bake for N minutes while watching alarms on \`Errors\` and \`Duration\` for \`Resource=app-api:live, ExecutedVersion=8\`.
4. Healthy: \`update-alias --function-version 8 --routing-config '{}'\` (promote). Alarm: \`update-alias --routing-config '{}'\` (back to 100% on 7).

**CodeDeploy** automates exactly this with deployment configs like \`CodeDeployDefault.LambdaCanary10Percent5Minutes\` and \`LambdaLinear10PercentEvery1Minute\`, \`BeforeAllowTraffic\`/\`AfterAllowTraffic\` hook functions for smoke tests, and an alarm list that triggers rollback. SAM exposes it as \`AutoPublishAlias\` + \`DeploymentPreference\`. You'll do the loop by hand in the lab so the mechanism is clear.

Pitfalls: weights apply per invocation, so a single user's requests can hit both versions (make both versions compatible with the same data); provisioned concurrency is per version, so a canary version without it sees cold starts that skew latency alarms; and a low-traffic function may send zero requests to a 10% canary during a five-minute bake, which means no signal. Use a synthetic canary (CloudWatch Synthetics or the hook function) to generate traffic.

## ECS blue/green

For ECS services behind an ALB, blue/green uses **two target groups** and a listener rule:

1. The new task set (green) starts in the second target group, while production traffic still goes to blue.
2. A **test listener** (say port 8443) routes to green so hooks can smoke-test it with real infrastructure.
3. Traffic shifts from blue to green: all at once, canary or linear (by listener rule weights).
4. Blue is kept for a bake/termination wait so rollback is a listener change.

Historically this needed CodeDeploy (\`deploymentController: CODE_DEPLOY\`) and an AppSpec file. ECS now also has built-in blue/green deployments in its own deployment controller, with lifecycle hooks and a bake time. Either way, the **deployment circuit breaker** (\`deploymentCircuitBreaker: {enable: true, rollback: true}\`) should be on for rolling deployments: it stops a deploy whose tasks keep failing health checks and rolls back, instead of retrying forever.

## Automated rollback on alarms

Wire rollback to the same alarms you page on:

| Mechanism | Watches | Action |
|---|---|---|
| CodeDeploy deployment group alarms | Any CloudWatch alarms you list | Stops the deployment and shifts traffic back |
| ECS deployment alarms / circuit breaker | Alarms; failed task launches | Rolls the service back to the last steady state |
| CloudFormation rollback triggers | Up to five alarms during a stack update + monitoring period | Rolls the whole stack update back |
| Your pipeline | The canary's alarms during bake | Calls \`update-alias\` back to the old version |

Good rollback alarms are **fast** (1-minute periods, evaluated over 2–3 datapoints), **specific to the new version** (the \`ExecutedVersion\` dimension, the green target group), and use \`TreatMissingData: notBreaching\` so silence doesn't count as failure. Alarm on error **rate** (metric math: errors / invocations) rather than raw counts when traffic varies.

## Feature flags

A deploy puts code on servers; a **release** exposes behaviour to users. Feature flags (AWS AppConfig, LaunchDarkly, Unleash, or a simple config table) separate the two: you deploy the new checkout flow switched off, turn it on for staff, then 1%, 10%, 100%, and turn it off in seconds if metrics move. Flags need hygiene: an owner, an expiry, and removal once fully rolled out, or the codebase fills with dead branches. Flag configuration is itself a deployment, so validate it (AppConfig validators) and roll it out gradually too.
`,
    },
    {
      id: "migrations",
      kind: "reading",
      title: "Database migrations in pipelines: expand and contract",
      minutes: 10,
      body: String.raw`
Code rolls back in seconds. Data doesn't. Most "we couldn't roll back" stories are a schema change shipped in the same deploy as the code that needs it: the migration renamed a column, the new code failed, the old code can't read the renamed column, and now there's no version that works.

During any gradual deployment (rolling, canary, blue/green), **old and new code run at the same time against the same database**. So every schema change must be compatible with both the version before it and the version after it.

## Expand, migrate, contract

<figure class="diagram">
<svg viewBox="0 0 640 170" role="img" aria-label="Expand, migrate and contract phases spread over three separate deploys">
  <rect x="10" y="20" width="190" height="110" rx="8" class="d-box d-accent"/>
  <text x="105" y="44" text-anchor="middle" class="d-label">1 Expand</text>
  <text x="105" y="66" text-anchor="middle" class="d-small">add new column/table</text>
  <text x="105" y="84" text-anchor="middle" class="d-small">(nullable, no default work)</text>
  <text x="105" y="104" text-anchor="middle" class="d-small">code writes both, reads old</text>
  <rect x="225" y="20" width="190" height="110" rx="8" class="d-box"/>
  <text x="320" y="44" text-anchor="middle" class="d-label">2 Migrate</text>
  <text x="320" y="66" text-anchor="middle" class="d-small">backfill in batches</text>
  <text x="320" y="84" text-anchor="middle" class="d-small">switch reads to new</text>
  <text x="320" y="104" text-anchor="middle" class="d-small">(behind a flag)</text>
  <rect x="440" y="20" width="190" height="110" rx="8" class="d-box d-ok"/>
  <text x="535" y="44" text-anchor="middle" class="d-label">3 Contract</text>
  <text x="535" y="66" text-anchor="middle" class="d-small">stop writing old</text>
  <text x="535" y="84" text-anchor="middle" class="d-small">later: drop old column</text>
  <text x="535" y="104" text-anchor="middle" class="d-small">(only after rollback window)</text>
  <path d="M200 75 H223" class="d-arrow"/><path d="M415 75 H438" class="d-arrow"/>
  <text x="320" y="156" text-anchor="middle" class="d-small">Each phase is its own deploy; each one can be rolled back on its own.</text>
</svg>
<figcaption>Renaming <code>customer_name</code> to <code>full_name</code> takes three deploys, not one.</figcaption>
</figure>

Example: rename \`customer_name\` → \`full_name\`.

1. **Expand.** Migration adds \`full_name\` (nullable). Code v2 writes both columns and still reads \`customer_name\`. Rolling back to v1 is safe: v1 ignores the new column.
2. **Migrate.** A batched backfill copies old values into \`full_name\`. Code v3 reads \`full_name\` (behind a flag, so you can flip back), still writes both.
3. **Contract.** Code v4 stops writing \`customer_name\`. Weeks later, after the rollback window has passed and nothing reads it, a migration drops it.

The same discipline applies to NoSQL and events, which is exactly what bites in this course's capstone: if a producer renames \`orderId\` to \`order_id\` in an event, every consumer must accept both shapes *before* the producer changes (a "tolerant reader"), and the old shape is removed only when no producer emits it.

## Running migrations in the pipeline

- **Run migrations as their own pipeline step**, before the code deploy that needs them, using a dedicated migration role. Not at application startup: twenty tasks starting at once will race to migrate, and a failed migration crash-loops the service.
- **Make migrations idempotent and forward-only.** "Down" migrations are rarely tested and often destroy data. Roll back by deploying the previous *code*, which the expand phase keeps compatible.
- **Watch for locking DDL.** Adding a column with a default, adding an index without \`CONCURRENTLY\` (Postgres), or changing a column type can lock a large table for minutes. Use online schema change tools and test against a production-sized copy.
- **Backfill in batches** with throttling, outside the deploy window, and make it resumable.
- **Take a snapshot first** (RDS snapshot, DynamoDB on-demand backup or PITR enabled) so the worst case is a restore, not a loss.
- **Separate the release of destructive steps.** A \`DROP\` goes in its own small change, reviewed on its own, after the rollback window.

## Checklist before you press merge

- Can the **previous** version of the code run against the database after this migration? If not, split the change.
- Can **this** version of the code run against the database *before* the migration (for the seconds or minutes the deploy takes)? If not, run the migration as an earlier step.
- Is the migration step's runtime bounded and its locks understood?
- Is there a tested restore path?
`,
    },
    {
      id: "oidc-deploy-role",
      kind: "lab",
      title: "Lab: an OIDC deploy role for GitHub Actions",
      minutes: 25,
      body: String.raw`
You're setting up deployments for the \`acme/app\` repository. Pushes to \`main\` deploy; pull requests may only read (for \`terraform plan\`-style previews). No IAM users, no access keys.

You'll build:

- the GitHub OIDC identity provider for this account,
- \`gha-deploy-app\`: trusted **only** for \`repo:acme/app:ref:refs/heads/main\`, with a deploy policy scoped to the \`app-*\` functions and the \`acme-artifacts/app/\` prefix,
- \`gha-plan-app\`: trusted only for \`repo:acme/app:pull_request\`, read-only.

The emulator can't verify real GitHub tokens offline (it can't fetch GitHub's signing keys), so the checks **parse your trust policies** and use \`iam simulate-principal-policy\` to prove the permissions. That's also what a policy test in CI should do.

## Useful commands

\`\`\`bash
aws iam list-open-id-connect-providers
aws iam get-role --role-name gha-deploy-app --query Role.AssumeRolePolicyDocument
\`\`\`

\`\`\`text
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::000000000000:role/gha-deploy-app \
  --action-names lambda:UpdateFunctionCode \
  --resource-arns arn:aws:lambda:us-east-1:000000000000:function:billing-api \
  --query 'EvaluationResults[].[EvalActionName,EvalDecision]' --output text
\`\`\`

Write the policy documents as files in the lab folder (\`trust-deploy.json\`, \`deploy-policy.json\` and so on) and pass them with \`file://\`. Policies in files can be reviewed and committed; policies inline in a shell command can't.
`,
      lab: {
        tasks: [
          {
            id: "provider",
            title: "Register GitHub as an OIDC identity provider",
            description:
              "Create an IAM OIDC identity provider for `https://token.actions.githubusercontent.com` whose only client ID (audience) is `sts.amazonaws.com`.",
            hints: [
              "The command is `aws iam create-open-id-connect-provider`.",
              "`aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com --client-id-list sts.amazonaws.com`",
            ],
            check: async ({ tryAws, account }) => {
              const arn = `arn:aws:iam::${account}:oidc-provider/${OIDC_HOST}`;
              const r = await tryAws(["iam", "get-open-id-connect-provider", "--open-id-connect-provider-arn", arn]);
              if (!r.ok) return `No OIDC provider \`${arn}\` yet.`;
              const ids: string[] = r.data.ClientIDList ?? [];
              if (ids.length !== 1 || ids[0] !== "sts.amazonaws.com")
                return `The provider's client ID list is ${JSON.stringify(ids)}; expected exactly ["sts.amazonaws.com"].`;
              return true;
            },
          },
          {
            id: "deploy-trust",
            title: "Create the deploy role, trusted only for main",
            description:
              "Create the role `gha-deploy-app`. Its trust policy must allow **only** `sts:AssumeRoleWithWebIdentity` from the GitHub provider, with `StringEquals` conditions on both `token.actions.githubusercontent.com:aud` = `sts.amazonaws.com` and `token.actions.githubusercontent.com:sub` = `repo:acme/app:ref:refs/heads/main`. Keep the maximum session duration at one hour.",
            hints: [
              "Write the trust policy to `trust-deploy.json`. `Principal` is `{\"Federated\": \"arn:aws:iam::000000000000:oidc-provider/token.actions.githubusercontent.com\"}`.",
              "Put both keys under one `\"StringEquals\"` block in `Condition`. Don't use `StringLike` or wildcards.",
              "`aws iam create-role --role-name gha-deploy-app --assume-role-policy-document file://trust-deploy.json` (use `aws iam update-assume-role-policy` to fix it later).",
            ],
            check: async ({ tryAws, account }) => {
              const r = await tryAws(["iam", "get-role", "--role-name", "gha-deploy-app"]);
              if (!r.ok) return "Role `gha-deploy-app` doesn't exist yet.";
              const p = trustProblems(r.data.Role.AssumeRolePolicyDocument, account, "repo:acme/app:ref:refs/heads/main");
              if (p) return p;
              const max = r.data.Role.MaxSessionDuration ?? 3600;
              if (max > 3600) return `MaxSessionDuration is ${max}s; keep it at 3600 (one hour) or less.`;
              return true;
            },
          },
          {
            id: "deploy-policy",
            title: "Scope what the deploy role can do",
            description: String.raw`Give \`gha-deploy-app\` an inline policy named \`deploy\` that allows exactly what a release of the \`app-*\` Lambda functions needs, and nothing else:

- \`lambda:UpdateFunctionCode\`, \`lambda:PublishVersion\`, \`lambda:UpdateAlias\` and \`lambda:GetFunction\` on \`arn:aws:lambda:us-east-1:000000000000:function:app-*\`
- \`s3:PutObject\` on \`arn:aws:s3:::acme-artifacts/app/*\`

The checks simulate: these are allowed on \`app-api\`, but **not** on \`billing-api\`; \`lambda:DeleteFunction\`, \`iam:CreateRole\` and \`iam:PassRole\` are denied; uploads outside \`app/\` are denied.`,
            hints: [
              "Two statements: one for the Lambda actions with `Resource` `arn:aws:lambda:us-east-1:000000000000:function:app-*`, one for `s3:PutObject` with `Resource` `arn:aws:s3:::acme-artifacts/app/*`.",
              "The function ARN pattern also matches alias ARNs like `function:app-api:live`, which `UpdateAlias` needs.",
              "`aws iam put-role-policy --role-name gha-deploy-app --policy-name deploy --policy-document file://deploy-policy.json`",
            ],
            check: async (ctx) => {
              const { tryAws, account } = ctx;
              const r = await tryAws(["iam", "get-role-policy", "--role-name", "gha-deploy-app", "--policy-name", "deploy"]);
              if (!r.ok) return "Role `gha-deploy-app` has no inline policy named `deploy` yet.";
              for (const s of asList(r.data.PolicyDocument?.Statement)) {
                if (asList(s.Action).some((a: string) => a === "*" || a.endsWith(":*")))
                  return "The `deploy` policy uses a wildcard action (`*` or `service:*`). List the actions explicitly.";
                if (asList(s.Resource).includes("*")) return "The `deploy` policy has `Resource: \"*\"`. Scope it to the `app-*` functions and the `app/` prefix.";
              }
              const fn = (n: string) => `arn:aws:lambda:us-east-1:${account}:function:${n}`;
              const allow: [string, string][] = [
                ["lambda:UpdateFunctionCode", fn("app-api")],
                ["lambda:PublishVersion", fn("app-api")],
                ["lambda:UpdateAlias", fn("app-api:live")],
                ["lambda:GetFunction", fn("app-api")],
                ["s3:PutObject", "arn:aws:s3:::acme-artifacts/app/app-1f3c9e2.zip"],
              ];
              for (const [a, res] of allow) {
                const d = await simulate(ctx, "gha-deploy-app", a, res);
                if (d !== "allowed") return `\`${a}\` on \`${res}\` is ${d}; it should be allowed.`;
              }
              const deny: [string, string | undefined][] = [
                ["lambda:UpdateFunctionCode", fn("billing-api")],
                ["lambda:DeleteFunction", fn("app-api")],
                ["iam:CreateRole", undefined],
                ["iam:PassRole", undefined],
                ["s3:PutObject", "arn:aws:s3:::acme-artifacts/billing/x.zip"],
              ];
              for (const [a, res] of deny) {
                const d = await simulate(ctx, "gha-deploy-app", a, res);
                if (d === "allowed") return `\`${a}\`${res ? ` on \`${res}\`` : ""} is allowed; the deploy role shouldn't be able to do that.`;
              }
              return true;
            },
          },
          {
            id: "plan-role",
            title: "A read-only role for pull requests",
            description:
              "Create `gha-plan-app`, trusted (same rules as before: `StringEquals` on `aud` and `sub`) only for `repo:acme/app:pull_request`, with the AWS managed policy `ReadOnlyAccess` attached and no write permissions.",
            hints: [
              "Copy `trust-deploy.json` to `trust-plan.json` and change only the `sub` value.",
              "`aws iam attach-role-policy --role-name gha-plan-app --policy-arn arn:aws:iam::aws:policy/ReadOnlyAccess`",
            ],
            check: async (ctx) => {
              const { tryAws, account } = ctx;
              const r = await tryAws(["iam", "get-role", "--role-name", "gha-plan-app"]);
              if (!r.ok) return "Role `gha-plan-app` doesn't exist yet.";
              const p = trustProblems(r.data.Role.AssumeRolePolicyDocument, account, "repo:acme/app:pull_request");
              if (p) return p;
              const att = await tryAws(["iam", "list-attached-role-policies", "--role-name", "gha-plan-app"]);
              const arns = (att.data?.AttachedPolicies ?? []).map((x: any) => x.PolicyArn);
              if (!arns.includes("arn:aws:iam::aws:policy/ReadOnlyAccess")) return "`ReadOnlyAccess` isn't attached to `gha-plan-app`.";
              const fn = `arn:aws:lambda:us-east-1:${account}:function:app-api`;
              if ((await simulate(ctx, "gha-plan-app", "lambda:GetFunction", fn)) !== "allowed") return "`gha-plan-app` can't read functions; is `ReadOnlyAccess` attached?";
              if ((await simulate(ctx, "gha-plan-app", "lambda:UpdateFunctionCode", fn)) === "allowed")
                return "`gha-plan-app` can update function code. A PR role must not be able to change anything.";
              return true;
            },
          },
        ],
        solution: String.raw`
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com --client-id-list sts.amazonaws.com

P=arn:aws:iam::000000000000:oidc-provider/token.actions.githubusercontent.com
trust() {
  cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "$P" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        "token.actions.githubusercontent.com:sub": "$1"
      }
    }
  }]
}
EOF
}
trust repo:acme/app:ref:refs/heads/main > trust-deploy.json
trust repo:acme/app:pull_request > trust-plan.json

aws iam create-role --role-name gha-deploy-app --assume-role-policy-document file://trust-deploy.json --max-session-duration 3600
cat > deploy-policy.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReleaseAppFunctions",
      "Effect": "Allow",
      "Action": ["lambda:UpdateFunctionCode", "lambda:PublishVersion", "lambda:UpdateAlias", "lambda:GetFunction"],
      "Resource": "arn:aws:lambda:us-east-1:000000000000:function:app-*"
    },
    {
      "Sid": "UploadAppArtifacts",
      "Effect": "Allow",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::acme-artifacts/app/*"
    }
  ]
}
EOF
aws iam put-role-policy --role-name gha-deploy-app --policy-name deploy --policy-document file://deploy-policy.json

aws iam create-role --role-name gha-plan-app --assume-role-policy-document file://trust-plan.json
aws iam attach-role-policy --role-name gha-plan-app --policy-arn arn:aws:iam::aws:policy/ReadOnlyAccess
`,
      },
    },
    {
      id: "canary-release",
      kind: "lab",
      title: "Lab: a Lambda canary release with a weighted alias",
      minutes: 30,
      body: String.raw`
\`setup\` has deployed the function \`app-api\` (Python, code in \`app/handler.py\`, returning \`{"version": "v1"}\`). Callers will use the alias \`live\`, never \`$LATEST\`. You'll release v2 the way CodeDeploy's \`LambdaCanary10Percent5Minutes\` would: 10% first, watched by an alarm, then 100%.

## Useful commands

\`\`\`bash
aws lambda list-versions-by-function --function-name app-api --query 'Versions[].[Version,Description]' --output text
aws lambda list-aliases --function-name app-api
\`\`\`

To see the split in action during the canary, invoke the alias a few times and count which version ran:

\`\`\`text
for i in $(seq 20); do
  aws lambda invoke --function-name app-api --qualifier live /dev/null --query ExecutedVersion --output text
done | sort | uniq -c
\`\`\`

Weights are per invocation and random, so 20 calls at 10% won't give exactly 2. That's also why a low-traffic canary can bake for five minutes with no traffic at all: generate synthetic traffic if you need a signal.

## Notes

- After \`update-function-code\`, wait with \`aws lambda wait function-updated-v2\` before \`publish-version\`, or you can publish the old code.
- \`--routing-config\` takes JSON: \`'{"AdditionalVersionWeights":{"2":0.1}}'\`. The CLI's shorthand syntax can't express a key that's a number.
- The checks look at the **end state**, so record the canary state to \`canary.json\` while it's in progress.
`,
      lab: {
        files: {
          "app/handler.py": String.raw`
VERSION = "v1"


def handler(event, context):
    return {"version": VERSION}
`,
        },
        setup: String.raw`
aws iam create-role --role-name app-api-role \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
aws iam attach-role-policy --role-name app-api-role --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
(cd app && zip -q ../app.zip handler.py)
aws lambda create-function --function-name app-api --runtime python3.12 --handler handler.handler \
  --role arn:aws:iam::000000000000:role/app-api-role --zip-file fileb://app.zip >/dev/null
aws lambda wait function-active-v2 --function-name app-api
`,
        tasks: [
          {
            id: "baseline",
            title: "Publish v1 and point the live alias at it",
            description:
              "Publish the current code as version `1` and create an alias named `live` that points at it. From now on, callers use `app-api:live`.",
            hints: [
              "`aws lambda publish-version --function-name app-api --description v1`",
              "`aws lambda create-alias --function-name app-api --name live --function-version 1`",
            ],
            check: async (ctx) => {
              const a = await ctx.tryAws(["lambda", "get-alias", "--function-name", "app-api", "--name", "live"]);
              if (!a.ok) return "Alias `live` doesn't exist on `app-api` yet.";
              const out = await invoke(ctx, "app-api", "1");
              if (out === null) return "Version 1 of `app-api` doesn't exist yet. Publish one.";
              if (!out.includes('"v1"')) return `Version 1 returns ${out}; it should be the original code returning v1.`;
              return true;
            },
          },
          {
            id: "canary",
            title: "Ship v2 as a 10% canary and record it",
            description:
              "Change `app/handler.py` so it returns `v2`, deploy it, publish it as version `2`, then shift **10%** of the `live` alias's traffic to version 2 (version 1 keeps 90%). While the canary is running, save the alias description to `canary.json` (`aws lambda get-alias --function-name app-api --name live > canary.json`).",
            hints: [
              "Edit the file, zip it again and run `aws lambda update-function-code --function-name app-api --zip-file fileb://app.zip`, then `aws lambda wait function-updated-v2 --function-name app-api`.",
              "`aws lambda publish-version --function-name app-api --description v2`",
              "`aws lambda update-alias --function-name app-api --name live --routing-config '{\"AdditionalVersionWeights\":{\"2\":0.1}}'` then `get-alias … > canary.json`.",
            ],
            check: async (ctx) => {
              const out = await invoke(ctx, "app-api", "2");
              if (out === null) return "Version 2 of `app-api` doesn't exist yet.";
              if (!out.includes('"v2"')) return `Version 2 returns ${out}; did you wait for the code update before publishing?`;
              const f = await ctx.readFile("canary.json");
              if (f === null) return "`canary.json` not found. Record the alias while the canary is at 10%.";
              let j: any;
              try {
                j = JSON.parse(f);
              } catch {
                return "`canary.json` isn't valid JSON. Save the output of `aws lambda get-alias`.";
              }
              if (j.Name !== "live") return `\`canary.json\` describes alias \`${j.Name}\`; expected \`live\`.`;
              if (j.FunctionVersion !== "1") return `In \`canary.json\` the alias's primary version is ${j.FunctionVersion}; during the canary it should still be 1.`;
              const w = j.RoutingConfig?.AdditionalVersionWeights ?? {};
              if (Math.abs((w["2"] ?? 0) - 0.1) > 1e-9 || Object.keys(w).length !== 1)
                return `In \`canary.json\` the additional weights are ${JSON.stringify(w)}; expected {"2": 0.1}.`;
              return true;
            },
          },
          {
            id: "alarm",
            title: "Alarm on the canary's errors",
            description:
              "Create a CloudWatch alarm `app-api-canary-errors` that a pipeline (or CodeDeploy) would use to roll back: metric `Errors` in `AWS/Lambda`, dimensions `FunctionName=app-api`, `Resource=app-api:live` and `ExecutedVersion=2`, statistic `Sum`, 60-second period, alarming when the sum is **at least 1**, and treating missing data as not breaching.",
            hints: [
              "`aws cloudwatch put-metric-alarm --alarm-name app-api-canary-errors --namespace AWS/Lambda --metric-name Errors …`",
              "`--dimensions Name=FunctionName,Value=app-api Name=Resource,Value=app-api:live Name=ExecutedVersion,Value=2 --statistic Sum --period 60 --evaluation-periods 1 --threshold 1 --comparison-operator GreaterThanOrEqualToThreshold --treat-missing-data notBreaching`",
            ],
            check: async ({ tryAws }) => {
              const r = await tryAws(["cloudwatch", "describe-alarms", "--alarm-names", "app-api-canary-errors"]);
              const a = r.data?.MetricAlarms?.[0];
              if (!a) return "Alarm `app-api-canary-errors` doesn't exist yet.";
              if (a.Namespace !== "AWS/Lambda" || a.MetricName !== "Errors") return `The alarm watches ${a.Namespace}/${a.MetricName}; expected AWS/Lambda/Errors.`;
              const d = Object.fromEntries((a.Dimensions ?? []).map((x: any) => [x.Name, x.Value]));
              const want = { FunctionName: "app-api", Resource: "app-api:live", ExecutedVersion: "2" };
              for (const [k, v] of Object.entries(want))
                if (d[k] !== v) return `Dimension \`${k}\` is ${JSON.stringify(d[k])}; expected \`${v}\`. Without ExecutedVersion the alarm mixes the old version's errors in.`;
              if (Object.keys(d).length !== 3) return `The alarm has extra dimensions ${JSON.stringify(d)}; a metric only matches with exactly these three.`;
              if (a.Statistic !== "Sum" || a.Period !== 60) return `Use statistic Sum over a 60-second period (found ${a.Statistic}/${a.Period}).`;
              const fires1 =
                (a.ComparisonOperator === "GreaterThanOrEqualToThreshold" && a.Threshold <= 1 && a.Threshold > 0) ||
                (a.ComparisonOperator === "GreaterThanThreshold" && a.Threshold >= 0 && a.Threshold < 1);
              if (!fires1) return `The alarm is ${a.ComparisonOperator} ${a.Threshold}; it should fire as soon as there is one error.`;
              if (a.TreatMissingData !== "notBreaching") return `TreatMissingData is ${a.TreatMissingData ?? "missing"}; a canary with no traffic shouldn't count as failing. Use notBreaching.`;
              return true;
            },
          },
          {
            id: "promote",
            title: "Promote v2 to 100%",
            description:
              "The bake period passed with the alarm in OK. Promote: point `live` at version `2` with **no** additional routing weights. Keep version 1 published: it's your rollback target.",
            hints: [
              "Set the primary version and clear the weights in one call so there's no moment with a strange split.",
              "`aws lambda update-alias --function-name app-api --name live --function-version 2 --routing-config '{}'`",
            ],
            check: async (ctx) => {
              const a = await ctx.tryAws(["lambda", "get-alias", "--function-name", "app-api", "--name", "live"]);
              if (!a.ok) return "Alias `live` doesn't exist.";
              if (a.data.FunctionVersion !== "2") return `\`live\` points at version ${a.data.FunctionVersion}; promote it to 2.`;
              const w = a.data.RoutingConfig?.AdditionalVersionWeights ?? {};
              if (Object.keys(w).length) return `\`live\` still has additional weights ${JSON.stringify(w)}; clear them with \`--routing-config '{}'\`.`;
              const v1 = await invoke(ctx, "app-api", "1");
              if (v1 === null) return "Version 1 is gone. Keep the previous version so rollback is a pointer change.";
              const live = await invoke(ctx, "app-api", "live");
              if (!live?.includes('"v2"')) return `Invoking \`live\` returns ${live}; expected v2.`;
              return true;
            },
          },
        ],
        solution: String.raw`
V1=$(aws lambda publish-version --function-name app-api --description v1 --query Version --output text)
aws lambda create-alias --function-name app-api --name live --function-version "$V1"

sed -i 's/VERSION = "v1"/VERSION = "v2"/' app/handler.py
(cd app && zip -q ../app.zip handler.py)
aws lambda update-function-code --function-name app-api --zip-file fileb://app.zip >/dev/null
aws lambda wait function-updated-v2 --function-name app-api
V2=$(aws lambda publish-version --function-name app-api --description v2 --query Version --output text)

aws lambda update-alias --function-name app-api --name live \
  --routing-config "{\"AdditionalVersionWeights\":{\"$V2\":0.1}}" >/dev/null
aws lambda get-alias --function-name app-api --name live > canary.json

aws cloudwatch put-metric-alarm --alarm-name app-api-canary-errors \
  --namespace AWS/Lambda --metric-name Errors \
  --dimensions Name=FunctionName,Value=app-api Name=Resource,Value=app-api:live Name=ExecutedVersion,Value="$V2" \
  --statistic Sum --period 60 --evaluation-periods 1 --threshold 1 \
  --comparison-operator GreaterThanOrEqualToThreshold --treat-missing-data notBreaching

# bake: here a pipeline would wait N minutes and roll back if the alarm went to ALARM
aws cloudwatch describe-alarms --alarm-names app-api-canary-errors --query 'MetricAlarms[0].StateValue' --output text

aws lambda update-alias --function-name app-api --name live --function-version "$V2" --routing-config '{}'
`,
      },
    },
  ],
  quiz: [
    {
      q: "Your pipeline builds the app in the staging job, runs tests, then the prod job runs `npm ci && npm run build` again and deploys. A prod-only bug appears that staging never showed. What's the root process problem?",
      options: [
        "The prod account has different IAM permissions",
        "The pipeline rebuilds per environment, so prod runs a different artifact than the one that was tested; it should build once and promote the same artifact by digest",
        "Staging should use more instances",
        "`npm ci` is non-deterministic and should be replaced with `npm install`",
      ],
      answer: 1,
      explain:
        "Two builds are two artifacts: base images, toolchains or registry contents can differ between them, even with a lockfile. Build once, record the digest, store it in a shared registry or bucket, and promote that exact artifact. Configuration, not code, should differ between environments.",
    },
    {
      q: "A role's trust policy allows `sts:AssumeRoleWithWebIdentity` from the GitHub OIDC provider with only the condition `token.actions.githubusercontent.com:aud = sts.amazonaws.com`. Who can assume it?",
      options: [
        "Only workflows in your organisation",
        "Only workflows on the default branch of your repositories",
        "Any GitHub Actions workflow in any repository, because every GitHub token for AWS carries that audience",
        "Nobody: the policy is invalid without a thumbprint",
      ],
      answer: 2,
      explain:
        "The provider is GitHub-wide. The audience only says the token was minted for AWS. The `sub` claim (`repo:org/repo:ref:refs/heads/main`, or `…:environment:production`) is what ties it to your repository, so always pin it with `StringEquals`.",
    },
    {
      q: "Pull requests must run `terraform plan` against the staging account. What's the safest credential setup?",
      options: [
        "Store the deploy role's access key as a repository secret",
        "Let PRs assume the deploy role, but only via `pull_request_target`",
        "A separate read-only role trusted only for `repo:acme/app:pull_request`, while the write role trusts only `main` or the production environment",
        "Give PRs the deploy role and require a manual approval before apply",
      ],
      answer: 2,
      explain:
        "Separate roles keep a malicious or buggy PR from changing anything. `pull_request_target` runs in the base repo's context with its secrets and is a well-known way to leak them to fork code. Long-lived keys shouldn't exist at all.",
    },
    {
      q: "During a 10% Lambda canary, your error alarm uses dimensions `FunctionName=app-api, Resource=app-api:live`. The canary version fails 50% of its requests, yet the alarm (threshold: error rate above 10%) stays OK. Why?",
      options: [
        "Lambda doesn't publish metrics for aliases",
        "The alarm mixes both versions: 50% errors on 10% of traffic is about 5% overall. Add the `ExecutedVersion` dimension to watch the canary alone",
        "Alarms can't evaluate error rates",
        "The canary should be at 50% to be visible",
      ],
      answer: 1,
      explain:
        "Alias-level metrics aggregate every version behind the alias. Lambda also publishes per-alias metrics with an `ExecutedVersion` dimension. Alarm on the new version specifically, or a small, very bad canary will hide inside the healthy majority.",
    },
    {
      q: "Which change is safe to ship in one deploy, alongside the code that uses it, with a rolling deployment?",
      options: [
        "Renaming a column the old code reads",
        "Dropping a column the old code still writes",
        "Adding a new nullable column that only the new code reads and writes",
        "Changing a column's type from text to integer",
      ],
      answer: 2,
      explain:
        "During a rolling or canary deploy, old and new code run at once against the same database. An additive, nullable change (the 'expand' step) is compatible with both. Renames, drops and type changes need the full expand → migrate → contract sequence over several deploys.",
    },
    {
      q: "Your integration tests run against the emulator in CI and pass. Which risk do they NOT cover, so you still need a real-account smoke test?",
      options: [
        "An EventBridge rule targeting a queue without a queue policy",
        "A CloudFormation template referencing a non-existent attribute",
        "An identity policy on the deploy role that's missing an action",
        "A missing waiter, so a script races a CREATING table",
      ],
      answer: 2,
      explain:
        "The emulator enforces trust policies and the resource policies on integrations (queue policies, invoke permissions), and validates templates and async states like AWS. It doesn't fully enforce identity policies on ordinary calls, so test least privilege with policy simulation and a real-account smoke test.",
    },
    {
      q: "You want to roll out a risky new pricing engine to 1% of customers, expand gradually, and turn it off in seconds without a deploy. What fits best?",
      options: [
        "Blue/green deployment",
        "All-at-once deployment with a fast rollback script",
        "A feature flag (e.g. AWS AppConfig) evaluated at runtime, with the code already deployed dark",
        "A linear deployment of 1% per hour",
      ],
      answer: 2,
      explain:
        "Deployment strategies shift traffic by *request* between *versions*; they can't target a stable customer cohort or switch off without another deploy. Feature flags separate release from deploy: the code ships dark, and exposure is controlled per user or percentage at runtime.",
    },
  ],
};
