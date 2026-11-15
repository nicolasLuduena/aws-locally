import type { CheckContext, Module } from "../types.ts";

// ---------------------------------------------------------------- helpers

const ARTIFACT_BUCKET = "ci-artifacts-000000000000";
const ARTIFACT_KEY = "releases/app/1.4.2/app-1.4.2.tar.gz";
const ARCHIVE_BUCKET = "release-archive";

/** Resolve any KMS key reference (id, ARN, alias name, alias ARN) to the key ARN, or null. */
async function keyArn(ctx: CheckContext, ref: string | undefined | null): Promise<string | null> {
  if (!ref) return null;
  const r = await ctx.tryAws(["kms", "describe-key", "--key-id", ref]);
  return r.ok ? r.data.KeyMetadata.Arn : null;
}

async function bucketPolicy(ctx: CheckContext, bucket: string): Promise<any[] | string> {
  const p = await ctx.tryAws(["s3api", "get-bucket-policy", "--bucket", bucket]);
  if (!p.ok) return p.code === "NoSuchBucket" ? `Bucket \`${bucket}\` doesn't exist yet.` : `\`${bucket}\` has no bucket policy yet.`;
  try {
    const doc = JSON.parse(p.data.Policy);
    return Array.isArray(doc.Statement) ? doc.Statement : [doc.Statement];
  } catch {
    return "The bucket policy isn't valid JSON.";
  }
}

