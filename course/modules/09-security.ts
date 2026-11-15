import type { CheckContext, Module } from "../types.ts";

// ---------------------------------------------------------------- helpers

/** Resolve any key reference (alias, key id, ARN) to its key ARN, or null. */
async function keyArn(ctx: CheckContext, ref: string | undefined | null): Promise<string | null> {
  if (!ref) return null;
  const r = await ctx.tryAws(["kms", "describe-key", "--key-id", ref]);
  return r.ok ? r.data.KeyMetadata.Arn : null;
}

const REPORT_CONTEXT = "purpose=quarterly-report";

/** Reads report.envelope.json and returns its fields, or a failure string. */
async function envelope(ctx: CheckContext): Promise<{ edk: string; iv: string; ec: any } | string> {
  const f = await ctx.readFile("report.envelope.json");
  if (f === null) return "`report.envelope.json` not found in the lab folder.";
  let j: any;
  try {
    j = JSON.parse(f);
  } catch {
    return "`report.envelope.json` isn't valid JSON.";
  }
  if (typeof j.EncryptedDataKey !== "string" || !/^[A-Za-z0-9+/=]+$/.test(j.EncryptedDataKey))
    return "`EncryptedDataKey` in the envelope must be the base64 `CiphertextBlob` from GenerateDataKey.";
  if (typeof j.IV !== "string" || !/^[0-9a-fA-F]{32}$/.test(j.IV)) return "`IV` in the envelope must be 32 hex characters (16 bytes).";
  return { edk: j.EncryptedDataKey, iv: j.IV, ec: j.EncryptionContext };
}

/** Decrypts the envelope's data key via KMS (with the context) and returns it as hex, or a failure string. */
async function dataKeyHex(ctx: CheckContext, edk: string): Promise<string> {
  const r = await ctx.sh(
    `aws kms decrypt --ciphertext-blob '${edk}' --encryption-context ${REPORT_CONTEXT} --query Plaintext --output text | base64 -d | od -An -tx1 | tr -d ' \\n'`,
  );
  return r.code === 0 && /^[0-9a-f]{64}$/.test(r.stdout.trim()) ? r.stdout.trim() : "";
}

const ROLE = "orders-api";

async function simulate(ctx: CheckContext, actions: string[], resource: string): Promise<Record<string, string>> {
  const r = await ctx.tryAws([
    "iam", "simulate-principal-policy",
    "--policy-source-arn", `arn:aws:iam::${ctx.account}:role/${ROLE}`,
    "--action-names", ...actions,
    "--resource-arns", resource,
  ]);
  if (!r.ok) throw new Error(`simulate-principal-policy failed: ${r.error.split("\n").pop()}`);
  return Object.fromEntries((r.data.EvaluationResults ?? []).map((e: any) => [e.EvalActionName, e.EvalDecision]));
}

const paramArn = (ctx: CheckContext, name: string) => `arn:aws:ssm:${ctx.region}:${ctx.account}:parameter${name}`;

