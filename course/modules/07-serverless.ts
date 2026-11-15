import type { CheckContext, Module } from "../types.ts";

// ------------------------------------------------------------ check helpers

const parse = (s: string): any => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

const asList = (x: any): any[] => (Array.isArray(x) ? x : x === undefined ? [] : [x]);

async function apiId(ctx: CheckContext, name: string): Promise<string | null> {
  const r = await ctx.tryAws(["apigatewayv2", "get-apis"]);
  if (!r.ok) return null;
  return (r.data?.Items ?? []).find((a: any) => a.Name === name)?.ApiId ?? null;
}

/** Call an HTTP API through the emulator endpoint with the API's Host header. */
async function callApi(ctx: CheckContext, id: string, method: string, path: string, body?: string) {
  const data = body === undefined ? "" : `-H 'content-type: application/json' --data '${body}'`;
  const r = await ctx.sh(
    `curl -sS --max-time 30 --cacert "$AWS_CA_BUNDLE" -X ${method} ${data} -H "Host: ${id}.execute-api.us-east-1.amazonaws.com" -w '\\n%{http_code}' "$AWS_ENDPOINT_URL${path}"`,
  );
  const lines = r.stdout.trimEnd().split("\n");
  const status = Number(lines.pop());
  return { status, body: lines.join("\n") };
}

/** All of a role's inline policy documents plus attached managed policy ARNs. */
async function rolePolicies(ctx: CheckContext, role: string) {
  const names = (await ctx.aws(["iam", "list-role-policies", "--role-name", role])).PolicyNames ?? [];
  const inline: any[] = [];
  for (const n of names) {
    const d = (await ctx.aws(["iam", "get-role-policy", "--role-name", role, "--policy-name", n])).PolicyDocument;
    inline.push(typeof d === "string" ? parse(decodeURIComponent(d)) : d);
  }
  const attached: string[] = ((await ctx.aws(["iam", "list-attached-role-policies", "--role-name", role])).AttachedPolicies ?? []).map(
    (p: any) => p.PolicyArn as string,
  );
  return { inline, attached };
}

const TABLE_ARN = (t: string) => `arn:aws:dynamodb:us-east-1:000000000000:table/${t}`;

/** Actions allowed on the table by inline policies, or a complaint about wildcards. */
function tableActions(inline: any[], table: string): { actions: Set<string>; wildcard: string | null } {
  const actions = new Set<string>();
  let wildcard: string | null = null;
  for (const doc of inline) {
    for (const s of asList(doc?.Statement)) {
      if (s.Effect !== "Allow") continue;
      const acts = asList(s.Action);
      const res = asList(s.Resource);
      if (acts.some((a: string) => a === "*" || a === "dynamodb:*")) wildcard = "an inline policy allows `dynamodb:*` (or `*`)";
      if (res.includes("*")) wildcard = "an inline policy uses `Resource: \"*\"`";
      if (res.includes(TABLE_ARN(table))) acts.forEach((a: string) => actions.add(a));
    }
  }
  return { actions, wildcard };
}

// ------------------------------------------------------------ lab files

const TRUST = String.raw`{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "lambda.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
`;

const NOTES_HANDLER = String.raw`import base64
import json
import os

import boto3
from botocore.exceptions import ClientError

# Init phase: runs once per execution environment, not on every request.
# Create SDK clients here so warm invocations reuse their connections.
TABLE = boto3.resource("dynamodb").Table(os.environ["TABLE"])


def respond(status, body):
    return {
        "statusCode": status,
        "headers": {"content-type": "application/json"},
        "body": json.dumps(body),
    }


def create_note(event):
    raw = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        raw = base64.b64decode(raw).decode()
    try:
        note = json.loads(raw)
    except ValueError:
        return respond(400, {"error": "body must be JSON"})
    if not isinstance(note.get("noteId"), str) or not isinstance(note.get("text"), str):
        return respond(400, {"error": "noteId and text are required strings"})
    try:
        # Conditional write: a retried POST can't silently overwrite a note.
        TABLE.put_item(
            Item={"noteId": note["noteId"], "text": note["text"]},
            ConditionExpression="attribute_not_exists(noteId)",
        )
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return respond(409, {"error": "note already exists"})
        raise
    return respond(201, {"noteId": note["noteId"]})


def get_note(event):
    note_id = event["pathParameters"]["noteId"]
    item = TABLE.get_item(Key={"noteId": note_id}).get("Item")
    if item is None:
        return respond(404, {"error": "not found"})
    return respond(200, item)


def handler(event, context):
    # HTTP API payload format 2.0: routeKey is "METHOD /path/{param}".
    route = event.get("routeKey")
    print(json.dumps({"route": route, "requestId": context.aws_request_id}))
    if route == "POST /notes":
        return create_note(event)
    if route == "GET /notes/{noteId}":
        return get_note(event)
    return respond(404, {"error": "no such route"})
`;

const NOTES_POLICY = String.raw`{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "NotesTable",
      "Effect": "Allow",
      "Action": ["dynamodb:PutItem"],
      "Resource": "arn:aws:dynamodb:us-east-1:000000000000:table/notes"
    }
  ]
}
`;

const WORKER = String.raw`import json
import os

import boto3
from botocore.exceptions import ClientError

TABLE = boto3.resource("dynamodb").Table(os.environ["TABLE"])
RELEASE = os.environ.get("RELEASE", "v1")


def log(level, msg, **fields):
    # One JSON object per line: CloudWatch Logs Insights can query the fields.
    print(json.dumps({"level": level, "msg": msg, "release": RELEASE, **fields}))


def process(job, version, message_id):
    if "jobId" not in job:
        raise ValueError("job has no jobId")
    try:
        # Idempotent: SQS is at-least-once, so the same job may arrive twice.
        TABLE.put_item(
            Item={"jobId": job["jobId"], "processedBy": version, "messageId": message_id},
            ConditionExpression="attribute_not_exists(jobId)",
        )
    except ClientError as e:
        if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
        log("info", "duplicate, already processed", jobId=job["jobId"])
        return
    log("info", "processed", jobId=job["jobId"], version=version)


def handler(event, context):
    failures = []
    for record in event["Records"]:
        try:
            process(json.loads(record["body"]), context.function_version, record["messageId"])
        except Exception as e:
            log("error", "job failed", messageId=record["messageId"], error=repr(e))
            # Partial batch response: only this message is retried.
            failures.append({"itemIdentifier": record["messageId"]})
    return {"batchItemFailures": failures}
`;

const RESULTS_POLICY = String.raw`{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["dynamodb:PutItem"],
      "Resource": "arn:aws:dynamodb:us-east-1:000000000000:table/results"
    }
  ]
}
`;

// ------------------------------------------------------------ module

