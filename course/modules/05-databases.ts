import type { CheckContext, Module } from "../types.ts";

// ---------------------------------------------------------------- helpers

const TABLE = "orders";

const S = (item: any, k: string): string | undefined => item?.[k]?.S;
const N = (item: any, k: string): number | undefined => (item?.[k]?.N === undefined ? undefined : Number(item[k].N));

async function getOrder(ctx: CheckContext, customer: string, orderId: string): Promise<any | null> {
  const r = await ctx.tryAws([
    "dynamodb", "get-item", "--table-name", TABLE, "--consistent-read",
    "--key", JSON.stringify({ pk: { S: `CUSTOMER#${customer}` }, sk: { S: `ORDER#${orderId}` } }),
  ]);
  return r.ok ? (r.data?.Item ?? null) : null;
}

async function keyArn(ctx: CheckContext, ref: string | undefined | null): Promise<string | null> {
  if (!ref) return null;
  const r = await ctx.tryAws(["kms", "describe-key", "--key-id", ref]);
  return r.ok ? r.data.KeyMetadata.Arn : null;
}

async function dbInstance(ctx: CheckContext, id: string): Promise<any | string> {
  const r = await ctx.tryAws(["rds", "describe-db-instances", "--db-instance-identifier", id]);
  if (!r.ok) return `DB instance \`${id}\` doesn't exist yet.`;
  return r.data.DBInstances[0];
}

async function subnetIdByName(ctx: CheckContext, name: string): Promise<string | null> {
  const r = await ctx.tryAws(["ec2", "describe-subnets", "--filters", `Name=tag:Name,Values=${name}`]);
  return r.ok ? (r.data.Subnets?.[0]?.SubnetId ?? null) : null;
}

// ---------------------------------------------------------------- module