const asList = (v: any): any[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

/** Read an object's body as text through the CLI (empty string on failure). */
async function objectText(ctx: CheckContext, bucket: string, key: string): Promise<string | null> {
  const r = await ctx.sh(`aws s3 cp "s3://${bucket}/${key}" - 2>/dev/null`);
  return r.code === 0 ? r.stdout : null;
}

// ---------------------------------------------------------------- module

export const storage: Module = {
  id: "storage",
  number: "04",
  title: "Storage: S3 in depth (plus EBS & EFS)",
  summary:
    "Run S3 like a production service: object model and limits, versioning, lifecycle and Object Lock, encryption and access control, presigned URLs and events, and know when EBS or EFS is the right tool instead.",
  services: ["S3", "KMS", "SQS", "EBS", "EFS"],
  lessons: [
    // ------------------------------------------------------------ reading 1
    {
      id: "object-model",
      kind: "reading",
      title: "S3's object model and limits",
      minutes: 14,
      body: String.raw`
S3 is the oldest AWS service and still the one most production systems lean on: build artifacts, Terraform state, logs, backups, data lakes, static sites, ML datasets. It *looks* like a filesystem in the console, and that illusion causes most S3 mistakes. It is a **key-value store for immutable blobs, behind an HTTP API**.

## Buckets, keys and the prefix illusion

A **bucket** is a container that lives in one region. Its name is **globally unique across every AWS account**, because it becomes part of a DNS name (\`my-bucket.s3.us-east-1.amazonaws.com\`). Inside a bucket there are no directories. There are only **keys**: UTF-8 strings of up to 1,024 bytes.

\`\`\`text
releases/app/1.4.2/app-1.4.2.tar.gz      ← one key; "releases/" is not a folder
releases/app/1.4.2/SHA256SUMS
logs/2026/11/15/web-01.log.gz
\`\`\`

The "folders" you see are **prefixes** that the List API groups for you when you pass a delimiter. Try it:

\`\`\`bash
aws s3api create-bucket --bucket demo-objects
echo v1 > /tmp/demo-a.txt
for k in releases/app/1.0.0/app.tgz releases/app/1.1.0/app.tgz releases/web/2.0.0/site.zip README.md; do
  aws s3api put-object --bucket demo-objects --key "$k" --body /tmp/demo-a.txt --query ETag --output text
done
aws s3api list-objects-v2 --bucket demo-objects --delimiter / \
  --query '{folders: CommonPrefixes[].Prefix, objects: Contents[].Key}'
aws s3api list-objects-v2 --bucket demo-objects --prefix releases/app/ --query 'Contents[].Key'
\`\`\`

Consequences that bite:

- **There is no rename.** "Moving" a prefix means copying every object and deleting the original. On a million objects that is two million requests and real money.
- **There is no append or partial update.** To change one byte you rewrite the object.
- **Listing is paginated at 1,000 keys** and is the slowest, most expensive way to find things. If an application needs to *query* objects, keep an index somewhere else (DynamoDB, a manifest file), or use S3 Inventory for bulk reporting.
- **Bucket names are a global namespace.** Use a convention that can't collide, such as \`<purpose>-<account-id>-<region>\`. When you delete a bucket, its name becomes free for *anyone*. If a forgotten pipeline still writes to that name, someone else can claim it and receive your data. Retire bucket names deliberately.

## Objects: data, metadata, version, checksum

An object is its **data** (0 bytes to **5 TB**), **system metadata** (\`Content-Type\`, \`Content-Length\`, storage class, encryption), **user metadata** (\`x-amz-meta-*\` headers, 2 KB total) and, if versioning is on, a **version ID**. Metadata is immutable: changing it means copying the object onto itself.

The **ETag** is *not* a reliable checksum. It is the MD5 of the content only for single-part uploads without SSE-KMS. Multipart uploads produce \`"<md5-of-md5s>-<parts>"\`. For integrity, use S3's additional checksums (CRC64NVME, CRC32C, SHA-256). Recent CLIs and SDKs send a CRC by default, and S3 verifies it on upload. Look for \`ChecksumCRC64NVME\` in the \`put-object\` output above.

## Consistency: strong, but no locking

Since December 2020, S3 gives **strong read-after-write consistency** for every PUT, DELETE and LIST, at no cost. After a successful \`PutObject\` returns, every subsequent GET and LIST sees the new object. Two things are still not guaranteed:

1. **Concurrent writers.** Two PUTs to the same key: the last one to finish wins, silently. If you need "create only if absent" or "update only if unchanged", use **conditional writes**: \`If-None-Match: *\` fails with \`412 PreconditionFailed\` when the key already exists, and \`If-Match: <etag>\` fails when someone changed it. Terraform's native S3 state locking is built on exactly this.
2. **Bucket configuration.** Changes to policies, lifecycle rules or versioning settings propagate over seconds to minutes. Don't run a deployment step that depends on a policy you set one second earlier.

\`\`\`bash
aws s3api put-object --bucket demo-objects --key locks/deploy.lock --body /tmp/demo-a.txt --if-none-match '*'
aws s3api put-object --bucket demo-objects --key locks/deploy.lock --body /tmp/demo-a.txt --if-none-match '*'
\`\`\`

The second call fails with \`PreconditionFailed\`. That is a distributed lock in one header.

## Multipart upload

A single \`PutObject\` can carry up to **5 GB**. Beyond that, and in practice above roughly 100 MB, you use **multipart upload**:

1. \`CreateMultipartUpload\` returns an \`UploadId\`.
2. \`UploadPart\` sends parts of **5 MiB to 5 GiB** (the last part can be smaller), up to **10,000 parts**, in parallel and in any order. A failed part is retried on its own.
3. \`CompleteMultipartUpload\` stitches the parts into one object, in part-number order.

\`aws s3 cp\` and the SDK transfer managers do this automatically above a threshold (8 MB by default for the CLI). Do it by hand once to see the moving parts:

\`\`\`bash
dd if=/dev/urandom of=/tmp/demo-part1 bs=1M count=5 2>/dev/null; echo tail > /tmp/demo-part2
UPLOAD=$(aws s3api create-multipart-upload --bucket demo-objects --key big/blob.bin --query UploadId --output text)
E1=$(aws s3api upload-part --bucket demo-objects --key big/blob.bin --upload-id "$UPLOAD" --part-number 1 --body /tmp/demo-part1 --query ETag --output text)
E2=$(aws s3api upload-part --bucket demo-objects --key big/blob.bin --upload-id "$UPLOAD" --part-number 2 --body /tmp/demo-part2 --query ETag --output text)
aws s3api complete-multipart-upload --bucket demo-objects --key big/blob.bin --upload-id "$UPLOAD" \
  --multipart-upload "{\"Parts\":[{\"ETag\":$E1,\"PartNumber\":1},{\"ETag\":$E2,\"PartNumber\":2}]}" --query ETag
\`\`\`

Note the \`-2\` suffix on the ETag. Now the trap: **an upload you never complete or abort keeps its parts, and you pay for them**, but they don't appear in \`list-objects\`. CI jobs that get killed mid-upload leak these for years.

\`\`\`bash
aws s3api create-multipart-upload --bucket demo-objects --key big/abandoned.bin --query UploadId --output text
aws s3api list-multipart-uploads --bucket demo-objects --query 'Uploads[].{key: Key, started: Initiated}'
\`\`\`

The fix is a lifecycle rule with \`AbortIncompleteMultipartUpload\`. Every bucket you own should have one, and you'll add one in the lab.

## Request rates and throttling

S3 scales by **partitioning the key space by prefix**. Each partitioned prefix supports at least **3,500 PUT/COPY/POST/DELETE and 5,500 GET/HEAD requests per second**, and S3 splits hot prefixes automatically. The split takes time, so a sudden spike can earn \`503 SlowDown\` responses. The SDKs retry those with backoff. Design so load spreads across prefixes (\`logs/<date>/<host>/…\` rather than every writer hammering one key), and treat \`SlowDown\` as a signal, not a bug.

## What a senior engineer does

- Treats objects as **immutable**: new version, new key, such as \`releases/app/<version>/\` or a content hash.
- Names buckets with account and region, manages them in IaC, and never reuses a retired name.
- Uses checksums, not ETags, for integrity, and conditional writes where concurrent writers are possible.
- Puts \`AbortIncompleteMultipartUpload\` on every bucket.
- Keeps queryable metadata outside S3 rather than listing to find things.

> **On real AWS:** S3 also offers **Express One Zone** directory buckets (single-digit-millisecond latency, one AZ, a different API flavour) for hot data such as ML training and analytics scratch. It trades durability across AZs for speed.
`,
    },

    // ------------------------------------------------------------ reading 2
    {
      id: "protection",
      kind: "reading",
      title: "Versioning, lifecycle, Object Lock and replication",
      minutes: 16,
      body: String.raw`
Durability is not the risk. S3 Standard is designed for 99.999999999% (eleven nines) durability across at least three AZs. Losing data to hardware is vanishingly rare. **Losing data to people and software is common**: a bad \`aws s3 sync --delete\`, a buggy job that overwrites objects, ransomware with stolen credentials, a Terraform \`destroy\` in the wrong workspace. This lesson covers the features that protect you from *yourself*, and the ones that keep the bill sane.

## Versioning

A bucket is in one of three states: **Unversioned** (the default), **Enabled**, or **Suspended**. Once enabled, it can never return to unversioned, only to suspended. With versioning on, every PUT creates a new version, and a plain DELETE doesn't delete anything. It adds a **delete marker** on top of the version stack.

<figure class="diagram">
<svg viewBox="0 0 640 230" role="img" aria-label="A versioned key is a stack: a delete marker on top hides older versions, which can be restored">
  <rect x="10" y="10" width="300" height="210" rx="10" class="d-box d-outer"/>
  <text x="26" y="34" class="d-label">key: releases/web/current.json</text>
  <rect x="30" y="50" width="260" height="36" rx="6" class="d-box d-danger"/><text x="160" y="73" text-anchor="middle" class="d-label">delete marker (latest)</text>
  <rect x="30" y="96" width="260" height="36" rx="6" class="d-box"/><text x="160" y="119" text-anchor="middle" class="d-small">version 3: "2.1.0-broken" (noncurrent)</text>
  <rect x="30" y="142" width="260" height="36" rx="6" class="d-box d-ok"/><text x="160" y="165" text-anchor="middle" class="d-small">version 2: "2.0.0" (noncurrent)</text>
  <rect x="30" y="188" width="260" height="24" rx="6" class="d-box d-dim"/><text x="160" y="205" text-anchor="middle" class="d-small">version 1 …</text>
  <rect x="350" y="40" width="280" height="56" rx="8" class="d-box"/>
  <text x="490" y="63" text-anchor="middle" class="d-label">GET key → 404</text><text x="490" y="82" text-anchor="middle" class="d-small">the marker hides everything below</text>
  <rect x="350" y="110" width="280" height="56" rx="8" class="d-box d-accent"/>
  <text x="490" y="133" text-anchor="middle" class="d-label">DELETE ?versionId=marker</text><text x="490" y="152" text-anchor="middle" class="d-small">undelete: version 3 is current again</text>
  <rect x="350" y="180" width="280" height="40" rx="8" class="d-box d-ok"/>
  <text x="490" y="205" text-anchor="middle" class="d-small">COPY version 2 onto the key = roll back</text>
  <path d="M290 68 H348" class="d-arrow"/><path d="M290 114 H348" class="d-arrow d-dashed"/><path d="M290 160 C320 160 320 200 348 200" class="d-arrow d-dashed"/>
</svg>
<figcaption>Versioning turns every key into a stack. Deleting the marker undeletes. Copying an old version onto the key rolls back while keeping the history.</figcaption>
</figure>

\`\`\`bash
aws s3api create-bucket --bucket demo-versions
aws s3api put-bucket-versioning --bucket demo-versions --versioning-configuration Status=Enabled
echo good > /tmp/demo-v.txt; aws s3api put-object --bucket demo-versions --key app.json --body /tmp/demo-v.txt --query VersionId
echo bad  > /tmp/demo-v.txt; aws s3api put-object --bucket demo-versions --key app.json --body /tmp/demo-v.txt --query VersionId
aws s3api delete-object --bucket demo-versions --key app.json
aws s3api list-object-versions --bucket demo-versions \
  --query '{versions: Versions[].[VersionId,IsLatest], markers: DeleteMarkers[].[VersionId,IsLatest]}'
\`\`\`

Things to know:

- **Deleting a specific version ID is permanent.** That is the operation to guard: with Object Lock, with MFA delete, and by denying \`s3:DeleteObjectVersion\` to everyone except a break-glass role.
- **Noncurrent versions are billed like any other data.** A job that rewrites a 10 GB file every hour adds 240 GB a day of history. Versioning without a noncurrent-version lifecycle rule is a slowly growing bill.
- **Suspending versioning doesn't delete history.** New writes get version ID \`null\` and overwrite each other, but the old versions stay until you remove them.

## MFA delete

MFA delete requires an MFA code to permanently delete a version or to change the versioning state. It sounds great and is rarely used. Only the **root user** can enable it, only through the API or CLI, and it can't be combined with lifecycle configuration. Most organisations get the same protection more operably from **Object Lock**, plus SCPs that deny \`s3:DeleteObjectVersion\` and \`s3:PutBucketVersioning\`.

## Object Lock: write once, read many

Object Lock makes a version **undeletable and unoverwritable until a date**. It requires versioning, and you can enable it at bucket creation or later on a versioned bucket. Two modes:

| | Governance | Compliance |
|---|---|---|
| Who can delete or shorten retention early? | Principals with \`s3:BypassGovernanceRetention\`, sending the bypass header | **Nobody, including the root user**, until the date passes |
| Use it for | Protecting against accidents and most attackers; testing your retention setup | Regulatory WORM (SEC 17a-4, FINRA), ransomware-proof backups |

Separately, a **legal hold** locks a version indefinitely until someone with \`s3:PutObjectLegalHold\` removes it.

\`\`\`bash
aws s3api create-bucket --bucket demo-lock --object-lock-enabled-for-bucket
V=$(aws s3api put-object --bucket demo-lock --key audit/2026-11.log --body /tmp/demo-v.txt \
  --object-lock-mode GOVERNANCE --object-lock-retain-until-date 2030-01-01T00:00:00Z --query VersionId --output text)
aws s3api delete-object --bucket demo-lock --key audit/2026-11.log --version-id "$V"
aws s3api delete-object --bucket demo-lock --key audit/2026-11.log --version-id "$V" --bypass-governance-retention
\`\`\`

The first delete is refused. The second succeeds only because governance mode allows a privileged bypass. **Never test with compliance mode on a real account**: a 10-year compliance retention on a test bucket means paying for that data for 10 years, and AWS Support cannot remove it. Start with governance, then switch to compliance once you've verified the retention period.

## Storage classes

| Class | For | Min. duration billed | Retrieval |
|---|---|---|---|
| **Standard** | Hot data, anything accessed often | none | ms |
| **Intelligent-Tiering** | Unknown or changing access patterns | none (small monitoring fee per object) | ms (optional archive tiers are async) |
| **Standard-IA** | Infrequent access, still needs ms latency | 30 days, 128 KB min. size | ms, plus a per-GB retrieval fee |
| **One Zone-IA** | Re-creatable data; lives in **one AZ** | 30 days, 128 KB | ms, plus a retrieval fee |
| **Glacier Instant Retrieval** | Archives read about once a quarter | 90 days, 128 KB | ms, with a higher retrieval fee |
| **Glacier Flexible Retrieval** | Backups and archives | 90 days | minutes to hours, needs **RestoreObject** |
| **Glacier Deep Archive** | Compliance archives read almost never | 180 days | 12–48 hours, needs RestoreObject |

The pitfalls are in the small print. **Minimum durations** mean deleting a Glacier Flexible object after 10 days still bills 90. **Per-object overheads** (the 128 KB minimum, about 40 KB of index metadata for Glacier classes, and per-request transition charges) mean that *moving millions of tiny objects to a colder class can cost more than leaving them in Standard*. Glacier Flexible and Deep Archive objects can't be read until restored:

\`\`\`bash
aws s3api put-object --bucket demo-objects --key archive/2019.tar --body /tmp/demo-a.txt --storage-class GLACIER --query ETag
aws s3api get-object --bucket demo-objects --key archive/2019.tar /tmp/demo-out.tar
aws s3api restore-object --bucket demo-objects --key archive/2019.tar --restore-request Days=1
\`\`\`

The GET fails with \`InvalidObjectState\`, just as it does on AWS. A restore makes a temporary copy readable for the requested number of days.

## Lifecycle rules

A lifecycle configuration is a list of rules. Each rule has a **filter** (prefix, object tags, object size, or the whole bucket) and **actions**:

- **Transitions**: move current versions to a colder class after N days.
- **Expiration**: delete current versions after N days. On a versioned bucket this *adds a delete marker*; it doesn't free space.
- **NoncurrentVersionTransition / NoncurrentVersionExpiration**: the same for old versions, counted from when they *became* noncurrent. \`NewerNoncurrentVersions\` keeps the latest N old versions regardless of age.
- **ExpiredObjectDeleteMarker**: clean up delete markers that no longer hide anything.
- **AbortIncompleteMultipartUpload**: discard parts of uploads that never completed.

\`\`\`json
{ "Rules": [
  { "ID": "logs", "Status": "Enabled", "Filter": { "Prefix": "logs/" },
    "Transitions": [ { "Days": 30, "StorageClass": "STANDARD_IA" }, { "Days": 90, "StorageClass": "GLACIER" } ],
    "Expiration": { "Days": 365 } },
  { "ID": "hygiene", "Status": "Enabled", "Filter": {},
    "NoncurrentVersionExpiration": { "NoncurrentDays": 30, "NewerNoncurrentVersions": 3 },
    "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 7 } }
] }
\`\`\`

Lifecycle is **asynchronous**: S3 evaluates rules about once a day and may take longer to act. Billing stops when an object becomes eligible, not when it is physically removed. Don't use lifecycle as a precise timer. Since 2024, S3 doesn't transition objects smaller than 128 KB by default, which is why the API returns \`TransitionDefaultMinimumObjectSize\`.

> **On real AWS:** transitions to Standard-IA or One Zone-IA require at least 30 days in Standard. The emulator accepts shorter transitions, so don't rely on it to catch that mistake. \`terraform plan\` won't catch it either; only the real API will.

## Replication

**Cross-Region Replication (CRR)** and **Same-Region Replication (SRR)** copy new object versions asynchronously to another bucket, optionally in another account. Requirements and gotchas:

- Versioning must be enabled on **both** buckets, and S3 needs an **IAM role** that can read the source and write the destination. For SSE-KMS objects, the role needs the KMS keys on both sides and the rule must opt in.
- Only objects written **after** the rule exists replicate. Existing objects need **S3 Batch Replication**.
- **Deletes are special.** Delete markers replicate only if you enable \`DeleteMarkerReplication\`, and deletes of a specific version *never* replicate. That is what makes a replica in a locked-down account a decent ransomware defence.
- Replication is usually seconds, but there's no bound unless you pay for **Replication Time Control** (99.99% of objects within 15 minutes, with metrics).
- Replication is not backup. If corruption is written, the corruption replicates. Pair it with versioning, Object Lock and lifecycle rules on the destination.

The emulator implements replication: objects in the source show \`ReplicationStatus: PENDING\` or \`COMPLETED\`, and copies in the destination show \`REPLICA\`.

## What a senior engineer does

- Enables versioning on every bucket whose contents matter, with a noncurrent-version expiry so the history has a cost ceiling.
- Puts critical backups and audit logs in a **separate account** with replication, Object Lock and tight deletion controls.
- Models storage classes on access patterns and object sizes before writing transition rules, and checks the bill a month later.
- Knows the restore procedure (undelete, roll back to a version, restore from Glacier) and has practised it. You'll practise it in the second lab.
`,
    },

    // ------------------------------------------------------------ reading 3
    {
      id: "security",
      kind: "reading",
      title: "Securing buckets: encryption, access control, presigned URLs",
      minutes: 16,
      body: String.raw`
Public S3 buckets have been behind a long list of data breaches. AWS has since changed the defaults: since April 2023 every new bucket has Block Public Access on and ACLs disabled, and since January 2023 every new object is encrypted. Defaults are not configuration, though. You still need to know what each control does, so you can set it explicitly in IaC, detect drift, and handle the cases where the defaults aren't enough.

## How a request is authorised

<figure class="diagram">
<svg viewBox="0 0 640 200" role="img" aria-label="An S3 GET passes Block Public Access, then policy evaluation, then KMS decrypt authorisation">
  <rect x="10" y="70" width="100" height="60" rx="8" class="d-box"/><text x="60" y="97" text-anchor="middle" class="d-label">Request</text><text x="60" y="115" text-anchor="middle" class="d-small">signed or presigned</text>
  <rect x="140" y="60" width="130" height="80" rx="8" class="d-box d-accent"/><text x="205" y="92" text-anchor="middle" class="d-label">Block Public</text><text x="205" y="110" text-anchor="middle" class="d-label">Access</text><text x="205" y="128" text-anchor="middle" class="d-small">account + bucket</text>
  <rect x="300" y="60" width="160" height="80" rx="8" class="d-box"/><text x="380" y="88" text-anchor="middle" class="d-label">Policy evaluation</text><text x="380" y="106" text-anchor="middle" class="d-small">explicit Deny wins; then</text><text x="380" y="122" text-anchor="middle" class="d-small">identity OR bucket Allow</text>
  <rect x="490" y="60" width="140" height="80" rx="8" class="d-box"/><text x="560" y="92" text-anchor="middle" class="d-label">KMS</text><text x="560" y="110" text-anchor="middle" class="d-small">kms:Decrypt allowed by</text><text x="560" y="126" text-anchor="middle" class="d-small">key policy + IAM?</text>
  <path d="M110 100 H138" class="d-arrow"/><path d="M270 100 H298" class="d-arrow"/><path d="M460 100 H488" class="d-arrow"/>
  <text x="205" y="170" text-anchor="middle" class="d-small">blocks public grants</text>
  <text x="380" y="170" text-anchor="middle" class="d-small">cross-account: both sides must allow</text>
  <text x="560" y="170" text-anchor="middle" class="d-small">SSE-KMS only</text>
</svg>
<figcaption>Every gate must pass. SSE-KMS adds a second, independent permission: a reader needs <code>s3:GetObject</code> <em>and</em> <code>kms:Decrypt</code> on the key.</figcaption>
</figure>

## Encryption at rest

| Option | Who holds the key | What you get | Watch out for |
|---|---|---|---|
| **SSE-S3** (\`AES256\`) | S3 | Free, transparent, the default | Anyone allowed \`s3:GetObject\` can read |
| **SSE-KMS**, AWS managed key (\`aws/s3\`) | KMS, AWS-managed policy | CloudTrail record of key use | Can't share cross-account; you can't edit the key policy |
| **SSE-KMS**, customer managed key | KMS, **your key policy** | A second authorisation layer, cross-account sharing, rotation, revocation by disabling the key | KMS request cost and quotas; use **bucket keys** |
| **DSSE-KMS** | KMS | Two layers of encryption, for specific compliance regimes | Higher cost; no bucket keys |
| **SSE-C** | **You**, sent with every request | S3 never stores the key | Lose the key and you lose the data; every reader needs the key |

For anything sensitive, the senior default is **SSE-KMS with a customer managed key and bucket keys enabled**. The key policy becomes an independent control: an engineer who has been granted \`s3:*\` by mistake still can't read the data without \`kms:Decrypt\`. Disabling the key is an emergency brake that makes every object unreadable at once.

Without **bucket keys**, every object PUT and GET is a KMS API call. At thousands of requests per second you hit KMS quotas (\`ThrottlingException\` surfacing as S3 errors) and pay for every request. With \`BucketKeyEnabled\`, S3 derives a short-lived bucket-level data key from your KMS key and reduces KMS traffic by up to 99%. There's no downside for most workloads.

\`\`\`bash
aws s3api create-bucket --bucket demo-secure
aws s3api get-bucket-encryption --bucket demo-secure --query 'ServerSideEncryptionConfiguration.Rules[0]'
aws s3api get-public-access-block --bucket demo-secure
aws s3api get-bucket-ownership-controls --bucket demo-secure
\`\`\`

These are the defaults every new bucket gets: SSE-S3, all four Block Public Access settings, and \`BucketOwnerEnforced\`. SSE-C looks like this. Note that every read must present the same key, which is why SSE-C rarely survives contact with real tooling:

\`\`\`bash
openssl rand 32 > /tmp/demo-ssec.key
aws s3api put-object --bucket demo-secure --key ssec.txt --body /tmp/demo-a.txt \
  --sse-customer-algorithm AES256 --sse-customer-key fileb:///tmp/demo-ssec.key --query SSECustomerAlgorithm
aws s3api get-object --bucket demo-secure --key ssec.txt /tmp/demo-ssec.out
aws s3api get-object --bucket demo-secure --key ssec.txt /tmp/demo-ssec.out \
  --sse-customer-algorithm AES256 --sse-customer-key fileb:///tmp/demo-ssec.key --query SSECustomerAlgorithm
\`\`\`

Many organisations block SSE-C outright, with a bucket policy or SCP that denies \`s3:PutObject\` when \`s3:x-amz-server-side-encryption-customer-algorithm\` is present.

## Block Public Access

Four independent switches, settable per bucket and per account (the account level overrides buckets):

- **BlockPublicAcls**: reject requests that *add* a public ACL.
- **IgnorePublicAcls**: ignore any public ACLs that already exist.
- **BlockPublicPolicy**: reject bucket policies that grant public access.
- **RestrictPublicBuckets**: if a public policy exists anyway, only AWS services and principals in the bucket owner's account can use it.

Turn all four on at the **account** level (\`aws s3control put-public-access-block\`), and use an SCP to deny \`s3:PutAccountPublicAccessBlock\` so nobody can turn it off. Serve public content through **CloudFront with Origin Access Control**, never from a public bucket. The emulator enforces the bucket-level settings:

\`\`\`bash
aws s3api put-bucket-policy --bucket demo-secure --policy '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":"*","Action":"s3:GetObject","Resource":"arn:aws:s3:::demo-secure/*"}]}'
\`\`\`

\`AccessDenied … because public policies are prevented by the BlockPublicPolicy setting\`. That's what you want to see.

> **Emulator note:** the account-level \`s3control\` API isn't reachable in the emulator (the CLI prepends the account ID to the endpoint hostname). Bucket-level settings behave like AWS.

## Bucket policies vs ACLs, and Object Ownership

**ACLs** are S3's original, pre-IAM permission system: per-object grants to canonical user IDs or groups such as "AllUsers". They're hard to audit, and with them an object uploaded by another account could be *owned by that account*, so the bucket owner couldn't read it. **Object Ownership = BucketOwnerEnforced** disables ACLs entirely: the bucket owner owns every object, and access is decided only by policies. It is the default for new buckets and should be set explicitly everywhere. The rare exception is a legacy integration that still needs ACLs, such as CloudFront standard logging (legacy).

\`\`\`bash
aws s3api put-bucket-acl --bucket demo-secure --acl public-read
\`\`\`

\`AccessControlListNotSupported\`: with ACLs disabled, the request is refused outright.

**Bucket policies** are resource-based IAM policies. Within one account, *either* an identity policy *or* the bucket policy can allow access. Across accounts, *both* must. An explicit Deny anywhere wins. The patterns you'll write over and over:

\`\`\`json
{ "Version": "2012-10-17", "Statement": [
  { "Sid": "DenyInsecureTransport", "Effect": "Deny", "Principal": "*", "Action": "s3:*",
    "Resource": ["arn:aws:s3:::ci-artifacts-000000000000", "arn:aws:s3:::ci-artifacts-000000000000/*"],
    "Condition": { "Bool": { "aws:SecureTransport": "false" } } },
  { "Sid": "DenyWrongEncryptionHeader", "Effect": "Deny", "Principal": "*", "Action": "s3:PutObject",
    "Resource": "arn:aws:s3:::ci-artifacts-000000000000/*",
    "Condition": { "Null": { "s3:x-amz-server-side-encryption": "false" },
                   "StringNotEquals": { "s3:x-amz-server-side-encryption": "aws:kms" } } }
] }
\`\`\`

- **TLS only.** \`aws:SecureTransport\` is \`false\` for plain HTTP requests. Note that the bucket *and* object ARNs both appear: \`s3:*\` covers bucket-level and object-level actions.
- **Encryption headers.** The classic "deny PutObject unless the header says \`aws:kms\`" policy predates default encryption, and it rejects clients that send no header at all and would have been encrypted by the bucket default anyway. The \`Null\` + \`StringNotEquals\` pair above denies only a header that's *present and wrong*. Conditions in one block are ANDed. Since default encryption exists, the bucket default does the encrypting and the policy only stops clients choosing something weaker.
- **Other useful conditions:** \`aws:PrincipalOrgID\` (only my organisation), \`aws:SourceVpce\` (only through my VPC endpoint), \`s3:x-amz-server-side-encryption-aws-kms-key-id\` (only my key).

The lock-out pitfall: a clever \`Deny\` such as "everyone except the deploy role" (written with \`NotPrincipal\` or an \`aws:PrincipalArn\` condition) can lock out your own administrators, and sometimes the deploy role too if its session ARN doesn't match the pattern. The account root user can always delete a bucket policy. Know who holds that break-glass access before you write clever denies.

## Presigned URLs

A presigned URL is a request **signed in advance** by someone with access, with the signature in the query string. Anyone holding the URL can perform that one operation (GET or PUT on that key) until it expires. Nothing is created server-side, so there's nothing to look up, list or revoke individually.

\`\`\`bash
URL=$(aws s3 presign s3://demo-objects/README.md --expires-in 300)
echo "$URL" | tr '?&' '\n\n' | head -8
curl -sS --cacert "$AWS_CA_BUNDLE" "$URL"
curl -sS --cacert "$AWS_CA_BUNDLE" -o /dev/null -w '%{http_code}\n' "$URL&tampered=1"
\`\`\`

The tampered URL returns 403 \`SignatureDoesNotMatch\`, because the query string is part of what was signed. Rules that matter in production:

- **The URL carries the signer's permissions, evaluated when it's used.** If the signer loses access, the URL stops working. That's the only way to revoke one early.
- **Expiry is capped by the credentials.** SigV4 allows up to 7 days, but a URL signed with temporary role credentials (Lambda, ECS, EC2 roles) dies when that session expires, often within hours. "Our 7-day download links break after 6 hours" is this bug.
- **Keep expiry short** (minutes for downloads, seconds to minutes for uploads), and log who generated which URL.
- For browser uploads, use **presigned POST** with conditions (content-length range, key prefix, content type), not an unconstrained presigned PUT.

## What a senior engineer does

- Sets Block Public Access at the account level and pins it with an SCP. Public content goes through CloudFront with OAC.
- Sets \`BucketOwnerEnforced\` and default SSE-KMS with a customer managed key and bucket keys on every bucket holding non-public data, explicitly in IaC.
- Adds the TLS-only deny to every bucket policy. It's cheap and security scanners flag its absence.
- Prefers short-lived presigned URLs generated by a service that authorises the user first, over sharing credentials or making objects public.
`,
    },

    // ------------------------------------------------------------ reading 4
    {
      id: "pipelines",
      kind: "reading",
      title: "S3 in the delivery pipeline: artifacts, Terraform state, events",
      minutes: 12,
      body: String.raw`
For a DevOps engineer, S3 is infrastructure plumbing. Three uses come up in almost every organisation: storing build artifacts, storing Terraform state, and triggering work when files arrive.

## S3 as an artifact store

A CI pipeline builds once and deploys the same bytes to every environment. S3 is where those bytes live between build and deploy.

\`\`\`text
s3://ci-artifacts-000000000000/
  releases/app/1.4.2/app-1.4.2.tar.gz
  releases/app/1.4.2/SHA256SUMS
  releases/app/1.4.2/sbom.spdx.json
  builds/app/3f9c2e1/app.tar.gz        ← by git commit, for every main-branch build
\`\`\`

- **Immutable keys.** A version or commit identifies exactly one set of bytes. Deploying "1.4.2" must always mean the same thing. Never overwrite: use \`--if-none-match '*'\` on upload so a re-run job fails instead of silently replacing the artifact. Versioning is the backstop for the mistake you didn't anticipate.
- **Promote by reference.** Promotion from staging to prod changes *which key* prod deploys. It doesn't copy or rebuild.
- **Integrity.** Publish a SHA-256 alongside the artifact (or rely on S3's checksum headers) and verify it at deploy time.
- **Retention.** Lifecycle rules expire \`builds/\` after 30–90 days and keep \`releases/\` longer, and \`AbortIncompleteMultipartUpload\` cleans up killed jobs.
- **Cross-account deploys.** The prod account's deploy role reads artifacts from the tooling account. That needs a bucket policy allowing the role **and** a KMS key policy allowing \`kms:Decrypt\` for it. Forgetting the key policy is the most common cause of a "403 on an object I definitely have access to".

## S3 as the Terraform state backend

Terraform state maps your code to real resource IDs. Lose it and Terraform forgets what it manages. Corrupt it and the next apply may try to recreate production. State also contains **secrets in plain text** (database passwords, generated keys). Treat the state bucket as one of the most sensitive buckets you own.

\`\`\`hcl
terraform {
  backend "s3" {
    bucket       = "tfstate-000000000000-us-east-1"
    key          = "network/prod/terraform.tfstate"   # one key per stack and environment
    region       = "us-east-1"
    encrypt      = true
    kms_key_id   = "alias/tfstate"
    use_lockfile = true   # S3-native locking (Terraform 1.10+), no DynamoDB table needed
  }
}
\`\`\`

- **Versioning on.** Recovering from a bad state write is "copy the previous version back". You'll do exactly that operation in the next lab.
- **Locking.** Two concurrent applies against one state corrupt it. \`use_lockfile\` writes a \`.tflock\` object with a conditional write (the \`If-None-Match\` trick from the first lesson). The older DynamoDB lock table is deprecated. Existing setups can run both during migration.
- **Access.** Only CI deploy roles and a break-glass role can write. Engineers get read access at most, because the state holds secrets. Use SSE-KMS with a customer managed key so access to the bucket alone isn't enough.
- **Blast radius.** Split state per stack and environment (\`network/prod\`, \`app/staging\`) so one bad apply can't touch everything, and so plans stay fast.
- **Bootstrap.** The state bucket can't be managed by the state it stores. Create it once with a small separate stack (or CloudFormation), with deletion protection through a policy.

## Event notifications

S3 can emit an event when objects are created, deleted, restored or replicated, and deliver it to **SQS**, **SNS**, **Lambda**, or **EventBridge**. That is the backbone of "file lands, pipeline runs" designs: ingest jobs, virus scanning, thumbnailing, triggering deploys.

<figure class="diagram">
<svg viewBox="0 0 640 170" role="img" aria-label="S3 event notifications deliver to SQS, SNS, Lambda or EventBridge; destination policies must allow S3">
  <rect x="10" y="55" width="150" height="60" rx="8" class="d-box d-accent"/><text x="85" y="80" text-anchor="middle" class="d-label">S3 bucket</text><text x="85" y="98" text-anchor="middle" class="d-small">filter: prefix + suffix</text>
  <rect x="250" y="10" width="150" height="40" rx="8" class="d-box"/><text x="325" y="35" text-anchor="middle" class="d-label">SQS queue</text>
  <rect x="250" y="65" width="150" height="40" rx="8" class="d-box"/><text x="325" y="90" text-anchor="middle" class="d-label">SNS / Lambda</text>
  <rect x="250" y="120" width="150" height="40" rx="8" class="d-box"/><text x="325" y="145" text-anchor="middle" class="d-label">EventBridge</text>
  <path d="M160 75 C200 75 210 30 248 30" class="d-arrow"/><path d="M160 85 H248" class="d-arrow"/><path d="M160 95 C200 95 210 140 248 140" class="d-arrow d-dashed"/>
  <rect x="440" y="10" width="190" height="40" rx="8" class="d-box d-dim"/><text x="535" y="35" text-anchor="middle" class="d-small">queue policy allows s3.amazonaws.com</text>
  <rect x="440" y="120" width="190" height="40" rx="8" class="d-box d-dim"/><text x="535" y="145" text-anchor="middle" class="d-small">rules fan out, richer filters</text>
  <path d="M400 30 H438" class="d-arrow d-dashed"/><path d="M400 140 H438" class="d-arrow d-dashed"/>
</svg>
<figcaption>Direct destinations need a resource policy that lets S3 deliver. EventBridge needs only a bucket setting, and its rules can fan out to many targets.</figcaption>
</figure>

What production experience teaches:

- **Delivery is at-least-once and unordered.** Consumers must be idempotent: use the object key plus version ID or \`sequencer\` as the deduplication key, and re-read the object rather than trusting the event alone.
- **The destination must allow S3.** An SQS queue needs a queue policy that allows \`s3.amazonaws.com\` to \`sqs:SendMessage\`, scoped with \`aws:SourceArn\` (the bucket) and \`aws:SourceAccount\` so other buckets can't spam it. S3 validates this when you save the configuration: without the policy you get \`Unable to validate the following destination configurations\`. The emulator behaves the same.
- **S3 sends an \`s3:TestEvent\` first** when you configure a queue. Consumers must tolerate messages that aren't object events.
- **Rules can't overlap.** Two rules with overlapping prefix and suffix for the same event type are rejected. Use EventBridge when several consumers need the same events.
- **The recursion trap.** A Lambda triggered by \`ObjectCreated\` that writes its output to the same bucket and prefix triggers itself, forever, and bills you for it. Write outputs to a different bucket or a prefix outside the filter.
- **Events aren't an inventory.** They can be delayed, and rarely lost in a misconfiguration. For "did we process every file?" reconcile against S3 Inventory or a listing.

## Where S3 is the wrong tool

Small records that change constantly (use DynamoDB), file locking and POSIX semantics (use EFS), a database's data files or a boot disk (use EBS), and anything needing single-digit-millisecond latency for every request (DynamoDB, ElastiCache, or S3 Express One Zone). The last lesson covers EBS and EFS.
`,
    },

    // ------------------------------------------------------------ reading 5
    {
      id: "ebs-efs",
      kind: "reading",
      title: "Block and file storage: EBS and EFS",
      minutes: 12,
      body: String.raw`
S3 is object storage over HTTP. Many workloads need storage the operating system mounts: a root disk, a database's data directory, a directory shared by a fleet of containers. On AWS those are **EBS** (block) and **EFS** (file).

## EBS: network block devices

An EBS volume is a virtual disk that lives in **one Availability Zone** and attaches to **one instance in that AZ** at a time. (io1/io2 Multi-Attach to several instances is an exception for clustered applications that coordinate writes themselves.) It's replicated within its AZ, so it survives a disk failure but not the loss of the AZ.

| Type | Performance model | Use |
|---|---|---|
| **gp3** | 3,000 IOPS and 125 MiB/s baseline *at any size*; provision IOPS (up to 80,000) and throughput separately | The default for almost everything: root volumes, most databases |
| **gp2** | IOPS tied to size (3 per GiB) with burst credits | Legacy. Migrate to gp3: it's about 20% cheaper and has no burst cliff |
| **io2 Block Express** | Provisioned IOPS (up to 256,000), sub-millisecond latency, 99.999% durability | Large production databases where latency is the product |
| **st1 / sc1** | HDD, throughput-oriented | Big sequential scans, cold data. Not for boot volumes |

The gp2 trap is worth knowing because it still causes outages: a small gp2 volume can burst to 3,000 IOPS until its credit bucket empties, then drops to its baseline (a 100 GiB volume gets 300 IOPS). The database "suddenly" becomes slow hours into a load test. gp3 has no credits.

\`\`\`bash
aws ec2 create-volume --availability-zone us-east-1a --size 100 --volume-type gp3 --iops 100
VOL=$(aws ec2 create-volume --availability-zone us-east-1a --size 100 --volume-type gp3 --iops 6000 --throughput 250 \
  --tag-specifications 'ResourceType=volume,Tags=[{Key=Name,Value=demo-data}]' --query VolumeId --output text)
aws ec2 wait volume-available --volume-ids "$VOL"
aws ec2 describe-volumes --volume-ids "$VOL" --query 'Volumes[0].{type: VolumeType, iops: Iops, mibps: Throughput, az: AvailabilityZone, encrypted: Encrypted}'
\`\`\`

The first call fails with the same validation message AWS gives (gp3 provisions 3,000 to 80,000 IOPS).

**Elastic Volumes** let you grow a volume, change its type or change its performance while attached, with no downtime. You then extend the partition and filesystem inside the OS (\`growpart\`, \`resize2fs\`/\`xfs_growfs\`). After a modification you must wait for it to finish optimising, and AWS allows one modification per volume every 6 hours. Plan capacity changes; don't count on doing three in an incident. Volumes can grow but **never shrink**.

### Snapshots

A snapshot is a point-in-time, **incremental** copy of a volume, stored regionally (in S3, managed by AWS). The first snapshot copies all used blocks; later ones copy only changed blocks. Deleting an old snapshot is safe, because AWS keeps any blocks later snapshots still need.

- Snapshots are **crash-consistent**, like pulling the power cord. For databases, flush and freeze the filesystem, or use the application's own backup (RDS does this for you).
- A volume restored from a snapshot **loads blocks lazily from S3**: first reads are slow until each block has been touched. For latency-sensitive restores, use **Fast Snapshot Restore** (paid, per AZ) or read the whole device once before going live.
- Automate them with **Data Lifecycle Manager** or **AWS Backup**, copy them to another region for DR, and use **Recycle Bin** retention rules so an accidental or malicious delete can be undone.

\`\`\`bash
SNAP=$(aws ec2 create-snapshot --volume-id "$VOL" --description "demo before upgrade" \
  --tag-specifications 'ResourceType=snapshot,Tags=[{Key=Name,Value=demo-data-pre-upgrade}]' --query SnapshotId --output text)
aws ec2 wait snapshot-completed --snapshot-ids "$SNAP" && aws ec2 describe-snapshots --snapshot-ids "$SNAP" --query 'Snapshots[0].[State,Encrypted]'
\`\`\`

### Encryption by default

EBS encryption uses KMS, costs nothing extra, and has no meaningful performance impact. Turn on **encryption by default** in every region of every account. It's a per-region setting, so a new region you start using is unencrypted until you set it. An encrypted volume produces encrypted snapshots, and those can be shared cross-account only if they use a customer managed key that the other account may use.

\`\`\`bash
aws ec2 get-ebs-encryption-by-default
aws ec2 enable-ebs-encryption-by-default
\`\`\`

> **Emulator note:** volumes, snapshots, Elastic Volumes state and encryption-by-default work. \`GetEbsDefaultKmsKeyId\` returns 501 NotImplemented, and creating a volume from a snapshot returns \`InvalidSnapshot.NotFound\`, so restores can't be practised here.

Other EBS facts that cost money: the root volume is deleted on instance termination by default, but **additional volumes are not** (\`DeleteOnTermination=false\`), so terminated fleets leave orphaned volumes behind. Look for \`available\` volumes in your cost reviews.

## EFS: managed NFS

EFS is a managed **NFSv4.1** file system that many clients mount at once: EC2 instances, ECS tasks, EKS pods and Lambda functions. A Regional file system stores data across multiple AZs and grows and shrinks automatically. You pay for what you store.

<figure class="diagram">
<svg viewBox="0 0 640 210" role="img" aria-label="An EFS file system has one mount target per AZ; clients mount the target in their own AZ">
  <rect x="10" y="10" width="620" height="190" rx="10" class="d-box d-outer"/>
  <text x="26" y="34" class="d-label">VPC (region us-east-1)</text>
  <rect x="30" y="46" width="280" height="90" rx="8" class="d-box"/><text x="46" y="66" class="d-small">AZ us-east-1a, private subnet</text>
  <rect x="330" y="46" width="280" height="90" rx="8" class="d-box"/><text x="346" y="66" class="d-small">AZ us-east-1b, private subnet</text>
  <rect x="46" y="78" width="110" height="44" rx="6" class="d-box d-dim"/><text x="101" y="104" text-anchor="middle" class="d-small">ECS tasks / EC2</text>
  <rect x="186" y="78" width="110" height="44" rx="6" class="d-box d-accent"/><text x="241" y="98" text-anchor="middle" class="d-small">mount target</text><text x="241" y="113" text-anchor="middle" class="d-small">ENI, SG :2049</text>
  <rect x="346" y="78" width="110" height="44" rx="6" class="d-box d-dim"/><text x="401" y="104" text-anchor="middle" class="d-small">EKS pods / Lambda</text>
  <rect x="486" y="78" width="110" height="44" rx="6" class="d-box d-accent"/><text x="541" y="98" text-anchor="middle" class="d-small">mount target</text><text x="541" y="113" text-anchor="middle" class="d-small">ENI, SG :2049</text>
  <path d="M156 100 H184" class="d-arrow"/><path d="M456 100 H484" class="d-arrow"/>
  <rect x="160" y="150" width="320" height="40" rx="8" class="d-box d-ok"/><text x="320" y="175" text-anchor="middle" class="d-label">EFS file system (data spans AZs)</text>
  <path d="M241 122 V148" class="d-arrow"/><path d="M541 122 C541 160 520 170 482 170" class="d-arrow"/>
</svg>
<figcaption>Create one mount target per AZ, in a subnet each client AZ can reach, with a security group allowing NFS (TCP 2049) from the clients.</figcaption>
</figure>

- **Mount targets.** One per AZ, each an ENI with an IP in one of your subnets. Clients should mount the target in their own AZ: cross-AZ mounts work but add latency and data-transfer cost, and fail if that AZ fails. Forgetting the mount target in a new AZ is a classic "pods in us-east-1c can't mount" incident.
- **Security groups.** The mount target's SG must allow TCP 2049 from the clients' SG.
- **Access points** give each application its own root directory and enforce a POSIX user and group. They're the right way to share one file system between several services, and IAM policies can require them.
- **Throughput modes.** **Elastic** (the default, and the recommended choice) scales with demand and bills per GB transferred. **Bursting** ties throughput to stored size, with credits: the same cliff as gp2. **Provisioned** buys fixed throughput.
- **Storage classes and lifecycle.** Files not accessed for N days move to EFS Infrequent Access or Archive, which cost far less per GB. \`TransitionToPrimaryStorageClass=AFTER_1_ACCESS\` moves them back when they're read.
- **Encryption.** Encryption at rest is chosen at creation and can't be changed later. Encryption in transit is a mount option (\`mount -t efs -o tls\` with the EFS mount helper).
- **Not for databases.** NFS latency (around 1 ms or more per operation) and locking semantics make EFS a poor home for database files. Use EBS, or a managed database.

\`\`\`bash
FS=$(aws efs create-file-system --creation-token demo-shared --encrypted --throughput-mode elastic \
  --tags Key=Name,Value=demo-shared --query FileSystemId --output text)
aws efs describe-file-systems --file-system-id "$FS" --query 'FileSystems[0].{state: LifeCycleState, encrypted: Encrypted, throughput: ThroughputMode}'
aws efs put-lifecycle-configuration --file-system-id "$FS" \
  --lifecycle-policies TransitionToIA=AFTER_30_DAYS TransitionToPrimaryStorageClass=AFTER_1_ACCESS --query LifecyclePolicies
\`\`\`

> **Emulator note:** EFS file systems, lifecycle policies and access points work, but mount targets are not faithful: the emulator accepts two mount targets in the same AZ (AWS rejects that with \`MountTargetConflict\`) and reports addresses outside the subnet. Nothing actually mounts locally.

## Choosing

| | **S3** | **EBS** | **EFS** |
|---|---|---|---|
| Interface | HTTPS API (objects) | Block device (one instance) | NFSv4.1 (many clients) |
| Scope | Regional, multi-AZ | **One AZ** | Regional, multi-AZ (or One Zone) |
| Size | Unlimited; 5 TB per object | Up to 64 TiB per volume, provisioned | Elastic, pay per GB used |
| Latency | Tens of ms (single-digit with Express One Zone) | Sub-ms to about 1 ms | About 1 ms and up |
| Relative cost per GB | Lowest | Middle (you pay for provisioned size) | Highest (Standard class) |
| Backups | Versioning, replication, Object Lock | Snapshots | AWS Backup, replication |
| Typical use | Artifacts, state, logs, backups, data lakes | Boot volumes, self-managed databases | Shared content, CMS uploads, ML home directories, legacy apps needing a shared POSIX path |

There's also **FSx** for workloads with specific file system needs: FSx for Windows File Server (SMB, Active Directory), FSx for Lustre (HPC, high throughput linked to S3), and FSx for NetApp ONTAP and OpenZFS (enterprise NAS features).

Rule of thumb: **if your code can use an API, use S3.** Use EBS when software expects a local disk, and EFS when several machines must share a POSIX file tree.
`,
    },

    // ------------------------------------------------------------ lab 1
    {
      id: "artifact-bucket",
      kind: "lab",
      title: "Lab: a production-grade artifact bucket",
      minutes: 35,
      body: String.raw`
Your platform team needs a bucket to hold CI build artifacts for every service. It must satisfy the security baseline auditors check, keep costs bounded, and give the deploy tooling a way to hand out short-lived download links.

You'll build it the way you would in Terraform, one control at a time, so you can see each one in the API tab. The bucket name follows the \`<purpose>-<account-id>\` convention so it can't collide with anyone else's.

| Control | Value |
|---|---|
| KMS key | customer managed, alias \`alias/ci-artifacts\`, automatic rotation on |
| Bucket | \`ci-artifacts-000000000000\`, versioning **Enabled**, tags \`team=platform\`, \`purpose=build-artifacts\` |
| Default encryption | SSE-KMS with \`alias/ci-artifacts\`, **bucket key enabled** |
| Public access | all four Block Public Access settings on; Object Ownership \`BucketOwnerEnforced\` |
| Bucket policy | deny any request without TLS; deny uploads that ask for an encryption type other than \`aws:kms\` |
| Lifecycle | noncurrent versions expire after **30 days**; incomplete multipart uploads abort after **7 days** |

**Prepare lab** builds the artifact for you in \`dist/app-1.4.2.tar.gz\`. Watch the **API** tab while you work: every control is its own subresource call (\`PUT /?versioning\`, \`PUT /?encryption\`, \`PUT /?policy\`, …), which is exactly what Terraform's separate \`aws_s3_bucket_*\` resources map to.

> **On real AWS:** the TLS-deny statement rejects plain-HTTP requests. The emulator only listens on HTTPS, and the course terminal's inspector proxy forwards to it over HTTPS, so your requests count as secure transport and still succeed.
`,
      lab: {
        files: {
          "release/VERSION": "1.4.2\n",
          "release/app.sh": "#!/bin/sh\necho \"app 1.4.2\"\n",
        },
        setup: String.raw`
mkdir -p dist
tar -czf dist/app-1.4.2.tar.gz -C release .
sha256sum dist/app-1.4.2.tar.gz | tee dist/SHA256SUMS
`,
        tasks: [
          {
            id: "kms-key",
            title: "Create a customer managed key",
            description:
              "Create a symmetric KMS key for artifact encryption, give it the alias `alias/ci-artifacts`, and enable **automatic key rotation**.",
            hints: [
              "`aws kms create-key --description ci-artifacts --query KeyMetadata.KeyId --output text` gives you the key ID to capture.",
              "Then `aws kms create-alias --alias-name alias/ci-artifacts --target-key-id \"$KEY\"` and `aws kms enable-key-rotation --key-id \"$KEY\"`.",
            ],
            check: async (ctx) => {
              const arn = await keyArn(ctx, "alias/ci-artifacts");
              if (!arn) return "No KMS key with alias `alias/ci-artifacts` yet.";
              const rot = await ctx.tryAws(["kms", "get-key-rotation-status", "--key-id", arn]);
              if (!rot.ok || !rot.data.KeyRotationEnabled) return "The key exists, but automatic rotation isn't enabled.";
              return true;
            },
          },
          {
            id: "bucket",
            title: "Create the bucket with versioning and tags",
            description: `Create the bucket \`${ARTIFACT_BUCKET}\`, enable **versioning**, and tag it \`team=platform\` and \`purpose=build-artifacts\`.`,
            hints: [
              "Versioning: `aws s3api put-bucket-versioning --bucket … --versioning-configuration Status=Enabled`.",
              "Tags: `aws s3api put-bucket-tagging --bucket … --tagging 'TagSet=[{Key=team,Value=platform},{Key=purpose,Value=build-artifacts}]'`. This call replaces the whole tag set.",
            ],
            check: async ({ tryAws }) => {
              const head = await tryAws(["s3api", "head-bucket", "--bucket", ARTIFACT_BUCKET]);
              if (!head.ok) return `Bucket \`${ARTIFACT_BUCKET}\` doesn't exist yet.`;
              const v = await tryAws(["s3api", "get-bucket-versioning", "--bucket", ARTIFACT_BUCKET]);
              if (v.data?.Status !== "Enabled") return `Versioning is ${v.data?.Status ?? "not configured"}; expected Enabled.`;
              const t = await tryAws(["s3api", "get-bucket-tagging", "--bucket", ARTIFACT_BUCKET]);
              const tags = Object.fromEntries((t.data?.TagSet ?? []).map((x: any) => [x.Key, x.Value]));
              if (tags.team !== "platform" || tags.purpose !== "build-artifacts")
                return `Tags are ${JSON.stringify(tags)}; expected team=platform and purpose=build-artifacts.`;
              return true;
            },
          },
          {
            id: "encryption",
            title: "Default SSE-KMS with a bucket key",
            description:
              "Make **SSE-KMS with `alias/ci-artifacts`** the bucket's default encryption, with **S3 Bucket Keys enabled** so S3 doesn't call KMS for every object.",
            hints: [
              "The API is `put-bucket-encryption` with a `--server-side-encryption-configuration` JSON containing one rule.",
              "`{\"Rules\":[{\"ApplyServerSideEncryptionByDefault\":{\"SSEAlgorithm\":\"aws:kms\",\"KMSMasterKeyID\":\"alias/ci-artifacts\"},\"BucketKeyEnabled\":true}]}`",
            ],
            check: async (ctx) => {
              const e = await ctx.tryAws(["s3api", "get-bucket-encryption", "--bucket", ARTIFACT_BUCKET]);
              if (!e.ok) return `Can't read the encryption configuration of \`${ARTIFACT_BUCKET}\`. Does the bucket exist?`;
              const rule = e.data.ServerSideEncryptionConfiguration?.Rules?.[0];
              const d = rule?.ApplyServerSideEncryptionByDefault ?? {};
              if (d.SSEAlgorithm !== "aws:kms") return `Default encryption is ${d.SSEAlgorithm}; expected aws:kms.`;
              const want = await keyArn(ctx, "alias/ci-artifacts");
              const got = await keyArn(ctx, d.KMSMasterKeyID);
              if (!d.KMSMasterKeyID) return "SSE-KMS is on, but with the AWS managed key. Set KMSMasterKeyID to your customer managed key.";
              if (!want || got !== want) return `Default encryption uses key \`${d.KMSMasterKeyID}\`, not the key behind alias/ci-artifacts.`;
              if (rule.BucketKeyEnabled !== true) return "BucketKeyEnabled is false. Turn it on to cut KMS calls (and cost) by up to 99%.";
              return true;
            },
          },
          {
            id: "public-access",
            title: "Block public access and disable ACLs",
            description:
              "Explicitly set all four **Block Public Access** settings to true on the bucket, and set **Object Ownership** to `BucketOwnerEnforced`. New buckets get these by default, but production IaC states them explicitly so drift detection can catch someone turning them off.",
            hints: [
              "`aws s3api put-public-access-block --bucket … --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true`",
              "`aws s3api put-bucket-ownership-controls --bucket … --ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerEnforced}]'`",
            ],
            check: async ({ tryAws }) => {
              const head = await tryAws(["s3api", "head-bucket", "--bucket", ARTIFACT_BUCKET]);
              if (!head.ok) return `Bucket \`${ARTIFACT_BUCKET}\` doesn't exist yet.`;
              const b = await tryAws(["s3api", "get-public-access-block", "--bucket", ARTIFACT_BUCKET]);
              if (!b.ok) return "The bucket has no Block Public Access configuration.";
              const c = b.data.PublicAccessBlockConfiguration ?? {};
              const off = ["BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets"].filter((k) => c[k] !== true);
              if (off.length) return `These Block Public Access settings are off: ${off.join(", ")}.`;
              const o = await tryAws(["s3api", "get-bucket-ownership-controls", "--bucket", ARTIFACT_BUCKET]);
              const own = o.data?.OwnershipControls?.Rules?.[0]?.ObjectOwnership;
              if (own !== "BucketOwnerEnforced") return `Object Ownership is ${own ?? "not set"}; expected BucketOwnerEnforced.`;
              return true;
            },
          },
          {
            id: "policy",
            title: "A bucket policy that enforces TLS and the encryption type",
            description: [
              "Attach a bucket policy with two **Deny** statements for all principals:",
              "",
              "1. Deny `s3:*` on the bucket **and** its objects when `aws:SecureTransport` is `false`.",
              "2. Deny `s3:PutObject` when the request **includes** an `s3:x-amz-server-side-encryption` header whose value **isn't** `aws:kms`. Uploads with no header must still be allowed, because the bucket default encrypts them.",
              "",
              "The lab folder is a good place for `policy.json`.",
            ].join("\n"),
            hints: [
              "Statement 1 needs `\"Resource\": [\"arn:aws:s3:::ci-artifacts-000000000000\", \"arn:aws:s3:::ci-artifacts-000000000000/*\"]` and `\"Condition\": {\"Bool\": {\"aws:SecureTransport\": \"false\"}}`.",
              "Statement 2 combines two condition operators in one block (they're ANDed): `\"Null\": {\"s3:x-amz-server-side-encryption\": \"false\"}` (the header is present) and `\"StringNotEquals\": {\"s3:x-amz-server-side-encryption\": \"aws:kms\"}`.",
              "Apply it with `aws s3api put-bucket-policy --bucket ci-artifacts-000000000000 --policy file://policy.json`, then test it: an upload with `--server-side-encryption AES256` should be denied.",
            ],
            check: async (ctx) => {
              const st = await bucketPolicy(ctx, ARTIFACT_BUCKET);
              if (typeof st === "string") return st;
              const bucketArn = `arn:aws:s3:::${ARTIFACT_BUCKET}`;
              const tls = st.find(
                (s) =>
                  s.Effect === "Deny" &&
                  String(s.Condition?.Bool?.["aws:SecureTransport"]).toLowerCase() === "false",
              );
              if (!tls) return "No Deny statement with the condition `Bool: aws:SecureTransport = false`.";
              const acts = asList(tls.Action);
              if (!acts.includes("s3:*")) return `The TLS statement denies ${JSON.stringify(acts)}; it should deny \`s3:*\`.`;
              const res = asList(tls.Resource);
              if (!res.includes(bucketArn) || !res.includes(`${bucketArn}/*`))
                return `The TLS statement must cover both \`${bucketArn}\` and \`${bucketArn}/*\`; it covers ${JSON.stringify(res)}.`;
              const sse = st.find(
                (s) =>
                  s.Effect === "Deny" &&
                  asList(s.Action).some((a: string) => a === "s3:PutObject" || a === "s3:*") &&
                  s.Condition?.StringNotEquals?.["s3:x-amz-server-side-encryption"] === "aws:kms",
              );
              if (!sse) return "No Deny statement for s3:PutObject with `StringNotEquals: s3:x-amz-server-side-encryption = aws:kms`.";
              if (String(sse.Condition?.Null?.["s3:x-amz-server-side-encryption"]).toLowerCase() !== "false")
                return "The encryption statement would also deny uploads that send no header at all. Add `Null: {s3:x-amz-server-side-encryption: false}` to the same condition block, so it only matches when the header is present.";
              return true;
            },
          },
          {
            id: "lifecycle",
            title: "Lifecycle: cap the history, clean up failed uploads",
            description:
              "Add a lifecycle rule that applies to the **whole bucket** and is Enabled. It must expire **noncurrent versions 30 days** after they become noncurrent, and **abort incomplete multipart uploads 7 days** after they start.",
            hints: [
              "An empty filter, `\"Filter\": {}`, applies a rule to every object.",
              "`{\"Rules\":[{\"ID\":\"hygiene\",\"Status\":\"Enabled\",\"Filter\":{},\"NoncurrentVersionExpiration\":{\"NoncurrentDays\":30},\"AbortIncompleteMultipartUpload\":{\"DaysAfterInitiation\":7}}]}` with `put-bucket-lifecycle-configuration --lifecycle-configuration file://lifecycle.json`.",
            ],
            check: async ({ tryAws }) => {
              const l = await tryAws(["s3api", "get-bucket-lifecycle-configuration", "--bucket", ARTIFACT_BUCKET]);
              if (!l.ok) return "The bucket has no lifecycle configuration yet.";
              const rules = (l.data.Rules ?? []).filter((r: any) => r.Status === "Enabled");
              const wholeBucket = (r: any) => {
                const f = r.Filter;
                if (r.Prefix !== undefined && r.Prefix !== "") return false;
                if (!f) return true;
                if (f.Tag || f.And || f.ObjectSizeGreaterThan || f.ObjectSizeLessThan) return false;
                return !f.Prefix;
              };
              const nc = rules.find((r: any) => r.NoncurrentVersionExpiration?.NoncurrentDays !== undefined);
              if (!nc) return "No enabled rule with NoncurrentVersionExpiration.";
              if (nc.NoncurrentVersionExpiration.NoncurrentDays !== 30)
                return `Noncurrent versions expire after ${nc.NoncurrentVersionExpiration.NoncurrentDays} days; expected 30.`;
              if (!wholeBucket(nc)) return "The noncurrent-version rule has a filter; it should apply to the whole bucket.";
              const mpu = rules.find((r: any) => r.AbortIncompleteMultipartUpload?.DaysAfterInitiation !== undefined);
              if (!mpu) return "No enabled rule with AbortIncompleteMultipartUpload.";
              if (mpu.AbortIncompleteMultipartUpload.DaysAfterInitiation !== 7)
                return `Incomplete uploads abort after ${mpu.AbortIncompleteMultipartUpload.DaysAfterInitiation} days; expected 7.`;
              if (!wholeBucket(mpu)) return "The multipart-abort rule has a filter; it should apply to the whole bucket.";
              return true;
            },
          },
          {
            id: "upload",
            title: "Publish the artifact",
            description: `Upload \`dist/app-1.4.2.tar.gz\` to \`s3://${ARTIFACT_BUCKET}/${ARTIFACT_KEY}\`. Don't pass any encryption options: the stored object should still come out **SSE-KMS encrypted with your key**, and versioned. Make the upload **create-only**, so a re-run of the job can't overwrite a published release.`,
            hints: [
              "`aws s3api put-object --bucket … --key … --body dist/app-1.4.2.tar.gz` prints the encryption and VersionId it applied.",
              "Add `--if-none-match '*'` to make it create-only. Run it twice: the second attempt should fail with PreconditionFailed.",
            ],
            check: async (ctx) => {
              const h = await ctx.tryAws(["s3api", "head-object", "--bucket", ARTIFACT_BUCKET, "--key", ARTIFACT_KEY]);
              if (!h.ok) return `\`${ARTIFACT_KEY}\` isn't in the bucket yet.`;
              if (h.data.ServerSideEncryption !== "aws:kms") return `The object is encrypted with ${h.data.ServerSideEncryption}; expected aws:kms. Was default encryption set before you uploaded?`;
              const want = await keyArn(ctx, "alias/ci-artifacts");
              if ((await keyArn(ctx, h.data.SSEKMSKeyId)) !== want) return `The object was encrypted with \`${h.data.SSEKMSKeyId}\`, not the alias/ci-artifacts key.`;
              if (!h.data.VersionId || h.data.VersionId === "null") return "The object has no version ID. Was versioning enabled before the upload?";
              const local = await ctx.sh("sha256sum dist/app-1.4.2.tar.gz | cut -d' ' -f1");
              const remote = await ctx.sh(`aws s3 cp "s3://${ARTIFACT_BUCKET}/${ARTIFACT_KEY}" - | sha256sum | cut -d' ' -f1`);
              if (local.stdout.trim() !== remote.stdout.trim()) return "The uploaded object's content doesn't match dist/app-1.4.2.tar.gz.";
              return true;
            },
          },
          {
            id: "presign",
            title: "Hand out a short-lived download link",
            description:
              "Generate a **presigned GET URL** for the artifact that expires in **at most one hour**, and save it (just the URL) to `presigned-url.txt`. Then download the artifact **with curl, using only that URL** (no AWS credentials), to `downloaded.tar.gz`.",
            hints: [
              "`aws s3 presign s3://ci-artifacts-000000000000/releases/app/1.4.2/app-1.4.2.tar.gz --expires-in 900 > presigned-url.txt`",
              "`curl -sSf --cacert \"$AWS_CA_BUNDLE\" -o downloaded.tar.gz \"$(cat presigned-url.txt)\"`. The CA bundle is only needed because the emulator uses its own TLS certificate.",
              "Compare `sha256sum downloaded.tar.gz` with `dist/SHA256SUMS`.",
            ],
            check: async ({ readFile, sh }) => {
              const url = (await readFile("presigned-url.txt"))?.trim();
              if (!url) return "`presigned-url.txt` not found (or empty) in the lab folder.";
              if (!url.includes("X-Amz-Signature=")) return "That doesn't look like a presigned URL: there's no X-Amz-Signature parameter.";
              if (!url.includes("app-1.4.2.tar.gz")) return "The URL isn't for the artifact key.";
              const exp = Number(/X-Amz-Expires=(\d+)/.exec(url)?.[1]);
              if (!exp || exp > 3600) return `The URL is valid for ${exp || "?"} seconds; keep download links to an hour or less.`;
              const dl = await sh("[ -f downloaded.tar.gz ] && sha256sum downloaded.tar.gz dist/app-1.4.2.tar.gz | cut -d' ' -f1 | uniq | wc -l");
              if (dl.stdout.trim() !== "1") return "`downloaded.tar.gz` is missing or doesn't match the original artifact.";
              const live = await sh(`curl -sS --cacert "$AWS_CA_BUNDLE" -o /dev/null -w '%{http_code}' "$(cat presigned-url.txt)"`);
              if (live.stdout.trim() !== "200") return `Fetching the URL now returns HTTP ${live.stdout.trim()}. If it has expired, generate a new one.`;
              return true;
            },
          },
        ],
        solution: String.raw`
B=ci-artifacts-000000000000
KEY=$(aws kms create-key --description ci-artifacts --query KeyMetadata.KeyId --output text)
aws kms create-alias --alias-name alias/ci-artifacts --target-key-id "$KEY"
aws kms enable-key-rotation --key-id "$KEY"

aws s3api create-bucket --bucket "$B"
aws s3api put-bucket-versioning --bucket "$B" --versioning-configuration Status=Enabled
aws s3api put-bucket-tagging --bucket "$B" --tagging 'TagSet=[{Key=team,Value=platform},{Key=purpose,Value=build-artifacts}]'

aws s3api put-bucket-encryption --bucket "$B" --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms","KMSMasterKeyID":"alias/ci-artifacts"},"BucketKeyEnabled":true}]}'

aws s3api put-public-access-block --bucket "$B" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-ownership-controls --bucket "$B" --ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerEnforced}]'

cat > policy.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyInsecureTransport",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": ["arn:aws:s3:::ci-artifacts-000000000000", "arn:aws:s3:::ci-artifacts-000000000000/*"],
      "Condition": { "Bool": { "aws:SecureTransport": "false" } }
    },
    {
      "Sid": "DenyWrongEncryptionHeader",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::ci-artifacts-000000000000/*",
      "Condition": {
        "Null": { "s3:x-amz-server-side-encryption": "false" },
        "StringNotEquals": { "s3:x-amz-server-side-encryption": "aws:kms" }
      }
    }
  ]
}
EOF
aws s3api put-bucket-policy --bucket "$B" --policy file://policy.json

cat > lifecycle.json <<'EOF'
{"Rules":[{"ID":"hygiene","Status":"Enabled","Filter":{},
  "NoncurrentVersionExpiration":{"NoncurrentDays":30},
  "AbortIncompleteMultipartUpload":{"DaysAfterInitiation":7}}]}
EOF
aws s3api put-bucket-lifecycle-configuration --bucket "$B" --lifecycle-configuration file://lifecycle.json

aws s3api put-object --bucket "$B" --key releases/app/1.4.2/app-1.4.2.tar.gz --body dist/app-1.4.2.tar.gz --if-none-match '*'
# a re-run must not overwrite the release
if aws s3api put-object --bucket "$B" --key releases/app/1.4.2/app-1.4.2.tar.gz --body dist/app-1.4.2.tar.gz --if-none-match '*'; then
  echo "create-only upload overwrote the release" >&2; exit 1
fi
# and the policy rejects a weaker encryption request
if aws s3api put-object --bucket "$B" --key probe.txt --body release/VERSION --server-side-encryption AES256; then
  echo "policy allowed an AES256 upload" >&2; exit 1
fi

aws s3 presign "s3://$B/releases/app/1.4.2/app-1.4.2.tar.gz" --expires-in 900 > presigned-url.txt
curl -sSf --cacert "$AWS_CA_BUNDLE" -o downloaded.tar.gz "$(cat presigned-url.txt)"
sha256sum downloaded.tar.gz
`,
      },
    },

    // ------------------------------------------------------------ lab 2
    {
      id: "recover-and-react",
      kind: "lab",
      title: "Lab: undo a bad release, then react to uploads",
      minutes: 25,
      body: String.raw`
It's 02:00. Someone ran a broken release script against \`${ARCHIVE_BUCKET}\`, a versioned bucket that the deploy system reads from. Two things are wrong:

1. \`releases/web/2.0.0/manifest.json\` was **deleted**. Deploys of 2.0.0 now fail with 404.
2. \`releases/web/current.json\`, the pointer that says which version is live, was **overwritten** with \`2.1.0-broken\`.

Versioning means nothing is lost. Your job is to recover without destroying evidence: the incident review will want to see exactly what was written. Then, so this is noticed next time, wire the bucket to send an event to the \`artifact-events\` SQS queue whenever a tarball lands under \`incoming/\`.

Start by looking at what happened:

\`\`\`bash
aws s3api list-object-versions --bucket release-archive --prefix releases/web/ \
  --query '{versions: Versions[].[Key,VersionId,IsLatest,LastModified], deleteMarkers: DeleteMarkers[].[Key,VersionId,IsLatest]}'
\`\`\`
`,
      lab: {
        setup: String.raw`
B=release-archive
aws s3api create-bucket --bucket "$B"
aws s3api put-bucket-versioning --bucket "$B" --versioning-configuration Status=Enabled
T=$(mktemp -d .setup.XXXX)
printf '{"version":"2.0.0","build":512,"artifact":"releases/web/2.0.0/site.zip"}\n' > "$T/manifest.json"
aws s3api put-object --bucket "$B" --key releases/web/2.0.0/manifest.json --body "$T/manifest.json" >/dev/null
printf '{"live":"2.0.0"}\n' > "$T/current.json"
aws s3api put-object --bucket "$B" --key releases/web/current.json --body "$T/current.json" >/dev/null
# the broken release script:
printf '{"live":"2.1.0-broken"}\n' > "$T/current.json"
aws s3api put-object --bucket "$B" --key releases/web/current.json --body "$T/current.json" >/dev/null
aws s3api delete-object --bucket "$B" --key releases/web/2.0.0/manifest.json >/dev/null
rm -rf "$T"
aws sqs create-queue --queue-name artifact-events >/dev/null
echo "release-archive is in its post-incident state; queue artifact-events exists."
`,
        tasks: [
          {
            id: "undelete",
            title: "Undelete the manifest",
            description:
              "Make `releases/web/2.0.0/manifest.json` readable again **without re-uploading it**: the original version must become current. When you're done, the key should have exactly one version and no delete markers.",
            hints: [
              "A DELETE on a versioned bucket only added a delete marker on top. Find its version ID with `list-object-versions`.",
              "`aws s3api delete-object --bucket release-archive --key releases/web/2.0.0/manifest.json --version-id <marker-version-id>` removes the marker.",
            ],
            check: async (ctx) => {
              const key = "releases/web/2.0.0/manifest.json";
              const v = await ctx.tryAws(["s3api", "list-object-versions", "--bucket", ARCHIVE_BUCKET, "--prefix", key]);
              if (!v.ok) return `Can't list versions in \`${ARCHIVE_BUCKET}\`. Did you press Prepare lab?`;
              const markers = (v.data.DeleteMarkers ?? []).filter((m: any) => m.Key === key);
              const versions = (v.data.Versions ?? []).filter((m: any) => m.Key === key);
              if (markers.length) return `The key still has ${markers.length} delete marker(s). Remove the marker rather than adding versions on top.`;
              if (versions.length !== 1) return `The key has ${versions.length} versions; expected exactly 1 (the original). Did you re-upload instead of removing the delete marker?`;
              const body = await objectText(ctx, ARCHIVE_BUCKET, key);
              if (!body?.includes('"build":512')) return "The current manifest isn't the original 2.0.0 manifest.";
              return true;
            },
          },
          {
            id: "rollback",
            title: "Roll back the live pointer, keeping history",
            description:
              "Make `releases/web/current.json` say `{\"live\":\"2.0.0\"}` again by **copying the previous version onto the key**. Don't delete the broken version: the incident review needs it. The key should end up with three versions, the newest being a copy of the good one.",
            hints: [
              "Find the noncurrent version: `list-object-versions --prefix releases/web/current.json --query 'Versions[?IsLatest==\\`false\\`].VersionId'`.",
              "`aws s3api copy-object --bucket release-archive --key releases/web/current.json --copy-source \"release-archive/releases/web/current.json?versionId=$PREV\"`",
            ],
            check: async (ctx) => {
              const key = "releases/web/current.json";
              const body = await objectText(ctx, ARCHIVE_BUCKET, key);
              if (body === null) return "`releases/web/current.json` isn't readable.";
              if (!body.includes('"live":"2.0.0"')) return `current.json says ${body.trim()}; expected {"live":"2.0.0"}.`;
              const v = await ctx.aws(["s3api", "list-object-versions", "--bucket", ARCHIVE_BUCKET, "--prefix", key]);
              const versions = (v.Versions ?? []).filter((m: any) => m.Key === key);
              if (versions.length < 3)
                return `current.json has ${versions.length} versions. It looks like a version was deleted; the broken version should be kept as evidence. Copy the good version on top instead.`;
              return true;
            },
          },
          {
            id: "queue-policy",
            title: "Let S3 deliver to the queue",
            description:
              "Give the `artifact-events` queue a policy that allows the service principal `s3.amazonaws.com` to `sqs:SendMessage`, **only** for events from the `release-archive` bucket (condition on `aws:SourceArn`) in account `000000000000` (condition on `aws:SourceAccount`).",
            hints: [
              "The policy is a queue attribute named `Policy`, whose value is the policy JSON *as a string*.",
              "Build the attribute with jq to avoid quoting pain: `aws sqs set-queue-attributes --queue-url \"$QURL\" --attributes \"$(jq -n --arg p \"$(cat queue-policy.json)\" '{Policy: $p}')\"`",
              "Statement: `{\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"s3.amazonaws.com\"},\"Action\":\"sqs:SendMessage\",\"Resource\":\"<queue-arn>\",\"Condition\":{\"ArnEquals\":{\"aws:SourceArn\":\"arn:aws:s3:::release-archive\"},\"StringEquals\":{\"aws:SourceAccount\":\"000000000000\"}}}`",
            ],
            check: async ({ tryAws }) => {
              const u = await tryAws(["sqs", "get-queue-url", "--queue-name", "artifact-events"]);
              if (!u.ok) return "Queue `artifact-events` doesn't exist. Press Prepare lab.";
              const a = await tryAws(["sqs", "get-queue-attributes", "--queue-url", u.data.QueueUrl, "--attribute-names", "Policy"]);
              const raw = a.data?.Attributes?.Policy;
              if (!raw) return "The queue has no policy yet.";
              const st = asList(JSON.parse(raw).Statement);
              const s = st.find(
                (x: any) =>
                  x.Effect === "Allow" &&
                  asList(x.Principal?.Service).includes("s3.amazonaws.com") &&
                  asList(x.Action).some((ac: string) => ac === "sqs:SendMessage" || ac === "sqs:*"),
              );
              if (!s) return "No statement allows the service principal s3.amazonaws.com to sqs:SendMessage.";
              const c = s.Condition ?? {};
              const src = c.ArnEquals?.["aws:SourceArn"] ?? c.ArnLike?.["aws:SourceArn"] ?? c.StringEquals?.["aws:SourceArn"];
              if (src !== `arn:aws:s3:::${ARCHIVE_BUCKET}`) return `The statement should be limited with aws:SourceArn = arn:aws:s3:::${ARCHIVE_BUCKET}; found ${JSON.stringify(src)}.`;
              const acct = c.StringEquals?.["aws:SourceAccount"] ?? c.StringLike?.["aws:SourceAccount"];
              if (acct !== "000000000000") return "Add a StringEquals condition on aws:SourceAccount = 000000000000, so a same-named bucket in another account can't send to your queue.";
              return true;
            },
          },
          {
            id: "notification",
            title: "Send an event when a tarball arrives",
            description:
              "Configure `release-archive` to notify the `artifact-events` queue on **every object-created event** (`s3:ObjectCreated:*`) for keys with the prefix `incoming/` and the suffix `.tar.gz`.",
            hints: [
              "`aws s3api put-bucket-notification-configuration --bucket release-archive --notification-configuration file://notify.json`",
              "`{\"QueueConfigurations\":[{\"Id\":\"incoming-tarballs\",\"QueueArn\":\"<arn>\",\"Events\":[\"s3:ObjectCreated:*\"],\"Filter\":{\"Key\":{\"FilterRules\":[{\"Name\":\"prefix\",\"Value\":\"incoming/\"},{\"Name\":\"suffix\",\"Value\":\".tar.gz\"}]}}}]}`",
              "If S3 answers `Unable to validate the following destination configurations`, the queue policy from the previous task is missing or doesn't match this bucket.",
            ],
            check: async ({ tryAws, region, account }) => {
              const n = await tryAws(["s3api", "get-bucket-notification-configuration", "--bucket", ARCHIVE_BUCKET]);
              if (!n.ok) return `Can't read the notification configuration of \`${ARCHIVE_BUCKET}\`.`;
              const qa = `arn:aws:sqs:${region}:${account}:artifact-events`;
              const qc = (n.data?.QueueConfigurations ?? []).find((q: any) => q.QueueArn === qa);
              if (!qc) return "No queue notification for artifact-events on the bucket yet.";
              if (!asList(qc.Events).includes("s3:ObjectCreated:*")) return `The notification fires on ${JSON.stringify(qc.Events)}; expected s3:ObjectCreated:*.`;
              const rules = Object.fromEntries((qc.Filter?.Key?.FilterRules ?? []).map((r: any) => [String(r.Name).toLowerCase(), r.Value]));
              if (rules.prefix !== "incoming/") return `The prefix filter is ${JSON.stringify(rules.prefix)}; expected "incoming/".`;
              if (rules.suffix !== ".tar.gz") return `The suffix filter is ${JSON.stringify(rules.suffix)}; expected ".tar.gz".`;
              return true;
            },
          },
          {
            id: "event",
            title: "Prove it end to end",
            description:
              "Upload any file as `incoming/build-99.tar.gz`, receive the resulting event from the queue, and write the **object key from the event** (just the key) to `event-key.txt`. The first message on the queue may be an `s3:TestEvent`; skip it.",
            hints: [
              "`aws sqs receive-message --queue-url \"$QURL\" --wait-time-seconds 5 --max-number-of-messages 10 --query 'Messages[].Body' --output json`",
              "Each body is JSON. Object events have `.Records[0].s3.object.key`. With jq: `… | jq -r '.[] | fromjson | .Records[0].s3.object.key // empty'`",
            ],
            check: async ({ tryAws, readFile }) => {
              const h = await tryAws(["s3api", "head-object", "--bucket", ARCHIVE_BUCKET, "--key", "incoming/build-99.tar.gz"]);
              if (!h.ok) return "`incoming/build-99.tar.gz` hasn't been uploaded yet.";
              const f = await readFile("event-key.txt");
              if (f === null) return "`event-key.txt` not found in the lab folder.";
              if (f.trim() !== "incoming/build-99.tar.gz") return `event-key.txt contains \`${f.trim().slice(0, 80)}\`; expected the key from the S3 event.`;
              return true;
            },
          },
        ],
        solution: String.raw`
B=release-archive
# 1. undelete: remove the delete marker
MARKER=$(aws s3api list-object-versions --bucket "$B" --prefix releases/web/2.0.0/manifest.json \
  --query 'DeleteMarkers[?IsLatest].VersionId' --output text)
aws s3api delete-object --bucket "$B" --key releases/web/2.0.0/manifest.json --version-id "$MARKER"

# 2. roll back: copy the previous version on top
PREV=$(aws s3api list-object-versions --bucket "$B" --prefix releases/web/current.json \
  --query 'Versions[?IsLatest==\`false\`] | [0].VersionId' --output text)
aws s3api copy-object --bucket "$B" --key releases/web/current.json \
  --copy-source "$B/releases/web/current.json?versionId=$PREV"
aws s3 cp "s3://$B/releases/web/current.json" -

# 3. queue policy
QURL=$(aws sqs get-queue-url --queue-name artifact-events --query QueueUrl --output text)
QARN=$(aws sqs get-queue-attributes --queue-url "$QURL" --attribute-names QueueArn --query Attributes.QueueArn --output text)
cat > queue-policy.json <<EOF
{"Version":"2012-10-17","Statement":[{"Sid":"AllowS3","Effect":"Allow",
  "Principal":{"Service":"s3.amazonaws.com"},"Action":"sqs:SendMessage","Resource":"$QARN",
  "Condition":{"ArnEquals":{"aws:SourceArn":"arn:aws:s3:::release-archive"},
               "StringEquals":{"aws:SourceAccount":"000000000000"}}}]}
EOF
aws sqs set-queue-attributes --queue-url "$QURL" --attributes "$(jq -n --arg p "$(cat queue-policy.json)" '{Policy: $p}')"

# 4. notification
cat > notify.json <<EOF
{"QueueConfigurations":[{"Id":"incoming-tarballs","QueueArn":"$QARN","Events":["s3:ObjectCreated:*"],
  "Filter":{"Key":{"FilterRules":[{"Name":"prefix","Value":"incoming/"},{"Name":"suffix","Value":".tar.gz"}]}}}]}
EOF
aws s3api put-bucket-notification-configuration --bucket "$B" --notification-configuration file://notify.json

# 5. end to end
echo build-99 > build-99.tar.gz
aws s3api put-object --bucket "$B" --key incoming/build-99.tar.gz --body build-99.tar.gz
: > event-key.txt
for i in $(seq 1 15); do
  aws sqs receive-message --queue-url "$QURL" --wait-time-seconds 2 --max-number-of-messages 10 --query 'Messages[].Body' --output json \
    | jq -r '.[]? | fromjson | .Records[0].s3.object.key // empty' > keys.out || true
  if [ -s keys.out ]; then head -1 keys.out > event-key.txt; break; fi
done
rm -f keys.out
cat event-key.txt
test -s event-key.txt
`,
      },
    },
  ],

  quiz: [
    {
      q: "A nightly job rewrites a 20 GB file in a versioned bucket. Six months later the bucket costs far more than expected, but `aws s3 ls` shows only a few files. What's the most likely cause and fix?",
      options: [
        "S3 bills listed objects twice; disable versioning",
        "Noncurrent versions are accumulating; add a NoncurrentVersionExpiration lifecycle rule",
        "Multipart uploads always double storage; switch to single PUTs",
        "Bucket keys are disabled; enable them",
      ],
      answer: 1,
      explain:
        "Every overwrite on a versioned bucket keeps the previous version, billed at full price but invisible to a plain listing. A `NoncurrentVersionExpiration` rule (optionally with `NewerNoncurrentVersions`) caps the history. Check `list-object-versions`, and also `list-multipart-uploads`, which is the other invisible cost.",
    },
    {
      q: "Your bucket policy denies `s3:PutObject` unless `s3:x-amz-server-side-encryption` equals `aws:kms`. The bucket has default SSE-KMS. Developers report that `aws s3 cp` uploads with no flags are rejected. Why?",
      options: [
        "Default encryption only applies to multipart uploads",
        "The condition is evaluated on the request headers; a request with no header doesn't match `aws:kms`, so the deny fires before default encryption could apply",
        "The emulator doesn't support default encryption",
        "KMS keys can't be used as bucket defaults",
      ],
      answer: 1,
      explain:
        "Policy conditions see the request, not the result. A missing header makes `StringNotEquals` true, so the Deny matches. Either drop the statement and rely on default encryption, or add `Null: {\"s3:x-amz-server-side-encryption\": \"false\"}` so the deny applies only to a header that's present and wrong.",
    },
    {
      q: "A Lambda function signs download links with `--expires-in 604800` (7 days). Users report the links stop working after a few hours. What's going on?",
      options: [
        "S3 caps presigned URLs at 1 hour",
        "The URL was signed with the function's temporary role credentials, and it stops working when that session expires",
        "The links were cached by CloudFront",
        "SigV4 presigned URLs are single-use",
      ],
      answer: 1,
      explain:
        "A presigned URL is only as valid as the credentials that signed it. Role sessions (Lambda, ECS, EC2) expire after hours. For long-lived links, sign with a long-lived identity created for the purpose, or better, keep links short and have a service issue a fresh one on demand.",
    },
    {
      q: "Compliance requires that audit logs can't be deleted or altered by anyone for 7 years, including administrators. Which configuration meets that?",
      options: [
        "Versioning with MFA delete",
        "A bucket policy that denies s3:DeleteObject to everyone",
        "Object Lock in compliance mode with a 7-year default retention",
        "Object Lock in governance mode with a 7-year default retention",
      ],
      answer: 2,
      explain:
        "Only compliance mode is immune to every principal, including root, until retention expires. Governance mode can be bypassed with `s3:BypassGovernanceRetention`. A bucket policy can be edited or deleted by an admin. MFA delete protects version deletion but not policy changes, and only root can manage it. Test with governance mode first: compliance retention can't be shortened.",
    },
    {
      q: "An S3 event notification triggers a Lambda that writes a thumbnail to `uploads/thumbs/` in the same bucket. The notification filter is prefix `uploads/`. What happens?",
      options: [
        "Nothing unusual: S3 never notifies on objects written by Lambda",
        "S3 rejects the configuration because the destination is Lambda",
        "Each thumbnail triggers the function again, creating a recursive loop that runs up cost",
        "The thumbnail overwrites the original image",
      ],
      answer: 2,
      explain:
        "The output key matches the filter, so every write triggers another invocation. Write outputs to a different bucket or a prefix outside the filter. AWS's recursive loop detection catches some Lambda/S3 cases, but don't design to depend on it.",
    },
    {
      q: "A team runs PostgreSQL on EC2. They need the data directory to survive instance replacement and to give consistent low-latency IOPS. Which storage fits best?",
      options: [
        "An EFS file system mounted on the instance",
        "A gp3 (or io2) EBS volume, with regular snapshots, in the instance's AZ",
        "An S3 bucket mounted with a FUSE driver",
        "The instance store",
      ],
      answer: 1,
      explain:
        "Databases want block storage with predictable latency: EBS gp3 for most, io2 Block Express for the most demanding. The volume persists independently of the instance (in the same AZ) and snapshots give point-in-time backups. EFS adds NFS latency and locking semantics, S3 isn't a filesystem, and instance store is lost when the instance stops. Better still, use RDS (next module).",
    },
    {
      q: "Deploys in a new AZ, us-east-1c, fail: ECS tasks there can't mount the shared EFS file system. Tasks in 1a and 1b work. What's the most likely cause?",
      options: [
        "EFS is a single-AZ service",
        "There's no EFS mount target in us-east-1c (or its security group doesn't allow NFS from the tasks)",
        "EFS needs Bursting throughput mode for more than two AZs",
        "The file system must be re-created to add an AZ",
      ],
      answer: 1,
      explain:
        "Clients mount through a mount target in their AZ. Adding an AZ to a service means adding an EFS mount target there, in a subnet the tasks can reach, with a security group allowing TCP 2049 from the tasks' security group. IaC that loops over the subnet list avoids this class of incident.",
    },
  ],
};
