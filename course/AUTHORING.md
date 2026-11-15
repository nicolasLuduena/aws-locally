# Authoring course modules

Every module is one TypeScript file in `course/modules/NN-<id>.ts` that exports a
`Module` (schema: `course/types.ts`). It's registered in `course/index.ts`.
`course/modules/00-foundations.ts` is the reference module: match its depth,
tone and structure.

## Audience and bar

The learner wants a **DevOps-level** understanding of AWS: someone who will run
production infrastructure, write IaC and pipelines, and debug incidents. That means:

- Explain **how things work and why**, not only which command to type. Include
  failure modes, limits, defaults that bite, cost and security implications,
  and what a senior engineer would do in production.
- Each module has **3–5 readings** (roughly 600–1,400 words each) and **1–2 labs**,
  ending with a **quiz of 5–7 scenario-based questions** whose explanations teach.
- Use tables for comparisons, short runnable examples, and an inline SVG diagram
  wherever a picture explains a relationship (architecture, packet flow, policy
  evaluation, a pipeline). See "Diagrams".
- Flag real-AWS vs emulator differences in a `> **On real AWS:** …` blockquote
  when it matters (for example, EC2 instances don't actually boot here).

## Markdown and escaping

Bodies are Markdown with raw HTML allowed. Write them as `String.raw\`…\``, so
bash line continuations (`\` at the end of a line) survive. Inside String.raw:

- write every backtick as `` \` ``
- write a literal `${` as `\${` (otherwise JS interpolates it)

`course/index.ts` strips those backslashes. The same applies to `solution`,
`setup`, `files`, task descriptions and hints when you use String.raw.

Fenced ```` ```bash ```` blocks get **Run** and **Copy** buttons that type the
command into the course terminal. Use ```` ```text ````, ```` ```json ```` or
```` ```yaml ```` for anything that shouldn't be runnable. Runnable examples in
readings should work against the emulator, in order, on a fresh state. Prefer
unique names (`demo-…`) so they don't collide with lab resources.

## Diagrams

Inline SVG inside `<figure class="diagram">…<figcaption>…</figcaption></figure>`.
Use only these classes (the theme styles them for light and dark):

| class | use |
|---|---|
| `d-box` | normal rectangle (fill + stroke) |
| `d-box d-outer` | outer container (subtle) |
| `d-box d-accent` | highlighted box |
| `d-box d-dim` | de-emphasised box |
| `d-box d-danger` / `d-box d-ok` | red / green emphasis |
| `d-label` | text, 13px semibold |
| `d-small` | text, 11px muted |
| `d-arrow` | line or path with an arrowhead (`<path d="M.. H.." class="d-arrow"/>`) |
| `d-arrow d-dashed` | dashed arrow (async, optional) |

Give the `<svg>` a `viewBox` with a width of about 640, no fixed width or height,
plus `role="img"` and an `aria-label`. Keep labels short: text doesn't wrap in SVG.

## Labs

A lab is a goal-oriented exercise with automatically checked tasks.

- `files`: starter files written to `workspace/<module>-<lesson>/` (templates,
  Lambda handlers, policy JSON). The terminal `cd`s there on **Prepare lab**.
- `setup`: bash that creates prerequisites on an **empty** emulator. Labs must
  not depend on other labs, because the learner may have reset the emulator.
- `tasks[]`: each has a `title`, a goal-oriented `description` (say what to
  achieve and the exact names to use, not the exact command), 1–3 progressive
  `hints` (the last one may be nearly the full command), and an async `check`.
- `check(ctx)` inspects **end state through the API** (`ctx.aws([...])`,
  `ctx.tryAws([...])`, `ctx.readFile(path)`, `ctx.sh(script)`). Return `true`, or
  a specific, helpful failure string ("Versioning is Suspended; expected
  Enabled."). Checks must not mutate state (exception: reading or deleting a
  probe message is fine when the task requires it). Use `tryAws` for
  "does it exist" checks so the message is friendly.
- `solution`: a complete, deterministic bash script. `npm run verify` runs
  `setup` → checks (which must not all pass yet) → `solution` (with
  `set -eo pipefail`) → checks (which must all pass) on a fresh emulator.
  Use waiters, never `sleep`, except where you must wait for async delivery
  (SNS→SQS, an event source mapping); then poll in a loop with a timeout.

Verify an unregistered module file:

```bash
node scripts/verify-labs.ts --file course/modules/03-compute.ts -j 2 -v
```

To experiment ad hoc against a throwaway emulator (each Bash tool call is
network-isolated in the agent sandbox, so start the emulator in the same command):

```bash
scripts/with-emulator.sh bash -c 'aws sqs create-queue --queue-name x && aws sqs list-queues'
scripts/with-emulator.sh bash /path/to/probe.sh
```

## Verified emulator facts (v1.0.385)

- Account `000000000000`, region `us-east-1`. Default caller is `arn:aws:iam::000000000000:user/emulator`.
- **High fidelity on validation and async states.** `dynamodb create-table`
  returns `CREATING`, so use `aws dynamodb wait table-exists`. Lambda starts
  `Pending`, so use `aws lambda wait function-active-v2`. Invalid input returns the
  same error codes and messages as AWS.
- **IAM:** trust policies are enforced on `sts:AssumeRole` (AccessDenied if the
  trust policy doesn't allow the caller). `iam simulate-principal-policy` works.
  Managed policies like `arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole`
  exist. Identity policies are **not** fully enforced on ordinary calls, so
  don't build labs that expect AccessDenied from a missing identity policy.
  Use simulate-principal-policy for that. (Measured: for assumed-role
  sessions, identity policies are enforced for S3, IAM and KMS, but not for
  SQS, SSM paths or chained AssumeRole. Permissions boundaries only affect the
  simulator. Calls made from inside a Lambda function with its execution role
  ARE enforced: a missing `dynamodb:GetItem` gives a real AccessDenied. CloudTrail attributes AssumeRole calls signed with an IAM user's own
  keys to `user/emulator`.)
- The CLI caches assumed-role profile credentials under `~/.aws/cli/cache`,
  which is read-only in the agent sandbox. Use a temporary `HOME` when a check
  exercises a profile.
- **Integrations need the same permissions as on AWS:** SNS→SQS and
  EventBridge→SQS deliver only if the queue policy allows
  `sns.amazonaws.com` / `events.amazonaws.com` to `sqs:SendMessage`. Lambda
  event source mappings from SQS require the function role to have SQS
  permissions (attach `AWSLambdaSQSQueueExecutionRole`). Lambda writes logs to
  `/aws/lambda/<fn>` only if the role allows it (`AWSLambdaBasicExecutionRole`).
- **Lambda executes code.** Python runtimes (`python3.12`, `python3.13`) run on
  an embedded RustPython. `boto3` is importable and its clients reach the
  emulator automatically. Node runtimes (`nodejs22.x`) run on an embedded JS
  engine. Keep handlers to the standard library plus boto3 (Python) or plain
  JS (no npm packages). Zip with `zip -q fn.zip handler.py`.
- **API Gateway:** HTTP APIs (`apigatewayv2 create-api --protocol-type HTTP
  --target <lambda-arn>`) work and invoke Lambda. Call them through the
  emulator endpoint with a Host header:
  `curl -sS --cacert "$AWS_CA_BUNDLE" -H "Host: $API_ID.execute-api.us-east-1.amazonaws.com" "$AWS_ENDPOINT_URL/path"`
  (the course terminal also has `apicall <api-id> /path`). You need
  `lambda add-permission` for `apigateway.amazonaws.com`.
- **EC2/VPC:** VPCs, subnets (CIDR conflicts are validated), IGWs, route
  tables, SGs, launch templates and instances (state `pending` → `running`,
  private IPs assigned) all work. No VM boots. The AMI comes from
  `aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64`.
  Auto Scaling groups launch instances to the desired capacity. ELBv2 ALBs, target groups and listeners work.
- **S3:** buckets, objects, versioning, tagging and presigned URLs work.
- **CloudFormation:** `aws cloudformation deploy` creates real emulated
  resources. Outputs, parameters, change sets (`--no-execute-changeset`),
  delete and waiters work.
- **Terraform** (`.tools/bin/terraform`, AWS provider `~> 6.0`) works against
  the emulator via `AWS_ENDPOINT_URL`. In the provider block, set
  `s3_use_path_style = true`, `skip_credentials_validation = true` and
  `skip_requesting_account_id = true`. `aws_sqs_queue` takes about 25s to create.
  In the agent sandbox, Terraform's provider plugin handshake fails; run Terraform
  verification with the sandbox disabled.
- **CloudWatch:** `put-metric-data`, `get-metric-statistics` and alarms work.
  `set-alarm-state --state-value ALARM` fires the alarm's SNS action.
  Logs groups and filter-log-events work.
- **Step Functions:** `create-state-machine` and `start-execution` run (Pass/Choice/Succeed/Fail verified).
- **KMS** encrypt/decrypt, aliases, **Secrets Manager** and **SSM Parameter Store** work.
- **ECR** repositories, **ECS** clusters and task definitions, and **Route 53** hosted zones work.
  **EKS** create-cluster validates (needs subnets in 2 AZs).
- **CloudTrail** `lookup-events` returns recent API calls.
- Unimplemented operations return HTTP 501 `NotImplemented`. If you hit one,
  design the lab around it and mention it in the prose. Don't make a task depend on it.

Always probe an operation before you build a lab task on it.
