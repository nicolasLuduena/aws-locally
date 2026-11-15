import type { CheckContext, Module } from "../types.ts";

// ------------------------------------------------------------------ helpers
const ACCT = "000000000000";
const REGION = "us-east-1";
const TOPIC_ARN = `arn:aws:sns:${REGION}:${ACCT}:ops-alerts`;
const QUEUE_ARN = `arn:aws:sqs:${REGION}:${ACCT}:ops-pager`;

const list = (x: any): any[] => (x == null ? [] : Array.isArray(x) ? x : [x]);
/** EC2 CloudTrail payloads wrap lists as { items: [...] } on real AWS; accept both shapes. */
const items = (x: any): any[] => (Array.isArray(x) ? x : Array.isArray(x?.items) ? x.items : []);

/** All CloudTrail events with this event name, with CloudTrailEvent parsed. */
async function trail(ctx: CheckContext, eventName: string): Promise<{ id: string; e: any }[]> {
  const r = await ctx.aws(["cloudtrail", "lookup-events", "--lookup-attributes", `AttributeKey=EventName,AttributeValue=${eventName}`]);
  return (r.Events ?? []).map((ev: any) => ({ id: ev.EventId, e: JSON.parse(ev.CloudTrailEvent) }));
}

async function answer(ctx: CheckContext, file: string): Promise<string | null> {
  const f = await ctx.readFile(file);
  return f === null ? null : f.trim();
}

function opensSshToWorld(e: any): boolean {
  return items(e.requestParameters?.ipPermissions).some(
    (p: any) =>
      Number(p.fromPort) <= 22 && Number(p.toPort) >= 22 && items(p.ipRanges).some((r: any) => r.cidrIp === "0.0.0.0/0"),
  );
}

const SAMPLE_LINES = [
  "2026-11-15T10:00:00Z ERROR payment declined order=1042",
  "2026-11-15T10:00:01Z INFO order placed order=1043",
  "2026-11-15T10:00:02Z WARN gateway slow, retrying order=1044",
];