function parseSecret(s: string | undefined): any {
  try {
    return JSON.parse(s ?? "");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- module

export const security: Module = {
  id: "security",
  number: "09",
  title: "Encryption & secrets: KMS, Secrets Manager, Parameter Store",
  summary:
    "Encrypt data with KMS the way AWS services do (envelope encryption), store configuration and secrets in the right service, and give applications narrowly scoped, auditable access to them.",
  services: ["KMS", "Secrets Manager", "SSM Parameter Store", "ACM", "IAM"],
  lessons: [
    {
      id: "kms",
      kind: "reading",
      title: "KMS keys, key policies and grants",
      minutes: 14,
      body: String.raw`
AWS Key Management Service holds keys you can **use but never see**. Key material is generated and kept inside FIPS-validated hardware security modules. You send data (or data keys) to KMS and get ciphertext back; the key itself never leaves. Almost every "encrypted at rest" checkbox in AWS (S3 SSE-KMS, EBS, RDS, DynamoDB, Secrets Manager, SSM SecureString, CloudWatch Logs) is a call to KMS under the hood.

That makes KMS two things at once: a cryptography service, and **an authorization layer for your data**. If you can't use the key, you can't read the data, even with \`s3:GetObject\` or \`AdministratorAccess\` on the bucket. Every use is logged in CloudTrail.

## Three kinds of key

| | AWS owned | AWS managed (\`alias/aws/s3\`, \`aws/ssm\`, …) | Customer managed (CMK) |
|---|---|---|---|
| Who controls the policy | AWS, invisible to you | AWS: fixed policy, usable only via that service in your account | **You** |
| Visible in your account | No | Yes | Yes |
| Rotation | AWS | Automatic, yearly | Optional: automatic (90 to 2,560 days) or on demand |
| Cross-account use | No | **No** | Yes, via key policy |
| Cost | Free | Free storage, request charges | ~$1/key/month + ~$0.03 per 10k requests |
| Use for | defaults you don't care about | quick start, single-account | anything you need to share, audit, restrict or delete on your terms |

The cross-account row is the one that bites: you **can't** share data encrypted with an AWS managed key with another account, because you can't edit that key's policy. If a bucket or a snapshot might ever be shared, use a customer managed key from day one. Re-encrypting later is painful.

Keys are **regional**. A key in \`us-east-1\` can't decrypt in \`eu-west-1\`, unless you create a **multi-Region key** (same key material and ID replicated to other regions), which is what you want for cross-region disaster recovery of encrypted data.

## Key policies: the root of KMS authorization

Every KMS key has exactly one **key policy**, and unlike most resources, IAM policies alone can't grant access to a key: the key policy must allow it, either directly or by delegating to IAM. The default key policy does that delegation:

\`\`\`json
{
  "Sid": "Enable IAM User Permissions",
  "Effect": "Allow",
  "Principal": { "AWS": "arn:aws:iam::111122223333:root" },
  "Action": "kms:*",
  "Resource": "*"
}
\`\`\`

\`:root\` here means "this account", not the root user. The statement says *IAM policies in this account may grant access to this key*. Remove it and only principals named directly in the key policy can use or manage the key. Remove the wrong statements and you can lock **everyone** out, after which only AWS Support can help. Production key policies usually split principals into:

- **Key administrators**: may change the policy, enable or disable, and schedule deletion, but **can't** encrypt or decrypt.
- **Key users**: may \`kms:Encrypt\`, \`kms:Decrypt\`, \`kms:GenerateDataKey*\`, often restricted with \`kms:ViaService\` (only through S3 or SSM) and \`kms:EncryptionContext:*\` conditions.

That split is separation of duties made concrete: the platform team runs the key, and only the application can read the data.

## Grants: temporary, programmatic delegation

A **grant** lets a principal use a key for specific operations without editing the key policy. AWS services use grants constantly (EBS creates one when it attaches an encrypted volume). You'd use one when a workflow needs short-lived access to a key: create the grant, do the work, retire the grant. Grants can carry **constraints** on the encryption context.

## Aliases

An alias (\`alias/orders-data\`) is a friendly, re-pointable name for a key. Applications should reference aliases, not key IDs, so you can swap the key behind them. Two caveats: an alias isn't a security boundary (key policies don't follow aliases unless you use the \`kms:ResourceAliases\` condition), and decrypting doesn't need the alias at all: symmetric ciphertext records which key produced it.

## Try it

\`\`\`bash
KEY_ID=$(aws kms create-key --description "demo data key" --tags TagKey=app,TagValue=demo \
  --query KeyMetadata.KeyId --output text)
aws kms create-alias --alias-name alias/demo-data --target-key-id "$KEY_ID"
aws kms describe-key --key-id alias/demo-data \
  --query 'KeyMetadata.{id:KeyId,manager:KeyManager,spec:KeySpec,usage:KeyUsage,state:KeyState}'
aws kms get-key-policy --key-id "$KEY_ID" --policy-name default --query Policy --output text
\`\`\`

Encrypt a small secret directly. **Encrypt accepts at most 4 KB**, which is why the next lesson exists:

\`\`\`bash
echo -n "db-password-123" > demo-secret.txt
aws kms encrypt --key-id alias/demo-data --plaintext fileb://demo-secret.txt \
  --query CiphertextBlob --output text > demo-secret.b64
aws kms decrypt --ciphertext-blob "$(cat demo-secret.b64)" --query Plaintext --output text | base64 -d; echo
\`\`\`

Now delegate decrypt rights to a role with a grant, and list it:

\`\`\`bash
aws iam create-role --role-name demo-kms-reader --query Role.Arn --assume-role-policy-document \
  '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"AWS":"arn:aws:iam::000000000000:root"},"Action":"sts:AssumeRole"}]}'
aws kms create-grant --key-id "$KEY_ID" --name demo-reader \
  --grantee-principal arn:aws:iam::000000000000:role/demo-kms-reader --operations Decrypt
aws kms list-grants --key-id "$KEY_ID" --query 'Grants[].[Name,GranteePrincipal,Operations]'
\`\`\`

The emulator enforces grants for role sessions: a session of \`demo-kms-reader\` can now decrypt \`demo-secret.b64\`, but \`kms:Encrypt\` fails with *no identity-based policy allows the kms:Encrypt action*.

## Rotation and deletion

- **Automatic rotation** creates new key material on a schedule (yearly by default, 90 to 2,560 days). The key ID, ARN and aliases don't change, and **old material is kept forever**, so old ciphertext still decrypts. Rotation limits how much data one key version protects; it doesn't re-encrypt anything and doesn't help if the *key policy* was too open.
- **On-demand rotation** (\`rotate-key-on-demand\`) does the same thing now, for example after a suspected exposure of a process that used the key.
- **Deletion is irreversible and destroys every byte encrypted under the key.** That's why \`schedule-key-deletion\` forces a 7 to 30 day waiting period. Senior practice: **disable** first, alarm on any CloudTrail \`Decrypt\` attempts that fail with \`DisabledException\`, and only then schedule deletion with the full 30 days.

\`\`\`bash
aws kms enable-key-rotation --key-id "$KEY_ID" --rotation-period-in-days 365
aws kms get-key-rotation-status --key-id "$KEY_ID"
\`\`\`

> **On real AWS:** KMS has per-account request quotas (5,500 to 100,000 requests per second for symmetric operations, depending on region). A busy service that calls KMS on every request, for example S3 SSE-KMS without **Bucket Keys**, can hit \`ThrottlingException\` and a surprising bill. Envelope encryption and data key caching are the cure.
`,
    },
    {
      id: "envelope",
      kind: "reading",
      title: "Envelope encryption and encryption context",
      minutes: 12,
      body: String.raw`
KMS won't encrypt more than 4 KB, and you wouldn't want it to: sending every gigabyte of your data over the network to an HSM would be slow, expensive and fragile. Instead, AWS services and the AWS Encryption SDK use **envelope encryption**: KMS protects a small **data key**, and the data key protects the data, locally.

<figure class="diagram">
<svg viewBox="0 0 640 290" role="img" aria-label="Envelope encryption: GenerateDataKey returns a plaintext and an encrypted data key; the app encrypts data locally, discards the plaintext key and stores the encrypted key next to the ciphertext">
  <rect x="10" y="20" width="150" height="70" rx="8" class="d-box d-accent"/><text x="85" y="48" text-anchor="middle" class="d-label">KMS key</text><text x="85" y="66" text-anchor="middle" class="d-small">never leaves the HSM</text>
  <rect x="250" y="12" width="170" height="40" rx="8" class="d-box d-danger"/><text x="335" y="37" text-anchor="middle" class="d-label">plaintext data key</text>
  <rect x="250" y="62" width="170" height="40" rx="8" class="d-box d-ok"/><text x="335" y="87" text-anchor="middle" class="d-label">encrypted data key</text>
  <path d="M160 45 H248" class="d-arrow"/><path d="M160 70 L248 82" class="d-arrow"/>
  <text x="204" y="30" text-anchor="middle" class="d-small">GenerateDataKey</text>
  <rect x="250" y="140" width="170" height="54" rx="8" class="d-box"/><text x="335" y="163" text-anchor="middle" class="d-label">your app</text><text x="335" y="181" text-anchor="middle" class="d-small">AES-256 locally, fast</text>
  <path d="M335 52 V60" class="d-arrow d-dashed"/>
  <path d="M290 52 C 250 90, 250 110, 290 138" class="d-arrow"/><text x="236" y="112" text-anchor="middle" class="d-small">use, then</text><text x="236" y="126" text-anchor="middle" class="d-small">wipe from memory</text>
  <rect x="10" y="140" width="150" height="54" rx="8" class="d-box d-dim"/><text x="85" y="163" text-anchor="middle" class="d-label">plaintext data</text><text x="85" y="181" text-anchor="middle" class="d-small">any size</text>
  <path d="M160 167 H248" class="d-arrow"/>
  <rect x="470" y="110" width="160" height="150" rx="10" class="d-box d-outer"/><text x="550" y="132" text-anchor="middle" class="d-label">stored together</text>
  <rect x="485" y="145" width="130" height="40" rx="6" class="d-box"/><text x="550" y="170" text-anchor="middle" class="d-small">ciphertext</text>
  <rect x="485" y="195" width="130" height="40" rx="6" class="d-box d-ok"/><text x="550" y="220" text-anchor="middle" class="d-small">encrypted data key</text>
  <path d="M420 167 H483" class="d-arrow"/><path d="M420 82 C 460 82, 450 215, 483 215" class="d-arrow"/>
  <text x="320" y="245" text-anchor="middle" class="d-small">To decrypt: send the encrypted data key to kms:Decrypt (an IAM-checked, CloudTrail-logged call),</text>
  <text x="320" y="262" text-anchor="middle" class="d-small">get the plaintext data key back, decrypt locally, wipe the key.</text>
</svg>
<figcaption>Envelope encryption. KMS only ever sees a 32-byte key, never your data. Access to the data is exactly access to <code>kms:Decrypt</code> on the KMS key.</figcaption>
</figure>

Why it's the right design:

- **Performance and cost.** One KMS call per object (or per batch), not per byte. Bulk crypto runs locally at memory speed.
- **Authorization stays in KMS.** Whoever holds the ciphertext and the encrypted data key still can't read anything without \`kms:Decrypt\`, which is logged and policy-controlled.
- **Blast radius.** Each object gets its own data key. One leaked data key exposes one object.
- **Rotation is cheap.** Rotating the KMS key doesn't touch your data; old encrypted data keys still decrypt. And if you ever need to move to a different KMS key, \`ReEncrypt\` re-wraps only the 32-byte data keys, without decrypting the data.

This is literally how S3 SSE-KMS, EBS and RDS encryption work. S3 **Bucket Keys** add one more layer: a bucket-level key derived from KMS for a while, cutting KMS requests (and cost) by up to 99%.

## Encryption context: authenticated, logged metadata

Every symmetric KMS operation accepts an **encryption context**, a map of non-secret key/value pairs such as \`{"tenant":"acme","purpose":"invoice"}\`. KMS binds it cryptographically to the ciphertext as *additional authenticated data*:

- **Decrypt must present the exact same context**, or it fails with \`InvalidCiphertextException\`. A ciphertext copied from tenant A's record into tenant B's can't be decrypted in B's context.
- It appears **in plaintext in CloudTrail**, so your audit log says *which* record was decrypted, not just "something was decrypted". (So never put secrets in it.)
- Key policies and grants can require it: \`"Condition": {"StringEquals": {"kms:EncryptionContext:tenant": "acme"}}\` limits a principal to one tenant's data.

AWS services set it for you: SSM uses \`PARAMETER_ARN\`, Secrets Manager uses \`SecretARN\`, S3 uses the object or bucket ARN.

## Try it: envelope-encrypt a file by hand

You'd use the AWS Encryption SDK in an application (it handles the message format, AES-GCM, key commitment and caching). Doing it by hand once makes the mechanism obvious. Make a key and a "large" file:

\`\`\`bash
aws kms create-key --description "demo envelope key" --query KeyMetadata.KeyId --output text > demo-env-key-id.txt
aws kms create-alias --alias-name alias/demo-envelope --target-key-id "$(cat demo-env-key-id.txt)"
seq 1 20000 > demo-big.txt && wc -c demo-big.txt
\`\`\`

Ask KMS for a data key, bound to an encryption context. Keep the plaintext key **only in a shell variable**, never on disk:

\`\`\`bash
read -r DK_PLAIN DK_CIPHER <<< "$(aws kms generate-data-key --key-id alias/demo-envelope --key-spec AES_256 \
  --encryption-context purpose=demo \
  --query '[Plaintext,CiphertextBlob]' --output text)"
DK_HEX=$(echo "$DK_PLAIN" | base64 -d | od -An -tx1 | tr -d ' \n')
IV=$(openssl rand -hex 16)
openssl enc -aes-256-cbc -K "$DK_HEX" -iv "$IV" -in demo-big.txt -out demo-big.txt.enc
echo "$DK_CIPHER" > demo-big.key.enc; echo "$IV" > demo-big.iv
unset DK_PLAIN DK_HEX
ls -l demo-big.*
\`\`\`

To decrypt, recover the data key from KMS. Watch it fail first with the wrong context:

\`\`\`bash
aws kms decrypt --ciphertext-blob "$(cat demo-big.key.enc)" --encryption-context purpose=other --query KeyId
\`\`\`

\`\`\`bash
DK_HEX=$(aws kms decrypt --ciphertext-blob "$(cat demo-big.key.enc)" --encryption-context purpose=demo \
  --key-id alias/demo-envelope --query Plaintext --output text | base64 -d | od -An -tx1 | tr -d ' \n')
openssl enc -d -aes-256-cbc -K "$DK_HEX" -iv "$(cat demo-big.iv)" -in demo-big.txt.enc | tail -3
unset DK_HEX
\`\`\`

Passing \`--key-id\` to \`decrypt\` is optional for symmetric keys, but it's a good habit: it makes KMS refuse ciphertext produced by a key you didn't expect.

## Pitfalls

- **Plaintext data keys on disk or in logs.** The whole scheme is only as strong as your handling of that 32-byte value. Never write it to a file, environment variable dump, crash report or debug log.
- **CBC without integrity.** \`openssl enc\` gives you AES-CBC, which doesn't detect tampering. Real systems use an authenticated mode (AES-GCM), which is one reason to use the Encryption SDK instead of rolling your own.
- **Reusing one data key forever.** Generate a new data key per object or per bounded batch. The Encryption SDK's *data key caching* lets you reuse one for a limited number of messages or seconds to cut KMS calls. Pick those limits deliberately.
- **Context drift.** If the writer and reader build the encryption context differently (key order doesn't matter, but key *names* and *values* do), decrypt fails. Put the context-building code in one shared library.
`,
    },
    {
      id: "envelope-lab",
      kind: "lab",
      title: "Lab: envelope-encrypt a report",
      minutes: 25,
      body: String.raw`
Finance exports \`report.csv\` every quarter, and it must be stored encrypted with a key the security team controls. You'll build the envelope by hand: a customer managed key, a data key bound to an encryption context, local AES encryption, and an envelope file that carries everything a reader needs **except** the plaintext key.

The envelope file format your team agreed on, \`report.envelope.json\`:

\`\`\`json
{
  "EncryptedDataKey": "<base64 CiphertextBlob from GenerateDataKey>",
  "IV": "<32 hex characters>",
  "EncryptionContext": { "purpose": "quarterly-report" }
}
\`\`\`

The ciphertext goes in \`report.csv.enc\`, encrypted with AES-256-CBC: \`openssl enc -aes-256-cbc -K <key-hex> -iv <iv-hex>\`.

Useful pieces (the envelope lesson walks through all of them):

\`\`\`text
--query '[Plaintext,CiphertextBlob]' --output text        two values on one line, for read -r A B
echo "$B64" | base64 -d | od -An -tx1 | tr -d ' \n'      base64 key -> hex for openssl -K
openssl rand -hex 16                                     a random 16-byte IV
printf '{"EncryptedDataKey":"%s","IV":"%s","EncryptionContext":{"purpose":"quarterly-report"}}\n' "$CIPHER" "$IV"
\`\`\`

> **On real AWS:** this lab uses \`openssl\` to show the mechanism. In an application, use the AWS Encryption SDK (or the service's own SSE-KMS), which uses authenticated AES-GCM, writes a standard message format with the encrypted data keys embedded, and supports data key caching.

Press **Prepare lab** to get \`report.csv\`.
`,
      lab: {
        files: {
          "report.csv": String.raw`
region,quarter,revenue_usd,margin_pct
north-america,2026-Q3,18250000,31.2
europe,2026-Q3,9420000,27.8
apac,2026-Q3,6110000,24.1
latam,2026-Q3,2380000,19.6
`,
        },
        tasks: [
          {
            id: "key",
            title: "Create a customer managed key with rotation",
            description:
              "Create a symmetric customer managed KMS key, point the alias `alias/reports` at it, and enable **automatic rotation**.",
            hints: [
              "`aws kms create-key --description … --query KeyMetadata.KeyId --output text`, then `aws kms create-alias --alias-name alias/reports --target-key-id <id>`.",
              "Then `aws kms enable-key-rotation --key-id <key-id>`. Use the key ID or ARN, not the alias: on real AWS the rotation APIs don't accept aliases (the emulator is more lenient).",
            ],
            check: async (ctx) => {
              const d = await ctx.tryAws(["kms", "describe-key", "--key-id", "alias/reports"]);
              if (!d.ok) return "The alias `alias/reports` doesn't exist yet.";
              const m = d.data.KeyMetadata;
              if (m.KeyManager !== "CUSTOMER") return `alias/reports points at an ${m.KeyManager} managed key; create your own key.`;
              if (m.KeySpec !== "SYMMETRIC_DEFAULT" || m.KeyUsage !== "ENCRYPT_DECRYPT") return `The key is ${m.KeySpec}/${m.KeyUsage}; expected a symmetric ENCRYPT_DECRYPT key.`;
              if (m.KeyState !== "Enabled") return `The key is ${m.KeyState}; it must be Enabled.`;
              const rot = await ctx.aws(["kms", "get-key-rotation-status", "--key-id", m.KeyId]);
              if (!rot.KeyRotationEnabled) return "Automatic rotation isn't enabled on the key.";
              return true;
            },
          },
          {
            id: "encrypt",
            title: "Encrypt the report with a data key",
            description:
              "Generate an AES-256 data key under `alias/reports` with the encryption context `purpose=quarterly-report`. Encrypt `report.csv` locally into `report.csv.enc` with that key and a random IV, and write `report.envelope.json` in the format above. Keep `report.csv` so the check can compare.",
            hints: [
              "`aws kms generate-data-key --key-id alias/reports --key-spec AES_256 --encryption-context purpose=quarterly-report --query '[Plaintext,CiphertextBlob]' --output text`",
              "Capture with `read -r PLAIN CIPHER <<< \"$(…)\"`, convert PLAIN to hex, then `openssl enc -aes-256-cbc -K \"$KEY_HEX\" -iv \"$IV\" -in report.csv -out report.csv.enc`.",
              "Write the envelope with the `printf` line from the lab notes, using `$CIPHER` and `$IV`.",
            ],
            check: async (ctx) => {
              const env = await envelope(ctx);
              if (typeof env === "string") return env;
              if (env.ec?.purpose !== "quarterly-report") return "The envelope's `EncryptionContext` must be `{\"purpose\": \"quarterly-report\"}`.";
              const enc = await ctx.sh("test -s report.csv.enc && ! cmp -s report.csv report.csv.enc");
              if (enc.code !== 0) return "`report.csv.enc` is missing, empty, or identical to the plaintext.";
              const ctxless = await ctx.sh(`aws kms decrypt --ciphertext-blob '${env.edk}' --query KeyId --output text`);
              if (ctxless.code === 0) return "The data key decrypts **without** an encryption context. Generate it with `--encryption-context purpose=quarterly-report`.";
              const kd = await ctx.sh(`aws kms decrypt --ciphertext-blob '${env.edk}' --encryption-context ${REPORT_CONTEXT} --query KeyId --output text`);
              if (kd.code !== 0) return "KMS can't decrypt `EncryptedDataKey` with the context `purpose=quarterly-report`.";
              const want = await keyArn(ctx, "alias/reports");
              if (kd.stdout.trim() !== want) return "The data key was encrypted under a different KMS key than `alias/reports`.";
              const hex = await dataKeyHex(ctx, env.edk);
              const ok = await ctx.sh(`openssl enc -d -aes-256-cbc -K ${hex} -iv ${env.iv} -in report.csv.enc 2>/dev/null | cmp -s - report.csv`);
              if (!hex || ok.code !== 0) return "Decrypting `report.csv.enc` with the envelope's data key and IV doesn't give back `report.csv`. Check the key conversion to hex and the IV.";
              return true;
            },
          },
          {
            id: "hygiene",
            title: "Leave no plaintext key behind",
            description:
              "Make sure the plaintext data key isn't stored **anywhere** in the lab folder, in base64 or hex (for example a saved `generate-data-key` JSON output). Only the encrypted data key belongs on disk.",
            hints: [
              "If you saved the full `generate-data-key` output to a file, delete that file: its `Plaintext` field is the key.",
              "Keep the plaintext key in a shell variable and `unset` it when you're done.",
            ],
            check: async (ctx) => {
              const env = await envelope(ctx);
              if (typeof env === "string") return env;
              const hex = await dataKeyHex(ctx, env.edk);
              if (!hex) return "Can't decrypt the envelope's data key yet; finish the previous task first.";
              const b64 = Buffer.from(hex, "hex").toString("base64");
              const r = await ctx.sh(`grep -rlaiF -e '${hex}' -e '${b64}' . 2>/dev/null || true`);
              const files = r.stdout.trim();
              if (files) return `The plaintext data key is stored in: ${files.split("\n").join(", ")}. Delete it.`;
              return true;
            },
          },
          {
            id: "rotate-decrypt",
            title: "Rotate the key, then decrypt as a reader",
            description:
              "Rotate the key material **on demand**. Then, acting as a reader who only has the envelope and `report.csv.enc`, recover the report into `report.decrypted.csv`. Old envelopes keep working after rotation because KMS keeps every previous key version.",
            hints: [
              "`aws kms rotate-key-on-demand --key-id <key-id>`, then `aws kms list-key-rotations --key-id <key-id>`.",
              "`aws kms decrypt --ciphertext-blob \"$(jq -r .EncryptedDataKey report.envelope.json)\" --encryption-context purpose=quarterly-report --key-id alias/reports --query Plaintext --output text`, then convert to hex.",
              "`openssl enc -d -aes-256-cbc -K \"$KEY_HEX\" -iv \"$(jq -r .IV report.envelope.json)\" -in report.csv.enc -out report.decrypted.csv`",
            ],
            check: async (ctx) => {
              const d = await ctx.tryAws(["kms", "describe-key", "--key-id", "alias/reports"]);
              if (!d.ok) return "The alias `alias/reports` doesn't exist yet.";
              const rot = await ctx.tryAws(["kms", "list-key-rotations", "--key-id", d.data.KeyMetadata.KeyId]);
              const onDemand = (rot.data?.Rotations ?? []).filter((r: any) => r.RotationType === "ON_DEMAND");
              if (!onDemand.length) return "The key has no on-demand rotation yet.";
              const same = await ctx.sh("test -f report.decrypted.csv && cmp -s report.csv report.decrypted.csv");
              if (same.code !== 0) return "`report.decrypted.csv` is missing or differs from `report.csv`.";
              return true;
            },
          },
        ],
        solution: String.raw`
KEY_ID=$(aws kms create-key --description "Quarterly finance reports" --tags TagKey=data,TagValue=finance \
  --query KeyMetadata.KeyId --output text)
aws kms create-alias --alias-name alias/reports --target-key-id "$KEY_ID"
aws kms enable-key-rotation --key-id "$KEY_ID"

# Writer: data key in memory only.
read -r PLAIN CIPHER <<< "$(aws kms generate-data-key --key-id alias/reports --key-spec AES_256 \
  --encryption-context purpose=quarterly-report --query '[Plaintext,CiphertextBlob]' --output text)"
KEY_HEX=$(echo "$PLAIN" | base64 -d | od -An -tx1 | tr -d ' \n')
IV=$(openssl rand -hex 16)
openssl enc -aes-256-cbc -K "$KEY_HEX" -iv "$IV" -in report.csv -out report.csv.enc
printf '{"EncryptedDataKey":"%s","IV":"%s","EncryptionContext":{"purpose":"quarterly-report"}}\n' "$CIPHER" "$IV" > report.envelope.json
unset PLAIN KEY_HEX CIPHER IV

aws kms rotate-key-on-demand --key-id "$KEY_ID"
aws kms list-key-rotations --key-id "$KEY_ID"

# Reader: only the envelope and the ciphertext.
EDK=$(jq -r .EncryptedDataKey report.envelope.json)
KEY_HEX=$(aws kms decrypt --ciphertext-blob "$EDK" --encryption-context purpose=quarterly-report \
  --key-id alias/reports --query Plaintext --output text | base64 -d | od -An -tx1 | tr -d ' \n')
openssl enc -d -aes-256-cbc -K "$KEY_HEX" -iv "$(jq -r .IV report.envelope.json)" -in report.csv.enc -out report.decrypted.csv
unset KEY_HEX
cmp report.csv report.decrypted.csv
`,
      },
    },
    {
      id: "secrets-params",
      kind: "reading",
      title: "Secrets Manager vs Parameter Store",
      minutes: 14,
      body: String.raw`
AWS has two places to keep configuration and secrets, and they overlap enough to confuse everyone. The short version: **Parameter Store is a cheap, hierarchical configuration store that can encrypt values. Secrets Manager is a secret lifecycle service: versions, rotation, replication and resource policies.**

## SSM Parameter Store

Parameters are named like paths, and that hierarchy is the feature:

\`\`\`text
/orders/dev/db/host            String        orders-db.dev.internal
/orders/dev/db/password        SecureString  (KMS-encrypted)
/orders/dev/features           StringList    new-checkout,fast-refunds
/orders/prod/db/host           String        orders-db.prod.internal
\`\`\`

- **Types:** \`String\`, \`StringList\` (comma-separated) and \`SecureString\` (encrypted with KMS: \`alias/aws/ssm\` by default, or your own key with \`--key-id\`).
- **Hierarchies:** \`get-parameters-by-path --path /orders/dev --recursive\` loads an app's whole config in one call, and IAM policies scope access by path (\`parameter/orders/dev/*\`).
- **Versions and labels:** every overwrite creates a new version. Reference one with \`name:3\`, or attach a label (\`name:stable\`) to pin consumers.
- **Tiers:** *Standard* is free, 4 KB values, 10,000 parameters per region. *Advanced* is $0.05 per parameter per month, 8 KB values, and supports **parameter policies** (expiration, "notify if not changed in 90 days").
- **Throughput:** about 40 transactions per second by default, shared across the account and region. Raising it ("higher throughput") costs per API call. Apps that call \`GetParameter\` on every request will be throttled during a traffic spike. Cache.
- **Public parameters:** AWS publishes values like \`/aws/service/ami-amazon-linux-latest/…\`, which is how IaC finds the latest AMI.

\`\`\`bash
aws kms create-alias --alias-name alias/demo-config \
  --target-key-id "$(aws kms create-key --description 'demo config key' --query KeyMetadata.KeyId --output text)"
aws ssm put-parameter --name /demo/dev/db/host --type String --value demo-db.dev.internal
aws ssm put-parameter --name /demo/dev/db/password --type SecureString --key-id alias/demo-config --value 'not-a-real-password'
aws ssm put-parameter --name /demo/dev/features --type StringList --value 'new-checkout,fast-refunds'
aws ssm get-parameters-by-path --path /demo/dev --recursive --query 'Parameters[].[Name,Type,Value]' --output table
\`\`\`

Note that the SecureString comes back as ciphertext. Add \`--with-decryption\` and SSM calls \`kms:Decrypt\` *as you*, which means the caller needs permission on the **KMS key**, not just on the parameter:

\`\`\`bash
aws ssm get-parameter --name /demo/dev/db/password --with-decryption --query Parameter.Value --output text
aws ssm put-parameter --name /demo/dev/db/password --type SecureString --key-id alias/demo-config --value 'rotated-1' --overwrite
aws ssm get-parameter-history --name /demo/dev/db/password --query 'Parameters[].[Version,LastModifiedDate]' --output text
\`\`\`

## Secrets Manager

A secret is a named container of **versions**, each a string (usually JSON) or binary blob, encrypted with KMS (\`aws/secretsmanager\` or your key). What you pay for, about $0.40 per secret per month plus API calls, is the lifecycle:

- **Staging labels** point at versions. \`AWSCURRENT\` is what \`get-secret-value\` returns by default. \`AWSPREVIOUS\` is the version before it. \`AWSPENDING\` is a version being rotated in. Labels move; version IDs don't.
- **Rotation:** Secrets Manager invokes a Lambda function on a schedule, which creates the new credential, sets it in the database, tests it and promotes it. Managed rotation templates exist for RDS, Redshift and DocumentDB, and RDS can even manage its master password in Secrets Manager entirely.
- **Resource policies:** attach a policy to the secret to allow another account or deny everyone except one role. \`--block-public-policy\` rejects policies that would make it public.
- **Replication** to other regions for DR, and native integrations: RDS, ECS/EKS secret injection, CloudFormation dynamic references.

<figure class="diagram">
<svg viewBox="0 0 640 230" role="img" aria-label="Secret rotation: a Lambda runs createSecret, setSecret, testSecret and finishSecret, moving the AWSCURRENT label from the old version to the new one">
  <rect x="10" y="20" width="140" height="44" rx="8" class="d-box"/><text x="80" y="47" text-anchor="middle" class="d-label">1 createSecret</text>
  <rect x="170" y="20" width="140" height="44" rx="8" class="d-box"/><text x="240" y="47" text-anchor="middle" class="d-label">2 setSecret</text>
  <rect x="330" y="20" width="140" height="44" rx="8" class="d-box"/><text x="400" y="47" text-anchor="middle" class="d-label">3 testSecret</text>
  <rect x="490" y="20" width="140" height="44" rx="8" class="d-box d-accent"/><text x="560" y="47" text-anchor="middle" class="d-label">4 finishSecret</text>
  <path d="M150 42 H168" class="d-arrow"/><path d="M310 42 H328" class="d-arrow"/><path d="M470 42 H488" class="d-arrow"/>
  <text x="80" y="82" text-anchor="middle" class="d-small">new version, AWSPENDING</text>
  <text x="240" y="82" text-anchor="middle" class="d-small">set it in the database</text>
  <text x="400" y="82" text-anchor="middle" class="d-small">log in with AWSPENDING</text>
  <text x="560" y="82" text-anchor="middle" class="d-small">move AWSCURRENT</text>
  <rect x="60" y="120" width="160" height="90" rx="8" class="d-box d-dim"/><text x="140" y="146" text-anchor="middle" class="d-label">version v1</text><text x="140" y="170" text-anchor="middle" class="d-small">AWSCURRENT</text><text x="140" y="190" text-anchor="middle" class="d-small">→ AWSPREVIOUS</text>
  <rect x="420" y="120" width="160" height="90" rx="8" class="d-box d-ok"/><text x="500" y="146" text-anchor="middle" class="d-label">version v2</text><text x="500" y="170" text-anchor="middle" class="d-small">AWSPENDING</text><text x="500" y="190" text-anchor="middle" class="d-small">→ AWSCURRENT</text>
  <path d="M220 165 H418" class="d-arrow d-dashed"/><text x="320" y="157" text-anchor="middle" class="d-small">label moves; apps re-read AWSCURRENT</text>
</svg>
<figcaption>Rotation is four Lambda steps around label moves. Clients that cache must cope with the moment the old password stops working.</figcaption>
</figure>

Try the label mechanics on a demo secret:

\`\`\`bash
aws secretsmanager create-secret --name demo/dev/api-key --kms-key-id alias/demo-config \
  --secret-string '{"key":"v1-aaaa"}' --query VersionId --output text
aws secretsmanager put-secret-value --secret-id demo/dev/api-key --secret-string '{"key":"v2-bbbb"}' --query VersionStages
aws secretsmanager list-secret-version-ids --secret-id demo/dev/api-key \
  --query 'Versions[].{id:VersionId,stages:VersionStages}'
\`\`\`

\`put-secret-value\` moved \`AWSCURRENT\` to the new version and \`AWSPREVIOUS\` to the old one. Now see a resource policy work: deny everyone except a named role, and you (the \`emulator\` user) are locked out too:

\`\`\`bash
aws secretsmanager put-resource-policy --secret-id demo/dev/api-key --block-public-policy --resource-policy '{
  "Version": "2012-10-17",
  "Statement": [{ "Effect": "Deny", "Principal": "*", "Action": "secretsmanager:GetSecretValue", "Resource": "*",
    "Condition": { "StringNotEquals": { "aws:PrincipalArn": "arn:aws:iam::000000000000:role/demo-only-reader" } } }] }'
aws secretsmanager get-secret-value --secret-id demo/dev/api-key --query SecretString
\`\`\`

\`\`\`bash
aws secretsmanager delete-resource-policy --secret-id demo/dev/api-key
aws secretsmanager get-secret-value --secret-id demo/dev/api-key --query SecretString --output text
\`\`\`

A "deny all except" statement like this is how teams make sure a production database password is readable by exactly one workload, regardless of who has \`AdministratorAccess\`. Keep a break-glass role in the exception list, or you'll need to lock yourself back in through the root user.

## When to use which

| Need | Parameter Store | Secrets Manager |
|---|---|---|
| Non-secret config (hosts, flags, ARNs) | ✅ String / StringList, free | overkill |
| A few static secrets, low budget | ✅ SecureString | ✅ |
| Automatic rotation (DB passwords) | ❌ build it yourself | ✅ built in |
| Cross-account sharing of one secret | ❌ (no resource policies) | ✅ resource policy + CMK |
| Cross-region replication | ❌ | ✅ |
| Values over 8 KB | ❌ | ✅ up to 64 KB |
| High read rates | ⚠️ 40 TPS default | ⚠️ 10,000 GetSecretValue/s, but cache anyway |

A common, sensible split: **configuration and pointers in Parameter Store, credentials in Secrets Manager.** Parameter Store can even read secrets through the \`/aws/reference/secretsmanager/<secret-name>\` path, so apps that only speak SSM can fetch both.

## Certificates are not secrets you store: ACM

TLS certificates for load balancers, CloudFront and API Gateway belong in **AWS Certificate Manager**. Public certificates are free, validated by DNS (a CNAME record, ideally created by IaC in Route 53), and **renewed automatically** as long as the validation record stays in place. The private key never leaves AWS, so there's nothing to rotate by hand or leak. Use **ACM Private CA** for internal mTLS. Only import certificates into ACM if you must, because imported certificates don't renew.

\`\`\`bash
aws acm request-certificate --domain-name demo.example.com --validation-method DNS --query CertificateArn --output text
aws acm list-certificates --query 'CertificateSummaryList[].[DomainName,Status]' --output text
\`\`\`

It stays \`PENDING_VALIDATION\` until the DNS record exists. That status is the most common reason a CloudFormation stack with a load balancer listener hangs for hours.

> **On real AWS:** CloudFront requires its certificate in \`us-east-1\`, whatever region your origin runs in. ACM certificates are regional resources, just like KMS keys.
`,
    },
    {
      id: "runtime",
      kind: "reading",
      title: "Getting secrets into applications safely",
      minutes: 12,
      body: String.raw`
Storing a secret well is half the job. The other half is getting it into a running process without leaking it, without hammering the API, and without breaking when it rotates.

## Three delivery patterns

| Pattern | How | Good | Watch out for |
|---|---|---|---|
| **Inject at start** | ECS task definition \`secrets\`, EKS Secrets Store CSI driver, Lambda reading at init | No SDK code; the platform fetches with the *task execution role* | The value is frozen until the task restarts, so rotation needs a redeploy. Environment variables leak into crash dumps, \`/proc\`, and "print env" debug endpoints. |
| **Fetch and cache in-process** | SDK call at startup + TTL cache (AWS provides caching clients for Java, Python, Go, .NET) | Picks up rotation within the TTL; one call per TTL, not per request | Cache invalidation on auth failure (below). |
| **Sidecar / extension** | Lambda *Parameters and Secrets* extension (local HTTP cache on \`localhost:2773\`), ECS sidecar | Language-agnostic, shared cache | One more moving part. |

**Never** bake secrets into images, AMIs, Lambda zip files, Terraform state outputs, or CloudFormation parameters without \`NoEcho\` (and even \`NoEcho\` values are visible to anyone who can call \`GetTemplate\`). Use CloudFormation *dynamic references* (\`{{resolve:secretsmanager:prod/db:SecretString:password}}\`) so the value never appears in the template.

## Rotation-safe clients

Any cached secret is a stale secret during rotation. The robust pattern:

1. Read \`AWSCURRENT\`, cache it for a few minutes.
2. On an **authentication failure** from the database or API, bypass the cache, re-read \`AWSCURRENT\`, and retry once.
3. Prefer rotation strategies that keep the old credential valid for a while. Secrets Manager's *alternating users* strategy keeps two database users and rotates them in turn, so \`AWSPREVIOUS\` still works while caches drain.

A minimal Python version of the cache, standard library and boto3 only:

\`\`\`text
import json, time, boto3
_sm = boto3.client("secretsmanager")
_cache = {}

def get_secret(name, ttl=300, force=False):
    hit = _cache.get(name)
    if hit and not force and time.time() - hit[1] < ttl:
        return hit[0]
    value = json.loads(_sm.get_secret_value(SecretId=name)["SecretString"])
    _cache[name] = (value, time.time())
    return value

def connect():
    creds = get_secret("orders/prod/db")
    try:
        return db_connect(creds)
    except AuthError:
        return db_connect(get_secret("orders/prod/db", force=True))   # rotated under us
\`\`\`

## Scope access by path, tag and key

The hierarchy you choose is your permission model. With \`/<app>/<env>/…\` names, one policy per app and environment falls out naturally:

\`\`\`json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "ReadOwnConfigTree", "Effect": "Allow",
      "Action": "ssm:GetParametersByPath",
      "Resource": "arn:aws:ssm:us-east-1:111122223333:parameter/orders/prod" },
    { "Sid": "ReadOwnParameters", "Effect": "Allow",
      "Action": ["ssm:GetParameter", "ssm:GetParameters"],
      "Resource": "arn:aws:ssm:us-east-1:111122223333:parameter/orders/prod/*" },
    { "Sid": "ReadOwnSecrets", "Effect": "Allow",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": "arn:aws:secretsmanager:us-east-1:111122223333:secret:orders/prod/*" },
    { "Sid": "DecryptOnlyViaTheseServices", "Effect": "Allow",
      "Action": "kms:Decrypt",
      "Resource": "arn:aws:kms:us-east-1:111122223333:key/1234abcd-…",
      "Condition": { "StringEquals": { "kms:ViaService": ["ssm.us-east-1.amazonaws.com", "secretsmanager.us-east-1.amazonaws.com"] } } }
  ]
}
\`\`\`

Details that matter:

- \`GetParametersByPath\` is authorized against the **path itself** (\`parameter/orders/prod\`), while \`GetParameter\` is authorized against each parameter (\`parameter/orders/prod/*\`). You need both statements.
- Parameter ARNs have **no slash** between \`parameter\` and the name's leading slash: \`parameter/orders/prod\`, not \`parameter//orders/prod\`.
- Secret ARNs end in a random 6-character suffix (\`orders/prod/db-a1B2c3\`), so grant with a trailing \`*\` or \`-??????\`, not the bare name.
- \`kms:ViaService\` means the role can decrypt *through SSM or Secrets Manager*, but can't call \`kms:Decrypt\` directly on ciphertext it found somewhere else. For even tighter control, condition on the encryption context those services set (\`kms:EncryptionContext:PARAMETER_ARN\`, \`kms:EncryptionContext:SecretARN\`).
- Using a **customer managed key per environment** means prod secrets are unreadable from a dev role even if a path policy is wrong. That's defence in depth for the price of $1 a month.
- ABAC is an alternative: tag secrets \`app=orders\` and allow \`secretsmanager:GetSecretValue\` when \`aws:ResourceTag/app\` equals \`aws:PrincipalTag/app\`.

## Audit and detection

Every \`GetSecretValue\`, \`GetParameter\` with decryption and \`kms:Decrypt\` lands in CloudTrail with the caller's identity. A senior setup alarms on:

- \`GetSecretValue\` from principals that aren't the owning workload (an engineer reading a prod password should be rare, and visible);
- \`kms:Decrypt\` failures (\`AccessDenied\`, \`InvalidCiphertextException\`) spiking, which often precedes an outage or signals probing;
- \`ScheduleKeyDeletion\`, \`DisableKey\`, \`PutKeyPolicy\`, \`DeleteSecret\` and \`PutResourcePolicy\`: rare, high-impact changes.

> **On real AWS:** the emulator enforces KMS permissions for role sessions (a role without \`kms:Decrypt\` can't read a SecureString), but it doesn't enforce SSM's own path-level permissions on live calls. Use \`iam simulate-principal-policy\` to prove path scoping, as the next lab does, and test the denial in a real sandbox account before relying on it.
`,
    },
    {
      id: "config-lab",
      kind: "lab",
      title: "Lab: config, secrets and a scoped app role",
      minutes: 35,
      body: String.raw`
The \`orders-api\` service is moving off a \`.env\` file. You'll give it a proper home for configuration and credentials, and a role that can read **its own environment's** values and nothing else.

Already created by **Prepare lab**:

- a customer managed KMS key with the alias \`alias/orders-config\` (this team's config key), and
- the IAM role \`orders-api\` (the service's task role). For this lab its trust policy also lets your account assume it, so the checks can test it end to end.

\`\`\`bash
aws kms describe-key --key-id alias/orders-config --query 'KeyMetadata.[Arn,KeyManager]' --output text
aws iam get-role --role-name orders-api --query Role.AssumeRolePolicyDocument
\`\`\`

Target layout:

\`\`\`text
/orders/dev/db/host         String        orders-db.dev.internal
/orders/dev/db/password     SecureString  (any value, alias/orders-config)
/orders/dev/features        StringList    new-checkout,fast-refunds
/orders/prod/db/password    SecureString  (any value, alias/orders-config)

Secrets Manager: orders/dev/db-credentials  {"username":"orders_app","password":"…"}   (alias/orders-config)
\`\`\`

> **On real AWS:** dev and prod would normally live in separate accounts, each with its own key, and that's the strongest boundary of all. Paths and policies are how you separate environments that *share* an account, and how you separate apps within one.
`,
      lab: {
        setup: String.raw`
if ! aws kms describe-key --key-id alias/orders-config >/dev/null 2>&1; then
  KEY_ID=$(aws kms create-key --description "orders-api configuration" --tags TagKey=app,TagValue=orders \
    --query KeyMetadata.KeyId --output text)
  aws kms create-alias --alias-name alias/orders-config --target-key-id "$KEY_ID"
fi
TRUST='{"Version":"2012-10-17","Statement":[{"Sid":"EcsTasks","Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"},{"Sid":"LabTesting","Effect":"Allow","Principal":{"AWS":"arn:aws:iam::000000000000:root"},"Action":"sts:AssumeRole"}]}'
if aws iam get-role --role-name orders-api >/dev/null 2>&1; then
  aws iam update-assume-role-policy --role-name orders-api --policy-document "$TRUST"
else
  aws iam create-role --role-name orders-api --assume-role-policy-document "$TRUST" \
    --description "Task role for the orders-api service" --tags Key=app,Value=orders >/dev/null
fi
echo "alias/orders-config and role orders-api are ready."
`,
        tasks: [
          {
            id: "hierarchy",
            title: "Build the parameter hierarchy",
            description:
              "Create the four parameters in the target layout with the exact names and types shown. Both `SecureString` parameters must be encrypted with `alias/orders-config`, not the default `alias/aws/ssm`.",
            hints: [
              "`aws ssm put-parameter --name /orders/dev/db/host --type String --value orders-db.dev.internal`",
              "SecureStrings take `--key-id alias/orders-config`. To change an existing parameter, add `--overwrite`.",
              "StringList values are comma-separated: `--type StringList --value 'new-checkout,fast-refunds'`.",
            ],
            check: async (ctx) => {
              const r = await ctx.tryAws(["ssm", "get-parameters-by-path", "--path", "/orders", "--recursive"]);
              const params = Object.fromEntries((r.data?.Parameters ?? []).map((p: any) => [p.Name, p]));
              const want: [string, string, string?][] = [
                ["/orders/dev/db/host", "String", "orders-db.dev.internal"],
                ["/orders/dev/db/password", "SecureString"],
                ["/orders/dev/features", "StringList", "new-checkout,fast-refunds"],
                ["/orders/prod/db/password", "SecureString"],
              ];
              for (const [name, type, value] of want) {
                const p = params[name];
                if (!p) return `Parameter \`${name}\` doesn't exist yet.`;
                if (p.Type !== type) return `\`${name}\` is a ${p.Type}; expected ${type}.`;
                if (value !== undefined && p.Value !== value) return `\`${name}\` is \`${p.Value}\`; expected \`${value}\`.`;
              }
              const cmk = await keyArn(ctx, "alias/orders-config");
              for (const name of ["/orders/dev/db/password", "/orders/prod/db/password"]) {
                const d = await ctx.aws(["ssm", "describe-parameters", "--parameter-filters", `Key=Name,Option=Equals,Values=${name}`]);
                const k = d.Parameters?.[0]?.KeyId;
                if ((await keyArn(ctx, k)) !== cmk) return `\`${name}\` is encrypted with \`${k}\`; expected \`alias/orders-config\`. Recreate it with \`--key-id alias/orders-config --overwrite\`.`;
              }
              return true;
            },
          },
          {
            id: "scope",
            title: "Scope the app role to its own environment",
            description:
              "Attach an inline policy named `read-dev-config` to the role `orders-api` so it can load everything under `/orders/dev` (by path, recursively, **and** by individual name) and decrypt it with the `alias/orders-config` key, and nothing under `/orders/prod`, no writes. The check simulates allowed and forbidden calls, then assumes `orders-api` and loads `/orders/dev` with decryption.",
            hints: [
              "Three statements: `ssm:GetParametersByPath` on `arn:aws:ssm:us-east-1:000000000000:parameter/orders/dev`; `ssm:GetParameter` and `ssm:GetParameters` on `…:parameter/orders/dev/*`; `kms:Decrypt` on the key's **ARN** (aliases don't work in an IAM `Resource`).",
              "Get the key ARN with `aws kms describe-key --key-id alias/orders-config --query KeyMetadata.Arn --output text`.",
              "Test it yourself: assume `orders-api`, export the credentials, run `aws ssm get-parameters-by-path --path /orders/dev --recursive --with-decryption`, then unset them.",
            ],
            check: async (ctx) => {
              const r = await ctx.tryAws(["iam", "get-role-policy", "--role-name", ROLE, "--policy-name", "read-dev-config"]);
              if (!r.ok) return "`orders-api` has no inline policy named `read-dev-config` yet.";
              const cmk = await keyArn(ctx, "alias/orders-config");
              if (!cmk) return "The key `alias/orders-config` is missing. Press Prepare lab again.";
              const other = await keyArn(ctx, "alias/aws/ssm");
              const want: [string, string[], string][] = [
                ["allowed", ["ssm:GetParametersByPath"], paramArn(ctx, "/orders/dev")],
                ["allowed", ["ssm:GetParameter", "ssm:GetParameters"], paramArn(ctx, "/orders/dev/db/password")],
                ["allowed", ["kms:Decrypt"], cmk],
                ["denied", ["ssm:GetParametersByPath"], paramArn(ctx, "/orders/prod")],
                ["denied", ["ssm:GetParameter", "ssm:GetParameters"], paramArn(ctx, "/orders/prod/db/password")],
                ["denied", ["ssm:PutParameter", "ssm:DeleteParameter"], paramArn(ctx, "/orders/dev/db/password")],
                ["denied", ["kms:Encrypt", "kms:CreateGrant", "kms:ScheduleKeyDeletion"], cmk],
              ];
              if (other) want.push(["denied", ["kms:Decrypt"], other]);
              for (const [expect, actions, resource] of want) {
                const d = await simulate(ctx, actions, resource);
                for (const a of actions) {
                  if (expect === "allowed" && d[a] !== "allowed") return `\`${a}\` on \`${resource}\` is ${d[a]}; the service needs it.`;
                  if (expect === "denied" && d[a] === "allowed") return `\`${a}\` on \`${resource}\` is allowed. The service must not have it.`;
                }
              }
              const live = await ctx.sh(`set -e
read -r AK SK ST <<< "$(aws sts assume-role --role-arn arn:aws:iam::${ctx.account}:role/${ROLE} --role-session-name lab-check --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text)"
AWS_ACCESS_KEY_ID="$AK" AWS_SECRET_ACCESS_KEY="$SK" AWS_SESSION_TOKEN="$ST" \
  aws ssm get-parameters-by-path --path /orders/dev --recursive --with-decryption --query 'Parameters[].Name' --output text`);
              if (live.code !== 0) return `As \`orders-api\`, loading /orders/dev with decryption fails: ${live.stderr.trim().split("\n").pop()}`;
              if (!live.stdout.includes("/orders/dev/db/password")) return "As `orders-api`, /orders/dev/db/password isn't returned. Finish the hierarchy task first.";
              return true;
            },
          },
          {
            id: "secret",
            title: "Store the database credentials in Secrets Manager",
            description:
              "Create the secret `orders/dev/db-credentials`, encrypted with `alias/orders-config`, whose value is JSON with `username` = `orders_app` and a generated `password` of at least 20 characters.",
            hints: [
              "Generate a password with `aws secretsmanager get-random-password --password-length 32 --exclude-punctuation --query RandomPassword --output text`.",
              "`aws secretsmanager create-secret --name orders/dev/db-credentials --kms-key-id alias/orders-config --secret-string \"{\\\"username\\\":\\\"orders_app\\\",\\\"password\\\":\\\"$PW\\\"}\"`",
            ],
            check: async (ctx) => {
              const d = await ctx.tryAws(["secretsmanager", "describe-secret", "--secret-id", "orders/dev/db-credentials"]);
              if (!d.ok) return "Secret `orders/dev/db-credentials` doesn't exist yet.";
              if ((await keyArn(ctx, d.data.KmsKeyId)) !== (await keyArn(ctx, "alias/orders-config")))
                return `The secret is encrypted with \`${d.data.KmsKeyId ?? "aws/secretsmanager (default)"}\`; expected \`alias/orders-config\`. Change it with \`aws secretsmanager update-secret --kms-key-id\`.`;
              const v = await ctx.aws(["secretsmanager", "get-secret-value", "--secret-id", "orders/dev/db-credentials"]);
              const j = parseSecret(v.SecretString);
              if (!j) return "The secret value isn't valid JSON.";
              if (j.username !== "orders_app") return `\`username\` is \`${j.username}\`; expected \`orders_app\`.`;
              if (typeof j.password !== "string" || j.password.length < 20) return "`password` must be a string of at least 20 characters. Generate one.";
              return true;
            },
          },
          {
            id: "rotate",
            title: "Rotate by hand: stage, promote, clean up",
            description:
              "Do what a rotation Lambda does. Put a **new** version of `orders/dev/db-credentials` (same username, new generated password) with only the `AWSPENDING` label, then move `AWSCURRENT` to it and remove `AWSPENDING`. End state: exactly one `AWSCURRENT` (the new password), the original version labelled `AWSPREVIOUS`, and no `AWSPENDING` label anywhere.",
            hints: [
              "`aws secretsmanager put-secret-value --secret-id orders/dev/db-credentials --secret-string … --version-stages AWSPENDING`, and note the returned `VersionId`.",
              "Check with `aws secretsmanager get-secret-value --secret-id orders/dev/db-credentials --version-stage AWSPENDING` that the default read still returns the old password.",
              "`aws secretsmanager update-secret-version-stage --secret-id … --version-stage AWSCURRENT --move-to-version-id <new> --remove-from-version-id <old>`, then the same command with `--version-stage AWSPENDING --remove-from-version-id <new>`.",
            ],
            check: async (ctx) => {
              const l = await ctx.tryAws(["secretsmanager", "list-secret-version-ids", "--secret-id", "orders/dev/db-credentials"]);
              if (!l.ok) return "Secret `orders/dev/db-credentials` doesn't exist yet.";
              const versions: any[] = l.data.Versions ?? [];
              const withLabel = (s: string) => versions.filter((v) => (v.VersionStages ?? []).includes(s));
              if (versions.length < 2) return "The secret has only one version. Put a new one with the `AWSPENDING` label.";
              if (withLabel("AWSPENDING").length) return "A version still carries `AWSPENDING`. Promote it to `AWSCURRENT`, then remove the `AWSPENDING` label.";
              const cur = withLabel("AWSCURRENT");
              const prev = withLabel("AWSPREVIOUS");
              if (cur.length !== 1) return `Expected exactly one AWSCURRENT version, found ${cur.length}.`;
              if (prev.length !== 1) return "No version is labelled `AWSPREVIOUS`. Use `--remove-from-version-id <old>` when you move AWSCURRENT, so the old version becomes AWSPREVIOUS.";
              const get = async (id: string) =>
                parseSecret((await ctx.aws(["secretsmanager", "get-secret-value", "--secret-id", "orders/dev/db-credentials", "--version-id", id])).SecretString);
              const c = await get(cur[0].VersionId);
              const p = await get(prev[0].VersionId);
              if (!c || c.username !== "orders_app" || typeof c.password !== "string" || c.password.length < 20)
                return "The AWSCURRENT version must be JSON with username `orders_app` and a password of at least 20 characters.";
              if (p && c.password === p.password) return "AWSCURRENT and AWSPREVIOUS have the same password. The new version needs a new password.";
              return true;
            },
          },
        ],
        solution: String.raw`
aws ssm put-parameter --name /orders/dev/db/host --type String --value orders-db.dev.internal --overwrite
aws ssm put-parameter --name /orders/dev/db/password --type SecureString --key-id alias/orders-config \
  --value "$(aws secretsmanager get-random-password --password-length 32 --exclude-punctuation --query RandomPassword --output text)" --overwrite
aws ssm put-parameter --name /orders/dev/features --type StringList --value 'new-checkout,fast-refunds' --overwrite
aws ssm put-parameter --name /orders/prod/db/password --type SecureString --key-id alias/orders-config \
  --value "$(aws secretsmanager get-random-password --password-length 32 --exclude-punctuation --query RandomPassword --output text)" --overwrite
aws ssm get-parameters-by-path --path /orders --recursive --query 'Parameters[].[Name,Type]' --output text

KEY_ARN=$(aws kms describe-key --key-id alias/orders-config --query KeyMetadata.Arn --output text)
cat > read-dev-config.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "LoadDevTree", "Effect": "Allow", "Action": "ssm:GetParametersByPath",
      "Resource": "arn:aws:ssm:us-east-1:000000000000:parameter/orders/dev" },
    { "Sid": "ReadDevParameters", "Effect": "Allow", "Action": ["ssm:GetParameter", "ssm:GetParameters"],
      "Resource": "arn:aws:ssm:us-east-1:000000000000:parameter/orders/dev/*" },
    { "Sid": "DecryptWithConfigKey", "Effect": "Allow", "Action": "kms:Decrypt", "Resource": "$KEY_ARN" }
  ]
}
EOF
aws iam put-role-policy --role-name orders-api --policy-name read-dev-config --policy-document file://read-dev-config.json

# Act as the service to prove it works.
read -r AK SK ST <<< "$(aws sts assume-role --role-arn arn:aws:iam::000000000000:role/orders-api --role-session-name smoke-test \
  --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text)"
AWS_ACCESS_KEY_ID="$AK" AWS_SECRET_ACCESS_KEY="$SK" AWS_SESSION_TOKEN="$ST" \
  aws ssm get-parameters-by-path --path /orders/dev --recursive --with-decryption --query 'Parameters[].Name' --output text
unset AK SK ST

PW1=$(aws secretsmanager get-random-password --password-length 32 --exclude-punctuation --query RandomPassword --output text)
OLD=$(aws secretsmanager create-secret --name orders/dev/db-credentials --kms-key-id alias/orders-config \
  --secret-string "{\"username\":\"orders_app\",\"password\":\"$PW1\"}" --query VersionId --output text)

PW2=$(aws secretsmanager get-random-password --password-length 32 --exclude-punctuation --query RandomPassword --output text)
NEW=$(aws secretsmanager put-secret-value --secret-id orders/dev/db-credentials --version-stages AWSPENDING \
  --secret-string "{\"username\":\"orders_app\",\"password\":\"$PW2\"}" --query VersionId --output text)
aws secretsmanager update-secret-version-stage --secret-id orders/dev/db-credentials \
  --version-stage AWSCURRENT --move-to-version-id "$NEW" --remove-from-version-id "$OLD"
aws secretsmanager update-secret-version-stage --secret-id orders/dev/db-credentials \
  --version-stage AWSPENDING --remove-from-version-id "$NEW"
aws secretsmanager list-secret-version-ids --secret-id orders/dev/db-credentials
`,
      },
    },
  ],
  quiz: [
    {
      q: "A batch job must encrypt 2 GB log archives with a KMS key before uploading them. A developer's first attempt calls kms:Encrypt on each file and gets a ValidationException. What's the right design?",
      options: [
        "Split each file into 4 KB chunks and call Encrypt on every chunk",
        "Call GenerateDataKey once per archive, encrypt locally with the plaintext data key, store the encrypted data key with the ciphertext, and discard the plaintext key",
        "Request a quota increase for the Encrypt payload size",
        "Use an asymmetric KMS key, which has no size limit",
      ],
      answer: 1,
      explain:
        "`Encrypt` takes at most 4 KB, by design. Envelope encryption sends only a 32-byte data key through KMS and does bulk crypto locally. Chunking would make millions of slow, billable, throttle-prone calls, and asymmetric keys have even smaller limits.",
    },
    {
      q: "After a refactor, decrypting records written last month fails with InvalidCiphertextException. The key is enabled and the role has kms:Decrypt. What's the most likely cause?",
      options: [
        "The key was rotated and old ciphertext can no longer be decrypted",
        "The encryption context passed to Decrypt no longer exactly matches the one used to encrypt",
        "KMS ciphertext expires after 30 days",
        "The alias was renamed",
      ],
      answer: 1,
      explain:
        "The encryption context is bound to the ciphertext as authenticated data, so any difference in keys or values makes Decrypt fail with `InvalidCiphertextException`. Rotation keeps old key material, so it doesn't break decryption. Aliases aren't needed to decrypt.",
    },
    {
      q: "Security asks you to rotate the customer managed key that protects 40 TB of S3 objects encrypted with SSE-KMS. What does enabling automatic rotation do to the existing objects?",
      options: [
        "Nothing to them: new material is used for new encryptions, and KMS keeps old material so existing objects still decrypt",
        "S3 re-encrypts all 40 TB in the background over the next week",
        "Existing objects become unreadable until you run a batch re-encrypt",
        "Rotation is impossible for keys that are in use",
      ],
      answer: 0,
      explain:
        "Rotation adds new key material behind the same key ID and keeps every previous version, so existing ciphertext keeps working and nothing is re-encrypted. If you need data protected by *different* material, you must re-encrypt (or copy) the data yourself.",
    },
    {
      q: "A team needs (a) 300 non-secret config values per environment, and (b) an RDS master password rotated every 30 days and readable from a second AWS account. What fits best?",
      options: [
        "Secrets Manager for everything",
        "Parameter Store for everything, with a cron job to rotate the password",
        "Parameter Store (String/StringList) for the config, Secrets Manager for the password, with a resource policy and a customer managed key shared with the other account",
        "Encrypted environment variables in the task definition",
      ],
      answer: 2,
      explain:
        "Standard-tier parameters are free and hierarchical, ideal for config. Secrets Manager adds managed rotation and resource policies for cross-account access. That access also needs a **customer managed** KMS key whose policy allows the other account, because AWS managed keys can't be shared.",
    },
    {
      q: "An ECS task role allows ssm:GetParameter on parameter/app/prod/*. Reading a SecureString with --with-decryption fails with AccessDeniedException mentioning kms:Decrypt. What's missing?",
      options: [
        "ssm:DecryptParameter on the parameter",
        "kms:Decrypt on the KMS key that encrypts the parameter (allowed by the key policy, typically via the account-root delegation statement)",
        "A VPC endpoint for KMS",
        "The parameter must be moved to the Advanced tier",
      ],
      answer: 1,
      explain:
        "SSM decrypts SecureStrings by calling KMS **as the caller**, so the caller needs `kms:Decrypt` on that key, and the key policy must allow it. Scoping it with `kms:ViaService = ssm.<region>.amazonaws.com` keeps the role from decrypting arbitrary ciphertext directly.",
    },
    {
      q: "A service caches its database password for 1 hour. After each Secrets Manager rotation, it throws authentication errors for up to an hour. What's the best fix?",
      options: [
        "Disable rotation",
        "Call GetSecretValue on every database query",
        "On an authentication failure, bypass the cache, re-read AWSCURRENT and retry once, and consider the alternating-users rotation strategy so AWSPREVIOUS stays valid while caches drain",
        "Cache AWSPENDING instead of AWSCURRENT",
      ],
      answer: 2,
      explain:
        "Caching is right (fetching on every query costs money and hits rate limits), but the cache must be invalidated when the credential stops working. Alternating-users rotation keeps the previous credential valid, which gives caches time to refresh. AWSPENDING isn't valid until rotation tests it.",
    },
    {
      q: "Someone scheduled deletion of a customer managed key that encrypts production backups, with a 7-day waiting period. It's day 3. What can you do, and what happens if you miss the window?",
      options: [
        "Nothing; deletion is immediate once scheduled",
        "Cancel the deletion (the key returns to Disabled, and you then re-enable it); after the window the key material is destroyed and everything encrypted only under it is permanently unrecoverable",
        "Contact AWS Support after deletion to restore the key from backup",
        "Create a new key with the same alias, which can decrypt the old data",
      ],
      answer: 1,
      explain:
        "`cancel-key-deletion` works only during the waiting period and leaves the key **Disabled**, so run `enable-key`. After deletion, nobody, including AWS, can recover the material. Alarm on `ScheduleKeyDeletion` and `DisableKey` in CloudTrail, and always use the full 30-day window.",
    },
  ],
};
