import type { CheckContext, Module } from "../types.ts";

// ------------------------------------------------------------ check helpers

const ARN = (name: string) => `arn:aws:sqs:us-east-1:000000000000:${name}`;

async function queueUrl(ctx: CheckContext, name: string): Promise<string | null> {
  const r = await ctx.tryAws(["sqs", "get-queue-url", "--queue-name", name]);
  return r.ok ? r.data.QueueUrl : null;
}

async function queueAttrs(ctx: CheckContext, name: string): Promise<Record<string, string> | null> {
  const url = await queueUrl(ctx, name);
  if (!url) return null;
  const r = await ctx.tryAws(["sqs", "get-queue-attributes", "--queue-url", url, "--attribute-names", "All"]);
  return r.ok ? (r.data?.Attributes ?? {}) : null;
}

/** Receive without hiding: visibility timeout 0 leaves the messages visible for the learner. */
async function peek(ctx: CheckContext, name: string): Promise<any[]> {
  const url = await queueUrl(ctx, name);
  if (!url) return [];
  const r = await ctx.tryAws([
    "sqs", "receive-message", "--queue-url", url, "--max-number-of-messages", "10",
    "--visibility-timeout", "0", "--wait-time-seconds", "1", "--attribute-names", "All",
    "--message-attribute-names", "All",
  ]);
  return r.ok ? (r.data?.Messages ?? []) : [];
}

const parse = (s: string): any => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

/** Does the queue policy allow `service` to SendMessage, scoped to `sourceArn`? */
function policyAllows(policyJson: string | undefined, service: string, sourceArn: string): string | true {
  if (!policyJson) return "it has no access policy (attribute `Policy`) yet";
  const p = parse(policyJson);
  if (!p) return "its `Policy` attribute isn't valid JSON";
  const stmts = Array.isArray(p.Statement) ? p.Statement : [p.Statement];
  const ok = stmts.find((s: any) => {
    if (s?.Effect !== "Allow") return false;
    const svc = s.Principal?.Service;
    const svcs = Array.isArray(svc) ? svc : [svc];
    if (!svcs.includes(service)) return false;
    const acts = Array.isArray(s.Action) ? s.Action : [s.Action];
    return acts.some((a: string) => a === "sqs:SendMessage" || a === "sqs:*");
  });
  if (!ok) return `no statement allows \`${service}\` to \`sqs:SendMessage\``;
  if (!JSON.stringify(ok.Condition ?? {}).includes(sourceArn))
    return `the statement for \`${service}\` isn't scoped with an \`aws:SourceArn\` condition to \`${sourceArn}\``;
  return true;
}

// ------------------------------------------------------------ module