export const observability: Module = {
  id: "observability",
  number: "10",
  title: "Observability: CloudWatch, Logs, CloudTrail, X-Ray",
  summary:
    "Turn logs into metrics and metrics into pages that matter, keep log costs under control, answer \"who did this?\" from CloudTrail, and alert on symptoms against SLOs.",
  services: ["CloudWatch", "CloudWatch Logs", "SNS", "SQS", "CloudTrail", "X-Ray"],
  lessons: [
    // ---------------------------------------------------------------- metrics & alarms
    {
      id: "metrics-alarms",
      kind: "reading",
      title: "Metrics and alarms",
      minutes: 16,
      body: String.raw`
CloudWatch is three products under one name: **metrics** (numeric time series), **logs** (text events) and **alarms** (rules that watch metrics and act). Most AWS services publish metrics for free; your applications publish **custom metrics**, and you pay for each one.

## What a metric is

A metric is identified by **namespace + metric name + dimensions**:

\`\`\`text
Namespace:  AWS/ApplicationELB                    ← AWS/* is reserved for AWS services
MetricName: HTTPCode_Target_5XX_Count
Dimensions: LoadBalancer=app/shop-alb/8c02…, TargetGroup=targetgroup/shop-api-tg/89f3…
\`\`\`

Every distinct **combination** of dimension values is a separate metric, billed separately (about $0.30 per metric-month for the first 10,000). Put \`CustomerId\` or \`RequestId\` in a dimension and you've created a million metrics and a five-figure bill. Dimensions are for **low-cardinality** things you alert or graph on: service, route, AZ, status class. High-cardinality detail belongs in logs.

**Resolution:** standard metrics have 1-minute granularity; **high-resolution** metrics (\`StorageResolution=1\`) go down to 1 second, and alarms on them can use 10 s or 30 s periods. CloudWatch keeps 1-second data for 3 hours, 1-minute data for 15 days, 5-minute data for 63 days and 1-hour data for 15 months, rolling it up as it ages. A dashboard of last quarter is therefore hourly data, whatever you published.

## Statistics vs percentiles

For each period, CloudWatch can return \`SampleCount\`, \`Sum\`, \`Average\`, \`Minimum\`, \`Maximum\`, and **percentiles** (\`p50\`, \`p90\`, \`p99\`, \`p99.9\`) and trimmed statistics (\`tm99\`).

**Averages lie about latency.** Publish 100 requests where 95 took ~110 ms and 5 took 900 ms:

\`\`\`bash
aws cloudwatch put-metric-data --namespace Demo/Checkout --metric-data '[{
  "MetricName": "Latency", "Unit": "Milliseconds",
  "Dimensions": [{"Name": "Service", "Value": "api"}],
  "Values": [100, 120, 130, 900], "Counts": [50, 30, 15, 5]}]'
START=$(( $(date +%s) - 600 )); END=$(( $(date +%s) + 60 ))
aws cloudwatch get-metric-statistics --namespace Demo/Checkout --metric-name Latency \
  --dimensions Name=Service,Value=api --start-time $START --end-time $END --period 300 \
  --statistics Average Maximum --query 'Datapoints[0].{avg: Average, max: Maximum}'
aws cloudwatch get-metric-statistics --namespace Demo/Checkout --metric-name Latency \
  --dimensions Name=Service,Value=api --start-time $START --end-time $END --period 300 \
  --extended-statistics p50 p99 --query 'Datapoints[0].ExtendedStatistics'
\`\`\`

An average of ~150 ms looks healthy, while p99 says one user in twenty waits almost a second. Alert on **p99** (or p95) for latency, on **Sum** for counts, and on **Average** only for things that really are averages (CPU utilisation). Percentiles need raw values: if you publish pre-aggregated *statistic sets* (\`Sum\`/\`Min\`/\`Max\`/\`Count\`), CloudWatch can't compute them.

## Publishing custom metrics: API vs EMF

- **\`PutMetricData\`**: a synchronous API call. Batch it (up to 1,000 metrics per request, up to 150 values per metric with \`Values\`/\`Counts\`) and never make it in the request path. Each call is billed and can be throttled.
- **Embedded Metric Format (EMF)**: write a structured JSON log line, and CloudWatch Logs extracts the metrics asynchronously. There's no extra API call, no throttling in your hot path, and the log line keeps the high-cardinality context (order ID, customer) next to the metric. This is the right default for Lambda and containers:

\`\`\`bash
aws logs create-log-group --log-group-name /demo/emf
aws logs create-log-stream --log-group-name /demo/emf --log-stream-name app
NOW=$(( $(date +%s) * 1000 ))
LINE=$(jq -nc --argjson t $NOW '{_aws: {Timestamp: $t, CloudWatchMetrics: [{Namespace: "Demo/EMF",
  Dimensions: [["Service"]], Metrics: [{Name: "OrderValue", Unit: "None"}]}]},
  Service: "checkout", OrderValue: 42.5, orderId: "o-1042"}')
aws logs put-log-events --log-group-name /demo/emf --log-stream-name app \
  --log-events "$(jq -nc --argjson t $NOW --arg m "$LINE" '[{timestamp: $t, message: $m}]')" >/dev/null
aws cloudwatch list-metrics --namespace Demo/EMF
\`\`\`

\`orderId\` isn't a dimension, so it costs nothing as a metric, but you can still find the log line that produced a spike.

## Alarms: the parameters that matter

An alarm evaluates one metric (or a metric-math expression) every period and moves between **OK**, **ALARM** and **INSUFFICIENT_DATA**. Actions fire on **state transitions**, not on every evaluation.

| Parameter | Meaning | Guidance |
|---|---|---|
| \`period\` | Length of each datapoint | 60 s for most; longer for sparse metrics |
| \`evaluation-periods\` (N) | How many recent periods to look at | Together with M, this is your noise filter |
| \`datapoints-to-alarm\` (M) | How many of those N must breach | "M out of N": 3 of 5 tolerates a blip but catches sustained trouble |
| \`statistic\` / \`extended-statistic\` | How each period is aggregated | Sum for counts, p99 for latency |
| \`treat-missing-data\` | What a period with no data means | See below. The default (\`missing\`) is often wrong |

<figure class="diagram">
<svg viewBox="0 0 640 190" role="img" aria-label="An M out of N alarm: 2 of the last 5 one-minute datapoints breach the threshold, so the alarm fires">
  <text x="20" y="22" class="d-label">datapoints-to-alarm 2, evaluation-periods 5, threshold ≥ 3</text>
  <path d="M40 80 H596" class="d-box d-danger"/>
  <text x="600" y="84" class="d-small">≥ 3</text>
  <rect x="60" y="127" width="80" height="23" rx="4" class="d-box d-ok"/><text x="100" y="120" text-anchor="middle" class="d-small">1</text>
  <rect x="160" y="57" width="80" height="93" rx="4" class="d-box d-danger"/><text x="200" y="110" text-anchor="middle" class="d-small">4</text>
  <rect x="260" y="148" width="80" height="2" rx="1" class="d-box d-dim"/><text x="300" y="140" text-anchor="middle" class="d-small">missing</text>
  <rect x="360" y="103" width="80" height="47" rx="4" class="d-box d-ok"/><text x="400" y="96" text-anchor="middle" class="d-small">2</text>
  <rect x="460" y="80" width="80" height="70" rx="4" class="d-box d-danger"/><text x="500" y="120" text-anchor="middle" class="d-small">3</text>
  <text x="100" y="172" text-anchor="middle" class="d-small">t-4</text><text x="200" y="172" text-anchor="middle" class="d-small">t-3</text>
  <text x="300" y="172" text-anchor="middle" class="d-small">t-2</text><text x="400" y="172" text-anchor="middle" class="d-small">t-1</text>
  <text x="500" y="172" text-anchor="middle" class="d-small">t</text>
</svg>
<figcaption>Two breaching datapoints in the window: ALARM. With <code>notBreaching</code>, the missing minute counts as fine; with <code>breaching</code> it would make three.</figcaption>
</figure>

**Missing data** is a design decision, per alarm:

- An **error count** from a metric filter or EMF produces no datapoint when nothing happens. Missing means "no errors": use \`notBreaching\`.
- A **heartbeat** (a batch job publishes \`JobSucceeded=1\` every night) going silent *is* the incident: use \`breaching\`.
- **Latency** with no traffic is unknowable: use \`missing\` or \`ignore\`, and alarm separately on traffic dropping to zero.

## Beyond a single threshold

- **Metric math** lets you alarm on what users feel: an error *rate* (\`100 * errors / requests\`) instead of a raw count that scales with traffic.
- **Composite alarms** combine alarms with \`AND\`/\`OR\`/\`NOT\`: \`ALARM("api-5xx-high") AND ALARM("api-p99-high")\`. Route only the composite to the pager. An \`ActionsSuppressor\` alarm (such as "a deployment is in progress") can mute it.
- **Anomaly detection** learns a metric's daily and weekly pattern (from up to two weeks of history) and alarms when the value leaves a band of *k* standard deviations (\`ANOMALY_DETECTION_BAND(m1, 2)\`). It's good for traffic and business metrics with strong seasonality, and poor for rare spiky signals.

## Alarm actions

Actions can target **SNS** (fan out to email, chat, a pager such as PagerDuty or Opsgenie, or an SQS queue for automation), **Lambda** directly, **EC2 actions** (reboot or recover), **Auto Scaling** policies, and **Systems Manager** OpsItems or incidents. Set **OK actions** too, so the page auto-resolves and humans aren't left guessing.

Test the wiring, not just the threshold. \`set-alarm-state\` forces a transition and fires the actions, without touching the metric:

\`\`\`bash
aws cloudwatch put-metric-alarm --alarm-name demo-latency-p99 --namespace Demo/Checkout --metric-name Latency \
  --dimensions Name=Service,Value=api --extended-statistic p99 --period 60 \
  --evaluation-periods 5 --datapoints-to-alarm 3 --threshold 500 \
  --comparison-operator GreaterThanThreshold --treat-missing-data missing
aws cloudwatch set-alarm-state --alarm-name demo-latency-p99 --state-value ALARM --state-reason "drill: testing the pager"
aws cloudwatch describe-alarm-history --alarm-name demo-latency-p99 --query 'AlarmHistoryItems[].HistorySummary'
\`\`\`

> **On real AWS vs the emulator:** the emulator evaluates alarms from real datapoints (including metric-filter and EMF output) and fires their SNS actions within seconds. Real CloudWatch evaluates on a schedule, and metric-filter datapoints can arrive a minute or two late, so expect a few minutes from the first error to the page. That delay is another reason to use M-of-N with a sensible N rather than a 1-of-1 hair trigger.
`,
    },
    // ---------------------------------------------------------------- logs
    {
      id: "logs",
      kind: "reading",
      title: "CloudWatch Logs: retention, filters and Insights",
      minutes: 15,
      body: String.raw`
CloudWatch Logs stores **log events** (timestamp + message) in **log streams** (one per source: a Lambda execution environment, an ECS task, an instance), grouped in **log groups** (one per application and environment, such as \`/ecs/shop-api\` or \`/aws/lambda/checkout\`). Settings live on the group: retention, KMS key, metric filters, subscription filters, data protection.

## Retention: never leave it at "never expire"

A new log group's retention is **Never expire**. Ingestion costs about $0.50/GB and storage $0.03/GB-month, forever. A chatty service that writes 50 GB a day pays for ingestion once, and then storage grows by 1.5 TB every month, indefinitely, for logs nobody will read.

- Set retention **when you create the group**, in IaC: 7–30 days for application logs, longer only where a requirement says so (and then archive to S3 Glacier rather than keeping it hot).
- Services that create their own groups (Lambda, ECS with \`awslogs-create-group\`, API Gateway) create them with no retention. Pre-create the groups in IaC, or run a scheduled job or Config rule that sets a default on every group with none.
- The **Infrequent Access** log class halves ingestion cost for logs you only need for occasional investigations (it doesn't support metric filters or subscriptions).
- Encrypt sensitive groups with a KMS key, and use **data protection policies** to mask PII such as emails or card numbers at ingestion.

\`\`\`bash
aws logs create-log-group --log-group-name /demo/orders
aws logs put-retention-policy --log-group-name /demo/orders --retention-in-days 14
aws logs describe-log-groups --log-group-name-prefix /demo --query 'logGroups[].{name: logGroupName, days: retentionInDays}'
\`\`\`

Allowed retention values are fixed (1, 3, 5, 7, 14, 30, 60, 90, 180, 365 … 3653 days).

## Log structured JSON

Free text forces every consumer to write regexes. One JSON object per line makes every field queryable:

\`\`\`json
{"ts":"2026-11-15T10:00:00Z","level":"ERROR","route":"/pay","ms":812,"order":"o-1042","msg":"payment declined"}
\`\`\`

## Filter patterns

The same pattern language drives \`filter-log-events\`, metric filters and subscription filters:

| Pattern | Matches |
|---|---|
| \`ERROR\` | events containing the term ERROR |
| \`"payment declined"\` | the exact phrase |
| \`?ERROR ?FATAL\` | either term |
| \`ERROR -healthcheck\` | ERROR but not healthcheck |
| \`{ $.level = "ERROR" && $.ms > 500 }\` | JSON events by field |
| \`[ts, level=ERROR, ...]\` | space-delimited events, by position |

\`\`\`bash
aws logs create-log-stream --log-group-name /demo/orders --log-stream-name api-1
NOW=$(( $(date +%s) * 1000 ))
aws logs put-log-events --log-group-name /demo/orders --log-stream-name api-1 --log-events \
  "[{\"timestamp\":$NOW,\"message\":\"{\\\"level\\\":\\\"ERROR\\\",\\\"route\\\":\\\"/pay\\\",\\\"ms\\\":812}\"},
    {\"timestamp\":$NOW,\"message\":\"{\\\"level\\\":\\\"INFO\\\",\\\"route\\\":\\\"/pay\\\",\\\"ms\\\":40}\"},
    {\"timestamp\":$NOW,\"message\":\"{\\\"level\\\":\\\"ERROR\\\",\\\"route\\\":\\\"/cart\\\",\\\"ms\\\":95}\"}]" >/dev/null
aws logs filter-log-events --log-group-name /demo/orders \
  --filter-pattern '{ $.level = "ERROR" && $.ms > 500 }' --query 'events[].message'
\`\`\`

## Metric filters: logs → metrics

A **metric filter** turns matching events into a metric datapoint: count them (\`metricValue=1\`) or extract a number from a field (\`metricValue=$.ms\`). This is how you alarm on things that only exist in logs: error lines, "payment declined", slow queries.

- Metric filters apply **only to events ingested after** the filter exists. They aren't retroactive.
- Leave \`defaultValue\` unset for error counters, and use \`treat-missing-data notBreaching\` on the alarm. (A \`defaultValue\` of 0 emits zeros only when *other* events arrive, which makes "no data" ambiguous.)
- You can add up to three dimensions taken from JSON fields. Mind cardinality: the same billing rules as custom metrics apply.
- \`aws logs test-metric-filter\` tests a pattern against sample lines before you deploy it.

## Subscription filters: stream logs elsewhere

A **subscription filter** streams matching events, in near real time, to **Kinesis Data Streams**, **Data Firehose** (to S3, OpenSearch or a third-party SIEM), or **Lambda**. A log group can have at most two. The standard pattern for a multi-account org is a cross-account *destination* in a central logging account, so every workload account ships to one place. The destination needs permission to be invoked by \`logs.amazonaws.com\`, exactly like the SNS→SQS queue policies you've written before.

## Logs Insights

**Logs Insights** is a query language over one or more log groups, billed per GB scanned (about $0.005/GB). Narrow the time range and the groups first, and it stays cheap.

\`\`\`text
fields @timestamp, route, ms
| filter level = "ERROR"
| stats count() as errors, avg(ms) as avg_ms, pct(ms, 99) as p99 by route
| sort errors desc
| limit 20
\`\`\`

Useful commands: \`parse\` (extract fields from free text with a glob or regex), \`stats … by bin(5m)\` (time series), \`dedup\`, and \`filter @message like /timeout/\`. Save the queries your runbooks use, so the on-call doesn't write them under pressure.

\`\`\`bash
QID=$(aws logs start-query --log-group-name /demo/orders \
  --start-time $(( $(date +%s) - 3600 )) --end-time $(( $(date +%s) + 60 )) \
  --query-string 'fields route, ms | filter level = "ERROR" | stats count() as errors, max(ms) as worst by route' \
  --query queryId --output text)
for _ in 1 2 3 4 5; do
  R=$(aws logs get-query-results --query-id "$QID")
  [ "$(echo "$R" | jq -r .status)" = Complete ] && break; sleep 1
done
echo "$R" | jq -c '.results[] | map({(.field): .value}) | add'
\`\`\`

<figure class="diagram">
<svg viewBox="0 0 640 200" role="img" aria-label="Logs flow from the application into a log group; a metric filter produces a metric that an alarm watches; the alarm notifies SNS, which delivers to a queue and a pager; a subscription filter streams logs to Firehose">
  <rect x="10" y="40" width="90" height="50" rx="8" class="d-box"/><text x="55" y="70" text-anchor="middle" class="d-label">App</text>
  <rect x="130" y="40" width="110" height="50" rx="8" class="d-box d-accent"/><text x="185" y="62" text-anchor="middle" class="d-label">Log group</text><text x="185" y="80" text-anchor="middle" class="d-small">retention 14 d</text>
  <rect x="270" y="40" width="100" height="50" rx="8" class="d-box"/><text x="320" y="62" text-anchor="middle" class="d-label">Metric</text><text x="320" y="80" text-anchor="middle" class="d-small">ErrorCount</text>
  <rect x="400" y="40" width="100" height="50" rx="8" class="d-box d-danger"/><text x="450" y="62" text-anchor="middle" class="d-label">Alarm</text><text x="450" y="80" text-anchor="middle" class="d-small">2 of 5 ≥ 3</text>
  <rect x="530" y="40" width="100" height="50" rx="8" class="d-box"/><text x="580" y="70" text-anchor="middle" class="d-label">SNS</text>
  <rect x="530" y="130" width="100" height="50" rx="8" class="d-box d-ok"/><text x="580" y="152" text-anchor="middle" class="d-label">SQS / pager</text><text x="580" y="170" text-anchor="middle" class="d-small">queue policy</text>
  <rect x="130" y="130" width="110" height="50" rx="8" class="d-box d-dim"/><text x="185" y="152" text-anchor="middle" class="d-label">Firehose</text><text x="185" y="170" text-anchor="middle" class="d-small">SIEM / S3</text>
  <path d="M100 65 H128" class="d-arrow"/>
  <path d="M240 65 H268" class="d-arrow"/>
  <path d="M370 65 H398" class="d-arrow"/>
  <path d="M500 65 H528" class="d-arrow"/>
  <path d="M580 90 V128" class="d-arrow"/>
  <path d="M185 90 V128" class="d-arrow d-dashed"/>
  <text x="254" y="34" text-anchor="middle" class="d-small">metric filter</text>
  <text x="196" y="114" class="d-small">subscription filter</text>
</svg>
<figcaption>The pipeline you'll build in the next lab. Every arrow is configuration you can get wrong silently, which is why you test it end to end.</figcaption>
</figure>

> **On real AWS vs the emulator:** filter patterns, metric filters (including JSON patterns and EMF extraction) and Logs Insights queries all work here. Live Tail, the Infrequent Access class's restrictions and data protection masking are real-AWS features to try in a sandbox account.
`,
    },
    // ---------------------------------------------------------------- lab: logs to alarm
    {
      id: "logs-to-alarm",
      kind: "lab",
      title: "Lab: From an ERROR line to a page",
      minutes: 30,
      body: String.raw`
The checkout service logs plain-text lines such as:

\`\`\`text
2026-11-15T10:00:00Z ERROR payment declined order=1042
2026-11-15T10:00:01Z INFO order placed order=1043
\`\`\`

The on-call wants a page when errors are **sustained**: at least 3 errors per minute in **2 of the last 5 minutes**. You'll build the whole path (log group → metric filter → metric → alarm → SNS → SQS), then prove it works by shipping errors and finding the notification in the queue. The queue stands in for a pager integration, and it's also how you would test an alerting path in CI.

Nothing is pre-created: Prepare lab only moves your terminal to the lab folder.
`,
      lab: {
        tasks: [
          {
            id: "log-group",
            title: "Create the log group with retention",
            description: "Create the log group `/app/checkout` with **14-day** retention, and a log stream `web-1` in it.",
            hints: [
              "`aws logs create-log-group` then `aws logs put-retention-policy --retention-in-days 14`.",
              "`aws logs create-log-stream --log-group-name /app/checkout --log-stream-name web-1`",
            ],
            check: async ({ tryAws }) => {
              const r = await tryAws(["logs", "describe-log-groups", "--log-group-name-prefix", "/app/checkout"]);
              const g = r.data?.logGroups?.find((x: any) => x.logGroupName === "/app/checkout");
              if (!g) return "Log group `/app/checkout` doesn't exist yet.";
              if (g.retentionInDays !== 14) return `Retention is ${g.retentionInDays ?? "never expire"}; expected 14 days.`;
              const s = await tryAws(["logs", "describe-log-streams", "--log-group-name", "/app/checkout", "--log-stream-name-prefix", "web-1"]);
              if (!s.data?.logStreams?.some((x: any) => x.logStreamName === "web-1")) return "Log stream `web-1` doesn't exist yet.";
              return true;
            },
          },
          {
            id: "metric-filter",
            title: "Count ERROR lines as a metric",
            description:
              "Add a metric filter named `checkout-errors` to `/app/checkout` that counts lines containing `ERROR` into the custom metric **`ErrorCount`** in namespace **`Checkout`** (value 1 per matching line).",
            hints: [
              "Try your pattern first: `aws logs test-metric-filter --filter-pattern 'ERROR' --log-event-messages 'x ERROR boom' 'x INFO ok'`.",
              "`aws logs put-metric-filter --log-group-name /app/checkout --filter-name checkout-errors --filter-pattern 'ERROR' --metric-transformations metricName=ErrorCount,metricNamespace=Checkout,metricValue=1`",
            ],
            check: async ({ tryAws, aws }) => {
              const r = await tryAws(["logs", "describe-metric-filters", "--log-group-name", "/app/checkout", "--filter-name-prefix", "checkout-errors"]);
              const f = r.data?.metricFilters?.find((x: any) => x.filterName === "checkout-errors");
              if (!f) return "No metric filter `checkout-errors` on `/app/checkout` yet.";
              const t = f.metricTransformations?.[0] ?? {};
              if (t.metricNamespace !== "Checkout" || t.metricName !== "ErrorCount")
                return `The filter emits ${t.metricNamespace}/${t.metricName}; expected Checkout/ErrorCount.`;
              if (String(t.metricValue) !== "1") return `metricValue is ${t.metricValue}; each matching line should count 1.`;
              const m = await aws(["logs", "test-metric-filter", "--filter-pattern", f.filterPattern, "--log-event-messages", ...SAMPLE_LINES]);
              const hits = (m.matches ?? []).map((x: any) => x.eventMessage);
              if (!hits.includes(SAMPLE_LINES[0])) return `Pattern \`${f.filterPattern}\` doesn't match an ERROR line like "${SAMPLE_LINES[0]}".`;
              if (hits.length !== 1) return `Pattern \`${f.filterPattern}\` also matches non-error lines (INFO/WARN).`;
              return true;
            },
          },
          {
            id: "alert-path",
            title: "Wire SNS to an SQS queue",
            description: String.raw`Create an SNS topic \`ops-alerts\` and an SQS queue \`ops-pager\`, and subscribe the queue to the topic.

The queue needs a **queue policy** that lets \`sns.amazonaws.com\` call \`sqs:SendMessage\`, restricted with an \`aws:SourceArn\` condition to the \`ops-alerts\` topic (so no other topic, in any account, can write to your pager queue).`,
            hints: [
              "`aws sns subscribe --topic-arn <topic> --protocol sqs --notification-endpoint <queue-arn>`",
              "Policy statement: `{\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"sns.amazonaws.com\"},\"Action\":\"sqs:SendMessage\",\"Resource\":\"<queue-arn>\",\"Condition\":{\"ArnEquals\":{\"aws:SourceArn\":\"<topic-arn>\"}}}`",
              "The Policy attribute is a JSON *string* inside JSON. jq does the escaping: `aws sqs set-queue-attributes --queue-url $QURL --attributes \"$(jq -nc --arg p \"$POLICY\" '{Policy: $p}')\"`.",
            ],
            check: async ({ tryAws }) => {
              const t = await tryAws(["sns", "get-topic-attributes", "--topic-arn", TOPIC_ARN]);
              if (!t.ok) return "Topic `ops-alerts` doesn't exist yet.";
              const u = await tryAws(["sqs", "get-queue-url", "--queue-name", "ops-pager"]);
              if (!u.ok) return "Queue `ops-pager` doesn't exist yet.";
              const subs = await tryAws(["sns", "list-subscriptions-by-topic", "--topic-arn", TOPIC_ARN]);
              if (!(subs.data?.Subscriptions ?? []).some((s: any) => s.Protocol === "sqs" && s.Endpoint === QUEUE_ARN))
                return "`ops-pager` isn't subscribed to `ops-alerts` (protocol sqs, endpoint = the queue ARN).";
              const a = await tryAws(["sqs", "get-queue-attributes", "--queue-url", u.data.QueueUrl, "--attribute-names", "Policy"]);
              const raw = a.data?.Attributes?.Policy;
              if (!raw) return "The queue has no policy, so SNS deliveries would be dropped silently.";
              const st = list(JSON.parse(raw).Statement).find(
                (s: any) =>
                  s.Effect === "Allow" &&
                  list(s.Principal?.Service).includes("sns.amazonaws.com") &&
                  list(s.Action).some((x: string) => /^sqs:(SendMessage|\*)$/i.test(x)),
              );
              if (!st) return "The queue policy doesn't allow `sns.amazonaws.com` to `sqs:SendMessage`.";
              const cond = JSON.stringify(st.Condition ?? {});
              if (!cond.includes("aws:SourceArn") || !cond.includes(TOPIC_ARN))
                return "Restrict the statement with an `aws:SourceArn` condition equal to the `ops-alerts` topic ARN.";
              return true;
            },
          },
          {
            id: "alarm",
            title: "Create an M-out-of-N alarm",
            description: String.raw`Create the alarm \`checkout-errors-high\` on \`Checkout\` / \`ErrorCount\`:

- statistic **Sum**, period **60** seconds;
- fires when the sum is **≥ 3** in **2 out of the last 5** periods;
- missing data counts as **not breaching** (no errors logged means no datapoints);
- notifies \`ops-alerts\` on **ALARM and on OK** (so the page auto-resolves).`,
            hints: [
              "`--evaluation-periods 5 --datapoints-to-alarm 2 --threshold 3 --comparison-operator GreaterThanOrEqualToThreshold`",
              "`--treat-missing-data notBreaching --alarm-actions <topic-arn> --ok-actions <topic-arn>`",
              "`aws cloudwatch put-metric-alarm --alarm-name checkout-errors-high --namespace Checkout --metric-name ErrorCount --statistic Sum --period 60 …`",
            ],
            check: async ({ tryAws }) => {
              const r = await tryAws(["cloudwatch", "describe-alarms", "--alarm-names", "checkout-errors-high"]);
              const a = r.data?.MetricAlarms?.[0];
              if (!a) return "Alarm `checkout-errors-high` doesn't exist yet.";
              if (a.Namespace !== "Checkout" || a.MetricName !== "ErrorCount") return `The alarm watches ${a.Namespace}/${a.MetricName}; expected Checkout/ErrorCount.`;
              if (a.Statistic !== "Sum") return `Statistic is ${a.Statistic ?? a.ExtendedStatistic}; use Sum for a count.`;
              if (a.Period !== 60) return `Period is ${a.Period}; expected 60.`;
              if (a.EvaluationPeriods !== 5 || a.DatapointsToAlarm !== 2)
                return `The alarm uses ${a.DatapointsToAlarm ?? a.EvaluationPeriods} out of ${a.EvaluationPeriods}; expected 2 out of 5.`;
              if (a.Threshold !== 3 || a.ComparisonOperator !== "GreaterThanOrEqualToThreshold")
                return `The condition is ${a.ComparisonOperator} ${a.Threshold}; expected GreaterThanOrEqualToThreshold 3.`;
              if (a.TreatMissingData !== "notBreaching") return `TreatMissingData is ${a.TreatMissingData ?? "missing"}; expected notBreaching.`;
              if (!(a.AlarmActions ?? []).includes(TOPIC_ARN)) return "The alarm doesn't notify `ops-alerts` on ALARM.";
              if (!(a.OKActions ?? []).includes(TOPIC_ARN)) return "Add `ops-alerts` as an OK action too, so the page resolves itself.";
              return true;
            },
          },
          {
            id: "ship-errors",
            title: "Ship a sustained burst of errors",
            description: String.raw`Write log events to \`/app/checkout\` / \`web-1\` with **at least 3 ERROR lines in each of two different minutes**: for example three timestamped one minute ago and three timestamped now.

Log event timestamps are milliseconds since the epoch, and the events in one \`put-log-events\` call must be in chronological order.`,
            hints: [
              "`NOW=$(( $(date +%s) * 1000 )); PREV=$(( NOW - 60000 ))`",
              "Shorthand works for simple messages: `--log-events timestamp=$PREV,message='ERROR payment declined order=1' timestamp=$PREV,message='ERROR …' …`",
              "Or write a JSON array of `{timestamp, message}` objects to a file and pass `--log-events file://events.json`.",
            ],
            check: async ({ tryAws }) => {
              const r = await tryAws([
                "logs", "filter-log-events", "--log-group-name", "/app/checkout", "--log-stream-names", "web-1", "--filter-pattern", "ERROR",
              ]);
              if (!r.ok) return "Can't read `/app/checkout` / `web-1` yet.";
              const perMinute = new Map<number, number>();
              for (const e of r.data?.events ?? []) {
                const m = Math.floor(e.timestamp / 60000);
                perMinute.set(m, (perMinute.get(m) ?? 0) + 1);
              }
              const busy = [...perMinute.values()].filter((n) => n >= 3).length;
              if (busy < 2)
                return `Found ERROR lines in ${perMinute.size} minute(s), ${busy} of them with 3 or more. The alarm needs 2 breaching minutes.`;
              return true;
            },
          },
          {
            id: "notified",
            title: "Prove the page arrived",
            description:
              "Once the alarm is in **ALARM**, receive the notification from `ops-pager` and save the **body of the ALARM notification** (the SNS envelope JSON) to `notification.json`. The queue may also hold an earlier OK notification; pick the right one.",
            hints: [
              "`aws cloudwatch describe-alarms --alarm-names checkout-errors-high --query 'MetricAlarms[0].StateValue'`",
              "`aws sqs receive-message --queue-url $QURL --max-number-of-messages 10 --wait-time-seconds 5 --query 'Messages[].Body'`",
              "Each body's `Message` field is itself JSON with `AlarmName` and `NewStateValue`. Select the ALARM one with jq: `jq -r '.Messages[].Body | select(fromjson | .Message | fromjson | .NewStateValue == \"ALARM\")'`.",
            ],
            check: async ({ tryAws, readFile }) => {
              const r = await tryAws(["cloudwatch", "describe-alarms", "--alarm-names", "checkout-errors-high"]);
              const a = r.data?.MetricAlarms?.[0];
              if (!a) return "Alarm `checkout-errors-high` doesn't exist yet.";
              if (a.StateValue !== "ALARM") return `The alarm is ${a.StateValue}: ${a.StateReason}`;
              const f = await readFile("notification.json");
              if (f === null) return "`notification.json` not found in the lab folder.";
              let msg: any;
              try {
                const outer = JSON.parse(f);
                msg = typeof outer.Message === "string" ? JSON.parse(outer.Message) : outer;
              } catch {
                return "`notification.json` isn't valid JSON. Save the message body exactly as received.";
              }
              if (msg.AlarmName !== "checkout-errors-high") return `The saved notification is for alarm \`${msg.AlarmName}\`.`;
              if (msg.NewStateValue !== "ALARM") return `The saved notification is the ${msg.NewStateValue} transition; save the ALARM one.`;
              return true;
            },
          },
        ],
        solution: String.raw`
aws logs create-log-group --log-group-name /app/checkout
aws logs put-retention-policy --log-group-name /app/checkout --retention-in-days 14
aws logs create-log-stream --log-group-name /app/checkout --log-stream-name web-1
aws logs put-metric-filter --log-group-name /app/checkout --filter-name checkout-errors --filter-pattern 'ERROR' \
  --metric-transformations metricName=ErrorCount,metricNamespace=Checkout,metricValue=1,unit=Count

TOPIC=$(aws sns create-topic --name ops-alerts --query TopicArn --output text)
QURL=$(aws sqs create-queue --queue-name ops-pager --query QueueUrl --output text)
QARN=$(aws sqs get-queue-attributes --queue-url "$QURL" --attribute-names QueueArn --query Attributes.QueueArn --output text)
POLICY=$(jq -nc --arg q "$QARN" --arg t "$TOPIC" '{Version: "2012-10-17", Statement: [{Sid: "AllowOpsAlerts", Effect: "Allow",
  Principal: {Service: "sns.amazonaws.com"}, Action: "sqs:SendMessage", Resource: $q,
  Condition: {ArnEquals: {"aws:SourceArn": $t}}}]}')
aws sqs set-queue-attributes --queue-url "$QURL" --attributes "$(jq -nc --arg p "$POLICY" '{Policy: $p}')"
aws sns subscribe --topic-arn "$TOPIC" --protocol sqs --notification-endpoint "$QARN" >/dev/null

aws cloudwatch put-metric-alarm --alarm-name checkout-errors-high \
  --alarm-description "Checkout: >=3 errors/min in 2 of 5 minutes. Runbook: wiki/checkout-errors" \
  --namespace Checkout --metric-name ErrorCount --statistic Sum --period 60 \
  --evaluation-periods 5 --datapoints-to-alarm 2 --threshold 3 \
  --comparison-operator GreaterThanOrEqualToThreshold --treat-missing-data notBreaching \
  --alarm-actions "$TOPIC" --ok-actions "$TOPIC"

NOW=$(( $(date +%s) * 1000 )); PREV=$(( NOW - 60000 ))
jq -n --argjson p $PREV --argjson n $NOW '[
  {timestamp: $p, message: "2026-11-15T10:00:00Z ERROR payment declined order=1042"},
  {timestamp: $p, message: "2026-11-15T10:00:01Z ERROR payment declined order=1043"},
  {timestamp: $p, message: "2026-11-15T10:00:02Z ERROR gateway timeout order=1044"},
  {timestamp: $p, message: "2026-11-15T10:00:03Z INFO order placed order=1045"},
  {timestamp: $n, message: "2026-11-15T10:01:00Z ERROR gateway timeout order=1046"},
  {timestamp: $n, message: "2026-11-15T10:01:01Z ERROR gateway timeout order=1047"},
  {timestamp: $n, message: "2026-11-15T10:01:02Z ERROR gateway timeout order=1048"}]' > events.json
aws logs put-log-events --log-group-name /app/checkout --log-stream-name web-1 --log-events file://events.json >/dev/null

# Alarm delivery is asynchronous: poll the queue (with a timeout) for the ALARM notification.
: > notification.json
for _ in $(seq 1 30); do
  aws sqs receive-message --queue-url "$QURL" --max-number-of-messages 10 --wait-time-seconds 2 > batch.json
  # Bodies are multi-line JSON: pick the first ALARM one inside jq, not with head.
  jq -r '[.Messages[]?.Body | select(fromjson | .Message | fromjson | .NewStateValue == "ALARM")] | first // empty' batch.json > candidate.json
  if [ -s candidate.json ]; then mv candidate.json notification.json; break; fi
done
[ -s notification.json ]
jq -r '.Subject' notification.json
`,
      },
    },
    // ---------------------------------------------------------------- CloudTrail
    {
      id: "cloudtrail",
      kind: "reading",
      title: "CloudTrail: the audit log of the control plane",
      minutes: 15,
      body: String.raw`
Every AWS API call is an authenticated, signed request, and **CloudTrail** records them: who (\`userIdentity\`), what (\`eventSource\`, \`eventName\`, \`requestParameters\`), when, from where (\`sourceIPAddress\`, \`userAgent\`), and what happened (\`responseElements\`, or \`errorCode\`). During an incident it's the closest thing AWS has to a security camera.

## Event types

| Type | Examples | Default | Cost |
|---|---|---|---|
| **Management events** | \`CreateRole\`, \`RunInstances\`, \`AuthorizeSecurityGroupIngress\`, \`DeleteQueue\`, console sign-ins | On: 90 days of **event history** per region, free | First trail copy free |
| **Data events** | \`s3:GetObject\`/\`PutObject\`, \`lambda:Invoke\`, DynamoDB item calls | Off | ~$0.10 per 100,000 events. High volume, so select precisely |
| **Insights events** | Unusual spikes in write-API call rates or error rates | Off | Per events analysed |

Management events tell you **someone changed the infrastructure**. Data events tell you **someone read the data**, and an exfiltration investigation without S3 data events for the sensitive buckets usually ends with "we can't tell". Enable data events selectively with *advanced event selectors* (for example only \`AWS::S3::Object\` in buckets tagged as sensitive), because enabling them for every bucket can cost more than the workload.

## Trails: keep it longer, keep it safe

Event history is 90 days, per region, and read-only. A **trail** delivers every event as gzipped JSON files to an **S3 bucket** (typically within about 5 minutes), and optionally to CloudWatch Logs for metric filters and alarms. What a senior engineer sets up on day one:

- An **organisation trail**, created in the management (or delegated admin) account: it covers every account and every region, and member accounts can't stop or modify it.
- Delivered to a bucket in a dedicated **log-archive account** that almost nobody can access, with **S3 Object Lock** (compliance mode) and a lifecycle policy to Glacier. An attacker who compromises a workload account can't delete the evidence.
- **Log file integrity validation** turned on: CloudTrail writes an hourly *digest file* with the SHA-256 hash of every log file, signed by CloudTrail. \`aws cloudtrail validate-logs\` proves that no file was modified or deleted, which is what makes logs admissible evidence.
- **KMS encryption** with a customer-managed key, and alarms on \`StopLogging\`, \`DeleteTrail\`, \`UpdateTrail\` and \`PutEventSelectors\`. Disabling the trail is one of the first things an attacker tries.

<figure class="diagram">
<svg viewBox="0 0 640 200" role="img" aria-label="Member accounts send events to an organisation trail, which writes to an Object Lock bucket in the log archive account and to CloudWatch Logs">
  <rect x="10" y="20" width="150" height="160" rx="10" class="d-box d-outer"/>
  <text x="85" y="42" text-anchor="middle" class="d-label">Member accounts</text>
  <rect x="25" y="55" width="120" height="30" rx="6" class="d-box"/><text x="85" y="75" text-anchor="middle" class="d-small">prod</text>
  <rect x="25" y="95" width="120" height="30" rx="6" class="d-box"/><text x="85" y="115" text-anchor="middle" class="d-small">staging</text>
  <rect x="25" y="135" width="120" height="30" rx="6" class="d-box"/><text x="85" y="155" text-anchor="middle" class="d-small">sandbox</text>
  <rect x="220" y="70" width="160" height="60" rx="8" class="d-box d-accent"/>
  <text x="300" y="96" text-anchor="middle" class="d-label">Organisation trail</text>
  <text x="300" y="114" text-anchor="middle" class="d-small">all accounts, all regions</text>
  <rect x="440" y="20" width="190" height="70" rx="8" class="d-box d-ok"/>
  <text x="535" y="44" text-anchor="middle" class="d-label">S3, log-archive account</text>
  <text x="535" y="62" text-anchor="middle" class="d-small">Object Lock + KMS</text>
  <text x="535" y="78" text-anchor="middle" class="d-small">+ hourly digest files</text>
  <rect x="440" y="120" width="190" height="60" rx="8" class="d-box"/>
  <text x="535" y="146" text-anchor="middle" class="d-label">CloudWatch Logs</text>
  <text x="535" y="164" text-anchor="middle" class="d-small">metric filters, alarms</text>
  <path d="M160 100 H218" class="d-arrow"/>
  <path d="M380 90 L438 60" class="d-arrow"/>
  <path d="M380 110 L438 148" class="d-arrow d-dashed"/>
</svg>
<figcaption>The production pattern: one trail for the whole organisation, written somewhere a compromised workload account can't reach.</figcaption>
</figure>

A trail's bucket needs a bucket policy that lets \`cloudtrail.amazonaws.com\` call \`s3:GetBucketAcl\` and \`s3:PutObject\` (under \`AWSLogs/<account>/\`). Without it, \`CreateTrail\` fails:

\`\`\`bash
aws s3api create-bucket --bucket demo-trail-logs >/dev/null
aws cloudtrail create-trail --name demo-trail --s3-bucket-name demo-trail-logs
aws s3api put-bucket-policy --bucket demo-trail-logs --policy '{"Version":"2012-10-17","Statement":[
  {"Sid":"AclCheck","Effect":"Allow","Principal":{"Service":"cloudtrail.amazonaws.com"},"Action":"s3:GetBucketAcl","Resource":"arn:aws:s3:::demo-trail-logs"},
  {"Sid":"Write","Effect":"Allow","Principal":{"Service":"cloudtrail.amazonaws.com"},"Action":"s3:PutObject",
   "Resource":"arn:aws:s3:::demo-trail-logs/AWSLogs/000000000000/*","Condition":{"StringEquals":{"s3:x-amz-acl":"bucket-owner-full-control"}}}]}'
aws cloudtrail create-trail --name demo-trail --s3-bucket-name demo-trail-logs \
  --is-multi-region-trail --enable-log-file-validation --query '{validation: LogFileValidationEnabled, multiRegion: IsMultiRegionTrail}'
aws cloudtrail start-logging --name demo-trail
aws cloudtrail get-trail-status --name demo-trail --query IsLogging
\`\`\`

## Reading an event

\`\`\`bash
aws sqs create-queue --queue-name demo-audited >/dev/null
aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=CreateQueue \
  --max-results 1 --query 'Events[0].CloudTrailEvent' --output text | jq '{userIdentity, eventName, requestParameters, errorCode}'
\`\`\`

The fields you pivot on during an investigation:

- \`userIdentity.type\` and \`.arn\`: \`IAMUser\`, \`AssumedRole\` (\`arn:aws:sts::<acct>:assumed-role/<role>/<session-name>\`), \`Root\`, \`AWSService\`. For roles, \`sessionContext.sessionIssuer\` names the role, and the **session name** is often the only clue about *who* was behind it. That's why your CI and SSO should set meaningful session names.
- \`userIdentity.accessKeyId\`: pivot on it to find everything one set of credentials did.
- \`AssumeRole\` events: \`requestParameters.roleSessionName\` plus the *caller's* \`userIdentity\` tell you who assumed what. Follow role chains backwards to a human.
- \`errorCode\`: a burst of \`AccessDenied\` from one principal is reconnaissance, someone probing what stolen credentials can do.
- \`sourceIPAddress\` and \`userAgent\`: a CI role suddenly used from a residential IP with a laptop CLI user agent is a strong signal.

## A forensics playbook

1. **Scope:** which principal, which access key, what time window? Start from the alert (GuardDuty finding, a deleted resource, a bill spike).
2. **Reconstruct:** pull everything that principal did (\`lookup-events --lookup-attributes AttributeKey=Username,…\` or \`AccessKeyId\`), and trace \`AssumeRole\` calls back to the original identity.
3. **Look for persistence:** \`CreateAccessKey\`, \`CreateUser\`, \`CreateLoginProfile\`, \`AttachUserPolicy\`/\`PutRolePolicy\`, \`UpdateAssumeRolePolicy\` (a new external trust), new Lambda functions or EventBridge rules. Attackers leave themselves a way back in.
4. **Look for defence evasion:** \`StopLogging\`, \`DeleteTrail\`, \`DeleteFlowLogs\`, GuardDuty \`DeleteDetector\`.
5. **Contain:** deactivate (don't delete) keys, revoke role sessions, and close network exposure. Preserve evidence.
6. **At scale:** query trail files in S3 with **Athena**, or use **CloudTrail Lake** (SQL over event data stores). \`lookup-events\` is limited to 2 requests per second and 90 days, so it's a starting point, not a SIEM.

> **On real AWS vs the emulator:** in this emulator version, event history records IAM, STS, EC2 and SQS calls (including the caller identity, request parameters, response elements and error codes), but not S3, DynamoDB, KMS, SNS or most other services, so "who deleted the bucket?" can't be answered here. Lookups by \`EventName\`, \`Username\`, \`EventSource\` and \`ReadOnly\` work; \`ResourceName\`/\`ResourceType\` return nothing. Trails do deliver log files to S3. On real AWS, events take up to ~5–15 minutes to appear, and EC2 wraps lists in \`items\` objects (\`requestParameters.ipPermissions.items[]\`), so write queries that tolerate both shapes.
`,
    },
    // ---------------------------------------------------------------- lab: forensics
    {
      id: "cloudtrail-forensics",
      kind: "lab",
      title: "Lab: Incident forensics with CloudTrail",
      minutes: 35,
      body: String.raw`
**03:12, Saturday.** The orders dead-letter queue \`orders-dlq\` is gone, and an external scanner reports SSH open on the \`bastion\` security group. You have CloudTrail event history and a terminal.

What you know about the account:

- \`ci-deploy\` is the pipeline's role (AdministratorAccess). The pipeline's sessions are named \`gha-run-<number>\`.
- \`contractor\` is an operations role for an external contractor: SQS and EC2 only… or so everyone thought.
- \`backup-svc\` is an IAM user that should never have access keys.

Prepare lab replays the night's activity, normal traffic included. Answer each question **from CloudTrail**, writing each answer to the named file, then contain the incident. Useful tools:

\`\`\`bash
aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=DeleteQueue \
  --query 'Events[].CloudTrailEvent' --output json | jq '.[] | fromjson | {who: .userIdentity.arn, params: .requestParameters, error: .errorCode}'
\`\`\`
`,
      lab: {
        setup: String.raw`
TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"AWS":"arn:aws:iam::000000000000:root"},"Action":"sts:AssumeRole"}]}'
for r in ci-deploy contractor; do
  aws iam get-role --role-name $r >/dev/null 2>&1 || aws iam create-role --role-name $r --assume-role-policy-document "$TRUST" >/dev/null
done
aws iam attach-role-policy --role-name ci-deploy --policy-arn arn:aws:iam::aws:policy/AdministratorAccess
# The misconfiguration: "ci-*" was meant to be a read-only helper role.
aws iam put-role-policy --role-name contractor --policy-name contractor-ops --policy-document '{"Version":"2012-10-17","Statement":[
  {"Effect":"Allow","Action":["sqs:*","ec2:*"],"Resource":"*"},
  {"Effect":"Allow","Action":"sts:AssumeRole","Resource":"arn:aws:iam::000000000000:role/ci-*"}]}'
aws iam get-user --user-name backup-svc >/dev/null 2>&1 || aws iam create-user --user-name backup-svc >/dev/null

VPC=$(aws ec2 describe-vpcs --filters Name=tag:Name,Values=incident-vpc --query 'Vpcs[0].VpcId' --output text)
if [ "$VPC" = None ]; then
  VPC=$(aws ec2 create-vpc --cidr-block 10.30.0.0/16 --tag-specifications 'ResourceType=vpc,Tags=[{Key=Name,Value=incident-vpc}]' --query Vpc.VpcId --output text)
fi
sg() {
  local id
  id=$(aws ec2 describe-security-groups --filters "Name=group-name,Values=$1" "Name=vpc-id,Values=$VPC" --query 'SecurityGroups[0].GroupId' --output text)
  [ "$id" != None ] || id=$(aws ec2 create-security-group --group-name "$1" --description "$2" --vpc-id "$VPC" --query GroupId --output text)
  echo "$id"
}
WEB_SG=$(sg web "Public web tier")
BASTION_SG=$(sg bastion "Ops bastion")

# Run a command as <role>/<session>. Calls can be nested to chain roles.
as() {
  local creds
  creds=$(aws sts assume-role --role-arn "arn:aws:iam::000000000000:role/$1" --role-session-name "$2" --query Credentials --output json) || return 1
  shift 2
  AWS_ACCESS_KEY_ID=$(echo "$creds" | jq -r .AccessKeyId) \
  AWS_SECRET_ACCESS_KEY=$(echo "$creds" | jq -r .SecretAccessKey) \
  AWS_SESSION_TOKEN=$(echo "$creds" | jq -r .SessionToken) "$@"
}
QBASE=https://sqs.us-east-1.amazonaws.com/000000000000

# --- a normal evening ---
as ci-deploy gha-run-4812 aws sqs create-queue --queue-name orders-dlq >/dev/null
as ci-deploy gha-run-4812 aws sqs create-queue --queue-name build-cache-4812 >/dev/null
as ci-deploy gha-run-4812 aws ec2 authorize-security-group-ingress --group-id "$WEB_SG" --protocol tcp --port 443 --cidr 0.0.0.0/0 >/dev/null 2>&1 || true
as contractor j.doe aws ec2 authorize-security-group-ingress --group-id "$BASTION_SG" --protocol tcp --port 22 --cidr 10.30.0.0/16 >/dev/null 2>&1 || true
as ci-deploy gha-run-4812 aws sqs delete-queue --queue-url "$QBASE/build-cache-4812" >/dev/null 2>&1 || true
as contractor j.doe aws sqs list-queues >/dev/null

# --- the night ---
as contractor j.doe aws sqs delete-queue --queue-url "$QBASE/orders-dlq" >/dev/null 2>&1 || true
as contractor j.doe aws ec2 authorize-security-group-ingress --group-id "$BASTION_SG" --protocol tcp --port 22 --cidr 0.0.0.0/0 >/dev/null 2>&1 || true
as contractor j.doe aws iam create-access-key --user-name backup-svc >/dev/null 2>&1 || true
as contractor j.doe aws iam list-attached-role-policies --role-name ci-deploy >/dev/null 2>&1 || true
as contractor j.doe as ci-deploy laptop-mk aws iam create-access-key --user-name backup-svc >/dev/null
as ci-deploy gha-run-4813 aws sqs list-queues >/dev/null
echo "Incident replayed. Start with: aws cloudtrail lookup-events --max-results 20"
`,
        tasks: [
          {
            id: "deleted-by",
            title: "Who deleted orders-dlq?",
            description:
              "Find the `DeleteQueue` call that deleted **`orders-dlq`** (another queue was deleted the same night, legitimately) and write the caller's full ARN (`userIdentity.arn`) to `deleted-by.txt`.",
            hints: [
              "`lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=DeleteQueue`, then look at `requestParameters.queueUrl`.",
              "`… --query 'Events[].CloudTrailEvent' --output json | jq -r '.[] | fromjson | select(.requestParameters.queueUrl | endswith(\"/orders-dlq\")) | .userIdentity.arn' > deleted-by.txt`",
            ],
            check: async (ctx) => {
              const a = await answer(ctx, "deleted-by.txt");
              if (a === null) return "`deleted-by.txt` not found in the lab folder.";
              const culprits = (await trail(ctx, "DeleteQueue"))
                .filter(({ e }) => String(e.requestParameters?.queueUrl ?? "").endsWith("/orders-dlq"))
                .map(({ e }) => e.userIdentity?.arn);
              if (!culprits.length) return "There's no DeleteQueue event for orders-dlq. Press Prepare lab to replay the incident.";
              if (a.endsWith("gha-run-4812")) return "That session deleted `build-cache-4812`, which is routine CI clean-up. Filter on the queue URL.";
              if (!culprits.includes(a)) return `\`${a}\` isn't the caller that deleted orders-dlq. Write the full \`userIdentity.arn\`.`;
              return true;
            },
          },
          {
            id: "ssh-event",
            title: "Which call opened SSH to the world?",
            description:
              "Find the `AuthorizeSecurityGroupIngress` call that opened **port 22 to 0.0.0.0/0** and write its **event ID** to `ssh-event-id.txt`. (Event IDs are what you cite in an incident ticket.) Several ingress rules were added that night; only one is the problem.",
            hints: [
              "`lookup-events` returns `EventId` next to `CloudTrailEvent`. Keep both: `--query 'Events[].{id: EventId, e: CloudTrailEvent}' --output json`.",
              "In jq: `.[] | select(.e | fromjson | .requestParameters | tostring | test(\"0.0.0.0/0\")) | …`, then check the port too: the web tier opened 443 to the world on purpose.",
            ],
            check: async (ctx) => {
              const a = await answer(ctx, "ssh-event-id.txt");
              if (a === null) return "`ssh-event-id.txt` not found in the lab folder.";
              const events = await trail(ctx, "AuthorizeSecurityGroupIngress");
              const bad = events.filter(({ e }) => opensSshToWorld(e)).map((x) => x.id);
              if (!bad.length) return "No event opens 22 to 0.0.0.0/0. Press Prepare lab to replay the incident.";
              if (bad.includes(a)) return true;
              if (events.some((x) => x.id === a)) return "That ingress event isn't the one that opened port 22 to 0.0.0.0/0.";
              return `\`${a}\` isn't the event ID of an AuthorizeSecurityGroupIngress call.`;
            },
          },
          {
            id: "key-creator",
            title: "Who created an access key for backup-svc?",
            description:
              "Someone created an access key for `backup-svc` (persistence: a long-lived credential an attacker can keep using). Find the **successful** `CreateAccessKey` call and write its caller's ARN to `key-created-by.txt`.",
            hints: [
              "There are two `CreateAccessKey` attempts. One failed: look at `errorCode`.",
              "`jq -r '.[] | fromjson | select(.errorCode == null and .requestParameters.userName == \"backup-svc\") | .userIdentity.arn'`",
            ],
            check: async (ctx) => {
              const a = await answer(ctx, "key-created-by.txt");
              if (a === null) return "`key-created-by.txt` not found in the lab folder.";
              const all = await trail(ctx, "CreateAccessKey");
              const ok = all.filter(({ e }) => !e.errorCode).map(({ e }) => e.userIdentity?.arn);
              const failed = all.filter(({ e }) => e.errorCode).map(({ e }) => e.userIdentity?.arn);
              if (!ok.length) return "No successful CreateAccessKey event. Press Prepare lab to replay the incident.";
              if (ok.includes(a)) return true;
              if (failed.includes(a)) return "That principal *tried* and got AccessDenied. Who succeeded afterwards?";
              return `\`${a}\` didn't create the key.`;
            },
          },
          {
            id: "pivot",
            title: "Who was really behind that session?",
            description: String.raw`The key was created by a \`ci-deploy\` session, but its name isn't a pipeline run. Follow the role chain back: find the \`AssumeRole\` call that started that session, and write **the ARN of the principal that made it** to \`real-actor.txt\`.`,
            hints: [
              "`AssumeRole` events have `requestParameters.roleSessionName` (the session that was created) and `userIdentity` (who asked for it).",
              "`lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=AssumeRole …| jq -r '.[] | fromjson | select(.requestParameters.roleSessionName == \"laptop-mk\") | .userIdentity.arn'`",
            ],
            check: async (ctx) => {
              const a = await answer(ctx, "real-actor.txt");
              if (a === null) return "`real-actor.txt` not found in the lab folder.";
              const keyCallers = (await trail(ctx, "CreateAccessKey")).filter(({ e }) => !e.errorCode).map(({ e }) => String(e.userIdentity?.arn ?? ""));
              const sessions = new Set(keyCallers.map((arn) => arn.split("/").pop()));
              const assumers = (await trail(ctx, "AssumeRole"))
                .filter(({ e }) => sessions.has(e.requestParameters?.roleSessionName) && String(e.requestParameters?.roleArn ?? "").endsWith("role/ci-deploy"))
                .map(({ e }) => e.userIdentity?.arn);
              if (!assumers.length) return "No AssumeRole event created that session. Press Prepare lab to replay the incident.";
              if (keyCallers.includes(a)) return "That's the session itself. Who called AssumeRole to create it?";
              if (!assumers.includes(a)) return `\`${a}\` didn't assume ci-deploy as that session.`;
              return true;
            },
          },
          {
            id: "disable-key",
            title: "Contain: disable the key, keep the evidence",
            description:
              "Make every access key of `backup-svc` **Inactive**. Don't delete them: an inactive key still identifies the credential in later CloudTrail events and in any findings, and you can't undo a deletion.",
            hints: [
              "`aws iam list-access-keys --user-name backup-svc`",
              "`aws iam update-access-key --user-name backup-svc --access-key-id <id> --status Inactive`",
            ],
            check: async ({ tryAws }) => {
              const r = await tryAws(["iam", "list-access-keys", "--user-name", "backup-svc"]);
              if (!r.ok) return "User `backup-svc` doesn't exist. Press Prepare lab.";
              const keys = r.data.AccessKeyMetadata ?? [];
              if (!keys.length) return "`backup-svc` has no keys left. Deleting destroys evidence; next time deactivate. (Prepare lab replays the incident.)";
              const active = keys.filter((k: any) => k.Status !== "Inactive");
              if (active.length) return `${active.length} key(s) still Active: ${active.map((k: any) => k.AccessKeyId).join(", ")}.`;
              return true;
            },
          },
          {
            id: "close-ssh",
            title: "Contain: close SSH to the world",
            description:
              "Remove the rule that allows port 22 from `0.0.0.0/0` on the `bastion` security group. **Keep** the legitimate rule that allows port 22 from the VPC (`10.30.0.0/16`).",
            hints: [
              "`aws ec2 describe-security-groups --filters Name=group-name,Values=bastion --query 'SecurityGroups[0].{id: GroupId, rules: IpPermissions}'`",
              "`aws ec2 revoke-security-group-ingress --group-id <sg> --protocol tcp --port 22 --cidr 0.0.0.0/0`",
            ],
            check: async ({ tryAws }) => {
              const r = await tryAws(["ec2", "describe-security-groups", "--filters", "Name=group-name,Values=bastion"]);
              const g = r.data?.SecurityGroups?.[0];
              if (!g) return "The `bastion` security group is missing. Press Prepare lab.";
              const ssh = (g.IpPermissions ?? []).filter((p: any) => p.FromPort <= 22 && p.ToPort >= 22);
              const cidrs = ssh.flatMap((p: any) => (p.IpRanges ?? []).map((x: any) => x.CidrIp));
              if (cidrs.includes("0.0.0.0/0")) return "Port 22 is still open to 0.0.0.0/0 on `bastion`.";
              if (!cidrs.includes("10.30.0.0/16")) return "The legitimate 10.30.0.0/16 SSH rule is gone too. Only revoke the 0.0.0.0/0 rule (re-add it with authorize-security-group-ingress).";
              return true;
            },
          },
          {
            id: "revoke-sessions",
            title: "Contain: revoke the roles' active sessions",
            description: String.raw`Temporary credentials stay valid until they expire, even after you fix a policy. Revoke all **existing** sessions of both \`contractor\` and \`ci-deploy\`: add an inline policy to each role that **denies everything** (\`Action: *\`, \`Resource: *\`) for tokens issued before now, using a \`DateLessThan\` condition on \`aws:TokenIssueTime\`.

This is exactly what the console's *Revoke active sessions* button does (it names the policy \`AWSRevokeOlderSessions\`). New sessions, such as the next pipeline run, keep working.`,
            hints: [
              "`NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)`",
              "Statement: `{\"Effect\":\"Deny\",\"Action\":\"*\",\"Resource\":\"*\",\"Condition\":{\"DateLessThan\":{\"aws:TokenIssueTime\":\"<NOW>\"}}}`",
              "`aws iam put-role-policy --role-name contractor --policy-name AWSRevokeOlderSessions --policy-document \"$DOC\"`, and the same for `ci-deploy`.",
            ],
            check: async ({ tryAws }) => {
              for (const role of ["contractor", "ci-deploy"]) {
                const names = await tryAws(["iam", "list-role-policies", "--role-name", role]);
                if (!names.ok) return `Role \`${role}\` is missing. Press Prepare lab.`;
                let revoked = false;
                for (const name of names.data.PolicyNames ?? []) {
                  const p = await tryAws(["iam", "get-role-policy", "--role-name", role, "--policy-name", name]);
                  const doc = typeof p.data?.PolicyDocument === "string" ? JSON.parse(decodeURIComponent(p.data.PolicyDocument)) : p.data?.PolicyDocument;
                  revoked ||= list(doc?.Statement).some(
                    (s: any) =>
                      s.Effect === "Deny" &&
                      list(s.Action).includes("*") &&
                      list(s.Resource).includes("*") &&
                      s.Condition?.DateLessThan?.["aws:TokenIssueTime"],
                  );
                }
                if (!revoked) return `\`${role}\` has no inline policy that denies * for tokens issued before a cut-off (DateLessThan aws:TokenIssueTime).`;
              }
              return true;
            },
          },
        ],
        solution: String.raw`
events() {
  aws cloudtrail lookup-events --lookup-attributes "AttributeKey=EventName,AttributeValue=$1" \
    --query 'Events[].{id: EventId, e: CloudTrailEvent}' --output json
}

events DeleteQueue | jq -r '.[] | .e | fromjson
  | select(.requestParameters.queueUrl | endswith("/orders-dlq")) | .userIdentity.arn' | head -n 1 > deleted-by.txt

# Tolerate both list shapes (real AWS wraps EC2 lists in {items: [...]}).
events AuthorizeSecurityGroupIngress | jq -r 'def items: if type == "object" then (.items // []) else (. // []) end;
  .[] | select(.e | fromjson | .requestParameters.ipPermissions | items
    | any(.[]; ((.fromPort | tonumber) <= 22) and ((.toPort | tonumber) >= 22)
               and (.ipRanges | items | any(.[]; .cidrIp == "0.0.0.0/0"))))
  | .id' | head -n 1 > ssh-event-id.txt

events CreateAccessKey | jq -r '.[] | .e | fromjson
  | select(.errorCode == null and .requestParameters.userName == "backup-svc") | .userIdentity.arn' | head -n 1 > key-created-by.txt

SESSION=$(awk -F/ '{print $NF}' key-created-by.txt)
events AssumeRole | jq -r --arg s "$SESSION" '.[] | .e | fromjson
  | select(.requestParameters.roleSessionName == $s) | .userIdentity.arn' | head -n 1 > real-actor.txt

for f in deleted-by ssh-event-id key-created-by real-actor; do echo "$f: $(cat $f.txt)"; done

for k in $(aws iam list-access-keys --user-name backup-svc --query 'AccessKeyMetadata[].AccessKeyId' --output text); do
  aws iam update-access-key --user-name backup-svc --access-key-id "$k" --status Inactive
done

SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=bastion --query 'SecurityGroups[0].GroupId' --output text)
aws ec2 revoke-security-group-ingress --group-id "$SG" --protocol tcp --port 22 --cidr 0.0.0.0/0 >/dev/null

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
DOC=$(jq -nc --arg t "$NOW" '{Version: "2012-10-17", Statement: [{Effect: "Deny", Action: "*", Resource: "*",
  Condition: {DateLessThan: {"aws:TokenIssueTime": $t}}}]}')
for r in contractor ci-deploy; do
  aws iam put-role-policy --role-name "$r" --policy-name AWSRevokeOlderSessions --policy-document "$DOC"
done
`,
      },
    },
    // ---------------------------------------------------------------- tracing, dashboards, SLOs
    {
      id: "tracing-slos",
      kind: "reading",
      title: "Tracing, dashboards and SLO-based alerting",
      minutes: 16,
      body: String.raw`
Metrics tell you **that** something is wrong, logs tell you **what** happened in one component, and traces tell you **where** the time went across components. With microservices, queues and Lambda in the path, you need all three.

## Distributed tracing: X-Ray and OpenTelemetry

A **trace** is one request's journey, identified by a trace ID that is propagated in a header (\`X-Amzn-Trace-Id\` for X-Ray, \`traceparent\` for W3C/OpenTelemetry) through every hop. Each service records a **segment** (its part of the work) with **subsegments** for downstream calls: a DynamoDB query, an HTTP call, a SQL statement.

- **Annotations** are indexed key-values you can filter on (\`customer_tier = "gold"\`). **Metadata** is unindexed detail. Keep annotations low-cardinality.
- **Sampling** keeps cost bounded. X-Ray's default rule records the first request each second plus 5% of the rest. Trace every *error* if your tooling allows it (tail-based sampling in the OpenTelemetry Collector), because the 95% of successful requests you dropped are the least interesting ones.
- The **service map** (built from traces) shows each dependency's latency and error rate, which is often the fastest way to see "the payment provider is slow, not us".

**OpenTelemetry (OTel)** is the vendor-neutral standard for traces, metrics and logs. Instrument with the OTel SDKs, run the **AWS Distro for OpenTelemetry (ADOT)** collector (as a sidecar, DaemonSet or Lambda layer), and send to X-Ray/CloudWatch, or to any other backend, without re-instrumenting. For new services, instrument with OTel rather than the X-Ray SDK. **CloudWatch Application Signals** builds on this to give per-service latency, error and availability dashboards, and SLOs, out of the box.

Segments are plain JSON, so you can send one by hand:

\`\`\`bash
NOW=$(date +%s)
TRACE="1-$(printf '%x' $NOW)-$(openssl rand -hex 12)"
aws xray put-trace-segments --trace-segment-documents "$(jq -nc --arg t "$TRACE" --argjson s $NOW \
  '{trace_id: $t, id: "a1b2c3d4e5f60718", name: "checkout", start_time: $s, end_time: ($s + 0.42),
    http: {request: {method: "POST", url: "/pay"}, response: {status: 502}}, fault: true,
    annotations: {route: "/pay"}}')"
aws xray get-trace-summaries --start-time $(( NOW - 60 )) --end-time $(( NOW + 60 )) \
  --query 'TraceSummaries[].{id: Id, fault: HasFault, seconds: Duration}'
\`\`\`

## Dashboards

A dashboard should answer **"is this service healthy, and if not, where?"** in five seconds. Structure it top-down:

1. **User-facing SLIs**: request rate, error rate, p99 latency, compared with the SLO.
2. **Saturation**: CPU and memory, queue depth and age of oldest message, DB connections, concurrency against limits.
3. **Dependencies**: downstream latency and errors.
4. **Deploy markers** and alarm states, so cause and effect line up.

Keep dashboards in code (\`put-dashboard\` with a JSON body from CloudFormation or Terraform), with one per service and one per business flow, rather than a single wall of 80 graphs:

\`\`\`bash
aws cloudwatch put-dashboard --dashboard-name demo-checkout --dashboard-body '{"widgets": [
  {"type": "metric", "x": 0, "y": 0, "width": 12, "height": 6, "properties": {
    "title": "Checkout p99 latency (ms)", "region": "us-east-1", "stat": "p99", "period": 60,
    "metrics": [["Demo/Checkout", "Latency", "Service", "api"]]}},
  {"type": "alarm", "x": 12, "y": 0, "width": 12, "height": 6, "properties": {
    "title": "Alarms", "alarms": ["arn:aws:cloudwatch:us-east-1:000000000000:alarm:demo-latency-p99"]}}]}'
aws cloudwatch list-dashboards --query 'DashboardEntries[].DashboardName'
\`\`\`

## Golden signals, and symptoms vs causes

Google's SRE book names four **golden signals** for any user-facing system: **latency**, **traffic**, **errors**, and **saturation**. RED (Rate, Errors, Duration) is the same idea for request-driven services; USE (Utilisation, Saturation, Errors) for resources.

**Page on symptoms, not causes.** Users feel "checkout is failing" (a symptom). They don't feel "CPU is 85%" (a possible cause). A cause-based page fires when nothing is wrong (CPU is high because a batch job is efficiently using the box) and stays silent when something is (a bad config returns 500s at 10% CPU).

| Alert on | As | Why |
|---|---|---|
| Error rate and latency against the SLO, at the load balancer or API | **Page** | Directly measures user pain |
| Age of the oldest message in a work queue | **Page** | Symptom of a stuck consumer, whatever the cause |
| CPU, memory, disk, a single host down | Ticket or dashboard | Causes; actionable during working hours, if at all |
| Anything nobody acts on | Delete it | Alert fatigue makes people ignore the real page |

Every page needs an **owner**, a **runbook link** in the alarm description, and must be **actionable now**.

## SLIs, SLOs and error budgets

- An **SLI** (service level indicator) is a measured ratio of good events to all events: "the proportion of checkout requests that succeed in under 500 ms".
- An **SLO** (objective) is the target for that SLI over a window: 99.9% over 30 days.
- The **error budget** is what's left: 0.1% of requests, or **43.2 minutes** of full outage in 30 days. While budget remains, ship fast; when it's spent, prioritise reliability work. It turns "reliability vs features" into a number both sides agreed on.

**Alert on burn rate, not on the instantaneous error rate.** Burn rate is how fast you're spending the budget: a burn rate of 1 spends exactly the budget over the window; 14.4 spends 2% of a 30-day budget in one hour. The multi-window pattern from the SRE workbook:

| Severity | Burn rate | Long window | Short window | Budget consumed |
|---|---|---|---|---|
| Page | 14.4× | 1 hour | 5 minutes | 2% |
| Page | 6× | 6 hours | 30 minutes | 5% |
| Ticket | 1× | 3 days | 6 hours | 10% |

The short window makes the alert reset quickly once the problem is fixed. In CloudWatch, implement each row as a metric-math alarm on the error ratio (errors ÷ requests ÷ (1 − SLO)), and combine the long and short windows with a composite alarm (\`AND\`). Application Signals can create SLOs and burn-rate alarms for you.

## A senior engineer's checklist

- Every log group has retention; every service logs structured JSON with a request or trace ID.
- Metrics have low-cardinality dimensions; high-cardinality context lives in logs (EMF) and traces.
- User-facing SLOs exist, with burn-rate pages; cause metrics are dashboards and tickets.
- Every alarm has an OK action, an owner and a runbook link, and its wiring has been tested with \`set-alarm-state\`.
- An organisation CloudTrail trail goes to a locked log-archive account, with integrity validation, and alarms fire if it is stopped.
- Traces propagate across every hop (including queues: put the trace context in message attributes).

> **On real AWS vs the emulator:** X-Ray segments, trace summaries and the service graph, plus dashboards, work here. Application Signals, CloudWatch SLOs and Synthetics canaries are real-AWS features to explore in a sandbox account.
`,
    },
  ],
  quiz: [
    {
      q: "A metric-filter-based alarm on `ErrorCount` (Sum, 1 of 1, threshold ≥ 1) sits in INSUFFICIENT_DATA most of the day and occasionally fires. The team wants it OK when no errors are logged. What should they change?",
      options: [
        "Set the metric filter's defaultValue to 1",
        "Set treat-missing-data to notBreaching, because no datapoint means no errors were logged",
        "Set treat-missing-data to breaching",
        "Switch the statistic to Average",
      ],
      answer: 1,
      explain:
        "Metric filters only emit a datapoint when matching events arrive, so for an error counter, missing means \"no errors\". `notBreaching` makes the alarm OK in quiet periods. `breaching` would page constantly. It's the right choice for a heartbeat metric, where silence *is* the failure.",
    },
    {
      q: "Average latency for an API is a steady 120 ms, but customers complain about slow checkouts. Which statistic should the latency alarm and dashboard use?",
      options: ["Average", "Sum", "p99 (or p95)", "SampleCount"],
      answer: 2,
      explain:
        "Averages hide the tail: 5% of requests at 900 ms barely move the mean. Percentiles show what the slowest users experience. For CloudWatch to compute them, publish raw values (or EMF) rather than pre-aggregated statistic sets.",
    },
    {
      q: "A developer adds `customerId` as a dimension on the custom metric `OrdersPlaced` (2 million customers). What's the main consequence?",
      options: [
        "Nothing: dimensions are free",
        "Each customerId value creates a separate custom metric, billed individually: potentially millions of metrics",
        "CloudWatch rejects dimensions with more than 100 values",
        "The metric becomes high-resolution",
      ],
      answer: 1,
      explain:
        "A metric is the unique combination of namespace, name and dimension values. High-cardinality identifiers belong in logs (for example EMF properties that aren't dimensions) or traces, where you can still find them without paying per value.",
    },
    {
      q: "During an investigation you find `s3:DeleteBucket` for a production bucket in CloudTrail, but nothing about who *read* objects from it in the days before. Why?",
      options: [
        "CloudTrail doesn't support S3",
        "Object-level reads (GetObject) are data events, which are off by default and must be enabled on a trail with event selectors",
        "Event history only keeps 24 hours",
        "Read-only events are never logged",
      ],
      answer: 1,
      explain:
        "Bucket-level calls such as DeleteBucket are management events, recorded by default. Object reads and writes are **data events**: you must opt in per trail, ideally with advanced event selectors scoped to sensitive buckets to control cost. Decide this before the incident, not during it.",
    },
    {
      q: "CloudTrail shows `iam:CreateAccessKey` for user `backup-svc`, made by `arn:aws:sts::111122223333:assumed-role/ci-deploy/laptop-mk`. Your pipeline names its sessions `gha-run-<n>`. What's the most useful next query?",
      options: [
        "Delete the ci-deploy role immediately",
        "Find the AssumeRole event whose requestParameters.roleSessionName is laptop-mk, and look at its userIdentity to see who created the session",
        "Search for GetObject events on the CloudTrail bucket",
        "Look up events by ResourceType AWS::IAM::User",
      ],
      answer: 1,
      explain:
        "An assumed-role ARN tells you the role and the session name, not the human. The AssumeRole call that created the session records the caller, so you can follow the chain back. Then contain: deactivate the key and revoke the role's older sessions, while keeping the evidence.",
    },
    {
      q: "Your service's SLO is 99.9% of requests successful over 30 days. Which alerting approach best balances fast detection against false pages?",
      options: [
        "Page whenever any 5xx occurs",
        "Page when CPU exceeds 80% for 5 minutes",
        "Page on a high error-budget burn rate (e.g. 14.4× over 1 hour AND over 5 minutes), and open a ticket for slow burns",
        "Page once the monthly error budget is fully spent",
      ],
      answer: 2,
      explain:
        "Multi-window burn-rate alerts page quickly for fast, severe budget consumption, reset quickly once fixed (the short window), and route slow burns to tickets. Paging on every 5xx is noise; CPU is a cause, not a symptom; and waiting until the budget is gone is too late.",
    },
    {
      q: "An attacker's assumed-role credentials are still working after you removed the policy that let them assume the role. Why, and what's the fix?",
      options: [
        "IAM changes take 24 hours to propagate; wait",
        "STS session credentials remain valid until they expire; add a Deny-all policy with a DateLessThan aws:TokenIssueTime condition (\"revoke active sessions\")",
        "Delete the CloudTrail trail so the session is forgotten",
        "Rotate the role's access keys",
      ],
      answer: 1,
      explain:
        "Removing the trust or permission stops *new* sessions, but existing temporary credentials are valid for their lifetime (up to 12 hours). Denying everything for tokens issued before now kills them immediately, while new legitimate sessions keep working. Roles have no access keys to rotate.",
    },
  ],
};