export const serverless: Module = {
  id: "serverless",
  number: "07",
  title: "Serverless: Lambda, API Gateway, Step Functions",
  summary:
    "Run code without servers and operate it properly: execution environments, permissions on both sides of an invocation, retries per invocation model, concurrency, aliases for canaries, HTTP APIs and Step Functions workflows.",
  services: ["Lambda", "API Gateway", "Step Functions", "DynamoDB", "SQS", "CloudWatch Logs"],
  lessons: [
    {
      id: "execution-model",
      kind: "reading",
      title: "How Lambda actually runs your code",
      minutes: 14,
      body: String.raw`
"Serverless" means you don't manage the servers, not that there aren't any. Lambda runs your function inside an **execution environment**: a Firecracker micro-VM with your runtime, your code, a slice of CPU proportional to memory, and a writable \`/tmp\`. Understanding that environment's lifecycle explains cold starts, connection reuse, leaked state between requests, and most Lambda performance work.

## The lifecycle of an execution environment

<figure class="diagram">
<svg viewBox="0 0 640 200" role="img" aria-label="Execution environment lifecycle: init phase once, then many invoke phases with freezes between them, then shutdown">
  <rect x="10" y="20" width="620" height="150" rx="10" class="d-box d-outer"/>
  <text x="26" y="42" class="d-label">One execution environment (micro-VM)</text>
  <rect x="26" y="62" width="150" height="70" rx="8" class="d-box d-accent"/>
  <text x="101" y="88" text-anchor="middle" class="d-label">Init</text>
  <text x="101" y="106" text-anchor="middle" class="d-small">download code, start runtime,</text>
  <text x="101" y="120" text-anchor="middle" class="d-small">run module-level code</text>
  <rect x="200" y="62" width="100" height="70" rx="8" class="d-box"/>
  <text x="250" y="92" text-anchor="middle" class="d-label">Invoke</text><text x="250" y="110" text-anchor="middle" class="d-small">handler(event)</text>
  <rect x="312" y="62" width="60" height="70" rx="8" class="d-box d-dim"/><text x="342" y="101" text-anchor="middle" class="d-small">frozen</text>
  <rect x="384" y="62" width="100" height="70" rx="8" class="d-box"/>
  <text x="434" y="92" text-anchor="middle" class="d-label">Invoke</text><text x="434" y="110" text-anchor="middle" class="d-small">reuses globals</text>
  <rect x="496" y="62" width="118" height="70" rx="8" class="d-box d-dim"/>
  <text x="555" y="92" text-anchor="middle" class="d-label">Shutdown</text><text x="555" y="110" text-anchor="middle" class="d-small">idle, or recycled</text>
  <path d="M176 97 H198" class="d-arrow"/><path d="M300 97 H310" class="d-arrow"/><path d="M372 97 H382" class="d-arrow"/><path d="M484 97 H494" class="d-arrow"/>
  <text x="101" y="156" text-anchor="middle" class="d-small">cold start = this phase</text>
  <text x="342" y="156" text-anchor="middle" class="d-small">no CPU between requests</text>
</svg>
<figcaption>Init runs once per environment. Each environment handles one request at a time, and Lambda freezes it between requests and reuses it for later ones.</figcaption>
</figure>

1. **Init.** Lambda creates an environment, downloads your package, starts the runtime, and runs everything at **module level**: imports, SDK client creation, config loading. On-demand functions get up to 10 seconds for init.
2. **Invoke.** Lambda calls your handler with the event and a context object. The function's **timeout** (1 s to 15 min) applies here.
3. **Freeze and reuse.** When the handler returns, the environment is frozen: no CPU, but memory stays. The next request routed to this environment thaws it and calls the handler again. Globals, open connections and files in \`/tmp\` are still there.
4. **Shutdown.** Idle environments are reclaimed after some minutes (unspecified, don't depend on it). Environments are also recycled periodically even under load.

**An environment processes exactly one request at a time.** Ten concurrent requests means ten environments. This is the key difference from a container running a web server, and it drives everything about concurrency later in this module.

## Cold starts

A **cold start** is a request that has to wait for Init. It happens when there's no idle environment: the first request after a deploy, a scale-out to more concurrency, or after idle environments were reclaimed. Typical costs: 100–300 ms for a small Python or Node function, up to seconds for a large Java or .NET package, or a function that loads a big ML model or fetches lots of config during init.

Reducing them, in rough order of impact:

- **Do less in Init.** Lazy-import rarely used heavy modules. Don't fetch config you can read from an environment variable.
- **Make the package smaller.** Fewer dependencies, no test data or docs in the zip. Size affects download time and import time.
- **Pick a fast-starting runtime** for latency-critical paths, or use **SnapStart** (Java, Python and .NET), which snapshots an initialised environment.
- **Provisioned concurrency** keeps N environments initialised, for a price. Next lesson but one.
- **Don't put a VPC in the way unless you need one.** VPC-attached functions used to add seconds. Since 2019 the network interface is created at function creation, not per cold start, but you still need NAT or VPC endpoints for AWS APIs.

Cold starts usually affect a small percentage of requests. Look at **p99 latency** and the \`Init Duration\` field in the \`REPORT\` log line before optimising.

## What goes in Init and what goes in the handler

\`\`\`text
import boto3, os
TABLE = boto3.resource("dynamodb").Table(os.environ["TABLE"])   # Init: once per environment

def handler(event, context):                                    # Invoke: every request
    return TABLE.get_item(Key={"id": event["id"]}).get("Item")
\`\`\`

- **Put in Init:** SDK clients, database connection pools, parsed config, compiled regexes. They're reused by every warm request, which avoids TLS handshakes per request.
- **Never put request data in globals.** A global set by request A is still there for request B, possibly from a different user. That's a real data-leak bug class.
- **Secrets in Init need a refresh strategy.** If you cache a secret for the life of the environment and it rotates, warm environments use the old value until they're recycled. Cache with a TTL.
- **\`/tmp\`** (512 MB by default, configurable up to 10 GB) persists across warm invocations in the same environment. It's a cache, not storage: it isn't shared between environments and disappears at shutdown.

## Memory is the CPU knob

You configure only **memory** (128 MB to 10,240 MB). CPU, network bandwidth and burst throughput scale with it: at **1,769 MB a function gets one full vCPU**, and at the top end, six. A CPU-bound function at 128 MB gets a small fraction of a core. Doubling the memory often *halves* the duration, so the cost (GB-seconds) stays flat and latency improves. Measure it with a power-tuning run rather than defaulting to 128 MB.

**Timeouts:** set the function timeout from the observed p99 plus margin, not the 15-minute maximum. Keep the downstream timeouts *inside* it: an SDK call with a 60 s timeout inside a 10 s function means the function dies first, mid-request, with no clean error. And remember the callers' limits. API Gateway gives up after about 30 s (HTTP API) or 29 s (REST API by default), whatever the function timeout.

## See it in the emulator

\`\`\`bash
cat > demo-trust.json <<'EOF'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}
EOF
aws iam create-role --role-name demo-fn-role --assume-role-policy-document file://demo-trust.json
aws iam attach-role-policy --role-name demo-fn-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
cat > demo_env.py <<'EOF'
import time, uuid
ENV_ID = uuid.uuid4().hex[:8]     # Init: runs once per environment
INIT_AT = time.time()
calls = 0
def handler(event, context):      # Invoke: runs every request
    global calls
    calls += 1
    return {"env": ENV_ID, "calls": calls, "memoryMB": context.memory_limit_in_mb,
            "remainingMs": context.get_remaining_time_in_millis(), "envAgeS": round(time.time() - INIT_AT, 1)}
EOF
zip -q demo-env.zip demo_env.py
aws lambda create-function --function-name demo-env --runtime python3.12 --handler demo_env.handler \
  --role arn:aws:iam::000000000000:role/demo-fn-role --zip-file fileb://demo-env.zip --timeout 5
aws lambda wait function-active-v2 --function-name demo-env
for i in 1 2 3; do aws lambda invoke --function-name demo-env out.json >/dev/null; cat out.json; echo; done
\`\`\`

The same \`env\` ID answers all three calls, and \`calls\` keeps counting: one warm environment, reused. Now change the configuration and invoke again:

\`\`\`bash
aws lambda update-function-configuration --function-name demo-env --memory-size 512 --query LastUpdateStatus
aws lambda wait function-updated-v2 --function-name demo-env
aws lambda invoke --function-name demo-env out.json >/dev/null; cat out.json; echo
aws logs filter-log-events --log-group-name /aws/lambda/demo-env --query 'events[].message' --output text | tr '\t' '\n' | grep REPORT
\`\`\`

A new \`env\` ID and \`calls\` back at 1: any code or configuration change replaces every environment, so **each deploy causes a wave of cold starts**. The \`REPORT\` lines show duration, billed duration and memory used for each invocation.

> **In the emulator:** Python runs on an embedded interpreter, so timings say nothing about real cold-start cost, and function code can't open files, so \`/tmp\` caching can't be demonstrated here. Measure cold starts on AWS with the \`Init Duration\` in \`REPORT\` lines.
`,
    },
    {
      id: "permissions-invocation",
      kind: "reading",
      title: "Permissions and invocation models",
      minutes: 16,
      body: String.raw`
Two separate policies govern a Lambda function, and confusing them is the most common Lambda permissions bug. Then there are three ways to invoke a function, each with completely different retry behaviour. Get both right and most "Lambda is flaky" incidents disappear.

## Two policies, two directions

<figure class="diagram">
<svg viewBox="0 0 640 220" role="img" aria-label="The resource-based policy controls who can invoke the function; the execution role controls what the function can call">
  <rect x="10" y="80" width="140" height="60" rx="8" class="d-box"/>
  <text x="80" y="106" text-anchor="middle" class="d-label">Callers</text><text x="80" y="124" text-anchor="middle" class="d-small">API GW, S3, SNS, you</text>
  <rect x="225" y="40" width="190" height="140" rx="10" class="d-box d-outer"/>
  <text x="320" y="62" text-anchor="middle" class="d-label">Lambda function</text>
  <rect x="240" y="74" width="160" height="40" rx="6" class="d-box d-accent"/>
  <text x="320" y="92" text-anchor="middle" class="d-small">resource-based policy</text><text x="320" y="106" text-anchor="middle" class="d-small">who may invoke me?</text>
  <rect x="240" y="126" width="160" height="40" rx="6" class="d-box d-ok"/>
  <text x="320" y="144" text-anchor="middle" class="d-small">execution role</text><text x="320" y="158" text-anchor="middle" class="d-small">what may I call?</text>
  <rect x="490" y="80" width="140" height="60" rx="8" class="d-box"/>
  <text x="560" y="106" text-anchor="middle" class="d-label">AWS APIs</text><text x="560" y="124" text-anchor="middle" class="d-small">DynamoDB, SQS, Logs</text>
  <path d="M150 105 L238 94" class="d-arrow"/><text x="190" y="88" text-anchor="middle" class="d-small">Invoke</text>
  <path d="M400 146 L488 116" class="d-arrow"/><text x="448" y="122" text-anchor="middle" class="d-small">sts creds</text>
</svg>
<figcaption>Inbound: the function's resource-based policy (<code>lambda add-permission</code>). Outbound: the execution role the function assumes. A service that pulls from a queue for you is the exception, see below.</figcaption>
</figure>

**The execution role** is an IAM role whose trust policy lets \`lambda.amazonaws.com\` assume it. Lambda assumes it and gives the temporary credentials to your code (the SDK finds them in environment variables). Everything the code calls (DynamoDB, S3, Secrets Manager, KMS, and CloudWatch Logs for its own log output) must be allowed by this role. Start from \`AWSLambdaBasicExecutionRole\` (logs only) and add a tightly scoped inline policy per function. **One role per function**, never one shared "lambda-role" with the union of everything.

**The resource-based policy** on the function says who may call \`lambda:InvokeFunction\`. API Gateway, S3 notifications, SNS, EventBridge and other accounts push to Lambda, so they need a statement here, added with \`aws lambda add-permission\`. Always scope it with \`--source-arn\` (and \`--source-account\` for S3, whose bucket ARNs contain no account), or any API Gateway or bucket in any account could invoke your function.

**Event source mappings are the exception.** For SQS, Kinesis, DynamoDB Streams, Kafka and MQ, the *Lambda service* polls the source on your behalf **using the function's execution role**. So the role needs \`sqs:ReceiveMessage\`, \`sqs:DeleteMessage\` and \`sqs:GetQueueAttributes\` (the managed \`AWSLambdaSQSQueueExecutionRole\`), and no \`add-permission\` is involved.

| Symptom | Missing |
|---|---|
| API Gateway returns 500, no function logs at all | resource-based policy for \`apigateway.amazonaws.com\` |
| Function runs, then \`AccessDeniedException\` in its logs | execution role permission |
| Function runs but no log group appears | \`logs:CreateLogStream\` / \`logs:PutLogEvents\` on the role |
| \`CreateEventSourceMapping\` fails: "role does not have permissions to call ReceiveMessage" | SQS permissions on the role |

The emulator enforces all four, and you'll hit at least two in the labs.

## Three invocation models

| | Synchronous | Asynchronous | Event source mapping (poll-based) |
|---|---|---|---|
| Who calls | API Gateway, ALB, SDK \`Invoke\`, Step Functions (\`RequestResponse\`) | S3, SNS, EventBridge, SDK with \`InvocationType=Event\` | Lambda's poller reads SQS, Kinesis, DynamoDB Streams, Kafka |
| Caller waits? | Yes, gets the result or error | No, gets \`202\` once the event is queued internally | Nobody waits; the poller does |
| Who retries on error | **The caller** (nobody, unless it does) | **Lambda**: 2 more attempts by default (0–2), with backoff, for up to 6 h of event age | **The source**: SQS redelivers after the visibility timeout; streams retry the batch until success or expiry |
| Where failures end up | In the caller's error handling | **On-failure destination** (SQS, SNS, Lambda, EventBridge, S3) or legacy DLQ | SQS: the **queue's** redrive policy DLQ. Streams: an on-failure destination for the ESM |
| Throttled? | \`429 TooManyRequestsException\` to the caller | Queued and retried internally for up to 6 h | Poller backs off; messages wait in the source |

Consequences that bite in production:

- **Synchronous errors are your problem.** An API client that doesn't retry with backoff just fails. A client that retries *without* backoff turns a throttle into an outage.
- **Async functions run up to three times** for one event. They must be idempotent.
- **Prefer destinations over the legacy DLQ** for async invocations. A destination receives the original event *plus* the error, the response and the attempt count. A DLQ gets only the event. \`OnSuccess\` destinations let you chain without code.
- **With SQS, a failed batch is retried whole** unless you enable \`ReportBatchItemFailures\` and return \`{"batchItemFailures": [{"itemIdentifier": messageId}]}\`. Without it, one poison message makes nine good ones retry with it and walk towards the DLQ together.
- **Set the queue's visibility timeout to at least 6× the function timeout**, so a throttled or retried batch doesn't reappear while still being handled.
- **For streams, one bad record blocks its shard** (ordering!) until it expires. Set \`MaximumRetryAttempts\`, \`BisectBatchOnFunctionError\` and an on-failure destination on the mapping.

## Asynchronous invoke with a failure destination

\`\`\`bash
aws iam create-role --role-name demo-async-role --assume-role-policy-document file://demo-trust.json
aws iam attach-role-policy --role-name demo-async-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws sqs create-queue --queue-name demo-async-failures
aws iam put-role-policy --role-name demo-async-role --policy-name failure-destination --policy-document \
  '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"sqs:SendMessage","Resource":"arn:aws:sqs:us-east-1:000000000000:demo-async-failures"}]}'
cat > demo_async.py <<'EOF'
def handler(event, context):
    if event.get("amount", 0) < 0:
        raise ValueError("amount must be positive")
    return {"ok": True}
EOF
zip -q demo-async.zip demo_async.py
aws lambda create-function --function-name demo-async --runtime python3.12 --handler demo_async.handler \
  --role arn:aws:iam::000000000000:role/demo-async-role --zip-file fileb://demo-async.zip
aws lambda wait function-active-v2 --function-name demo-async
aws lambda put-function-event-invoke-config --function-name demo-async --maximum-retry-attempts 0 \
  --destination-config '{"OnFailure":{"Destination":"arn:aws:sqs:us-east-1:000000000000:demo-async-failures"}}'
aws lambda invoke --function-name demo-async --invocation-type Event \
  --cli-binary-format raw-in-base64-out --payload '{"amount":-5}' out.json
aws sqs receive-message --queue-url "$(aws sqs get-queue-url --queue-name demo-async-failures --query QueueUrl --output text)" \
  --wait-time-seconds 10 --query 'Messages[0].Body' --output text | jq '{condition: .requestContext.condition, request: .requestPayload, error: .responsePayload.errorMessage}'
\`\`\`

The invoke returns \`202\` immediately. The failure record in the queue carries the original payload, the error message and the reason (\`RetriesExhausted\`). That's what an on-call engineer needs. The function's role needs \`sqs:SendMessage\` on the destination, because Lambda delivers it with the execution role.

## Which retries stack?

Retries multiply across layers. An SDK in the function retries DynamoDB 3 times, async invoke retries the function 3 times, and an SNS-triggered chain does it again: one bad event can cause 9+ attempts at the database. Decide **one layer that owns retries** for each failure type, keep the others shallow, and make every layer idempotent.
`,
    },
    {
      id: "concurrency-deploy",
      kind: "reading",
      title: "Concurrency, packaging, config and safe deploys",
      minutes: 15,
      body: String.raw`
## Concurrency is environments in use

Because one environment handles one request at a time, **concurrency = request rate × average duration**. 200 requests/s at 250 ms needs about 50 concurrent environments. The same traffic at 2 s needs 400. Slow downstreams consume concurrency, which is why a degraded database can throttle *unrelated* functions in the same account.

- **Account limit:** 1,000 concurrent executions per region by default, shared by **every function in the account and region**. It's a soft limit you can raise. Check yours with \`aws lambda get-account-settings\`.
- **Scaling rate:** each function can add 1,000 concurrent environments every 10 seconds. A sudden spike above that is throttled while it scales.
- **Reserved concurrency** does two things: it *guarantees* that many environments for this function (subtracted from the shared pool), and it *caps* the function at that number. The cap is often the reason to use it: it protects a fragile downstream (a database with 100 connections) or stops a runaway function from starving everything else. Reserved concurrency of **0** is the kill switch: every invoke is throttled.
- **Provisioned concurrency** keeps N environments *initialised* on a specific version or alias, so those requests never see a cold start. You pay for it per hour whether or not it's used. Use it for latency-sensitive synchronous paths with predictable traffic, and schedule it with Application Auto Scaling.

\`\`\`bash
aws lambda get-account-settings --query AccountLimit
aws lambda put-function-concurrency --function-name demo-env --reserved-concurrent-executions 0
aws lambda invoke --function-name demo-env out.json
aws lambda delete-function-concurrency --function-name demo-env
\`\`\`

The invoke fails with \`TooManyRequestsException\` (HTTP 429) after the CLI's own retries. This is exactly what a synchronous caller sees when a function, or the whole account, runs out of concurrency. Alarm on the \`Throttles\` metric and on \`ConcurrentExecutions\` approaching the account limit.

## Packaging

| | Zip archive | Zip + layers | Container image |
|---|---|---|---|
| Max size | 50 MB zipped (direct upload), 250 MB unzipped | Function + up to 5 layers ≤ 250 MB unzipped | 10 GB |
| Built with | \`zip\`, SAM, CDK, Terraform \`archive_file\` | Same, plus \`publish-layer-version\` | \`docker build\`, pushed to ECR |
| Good for | Most functions | Sharing a dependency or runtime extension across functions | Big dependencies (ML, browsers), existing container tooling |
| Watch out for | Native modules must be built for Amazon Linux and the right architecture | Version skew: the function pins a layer *version*, and layers aren't a package manager | Image must implement the Lambda Runtime API (use AWS base images) |

Pick the architecture deliberately: **arm64 (Graviton)** is about 20% cheaper per GB-second and often faster, but native dependencies must be built for it.

> **In the emulator:** \`publish-layer-version\` works, but layer contents aren't mounted into the function at run time, so a function that imports from a layer fails with \`ImportModuleError\`. Bundle dependencies in the zip for local tests.

## Configuration and secrets

**Environment variables** are right for non-secret config (table names, feature flags, log level). They're encrypted at rest, but anyone with \`lambda:GetFunctionConfiguration\` can read them in plain text, and they end up in IaC state files and deploy logs. So **don't put secrets in environment variables**. Store them in **Secrets Manager** (rotation, cross-account sharing) or **SSM Parameter Store SecureString** (cheaper, no built-in rotation), grant the execution role \`secretsmanager:GetSecretValue\` on that one secret, fetch it during Init, and cache it with a TTL. The AWS Parameters and Secrets Lambda Extension does the caching for you.

## Versions and aliases

- **\`$LATEST\`** is the mutable working copy. Every \`update-function-code\` changes it.
- **\`publish-version\`** snapshots code *and* configuration into an immutable, numbered version (\`:1\`, \`:2\`, …). It returns the existing version if nothing changed since the last publish.
- An **alias** (\`live\`, \`prod\`) is a named pointer to a version, with its own ARN. Point every trigger (API Gateway integration, event source mapping, provisioned concurrency) at the **alias**, never at \`$LATEST\`, so a deploy is a pointer move and a rollback is a pointer move back.
- A **weighted alias** splits traffic between two versions: \`live\` → version 7, plus 10% to version 8. That's a **canary**. Watch errors and latency on the new version (CloudWatch dimensions \`Resource=fn:live\` and \`ExecutedVersion\`), then shift to 100%, or back to 0%.

\`\`\`text
aws lambda publish-version --function-name api                       # -> 8
aws lambda update-alias --function-name api --name live --function-version 7 \
  --routing-config '{"AdditionalVersionWeights":{"8":0.1}}'            # 10% canary
aws lambda update-alias --function-name api --name live --function-version 8 \
  --routing-config '{}'                                                # promote
\`\`\`

In production, let **CodeDeploy** (via SAM's \`DeploymentPreference\` or CDK) drive the weights (\`Canary10Percent5Minutes\`, \`Linear10PercentEvery1Minute\`) with CloudWatch alarms that **roll back automatically**. Hand-shifting weights is fine for learning and emergencies.

Canary caveats: a weighted alias routes **per invocation**, so one user can hit both versions within a session. Both versions must be compatible with the same data and event schemas (expand, then contract). And for SQS event source mappings, the weighting applies per batch.

## A deploy checklist

1. Build once and promote the same artifact through environments (hash it, store it in S3 or ECR).
2. Publish a version, and shift an alias with automatic rollback on alarms.
3. Triggers and provisioned concurrency point at the alias.
4. Timeouts, memory, reserved concurrency, DLQ or destinations, and log retention (\`/aws/lambda/<fn>\` defaults to **never expire**) are all set in IaC.
5. One least-privilege role per function.
`,
    },
    {
      id: "api-gateway",
      kind: "reading",
      title: "API Gateway in front of Lambda",
      minutes: 12,
      body: String.raw`
API Gateway turns HTTP requests into Lambda invocations (and other integrations) and handles the parts every API needs: TLS, routing, authorisation, throttling, CORS and access logs. It comes in two main flavours. The naming is unfortunate, because both are REST-style HTTP APIs.

## HTTP API vs REST API

| | HTTP API (\`apigatewayv2\`) | REST API (\`apigateway\`) |
|---|---|---|
| Price | ~70% cheaper per request | More expensive |
| Latency | Lower | Higher |
| Auth | JWT authorizers (Cognito, any OIDC IdP), Lambda authorizers, IAM | Cognito, Lambda authorizers, IAM, **API keys and usage plans** |
| Features | Auto-deploy stages, simple CORS, private integrations via VPC link | Request validation, request/response mapping (VTL), caching, **AWS WAF**, edge-optimised and **private** endpoints, per-client throttling with usage plans |
| Default timeout | 30 s | 29 s (raisable for Regional and private APIs) |

Default to an **HTTP API**. Choose a REST API when you need WAF on the API itself, API keys with usage plans (selling API access), response caching, request validation, or a private API reachable only from a VPC.

## Lambda proxy integration

With a **proxy integration** (\`AWS_PROXY\`), API Gateway passes the whole request to the function as an event and expects a response object back. HTTP APIs use **payload format 2.0**:

\`\`\`json
{
  "version": "2.0",
  "routeKey": "GET /notes/{noteId}",
  "rawPath": "/notes/n-1",
  "headers": { "host": "abc123.execute-api.us-east-1.amazonaws.com", "user-agent": "curl/8" },
  "queryStringParameters": { "verbose": "1" },
  "pathParameters": { "noteId": "n-1" },
  "requestContext": { "http": { "method": "GET", "sourceIp": "203.0.113.9" }, "requestId": "..." },
  "body": null,
  "isBase64Encoded": false
}
\`\`\`

The function returns \`{"statusCode": 200, "headers": {...}, "body": "<string>"}\`. The \`body\` must be a **string**: \`json.dumps\` it. If the function throws, times out, or returns something malformed, the client gets a bare **500** \`{"message":"Internal Server Error"}\`, which tells you nothing. That's why you need structured logs with the request ID, and API access logs. Return 4xx yourself for client errors.

Keep the handler thin: parse and validate the request, call your domain code, map the result to a response. Then the same domain code can be tested without API Gateway.

## Routes, stages and deployments

- **Routes** are \`METHOD /path\` keys (\`GET /notes/{noteId}\`, \`ANY /{proxy+}\`, or \`$default\` as a catch-all), each with a target integration.
- A **stage** is a deployed snapshot of the API at a URL (\`https://{api-id}.execute-api.{region}.amazonaws.com/{stage}\`). The special \`$default\` stage is served at the root. With **auto-deploy**, every change goes live immediately, which is convenient for dev. For prod, deploy explicitly from your pipeline.
- **Stage variables** and per-stage settings (throttling, logging) let one API serve several environments. Most teams prefer one API per environment, created by IaC, which is easier to reason about.
- **Custom domains** map \`api.example.com\` (with an ACM certificate) to stages, with base path mappings for versioning (\`/v1\`, \`/v2\`).

## Authorisation

- **JWT authorizer** (HTTP API): API Gateway validates the token's signature, issuer, audience and expiry against your IdP's JWKS before invoking anything. Fast, and no code to run. Scopes can be required per route.
- **Lambda authorizer**: your function inspects the request (a token, a header, the source IP) and returns allow/deny plus context. Cache its results (by token, for a TTL) or you pay an extra invocation per request.
- **IAM authorization** (SigV4): for service-to-service calls from other AWS workloads.
- And always: authorise **inside** the function too, for resource-level checks ("may this user read note n-1?"). The authorizer only establishes who the caller is.

## Throttling and limits

Default account-level throttling is **10,000 requests/s with a burst of 5,000** per region, shared across APIs. Set **stage and route throttles** below what your backend (and Lambda concurrency) can actually take, so excess load gets a cheap \`429\` at the edge instead of a pile-up of timed-out invocations. Payloads are capped at 10 MB. For large uploads, return a presigned S3 URL instead.

## Try it: a quick-create HTTP API

A *quick create* makes the API, a \`$default\` route, the integration and an auto-deploying stage in one call:

\`\`\`bash
cat > index.mjs <<'EOF'
export const handler = async (event) => ({
  statusCode: 200,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ route: event.routeKey, path: event.rawPath, method: event.requestContext.http.method }),
});
EOF
zip -q demo-hello.zip index.mjs
aws lambda create-function --function-name demo-hello --runtime nodejs22.x --handler index.handler \
  --role arn:aws:iam::000000000000:role/demo-fn-role --zip-file fileb://demo-hello.zip
aws lambda wait function-active-v2 --function-name demo-hello
DEMO_API=$(aws apigatewayv2 create-api --name demo-hello --protocol-type HTTP \
  --target arn:aws:lambda:us-east-1:000000000000:function:demo-hello --query ApiId --output text)
curl -sS --cacert "$AWS_CA_BUNDLE" -H "Host: $DEMO_API.execute-api.us-east-1.amazonaws.com" "$AWS_ENDPOINT_URL/anything"; echo
\`\`\`

That first call returns **500**: API Gateway isn't allowed to invoke the function. Grant it, scoped to this API, and call again:

\`\`\`bash
aws lambda add-permission --function-name demo-hello --statement-id apigw-demo-hello \
  --action lambda:InvokeFunction --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:us-east-1:000000000000:$DEMO_API/*"
curl -sS --cacert "$AWS_CA_BUNDLE" -H "Host: $DEMO_API.execute-api.us-east-1.amazonaws.com" "$AWS_ENDPOINT_URL/anything"; echo
\`\`\`

The course terminal also has a shortcut, \`apicall <api-id> /path\`. On real AWS you'd simply \`curl https://$DEMO_API.execute-api.us-east-1.amazonaws.com/anything\`.
`,
    },
    {
      id: "step-functions",
      kind: "reading",
      title: "Step Functions: orchestrating workflows",
      minutes: 13,
      body: String.raw`
Once a business process spans several steps (charge the card, reserve stock, send the email, compensate if any of it fails), you face a choice: chain functions with events, or put the flow in an explicit **state machine**. Step Functions is AWS's managed workflow engine. You describe the workflow in JSON (Amazon States Language), and it runs each step, tracks state, retries, branches and records every transition.

## Orchestration vs choreography

<figure class="diagram">
<svg viewBox="0 0 640 230" role="img" aria-label="Orchestration: a state machine calls each service in turn. Choreography: services react to events on a bus">
  <text x="160" y="22" text-anchor="middle" class="d-label">Orchestration</text>
  <rect x="95" y="34" width="130" height="44" rx="8" class="d-box d-accent"/><text x="160" y="61" text-anchor="middle" class="d-label">State machine</text>
  <rect x="15" y="150" width="90" height="44" rx="8" class="d-box"/><text x="60" y="177" text-anchor="middle" class="d-small">payments</text>
  <rect x="115" y="150" width="90" height="44" rx="8" class="d-box"/><text x="160" y="177" text-anchor="middle" class="d-small">inventory</text>
  <rect x="215" y="150" width="90" height="44" rx="8" class="d-box"/><text x="260" y="177" text-anchor="middle" class="d-small">email</text>
  <path d="M130 78 L68 148" class="d-arrow"/><path d="M160 78 V148" class="d-arrow"/><path d="M190 78 L252 148" class="d-arrow"/>
  <text x="160" y="214" text-anchor="middle" class="d-small">one place owns the flow, retries, compensation</text>
  <text x="480" y="22" text-anchor="middle" class="d-label">Choreography</text>
  <rect x="415" y="92" width="130" height="44" rx="8" class="d-box d-accent"/><text x="480" y="119" text-anchor="middle" class="d-label">Event bus</text>
  <rect x="335" y="34" width="90" height="40" rx="8" class="d-box"/><text x="380" y="59" text-anchor="middle" class="d-small">orders</text>
  <rect x="335" y="154" width="90" height="40" rx="8" class="d-box"/><text x="380" y="179" text-anchor="middle" class="d-small">payments</text>
  <rect x="535" y="34" width="90" height="40" rx="8" class="d-box"/><text x="580" y="59" text-anchor="middle" class="d-small">inventory</text>
  <rect x="535" y="154" width="90" height="40" rx="8" class="d-box"/><text x="580" y="179" text-anchor="middle" class="d-small">email</text>
  <path d="M400 74 L440 90" class="d-arrow d-dashed"/><path d="M440 138 L400 152" class="d-arrow d-dashed"/>
  <path d="M520 90 L560 76" class="d-arrow d-dashed"/><path d="M520 138 L560 152" class="d-arrow d-dashed"/>
  <text x="480" y="214" text-anchor="middle" class="d-small">services react to events; no central owner</text>
</svg>
<figcaption>Use orchestration inside a bounded context where steps must happen in order with compensation, and choreography between teams and domains where loose coupling matters more than central visibility.</figcaption>
</figure>

- **Orchestration** (Step Functions) makes the flow explicit and visible: you can see every execution, which step failed, with what input. Retries, timeouts and compensation ("refund the card if inventory fails") are declared once. The cost is a central component that knows about every participant.
- **Choreography** (EventBridge, SNS) keeps services independent: each one reacts to events and emits its own. Adding a consumer doesn't touch anyone else. The cost is that the end-to-end flow exists only implicitly, so "where is order 42 stuck?" needs distributed tracing, and compensation logic is scattered.

Most real systems use both: choreography between domains, orchestration within one.

## Standard vs Express

| | Standard | Express |
|---|---|---|
| Max duration | 1 year | 5 minutes |
| Semantics | Exactly-once per step | At-least-once (async) or at-most-once (sync) |
| Pricing | Per state transition (~$25 per million) | Per request plus duration and memory, much cheaper at high volume |
| History | Full execution history in the console and API for 90 days | CloudWatch Logs only (if enabled) |
| Use for | Business processes, human approval (\`.waitForTaskToken\`), long waits | High-volume event processing, API backends, streaming transforms |

A Standard workflow that waits a week for an approval costs nothing while it waits. An Express workflow processing 100,000 events a second would be ruinous as Standard.

## The states you'll use

- **Task**: do work. Invoke Lambda, or call almost any AWS API directly through **SDK integrations** (\`arn:aws:states:::dynamodb:putItem\`, \`arn:aws:states:::sqs:sendMessage\`) with no Lambda in between. Service patterns: request-response (default), \`.sync\` (wait for a job such as ECS RunTask or Glue to finish), and \`.waitForTaskToken\` (pause until something calls \`SendTaskSuccess\` with the token).
- **Choice**: branch on the input (\`NumericGreaterThan\`, \`StringEquals\`, \`IsPresent\`, \`And\`/\`Or\`). Always give a \`Default\`.
- **Parallel**: run fixed branches concurrently and collect all their outputs.
- **Map**: run the same steps for each item in an array. Inline Map for small arrays, **Distributed Map** for millions of items from S3, with a concurrency limit you set.
- **Wait**, **Pass**, **Succeed**, **Fail**.

**Retry** and **Catch** go on Task (and Parallel and Map) states. \`Retry\` lists error names with \`IntervalSeconds\`, \`MaxAttempts\`, \`BackoffRate\` and \`JitterStrategy\`. \`Catch\` routes an error that retries didn't fix to a fallback state, with the error placed in the state's data via \`ResultPath\`. Error names are \`States.Timeout\`, \`States.TaskFailed\`, \`States.ALL\`, Lambda's own (\`Lambda.ServiceException\`, \`Lambda.TooManyRequestsException\`), or the **exception type your function raised**.

Senior habits: retry transient errors (throttles, timeouts, service exceptions) with backoff and jitter, **never** retry validation errors, set \`TimeoutSeconds\` on every Task (the default is to wait as long as the workflow can run), and catch everything at the end into a compensation path or a clear \`Fail\` state with a useful \`Error\` and \`Cause\`.

## Try it: Choice, Retry and Catch

The function below simulates a flaky payment provider: for orders marked \`flaky\`, the first two attempts raise \`ConnectionError\`. Its attempt counter is a global, so it survives between warm invocations, as you saw in the first reading.

\`\`\`bash
cat > demo-sfn-trust.json <<'EOF'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":["lambda.amazonaws.com","states.amazonaws.com"]},"Action":"sts:AssumeRole"}]}
EOF
aws iam create-role --role-name demo-sfn-role --assume-role-policy-document file://demo-sfn-trust.json
aws iam put-role-policy --role-name demo-sfn-role --policy-name invoke --policy-document \
  '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"lambda:InvokeFunction","Resource":"arn:aws:lambda:us-east-1:000000000000:function:demo-charge*"}]}'
cat > demo_charge.py <<'EOF'
attempts = {}
def handler(event, context):
    oid = event["orderId"]
    attempts[oid] = attempts.get(oid, 0) + 1
    if event.get("flaky") and attempts[oid] < 3:
        raise ConnectionError("payment provider timed out")
    if event["amount"] <= 0:
        raise ValueError("amount must be positive")
    return {"orderId": oid, "charged": event["amount"], "attempts": attempts[oid]}
EOF
zip -q demo-charge.zip demo_charge.py
aws lambda create-function --function-name demo-charge --runtime python3.12 --handler demo_charge.handler \
  --role arn:aws:iam::000000000000:role/demo-sfn-role --zip-file fileb://demo-charge.zip
aws lambda wait function-active-v2 --function-name demo-charge
cat > demo-checkout.asl.json <<'EOF'
{
  "Comment": "Large orders go to review; others are charged with retries",
  "StartAt": "NeedsReview",
  "States": {
    "NeedsReview": {
      "Type": "Choice",
      "Choices": [{ "Variable": "$.amount", "NumericGreaterThan": 1000, "Next": "ManualReview" }],
      "Default": "Charge"
    },
    "ManualReview": { "Type": "Pass", "Result": "queued-for-review", "ResultPath": "$.status", "End": true },
    "Charge": {
      "Type": "Task",
      "Resource": "arn:aws:states:::lambda:invoke",
      "Parameters": { "FunctionName": "arn:aws:lambda:us-east-1:000000000000:function:demo-charge", "Payload.$": "$" },
      "OutputPath": "$.Payload",
      "TimeoutSeconds": 10,
      "Retry": [{ "ErrorEquals": ["ConnectionError"], "IntervalSeconds": 1, "MaxAttempts": 3, "BackoffRate": 2 }],
      "Catch": [{ "ErrorEquals": ["States.ALL"], "ResultPath": "$.error", "Next": "ChargeFailed" }],
      "End": true
    },
    "ChargeFailed": { "Type": "Fail", "Error": "ChargeFailed", "Cause": "Charge failed after retries" }
  }
}
EOF
DEMO_SM=$(aws stepfunctions create-state-machine --name demo-checkout --role-arn arn:aws:iam::000000000000:role/demo-sfn-role \
  --definition file://demo-checkout.asl.json --query stateMachineArn --output text)
run() {
  LAST_EXEC=$(aws stepfunctions start-execution --state-machine-arn "$DEMO_SM" --input "$1" --query executionArn --output text)
  for i in $(seq 30); do
    [ "$(aws stepfunctions describe-execution --execution-arn "$LAST_EXEC" --query status --output text)" != RUNNING ] && break
    sleep 1
  done
  aws stepfunctions describe-execution --execution-arn "$LAST_EXEC" --query '{status: status, output: output, error: error}'
}
run '{"orderId":"o-1","amount":40}'
run '{"orderId":"o-2","amount":5000}'
run '{"orderId":"o-4","amount":-1}'
run '{"orderId":"o-3","amount":40,"flaky":true}'
\`\`\`

o-1 is charged on the first attempt, and o-2 takes the \`Choice\` branch to review. o-4 raises \`ValueError\`, which isn't in the \`Retry\` list, so \`Catch\` sends it straight to \`ChargeFailed\`. o-3 succeeds on its third attempt thanks to \`Retry\`. Its execution is the last one started, so look at its history:

\`\`\`bash
aws stepfunctions get-execution-history --execution-arn "$LAST_EXEC" --query 'events[].type'
\`\`\`

You'll see \`TaskFailed\` twice before \`TaskSucceeded\`: the retries are recorded in the workflow's history, not hidden in your code.

> **On real AWS:** the role passed to \`create-state-machine\` must trust \`states.amazonaws.com\` and allow \`lambda:InvokeFunction\` on the function (including \`:*\` for versions and aliases if you invoke them).
`,
    },
    {
      id: "lab-notes-api",
      kind: "lab",
      title: "Lab: an API → Lambda → DynamoDB service",
      minutes: 35,
      body: String.raw`
You'll ship a small notes service: an HTTP API in front of a Python Lambda that stores notes in DynamoDB. You'll wire both sides of the function's permissions yourself and debug a real least-privilege gap.

The lab folder contains:

- \`handler.py\`: the finished function. \`POST /notes\` creates a note with a conditional write. \`GET /notes/{noteId}\` reads one or returns 404.
- \`trust.json\`: a trust policy that lets Lambda assume a role.
- \`notes-policy.json\`: the function's table permissions, as a teammate wrote them. Use it as given at first.

Call the API through the emulator with the Host header (or the terminal's \`apicall\` shortcut):

\`\`\`text
curl -sS --cacert "$AWS_CA_BUNDLE" -H "Host: $API_ID.execute-api.us-east-1.amazonaws.com" "$AWS_ENDPOINT_URL/notes/n-1"
curl -sS --cacert "$AWS_CA_BUNDLE" -H "Host: $API_ID.execute-api.us-east-1.amazonaws.com" \
  -H 'content-type: application/json' -X POST -d '{"noteId":"n-1","text":"hello"}' "$AWS_ENDPOINT_URL/notes"
\`\`\`
`,
      lab: {
        files: {
          "handler.py": NOTES_HANDLER,
          "trust.json": TRUST,
          "notes-policy.json": NOTES_POLICY,
        },
        tasks: [
          {
            id: "table-role",
            title: "Table and execution role",
            description:
              "Create a DynamoDB table `notes` (string partition key `noteId`, on-demand). Create the role `notes-api-role` that Lambda can assume (use `trust.json`), attach `AWSLambdaBasicExecutionRole` so the function can write logs, and add `notes-policy.json` as an inline policy named `notes-table`.",
            hints: [
              "`aws dynamodb create-table --table-name notes --attribute-definitions AttributeName=noteId,AttributeType=S --key-schema AttributeName=noteId,KeyType=HASH --billing-mode PAY_PER_REQUEST`",
              "`aws iam create-role --role-name notes-api-role --assume-role-policy-document file://trust.json`, then `aws iam attach-role-policy --role-name notes-api-role --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole`.",
              "`aws iam put-role-policy --role-name notes-api-role --policy-name notes-table --policy-document file://notes-policy.json`",
            ],
            check: async (ctx) => {
              const t = await ctx.tryAws(["dynamodb", "describe-table", "--table-name", "notes"]);
              if (!t.ok) return "Table `notes` doesn't exist yet.";
              const key = t.data.Table.KeySchema?.find((k: any) => k.KeyType === "HASH")?.AttributeName;
              if (key !== "noteId") return `The table's partition key is \`${key}\`; expected \`noteId\`.`;
              const r = await ctx.tryAws(["iam", "get-role", "--role-name", "notes-api-role"]);
              if (!r.ok) return "Role `notes-api-role` doesn't exist yet.";
              const trust = r.data.Role.AssumeRolePolicyDocument;
              const doc = typeof trust === "string" ? parse(decodeURIComponent(trust)) : trust;
              if (!JSON.stringify(doc ?? {}).includes("lambda.amazonaws.com")) return "The role's trust policy doesn't allow `lambda.amazonaws.com`.";
              const { inline, attached } = await rolePolicies(ctx, "notes-api-role");
              if (!attached.some((a) => a.endsWith("/AWSLambdaBasicExecutionRole")))
                return "Attach `AWSLambdaBasicExecutionRole`, or the function can't write to CloudWatch Logs.";
              const { actions } = tableActions(inline, "notes");
              if (!actions.has("dynamodb:PutItem")) return "No inline policy allows `dynamodb:PutItem` on the `notes` table yet (`notes-table` from `notes-policy.json`).";
              return true;
            },
          },
          {
            id: "function",
            title: "Deploy the function",
            description:
              "Deploy `handler.py` as a Lambda function named `notes-api`: runtime `python3.12`, handler `handler.handler`, role `notes-api-role`, timeout **10 seconds**, and environment variable `TABLE=notes`. Wait until it's Active.",
            hints: [
              "`zip -q fn.zip handler.py`",
              "`aws lambda create-function --function-name notes-api --runtime python3.12 --handler handler.handler --role arn:aws:iam::000000000000:role/notes-api-role --zip-file fileb://fn.zip --timeout 10 --environment 'Variables={TABLE=notes}'`",
              "`aws lambda wait function-active-v2 --function-name notes-api`",
            ],
            check: async (ctx) => {
              const f = await ctx.tryAws(["lambda", "get-function-configuration", "--function-name", "notes-api"]);
              if (!f.ok) return "Function `notes-api` doesn't exist yet.";
              const c = f.data;
              if (c.Runtime !== "python3.12") return `Runtime is ${c.Runtime}; expected python3.12.`;
              if (c.Handler !== "handler.handler") return `Handler is ${c.Handler}; expected handler.handler.`;
              if (!String(c.Role).endsWith(":role/notes-api-role")) return `The function's role is ${c.Role}; expected notes-api-role.`;
              if (c.Timeout !== 10) return `Timeout is ${c.Timeout}s; expected 10.`;
              if (c.Environment?.Variables?.TABLE !== "notes") return "Environment variable `TABLE` should be `notes`.";
              if (c.State !== "Active") return `The function is ${c.State}. Wait for it with \`aws lambda wait function-active-v2\`.`;
              return true;
            },
          },
          {
            id: "http-api",
            title: "Expose it with an HTTP API",
            description:
              "Create an HTTP API named `notes-http` with a Lambda proxy integration (payload format 2.0) to `notes-api`, routes `POST /notes` and `GET /notes/{noteId}`, and an auto-deploying `$default` stage. Allow API Gateway to invoke the function, **scoped to this API** with a source ARN.",
            hints: [
              "Create the API without `--target` (quick create would add a catch-all route): `aws apigatewayv2 create-api --name notes-http --protocol-type HTTP --query ApiId --output text`.",
              "`aws apigatewayv2 create-integration --api-id $API_ID --integration-type AWS_PROXY --integration-uri arn:aws:lambda:us-east-1:000000000000:function:notes-api --payload-format-version 2.0`, then `create-route --api-id $API_ID --route-key 'POST /notes' --target integrations/$INTEGRATION_ID` (and the GET route), then `create-stage --api-id $API_ID --stage-name '$default' --auto-deploy`.",
              "`aws lambda add-permission --function-name notes-api --statement-id apigw --action lambda:InvokeFunction --principal apigateway.amazonaws.com --source-arn \"arn:aws:execute-api:us-east-1:000000000000:$API_ID/*\"`",
            ],
            check: async (ctx) => {
              const id = await apiId(ctx, "notes-http");
              if (!id) return "No HTTP API named `notes-http` yet.";
              const routes = (await ctx.aws(["apigatewayv2", "get-routes", "--api-id", id])).Items ?? [];
              const ints = (await ctx.aws(["apigatewayv2", "get-integrations", "--api-id", id])).Items ?? [];
              for (const key of ["POST /notes", "GET /notes/{noteId}"]) {
                const r = routes.find((x: any) => x.RouteKey === key);
                if (!r) return `Route \`${key}\` doesn't exist yet. Routes: ${JSON.stringify(routes.map((x: any) => x.RouteKey))}.`;
                const intId = String(r.Target ?? "").replace("integrations/", "");
                const i = ints.find((x: any) => x.IntegrationId === intId);
                if (!i) return `Route \`${key}\` has no integration target.`;
                if (i.IntegrationType !== "AWS_PROXY" || !String(i.IntegrationUri).includes(":function:notes-api"))
                  return `Route \`${key}\` should target an AWS_PROXY integration for notes-api.`;
                if (i.PayloadFormatVersion !== "2.0") return `The integration uses payload format ${i.PayloadFormatVersion}; expected 2.0.`;
              }
              const stages = (await ctx.aws(["apigatewayv2", "get-stages", "--api-id", id])).Items ?? [];
              const st = stages.find((s: any) => s.StageName === "$default");
              if (!st) return "There's no `$default` stage yet.";
              if (!st.AutoDeploy) return "The `$default` stage should have auto-deploy on.";
              const p = await ctx.tryAws(["lambda", "get-policy", "--function-name", "notes-api"]);
              const pol = p.ok ? parse(p.data.Policy) : null;
              const stmt = asList(pol?.Statement).find((s: any) => s.Principal?.Service === "apigateway.amazonaws.com");
              if (!stmt) return "The function's resource-based policy doesn't allow `apigateway.amazonaws.com` yet (`lambda add-permission`).";
              if (!JSON.stringify(stmt.Condition ?? {}).includes(`:${id}/`))
                return "The API Gateway permission isn't scoped to this API. Add `--source-arn arn:aws:execute-api:us-east-1:000000000000:<api-id>/*`.";
              return true;
            },
          },
          {
            id: "write",
            title: "Create a note through the API",
            description:
              "Through the API, `POST /notes` with body `{\"noteId\":\"n-1\",\"text\":\"hello\"}`. It should return 201, and the item should be in the `notes` table.",
            hints: [
              "`curl -sS --cacert \"$AWS_CA_BUNDLE\" -H \"Host: $API_ID.execute-api.us-east-1.amazonaws.com\" -H 'content-type: application/json' -X POST -d '{\"noteId\":\"n-1\",\"text\":\"hello\"}' \"$AWS_ENDPOINT_URL/notes\"`",
              "A 500 means the function failed or API Gateway can't invoke it. Read the function's logs: `aws logs filter-log-events --log-group-name /aws/lambda/notes-api --query 'events[].message'`.",
            ],
            check: async (ctx) => {
              const r = await ctx.tryAws(["dynamodb", "get-item", "--table-name", "notes", "--key", '{"noteId":{"S":"n-1"}}']);
              if (!r.ok) return "Couldn't read the `notes` table. Does it exist?";
              const item = r.data?.Item;
              if (!item) return "There's no item `n-1` in `notes` yet. POST it through the API.";
              if (item.text?.S !== "hello") return `Item n-1 has text ${JSON.stringify(item.text)}; expected "hello".`;
              return true;
            },
          },
          {
            id: "read",
            title: "Read it back (and fix what breaks)",
            description:
              "`GET /notes/n-1` must return **200** with the note, and `GET /notes/missing` must return **404**. With the teammate's policy it returns 500: find out why from the function's logs and fix it with **least privilege** (no `dynamodb:*`, no `Resource: \"*\"`, no `AmazonDynamoDBFullAccess`).",
            hints: [
              "`aws logs filter-log-events --log-group-name /aws/lambda/notes-api --query 'events[].message' --output text | grep -i denied`",
              "The role can `PutItem` but not `GetItem`. Add `dynamodb:GetItem` to `notes-policy.json`, keeping the table ARN as the resource.",
              "`aws iam put-role-policy --role-name notes-api-role --policy-name notes-table --policy-document file://notes-policy.json` replaces the inline policy. The next request picks up the new permissions.",
            ],
            check: async (ctx) => {
              const id = await apiId(ctx, "notes-http");
              if (!id) return "No HTTP API named `notes-http` yet.";
              const got = await callApi(ctx, id, "GET", "/notes/n-1");
              if (got.status === 500)
                return "GET /notes/n-1 returns 500. Check the function's logs in `/aws/lambda/notes-api` for the error.";
              if (got.status !== 200) return `GET /notes/n-1 returned ${got.status}; expected 200. Body: ${got.body.slice(0, 200)}`;
              if (parse(got.body)?.text !== "hello") return `GET /notes/n-1 returned ${got.body.slice(0, 200)}; expected the note with text "hello".`;
              const miss = await callApi(ctx, id, "GET", "/notes/missing");
              if (miss.status !== 404) return `GET /notes/missing returned ${miss.status}; expected 404.`;
              const { inline, attached } = await rolePolicies(ctx, "notes-api-role");
              if (attached.some((a) => a.endsWith("/AmazonDynamoDBFullAccess")))
                return "It works, but `AmazonDynamoDBFullAccess` is far broader than this function needs. Detach it and grant only the actions it uses.";
              const { wildcard } = tableActions(inline, "notes");
              if (wildcard) return `It works, but ${wildcard}. Scope it to the actions and the table the function uses.`;
              return true;
            },
          },
        ],
        solution: String.raw`
aws dynamodb create-table --table-name notes --attribute-definitions AttributeName=noteId,AttributeType=S \
  --key-schema AttributeName=noteId,KeyType=HASH --billing-mode PAY_PER_REQUEST
aws iam create-role --role-name notes-api-role --assume-role-policy-document file://trust.json
aws iam attach-role-policy --role-name notes-api-role --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam put-role-policy --role-name notes-api-role --policy-name notes-table --policy-document file://notes-policy.json
aws dynamodb wait table-exists --table-name notes

zip -q fn.zip handler.py
aws lambda create-function --function-name notes-api --runtime python3.12 --handler handler.handler \
  --role arn:aws:iam::000000000000:role/notes-api-role --zip-file fileb://fn.zip --timeout 10 \
  --environment 'Variables={TABLE=notes}'
aws lambda wait function-active-v2 --function-name notes-api

API_ID=$(aws apigatewayv2 create-api --name notes-http --protocol-type HTTP --query ApiId --output text)
INT_ID=$(aws apigatewayv2 create-integration --api-id "$API_ID" --integration-type AWS_PROXY \
  --integration-uri arn:aws:lambda:us-east-1:000000000000:function:notes-api --payload-format-version 2.0 \
  --query IntegrationId --output text)
aws apigatewayv2 create-route --api-id "$API_ID" --route-key 'POST /notes' --target "integrations/$INT_ID"
aws apigatewayv2 create-route --api-id "$API_ID" --route-key 'GET /notes/{noteId}' --target "integrations/$INT_ID"
aws apigatewayv2 create-stage --api-id "$API_ID" --stage-name '$default' --auto-deploy
aws lambda add-permission --function-name notes-api --statement-id apigw --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com --source-arn "arn:aws:execute-api:us-east-1:000000000000:$API_ID/*"

call() { curl -sS --cacert "$AWS_CA_BUNDLE" -H "Host: $API_ID.execute-api.us-east-1.amazonaws.com" -w ' %{http_code}\n' "$@"; }
call -H 'content-type: application/json' -X POST -d '{"noteId":"n-1","text":"hello"}' "$AWS_ENDPOINT_URL/notes"
call "$AWS_ENDPOINT_URL/notes/n-1"     # 500: the role can't GetItem
aws logs filter-log-events --log-group-name /aws/lambda/notes-api --query 'events[].message' --output text | tr '\t' '\n' | grep -i 'not authorized' | head -1

jq '.Statement[0].Action = ["dynamodb:PutItem","dynamodb:GetItem"]' notes-policy.json > notes-policy.fixed.json
mv notes-policy.fixed.json notes-policy.json
aws iam put-role-policy --role-name notes-api-role --policy-name notes-table --policy-document file://notes-policy.json
call "$AWS_ENDPOINT_URL/notes/n-1"
call "$AWS_ENDPOINT_URL/notes/missing"
`,
      },
    },
    {
      id: "lab-worker",
      kind: "lab",
      title: "Lab: an SQS worker with versions and a canary",
      minutes: 35,
      body: String.raw`
Now the asynchronous side. You'll run \`worker.py\` as an SQS-triggered Lambda: an event source mapping polls the \`jobs\` queue and invokes the function with batches. The worker is idempotent (a conditional write keyed on \`jobId\`) and reports partial batch failures, so one bad job doesn't retry the whole batch.

You'll deploy it the way production should: triggers point at a **\`live\` alias**, never at \`$LATEST\`, and a new release goes out as a 10% canary.

**Prepare lab** has created:

- the DynamoDB table \`results\` (partition key \`jobId\`),
- the dead-letter queue \`jobs-dlq\`,
- the role \`worker-role\` with logging and \`PutItem\` on \`results\`. Something is missing from it, and you'll find out what when you create the trigger.

Tip: the worker logs one JSON object per line. Once it's running, read its logs with:

\`\`\`text
aws logs filter-log-events --log-group-name /aws/lambda/worker --query 'events[].message' --output text
\`\`\`
`,
      lab: {
        files: {
          "worker.py": WORKER,
          "trust.json": TRUST,
          "results-policy.json": RESULTS_POLICY,
        },
        setup: String.raw`
aws dynamodb describe-table --table-name results >/dev/null 2>&1 || \
  aws dynamodb create-table --table-name results --attribute-definitions AttributeName=jobId,AttributeType=S \
    --key-schema AttributeName=jobId,KeyType=HASH --billing-mode PAY_PER_REQUEST >/dev/null
aws sqs create-queue --queue-name jobs-dlq --attributes MessageRetentionPeriod=1209600 >/dev/null
aws iam get-role --role-name worker-role >/dev/null 2>&1 || \
  aws iam create-role --role-name worker-role --assume-role-policy-document file://trust.json >/dev/null
aws iam attach-role-policy --role-name worker-role --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam put-role-policy --role-name worker-role --policy-name results-table --policy-document file://results-policy.json
aws dynamodb wait table-exists --table-name results
`,
        tasks: [
          {
            id: "queue",
            title: "Create the jobs queue",
            description:
              "Create a standard queue `jobs` whose visibility timeout is **60 seconds** (six times the worker's 10-second timeout) with a redrive policy to `jobs-dlq` after **5** receives.",
            hints: [
              "`jq -n '{VisibilityTimeout:\"60\", RedrivePolicy: ({deadLetterTargetArn:\"arn:aws:sqs:us-east-1:000000000000:jobs-dlq\", maxReceiveCount:5}|tojson)}' > jobs.json`",
              "`aws sqs create-queue --queue-name jobs --attributes file://jobs.json`",
            ],
            check: async (ctx) => {
              const u = await ctx.tryAws(["sqs", "get-queue-url", "--queue-name", "jobs"]);
              if (!u.ok) return "Queue `jobs` doesn't exist yet.";
              const a = (await ctx.aws(["sqs", "get-queue-attributes", "--queue-url", u.data.QueueUrl, "--attribute-names", "All"])).Attributes ?? {};
              if (Number(a.VisibilityTimeout) < 60)
                return `VisibilityTimeout is ${a.VisibilityTimeout}s. For a Lambda consumer with a 10 s timeout it should be at least 60 s.`;
              const rp = parse(a.RedrivePolicy ?? "");
              if (!rp) return "`jobs` has no redrive policy yet.";
              if (rp.deadLetterTargetArn !== "arn:aws:sqs:us-east-1:000000000000:jobs-dlq")
                return `The DLQ is ${rp.deadLetterTargetArn}; expected jobs-dlq.`;
              if (Number(rp.maxReceiveCount) !== 5) return `maxReceiveCount is ${rp.maxReceiveCount}; expected 5.`;
              return true;
            },
          },
          {
            id: "alias",
            title: "Deploy version 1 behind a live alias",
            description:
              "Deploy `worker.py` as function `worker` (runtime `python3.12`, handler `worker.handler`, role `worker-role`, timeout **10 s**, env `TABLE=results`). **Publish version 1** and create an alias `live` pointing at it.",
            hints: [
              "`zip -q worker.zip worker.py && aws lambda create-function --function-name worker --runtime python3.12 --handler worker.handler --role arn:aws:iam::000000000000:role/worker-role --zip-file fileb://worker.zip --timeout 10 --environment 'Variables={TABLE=results}'`",
              "Wait for it (`aws lambda wait function-active-v2`), then `aws lambda publish-version --function-name worker`.",
              "`aws lambda create-alias --function-name worker --name live --function-version 1`",
            ],
            check: async (ctx) => {
              const f = await ctx.tryAws(["lambda", "get-function-configuration", "--function-name", "worker"]);
              if (!f.ok) return "Function `worker` doesn't exist yet.";
              const c = f.data;
              if (c.Runtime !== "python3.12" || c.Handler !== "worker.handler")
                return `Runtime/handler are ${c.Runtime}/${c.Handler}; expected python3.12/worker.handler.`;
              if (c.Timeout !== 10) return `Timeout is ${c.Timeout}s; expected 10.`;
              if (c.Environment?.Variables?.TABLE !== "results") return "Environment variable `TABLE` should be `results`.";
              const al = await ctx.tryAws(["lambda", "get-alias", "--function-name", "worker", "--name", "live"]);
              if (!al.ok) return "Alias `live` doesn't exist yet. Publish a version first, then create the alias.";
              if (al.data.FunctionVersion === "$LATEST") return "`live` points at $LATEST. Aliases should point at an immutable, published version.";
              if (al.data.FunctionVersion !== "1") return `\`live\` points at version ${al.data.FunctionVersion}; expected 1 as its primary version.`;
              return true;
            },
          },
          {
            id: "trigger",
            title: "Trigger the alias from the queue",
            description:
              "Create an event source mapping from `jobs` to **`worker:live`** (not the unqualified function) with batch size **10** and **`ReportBatchItemFailures`** enabled. The first attempt will fail: read the error and give `worker-role` what the poller needs.",
            hints: [
              "`aws lambda create-event-source-mapping --function-name worker:live --event-source-arn arn:aws:sqs:us-east-1:000000000000:jobs --batch-size 10 --function-response-types ReportBatchItemFailures`",
              "The Lambda poller reads the queue with the function's execution role. Attach the managed policy `arn:aws:iam::aws:policy/service-role/AWSLambdaSQSQueueExecutionRole` to `worker-role`.",
            ],
            check: async (ctx) => {
              const m = await ctx.tryAws(["lambda", "list-event-source-mappings", "--event-source-arn", "arn:aws:sqs:us-east-1:000000000000:jobs"]);
              const maps = m.ok ? (m.data.EventSourceMappings ?? []) : [];
              if (!maps.length) return "There's no event source mapping from `jobs` yet.";
              const e = maps.find((x: any) => String(x.FunctionArn).endsWith(":function:worker:live"));
              if (!e)
                return `The mapping targets ${maps.map((x: any) => x.FunctionArn).join(", ")}. Point it at the alias \`worker:live\` so deploys are alias moves.`;
              if (e.BatchSize !== 10) return `BatchSize is ${e.BatchSize}; expected 10.`;
              if (!(e.FunctionResponseTypes ?? []).includes("ReportBatchItemFailures"))
                return "Enable `ReportBatchItemFailures`, so one failed job doesn't make the whole batch retry.";
              if (e.State !== "Enabled") return `The mapping is ${e.State}; wait until it's Enabled.`;
              return true;
            },
          },
          {
            id: "process",
            title: "Process a job",
            description:
              "Send `{\"jobId\":\"j-1\"}` to `jobs`. The worker should write `j-1` to `results` (with `processedBy` set to the **version** that ran it, not `$LATEST`) and log a `processed` line to `/aws/lambda/worker`.",
            hints: [
              "`aws sqs send-message --queue-url \"$(aws sqs get-queue-url --queue-name jobs --query QueueUrl --output text)\" --message-body '{\"jobId\":\"j-1\"}'`",
              "Delivery is asynchronous. Give it a few seconds, then `aws dynamodb get-item --table-name results --key '{\"jobId\":{\"S\":\"j-1\"}}'`.",
            ],
            check: async (ctx) => {
              const r = await ctx.tryAws(["dynamodb", "get-item", "--table-name", "results", "--key", '{"jobId":{"S":"j-1"}}']);
              const item = r.ok ? r.data?.Item : null;
              if (!item) return "There's no `j-1` in `results` yet. Send the message and give the poller a few seconds.";
              const v = item.processedBy?.S;
              if (v === "$LATEST") return "j-1 was processed by $LATEST. The event source mapping should invoke the `live` alias.";
              if (!/^\d+$/.test(v ?? "")) return `processedBy is ${JSON.stringify(v)}; expected a published version number.`;
              const logs = await ctx.tryAws(["logs", "filter-log-events", "--log-group-name", "/aws/lambda/worker"]);
              if (!logs.ok) return "There's no `/aws/lambda/worker` log group. Does the role still have `AWSLambdaBasicExecutionRole`?";
              const lines = (logs.data.events ?? []).map((e: any) => parse(e.message)).filter(Boolean);
              if (!lines.some((l: any) => l.msg === "processed" && l.jobId === "j-1"))
                return "The worker's logs have no `processed` line for j-1 yet.";
              return true;
            },
          },
          {
            id: "canary",
            title: "Release v2 as a 10% canary",
            description:
              "Set the environment variable `RELEASE=v2` on the function (keep `TABLE=results`), **publish version 2**, and change the `live` alias so it keeps version **1** as primary and sends **10%** of invocations to version 2.",
            hints: [
              "`aws lambda update-function-configuration --function-name worker --environment 'Variables={TABLE=results,RELEASE=v2}'`, then `aws lambda wait function-updated-v2 --function-name worker`.",
              "`aws lambda publish-version --function-name worker` should return version 2.",
              "`aws lambda update-alias --function-name worker --name live --function-version 1 --routing-config '{\"AdditionalVersionWeights\":{\"2\":0.1}}'`",
            ],
            check: async (ctx) => {
              const v2 = await ctx.tryAws(["lambda", "get-function-configuration", "--function-name", "worker", "--qualifier", "2"]);
              if (!v2.ok) return "Version 2 of `worker` doesn't exist yet.";
              const env = v2.data.Environment?.Variables ?? {};
              if (env.RELEASE !== "v2") return "Version 2 should have `RELEASE=v2` in its environment. Update the configuration *before* publishing.";
              if (env.TABLE !== "results") return "Version 2 lost `TABLE=results`. `--environment` replaces the whole map.";
              const al = await ctx.tryAws(["lambda", "get-alias", "--function-name", "worker", "--name", "live"]);
              if (!al.ok) return "Alias `live` doesn't exist.";
              if (al.data.FunctionVersion !== "1") return `\`live\`'s primary version is ${al.data.FunctionVersion}; keep 1 as primary during the canary.`;
              const w = al.data.RoutingConfig?.AdditionalVersionWeights ?? {};
              if (Math.abs(Number(w["2"] ?? 0) - 0.1) > 1e-9)
                return `\`live\` routes ${JSON.stringify(w)} to additional versions; expected {"2": 0.1}.`;
              return true;
            },
          },
        ],
        solution: String.raw`
jq -n '{VisibilityTimeout:"60", RedrivePolicy: ({deadLetterTargetArn:"arn:aws:sqs:us-east-1:000000000000:jobs-dlq", maxReceiveCount:5}|tojson)}' > jobs.json
aws sqs create-queue --queue-name jobs --attributes file://jobs.json

zip -q worker.zip worker.py
aws lambda create-function --function-name worker --runtime python3.12 --handler worker.handler \
  --role arn:aws:iam::000000000000:role/worker-role --zip-file fileb://worker.zip --timeout 10 \
  --environment 'Variables={TABLE=results}'
aws lambda wait function-active-v2 --function-name worker
V1=$(aws lambda publish-version --function-name worker --query Version --output text)
aws lambda create-alias --function-name worker --name live --function-version "$V1"

# Without SQS permissions on the role, this fails with InvalidParameterValueException.
aws lambda create-event-source-mapping --function-name worker:live \
  --event-source-arn arn:aws:sqs:us-east-1:000000000000:jobs --batch-size 10 \
  --function-response-types ReportBatchItemFailures 2>&1 | grep -i 'permissions' || true
aws iam attach-role-policy --role-name worker-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaSQSQueueExecutionRole
UUID=$(aws lambda create-event-source-mapping --function-name worker:live \
  --event-source-arn arn:aws:sqs:us-east-1:000000000000:jobs --batch-size 10 \
  --function-response-types ReportBatchItemFailures --query UUID --output text)
for i in $(seq 30); do
  [ "$(aws lambda get-event-source-mapping --uuid "$UUID" --query State --output text)" = Enabled ] && break
  sleep 1
done

aws sqs send-message --queue-url "$(aws sqs get-queue-url --queue-name jobs --query QueueUrl --output text)" --message-body '{"jobId":"j-1"}'
for i in $(seq 30); do
  aws dynamodb get-item --table-name results --key '{"jobId":{"S":"j-1"}}' --query Item.processedBy.S --output text | grep -qx '[0-9][0-9]*' && break
  sleep 1
done
aws logs filter-log-events --log-group-name /aws/lambda/worker --query 'events[].message' --output text

aws lambda update-function-configuration --function-name worker --environment 'Variables={TABLE=results,RELEASE=v2}'
aws lambda wait function-updated-v2 --function-name worker
V2=$(aws lambda publish-version --function-name worker --query Version --output text)
aws lambda update-alias --function-name worker --name live --function-version "$V1" \
  --routing-config "{\"AdditionalVersionWeights\":{\"$V2\":0.1}}"
`,
      },
    },
  ],
  quiz: [
    {
      q: "A Python function creates its boto3 DynamoDB client inside the handler. p50 latency is fine but every request spends ~40 ms on a TLS handshake. What's the fix?",
      options: [
        "Increase the timeout",
        "Create the client at module level (Init), so warm invocations reuse it and its connections",
        "Enable provisioned concurrency",
        "Move the function into a VPC",
      ],
      answer: 1,
      explain:
        "Module-level code runs once per execution environment, and warm invocations reuse its objects, including open connections. Creating clients per request throws that away. Provisioned concurrency only removes *Init* latency; it doesn't help per-request work inside the handler.",
    },
    {
      q: "An HTTP API returns 500 Internal Server Error for every request, and the function's log group shows no invocations at all. What's most likely missing?",
      options: [
        "dynamodb:GetItem on the execution role",
        "A resource-based policy statement letting apigateway.amazonaws.com invoke the function (lambda add-permission)",
        "AWSLambdaBasicExecutionRole",
        "Reserved concurrency",
      ],
      answer: 1,
      explain:
        "No invocations means the call never reached the function: API Gateway wasn't allowed to invoke it. That's the function's **resource-based** policy, not its execution role. A missing execution-role permission would show the function running and logging an AccessDenied error (as in the lab).",
    },
    {
      q: "An S3-triggered (asynchronous) function fails on a malformed file. What happens by default, and what should you add?",
      options: [
        "S3 retries forever; add reserved concurrency",
        "Lambda retries the event twice more, then discards it; add an on-failure destination (or DLQ) so failed events are kept with their error",
        "The event goes back to the bucket; add versioning",
        "Nothing is retried; switch to synchronous invocation",
      ],
      answer: 1,
      explain:
        "Async invocations are queued by Lambda and retried up to 2 more times (configurable 0–2, events up to 6 h old), then dropped unless you configure an on-failure destination or DLQ. A destination record includes the error and attempt count, which is why it's preferred.",
    },
    {
      q: "An SQS-triggered function processes batches of 10. One malformed message makes the handler raise, and the DLQ slowly fills with *valid* messages too. Why, and what fixes it?",
      options: [
        "The visibility timeout is too long",
        "An exception fails the whole batch, so the nine good messages retry with the bad one and hit maxReceiveCount together; enable ReportBatchItemFailures and return only the failed message IDs",
        "SQS standard queues can't be used with Lambda",
        "Batch size must be 1 when using a DLQ",
      ],
      answer: 1,
      explain:
        "Without partial batch responses, any error makes the whole batch visible again. With `ReportBatchItemFailures` and `batchItemFailures`, only the listed messages return to the queue, and the rest are deleted. Batch size 1 also works, but it costs throughput and money.",
    },
    {
      q: "A payment function talks to a database that allows 100 connections. A traffic spike scales the function to 800 concurrent environments and the database falls over. What's the most direct guard?",
      options: [
        "Provisioned concurrency of 100",
        "Reserved concurrency of about 100 on the function, which caps it (and put an SQS queue in front if requests must not be rejected)",
        "Increase memory so each request finishes faster",
        "A longer function timeout",
      ],
      answer: 1,
      explain:
        "Reserved concurrency is also a hard **cap**. Excess synchronous requests get 429s, and queued work simply waits. Provisioned concurrency pre-warms environments but doesn't cap anything. A queue in front turns rejections into backlog. RDS Proxy is the other standard answer for connection pooling.",
    },
    {
      q: "You want to send 10% of production traffic to a new Lambda release and roll back instantly if errors rise. How should triggers be configured?",
      options: [
        "Point triggers at $LATEST and update the code",
        "Point triggers at an alias; publish the new version and give the alias a routing config with 0.1 weight to it (ideally driven by CodeDeploy with alarm-based rollback)",
        "Create a second function and split traffic in the client",
        "Use reserved concurrency of 10%",
      ],
      answer: 1,
      explain:
        "Versions are immutable snapshots and aliases are movable pointers with optional weighted routing. Triggers that target the alias let you canary, promote and roll back without touching API Gateway, event source mappings or permissions. `$LATEST` changes under you with every deploy.",
    },
    {
      q: "A checkout flow must charge a card, reserve stock and email the customer, refunding the card if reservation fails, with visibility into where each order is. It runs millions of times a day but each run takes under 2 seconds. Which fits best?",
      options: [
        "Lambdas calling each other synchronously",
        "A Step Functions Express workflow with Retry/Catch and a compensation step (or Standard if runs can be long or need exactly-once steps)",
        "SNS fan-out to three Lambdas",
        "A cron job that reconciles orders nightly",
      ],
      answer: 1,
      explain:
        "Ordered steps with compensation are orchestration's home ground: Retry and Catch are declared in the state machine, and each execution's path is visible. At millions of short runs a day, Express is far cheaper than Standard's per-transition pricing. Lambda-to-Lambda calls double-bill waiting time and hide the flow. Fan-out can't express \"refund if step 2 fails\".",
    },
  ],
};
