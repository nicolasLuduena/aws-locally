import type { Module } from "../types.ts";

export const foundations: Module = {
  id: "foundations",
  number: "00",
  title: "How AWS actually works",
  summary: "Build the mental model every other module relies on: regions, accounts, ARNs, signed API calls, and the CLI as a precision tool.",
  services: ["STS", "S3", "SQS", "CLI"],
  lessons: [
    {
      id: "mental-model",
      kind: "reading",
      title: "The shape of AWS",
      minutes: 10,
      body: String.raw`
AWS is not a website with buttons. It is **a few hundred HTTP APIs** that share an identity system, a naming scheme and a billing system. The console, the CLI, Terraform and the SDKs are all clients of those same APIs. Once you see it that way, everything else in this course is detail.

## Regions, Availability Zones, accounts

<figure class="diagram">
<svg viewBox="0 0 640 250" role="img" aria-label="An AWS account spans regions; each region contains isolated availability zones">
  <rect x="10" y="10" width="620" height="230" rx="10" class="d-box d-outer"/>
  <text x="26" y="34" class="d-label">AWS account 000000000000 (the security &amp; billing boundary)</text>
  <rect x="30" y="50" width="370" height="170" rx="8" class="d-box"/>
  <text x="46" y="74" class="d-label">Region us-east-1</text>
  <rect x="48" y="88" width="104" height="110" rx="6" class="d-box d-accent"/><text x="100" y="146" text-anchor="middle" class="d-small">AZ us-east-1a</text>
  <rect x="166" y="88" width="104" height="110" rx="6" class="d-box d-accent"/><text x="218" y="146" text-anchor="middle" class="d-small">AZ us-east-1b</text>
  <rect x="284" y="88" width="104" height="110" rx="6" class="d-box d-accent"/><text x="336" y="146" text-anchor="middle" class="d-small">AZ us-east-1c</text>
  <rect x="420" y="50" width="190" height="170" rx="8" class="d-box d-dim"/>
  <text x="436" y="74" class="d-label">Region eu-west-1</text>
  <text x="515" y="146" text-anchor="middle" class="d-small">separate endpoints,</text>
  <text x="515" y="164" text-anchor="middle" class="d-small">separate resources</text>
</svg>
<figcaption>Accounts are hard boundaries. Regions are independent copies of the platform. AZs are isolated data centres inside a region.</figcaption>
</figure>

- **Region**: a fully independent deployment of AWS (\`us-east-1\`, \`eu-west-1\`). Resources live in one region, and each region has its own API endpoints. A bucket you create in one region is not visible from another region's EC2 API.
- **Availability Zone (AZ)**: one or more data centres with independent power and networking, a few milliseconds apart. **High availability on AWS means spreading across AZs.** Subnets, EC2 instances and EBS volumes are *zonal*. Load balancers, Auto Scaling groups and RDS Multi-AZ are how you span zones.
- **Account**: the hard boundary for security, quotas and billing. Mature organisations run *many* accounts (prod, staging, shared-services, log-archive, security), managed with AWS Organizations, because an account boundary is the strongest isolation AWS gives you.
- **Global services**: IAM, Route 53, CloudFront and Organizations are not regional. IAM is the one that matters most here: a role exists in every region at once.

## ARNs: the universal resource name

Every resource has an **Amazon Resource Name**:

\`\`\`text
arn:partition:service:region:account-id:resource-type/resource-id
arn:aws:sqs:us-east-1:000000000000:orders
arn:aws:iam::000000000000:role/deployer          ← IAM is global: no region
arn:aws:s3:::my-bucket                           ← S3 bucket names are global: no region, no account
arn:aws:lambda:us-east-1:000000000000:function:api
\`\`\`

ARNs are what policies, event rules and integrations point at. If you can read an ARN, you can tell *what* a policy grants access to.

## The shared responsibility model

AWS secures the cloud: hardware, hypervisors, the physical network, and the managed parts of managed services. **You** secure what you put in the cloud: IAM, network exposure, encryption settings, patching your own instances, and your application. Almost every real-world AWS breach is on the customer side: a public bucket, a leaked access key, a security group open to \`0.0.0.0/0\`. Much of DevOps on AWS is getting your side of that line right *by default*, through code.

## The DevOps lens

As a DevOps engineer you rarely click through the console. You:

1. **Describe infrastructure as code** (CloudFormation, Terraform, CDK) so every environment is reproducible.
2. **Automate through APIs** (CLI scripts, pipelines, SDK tooling).
3. **Design for failure**: multi-AZ, retries with backoff, dead-letter queues, alarms.
4. **Apply least privilege**: every workload gets its own narrowly scoped role.
5. **Observe everything**: metrics, logs, traces and audit trails (CloudTrail).

Every module ends with you doing these things for real, against the emulator.
`,
    },
    {
      id: "api-calls",
      kind: "reading",
      title: "Every action is a signed API call",
      minutes: 12,
      body: String.raw`
When you run \`aws s3api create-bucket --bucket demo\`, the CLI:

1. Resolves **credentials** (env vars → shared credentials file → SSO/role config → instance or container metadata).
2. Resolves the **region** and the **endpoint** (normally \`https://s3.us-east-1.amazonaws.com\`; in this course, the emulator).
3. Serialises the request in that service's **protocol**.
4. **Signs it with Signature Version 4 (SigV4)**: an HMAC over the method, path, headers, body hash, date, region and service, keyed with a key derived from your secret access key.
5. Sends it over HTTPS, parses the response, and turns error responses into exceptions.

<figure class="diagram">
<svg viewBox="0 0 640 150" role="img" aria-label="CLI signs requests and sends them to the inspector proxy which forwards them to the emulator">
  <rect x="10" y="40" width="150" height="70" rx="8" class="d-box"/><text x="85" y="70" text-anchor="middle" class="d-label">aws CLI / SDK</text><text x="85" y="90" text-anchor="middle" class="d-small">signs with SigV4</text>
  <rect x="245" y="40" width="150" height="70" rx="8" class="d-box d-accent"/><text x="320" y="70" text-anchor="middle" class="d-label">Inspector proxy</text><text x="320" y="90" text-anchor="middle" class="d-small">:9298, records calls</text>
  <rect x="480" y="40" width="150" height="70" rx="8" class="d-box"/><text x="555" y="70" text-anchor="middle" class="d-label">AWS Emulator</text><text x="555" y="90" text-anchor="middle" class="d-small">:9297, verifies SigV4</text>
  <path d="M160 75 H243" class="d-arrow"/><path d="M395 75 H478" class="d-arrow"/>
  <text x="202" y="66" text-anchor="middle" class="d-small">HTTP</text><text x="437" y="66" text-anchor="middle" class="d-small">HTTPS</text>
</svg>
<figcaption>In this course the terminal's <code>AWS_ENDPOINT_URL</code> points at a small proxy, so you can see every request in the <b>API</b> tab.</figcaption>
</figure>

## Four wire protocols

AWS services grew up at different times, so they speak different dialects. You will see all of them in the **API** tab:

| Protocol | How the operation is named | Examples |
|---|---|---|
| **query** | form-encoded \`Action=CreateVpc\` | EC2, IAM, STS, SNS, CloudFormation, ELB, Auto Scaling |
| **json** | header \`X-Amz-Target: DynamoDB_20120810.PutItem\` | DynamoDB, SQS, KMS, Logs, ECS, Step Functions |
| **rest-json / rest-xml** | the HTTP method and path | S3, Lambda, API Gateway, Route 53 |
| **rpc-v2-cbor** | path \`/service/X/operation/Y\`, binary body | CloudWatch metrics (newer SDKs) |

You never have to hand-write these, but recognising them makes debugging *much* faster. When a Terraform apply hangs, the question is always "which API call, with what response?"

## Control plane vs data plane

- **Control plane**: create, describe, update, delete, list resources (\`CreateTable\`, \`RunInstances\`). Low volume, often eventually consistent, and frequently *asynchronous*: \`CreateTable\` returns \`CREATING\` before the table exists.
- **Data plane**: the service doing its job (\`PutItem\`, \`GetObject\`, \`SendMessage\`, \`Invoke\`). High volume, designed for availability.

Good operational practice keeps your **runtime path on the data plane only**. Don't call \`CreateQueue\` on every request; create the queue once with IaC. During incidents, control planes are the first thing to degrade.

## Asynchronous resources and waiters

Because control planes are async, scripts must **wait for a state**, not sleep:

\`\`\`bash
aws dynamodb create-table --table-name Demo \
  --attribute-definitions AttributeName=id,AttributeType=S \
  --key-schema AttributeName=id,KeyType=HASH --billing-mode PAY_PER_REQUEST \
  --query TableDescription.TableStatus
aws dynamodb wait table-exists --table-name Demo && echo ready
\`\`\`

Run it, then open the **API** tab. The waiter is just \`DescribeTable\` in a loop. Terraform and CloudFormation do exactly the same thing internally.

## Errors are part of the API

Every error has a **code** (\`ValidationException\`, \`AccessDenied\`, \`ResourceNotFoundException\`, \`ThrottlingException\`) and an HTTP status. 4xx means *your request is wrong*: fix it, don't retry. 5xx and throttling mean *retry with exponential backoff and jitter*. The SDKs do that automatically. Try one:

\`\`\`bash
aws dynamodb create-table --table-name ab \
  --attribute-definitions AttributeName=id,AttributeType=S \
  --key-schema AttributeName=id,KeyType=HASH --billing-mode PAY_PER_REQUEST
\`\`\`

The emulator returns the same \`ValidationException\` and message that AWS does. That fidelity is the whole point of testing against it.
`,
    },
    {
      id: "environment",
      kind: "reading",
      title: "Your lab environment",
      minutes: 6,
      body: String.raw`
Everything in this course runs on your machine against **AWS Emulator**, AWS's official local emulator of the AWS APIs. There is no account, no bill, and no way to touch real AWS from the course terminal.

## What's running

| Piece | Where | What it does |
|---|---|---|
| \`aws-emulator\` | \`https://127.0.0.1:9297\` | Implements the AWS APIs in memory. Generates fresh SigV4 keys and a TLS cert on every start. |
| Inspector proxy | \`http://127.0.0.1:9298\` | Forwards to the emulator and records every call for the **API** tab. |
| Course terminal | the **Terminal** tab | A real bash shell. All \`AWS_*\` variables point at the emulator, and your own AWS profiles are removed. |

The terminal is a normal shell, so \`jq\`, pipes, variables, \`vim\` and \`terraform\` all work. Run \`whereami\` to see the endpoint and identity:

\`\`\`bash
whereami
env | grep ^AWS_ | sort
\`\`\`

## Using the emulator from your own terminal

These are the variables the emulator's documentation tells you to set. Use them in any shell (port 9297 talks to the emulator directly, without the inspector):

\`\`\`text
export AWS_ENDPOINT_URL=https://127.0.0.1:9297
export AWS_SHARED_CREDENTIALS_FILE=<repo>/.state/emulator-home/.aws/emulator/9297/emulator_credentials
export AWS_CONFIG_FILE=<repo>/.state/emulator-home/.aws/emulator/9297/config
export AWS_CA_BUNDLE=<repo>/.state/emulator-home/.aws/emulator/9297/ca.pem
export AWS_EC2_METADATA_DISABLED=true AWS_DISABLE_HOST_PREFIX_INJECTION=true
export AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE
\`\`\`

The \`unset\` line matters. Environment credentials take precedence over the credentials file, and the emulator rejects requests signed with real keys.

## Rules of the emulator

- **State lives in memory.** *Reset* in the top bar restarts the emulator and wipes everything. Each lab has a **Prepare lab** button that recreates its prerequisites, so resetting between labs is safe.
- **One account (\`000000000000\`) and one region (\`us-east-1\`).** Run a second emulator on another port if you need to simulate multi-region.
- **Fidelity is high, not perfect.** Validation errors, async states and many cross-service integrations (SNS→SQS, EventBridge→SQS, SQS→Lambda, alarms→SNS) behave like AWS. It even enforces trust policies and queue policies on those integrations. It is still **not** a security test bench: use IAM policy simulation and real-account reviews for that. Unimplemented operations return HTTP 501 \`NotImplemented\`.
- **Lambda really runs your code** on your machine, using the matching local runtime (for example \`python3\`).
- **EC2 instances, RDS databases and EKS clusters are control-plane only.** They get IDs, states and IPs, but no VM boots. That's exactly what IaC and pipeline testing need.

> **Why this matters for DevOps:** the same emulator runs in CI. Later you'll wire it into a pipeline so every pull request runs integration tests and \`terraform plan/apply\` without an AWS account.
`,
    },
    {
      id: "cli-fluency",
      kind: "lab",
      title: "Lab: CLI fluency",
      minutes: 20,
      body: String.raw`
The AWS CLI is your scalpel. Three skills separate fluent operators from people who copy-paste: **\`--query\`** (JMESPath filtering), **\`--output text\`** for shell capture, and **waiters**.

## JMESPath in 60 seconds

\`\`\`bash
aws sqs create-queue --queue-name jobs --attributes VisibilityTimeout=45
aws sqs list-queues --query 'QueueUrls[0]' --output text
aws sqs get-queue-attributes --queue-url "$(aws sqs get-queue-url --queue-name jobs --query QueueUrl --output text)" \
  --attribute-names All --query 'Attributes.{arn: QueueArn, vis: VisibilityTimeout}'
\`\`\`

- \`Foo.Bar\`: navigate. \`Foo[0]\`: index. \`Foo[*].Name\` or \`Foo[].Name\`: project a list.
- \`Foo[?State=='running'].Id\`: filter. \`{a: X, b: Y}\`: reshape. \`length(Foo)\`: count.
- \`--output text\` strips quotes, which is what you want for \`VAR=$(...)\`.

## Capture IDs, don't copy them

\`\`\`bash
QURL=$(aws sqs get-queue-url --queue-name jobs --query QueueUrl --output text)
echo "$QURL"
\`\`\`

This is the core idiom of every infrastructure script you will write.

## Your tasks

Press **Prepare lab** first, so the terminal moves into this lab's folder. Then complete the tasks below and press **Check**. Watch the **API** and **Resources** tabs as you go.
`,
      lab: {
        tasks: [
          {
            id: "bucket",
            title: "Create and tag a bucket",
            description:
              "Create an S3 bucket named `course-artifacts` and give it the tags `team=platform` and `env=dev`.",
            hints: [
              "Bucket creation is `aws s3api create-bucket --bucket …`.",
              "Tags are set with `aws s3api put-bucket-tagging --bucket course-artifacts --tagging 'TagSet=[{Key=team,Value=platform},{Key=env,Value=dev}]'`.",
            ],
            check: async ({ aws, tryAws }) => {
              const head = await tryAws(["s3api", "head-bucket", "--bucket", "course-artifacts"]);
              if (!head.ok) return "Bucket `course-artifacts` doesn't exist yet.";
              const t = await tryAws(["s3api", "get-bucket-tagging", "--bucket", "course-artifacts"]);
              if (!t.ok) return "The bucket has no tags yet.";
              const tags = Object.fromEntries((t.data.TagSet ?? []).map((x: any) => [x.Key, x.Value]));
              if (tags.team !== "platform" || tags.env !== "dev")
                return `Tags are ${JSON.stringify(tags)}; expected team=platform and env=dev.`;
              return true;
            },
          },
          {
            id: "queue",
            title: "Create a queue with tuned attributes",
            description:
              "Create an SQS queue named `jobs` with a **visibility timeout of 45 seconds** and a **message retention period of 1 day** (in seconds).",
            hints: [
              "Attributes are strings: `--attributes VisibilityTimeout=45,MessageRetentionPeriod=…`.",
              "1 day = 86400 seconds. If the queue already exists, change it with `aws sqs set-queue-attributes`.",
            ],
            check: async ({ tryAws }) => {
              const u = await tryAws(["sqs", "get-queue-url", "--queue-name", "jobs"]);
              if (!u.ok) return "Queue `jobs` doesn't exist yet.";
              const a = await tryAws(["sqs", "get-queue-attributes", "--queue-url", u.data.QueueUrl, "--attribute-names", "All"]);
              const attrs = a.data?.Attributes ?? {};
              if (attrs.VisibilityTimeout !== "45") return `VisibilityTimeout is ${attrs.VisibilityTimeout}, expected 45.`;
              if (attrs.MessageRetentionPeriod !== "86400") return `MessageRetentionPeriod is ${attrs.MessageRetentionPeriod}, expected 86400.`;
              return true;
            },
          },
          {
            id: "capture",
            title: "Capture an ARN with --query",
            description:
              "Write the **ARN** of the `jobs` queue (and nothing else) into a file named `queue-arn.txt` in the lab folder, using `--query` and `--output text`.",
            hints: [
              "`get-queue-attributes --attribute-names QueueArn --query Attributes.QueueArn --output text`",
              "Redirect with `> queue-arn.txt`.",
            ],
            check: async ({ readFile, region, account }) => {
              const f = await readFile("queue-arn.txt");
              if (f === null) return "`queue-arn.txt` not found in the lab folder. Did you press Prepare lab so the terminal is in the right directory?";
              const want = `arn:aws:sqs:${region}:${account}:jobs`;
              if (f.trim() !== want) return `The file contains \`${f.trim().slice(0, 80)}\`; expected exactly \`${want}\`.`;
              return true;
            },
          },
          {
            id: "table",
            title: "Create a table and wait for it",
            description:
              "Create a DynamoDB table `sessions` with a string partition key `sid`, on-demand billing. Use a **waiter** so your script only continues once it's ACTIVE.",
            hints: ["`--billing-mode PAY_PER_REQUEST`", "`aws dynamodb wait table-exists --table-name sessions`"],
            check: async ({ tryAws }) => {
              const d = await tryAws(["dynamodb", "describe-table", "--table-name", "sessions"]);
              if (!d.ok) return "Table `sessions` doesn't exist yet.";
              const t = d.data.Table;
              const key = t.KeySchema?.find((k: any) => k.KeyType === "HASH");
              if (key?.AttributeName !== "sid") return `Partition key is \`${key?.AttributeName}\`, expected \`sid\`.`;
              if (t.BillingModeSummary?.BillingMode !== "PAY_PER_REQUEST") return "Billing mode should be PAY_PER_REQUEST (on-demand).";
              if (t.TableStatus !== "ACTIVE") return `Table status is ${t.TableStatus}. Wait for it.`;
              return true;
            },
          },
        ],
        solution: String.raw`
aws s3api create-bucket --bucket course-artifacts
aws s3api put-bucket-tagging --bucket course-artifacts --tagging 'TagSet=[{Key=team,Value=platform},{Key=env,Value=dev}]'
aws sqs create-queue --queue-name jobs --attributes VisibilityTimeout=45,MessageRetentionPeriod=86400
QURL=$(aws sqs get-queue-url --queue-name jobs --query QueueUrl --output text)
aws sqs get-queue-attributes --queue-url "$QURL" --attribute-names QueueArn --query Attributes.QueueArn --output text > queue-arn.txt
aws dynamodb create-table --table-name sessions --attribute-definitions AttributeName=sid,AttributeType=S \
  --key-schema AttributeName=sid,KeyType=HASH --billing-mode PAY_PER_REQUEST
aws dynamodb wait table-exists --table-name sessions
`,
      },
    },
  ],
  quiz: [
    {
      q: "A Terraform apply creating a DynamoDB table succeeds, but a script that runs immediately afterwards fails with ResourceNotFoundException on PutItem. What's the most likely cause?",
      options: [
        "The IAM policy is missing dynamodb:PutItem",
        "The script ran before the table left the CREATING state; it should use a waiter or poll DescribeTable",
        "DynamoDB tables are global and need replication first",
        "PutItem must be signed with SigV2",
      ],
      answer: 1,
      explain:
        "Control-plane operations are asynchronous. `CreateTable` returns while the table is still `CREATING`. Use `aws dynamodb wait table-exists`, or poll the describe call, before you use the table.",
    },
    {
      q: "Which ARN belongs to a global service with no region component?",
      options: [
        "arn:aws:sqs:us-east-1:111122223333:orders",
        "arn:aws:lambda:us-east-1:111122223333:function:api",
        "arn:aws:iam::111122223333:role/deployer",
        "arn:aws:dynamodb:us-east-1:111122223333:table/Orders",
      ],
      answer: 2,
      explain: "IAM is global, so its ARNs leave the region field empty (`arn:aws:iam::account:…`). S3 bucket ARNs omit both region and account.",
    },
    {
      q: "Your app gets an HTTP 400 ValidationException from an AWS API. What should your retry logic do?",
      options: [
        "Retry immediately up to 10 times",
        "Retry with exponential backoff and jitter",
        "Not retry: fix the request, because 4xx errors are client errors",
        "Switch to another region and retry",
      ],
      answer: 2,
      explain:
        "4xx errors (apart from throttling) mean the request itself is wrong, and retrying won't change the answer. Retry 5xx and throttling errors with exponential backoff and jitter. The SDKs do this for you.",
    },
    {
      q: "Why do mature organisations run many AWS accounts instead of one big one?",
      options: [
        "Each account gets a free tier",
        "The account is the strongest isolation boundary for security, quotas and blast radius",
        "IAM roles can't be shared within one account",
        "Regions are limited to one per account",
      ],
      answer: 1,
      explain:
        "Accounts are hard boundaries. A compromised dev workload can't touch prod resources in another account unless a cross-account trust was explicitly granted. Quotas and billing are separated too.",
    },
    {
      q: "Which of these belongs on the data plane rather than the control plane?",
      options: ["sqs:CreateQueue", "ec2:RunInstances", "dynamodb:PutItem", "lambda:CreateFunction"],
      answer: 2,
      explain: "PutItem is the service doing its job: storing data. The others create or modify resources, which is control-plane work. Keep runtime code paths on the data plane.",
    },
  ],
};