export const messaging: Module = {
  id: "messaging",
  number: "06",
  title: "Messaging & events: SQS, SNS, EventBridge",
  summary:
    "Decouple services with queues, topics and event buses: size visibility timeouts, build DLQs and redrive, fan out with filter policies, route events by content, and handle poison messages like an operator.",
  services: ["SQS", "SNS", "EventBridge", "EventBridge Scheduler", "EventBridge Pipes"],
  lessons: [
    {
      id: "why-decouple",
      kind: "reading",
      title: "Why decouple, and what it costs",
      minutes: 10,
      body: String.raw`
A synchronous call chain is only as available as its weakest link and only as fast as its slowest one. If the checkout service calls billing, billing calls the ledger, and the ledger takes a 30-second GC pause, every customer at checkout waits 30 seconds. Then the retries pile up. Messaging breaks that chain: the producer hands work to a durable intermediary and moves on, and the consumer does the work when it can.

## What a queue buys you

<figure class="diagram">
<svg viewBox="0 0 640 210" role="img" aria-label="A bursty producer writes to a queue that absorbs the spike while consumers drain it at a steady rate">
  <rect x="10" y="60" width="150" height="90" rx="8" class="d-box"/>
  <text x="85" y="92" text-anchor="middle" class="d-label">Producers</text>
  <text x="85" y="112" text-anchor="middle" class="d-small">burst: 5,000 msg/s</text>
  <text x="85" y="128" text-anchor="middle" class="d-small">for 60 seconds</text>
  <rect x="235" y="40" width="170" height="130" rx="8" class="d-box d-accent"/>
  <text x="320" y="68" text-anchor="middle" class="d-label">SQS queue</text>
  <rect x="255" y="84" width="20" height="60" class="d-box d-dim"/><rect x="280" y="84" width="20" height="60" class="d-box d-dim"/>
  <rect x="305" y="84" width="20" height="60" class="d-box d-dim"/><rect x="330" y="84" width="20" height="60" class="d-box d-dim"/>
  <rect x="355" y="84" width="20" height="60" class="d-box d-dim"/>
  <text x="320" y="162" text-anchor="middle" class="d-small">backlog grows, then drains</text>
  <rect x="480" y="60" width="150" height="90" rx="8" class="d-box"/>
  <text x="555" y="92" text-anchor="middle" class="d-label">Consumers</text>
  <text x="555" y="112" text-anchor="middle" class="d-small">steady: 800 msg/s</text>
  <text x="555" y="128" text-anchor="middle" class="d-small">sized for the average</text>
  <path d="M160 105 H233" class="d-arrow"/><path d="M405 105 H478" class="d-arrow"/>
  <text x="196" y="96" text-anchor="middle" class="d-small">send</text><text x="441" y="96" text-anchor="middle" class="d-small">poll</text>
</svg>
<figcaption>Load levelling: the queue turns a spike into a backlog. Consumers are sized for the average rate, not the peak, and the metric to watch is the age of the oldest message.</figcaption>
</figure>

- **Load levelling.** Producers can burst far beyond what the consumer fleet (or the database behind it) can handle. The queue absorbs the burst, and consumers drain it at the rate they can sustain. You size for throughput over time instead of peak concurrency, which is usually much cheaper.
- **Failure isolation.** If the consumer is down, deploying or throttled, producers keep succeeding. Messages wait (SQS keeps them for up to 14 days). An outage in a downstream dependency becomes *latency*, not *errors*.
- **Temporal decoupling.** Producer and consumer don't need to be up at the same time, written in the same language, or deployed together.
- **Independent scaling.** You scale consumers on queue depth (\`ApproximateNumberOfMessagesVisible\`) or backlog age, independently of the front end.
- **Fan-out.** One event, many independent reactions (billing, email, analytics), each with its own failure domain. This is what SNS and EventBridge add on top of queues.

## What it costs you

Asynchrony is not free. You trade an easy-to-reason-about call stack for distributed-systems problems you now own:

1. **No immediate answer.** The producer can't tell the user "your payment succeeded" when it has only enqueued it. Design the UX and the API for it: return \`202 Accepted\` and a status resource, or notify the user later.
2. **At-least-once delivery.** SQS standard queues, SNS and EventBridge all deliver **at least once**. Duplicates are rare but guaranteed to happen eventually: a consumer crashes after doing the work but before deleting the message, a network timeout hides a successful send so the producer retries, or the service itself redelivers.
3. **Ordering is not guaranteed** unless you pay for it (FIFO), and even then only within a message group.
4. **Failures are invisible by default.** A synchronous error shows up in someone's browser. An async failure sits in a queue until someone looks. You need dead-letter queues, alarms on backlog age and DLQ depth, and a runbook.
5. **Debugging spans hops.** Propagate a correlation ID in message attributes and log it at every hop, or you'll be grepping timestamps during an incident.

## Delivery semantics, honestly

| Guarantee | What it means | Who offers it |
|---|---|---|
| At-most-once | May lose messages, never duplicates | Fire-and-forget UDP, or deleting *before* processing (don't do this) |
| At-least-once | Never loses an acknowledged message, may duplicate | SQS standard, SNS, EventBridge, Lambda async invoke |
| "Exactly-once" | Duplicates suppressed *inside a window* | SQS FIFO deduplicates sends within 5 minutes; this is not end-to-end |

End-to-end exactly-once *processing* does not exist across a network. What you build is **at-least-once delivery plus idempotent processing**, which gives the same observable result.

## Idempotent consumers

An operation is idempotent if doing it twice has the same effect as doing it once. Patterns, in order of preference:

- **Natural idempotency.** "Set order 42's status to SHIPPED" is idempotent. "Add 10 to the balance" is not. Prefer state-setting messages over deltas.
- **Idempotency key + conditional write.** Give every message a business key (\`orderId\`, \`paymentId\`) and record it with a conditional write, for example DynamoDB \`PutItem\` with \`ConditionExpression: attribute_not_exists(pk)\`. A \`ConditionalCheckFailedException\` means "already done": acknowledge and move on.
- **Dedup table with a TTL.** Store processed message keys for longer than the maximum redelivery window, and let DynamoDB TTL expire them.
- **Transactional outbox** on the producer side, so the database write and the "publish event" can't diverge.

Never use the SQS \`MessageId\` as your idempotency key on its own. A producer retry creates a *new* message with a *new* ID carrying the same business event. Use a key from the payload.

> **Senior rule of thumb:** every consumer you write must be safe to run twice on the same message. Write it down in the code review checklist. It's far cheaper than debugging a double charge.

## The three services in one paragraph

**SQS** is a queue: one logical consumer group pulls work and deletes it when done. **SNS** is a push topic: every subscriber gets a copy, immediately, with optional attribute- or body-based filtering. **EventBridge** is an event router: producers emit structured events onto a bus, and rules match on any field of the event and route to over 20 target types, with transformation, archive and replay. Real systems combine them. The canonical pattern is *SNS or EventBridge for fan-out, an SQS queue in front of each consumer for buffering and retries*. The rest of this module is about doing that well.
`,
    },
    {
      id: "sqs",
      kind: "reading",
      title: "SQS in depth: visibility, polling, DLQs, FIFO",
      minutes: 16,
      body: String.raw`
SQS looks trivial (send, receive, delete) but every production incident with it comes down to four settings: the **visibility timeout**, the **receive wait time**, the **redrive policy**, and the choice of **standard or FIFO**.

## The message lifecycle

<figure class="diagram">
<svg viewBox="0 0 640 220" role="img" aria-label="Message lifecycle: visible, received and invisible for the visibility timeout, then either deleted or visible again; after maxReceiveCount receives it moves to the DLQ">
  <rect x="10" y="80" width="110" height="60" rx="8" class="d-box"/>
  <text x="65" y="106" text-anchor="middle" class="d-label">Visible</text><text x="65" y="124" text-anchor="middle" class="d-small">in the queue</text>
  <rect x="200" y="80" width="150" height="60" rx="8" class="d-box d-accent"/>
  <text x="275" y="106" text-anchor="middle" class="d-label">In flight</text><text x="275" y="124" text-anchor="middle" class="d-small">hidden for VisibilityTimeout</text>
  <rect x="440" y="20" width="190" height="56" rx="8" class="d-box d-ok"/>
  <text x="535" y="44" text-anchor="middle" class="d-label">Deleted</text><text x="535" y="62" text-anchor="middle" class="d-small">consumer called DeleteMessage</text>
  <rect x="440" y="144" width="190" height="56" rx="8" class="d-box d-danger"/>
  <text x="535" y="168" text-anchor="middle" class="d-label">Dead-letter queue</text><text x="535" y="186" text-anchor="middle" class="d-small">receive count &gt; maxReceiveCount</text>
  <path d="M120 100 H198" class="d-arrow"/><text x="159" y="92" text-anchor="middle" class="d-small">Receive</text>
  <path d="M350 95 L438 55" class="d-arrow"/><text x="384" y="62" text-anchor="middle" class="d-small">success</text>
  <path d="M275 140 C275 190 65 190 65 142" class="d-arrow d-dashed"/><text x="170" y="196" text-anchor="middle" class="d-small">timeout expires, no delete: visible again</text>
  <path d="M350 125 L438 165" class="d-arrow"/><text x="400" y="132" text-anchor="middle" class="d-small">too many tries</text>
</svg>
<figcaption>SQS never "pushes" or "acks". A receive hides the message. Only DeleteMessage removes it. Everything else is a retry.</figcaption>
</figure>

\`ReceiveMessage\` doesn't remove a message. It hides it for the **visibility timeout** (default 30 s, max 12 h) and gives you a *receipt handle*. If you call \`DeleteMessage\` with that handle before the timeout expires, the message is gone. If you don't (crash, exception, timeout, or forgetting), it becomes visible again and another consumer gets it. Each receive increments \`ApproximateReceiveCount\`.

## Sizing the visibility timeout

The visibility timeout must be **longer than the worst-case processing time**, including retries inside your code. Too short, and a slow-but-healthy consumer has its message re-delivered to a second consumer while it's still working: duplicate work, and possibly a message wrongly counted towards the DLQ. Too long, and a crashed consumer's message sits hidden for that long before anyone retries it.

- For long or variable jobs, **extend it while working**: call \`ChangeMessageVisibility\` periodically (a heartbeat) instead of setting a huge static value.
- For Lambda consumers, AWS recommends a queue visibility timeout of **at least six times the function timeout**. The event source mapping retries throttled invocations within that window. AWS (and the emulator) rejects creating the mapping if the visibility timeout is shorter than the function timeout.
- Visibility is per receive. You can pass \`--visibility-timeout\` on a single \`ReceiveMessage\` call to override the queue default.

## Long polling

With **short polling** (\`WaitTimeSeconds=0\`, the default), a receive queries a subset of SQS's servers and returns immediately, often empty. A fleet of idle consumers polling in a loop burns API requests (you pay per request) and can miss messages that sit on servers it didn't sample. **Long polling** (\`WaitTimeSeconds\` 1–20) waits until a message arrives or the time runs out, and queries all servers. Set \`ReceiveMessageWaitTimeSeconds=20\` on every queue unless you have a reason not to. It's cheaper and more responsive.

\`\`\`bash
aws sqs create-queue --queue-name demo-work --attributes ReceiveMessageWaitTimeSeconds=20,VisibilityTimeout=60
DEMO_Q=$(aws sqs get-queue-url --queue-name demo-work --query QueueUrl --output text)
aws sqs send-message --queue-url "$DEMO_Q" --message-body '{"jobId":"j-1"}' \
  --message-attributes 'correlationId={DataType=String,StringValue=req-abc}'
aws sqs receive-message --queue-url "$DEMO_Q" --attribute-names All --message-attribute-names All
\`\`\`

Run the receive twice: the second call waits, because the first one made the message invisible for 60 seconds.

## Dead-letter queues and maxReceiveCount

A **redrive policy** on the source queue names a dead-letter queue and a \`maxReceiveCount\`. When a message has been received more than that many times without being deleted, SQS moves it to the DLQ instead of delivering it again. This is your circuit breaker for **poison messages**, messages that will never succeed (malformed payload, a bug, a reference to a deleted record), which would otherwise be retried forever and hog consumer capacity.

\`\`\`bash
aws sqs create-queue --queue-name demo-work-dlq --attributes MessageRetentionPeriod=1209600
DLQ_ARN=$(aws sqs get-queue-attributes --queue-url "$(aws sqs get-queue-url --queue-name demo-work-dlq --query QueueUrl --output text)" \
  --attribute-names QueueArn --query Attributes.QueueArn --output text)
aws sqs set-queue-attributes --queue-url "$DEMO_Q" --attributes \
  "{\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}"
aws sqs get-queue-attributes --queue-url "$DEMO_Q" --attribute-names RedrivePolicy
\`\`\`

The quoting is ugly because \`RedrivePolicy\` is a JSON document stored *as a string* inside the attributes map. In real projects you set it in Terraform or CloudFormation, or build it with \`jq\`.

Rules that matter:

- **A DLQ must be the same type as its source**: FIFO for FIFO, standard for standard, in the same account and region.
- **Set the DLQ's retention to the maximum (14 days)**. The original enqueue timestamp is kept when a message moves, so a message that spent 3 days failing has 3 fewer days left in the DLQ. A DLQ with the default 4-day retention silently deletes evidence over a long weekend.
- **maxReceiveCount between 3 and 10** for most workloads. 1 sends a message to the DLQ on the first transient blip. A very high value lets poison messages consume capacity for hours.
- **Restrict who can use a queue as a DLQ** with a \`RedriveAllowPolicy\` (\`byQueue\` plus a list of source ARNs) on the DLQ.
- **Alarm on DLQ depth** (\`ApproximateNumberOfMessagesVisible > 0\`). A DLQ without an alarm is a place where data goes to die quietly.

## Redrive

Once you've fixed the bug, move messages from the DLQ back to the source with a **message move task**:

\`\`\`text
aws sqs start-message-move-task --source-arn <dlq-arn>                       # back to the original source queue
aws sqs start-message-move-task --source-arn <dlq-arn> --destination-arn <q> # or anywhere else
aws sqs list-message-move-tasks --source-arn <dlq-arn>
\`\`\`

You can cap the rate with \`--max-number-of-messages-per-second\`, which you should do when the backlog is large and the consumer talks to a database that you don't want to stampede.

## Delay queues and message timers

\`DelaySeconds\` (0–900) on the queue, or per message on standard queues, keeps new messages invisible for that long. Use it for "retry in 5 minutes" or "give the read replica time to catch up". It's not a scheduler: anything longer than 15 minutes belongs in EventBridge Scheduler or a Step Functions \`Wait\` state.

## Standard vs FIFO

| | Standard | FIFO (\`.fifo\` suffix) |
|---|---|---|
| Throughput | Nearly unlimited | 300 API calls/s per action, 3,000 msg/s with batching, much more with high-throughput mode |
| Ordering | Best effort | Strict **within a message group** |
| Duplicates | Possible | Deduplicated within a 5-minute window |
| Required on send | Nothing | \`MessageGroupId\`, plus a \`MessageDeduplicationId\` unless content-based dedup is on |

**Message groups** are the important idea. Ordering applies per \`MessageGroupId\`, and while one message from a group is in flight, no other message from *that group* is delivered. So the group is your unit of both ordering and parallelism. Use the entity ID (\`customerId\`, \`accountId\`), never a constant: a single group ID serialises the entire queue onto one consumer. And a poison message at the head of a group **blocks the whole group** until it's deleted or dead-lettered.

\`\`\`bash
aws sqs create-queue --queue-name demo-ledger.fifo --attributes FifoQueue=true,ContentBasedDeduplication=true
DEMO_F=$(aws sqs get-queue-url --queue-name demo-ledger.fifo --query QueueUrl --output text)
aws sqs send-message --queue-url "$DEMO_F" --message-group-id acct-1 --message-body '{"op":"debit","amount":5}'
aws sqs send-message --queue-url "$DEMO_F" --message-group-id acct-1 --message-body '{"op":"debit","amount":5}'
aws sqs get-queue-attributes --queue-url "$DEMO_F" --attribute-names ApproximateNumberOfMessages
\`\`\`

The second send returns the *same* \`MessageId\` and \`SequenceNumber\`, and the queue holds one message. Content-based dedup hashed the body. That's a feature until two genuinely different debits of the same amount arrive within 5 minutes. For anything financial, set an explicit \`MessageDeduplicationId\` derived from the business key.

## Other limits that bite

- **256 KB max message size** (including attributes). Large payloads go in S3, with a pointer in the message (the "claim check" pattern).
- **Batch everything**: \`SendMessageBatch\`, \`DeleteMessageBatch\` and \`--max-number-of-messages 10\` cut request costs up to tenfold. Check the per-entry results: a batch call can partially fail and still return HTTP 200.
- **In-flight limit**: about 120,000 in-flight messages per standard queue (20,000 for FIFO). Consumers that receive and never delete hit it during incidents.
- **Encryption**: SSE-SQS is on by default. Use SSE-KMS with a customer-managed key when you need key policies and CloudTrail on decrypts. Then producers, and SNS or EventBridge if they deliver, need \`kms:GenerateDataKey\` on the key.
`,
    },
    {
      id: "sns",
      kind: "reading",
      title: "SNS: pub/sub, fan-out and filter policies",
      minutes: 12,
      body: String.raw`
SNS is a **push-based topic**. A publisher sends one message to a topic, and SNS delivers a copy to every subscription: SQS queues, Lambda functions, HTTP(S) endpoints, email, SMS, mobile push, Kinesis Data Firehose. It doesn't store messages for later. If nobody is subscribed, the message is gone.

## The fan-out pattern

<figure class="diagram">
<svg viewBox="0 0 640 250" role="img" aria-label="SNS fan-out: a publisher sends to an SNS topic which delivers to three SQS queues, one with a filter policy, each read by its own consumer">
  <rect x="10" y="95" width="110" height="60" rx="8" class="d-box"/>
  <text x="65" y="121" text-anchor="middle" class="d-label">Order service</text><text x="65" y="139" text-anchor="middle" class="d-small">sns:Publish</text>
  <rect x="170" y="95" width="120" height="60" rx="8" class="d-box d-accent"/>
  <text x="230" y="121" text-anchor="middle" class="d-label">SNS topic</text><text x="230" y="139" text-anchor="middle" class="d-small">order-events</text>
  <rect x="360" y="20" width="130" height="52" rx="8" class="d-box"/><text x="425" y="42" text-anchor="middle" class="d-label">billing queue</text><text x="425" y="59" text-anchor="middle" class="d-small">all messages</text>
  <rect x="360" y="99" width="130" height="52" rx="8" class="d-box"/><text x="425" y="121" text-anchor="middle" class="d-label">priority queue</text><text x="425" y="138" text-anchor="middle" class="d-small">filter: priority=high</text>
  <rect x="360" y="178" width="130" height="52" rx="8" class="d-box"/><text x="425" y="200" text-anchor="middle" class="d-label">analytics queue</text><text x="425" y="217" text-anchor="middle" class="d-small">raw delivery</text>
  <rect x="530" y="20" width="100" height="52" rx="8" class="d-box d-dim"/><text x="580" y="50" text-anchor="middle" class="d-small">billing workers</text>
  <rect x="530" y="99" width="100" height="52" rx="8" class="d-box d-dim"/><text x="580" y="129" text-anchor="middle" class="d-small">pager / fast lane</text>
  <rect x="530" y="178" width="100" height="52" rx="8" class="d-box d-dim"/><text x="580" y="208" text-anchor="middle" class="d-small">batch loader</text>
  <path d="M120 125 H168" class="d-arrow"/>
  <path d="M290 115 L358 50" class="d-arrow"/><path d="M290 125 H358" class="d-arrow"/><path d="M290 135 L358 200" class="d-arrow"/>
  <path d="M490 46 H528" class="d-arrow d-dashed"/><path d="M490 125 H528" class="d-arrow d-dashed"/><path d="M490 204 H528" class="d-arrow d-dashed"/>
  <text x="322" y="82" text-anchor="middle" class="d-small">push</text><text x="510" y="92" text-anchor="middle" class="d-small">poll</text>
</svg>
<figcaption>SNS pushes a copy to every matching subscription. Each queue buffers for its own consumer, so a slow analytics loader never delays billing.</figcaption>
</figure>

Why not have the order service write to three queues itself? Because then the producer knows about every consumer, needs permissions on every queue, and has to handle partial failure ("two of three sends succeeded"). With a topic, adding a consumer is a subscription, not a code change in the producer.

Why put queues between SNS and the consumers, rather than subscribing Lambda or HTTP endpoints directly? Because SNS delivery is fire-and-retry: if the endpoint is down beyond the retry policy, the message is lost (or lands in a subscription DLQ, if you configured one). A queue gives each consumer **durability, back-pressure, its own retry and its own DLQ**.

## The queue policy: the step everyone forgets

SNS delivers to SQS by calling \`sqs:SendMessage\` *as the SNS service*. The queue must allow it with a resource-based policy. Without it, the subscription looks healthy (\`PendingConfirmation=false\`), \`Publish\` returns a \`MessageId\`, and nothing ever arrives. The emulator enforces this exactly like AWS.

\`\`\`json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AllowOrderEventsTopic",
    "Effect": "Allow",
    "Principal": { "Service": "sns.amazonaws.com" },
    "Action": "sqs:SendMessage",
    "Resource": "arn:aws:sqs:us-east-1:000000000000:billing",
    "Condition": { "ArnEquals": { "aws:SourceArn": "arn:aws:sns:us-east-1:000000000000:order-events" } }
  }]
}
\`\`\`

The \`aws:SourceArn\` condition is not optional in production. Without it, **any SNS topic in any account** can write into your queue. That's the "confused deputy" problem: the SNS service has the permission, and anyone can ask it to use it on their behalf. If the queue is encrypted with a customer-managed KMS key, the key policy must also let \`sns.amazonaws.com\` call \`kms:GenerateDataKey\` and \`kms:Decrypt\`, or deliveries fail silently. (The default AWS-managed \`aws/sqs\` key can't grant that, so you can't use it with SNS.)

## Envelope vs raw message delivery

By default, SQS receives a **JSON envelope**: \`Type\`, \`MessageId\`, \`TopicArn\`, \`Message\` (your payload, as a string), \`Timestamp\`, signature fields, and \`MessageAttributes\`. Consumers must parse twice: the SQS body, then the \`Message\` string inside it.

With **\`RawMessageDelivery=true\`** on the subscription, the SQS body is exactly what was published, and SNS message attributes become SQS message attributes. Use raw delivery when the consumer doesn't need the envelope metadata and you want the consumer to be agnostic about whether messages arrived via SNS or directly. Be consistent: half your queues raw and half enveloped is a classic source of "works in staging" bugs.

## Filter policies

A **filter policy** on a subscription drops non-matching messages before they're delivered. You don't pay for or process what you don't want. Policies match **message attributes** by default, or the **message body** if you set \`FilterPolicyScope=MessageBody\` (the body must be JSON).

\`\`\`json
{
  "priority": ["high"],
  "region":   [{ "prefix": "eu-" }],
  "amount":   [{ "numeric": [">=", 1000] }],
  "channel":  [{ "anything-but": ["test"] }],
  "coupon":   [{ "exists": false }]
}
\`\`\`

Keys are ANDed, values in a list are ORed. A message with **no** \`priority\` attribute doesn't match \`"priority": ["high"]\`, which surprises people the first time. Numeric matching on attributes requires \`DataType=Number\`. Filter policy changes take up to 15 minutes to propagate on AWS, so don't test a change with a single publish immediately afterwards.

Try it end to end:

\`\`\`bash
DEMO_T=$(aws sns create-topic --name demo-alerts --query TopicArn --output text)
aws sqs create-queue --queue-name demo-pager
PAGER_URL=$(aws sqs get-queue-url --queue-name demo-pager --query QueueUrl --output text)
PAGER_ARN=$(aws sqs get-queue-attributes --queue-url "$PAGER_URL" --attribute-names QueueArn --query Attributes.QueueArn --output text)
jq -n --arg q "$PAGER_ARN" --arg t "$DEMO_T" '{Policy: ({Version:"2012-10-17",Statement:[{Effect:"Allow",
  Principal:{Service:"sns.amazonaws.com"},Action:"sqs:SendMessage",Resource:$q,
  Condition:{ArnEquals:{"aws:SourceArn":$t}}}]} | tojson)}' > demo-pager-policy.json
aws sqs set-queue-attributes --queue-url "$PAGER_URL" --attributes file://demo-pager-policy.json
aws sns subscribe --topic-arn "$DEMO_T" --protocol sqs --notification-endpoint "$PAGER_ARN" \
  --attributes '{"RawMessageDelivery":"true","FilterPolicy":"{\"severity\":[\"critical\"]}"}'
aws sns publish --topic-arn "$DEMO_T" --message 'disk 91%' --message-attributes 'severity={DataType=String,StringValue=warning}'
aws sns publish --topic-arn "$DEMO_T" --message 'db down' --message-attributes 'severity={DataType=String,StringValue=critical}'
aws sqs receive-message --queue-url "$PAGER_URL" --wait-time-seconds 5 --max-number-of-messages 10 --query 'Messages[].Body'
\`\`\`

Only \`db down\` arrives, as a raw body. Note the \`jq ... | tojson\` trick: it builds the policy and encodes it as the string that the \`Policy\` attribute requires. That beats hand-escaping quotes.

## Delivery, retries and FIFO topics

- **To SQS and Lambda**, SNS retries for a long time (tens of thousands of attempts over days) because those endpoints are AWS-managed. For HTTP(S), the default retry policy is much shorter. Configure a **subscription-level DLQ** (\`RedrivePolicy\` on the subscription) so undeliverable messages are kept instead of dropped.
- **SNS FIFO topics** (\`.fifo\`) preserve order per message group and deduplicate, but can only deliver to SQS queues (FIFO or standard). Use them when the fan-out targets also need ordering, for example per-account ledger events.
- **Message size** is 256 KB, as for SQS. Use the claim-check pattern for anything bigger.
- **Cross-account**: the topic policy controls who can publish and subscribe. The queue policy controls who can deliver. Both must agree.

> **On real AWS:** SQS subscriptions in the same account are confirmed automatically. Cross-account and HTTP subscriptions must be confirmed by the endpoint. The emulator auto-confirms SQS subscriptions too.
`,
    },
    {
      id: "eventbridge",
      kind: "reading",
      title: "EventBridge: buses, patterns, Scheduler and Pipes",
      minutes: 14,
      body: String.raw`
SNS filters on attributes you chose to attach. **EventBridge** routes on *the content of the event itself*. Producers put structured events onto an **event bus**. **Rules** on that bus match events with **event patterns** and send them to up to five **targets** each: SQS, SNS, Lambda, Step Functions, Kinesis, another bus (including cross-account), API destinations (any HTTPS API), ECS tasks and more.

## The event envelope

Every event has the same top-level shape. Your payload goes in \`detail\`:

\`\`\`json
{
  "version": "0",
  "id": "6a7e8feb-b491-4cf7-a9f1-bf3703467718",
  "detail-type": "OrderPlaced",
  "source": "app.orders",
  "account": "000000000000",
  "time": "2026-01-01T12:00:00Z",
  "region": "us-east-1",
  "resources": [],
  "detail": { "orderId": "o-42", "total": 129.5, "customer": { "tier": "gold" } }
}
\`\`\`

**Buses:** the \`default\` bus receives AWS service events (EC2 state changes, S3 notifications if enabled, CodePipeline status and so on). Create **custom buses** for your application events (\`app\`), so permissions, archives and rules for your domain are separate from AWS noise. **Partner buses** receive SaaS events (Datadog, Zendesk, Auth0).

## Event patterns

A pattern is a JSON document that has the same shape as the events it matches. Every field you list must match, and values in a list are ORed:

\`\`\`json
{
  "source": ["app.orders"],
  "detail-type": ["OrderPlaced"],
  "detail": {
    "total": [{ "numeric": [">", 100] }],
    "customer": { "tier": ["gold", "platinum"] },
    "coupon": [{ "exists": false }],
    "channel": [{ "anything-but": { "prefix": "test-" } }]
  }
}
\`\`\`

There are also \`prefix\`, \`suffix\`, \`equals-ignore-case\`, \`wildcard\`, \`cidr\` and \`$or\` operators. Test patterns offline before deploying a rule. There's an API for exactly that:

\`\`\`bash
aws events test-event-pattern \
  --event-pattern '{"source":["app.orders"],"detail":{"total":[{"numeric":[">",100]}]}}' \
  --event '{"id":"1","account":"000000000000","source":"app.orders","time":"2026-01-01T00:00:00Z","region":"us-east-1","resources":[],"detail-type":"OrderPlaced","detail":{"total":129.5}}'
\`\`\`

Always include \`source\` in a pattern. A rule that matches only on \`detail\` fields will one day match an event from a producer you've never heard of.

## Targets, permissions and input transformers

The rule needs permission to reach its target, and how depends on the target:

- **SQS, SNS, Lambda**: a **resource-based policy** on the target that allows \`events.amazonaws.com\`, scoped with \`aws:SourceArn\` to the rule's ARN (\`arn:aws:events:region:acct:rule/<bus>/<rule>\` for custom buses). The same confused-deputy reasoning as SNS applies.
- **Step Functions, Kinesis, ECS, API destinations, cross-account buses**: an **IAM role** that EventBridge assumes, passed as the target's \`RoleArn\`.

By default the target receives the whole event. An **input transformer** extracts fields with JSONPath and renders a template, so the consumer gets exactly the contract it expects and isn't coupled to the envelope:

\`\`\`json
{
  "InputPathsMap": { "id": "$.detail.orderId", "at": "$.time" },
  "InputTemplate": "{\"orderId\": <id>, \"placedAt\": <at>}"
}
\`\`\`

String values are inserted with their quotes, so \`<id>\` becomes \`"o-42"\`. Don't wrap placeholders in quotes yourself when the template is JSON.

Delivery is at-least-once with retries for up to 24 hours (configurable with a \`RetryPolicy\`). Attach a **DLQ to each target** (\`DeadLetterConfig\`). Without one, events that exhaust retries are dropped, and the only trace is the \`FailedInvocations\` metric.

## Archive and replay

An **archive** records events from a bus (optionally filtered by a pattern) for a retention period. A **replay** re-sends archived events from a time window back onto the bus, where rules see them again (replayed events carry a \`replay-name\` field, so rules can opt in or out). This is how you backfill a new consumer, or reprocess a day of events after fixing a bug. It only works safely if consumers are idempotent.

\`\`\`text
aws events create-archive --archive-name app-archive \
  --event-source-arn arn:aws:events:us-east-1:000000000000:event-bus/app --retention-days 30
aws events start-replay --replay-name fix-1234 \
  --event-source-arn arn:aws:events:us-east-1:000000000000:archive/app-archive \
  --event-start-time 2026-01-01T00:00:00Z --event-end-time 2026-01-02T00:00:00Z \
  --destination Arn=arn:aws:events:us-east-1:000000000000:event-bus/app
\`\`\`

> **In the emulator:** archives record events and \`start-replay\` is accepted, but the replay stays in \`STARTING\`. Use the API shape here and test real replays in an AWS sandbox account.

## EventBridge Scheduler

Scheduled rules (\`rate(5 minutes)\`, \`cron(...)\`) on the default bus still work, but **EventBridge Scheduler** is the modern replacement. It's a separate service with millions of schedules per account, one-off schedules (\`at(2026-12-31T23:00:00)\`), time zones and daylight-saving handling, flexible time windows to spread load, built-in retries and DLQs, and **universal targets** (any AWS API action, not just event targets). Use it for "send a reminder 24 hours after sign-up", one schedule per user, which rules were never designed for.

\`\`\`text
aws scheduler create-schedule --name trial-ends-u123 \
  --schedule-expression 'at(2026-12-31T09:00:00)' --schedule-expression-timezone Europe/London \
  --flexible-time-window Mode=OFF --action-after-completion DELETE \
  --target '{"Arn":"arn:aws:sqs:...:reminders","RoleArn":"arn:aws:iam::...:role/scheduler-sqs","Input":"{\"userId\":\"u123\"}"}'
\`\`\`

## EventBridge Pipes

A **pipe** connects one *source* (SQS, Kinesis, DynamoDB Streams, MSK, MQ) to one *target*, with optional **filtering**, **enrichment** (a Lambda, Step Functions Express workflow, or API call) and input transformation in between. It replaces the glue Lambda that reads a queue, drops half the messages and forwards the rest. Pipes poll the source for you, so the filter runs before you pay for anything downstream. Filtered-out SQS messages are deleted from the source, not left behind.

## Choosing between them

| Need | Reach for |
|---|---|
| Buffer work for one consumer group, absorb bursts, retry with a DLQ | **SQS** |
| Strict ordering per entity, deduplication | **SQS FIFO** (with SNS FIFO for ordered fan-out) |
| Fan-out of the same message to many subscribers, high throughput, low latency | **SNS** (to SQS queues) |
| Route by event content, many producers and consumers, cross-account event mesh, SaaS events | **EventBridge** bus and rules |
| Replay history to a new or fixed consumer | **EventBridge archive** (or Kinesis/MSK if you need a real log) |
| Point-to-point source → filter → enrich → target, no code | **EventBridge Pipes** |
| Run something at a time, or on a schedule, at scale | **EventBridge Scheduler** |
| Ordered, replayable stream with many independent readers at high volume | **Kinesis Data Streams / MSK**, not this module's services |

Rough latency and throughput: SNS delivers in tens of milliseconds at very high throughput. EventBridge typically adds about half a second and has a default \`PutEvents\` quota in the thousands per second per region (raisable). Neither is a stream: once delivered, a message is gone (barring archives).
`,
    },
    {
      id: "poison-playbook",
      kind: "reading",
      title: "Operating it: the poison-message playbook",
      minutes: 10,
      body: String.raw`
Messaging systems fail quietly. The page you get is rarely "SQS is down". It's "orders are taking 40 minutes" or "the DLQ alarm fired at 3 a.m." This is the runbook a senior engineer keeps.

## Watch the right metrics

| Metric | What it tells you | Alarm when |
|---|---|---|
| \`ApproximateAgeOfOldestMessage\` | How far behind consumers are, in seconds. The single best SLO signal. | Above your latency budget for 5+ minutes |
| \`ApproximateNumberOfMessagesVisible\` | Backlog size. Scale consumers on it. | Rising steadily for N periods |
| \`ApproximateNumberOfMessagesNotVisible\` | In-flight. High with low throughput means consumers are stuck or crashing without deleting. | Near the in-flight limit |
| DLQ \`ApproximateNumberOfMessagesVisible\` | Something failed \`maxReceiveCount\` times | **\`> 0\`**, always |
| \`NumberOfMessagesSent\` on the DLQ | Rate of new failures (more useful than depth for paging) | \`> 0\` |
| SNS \`NumberOfNotificationsFailed\`, EventBridge \`FailedInvocations\` | Delivery to targets failing (often a missing queue or KMS policy) | \`> 0\` |

Queue depth alone is misleading. 10,000 messages that are 2 seconds old is a healthy burst. 50 messages that are 2 hours old is an outage.

## Is it poison or is it the platform?

When the DLQ fills or the backlog grows, the first question is **one message or all of them?**

- **One message type, or one tenant, keeps failing; others flow.** Poison message: a payload your code can't handle. The DLQ is doing its job.
- **Everything fails.** A dependency is down (database, third-party API), credentials or permissions changed, or a bad deploy. Messages are not poison. They will hit \`maxReceiveCount\` and drain into the DLQ at full speed. The first action is to **stop the bleeding**: pause consumption (disable the Lambda event source mapping, or scale workers to zero) so the queue holds messages instead of burning their retries.

## The playbook

1. **Acknowledge and scope.** Which queue, since when, how many, one type or all? Check deploy history and the dependency dashboards.
2. **Inspect without destroying.** Look at DLQ messages with a receive and \`--visibility-timeout 0\` or a short timeout, and **never delete while investigating**. Read \`ApproximateReceiveCount\`, \`SentTimestamp\`, \`DeadLetterQueueSourceArn\` and your correlation ID, then find that ID in the consumer logs to get the actual exception.
   \`\`\`text
   aws sqs receive-message --queue-url "$DLQ_URL" --max-number-of-messages 10 \
     --visibility-timeout 0 --attribute-names All --message-attribute-names All
   \`\`\`
3. **Preserve evidence.** Copy problematic bodies to a ticket or an S3 bucket. DLQ retention is a countdown that started when the message was *first* sent.
4. **Fix forward.** Deploy the fix (handle the new field, add validation, raise the timeout). If the message is genuinely invalid and will never be processable, decide explicitly: discard with a recorded reason, or route it to a "parking lot" queue for manual handling. Don't leave it to expire.
5. **Redrive deliberately.** Start a message move task back to the source, rate-limited if the backlog is big, and watch the consumer error rate and the DLQ. If they start landing in the DLQ again, stop: your fix didn't fix it.
6. **Prevent recurrence.** Add the payload as a test case, add schema validation at the producer, and write the postmortem.

## Design choices that make the playbook work

- **Catch, classify, and act.** In the consumer, separate *permanent* errors (validation, unknown type: send straight to the DLQ or parking lot, and delete from the source) from *transient* ones (timeouts, throttling: let the message become visible again). Retrying a permanent error just burns \`maxReceiveCount\` and delays everything behind it.
- **Partial batch failures.** With Lambda and SQS, return \`batchItemFailures\` so one bad message doesn't make the whole batch of ten retry (and drag nine good messages towards the DLQ). You'll do this in the next module.
- **Backoff between retries.** SQS retries as soon as visibility expires. For a struggling dependency, increase the message's visibility with \`ChangeMessageVisibility\` on failure (for example 30 s × attempt) to get exponential backoff.
- **Watch FIFO heads.** In FIFO queues, a poison message blocks its whole message group until it leaves. Keep \`maxReceiveCount\` low enough that a blocked group recovers within your SLO.
- **Make redrive safe.** It's only safe if consumers are idempotent: some of these messages may have *partially* succeeded the first time.
- **Everything in IaC.** Queue, DLQ, redrive policy, redrive allow policy, alarms and the queue policy belong in one Terraform module or CloudFormation stack, so no queue ever ships without its DLQ and alarm.

> **Common incident:** a deploy raises the consumer's processing time from 20 s to 40 s, but the queue visibility timeout is still 30 s. Every message gets processed twice, half of them by two workers at once, the receive count climbs, and healthy messages start reaching the DLQ. Symptom: duplicates plus DLQ growth with no errors in the logs. Fix: raise the visibility timeout (or heartbeat), *then* redrive.

The first lab has you build exactly this: a queue with a DLQ, a consumer that chokes on a poison message, and a fix-and-redrive.
`,
    },
    {
      id: "lab-work-queue",
      kind: "lab",
      title: "Lab: a resilient work queue",
      minutes: 25,
      body: String.raw`
You run the order-processing worker. It reads from an SQS queue, and a single malformed order must not block the queue or be retried forever. You'll build the queue, its DLQ and redrive policy, watch a poison message bounce until it's quarantined, then ship a fix and redrive it.

The lab folder contains \`consumer.sh\`, a simulated worker. It long-polls \`orders\`, appends each message body to \`processed.log\`, and deletes the message. It has a bug: any body containing \`poison\` makes it "crash" before the delete. Run it with \`FIXED=1\` once you've "shipped the fix".

\`\`\`text
./consumer.sh 6            # up to 6 receive attempts with the buggy worker
FIXED=1 ./consumer.sh 3    # the fixed worker
\`\`\`

The visibility timeout in this lab is 2 seconds so the retry loop takes seconds, not minutes. In production you'd size it from the consumer's worst-case runtime, as the reading explains.
`,
      lab: {
        files: {
          "consumer.sh": String.raw`#!/usr/bin/env bash
# Simulated order worker. Long-polls the "orders" queue, appends each body to
# processed.log, then deletes the message.
# BUG: a body containing "poison" makes it crash before DeleteMessage, so the
# message becomes visible again when its visibility timeout expires.
# Usage: ./consumer.sh [rounds]        FIXED=1 ./consumer.sh [rounds]
set -uo pipefail
ROUNDS=\${1:-5}
QURL=$(aws sqs get-queue-url --queue-name orders --query QueueUrl --output text) || exit 1
for i in $(seq "$ROUNDS"); do
  MSG=$(aws sqs receive-message --queue-url "$QURL" --wait-time-seconds 5 \
    --attribute-names ApproximateReceiveCount --query 'Messages[0]' --output json)
  if [ -z "$MSG" ] || [ "$MSG" = "null" ]; then echo "round $i: nothing to receive"; continue; fi
  BODY=$(jq -r .Body <<<"$MSG")
  COUNT=$(jq -r .Attributes.ApproximateReceiveCount <<<"$MSG")
  if [[ "$BODY" == *poison* ]] && [ "\${FIXED:-0}" != 1 ]; then
    echo "round $i: receive #$COUNT of $BODY -> crashed, not deleted"
    continue
  fi
  echo "$BODY" >> processed.log
  aws sqs delete-message --queue-url "$QURL" --receipt-handle "$(jq -r .ReceiptHandle <<<"$MSG")"
  echo "round $i: receive #$COUNT of $BODY -> processed and deleted"
done
`,
        },
        tasks: [
          {
            id: "dlq",
            title: "Create the dead-letter queue",
            description:
              "Create a standard queue named `orders-dlq` with the **maximum message retention (14 days)**, and give it a **redrive allow policy** so that only the queue `orders` (ARN `arn:aws:sqs:us-east-1:000000000000:orders`) may use it as a DLQ.",
            hints: [
              "14 days is 1209600 seconds (`MessageRetentionPeriod`).",
              "`RedriveAllowPolicy` is a JSON string: `{\"redrivePermission\":\"byQueue\",\"sourceQueueArns\":[\"arn:aws:sqs:us-east-1:000000000000:orders\"]}`. Building the attributes file with `jq -n '{MessageRetentionPeriod:\"1209600\", RedriveAllowPolicy: ({redrivePermission:\"byQueue\", sourceQueueArns:[\"arn:aws:sqs:us-east-1:000000000000:orders\"]}|tojson)}' > dlq.json` avoids quoting pain.",
              "`aws sqs create-queue --queue-name orders-dlq --attributes file://dlq.json`",
            ],
            check: async (ctx) => {
              const a = await queueAttrs(ctx, "orders-dlq");
              if (!a) return "Queue `orders-dlq` doesn't exist yet.";
              if (a.MessageRetentionPeriod !== "1209600")
                return `MessageRetentionPeriod is ${a.MessageRetentionPeriod}; a DLQ should keep messages for the maximum, 1209600 (14 days).`;
              const rap = parse(a.RedriveAllowPolicy ?? "");
              if (!rap) return "`orders-dlq` has no RedriveAllowPolicy yet.";
              if (rap.redrivePermission !== "byQueue") return `redrivePermission is \`${rap.redrivePermission}\`; expected \`byQueue\`.`;
              if (!(rap.sourceQueueArns ?? []).includes(ARN("orders")))
                return `sourceQueueArns is ${JSON.stringify(rap.sourceQueueArns)}; it should contain ${ARN("orders")}.`;
              return true;
            },
          },
          {
            id: "main-queue",
            title: "Create the work queue with a redrive policy",
            description:
              "Create a standard queue named `orders` with a **visibility timeout of 2 seconds** (lab value), **long polling of 20 seconds** by default, and a **redrive policy** that sends messages to `orders-dlq` after **3** receives (`maxReceiveCount=3`).",
            hints: [
              "Attributes: `VisibilityTimeout=2`, `ReceiveMessageWaitTimeSeconds=20`, and `RedrivePolicy`, which is itself a JSON string.",
              "`jq -n '{VisibilityTimeout:\"2\", ReceiveMessageWaitTimeSeconds:\"20\", RedrivePolicy: ({deadLetterTargetArn:\"arn:aws:sqs:us-east-1:000000000000:orders-dlq\", maxReceiveCount:3}|tojson)}' > orders.json`",
              "`aws sqs create-queue --queue-name orders --attributes file://orders.json` (or `set-queue-attributes` if it already exists).",
            ],
            check: async (ctx) => {
              const a = await queueAttrs(ctx, "orders");
              if (!a) return "Queue `orders` doesn't exist yet.";
              if (a.VisibilityTimeout !== "2") return `VisibilityTimeout is ${a.VisibilityTimeout}; expected 2 for this lab.`;
              if (a.ReceiveMessageWaitTimeSeconds !== "20")
                return `ReceiveMessageWaitTimeSeconds is ${a.ReceiveMessageWaitTimeSeconds}; expected 20 (long polling).`;
              const rp = parse(a.RedrivePolicy ?? "");
              if (!rp) return "`orders` has no RedrivePolicy yet.";
              if (rp.deadLetterTargetArn !== ARN("orders-dlq"))
                return `deadLetterTargetArn is ${rp.deadLetterTargetArn}; expected ${ARN("orders-dlq")}.`;
              if (Number(rp.maxReceiveCount) !== 3) return `maxReceiveCount is ${rp.maxReceiveCount}; expected 3.`;
              return true;
            },
          },
          {
            id: "poison",
            title: "Watch a poison message get quarantined",
            description:
              "Send two messages to `orders`: `{\"orderId\":\"o-12\"}` and `{\"orderId\":\"o-13\",\"poison\":true}`. Run the buggy `./consumer.sh` until `o-12` is in `processed.log` and `o-13` has been **moved to `orders-dlq`** by SQS. Watch the receive count climb on each attempt.",
            hints: [
              "`aws sqs send-message --queue-url \"$(aws sqs get-queue-url --queue-name orders --query QueueUrl --output text)\" --message-body '{\"orderId\":\"o-12\"}'`, then the same for o-13.",
              "Run `./consumer.sh 6`. The poison message is received 3 times. On the 4th attempt SQS moves it to the DLQ instead of delivering it.",
              "Peek at the DLQ without hiding the message: `aws sqs receive-message --queue-url <dlq-url> --visibility-timeout 0 --attribute-names All`. Note `DeadLetterQueueSourceArn`.",
            ],
            check: async (ctx) => {
              const log = (await ctx.readFile("processed.log")) ?? "";
              if (!log.includes("o-12")) return "`processed.log` doesn't contain o-12 yet. Send both messages and run `./consumer.sh 6`.";
              if (log.includes("o-13")) {
                // Already fixed and redriven: accept if the redrive happened.
                const t = await ctx.tryAws(["sqs", "list-message-move-tasks", "--source-arn", ARN("orders-dlq")]);
                if (t.ok && (t.data?.Results ?? []).length) return true;
                return "o-13 was processed without ever reaching the DLQ. Did you run the consumer with FIXED=1 too early?";
              }
              const msgs = await peek(ctx, "orders-dlq");
              const m = msgs.find((x) => parse(x.Body)?.orderId === "o-13");
              if (!m) return "o-13 isn't in `orders-dlq` yet. Keep running `./consumer.sh` until its receive count exceeds 3.";
              if (m.Attributes?.DeadLetterQueueSourceArn && m.Attributes.DeadLetterQueueSourceArn !== ARN("orders"))
                return `The DLQ message came from ${m.Attributes.DeadLetterQueueSourceArn}, not \`orders\`.`;
              return true;
            },
          },
          {
            id: "redrive",
            title: "Ship the fix and redrive",
            description:
              "Redrive the DLQ back to its source queue with a **message move task**, then run the fixed worker (`FIXED=1 ./consumer.sh`) so `o-13` is processed. Finish with both `orders` and `orders-dlq` empty.",
            hints: [
              "`aws sqs start-message-move-task --source-arn arn:aws:sqs:us-east-1:000000000000:orders-dlq` moves messages back to the queue they came from.",
              "Check progress with `aws sqs list-message-move-tasks --source-arn …`, then run `FIXED=1 ./consumer.sh 3`.",
            ],
            check: async (ctx) => {
              const t = await ctx.tryAws(["sqs", "list-message-move-tasks", "--source-arn", ARN("orders-dlq")]);
              if (!t.ok) return "Couldn't list message move tasks for `orders-dlq`. Does the queue exist?";
              const done = (t.data?.Results ?? []).find((r: any) => r.Status === "COMPLETED");
              if (!done) return "No completed message move task from `orders-dlq` yet. Start one with `start-message-move-task`.";
              const log = (await ctx.readFile("processed.log")) ?? "";
              if (!log.includes("o-13")) return "o-13 hasn't been processed yet. Run `FIXED=1 ./consumer.sh 3`.";
              for (const q of ["orders", "orders-dlq"]) {
                const a = await queueAttrs(ctx, q);
                const n = Number(a?.ApproximateNumberOfMessages ?? 0) + Number(a?.ApproximateNumberOfMessagesNotVisible ?? 0);
                if (n > 0) return `\`${q}\` still holds ${n} message(s). Every message should be processed and deleted.`;
              }
              return true;
            },
          },
        ],
        solution: String.raw`
jq -n '{MessageRetentionPeriod:"1209600", RedriveAllowPolicy: ({redrivePermission:"byQueue", sourceQueueArns:["arn:aws:sqs:us-east-1:000000000000:orders"]}|tojson)}' > dlq.json
aws sqs create-queue --queue-name orders-dlq --attributes file://dlq.json
jq -n '{VisibilityTimeout:"2", ReceiveMessageWaitTimeSeconds:"20", RedrivePolicy: ({deadLetterTargetArn:"arn:aws:sqs:us-east-1:000000000000:orders-dlq", maxReceiveCount:3}|tojson)}' > orders.json
aws sqs create-queue --queue-name orders --attributes file://orders.json
QURL=$(aws sqs get-queue-url --queue-name orders --query QueueUrl --output text)
DLQ_URL=$(aws sqs get-queue-url --queue-name orders-dlq --query QueueUrl --output text)
aws sqs send-message --queue-url "$QURL" --message-body '{"orderId":"o-12"}'
aws sqs send-message --queue-url "$QURL" --message-body '{"orderId":"o-13","poison":true}'
./consumer.sh 7
for i in $(seq 30); do
  N=$(aws sqs get-queue-attributes --queue-url "$DLQ_URL" --attribute-names ApproximateNumberOfMessages --query Attributes.ApproximateNumberOfMessages --output text)
  [ "$N" = 1 ] && break
  ./consumer.sh 1
done
aws sqs receive-message --queue-url "$DLQ_URL" --visibility-timeout 0 --attribute-names All
aws sqs start-message-move-task --source-arn arn:aws:sqs:us-east-1:000000000000:orders-dlq
for i in $(seq 30); do
  S=$(aws sqs list-message-move-tasks --source-arn arn:aws:sqs:us-east-1:000000000000:orders-dlq --query 'Results[0].Status' --output text)
  [ "$S" = COMPLETED ] && break
  sleep 1
done
FIXED=1 ./consumer.sh 2
`,
      },
    },
    {
      id: "lab-fanout",
      kind: "lab",
      title: "Lab: fan-out with SNS and EventBridge",
      minutes: 30,
      body: String.raw`
The order service publishes order events. Three teams want them:

- **Billing** wants every order event, from an SNS topic.
- **On-call** wants only \`priority=high\` orders, as raw JSON, from the same topic.
- **Fulfilment** wants \`OrderPlaced\` events from the \`app\` EventBridge bus, reshaped to \`{"orderId": …, "placedAt": …}\`.

**Prepare lab** has created the three queues (\`billing\`, \`priority\`, \`fulfilment\`). You wire up everything else, including the queue policies, which are what make or break this in real life.

A starting point for a queue policy is in \`queue-policy.json\`. Remember that \`set-queue-attributes\` wants the policy as a JSON *string* inside the attributes map:

\`\`\`text
jq -n --arg p "$(cat my-policy.json)" '{Policy: $p}' > attrs.json
aws sqs set-queue-attributes --queue-url <url> --attributes file://attrs.json
\`\`\`

A queue has one policy. If a queue had to accept both SNS and EventBridge, both statements would go in the same document.
`,
      lab: {
        files: {
          "queue-policy.json": String.raw`{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowPublisher",
      "Effect": "Allow",
      "Principal": { "Service": "SERVICE.amazonaws.com" },
      "Action": "sqs:SendMessage",
      "Resource": "QUEUE_ARN",
      "Condition": { "ArnEquals": { "aws:SourceArn": "SOURCE_ARN" } }
    }
  ]
}
`,
        },
        setup: String.raw`
for q in billing priority fulfilment; do aws sqs create-queue --queue-name "$q" >/dev/null; done
`,
        tasks: [
          {
            id: "topic-billing",
            title: "Topic and billing subscription",
            description:
              "Create an SNS topic named `order-events` and subscribe the `billing` queue to it (envelope delivery, no filter). Give `billing` a queue policy that allows `sns.amazonaws.com` to `sqs:SendMessage`, **scoped with `aws:SourceArn` to the topic**.",
            hints: [
              "`aws sns create-topic --name order-events` returns the topic ARN. Queue ARNs look like `arn:aws:sqs:us-east-1:000000000000:billing`.",
              "Fill in `queue-policy.json` (SERVICE=sns, QUEUE_ARN, SOURCE_ARN=topic ARN), save it as `billing-policy.json`, wrap it with `jq -n --arg p \"$(cat billing-policy.json)\" '{Policy: $p}' > attrs.json`, then `aws sqs set-queue-attributes --queue-url <billing-url> --attributes file://attrs.json`.",
              "`aws sns subscribe --topic-arn <topic-arn> --protocol sqs --notification-endpoint arn:aws:sqs:us-east-1:000000000000:billing`",
            ],
            check: async (ctx) => {
              const topic = "arn:aws:sns:us-east-1:000000000000:order-events";
              const t = await ctx.tryAws(["sns", "get-topic-attributes", "--topic-arn", topic]);
              if (!t.ok) return "Topic `order-events` doesn't exist yet.";
              const subs = await ctx.aws(["sns", "list-subscriptions-by-topic", "--topic-arn", topic]);
              const s = (subs.Subscriptions ?? []).find((x: any) => x.Endpoint === ARN("billing"));
              if (!s) return "`billing` isn't subscribed to `order-events` yet.";
              if (s.Protocol !== "sqs") return `The billing subscription uses protocol ${s.Protocol}; expected sqs.`;
              const a = await queueAttrs(ctx, "billing");
              const p = policyAllows(a?.Policy, "sns.amazonaws.com", topic);
              if (p !== true) return `The \`billing\` queue policy: ${p}.`;
              return true;
            },
          },
          {
            id: "priority-sub",
            title: "Filtered, raw subscription for on-call",
            description:
              "Subscribe the `priority` queue to `order-events` with a **filter policy** that only accepts messages whose message attribute `priority` is `high`, and **raw message delivery** turned on. Give `priority` the same kind of scoped queue policy.",
            hints: [
              "Subscription attributes: `FilterPolicy` = `{\"priority\":[\"high\"]}` and `RawMessageDelivery` = `true`. Both are strings.",
              "`aws sns subscribe … --attributes '{\"RawMessageDelivery\":\"true\",\"FilterPolicy\":\"{\\\"priority\\\":[\\\"high\\\"]}\"}'`, or set them afterwards with `aws sns set-subscription-attributes`.",
              "Don't forget the queue policy for `priority`. Without it the subscription looks fine and nothing arrives.",
            ],
            check: async (ctx) => {
              const topic = "arn:aws:sns:us-east-1:000000000000:order-events";
              const subs = await ctx.tryAws(["sns", "list-subscriptions-by-topic", "--topic-arn", topic]);
              if (!subs.ok) return "Topic `order-events` doesn't exist yet.";
              const s = (subs.data.Subscriptions ?? []).find((x: any) => x.Endpoint === ARN("priority"));
              if (!s) return "`priority` isn't subscribed to `order-events` yet.";
              const at = (await ctx.aws(["sns", "get-subscription-attributes", "--subscription-arn", s.SubscriptionArn])).Attributes ?? {};
              const fp = parse(at.FilterPolicy ?? "");
              if (!fp) return "The priority subscription has no FilterPolicy yet.";
              if (JSON.stringify(fp.priority) !== JSON.stringify(["high"]))
                return `FilterPolicy is ${at.FilterPolicy}; expected {"priority":["high"]}.`;
              if ((at.FilterPolicyScope ?? "MessageAttributes") !== "MessageAttributes")
                return `FilterPolicyScope is ${at.FilterPolicyScope}; this filter matches message attributes, so leave it as MessageAttributes.`;
              if (at.RawMessageDelivery !== "true") return "RawMessageDelivery isn't enabled on the priority subscription.";
              const a = await queueAttrs(ctx, "priority");
              const p = policyAllows(a?.Policy, "sns.amazonaws.com", topic);
              if (p !== true) return `The \`priority\` queue policy: ${p}.`;
              return true;
            },
          },
          {
            id: "publish",
            title: "Publish and verify the fan-out",
            description:
              "Publish two messages to `order-events`: body `{\"orderId\":\"o-1\"}` with message attribute `priority=high`, and body `{\"orderId\":\"o-2\"}` with `priority=low`. `billing` should end up with **both** (in SNS envelopes) and `priority` with **only o-1** (raw). Don't consume them: the check reads the queues.",
            hints: [
              "`aws sns publish --topic-arn <arn> --message '{\"orderId\":\"o-1\"}' --message-attributes 'priority={DataType=String,StringValue=high}'`",
              "Peek without consuming: `aws sqs receive-message --queue-url <url> --visibility-timeout 0 --max-number-of-messages 10 --query 'Messages[].Body'`.",
              "If `priority` gets nothing, check its queue policy first, then the filter policy.",
            ],
            check: async (ctx) => {
              const billing = await peek(ctx, "billing");
              const ids = billing.map((m) => parse(parse(m.Body)?.Message ?? "")?.orderId);
              if (!ids.includes("o-1") || !ids.includes("o-2"))
                return `\`billing\` holds ${billing.length} message(s) with orderIds ${JSON.stringify(ids)}; expected SNS envelopes for both o-1 and o-2.`;
              const pr = await peek(ctx, "priority");
              const pids = pr.map((m) => parse(m.Body)?.orderId);
              if (!pids.includes("o-1"))
                return "`priority` doesn't have o-1 as a raw JSON body. Check its queue policy, RawMessageDelivery and that you set the `priority=high` message attribute.";
              if (pids.includes("o-2")) return "`priority` received o-2 (priority=low). The filter policy isn't filtering.";
              if (pr.some((m) => parse(m.Body)?.Type === "Notification"))
                return "`priority` has an SNS envelope in it. Raw message delivery wasn't on when that message was delivered.";
              return true;
            },
          },
          {
            id: "eventbridge-rule",
            title: "Route OrderPlaced events with EventBridge",
            description:
              "Create a custom event bus `app` and a rule `order-placed` on it that matches **only** events with source `app.orders` and detail-type `OrderPlaced`. Target the `fulfilment` queue with an **input transformer** that delivers `{\"orderId\": <detail.orderId>, \"placedAt\": <time>}`. Give `fulfilment` a queue policy for `events.amazonaws.com`, scoped to the rule's ARN.",
            hints: [
              "The rule ARN on a custom bus is `arn:aws:events:us-east-1:000000000000:rule/app/order-placed`.",
              "`aws events put-rule --name order-placed --event-bus-name app --event-pattern '{\"source\":[\"app.orders\"],\"detail-type\":[\"OrderPlaced\"]}'`",
              "Write targets.json: `[{\"Id\":\"fulfilment\",\"Arn\":\"arn:aws:sqs:us-east-1:000000000000:fulfilment\",\"InputTransformer\":{\"InputPathsMap\":{\"id\":\"$.detail.orderId\",\"at\":\"$.time\"},\"InputTemplate\":\"{\\\"orderId\\\": <id>, \\\"placedAt\\\": <at>}\"}}]`, then `aws events put-targets --rule order-placed --event-bus-name app --targets file://targets.json`.",
            ],
            check: async (ctx) => {
              const r = await ctx.tryAws(["events", "describe-rule", "--name", "order-placed", "--event-bus-name", "app"]);
              if (!r.ok) return "Rule `order-placed` on bus `app` doesn't exist yet.";
              const pat = parse(r.data.EventPattern ?? "");
              if (!pat) return "The rule has no event pattern.";
              if (JSON.stringify(pat.source) !== JSON.stringify(["app.orders"]))
                return `The pattern's source is ${JSON.stringify(pat.source)}; expected ["app.orders"].`;
              if (JSON.stringify(pat["detail-type"]) !== JSON.stringify(["OrderPlaced"]))
                return `The pattern's detail-type is ${JSON.stringify(pat["detail-type"])}; expected ["OrderPlaced"].`;
              const t = await ctx.aws(["events", "list-targets-by-rule", "--rule", "order-placed", "--event-bus-name", "app"]);
              const tg = (t.Targets ?? []).find((x: any) => x.Arn === ARN("fulfilment"));
              if (!tg) return "The rule doesn't target the `fulfilment` queue yet.";
              const it = tg.InputTransformer;
              if (!it) return "The fulfilment target has no InputTransformer, so it would receive the whole event envelope.";
              const paths = Object.values(it.InputPathsMap ?? {});
              if (!paths.includes("$.detail.orderId") || !paths.includes("$.time"))
                return `InputPathsMap is ${JSON.stringify(it.InputPathsMap)}; it should extract $.detail.orderId and $.time.`;
              const a = await queueAttrs(ctx, "fulfilment");
              const p = policyAllows(a?.Policy, "events.amazonaws.com", r.data.Arn);
              if (p !== true) return `The \`fulfilment\` queue policy: ${p}.`;
              return true;
            },
          },
          {
            id: "events-delivered",
            title: "Put events and verify the routing",
            description:
              "Put two events on the `app` bus with source `app.orders`: an `OrderPlaced` with detail `{\"orderId\":\"o-3\"}` and an `OrderCancelled` with detail `{\"orderId\":\"o-4\"}`. `fulfilment` should receive only o-3, reshaped by your transformer.",
            hints: [
              "`aws events put-events --entries '[{\"EventBusName\":\"app\",\"Source\":\"app.orders\",\"DetailType\":\"OrderPlaced\",\"Detail\":\"{\\\"orderId\\\":\\\"o-3\\\"}\"}]'`",
              "Check `FailedEntryCount` in the response, then peek at the queue with `--visibility-timeout 0`.",
            ],
            check: async (ctx) => {
              const msgs = await peek(ctx, "fulfilment");
              const bodies = msgs.map((m) => parse(m.Body));
              const o3 = bodies.find((b) => b?.orderId === "o-3");
              if (!o3) {
                if (bodies.some((b) => b?.detail?.orderId === "o-3"))
                  return "o-3 arrived as a full event envelope. The input transformer wasn't applied.";
                return `\`fulfilment\` has no message with orderId o-3 (it holds ${msgs.length} message(s)). Check FailedEntryCount, the rule and the queue policy.`;
              }
              if (!o3.placedAt) return `The o-3 message is ${JSON.stringify(o3)}; it should include placedAt from the event's time.`;
              if (bodies.some((b) => b?.orderId === "o-4" || b?.detail?.orderId === "o-4"))
                return "`fulfilment` received o-4 (an OrderCancelled event). Tighten the event pattern.";
              return true;
            },
          },
        ],
        solution: String.raw`
TOPIC=$(aws sns create-topic --name order-events --query TopicArn --output text)
qurl() { aws sqs get-queue-url --queue-name "$1" --query QueueUrl --output text; }
allow() {
  sed -e "s|SERVICE|$2|" -e "s|QUEUE_ARN|arn:aws:sqs:us-east-1:000000000000:$1|" -e "s|SOURCE_ARN|$3|" queue-policy.json > "$1-policy.json"
  jq -n --arg p "$(cat "$1-policy.json")" '{Policy: $p}' > "$1-attrs.json"
  aws sqs set-queue-attributes --queue-url "$(qurl "$1")" --attributes "file://$1-attrs.json"
}
allow billing sns "$TOPIC"
allow priority sns "$TOPIC"
aws sns subscribe --topic-arn "$TOPIC" --protocol sqs --notification-endpoint arn:aws:sqs:us-east-1:000000000000:billing
aws sns subscribe --topic-arn "$TOPIC" --protocol sqs --notification-endpoint arn:aws:sqs:us-east-1:000000000000:priority \
  --attributes '{"RawMessageDelivery":"true","FilterPolicy":"{\"priority\":[\"high\"]}"}'
aws sns publish --topic-arn "$TOPIC" --message '{"orderId":"o-1"}' --message-attributes 'priority={DataType=String,StringValue=high}'
aws sns publish --topic-arn "$TOPIC" --message '{"orderId":"o-2"}' --message-attributes 'priority={DataType=String,StringValue=low}'

aws events create-event-bus --name app
RULE=$(aws events put-rule --name order-placed --event-bus-name app \
  --event-pattern '{"source":["app.orders"],"detail-type":["OrderPlaced"]}' --query RuleArn --output text)
allow fulfilment events "$RULE"
cat > targets.json <<'EOF'
[{"Id":"fulfilment","Arn":"arn:aws:sqs:us-east-1:000000000000:fulfilment",
  "InputTransformer":{"InputPathsMap":{"id":"$.detail.orderId","at":"$.time"},
                      "InputTemplate":"{\"orderId\": <id>, \"placedAt\": <at>}"}}]
EOF
aws events put-targets --rule order-placed --event-bus-name app --targets file://targets.json
aws events put-events --entries '[{"EventBusName":"app","Source":"app.orders","DetailType":"OrderPlaced","Detail":"{\"orderId\":\"o-3\"}"},{"EventBusName":"app","Source":"app.orders","DetailType":"OrderCancelled","Detail":"{\"orderId\":\"o-4\"}"}]'

# Delivery is asynchronous: wait until each queue has what we expect.
for q in billing:2 priority:1 fulfilment:1; do
  for i in $(seq 30); do
    N=$(aws sqs get-queue-attributes --queue-url "$(qurl "\${q%%:*}")" --attribute-names ApproximateNumberOfMessages --query Attributes.ApproximateNumberOfMessages --output text)
    [ "$N" -ge "\${q##*:}" ] && break
    sleep 1
  done
done
`,
      },
    },
  ],
  quiz: [
    {
      q: "A worker's average job takes 20 s and the slowest take 90 s. The queue's visibility timeout is 30 s and maxReceiveCount is 3. Users report duplicate emails, and the DLQ is slowly filling with messages that have no errors in the logs. What's the fix?",
      options: [
        "Lower maxReceiveCount to 1 so duplicates go to the DLQ immediately",
        "Raise the visibility timeout above the worst-case processing time (or heartbeat with ChangeMessageVisibility), then redrive the DLQ",
        "Switch to a FIFO queue, which prevents duplicate deliveries",
        "Enable long polling with ReceiveMessageWaitTimeSeconds=20",
      ],
      answer: 1,
      explain:
        "Slow jobs outlive their 30 s visibility, so the message reappears and a second worker processes it (duplicates). The receive count climbs, so healthy messages reach the DLQ. Size the visibility timeout to the worst case, or extend it while working, then redrive. FIFO deduplicates *sends* within 5 minutes. It doesn't stop redelivery after a visibility timeout expires.",
    },
    {
      q: "You subscribed an SQS queue to an SNS topic. The subscription shows PendingConfirmation=false, Publish returns a MessageId, but the queue never receives anything. What's the most likely cause?",
      options: [
        "SNS needs RawMessageDelivery to deliver to SQS",
        "The queue's access policy doesn't allow sns.amazonaws.com to sqs:SendMessage for this topic",
        "The publisher's IAM policy is missing sqs:SendMessage",
        "SQS subscriptions only work with FIFO topics",
      ],
      answer: 1,
      explain:
        "SNS delivers by calling SendMessage as the SNS service principal, so the **queue's** resource policy must allow `sns.amazonaws.com`, ideally with an `aws:SourceArn` condition for the topic. The publisher only needs `sns:Publish`. With a customer-managed KMS key on the queue, the key policy must allow SNS too.",
    },
    {
      q: "A FIFO queue uses MessageGroupId = \"orders\" for every message. Throughput is stuck at a handful of messages per second even with 50 consumers, and one bad message stopped everything for an hour. Why?",
      options: [
        "FIFO queues are limited to 1 message per second",
        "Ordering and in-flight exclusivity apply per message group: a single group ID serialises the whole queue, and a poison message at its head blocks it",
        "The consumers need long polling",
        "Content-based deduplication is dropping messages",
      ],
      answer: 1,
      explain:
        "While a message from a group is in flight, no other message from that group is delivered. One group means one message at a time, queue-wide. Use the entity ID (customer, account) as the group ID so unrelated entities process in parallel, and keep maxReceiveCount low so a poison message leaves the head quickly.",
    },
    {
      q: "Your consumer deduplicates using the SQS MessageId and still double-charges a customer. How did the duplicate get past it?",
      options: [
        "SQS reused a MessageId",
        "The producer timed out on SendMessage and retried, creating a second message (new MessageId) for the same payment. Dedup on a business key such as paymentId",
        "The visibility timeout was too long",
        "Long polling returns duplicates",
      ],
      answer: 1,
      explain:
        "MessageId identifies a *message*, not a *business event*. Producer retries create new messages. Idempotency must key on something in the payload (paymentId, orderId), enforced with a conditional write or a dedup table with a TTL.",
    },
    {
      q: "Several teams need order events. Billing needs every one; risk needs only orders over $1,000 from new customers; a partner account needs OrderShipped events. Which design fits best?",
      options: [
        "One SQS queue that all three teams poll",
        "Publish to an EventBridge bus; one rule per consumer with a content-based pattern (numeric and field matching), each targeting that team's SQS queue or the partner's bus",
        "The order service sends directly to three queues",
        "An SNS topic with an email subscription per team",
      ],
      answer: 1,
      explain:
        "EventBridge rules match on any field of the event (numeric ranges, nested fields, existence) and can target another account's bus. A queue in front of each internal consumer adds buffering and a DLQ. A shared queue gives each message to only one consumer, and direct sends couple the producer to every consumer.",
    },
    {
      q: "At 03:00 the DLQ alarm fires. Every message type is failing, and the logs show connection timeouts to the database. What should you do first?",
      options: [
        "Purge the DLQ so the alarm clears",
        "Start a message move task to redrive the DLQ right away",
        "Pause consumption (disable the event source mapping or scale workers to zero) so the queue holds messages instead of burning their receive counts, then fix the database",
        "Raise maxReceiveCount to 1000",
      ],
      answer: 2,
      explain:
        "These messages aren't poison. A dependency is down. Every retry moves healthy messages closer to the DLQ. Stop consuming, restore the dependency, then resume and redrive deliberately. Purging destroys data. Redriving into a still-broken consumer just loops.",
    },
    {
      q: "Why should a DLQ's MessageRetentionPeriod be set to the 14-day maximum?",
      options: [
        "DLQs are billed less when retention is longer",
        "A message keeps its original enqueue timestamp when it moves to the DLQ, so time spent failing in the source queue counts against the DLQ's retention",
        "SQS requires it for redrive policies",
        "It makes the redrive faster",
      ],
      answer: 1,
      explain:
        "Retention counts from when the message was first sent to the source queue. With default retention, a message that failed for days can expire from the DLQ almost immediately, taking the evidence with it. Use the maximum, and alarm on DLQ depth so someone looks well before then.",
    },
  ],
};