export const databases: Module = {
  id: "databases",
  number: "05",
  title: "Databases: DynamoDB & RDS",
  summary:
    "Design DynamoDB tables from access patterns and keep them correct under concurrency, and run RDS the way production needs it: Multi-AZ, encrypted, backed up, in private subnets, with safe change management.",
  services: ["DynamoDB", "DynamoDB Streams", "RDS", "Aurora", "KMS", "Secrets Manager"],
  lessons: [
    // ------------------------------------------------------------ reading 1
    {
      id: "dynamodb-internals",
      kind: "reading",
      title: "How DynamoDB works: keys, partitions, capacity",
      minutes: 15,
      body: String.raw`
DynamoDB is a key-value and document database that gives **single-digit-millisecond latency at any scale**, with no servers, no connection pools, no vacuuming and no version upgrades. The price is that you must design around how it stores data. A DynamoDB table designed like a relational table works fine in a demo and falls over, or becomes very expensive, in production.

## Tables, items, keys

A **table** holds **items** (rows) of up to **400 KB** each. Items are schemaless apart from the **primary key**, which takes one of two forms:

- **Simple**: a **partition key** only (\`userId\`). Every item has a unique partition key value.
- **Composite**: a **partition key** plus a **sort key** (\`customerId\` + \`orderDate\`). Items sharing a partition key form an **item collection**, stored together and sorted by the sort key.

The only efficient ways to read are **by exact partition key**, optionally narrowed by a **sort key condition** (\`=\`, \`<\`, \`between\`, \`begins_with\`). There are no joins, and no ad-hoc \`WHERE\` on arbitrary attributes, at least not cheaply.

## Partitions: where your data physically lives

<figure class="diagram">
<svg viewBox="0 0 640 230" role="img" aria-label="DynamoDB hashes the partition key to choose a partition; each partition has throughput and size limits">
  <rect x="10" y="80" width="140" height="70" rx="8" class="d-box"/><text x="80" y="108" text-anchor="middle" class="d-label">PutItem</text><text x="80" y="128" text-anchor="middle" class="d-small">pk = CUSTOMER#42</text>
  <rect x="190" y="80" width="110" height="70" rx="8" class="d-box d-accent"/><text x="245" y="108" text-anchor="middle" class="d-label">hash(pk)</text><text x="245" y="128" text-anchor="middle" class="d-small">request router</text>
  <rect x="350" y="14" width="280" height="56" rx="8" class="d-box"/><text x="366" y="36" class="d-label">Partition A</text><text x="366" y="56" class="d-small">≤10 GB · ≤3,000 RCU · ≤1,000 WCU</text>
  <rect x="350" y="86" width="280" height="56" rx="8" class="d-box d-danger"/><text x="366" y="108" class="d-label">Partition B (hot)</text><text x="366" y="128" class="d-small">CUSTOMER#42 lives here, plus others</text>
  <rect x="350" y="158" width="280" height="56" rx="8" class="d-box"/><text x="366" y="180" class="d-label">Partition C</text><text x="366" y="200" class="d-small">each copied to 3 AZs</text>
  <path d="M150 115 H188" class="d-arrow"/><path d="M300 115 H348" class="d-arrow"/>
  <path d="M300 105 C325 105 325 42 348 42" class="d-arrow d-dashed"/><path d="M300 125 C325 125 325 186 348 186" class="d-arrow d-dashed"/>
</svg>
<figcaption>The partition key's hash picks the partition. Total table throughput is the sum of the partitions, but any one key can only use what its partition gives it.</figcaption>
</figure>

DynamoDB hashes the partition key to place each item on a **partition**: a slice of storage replicated across three AZs. Each partition holds up to about **10 GB** and serves up to **3,000 read capacity units and 1,000 write capacity units per second**. DynamoDB splits partitions as data or traffic grows, and **adaptive capacity** shifts throughput toward busy partitions, even isolating a single hot item onto its own partition.

What it can't do is make *one partition key value* faster than one partition. That's the **hot key problem**:

- A \`status\` attribute as the partition key (\`PENDING\`, \`SHIPPED\`), where every new order writes to \`PENDING\`.
- A date as the partition key for time-series data: all of today's writes go to one key.
- A global counter item that every request increments.
- A celebrity user whose item collection gets 100 times the traffic of anyone else's.

The fixes are **high-cardinality partition keys** (user ID, order ID, device ID) and, when you truly need to aggregate, **write sharding**: append a suffix (\`STATUS#PENDING#0\` … \`#9\`), write to a random shard, and read all ten in parallel. Caching (DAX or ElastiCache) helps with hot *reads*, but not hot writes.

## Capacity units

Throughput is measured in capacity units, and they decide your bill:

| Operation | Cost |
|---|---|
| Strongly consistent read | 1 RCU per **4 KB** read (rounded up) |
| Eventually consistent read (the default) | **0.5** RCU per 4 KB |
| Transactional read | 2 RCU per 4 KB |
| Standard write | 1 WCU per **1 KB** written (rounded up) |
| Transactional write | 2 WCU per 1 KB |

Item size dominates. Writing a 3.1 KB item costs 4 WCU, every time, even if you changed one attribute, because DynamoDB rewrites the whole item. Updating a GSI'd attribute costs additional writes on each affected index. Ask for the numbers:

\`\`\`bash
aws dynamodb create-table --table-name DemoCapacity \
  --attribute-definitions AttributeName=id,AttributeType=S --key-schema AttributeName=id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST --query TableDescription.TableStatus
aws dynamodb wait table-exists --table-name DemoCapacity
BLOB=$(head -c 3000 /dev/zero | tr '\0' x)
aws dynamodb put-item --table-name DemoCapacity --item "{\"id\":{\"S\":\"a\"},\"blob\":{\"S\":\"$BLOB\"}}" \
  --return-consumed-capacity TOTAL --query ConsumedCapacity
aws dynamodb get-item --table-name DemoCapacity --key '{"id":{"S":"a"}}' --return-consumed-capacity TOTAL --query ConsumedCapacity.CapacityUnits
aws dynamodb get-item --table-name DemoCapacity --key '{"id":{"S":"a"}}' --consistent-read --return-consumed-capacity TOTAL --query ConsumedCapacity.CapacityUnits
\`\`\`

A 3 KB write costs 3 WCU. The eventually consistent read costs 0.5 RCU and the strongly consistent read costs 1.

## On-demand vs provisioned

| | **On-demand** (\`PAY_PER_REQUEST\`) | **Provisioned** (+ auto scaling) |
|---|---|---|
| You pay for | Each request | Capacity per hour, used or not |
| Scaling | Instant, up to double the previous peak, then keeps adapting | Auto scaling reacts in minutes to CloudWatch metrics |
| Throttling | Rare: sudden spikes far above history, or a hot partition | When traffic exceeds provisioned capacity before scaling catches up |
| Best for | New, spiky or unpredictable workloads; most dev and staging tables | Steady, predictable, high-volume traffic (often much cheaper per request) |

On-demand is the right default. Its per-request price was cut substantially in late 2024, so the crossover point where provisioned saves money is now at high, steady utilisation. Two production controls to know: **maximum on-demand throughput**, which caps a table's request rate so a runaway job can't produce an unbounded bill, and **warm throughput**, which pre-warms a table before a known event such as a launch or a sale. You can switch billing modes, but only a limited number of times in 24 hours.

## Throttling

When a request exceeds what the table or a partition can serve, DynamoDB returns \`ProvisionedThroughputExceededException\` or \`ThrottlingException\` (HTTP 400). The SDKs retry with backoff, so the first symptom is usually **latency**, and only later errors. Monitor \`ThrottledRequests\` and the per-reason throttle metrics, and enable **CloudWatch Contributor Insights** to see *which keys* are hot. A GSI that can't keep up throttles writes to the **base table**: an under-provisioned index is a production outage, not just a slow query.

> **Emulator note:** capacity accounting (\`ConsumedCapacity\`) matches AWS, but the emulator doesn't throttle, even a provisioned table at 1 WCU. Use load tests in a real account for capacity planning.

## What a senior engineer does

- Starts from **access patterns** (next lesson) and picks a high-cardinality partition key.
- Keeps items small: large blobs go to S3, with a pointer in DynamoDB.
- Defaults to on-demand with a maximum throughput cap. Switches to provisioned with auto scaling when traffic is steady and the bill justifies it.
- Alarms on throttles and system errors, and uses Contributor Insights before guessing at hot keys.
- Turns on **deletion protection** and **point-in-time recovery** for every production table (lesson three).
`,
    },

    // ------------------------------------------------------------ reading 2
    {
      id: "access-patterns",
      kind: "reading",
      title: "Designing for access patterns: keys, indexes, Query vs Scan",
      minutes: 15,
      body: String.raw`
In a relational database you model the *data*, normalise it, and write whatever queries you need later. The query planner works out how. DynamoDB has no query planner. **You model the queries**, and the table is shaped so each one is a single, cheap key lookup.

## Start from the access patterns

Before writing a key schema, list every way the application reads and writes data, with rough volumes. For an orders service:

| # | Access pattern | Volume |
|---|---|---|
| 1 | Get one order for a customer | high |
| 2 | List a customer's orders, newest first | high |
| 3 | List orders in a status (e.g. \`PENDING\`), oldest first, for the fulfilment worker | medium |
| 4 | Create an order exactly once, even if the client retries | high |
| 5 | Update an order's status without losing concurrent updates | medium |

Then design keys so each pattern is a \`GetItem\` or a \`Query\`:

| Item | \`pk\` | \`sk\` | \`gsi1pk\` | \`gsi1sk\` |
|---|---|---|---|---|
| Order | \`CUSTOMER#c-42\` | \`ORDER#o-1001\` | \`STATUS#PENDING\` | \`2026-11-01T09:00:00Z\` |
| Customer profile | \`CUSTOMER#c-42\` | \`PROFILE\` | | |
| Idempotency record | \`IDEMPOTENCY#req-7f3a\` | \`IDEMPOTENCY#req-7f3a\` | | |

- Pattern 1 is \`GetItem(pk, sk)\`. Pattern 2 is \`Query pk = CUSTOMER#c-42 AND begins_with(sk, ORDER#)\`, newest first with \`ScanIndexForward=false\`. Order IDs here are time-sortable (like ULIDs), so sorting by ID sorts by time.
- Pattern 3 needs a different partition key, so it uses a **global secondary index** keyed on \`gsi1pk\`/\`gsi1sk\`.
- Patterns 4 and 5 are conditional writes, covered in the next lesson.

## Single-table design

The table above stores several **entity types in one table**, with generic key names (\`pk\`, \`sk\`, \`gsi1pk\`) and prefixed values (\`CUSTOMER#\`, \`ORDER#\`). This is **single-table design**. The benefit is that related items share a partition key, so one \`Query\` returns the customer's profile *and* their orders, with no join. Generic GSI names let one index serve several patterns ("overloading").

It isn't mandatory. Single-table design pays off when entities are read together and the access patterns are stable. It costs readability, ad-hoc analytics (export to S3 and use Athena for that), and flexibility when access patterns change. Many teams use **one table per bounded context or microservice**, single-table inside it. Either way, the rule is the same: *never* design a DynamoDB table without the access pattern list.

## Secondary indexes: GSI vs LSI

| | **Global secondary index (GSI)** | **Local secondary index (LSI)** |
|---|---|---|
| Keys | Any partition key and sort key | Same partition key, different sort key |
| When | Add or remove any time | **Only at table creation**, never later |
| Consistency | **Eventually consistent only** | Strongly consistent reads available |
| Capacity | Its own (provisioned separately, or on-demand) | Shares the table's |
| Size limit | None | Item collection (all items with one pk) capped at **10 GB** |
| Limit per table | 20 (default) | 5 |

**Prefer GSIs.** LSIs are rarely worth their creation-time commitment and the 10 GB collection cap, which turns a growing customer into a write failure.

GSIs are **asynchronously** maintained copies. After a write to the base table, a query on the GSI may briefly not see it, typically for milliseconds and occasionally longer. Asking for a consistent read on a GSI is an error:

\`\`\`bash
aws dynamodb create-table --table-name DemoOrders \
  --attribute-definitions AttributeName=pk,AttributeType=S AttributeName=sk,AttributeType=S \
    AttributeName=gsi1pk,AttributeType=S AttributeName=gsi1sk,AttributeType=S \
  --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE \
  --global-secondary-indexes 'IndexName=gsi1,KeySchema=[{AttributeName=gsi1pk,KeyType=HASH},{AttributeName=gsi1sk,KeyType=RANGE}],Projection={ProjectionType=ALL}' \
  --billing-mode PAY_PER_REQUEST --query TableDescription.TableStatus
aws dynamodb wait table-exists --table-name DemoOrders
for i in 1 2 3; do
  aws dynamodb put-item --table-name DemoOrders --item "{\"pk\":{\"S\":\"CUSTOMER#c-1\"},\"sk\":{\"S\":\"ORDER#o-00$i\"},\"gsi1pk\":{\"S\":\"STATUS#PENDING\"},\"gsi1sk\":{\"S\":\"2026-11-0$i\"}}"
done
aws dynamodb query --table-name DemoOrders --index-name gsi1 --key-condition-expression 'gsi1pk = :s' \
  --expression-attribute-values '{":s":{"S":"STATUS#PENDING"}}' --consistent-read
\`\`\`

\`ValidationException: Consistent reads are not supported on global secondary indexes\`. Design so that's acceptable: a worker polling for pending orders doesn't care about a few milliseconds of lag, but "read my own write" flows must read the base table.

Other index facts worth knowing:

- **Sparse indexes.** Items that lack the GSI key attributes don't appear in the index at all. Remove \`gsi1pk\` when an order is delivered and the "open orders" index only ever contains open orders: small, cheap, fast. The idempotency records above don't appear in \`gsi1\` for the same reason.
- **Projections.** \`KEYS_ONLY\`, \`INCLUDE\` (named attributes) or \`ALL\`. Narrow projections cost less storage and fewer index writes, but a query needing an unprojected attribute must fetch the item from the base table.
- **Write amplification.** Every write that touches an indexed attribute writes to the index too. Changing \`gsi1pk\` is a delete *and* a put in the index.
- **Hot index keys.** The \`STATUS#PENDING\` partition key is low-cardinality. Fine for thousands of pending orders, a hot partition at tens of thousands of writes per second. At that scale, shard it (\`STATUS#PENDING#3\`).

## Query vs Scan

- **Query** reads one item collection (one partition key), optionally narrowed by the sort key. Cost is proportional to the data *returned*.
- **Scan** reads **every item in the table** (or index), 1 MB per page. Cost is proportional to the *table size*. A **filter expression** removes items *after* they're read and billed: it saves bandwidth, not capacity.

\`\`\`bash
aws dynamodb query --table-name DemoOrders --key-condition-expression 'pk = :c AND begins_with(sk, :o)' \
  --expression-attribute-values '{":c":{"S":"CUSTOMER#c-1"},":o":{"S":"ORDER#"}}' --no-scan-index-forward \
  --query '{newestFirst: Items[].sk.S, count: Count, scanned: ScannedCount}'
aws dynamodb scan --table-name DemoOrders --filter-expression 'sk = :k' --expression-attribute-values '{":k":{"S":"ORDER#o-002"}}' \
  --query '{count: Count, scanned: ScannedCount}'
\`\`\`

On three items the difference is invisible. On 50 million items, that scan reads tens of gigabytes to return one item, and on a provisioned table it eats the capacity production traffic needs. Scans are for exports, migrations and backfills, run as a **parallel scan** (\`--segment\`/\`--total-segments\`) at a rate-limited pace, or better, replaced by **export to S3**, which uses no table capacity at all.

Both operations paginate: a response holds at most 1 MB, and \`LastEvaluatedKey\` tells you there's more. The CLI follows pages for you. Your application code must too: "the query only returns some of the orders" is a pagination bug.

## What a senior engineer does

- Writes the access-pattern table first and reviews it with the team, like an API contract.
- Uses high-cardinality partition keys, prefixed key values, and GSIs for alternative lookups.
- Uses sparse indexes to make "find the few items that need attention" queries cheap.
- Treats any \`Scan\` in a request path as a bug, and alarms on it in code review.
- Exports to S3 for analytics instead of bending the table schema to serve reports.
`,
    },

    // ------------------------------------------------------------ reading 3
    {
      id: "correctness",
      kind: "reading",
      title: "Correctness and operations: conditions, transactions, TTL, Streams, backups",
      minutes: 16,
      body: String.raw`
DynamoDB has no locks, and by default a write simply replaces whatever is there. Under concurrency and retries, that loses data silently. This lesson covers the tools that make writes correct, and the operational features that keep the data safe.

## Conditional writes

Every write (\`PutItem\`, \`UpdateItem\`, \`DeleteItem\`) can carry a **condition expression**. DynamoDB evaluates it atomically against the current item and fails the write with \`ConditionalCheckFailedException\` if it's false. The check and the write are one operation, so there's no race.

**Create only if absent: idempotency.** Network timeouts and client retries mean "create order" will sometimes be sent twice. Make the second attempt fail instead of creating a duplicate or overwriting:

\`\`\`bash
aws dynamodb put-item --table-name DemoOrders \
  --item '{"pk":{"S":"CUSTOMER#c-9"},"sk":{"S":"ORDER#o-500"},"totalCents":{"N":"1000"}}' \
  --condition-expression 'attribute_not_exists(pk)'
aws dynamodb put-item --table-name DemoOrders \
  --item '{"pk":{"S":"CUSTOMER#c-9"},"sk":{"S":"ORDER#o-500"},"totalCents":{"N":"1"}}' \
  --condition-expression 'attribute_not_exists(pk)'
\`\`\`

\`attribute_not_exists(pk)\` reads as "no item with this primary key exists", since every item has a \`pk\`. The application should treat \`ConditionalCheckFailedException\` on a create as "already done": fetch the existing item and return it, so the client sees the same response it would have seen the first time.

## Optimistic locking with a version attribute

Two workers read an order at version 3. Worker A ships it, worker B cancels it. Without protection, whichever writes last wins, and the other update is silently lost. With **optimistic locking**, every item carries a \`version\` number, and every update says "only if the version is still what I read, and increment it":

\`\`\`bash
aws dynamodb update-item --table-name DemoOrders --key '{"pk":{"S":"CUSTOMER#c-9"},"sk":{"S":"ORDER#o-500"}}' \
  --update-expression 'SET #st = :new, #v = :one' --condition-expression 'attribute_not_exists(#v)' \
  --expression-attribute-names '{"#st":"status","#v":"version"}' --expression-attribute-values '{":new":{"S":"PENDING"},":one":{"N":"1"}}'
aws dynamodb update-item --table-name DemoOrders --key '{"pk":{"S":"CUSTOMER#c-9"},"sk":{"S":"ORDER#o-500"}}' \
  --update-expression 'SET #st = :new, #v = #v + :inc' --condition-expression '#v = :expected' \
  --expression-attribute-names '{"#st":"status","#v":"version"}' \
  --expression-attribute-values '{":new":{"S":"SHIPPED"},":inc":{"N":"1"},":expected":{"N":"1"}}' --return-values UPDATED_NEW
aws dynamodb update-item --table-name DemoOrders --key '{"pk":{"S":"CUSTOMER#c-9"},"sk":{"S":"ORDER#o-500"}}' \
  --update-expression 'SET #st = :new, #v = #v + :inc' --condition-expression '#v = :expected' \
  --expression-attribute-names '{"#st":"status","#v":"version"}' \
  --expression-attribute-values '{":new":{"S":"CANCELLED"},":inc":{"N":"1"},":expected":{"N":"1"}}' \
  --return-values-on-condition-check-failure ALL_OLD
\`\`\`

The stale writer fails. With \`--return-values-on-condition-check-failure ALL_OLD\`, the error includes the current item, so the loser can re-read, re-apply its business rule ("can a shipped order be cancelled?"), and retry without an extra \`GetItem\`. \`status\` is a DynamoDB reserved word, hence \`#st\`. Reserved words (\`status\`, \`name\`, \`date\`, \`count\`, …) are a constant source of \`ValidationException\`s, so alias every attribute name in expressions and you'll never hit one.

Optimistic locking is right when conflicts are rare. When many writers fight over one item (a counter, inventory for a hot product), use atomic \`ADD\` updates or redesign to avoid the contention.

## Transactions

\`TransactWriteItems\` applies up to **100** actions (Put, Update, Delete, ConditionCheck) across items and tables **all or nothing**, with each action's condition checked atomically. \`TransactGetItems\` reads a consistent snapshot of up to 100 items. Typical uses: create an order *and* its idempotency record; transfer a balance between two items; enforce uniqueness of a secondary attribute (an email address) by writing a marker item.

Costs and limits: transactional operations consume **twice** the capacity, the total payload is capped at 4 MB, and an item can't appear twice in one transaction. A transaction that loses a race with another fails with \`TransactionCanceledException\`, and its \`CancellationReasons\` list says which action failed and why. Pass a \`ClientRequestToken\` to make the *whole call* idempotent for 10 minutes, so an SDK retry after a timeout doesn't re-run it.

Don't use transactions as a habit. Most correctness needs are met by a single conditional write, at half the cost.

## TTL: automatic expiry

Enable **Time to Live** on a Number attribute holding an **epoch timestamp in seconds**, and DynamoDB deletes items after that time. TTL deletes are free (no WCU). Use it for sessions, idempotency keys, caches, and data with a retention limit.

- Deletion is **background and lazy**: typically within a few days of expiry on AWS. Expired items can still be returned by reads until then, so filter on the attribute (\`expiresAt > :now\`) if correctness matters.
- The attribute must be a **Number in seconds**. Milliseconds (13 digits) puts expiry in the year 50,000. A String is ignored. Both are silent bugs.
- TTL deletes appear in DynamoDB Streams with a \`userIdentity\` of the DynamoDB service, so consumers can tell them apart from user deletes, for example to archive expired items to S3.

> **Emulator note:** the emulator deletes expired items within about a second, much faster than AWS, and its stream records for TTL deletes don't carry \`userIdentity\` or the old image. Don't build tests that depend on either behaviour.

## Streams: change data capture

**DynamoDB Streams** records every item-level change for **24 hours**, in order per item, with a configurable view: \`KEYS_ONLY\`, \`NEW_IMAGE\`, \`OLD_IMAGE\` or \`NEW_AND_OLD_IMAGES\`. Consumers are usually a **Lambda event source mapping**, which processes batches per shard and retries a failing batch until it succeeds or the records expire. Configure a bisect-on-error setting, a maximum retry count and an on-failure destination, or one poison record blocks the shard for a day.

Uses: maintaining aggregates or search indexes (OpenSearch), emitting domain events (Stream → Lambda → EventBridge), replicating to other stores, auditing. Consumers must be **idempotent**, because Lambda delivery is at-least-once. For longer retention, more consumers or a Kinesis-based pipeline, stream to **Kinesis Data Streams** instead.

\`\`\`bash
aws dynamodb update-table --table-name DemoOrders --stream-specification StreamEnabled=true,StreamViewType=NEW_AND_OLD_IMAGES \
  --query TableDescription.LatestStreamArn --output text
aws dynamodb put-item --table-name DemoOrders --item '{"pk":{"S":"CUSTOMER#c-9"},"sk":{"S":"ORDER#o-501"}}'
ARN=$(aws dynamodb describe-table --table-name DemoOrders --query Table.LatestStreamArn --output text)
SHARD=$(aws dynamodbstreams describe-stream --stream-arn "$ARN" --query 'StreamDescription.Shards[0].ShardId' --output text)
IT=$(aws dynamodbstreams get-shard-iterator --stream-arn "$ARN" --shard-id "$SHARD" --shard-iterator-type TRIM_HORIZON --query ShardIterator --output text)
aws dynamodbstreams get-records --shard-iterator "$IT" --query 'Records[].{event: eventName, key: dynamodb.Keys.sk.S}'
\`\`\`

## Backups and recovery

- **Point-in-time recovery (PITR)**: continuous backups, restore to any second in the last 35 days (configurable down to 1). Turn it on for every production table: it's the undo button for a bad deploy that corrupted data.
- **On-demand backups**: full snapshots kept until you delete them, with no performance impact. Use them before risky migrations, and use **AWS Backup** for schedules, cross-account and cross-region copies, and vault locks.
- **A restore always creates a new table.** It doesn't copy auto scaling policies, IAM policies, CloudWatch alarms, tags, stream settings or TTL settings. Your runbook must recreate those and then repoint the application, or copy data back. Practise it before you need it.
- **Deletion protection** stops \`DeleteTable\`, including a mistaken \`terraform destroy\`. Turn it on for production.
- **Global tables** replicate a table across regions (multi-active, last-writer-wins conflict resolution) for multi-region availability. Plan the conflict model before enabling them.

\`\`\`bash
aws dynamodb update-continuous-backups --table-name DemoOrders --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true \
  --query 'ContinuousBackupsDescription.PointInTimeRecoveryDescription.PointInTimeRecoveryStatus'
aws dynamodb update-table --table-name DemoOrders --deletion-protection-enabled --query TableDescription.DeletionProtectionEnabled
aws dynamodb delete-table --table-name DemoOrders
\`\`\`

The delete is refused until deletion protection is turned off. That's the point.
`,
    },

    // ------------------------------------------------------------ reading 4
    {
      id: "rds",
      kind: "reading",
      title: "RDS and Aurora in production",
      minutes: 18,
      body: String.raw`
When data is relational, needs joins and ad-hoc queries, or the application already speaks SQL, use **Amazon RDS**: managed PostgreSQL, MySQL, MariaDB, SQL Server, Oracle and Db2. AWS runs the OS, installs patches, takes backups and handles failover. You still own the schema, the queries, the sizing, the parameters, the network exposure and change management. **Aurora** is AWS's own engine, compatible with PostgreSQL and MySQL, with a different storage architecture.

## Availability: Multi-AZ vs read replicas

These two features are constantly confused. They solve different problems.

<figure class="diagram">
<svg viewBox="0 0 640 260" role="img" aria-label="Multi-AZ uses a synchronous standby for failover; read replicas use asynchronous replication for read scaling">
  <rect x="10" y="10" width="300" height="240" rx="10" class="d-box d-outer"/>
  <text x="26" y="34" class="d-label">Multi-AZ: availability</text>
  <rect x="30" y="54" width="120" height="70" rx="8" class="d-box d-accent"/><text x="90" y="82" text-anchor="middle" class="d-label">Primary</text><text x="90" y="100" text-anchor="middle" class="d-small">us-east-1a</text>
  <rect x="170" y="54" width="120" height="70" rx="8" class="d-box d-dim"/><text x="230" y="82" text-anchor="middle" class="d-label">Standby</text><text x="230" y="100" text-anchor="middle" class="d-small">us-east-1b, no reads</text>
  <path d="M150 89 H168" class="d-arrow"/><text x="160" y="140" text-anchor="middle" class="d-small">synchronous</text>
  <rect x="30" y="160" width="260" height="34" rx="6" class="d-box"/><text x="160" y="182" text-anchor="middle" class="d-small">one DNS endpoint; failover flips it (1–2 min)</text>
  <text x="160" y="222" text-anchor="middle" class="d-small">no data loss on failover (RPO ≈ 0)</text>
  <rect x="330" y="10" width="300" height="240" rx="10" class="d-box d-outer"/>
  <text x="346" y="34" class="d-label">Read replicas: read scaling</text>
  <rect x="350" y="54" width="120" height="70" rx="8" class="d-box d-accent"/><text x="410" y="82" text-anchor="middle" class="d-label">Primary</text><text x="410" y="100" text-anchor="middle" class="d-small">reads + writes</text>
  <rect x="490" y="44" width="120" height="40" rx="8" class="d-box"/><text x="550" y="69" text-anchor="middle" class="d-small">replica 1 (reads)</text>
  <rect x="490" y="96" width="120" height="40" rx="8" class="d-box"/><text x="550" y="121" text-anchor="middle" class="d-small">replica 2, other region</text>
  <path d="M470 80 C480 80 480 64 488 64" class="d-arrow d-dashed"/><path d="M470 98 C480 98 480 116 488 116" class="d-arrow d-dashed"/>
  <text x="480" y="152" text-anchor="middle" class="d-small">asynchronous: replicas lag</text>
  <rect x="350" y="160" width="260" height="34" rx="6" class="d-box"/><text x="480" y="182" text-anchor="middle" class="d-small">each replica has its own endpoint</text>
  <text x="480" y="222" text-anchor="middle" class="d-small">promotion is manual; lag = possible data loss</text>
</svg>
<figcaption>Multi-AZ keeps you up when an instance or AZ fails. Read replicas offload reads and provide cross-region DR. Production usually needs Multi-AZ; replicas only when reads demand it.</figcaption>
</figure>

| | **Multi-AZ (instance)** | **Multi-AZ DB cluster** | **Read replica** | **Aurora replicas** |
|---|---|---|---|---|
| Purpose | High availability | HA plus read capacity | Read scaling, cross-region DR | HA *and* read scaling |
| Replication | Synchronous, block-level | Semi-synchronous, 2 readable standbys | Asynchronous (engine-native) | Shared storage volume |
| Readable? | Standby: **no** | Yes, through a reader endpoint | Yes | Yes (up to 15) |
| Failover | Automatic, about 60–120 s | Automatic, typically under 35 s | **Manual promotion** | Automatic, typically about 30 s |
| Data loss on failover | None | None | Up to the replica lag | None |

Failover means the instance's **DNS name** moves to the standby. Applications must re-resolve DNS (don't cache it forever: the JVM has historically cached DNS indefinitely by default) and **reconnect with retries**. Practise it with \`aws rds reboot-db-instance --force-failover\` in staging. The first real failover shouldn't be the first time your connection pool sees one.

## Aurora in brief

Aurora separates compute from storage. The storage volume keeps **six copies across three AZs** and grows automatically up to 128 TiB (256 TiB on newer versions). Replicas read the same volume, so replica lag is usually milliseconds, and failover promotes a replica rather than replaying a log. You get a **cluster (writer) endpoint** and a **reader endpoint** that load-balances across replicas. **Aurora Serverless v2** scales capacity in fine-grained steps, and **Aurora Global Database** replicates to other regions with typically under a second of lag. It costs more per hour than RDS, and I/O can dominate the bill for I/O-heavy workloads; the **I/O-Optimized** storage configuration trades a higher storage price for no per-I/O charges.

## Networking: subnet groups and security groups

A **DB subnet group** lists the private subnets RDS may place instances in. It must cover **at least two AZs**, even for a single-AZ instance, so that Multi-AZ and failover have somewhere to go. The emulator enforces this, just like AWS (\`DBSubnetGroupDoesNotCoverEnoughAZs\`).

- Databases live in **private subnets** with \`PubliclyAccessible=false\`. There is almost never a reason for a public production database. Engineers connect through SSM Session Manager port forwarding or a bastion; applications through private networking.
- The database's **security group** allows the engine port (5432, 3306) only from the application's security group, *by SG reference*, not by CIDR.

## Parameter groups and option groups

A **parameter group** holds engine configuration (\`max_connections\`, \`work_mem\`, \`log_min_duration_statement\`, \`rds.force_ssl\`). The **default parameter groups can't be modified**, so always create your own from day one. Switching an instance to a new parameter group later requires a reboot.

- **Dynamic** parameters apply immediately (\`ApplyMethod=immediate\`). **Static** parameters apply only after a reboot, and the instance shows \`pending-reboot\` until then. Find out which kind a parameter is *before* the change window.
- Parameter groups are per engine **family** (\`postgres16\`). A major version upgrade needs a new group for the new family.
- Aurora has both **cluster** and **instance** parameter groups.
- **Option groups** (MySQL, MariaDB, SQL Server, Oracle) enable features such as native backup to S3 or Oracle TDE.

## Backups, snapshots and restores

- **Automated backups**: a daily snapshot plus transaction logs, giving **point-in-time restore** to any second within the retention period (1–35 days), usually up to about five minutes ago (\`LatestRestorableTime\`). **A retention of 0 disables backups, and with them read replicas.** The CLI default is 1 day, which is too short for production. Use 7–35.
- **Manual snapshots** persist until you delete them, even after the instance is deleted. Take one before every risky change, and set \`--copy-tags-to-snapshot\`.
- Deleting an instance offers a **final snapshot**. Automated backups are deleted with the instance unless you choose to retain them.
- **Every restore creates a new instance with a new endpoint.** Plan for DNS or configuration changes in the runbook, and practise restores: an untested backup is a hope, not a backup.

## Encryption, TLS and authentication

- **Encryption at rest** (KMS) must be chosen **at creation**. You can't encrypt an existing instance in place. The path is: snapshot → copy the snapshot with encryption → restore → cut over. Use a customer managed key if snapshots must be shared cross-account. Read replicas and snapshots inherit encryption.
- **In transit**: set \`rds.force_ssl=1\` (PostgreSQL) or \`require_secure_transport=ON\` (MySQL) in your parameter group, and have clients verify the RDS CA certificate.
- **Master password**: use \`--manage-master-user-password\`, so RDS generates the password, stores it in **Secrets Manager**, and rotates it. Nobody has to paste a password into Terraform, where it would end up in state.
- **IAM database authentication**: clients connect with a 15-minute token from \`aws rds generate-db-auth-token\` instead of a password, so access is governed by IAM roles. Good for humans and low-to-moderate connection rates. For high connection churn, put RDS Proxy in front.

## RDS Proxy

Each PostgreSQL or MySQL connection costs server memory, and \`max_connections\` is finite. A Lambda function scaling to 1,000 concurrent executions opens 1,000 connections and can take down the database. **RDS Proxy** pools and multiplexes connections, holds client connections open during failover (cutting failover impact substantially), and can enforce IAM authentication and TLS at the proxy. Use it for Lambda and for any fleet with many short-lived connections. Watch for **connection pinning** (session state such as temporary tables or \`SET\` statements forces a client onto one backend connection), which reduces the benefit.

## Change management: maintenance windows and blue/green

- **Maintenance windows**: minor-version patches and some modifications are applied during the weekly window. Set it to your low-traffic time, and know that \`--apply-immediately\` means *now*, possibly with downtime.
- **Blue/green deployments** create a synchronised copy of your database (green) using replication. You upgrade or reconfigure green (major version, parameter group, instance class), test it, then **switch over**: RDS stops writes, waits for green to catch up and renames endpoints so applications reconnect with no configuration change. Downtime is typically under a minute. This is the safe way to do major version upgrades.
- **Storage autoscaling** grows storage before it fills (a full database stops accepting writes). Set \`MaxAllocatedStorage\`.
- Turn on **deletion protection** for every production instance, and monitor with Performance Insights (or CloudWatch Database Insights), Enhanced Monitoring, and alarms on CPU, \`FreeableMemory\`, \`FreeStorageSpace\`, \`DatabaseConnections\` and \`ReplicaLag\`.

\`\`\`bash
aws rds describe-db-engine-versions --engine postgres --query 'DBEngineVersions[].EngineVersion' --output text
\`\`\`

> **Emulator note:** the RDS control plane is high-fidelity: subnet group AZ validation, parameter groups, Multi-AZ, encryption with KMS, managed master passwords in Secrets Manager, snapshots, read replicas, deletion protection, blue/green deployments and RDS Proxy all respond like AWS. The endpoint even runs a PostgreSQL-compatible engine on \`127.0.0.1\` that \`psql\` can connect to. But parameter group values aren't applied to that engine, IAM auth tokens aren't accepted by it, and there's no real standby to fail over to.
`,
    },

    // ------------------------------------------------------------ reading 5
    {
      id: "which-database",
      kind: "reading",
      title: "Which database when",
      minutes: 8,
      body: String.raw`
AWS has more than a dozen database services. You need to know a few deeply and recognise the rest. The choice is driven by **access patterns, consistency needs, scale, and who will operate it**, not by fashion.

| Need | Default choice | Why | Watch out for |
|---|---|---|---|
| Relational data, joins, ad-hoc SQL, moderate scale | **RDS for PostgreSQL / MySQL** | Familiar, flexible, cheap to start | Vertical scaling limits; connection limits; you own query tuning |
| Relational, high availability and read scale, larger | **Aurora** (PostgreSQL/MySQL compatible) | Fast failover, 15 replicas, storage autoscaling, Global Database | Higher cost; I/O charges unless I/O-Optimized |
| Spiky or intermittent relational workloads | **Aurora Serverless v2** | Scales capacity in small steps with load | Minimum capacity still bills; cold scaling has limits |
| Key-value or document access at any scale, known access patterns | **DynamoDB** | Single-digit-ms latency, serverless, no connections, no maintenance | Must design for access patterns; no ad-hoc queries or joins |
| Sub-millisecond caching, sessions, leaderboards, rate limiting | **ElastiCache** (Valkey/Redis OSS, Memcached) | In-memory speed | A cache, not a system of record (data can be lost) |
| Durable in-memory primary database | **MemoryDB** | Redis-compatible with a durable multi-AZ log | Cost per GB |
| Full-text search, log analytics | **OpenSearch Service** | Inverted indexes, aggregations | Cluster sizing and shard management; not a primary store |
| Analytics and data warehousing | **Redshift**, or **Athena** over S3 | Columnar, massively parallel | Not for OLTP; Athena bills per data scanned |
| Graph relationships (fraud rings, recommendations) | **Neptune** | Graph queries (Gremlin, openCypher, SPARQL) | Niche skills |
| Time series (metrics, IoT) | **Timestream** | Time-based storage tiers and functions | Query model differs from SQL databases |
| MongoDB-compatible documents | **DocumentDB** | Managed, MongoDB API compatible | Not every MongoDB feature is supported |
| Wide-column, Cassandra-compatible | **Keyspaces** | Serverless Cassandra API | CQL feature gaps |

## A decision path that works

1. **Do you know the access patterns, and are they mostly key lookups at high volume?** DynamoDB. It removes connection management, patching and capacity planning, and it fits Lambda perfectly.
2. **Do you need flexible queries, joins, reporting or strong relational integrity, or is the team SQL-first?** PostgreSQL on RDS. Move to Aurora when you need faster failover, more replicas or easier read scaling.
3. **Is it derived data?** (search indexes, caches, analytics) Feed it *from* the system of record, via DynamoDB Streams, RDS change data capture (for example with AWS DMS), or exports to S3, rather than dual-writing from the application.

Common, healthy architectures combine them: DynamoDB for the high-volume transactional core, Streams feeding OpenSearch for search and S3/Athena for analytics, and a small RDS database for back-office reporting that needs SQL.

## Mistakes seen in production

- **DynamoDB used like a relational database**: one table per entity, \`Scan\` with filters for every query, and "joins" done in application code. It's slow and expensive, and the team blames DynamoDB.
- **RDS used like DynamoDB**: millions of Lambda invocations each opening a new connection, without RDS Proxy. The database runs out of connections at the first traffic spike.
- **A cache treated as a database**: ElastiCache data lost on node replacement, with no way to rebuild it.
- **No backup restore tested**: PITR enabled for two years, never restored, and the runbook doesn't mention that the restored table has no alarms, no auto scaling and a different name.
- **Self-managing a database on EC2** without a reason (an engine or extension RDS doesn't support, or extreme tuning). You take on patching, backups, replication and failover that RDS gives you.
`,
    },

    // ------------------------------------------------------------ lab 1
    {
      id: "orders-table",
      kind: "lab",
      title: "Lab: design an Orders table that stays correct",
      minutes: 35,
      body: String.raw`
You're building the orders service. The access patterns have been agreed with the team:

| # | Access pattern | Key design |
|---|---|---|
| 1 | Get one order for a customer | \`GetItem pk=CUSTOMER#<customerId>, sk=ORDER#<orderId>\` |
| 2 | List a customer's orders, newest first | \`Query pk=CUSTOMER#<id>, begins_with(sk, ORDER#)\`, descending |
| 3 | List orders in a status, oldest first (fulfilment worker) | GSI \`gsi1\`: \`gsi1pk=STATUS#<status>\`, \`gsi1sk=<createdAt>\` |
| 4 | Create an order exactly once, despite client retries | Transaction with an idempotency record |
| 5 | Change an order's status without losing concurrent updates | Optimistic locking on \`version\` |

Every order item carries these attributes:

\`\`\`text
pk=CUSTOMER#<customerId>  sk=ORDER#<orderId>  orderId  customerId  status  totalCents (Number)
createdAt (ISO-8601)  gsi1pk=STATUS#<status>  gsi1sk=<createdAt>  version (Number, starts at 1)
\`\`\`

**Prepare lab** writes \`seed.json\` (three existing orders for customer \`c-42\`) into the lab folder. Do the tasks **in order**: later tasks change order statuses. DynamoDB JSON is verbose; writing items to files (\`file://item.json\`) keeps the commands readable.

For pattern 2, try this once the seed is loaded:

\`\`\`bash
aws dynamodb query --table-name orders --key-condition-expression 'pk = :c AND begins_with(sk, :o)' \
  --expression-attribute-values '{":c":{"S":"CUSTOMER#c-42"},":o":{"S":"ORDER#"}}' --no-scan-index-forward \
  --query 'Items[].[orderId.S, status.S, createdAt.S]' --output table
\`\`\`
`,
      lab: {
        files: {
          "seed.json": String.raw`
{
  "orders": [
    { "PutRequest": { "Item": {
      "pk": {"S": "CUSTOMER#c-42"}, "sk": {"S": "ORDER#o-1001"}, "orderId": {"S": "o-1001"}, "customerId": {"S": "c-42"},
      "status": {"S": "PENDING"}, "totalCents": {"N": "4999"}, "createdAt": {"S": "2026-11-01T09:00:00Z"},
      "gsi1pk": {"S": "STATUS#PENDING"}, "gsi1sk": {"S": "2026-11-01T09:00:00Z"}, "version": {"N": "1"} } } },
    { "PutRequest": { "Item": {
      "pk": {"S": "CUSTOMER#c-42"}, "sk": {"S": "ORDER#o-1002"}, "orderId": {"S": "o-1002"}, "customerId": {"S": "c-42"},
      "status": {"S": "SHIPPED"}, "totalCents": {"N": "1500"}, "createdAt": {"S": "2026-11-03T12:15:00Z"},
      "gsi1pk": {"S": "STATUS#SHIPPED"}, "gsi1sk": {"S": "2026-11-03T12:15:00Z"}, "version": {"N": "3"} } } },
    { "PutRequest": { "Item": {
      "pk": {"S": "CUSTOMER#c-42"}, "sk": {"S": "ORDER#o-1003"}, "orderId": {"S": "o-1003"}, "customerId": {"S": "c-42"},
      "status": {"S": "PENDING"}, "totalCents": {"N": "899"}, "createdAt": {"S": "2026-11-05T08:45:00Z"},
      "gsi1pk": {"S": "STATUS#PENDING"}, "gsi1sk": {"S": "2026-11-05T08:45:00Z"}, "version": {"N": "1"} } } }
  ]
}
`,
        },
        tasks: [
          {
            id: "table",
            title: "Create the table and its status index",
            description:
              "Create an **on-demand** table `orders` with a String partition key `pk` and String sort key `sk`, and a GSI named `gsi1` with String keys `gsi1pk` (partition) and `gsi1sk` (sort), **projecting all attributes**. Wait until it's ACTIVE.",
            hints: [
              "Every key attribute (table and index) must appear in `--attribute-definitions`; non-key attributes must not.",
              "`--global-secondary-indexes 'IndexName=gsi1,KeySchema=[{AttributeName=gsi1pk,KeyType=HASH},{AttributeName=gsi1sk,KeyType=RANGE}],Projection={ProjectionType=ALL}'`",
              "Finish with `aws dynamodb wait table-exists --table-name orders`.",
            ],
            check: async ({ tryAws }) => {
              const d = await tryAws(["dynamodb", "describe-table", "--table-name", TABLE]);
              if (!d.ok) return "Table `orders` doesn't exist yet.";
              const t = d.data.Table;
              const key = (ks: any[], type: string) => ks?.find((k: any) => k.KeyType === type)?.AttributeName;
              const types = Object.fromEntries((t.AttributeDefinitions ?? []).map((a: any) => [a.AttributeName, a.AttributeType]));
              if (key(t.KeySchema, "HASH") !== "pk" || key(t.KeySchema, "RANGE") !== "sk")
                return `Key schema is ${JSON.stringify(t.KeySchema)}; expected partition key pk and sort key sk.`;
              if (types.pk !== "S" || types.sk !== "S") return "pk and sk must both be String (S) attributes.";
              if (t.BillingModeSummary?.BillingMode !== "PAY_PER_REQUEST") return "Billing mode should be PAY_PER_REQUEST (on-demand).";
              const g = (t.GlobalSecondaryIndexes ?? []).find((x: any) => x.IndexName === "gsi1");
              if (!g) return "The table has no GSI named `gsi1`.";
              if (key(g.KeySchema, "HASH") !== "gsi1pk" || key(g.KeySchema, "RANGE") !== "gsi1sk")
                return "gsi1 should have partition key gsi1pk and sort key gsi1sk.";
              if (types.gsi1pk !== "S" || types.gsi1sk !== "S") return "gsi1pk and gsi1sk must be String attributes.";
              if (g.Projection?.ProjectionType !== "ALL") return `gsi1 projects ${g.Projection?.ProjectionType}; project ALL attributes so the worker gets whole orders.`;
              if (t.TableStatus !== "ACTIVE" || g.IndexStatus !== "ACTIVE") return `Table is ${t.TableStatus}, index is ${g.IndexStatus}. Wait for both to be ACTIVE.`;
              return true;
            },
          },
          {
            id: "write",
            title: "Load the seed and write a new order",
            description: [
              "Load `seed.json` with a batch write. Then add order **`o-1004`** for customer **`c-7`**: status `PENDING`, `totalCents` 1250, `createdAt` `2026-11-10T14:30:00Z`, `version` 1, with every key and index attribute filled in according to the design above.",
            ].join("\n"),
            hints: [
              "`aws dynamodb batch-write-item --request-items file://seed.json`. Check the response's `UnprocessedItems` is empty; in production you must retry those.",
              "The new item's keys are `pk=CUSTOMER#c-7`, `sk=ORDER#o-1004`, `gsi1pk=STATUS#PENDING` and `gsi1sk=2026-11-10T14:30:00Z`. Numbers are written as strings in DynamoDB JSON: `{\"N\": \"1250\"}`.",
              "Write the item to `o-1004.json` and run `aws dynamodb put-item --table-name orders --item file://o-1004.json`.",
            ],
            check: async (ctx) => {
              for (const id of ["o-1001", "o-1002", "o-1003"]) {
                if (!(await getOrder(ctx, "c-42", id))) return `Seed order ${id} isn't in the table. Load seed.json with batch-write-item.`;
              }
              const it = await getOrder(ctx, "c-7", "o-1004");
              if (!it) return "No item with pk=CUSTOMER#c-7, sk=ORDER#o-1004 yet.";
              const want: Record<string, string> = {
                orderId: "o-1004", customerId: "c-7", createdAt: "2026-11-10T14:30:00Z",
                gsi1sk: "2026-11-10T14:30:00Z",
              };
              for (const [k, v] of Object.entries(want)) if (S(it, k) !== v) return `o-1004 has ${k}=${JSON.stringify(S(it, k))}; expected "${v}".`;
              if (N(it, "totalCents") !== 1250) return `o-1004 totalCents is ${JSON.stringify(it.totalCents)}; expected the Number 1250.`;
              if (S(it, "status") !== "PENDING") return `o-1004 has status ${JSON.stringify(S(it, "status"))}; expected PENDING.`;
              if (S(it, "gsi1pk") !== `STATUS#${S(it, "status")}`) return `o-1004's gsi1pk is ${S(it, "gsi1pk")}; it must be STATUS#<status> so the order appears in the status index.`;
              if (N(it, "version") === undefined) return "o-1004 has no Number attribute `version`.";
              return true;
            },
          },
          {
            id: "query-gsi",
            title: "Serve the fulfilment worker from the index",
            description:
              "Using a **Query on `gsi1`** (not a Scan), write the `orderId`s of all **PENDING** orders, **oldest first**, to `pending.txt` (whitespace- or newline-separated).",
            hints: [
              "`--index-name gsi1 --key-condition-expression 'gsi1pk = :s' --expression-attribute-values '{\":s\":{\"S\":\"STATUS#PENDING\"}}'`",
              "Ascending sort-key order is the default. Add `--query 'Items[].orderId.S' --output text > pending.txt`.",
            ],
            check: async ({ readFile }) => {
              const f = await readFile("pending.txt");
              if (f === null) return "`pending.txt` not found in the lab folder.";
              const got = f.trim().split(/\s+/).filter(Boolean);
              const want = ["o-1001", "o-1003", "o-1004"];
              if (JSON.stringify(got) !== JSON.stringify(want))
                return `pending.txt lists ${JSON.stringify(got)}; expected ${JSON.stringify(want)} (oldest first). If you've already done later tasks, statuses may have changed: the expected list is the one before them.`;
              return true;
            },
          },
          {
            id: "idempotent-create",
            title: "Create an order exactly once",
            description: [
              "The client sends *create order `o-1005`* with idempotency key **`req-7f3a`**. In **one transaction**, write:",
              "",
              "- an idempotency record with `pk` and `sk` both `IDEMPOTENCY#req-7f3a`, an `orderId` of `o-1005`, and a Number `expiresAt` set to **24 hours from now** (epoch seconds), and",
              "- order `o-1005` for customer `c-7` (status `PENDING`, `totalCents` 3200, `createdAt` `2026-11-12T10:00:00Z`, `version` 1, keys per the design),",
              "",
              "each conditioned on the item **not already existing**. Then simulate the client's retry by running the **same transaction again**, and save its error output to `retry.txt`.",
            ].join("\n"),
            hints: [
              "`aws dynamodb transact-write-items --transact-items file://create-o-1005.json`, where the file is a JSON list of `{\"Put\": {\"TableName\": \"orders\", \"Item\": {…}, \"ConditionExpression\": \"attribute_not_exists(pk)\"}}`.",
              "Generate the file with a heredoc so the shell fills in `EXP=$(( $(date +%s) + 86400 ))` as `\"expiresAt\": {\"N\": \"$EXP\"}`.",
              "For the retry, run the identical command with `2> retry.txt || true`: it should fail with TransactionCanceledException, reasons `[ConditionalCheckFailed, ConditionalCheckFailed]`.",
            ],
            check: async (ctx) => {
              const order = await getOrder(ctx, "c-7", "o-1005");
              if (!order) return "Order o-1005 (pk=CUSTOMER#c-7, sk=ORDER#o-1005) doesn't exist yet.";
              if (N(order, "totalCents") !== 3200) return `o-1005 totalCents is ${JSON.stringify(order.totalCents)}; expected 3200. Did the retry overwrite it?`;
              if (S(order, "gsi1pk") !== `STATUS#${S(order, "status")}`) return "o-1005's gsi1pk doesn't match its status.";
              const r = await ctx.tryAws([
                "dynamodb", "get-item", "--table-name", TABLE, "--consistent-read",
                "--key", JSON.stringify({ pk: { S: "IDEMPOTENCY#req-7f3a" }, sk: { S: "IDEMPOTENCY#req-7f3a" } }),
              ]);
              const rec = r.data?.Item;
              if (!rec) return "No idempotency record with pk=sk=IDEMPOTENCY#req-7f3a.";
              if (S(rec, "orderId") !== "o-1005") return "The idempotency record should store orderId o-1005, so a retry can return the original order.";
              const exp = N(rec, "expiresAt");
              const now = Math.floor(Date.now() / 1000);
              if (exp === undefined) return "The idempotency record needs a Number attribute `expiresAt` (epoch seconds). A String won't work with TTL.";
              if (exp > 1e11) return `expiresAt is ${exp}: that's milliseconds. TTL needs epoch **seconds**.`;
              if (exp < now + 20 * 3600 || exp > now + 26 * 3600) return `expiresAt is ${exp}, but 24 hours from now is about ${now + 86400}.`;
              const f = await ctx.readFile("retry.txt");
              if (f === null) return "`retry.txt` not found. Run the same transaction again and save its error output there.";
              if (!f.includes("TransactionCanceledException")) return "retry.txt doesn't contain TransactionCanceledException. Did the retry use the same conditions?";
              return true;
            },
          },
          {
            id: "ttl",
            title: "Expire idempotency records automatically",
            description:
              "Enable **TTL** on the `orders` table using the attribute `expiresAt`, so idempotency records clean themselves up. Orders have no `expiresAt`, so they never expire.",
            hints: ["`aws dynamodb update-time-to-live --table-name orders --time-to-live-specification Enabled=true,AttributeName=expiresAt`"],
            check: async ({ tryAws }) => {
              const r = await tryAws(["dynamodb", "describe-time-to-live", "--table-name", TABLE]);
              if (!r.ok) return "Can't describe TTL. Does the table exist?";
              const t = r.data.TimeToLiveDescription ?? {};
              if (!["ENABLED", "ENABLING"].includes(t.TimeToLiveStatus)) return `TTL status is ${t.TimeToLiveStatus}; expected ENABLED.`;
              if (t.AttributeName !== "expiresAt") return `TTL uses attribute ${t.AttributeName}; expected expiresAt.`;
              return true;
            },
          },
          {
            id: "optimistic-lock",
            title: "Ship an order without losing a concurrent update",
            description: [
              "Two workers both read order **`o-1001`** (customer `c-42`) at **version 1**.",
              "",
              "1. Worker A ships it: set `status` to `SHIPPED`, move it in the index (`gsi1pk` = `STATUS#SHIPPED`), and increment `version`, **only if `version` is still 1**.",
              "2. Worker B, still holding version 1, tries to set `status` to `CANCELLED` with the same condition. It must be rejected. Save its error output to `stale.txt`.",
              "",
              "End state: o-1001 is SHIPPED at version 2, and appears in the SHIPPED partition of `gsi1`.",
            ].join("\n"),
            hints: [
              "`status` is a reserved word: use `--expression-attribute-names '{\"#st\":\"status\",\"#v\":\"version\"}'`.",
              "`--update-expression 'SET #st = :s, gsi1pk = :g, #v = #v + :one' --condition-expression '#v = :expected'` with `:expected` = `{\"N\":\"1\"}`.",
              "Run worker B's update with `2> stale.txt || true`. Adding `--return-values-on-condition-check-failure ALL_OLD` shows B the current item, so it could re-read and decide.",
            ],
            check: async (ctx) => {
              const it = await getOrder(ctx, "c-42", "o-1001");
              if (!it) return "Order o-1001 is missing.";
              if (S(it, "status") === "CANCELLED") return "o-1001 is CANCELLED: worker B's stale write won. Its update must be conditional on version = 1.";
              if (S(it, "status") !== "SHIPPED") return `o-1001 is ${S(it, "status")}; expected SHIPPED.`;
              if (N(it, "version") !== 2) return `o-1001 is at version ${N(it, "version")}; expected exactly 2 (one successful update).`;
              if (S(it, "gsi1pk") !== "STATUS#SHIPPED") return `o-1001's gsi1pk is ${S(it, "gsi1pk")}; the index entry must move to STATUS#SHIPPED too.`;
              const q = await ctx.aws([
                "dynamodb", "query", "--table-name", TABLE, "--index-name", "gsi1",
                "--key-condition-expression", "gsi1pk = :s",
                "--expression-attribute-values", JSON.stringify({ ":s": { S: "STATUS#SHIPPED" } }),
              ]);
              if (!(q.Items ?? []).some((i: any) => S(i, "orderId") === "o-1001")) return "o-1001 doesn't show up when querying gsi1 for STATUS#SHIPPED.";
              const f = await ctx.readFile("stale.txt");
              if (f === null) return "`stale.txt` not found. Run worker B's conditional update and save its error output there.";
              if (!f.includes("ConditionalCheckFailedException")) return "stale.txt doesn't contain ConditionalCheckFailedException.";
              return true;
            },
          },
        ],
        solution: String.raw`
aws dynamodb create-table --table-name orders \
  --attribute-definitions AttributeName=pk,AttributeType=S AttributeName=sk,AttributeType=S \
    AttributeName=gsi1pk,AttributeType=S AttributeName=gsi1sk,AttributeType=S \
  --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE \
  --global-secondary-indexes 'IndexName=gsi1,KeySchema=[{AttributeName=gsi1pk,KeyType=HASH},{AttributeName=gsi1sk,KeyType=RANGE}],Projection={ProjectionType=ALL}' \
  --billing-mode PAY_PER_REQUEST
aws dynamodb wait table-exists --table-name orders

aws dynamodb batch-write-item --request-items file://seed.json
cat > o-1004.json <<'EOF'
{"pk":{"S":"CUSTOMER#c-7"},"sk":{"S":"ORDER#o-1004"},"orderId":{"S":"o-1004"},"customerId":{"S":"c-7"},
 "status":{"S":"PENDING"},"totalCents":{"N":"1250"},"createdAt":{"S":"2026-11-10T14:30:00Z"},
 "gsi1pk":{"S":"STATUS#PENDING"},"gsi1sk":{"S":"2026-11-10T14:30:00Z"},"version":{"N":"1"}}
EOF
aws dynamodb put-item --table-name orders --item file://o-1004.json --condition-expression 'attribute_not_exists(pk)'

aws dynamodb query --table-name orders --index-name gsi1 --key-condition-expression 'gsi1pk = :s' \
  --expression-attribute-values '{":s":{"S":"STATUS#PENDING"}}' --query 'Items[].orderId.S' --output text > pending.txt
cat pending.txt

EXP=$(( $(date +%s) + 86400 ))
cat > create-o-1005.json <<EOF
[
  {"Put": {"TableName": "orders", "ConditionExpression": "attribute_not_exists(pk)", "Item": {
    "pk": {"S": "IDEMPOTENCY#req-7f3a"}, "sk": {"S": "IDEMPOTENCY#req-7f3a"},
    "orderId": {"S": "o-1005"}, "expiresAt": {"N": "$EXP"}}}},
  {"Put": {"TableName": "orders", "ConditionExpression": "attribute_not_exists(pk)", "Item": {
    "pk": {"S": "CUSTOMER#c-7"}, "sk": {"S": "ORDER#o-1005"}, "orderId": {"S": "o-1005"}, "customerId": {"S": "c-7"},
    "status": {"S": "PENDING"}, "totalCents": {"N": "3200"}, "createdAt": {"S": "2026-11-12T10:00:00Z"},
    "gsi1pk": {"S": "STATUS#PENDING"}, "gsi1sk": {"S": "2026-11-12T10:00:00Z"}, "version": {"N": "1"}}}}
]
EOF
aws dynamodb transact-write-items --transact-items file://create-o-1005.json
aws dynamodb transact-write-items --transact-items file://create-o-1005.json 2> retry.txt || true
cat retry.txt

aws dynamodb update-time-to-live --table-name orders --time-to-live-specification Enabled=true,AttributeName=expiresAt

KEY='{"pk":{"S":"CUSTOMER#c-42"},"sk":{"S":"ORDER#o-1001"}}'
NAMES='{"#st":"status","#v":"version"}'
aws dynamodb update-item --table-name orders --key "$KEY" \
  --update-expression 'SET #st = :s, gsi1pk = :g, #v = #v + :one' --condition-expression '#v = :expected' \
  --expression-attribute-names "$NAMES" \
  --expression-attribute-values '{":s":{"S":"SHIPPED"},":g":{"S":"STATUS#SHIPPED"},":one":{"N":"1"},":expected":{"N":"1"}}' \
  --return-values ALL_NEW
aws dynamodb update-item --table-name orders --key "$KEY" \
  --update-expression 'SET #st = :s, gsi1pk = :g, #v = #v + :one' --condition-expression '#v = :expected' \
  --expression-attribute-names "$NAMES" \
  --expression-attribute-values '{":s":{"S":"CANCELLED"},":g":{"S":"STATUS#CANCELLED"},":one":{"N":"1"},":expected":{"N":"1"}}' \
  --return-values-on-condition-check-failure ALL_OLD 2> stale.txt || true
cat stale.txt
`,
      },
    },

    // ------------------------------------------------------------ lab 2
    {
      id: "rds-production",
      kind: "lab",
      title: "Lab: a production-shaped PostgreSQL instance",
      minutes: 30,
      body: String.raw`
The team is moving a service from a hand-built database to RDS for PostgreSQL. You'll build the control plane the way a production review expects it. **Prepare lab** creates the network for you:

| Resource | Name (tag) | Details |
|---|---|---|
| VPC | \`app-vpc\` | 10.30.0.0/16 |
| Private subnets | \`db-a\`, \`db-b\` | us-east-1a and us-east-1b |
| Security group | \`app-db-sg\` | allows 5432 from inside the VPC only |
| KMS key | \`alias/rds-app\` | customer managed key for the database |

Look the IDs up instead of copying them. That's what your IaC does too:

\`\`\`bash
VPC=$(aws ec2 describe-vpcs --filters Name=tag:Name,Values=app-vpc --query 'Vpcs[0].VpcId' --output text)
SUBNETS=$(aws ec2 describe-subnets --filters Name=tag:Name,Values=db-a,db-b --query 'Subnets[].SubnetId' --output text)
SG=$(aws ec2 describe-security-groups --filters Name=vpc-id,Values=$VPC Name=group-name,Values=app-db-sg --query 'SecurityGroups[0].GroupId' --output text)
echo "$VPC | $SUBNETS | $SG"
\`\`\`

Some settings, such as **encryption, can only be chosen when the instance is created**. Read every task before you run \`create-db-instance\`. If you get it wrong, you'll have to turn off deletion protection, delete the instance and start again, just as on AWS.

## Going further (optional): connect to it

The emulator's endpoint runs a PostgreSQL-compatible engine. Once \`app-db\` is available, and if \`psql\` is installed, fetch the generated master password from Secrets Manager and connect. This is the same flow an application uses with a managed master secret:

\`\`\`bash
SECRET=$(aws rds describe-db-instances --db-instance-identifier app-db --query 'DBInstances[0].MasterUserSecret.SecretArn' --output text)
export PGPASSWORD=$(aws secretsmanager get-secret-value --secret-id "$SECRET" --query SecretString --output text | jq -r .password)
read -r HOST PORT < <(aws rds describe-db-instances --db-instance-identifier app-db --query 'DBInstances[0].Endpoint.[Address,Port]' --output text)
psql -h "$HOST" -p "$PORT" -U app -d postgres -c 'select version()'
\`\`\`

> **Emulator note:** parameter group values aren't applied to the emulator's engine (\`show log_min_duration_statement\` still says \`-1\`), and it doesn't accept IAM auth tokens. On AWS, \`rds.force_ssl=1\` would also make that \`psql\` call negotiate TLS.
`,
      lab: {
        setup: String.raw`
VPC=$(aws ec2 create-vpc --cidr-block 10.30.0.0/16 --tag-specifications 'ResourceType=vpc,Tags=[{Key=Name,Value=app-vpc}]' --query Vpc.VpcId --output text)
aws ec2 create-subnet --vpc-id "$VPC" --cidr-block 10.30.10.0/24 --availability-zone us-east-1a \
  --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=db-a}]' --query Subnet.SubnetId --output text
aws ec2 create-subnet --vpc-id "$VPC" --cidr-block 10.30.11.0/24 --availability-zone us-east-1b \
  --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=db-b}]' --query Subnet.SubnetId --output text
SG=$(aws ec2 create-security-group --group-name app-db-sg --description "PostgreSQL from inside the VPC" --vpc-id "$VPC" --query GroupId --output text)
aws ec2 authorize-security-group-ingress --group-id "$SG" --protocol tcp --port 5432 --cidr 10.30.0.0/16 >/dev/null
KEY=$(aws kms create-key --description "rds-app" --query KeyMetadata.KeyId --output text)
aws kms create-alias --alias-name alias/rds-app --target-key-id "$KEY"
echo "network ready: $VPC $SG"
`,
        tasks: [
          {
            id: "subnet-group",
            title: "A DB subnet group across two AZs",
            description: "Create a DB subnet group named `app-db-subnets` containing the private subnets `db-a` and `db-b`.",
            hints: [
              "`aws rds create-db-subnet-group --db-subnet-group-name app-db-subnets --db-subnet-group-description \"app db\" --subnet-ids $SUBNETS`",
              "Try it with only one subnet first and read the error: subnet groups must cover at least two AZs.",
            ],
            check: async (ctx) => {
              const r = await ctx.tryAws(["rds", "describe-db-subnet-groups", "--db-subnet-group-name", "app-db-subnets"]);
              if (!r.ok) return "DB subnet group `app-db-subnets` doesn't exist yet.";
              const got = new Set((r.data.DBSubnetGroups[0].Subnets ?? []).map((s: any) => s.SubnetIdentifier));
              const a = await subnetIdByName(ctx, "db-a");
              const b = await subnetIdByName(ctx, "db-b");
              if (!a || !b) return "Subnets db-a / db-b not found. Press Prepare lab.";
              if (got.size !== 2 || !got.has(a) || !got.has(b)) return `The subnet group contains ${JSON.stringify([...got])}; expected exactly db-a (${a}) and db-b (${b}).`;
              return true;
            },
          },
          {
            id: "parameter-group",
            title: "Your own parameter group",
            description:
              "Create a DB parameter group `app-pg16` for the **`postgres16`** family, and set **`rds.force_ssl` = 1** (reject non-TLS connections) and **`log_min_duration_statement` = 500** (log queries slower than 500 ms).",
            hints: [
              "`aws rds create-db-parameter-group --db-parameter-group-name app-pg16 --db-parameter-group-family postgres16 --description \"app PostgreSQL 16\"`",
              "`aws rds modify-db-parameter-group --db-parameter-group-name app-pg16 --parameters 'ParameterName=rds.force_ssl,ParameterValue=1,ApplyMethod=immediate' 'ParameterName=log_min_duration_statement,ParameterValue=500,ApplyMethod=immediate'`",
              "Check with `aws rds describe-db-parameters --db-parameter-group-name app-pg16 --source user`.",
            ],
            check: async ({ tryAws }) => {
              const g = await tryAws(["rds", "describe-db-parameter-groups", "--db-parameter-group-name", "app-pg16"]);
              if (!g.ok) return "Parameter group `app-pg16` doesn't exist yet.";
              const fam = g.data.DBParameterGroups[0].DBParameterGroupFamily;
              if (fam !== "postgres16") return `app-pg16 is for family ${fam}; expected postgres16.`;
              const p = await tryAws(["rds", "describe-db-parameters", "--db-parameter-group-name", "app-pg16", "--source", "user"]);
              const vals = Object.fromEntries((p.data?.Parameters ?? []).map((x: any) => [x.ParameterName, x.ParameterValue]));
              if (vals["rds.force_ssl"] !== "1") return `rds.force_ssl is ${vals["rds.force_ssl"] ?? "not set"}; expected 1.`;
              if (vals["log_min_duration_statement"] !== "500") return `log_min_duration_statement is ${vals["log_min_duration_statement"] ?? "not set"}; expected 500.`;
              return true;
            },
          },
          {
            id: "instance",
            title: "Launch a private Multi-AZ instance",
            description: [
              "Create DB instance **`app-db`**: engine `postgres` version **16.x**, class `db.t4g.medium`, **20 GiB of gp3** storage, master user `app`, in subnet group `app-db-subnets` with security group `app-db-sg` and parameter group `app-pg16`, **Multi-AZ**, and **not publicly accessible**. Wait until it's `available`.",
              "",
              "Read the next task first: some of its settings can't be added after creation.",
            ].join("\n"),
            hints: [
              "`aws rds describe-db-engine-versions --engine postgres --query 'DBEngineVersions[].EngineVersion'` lists the versions; pick a 16.x.",
              "Key flags: `--db-subnet-group-name app-db-subnets --vpc-security-group-ids $SG --db-parameter-group-name app-pg16 --multi-az --no-publicly-accessible --storage-type gp3 --allocated-storage 20`.",
              "Then `aws rds wait db-instance-available --db-instance-identifier app-db`.",
            ],
            check: async (ctx) => {
              const d = await dbInstance(ctx, "app-db");
              if (typeof d === "string") return d;
              if (d.Engine !== "postgres") return `Engine is ${d.Engine}; expected postgres.`;
              if (!String(d.EngineVersion).startsWith("16.")) return `Engine version is ${d.EngineVersion}; expected 16.x to match the postgres16 parameter group.`;
              if (d.DBInstanceClass !== "db.t4g.medium") return `Instance class is ${d.DBInstanceClass}; expected db.t4g.medium.`;
              if (d.StorageType !== "gp3" || d.AllocatedStorage < 20) return `Storage is ${d.AllocatedStorage} GiB of ${d.StorageType}; expected 20 GiB of gp3.`;
              if (d.MasterUsername !== "app") return `Master user is ${d.MasterUsername}; expected app.`;
              if (d.DBSubnetGroup?.DBSubnetGroupName !== "app-db-subnets") return `Subnet group is ${d.DBSubnetGroup?.DBSubnetGroupName}; expected app-db-subnets.`;
              const sg = await ctx.tryAws(["ec2", "describe-security-groups", "--filters", "Name=group-name,Values=app-db-sg"]);
              const sgId = sg.data?.SecurityGroups?.[0]?.GroupId;
              const sgs = (d.VpcSecurityGroups ?? []).map((x: any) => x.VpcSecurityGroupId);
              if (!sgId || !sgs.includes(sgId)) return `The instance's security groups are ${JSON.stringify(sgs)}; expected app-db-sg (${sgId}).`;
              const pg = (d.DBParameterGroups ?? []).map((x: any) => x.DBParameterGroupName);
              if (!pg.includes("app-pg16")) return `Parameter group is ${JSON.stringify(pg)}; expected app-pg16.`;
              if (d.MultiAZ !== true) return "The instance isn't Multi-AZ.";
              if (d.PubliclyAccessible !== false) return "The instance is publicly accessible. Production databases belong in private subnets only.";
              if (d.DBInstanceStatus !== "available") return `Status is ${d.DBInstanceStatus}; wait for available.`;
              return true;
            },
          },
          {
            id: "data-protection",
            title: "Data protection settings",
            description: [
              "`app-db` must also have:",
              "",
              "- storage **encrypted with `alias/rds-app`** (creation time only),",
              "- a master password **managed by RDS in Secrets Manager** (no password on the command line),",
              "- automated backups retained for **7 days**, and tags copied to snapshots,",
              "- **deletion protection** on,",
              "- **IAM database authentication** enabled.",
            ].join("\n"),
            hints: [
              "Creation-time flags: `--storage-encrypted --kms-key-id alias/rds-app --manage-master-user-password`.",
              "`--backup-retention-period 7 --copy-tags-to-snapshot --deletion-protection --enable-iam-database-authentication` can be set at creation or later with `modify-db-instance … --apply-immediately`.",
              "Forgot encryption? `modify-db-instance --no-deletion-protection --apply-immediately`, then `delete-db-instance --skip-final-snapshot`, wait with `db-instance-deleted`, and create it again.",
            ],
            check: async (ctx) => {
              const d = await dbInstance(ctx, "app-db");
              if (typeof d === "string") return d;
              if (d.StorageEncrypted !== true) return "Storage isn't encrypted. This can only be set at creation: delete the instance (disable deletion protection first) and recreate it.";
              const want = await keyArn(ctx, "alias/rds-app");
              if (!want || (await keyArn(ctx, d.KmsKeyId)) !== want) return `Storage is encrypted with ${d.KmsKeyId}, not the alias/rds-app key.`;
              if (!d.MasterUserSecret?.SecretArn) return "The master password isn't managed in Secrets Manager. Use --manage-master-user-password.";
              if (d.BackupRetentionPeriod !== 7) return `Backup retention is ${d.BackupRetentionPeriod} days; expected 7.`;
              if (d.CopyTagsToSnapshot !== true) return "CopyTagsToSnapshot is off.";
              if (d.DeletionProtection !== true) return "Deletion protection is off.";
              if (d.IAMDatabaseAuthenticationEnabled !== true) return "IAM database authentication isn't enabled.";
              return true;
            },
          },
          {
            id: "snapshot",
            title: "Snapshot before the change",
            description:
              "Before next week's schema migration, take a **manual snapshot** of `app-db` named **`app-db-pre-migration`** and wait for it to be available. Manual snapshots survive even if the instance is deleted.",
            hints: [
              "`aws rds create-db-snapshot --db-instance-identifier app-db --db-snapshot-identifier app-db-pre-migration`",
              "`aws rds wait db-snapshot-available --db-snapshot-identifier app-db-pre-migration`",
            ],
            check: async ({ tryAws }) => {
              const s = await tryAws(["rds", "describe-db-snapshots", "--db-snapshot-identifier", "app-db-pre-migration"]);
              if (!s.ok) return "Snapshot `app-db-pre-migration` doesn't exist yet.";
              const snap = s.data.DBSnapshots[0];
              if (snap.DBInstanceIdentifier !== "app-db") return `The snapshot is of ${snap.DBInstanceIdentifier}, not app-db.`;
              if (snap.SnapshotType !== "manual") return `Snapshot type is ${snap.SnapshotType}; expected manual.`;
              if (snap.Status !== "available") return `Snapshot status is ${snap.Status}; wait for available.`;
              if (snap.Encrypted !== true) return "The snapshot isn't encrypted, which means the instance wasn't either.";
              return true;
            },
          },
          {
            id: "read-replica",
            title: "Add a read replica for reporting",
            description:
              "The reporting team's heavy queries must not slow down the application. Create a **read replica** of `app-db` named **`app-db-ro`** in **`us-east-1b`**, class `db.t4g.medium`, and wait for it to be available. Note that this is separate from Multi-AZ: the standby can't serve reads, the replica can.",
            hints: [
              "`aws rds create-db-instance-read-replica --db-instance-identifier app-db-ro --source-db-instance-identifier app-db --db-instance-class db.t4g.medium --availability-zone us-east-1b`",
              "`aws rds wait db-instance-available --db-instance-identifier app-db-ro`",
            ],
            check: async (ctx) => {
              const d = await dbInstance(ctx, "app-db-ro");
              if (typeof d === "string") return d;
              if (d.ReadReplicaSourceDBInstanceIdentifier !== "app-db") return "app-db-ro exists but isn't a read replica of app-db.";
              if (d.AvailabilityZone !== "us-east-1b") return `app-db-ro is in ${d.AvailabilityZone}; expected us-east-1b.`;
              if (d.DBInstanceClass !== "db.t4g.medium") return `app-db-ro is ${d.DBInstanceClass}; expected db.t4g.medium.`;
              if (d.DBInstanceStatus !== "available") return `app-db-ro is ${d.DBInstanceStatus}; wait for available.`;
              return true;
            },
          },
        ],
        solution: String.raw`
VPC=$(aws ec2 describe-vpcs --filters Name=tag:Name,Values=app-vpc --query 'Vpcs[0].VpcId' --output text)
SUBNETS=$(aws ec2 describe-subnets --filters Name=tag:Name,Values=db-a,db-b --query 'Subnets[].SubnetId' --output text)
SG=$(aws ec2 describe-security-groups --filters Name=vpc-id,Values=$VPC Name=group-name,Values=app-db-sg --query 'SecurityGroups[0].GroupId' --output text)

aws rds create-db-subnet-group --db-subnet-group-name app-db-subnets --db-subnet-group-description "app db" --subnet-ids $SUBNETS

aws rds create-db-parameter-group --db-parameter-group-name app-pg16 --db-parameter-group-family postgres16 --description "app PostgreSQL 16"
aws rds modify-db-parameter-group --db-parameter-group-name app-pg16 --parameters \
  'ParameterName=rds.force_ssl,ParameterValue=1,ApplyMethod=immediate' \
  'ParameterName=log_min_duration_statement,ParameterValue=500,ApplyMethod=immediate'

VERSION=$(aws rds describe-db-engine-versions --engine postgres --query 'DBEngineVersions[?starts_with(EngineVersion, \`16.\`)].EngineVersion | [-1]' --output text)
aws rds create-db-instance --db-instance-identifier app-db \
  --engine postgres --engine-version "$VERSION" --db-instance-class db.t4g.medium \
  --storage-type gp3 --allocated-storage 20 \
  --master-username app --manage-master-user-password \
  --db-subnet-group-name app-db-subnets --vpc-security-group-ids "$SG" --db-parameter-group-name app-pg16 \
  --multi-az --no-publicly-accessible \
  --storage-encrypted --kms-key-id alias/rds-app \
  --backup-retention-period 7 --copy-tags-to-snapshot --deletion-protection \
  --enable-iam-database-authentication \
  --tags Key=service,Value=app Key=env,Value=prod \
  --query 'DBInstance.DBInstanceStatus'
aws rds wait db-instance-available --db-instance-identifier app-db

aws rds create-db-snapshot --db-instance-identifier app-db --db-snapshot-identifier app-db-pre-migration --query DBSnapshot.Status
aws rds wait db-snapshot-available --db-snapshot-identifier app-db-pre-migration

aws rds create-db-instance-read-replica --db-instance-identifier app-db-ro --source-db-instance-identifier app-db \
  --db-instance-class db.t4g.medium --availability-zone us-east-1b --query 'DBInstance.DBInstanceStatus'
aws rds wait db-instance-available --db-instance-identifier app-db-ro
`,
      },
    },
  ],

  quiz: [
    {
      q: "An IoT table uses `deviceType` (5 possible values) as its partition key. As the fleet grows, writes start throttling even though total consumed capacity is far below the table's limits. Why?",
      options: [
        "On-demand tables have a fixed per-table write limit",
        "Low-cardinality partition keys concentrate writes on a few partitions; each partition (and each key) has its own throughput ceiling",
        "GSIs always throttle the base table",
        "DynamoDB requires a sort key for high write rates",
      ],
      answer: 1,
      explain:
        "Throughput is spread across partitions by hashing the partition key. With five values, all writes land on at most five keys, and a single key can't exceed one partition's roughly 1,000 WCU. Use a high-cardinality key such as `deviceId`, or shard (`deviceType#0..N`). Contributor Insights shows hot keys directly.",
    },
    {
      q: "A worker writes an order and immediately queries a GSI for it, but sometimes the order isn't returned. Adding `--consistent-read` to the GSI query fails. What's the right fix?",
      options: [
        "Use an LSI instead, created with `update-table`",
        "Accept that GSIs are eventually consistent: read your own write from the base table by primary key, and design the GSI consumer to tolerate brief lag",
        "Scan the table with a filter instead",
        "Switch the table to provisioned capacity",
      ],
      answer: 1,
      explain:
        "GSIs are updated asynchronously and support only eventually consistent reads. For read-your-own-write, read the base table (strongly consistent reads are available there). LSIs do support strong consistency, but can only be created with the table, and a Scan is the expensive non-answer.",
    },
    {
      q: "Two instances of a service update the same DynamoDB item at nearly the same time, and one update is occasionally lost. Which pattern fixes this with the least cost?",
      options: [
        "Wrap every update in TransactWriteItems",
        "Add a `version` attribute and make every update conditional on the version read, incrementing it",
        "Use strongly consistent reads before every write",
        "Enable DynamoDB Streams and replay lost updates",
      ],
      answer: 1,
      explain:
        "Optimistic locking makes the check and the write atomic: the stale writer gets `ConditionalCheckFailedException` and must re-read and retry. A strongly consistent read doesn't prevent the race between read and write. Transactions also work but cost twice the capacity, and aren't needed for a single item.",
    },
    {
      q: "Session items have `expiresAt` set from JavaScript's `Date.now()`. TTL is enabled, but sessions never expire. Why?",
      options: [
        "TTL only works on tables with streams enabled",
        "`Date.now()` is milliseconds; TTL expects epoch seconds, so the items expire tens of thousands of years from now",
        "TTL deletes require provisioned capacity",
        "The attribute must be named `ttl`",
      ],
      answer: 1,
      explain:
        "TTL reads the attribute as epoch **seconds**. A millisecond timestamp is about 1,000 times too large. Use `Math.floor(Date.now() / 1000)`. Also remember TTL deletion is lazy (up to days on AWS), so filter expired items on read if it matters.",
    },
    {
      q: "Your RDS for PostgreSQL instance is Multi-AZ. Reporting queries are slowing the application, and someone suggests sending reports to the Multi-AZ standby. What do you tell them?",
      options: [
        "Good idea: the standby has the same data",
        "The standby of a Multi-AZ instance deployment can't serve reads; create a read replica (or use a Multi-AZ DB cluster or Aurora, whose standbys or replicas are readable)",
        "Point reports at the primary's reader endpoint",
        "Disable Multi-AZ and use the second instance for reports",
      ],
      answer: 1,
      explain:
        "In a Multi-AZ *instance* deployment, the standby exists only for failover and accepts no connections. Read scaling needs read replicas (asynchronous, so they lag) or an architecture with readable standbys: a Multi-AZ DB cluster or Aurora with its reader endpoint.",
    },
    {
      q: "Security review finds a production RDS instance created without storage encryption. What's the correct remediation?",
      options: [
        "`modify-db-instance --storage-encrypted --apply-immediately`",
        "Enable EBS encryption by default for the region",
        "Snapshot the instance, copy the snapshot with encryption using a KMS key, restore a new instance from the encrypted copy, then cut over",
        "Enable `rds.force_ssl` in the parameter group",
      ],
      answer: 2,
      explain:
        "Encryption at rest is fixed at creation, so it can't be turned on in place. The snapshot → encrypted copy → restore → cutover path is the standard fix, ideally with a replication-based or blue/green style cutover to minimise downtime. `rds.force_ssl` covers encryption in transit, a separate control.",
    },
    {
      q: "A Lambda-based API scales to 2,000 concurrent executions during a spike and the PostgreSQL instance starts rejecting connections. What's the best fix?",
      options: [
        "Raise `max_connections` to 10,000",
        "Put RDS Proxy between Lambda and the database to pool and multiplex connections",
        "Use a larger Lambda memory size",
        "Switch to IAM database authentication",
      ],
      answer: 1,
      explain:
        "Each execution environment holds its own connection, and PostgreSQL connections are expensive. RDS Proxy pools them, reducing database connections dramatically, and also improves failover behaviour. Raising `max_connections` just moves the failure to memory exhaustion. IAM auth alone makes connection setup *more* expensive.",
    },
  ],
};
