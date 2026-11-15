import type { CheckContext, Module } from "../types.ts";

// ---------------------------------------------------------------- helpers

const roleArn = (ctx: CheckContext, name: string) => `arn:aws:iam::${ctx.account}:role/${name}`;

/** Parse a trust/permission document the CLI may return as an object or an URL-encoded string. */
const doc = (d: any) => (typeof d === "string" ? JSON.parse(decodeURIComponent(d)) : d);
const list = (x: any): any[] => (x === undefined ? [] : Array.isArray(x) ? x : [x]);

/** Simulate a set of actions against one resource; returns { action: decision }. */
async function simulate(ctx: CheckContext, role: string, actions: string[], resource: string): Promise<Record<string, string>> {
  const r = await ctx.tryAws([
    "iam", "simulate-principal-policy",
    "--policy-source-arn", roleArn(ctx, role),
    "--action-names", ...actions,
    "--resource-arns", resource,
  ]);
  if (!r.ok) throw new Error(`simulate-principal-policy failed: ${r.error.split("\n").pop()}`);
  return Object.fromEntries((r.data.EvaluationResults ?? []).map((e: any) => [e.EvalActionName, e.EvalDecision]));
}

/** Bash that assumes a role and prints its three credential fields; used inside checks. */
const assumeCmd = (arn: string, session: string) =>
  `aws sts assume-role --role-arn ${arn} --role-session-name ${session} --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text`;

async function trailEvents(ctx: CheckContext, attr: string, value: string): Promise<any[]> {
  const r = await ctx.tryAws(["cloudtrail", "lookup-events", "--lookup-attributes", `AttributeKey=${attr},AttributeValue=${value}`]);
  if (!r.ok) return [];
  return (r.data?.Events ?? []).map((e: any) => ({ ...e, detail: JSON.parse(e.CloudTrailEvent ?? "{}") }));
}

// ---------------------------------------------------------------- module

export const iam: Module = {
  id: "iam",
  number: "01",
  title: "Identity: IAM & STS",
  summary:
    "Design least-privilege roles, read and debug any policy with the evaluation logic, and work with short-lived credentials from STS the way production teams do.",
  services: ["IAM", "STS", "Access Analyzer", "CloudTrail"],
  lessons: [
    {
      id: "principals",
      kind: "reading",
      title: "Principals and credentials",
      minutes: 12,
      body: String.raw`
Every AWS API call answers two questions before it does anything: **who is calling** (authentication) and **are they allowed to do this, to this resource, right now** (authorization). IAM is the system that answers both, for every service, in every region. It is also the single most common cause of real AWS incidents, in both directions: too much access (a breach) and too little (an outage at 3 a.m. because a deploy role lost \`iam:PassRole\`).

## The kinds of principal

A **principal** is an identity that can make a request. You'll meet five:

| Principal | Credentials | Use it for | Avoid it for |
|---|---|---|---|
| **Root user** | email + password (+ MFA) | ~10 tasks that require it (closing the account, some billing settings) | everything else, ever |
| **IAM user** | password and/or **long-lived access keys** | break-glass, legacy third-party tools that can't do anything else | humans, workloads, CI |
| **IAM role** | none of its own; you **assume** it and get temporary credentials | workloads (EC2, Lambda, ECS), CI, cross-account access, humans via SSO | |
| **Federated identity** | an external IdP's token (SAML, OIDC) exchanged for a role session | humans (IAM Identity Center, Okta, Entra ID), CI (GitHub Actions OIDC) | |
| **Service principal** | AWS itself, e.g. \`lambda.amazonaws.com\` | appears in **trust** and **resource** policies: "let Lambda assume this role", "let SNS send to this queue" | |

An **assumed-role session** is what actually makes calls when you use a role: \`arn:aws:sts::111122223333:assumed-role/deployer/alice\`. The last part is the **session name**, and it shows up in CloudTrail. That's how you tell which pipeline run or person used a shared role.

<figure class="diagram">
<svg viewBox="0 0 640 260" role="img" aria-label="Humans, workloads and CI all obtain temporary credentials from STS by assuming roles; IAM user access keys are the long-lived exception">
  <rect x="10" y="20" width="170" height="54" rx="8" class="d-box"/><text x="95" y="44" text-anchor="middle" class="d-label">Human via SSO</text><text x="95" y="62" text-anchor="middle" class="d-small">IdP: SAML / Identity Center</text>
  <rect x="10" y="90" width="170" height="54" rx="8" class="d-box"/><text x="95" y="114" text-anchor="middle" class="d-label">Workload</text><text x="95" y="132" text-anchor="middle" class="d-small">EC2 / Lambda / ECS task role</text>
  <rect x="10" y="160" width="170" height="54" rx="8" class="d-box"/><text x="95" y="184" text-anchor="middle" class="d-label">CI pipeline</text><text x="95" y="202" text-anchor="middle" class="d-small">OIDC token (module 13)</text>
  <rect x="245" y="70" width="140" height="94" rx="8" class="d-box d-accent"/><text x="315" y="106" text-anchor="middle" class="d-label">STS</text><text x="315" y="126" text-anchor="middle" class="d-small">checks trust policy,</text><text x="315" y="142" text-anchor="middle" class="d-small">issues session</text>
  <rect x="450" y="70" width="180" height="94" rx="8" class="d-box d-ok"/><text x="540" y="100" text-anchor="middle" class="d-label">Temporary credentials</text><text x="540" y="120" text-anchor="middle" class="d-small">key + secret + token</text><text x="540" y="138" text-anchor="middle" class="d-small">expire in 15 min to 12 h</text>
  <path d="M180 47 L243 95" class="d-arrow"/><path d="M180 117 H243" class="d-arrow"/><path d="M180 187 L243 140" class="d-arrow"/><path d="M385 117 H448" class="d-arrow"/>
  <rect x="245" y="200" width="385" height="44" rx="8" class="d-box d-danger"/><text x="437" y="220" text-anchor="middle" class="d-label">IAM user access key: never expires, leaks forever</text><text x="437" y="236" text-anchor="middle" class="d-small">the credential behind most real-world AWS breaches</text>
</svg>
<figcaption>Every modern access path ends in a role session with credentials that expire. Long-lived access keys are the exception you work to eliminate.</figcaption>
</figure>

## Why roles and short-lived credentials win

An access key (\`AKIA…\` plus a secret) is valid until somebody deletes it. It gets pasted into \`.env\` files, CI variables, Slack threads, Docker image layers and public GitHub repos, and automated scanners find keys on GitHub within minutes. Temporary credentials (\`ASIA…\` plus a secret plus a **session token**) fix the problem structurally:

- **They expire** (default 1 hour). A leaked credential is a short incident, not a permanent backdoor.
- **Nothing to rotate or store.** The EC2 instance profile, the Lambda runtime and the ECS agent fetch and refresh them for you. Your code just uses the SDK's default credential chain.
- **Attribution.** The session name and optional *source identity* tell CloudTrail exactly who or what was behind each call.
- **One policy, many callers.** Fifty pipelines can assume the same well-reviewed \`deployer\` role instead of fifty users drifting apart.

> **Senior rule of thumb:** a production account should have *zero* IAM users with access keys, except a documented, alarmed break-glass path. Humans come in through SSO; workloads use their attached role; CI uses OIDC federation.

## How the SDK finds credentials

The CLI and every SDK walk the same **default credential provider chain** and stop at the first hit:

1. Explicit options in code, or \`--profile\` on the CLI
2. Environment variables: \`AWS_ACCESS_KEY_ID\`, \`AWS_SECRET_ACCESS_KEY\`, \`AWS_SESSION_TOKEN\`
3. Web identity token file (\`AWS_WEB_IDENTITY_TOKEN_FILE\` + \`AWS_ROLE_ARN\`): EKS IRSA, some CI systems
4. The shared config/credentials files (\`~/.aws/config\`, \`~/.aws/credentials\`), including SSO and \`role_arn\` profiles
5. Container credentials (ECS task role, EKS Pod Identity), then the EC2 instance metadata service (IMDSv2)

Two production pitfalls come straight from this order. First, **stale environment variables win over everything below them**: a forgotten \`AWS_ACCESS_KEY_ID\` in your shell silently overrides the profile you think you're using. Second, an app that "works on my laptop" may be using *your* admin credentials, then fail in ECS where only the task role exists. Always check:

\`\`\`bash
aws sts get-caller-identity
\`\`\`

\`GetCallerIdentity\` needs no permissions and can't be denied, which makes it the first command in every debugging session and every pipeline.

## Seeing the long-lived key problem

In this emulator your terminal runs as the IAM user \`emulator\`. Create a "legacy bot" user with an access key, then look at what you've made:

\`\`\`bash
aws iam create-user --user-name demo-legacy-bot
aws iam create-access-key --user-name demo-legacy-bot --query 'AccessKey.{id:AccessKeyId,status:Status}'
aws iam list-access-keys --user-name demo-legacy-bot
\`\`\`

There's no expiry field: that key works until someone deletes it. On a real account you'd find these with the IAM **credential report** (\`aws iam generate-credential-report\`) and \`get-access-key-last-used\`, and alarm on any key older than 90 days.

> **On real AWS:** the root user is the email address that opened the account. Lock it with hardware MFA, delete its access keys, and in an AWS Organization use *centralized root access* so member accounts have no root credentials at all.

Clean up:

\`\`\`bash
for k in $(aws iam list-access-keys --user-name demo-legacy-bot --query 'AccessKeyMetadata[].AccessKeyId' --output text); do
  aws iam delete-access-key --user-name demo-legacy-bot --access-key-id "$k"
done
aws iam delete-user --user-name demo-legacy-bot
\`\`\`

## Workload roles in one paragraph

Workloads never hold keys. You attach a role, and the platform hands out credentials: an **instance profile** for EC2 (fetched from IMDSv2 at \`169.254.169.254\`), the **execution role** for Lambda, the **task role** for ECS (keep it separate from the *task execution role*, which only pulls images and secrets), and **IRSA / Pod Identity** for EKS. Each role's **trust policy** names the service principal allowed to assume it, for example \`lambda.amazonaws.com\`. Give each workload *its own* role. Shared roles become the union of everyone's needs, and the union is never least privilege.
`,
    },
    {
      id: "policies",
      kind: "reading",
      title: "Policy anatomy and policy types",
      minutes: 14,
      body: String.raw`
A policy is a JSON document of **statements**. Each statement says: this **Effect** applies to these **Actions** on these **Resources**, when these **Conditions** hold (and, in resource-based policies, for this **Principal**).

\`\`\`json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadReleaseArtifacts",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:GetObjectVersion"],
      "Resource": "arn:aws:s3:::acme-releases/prod/*",
      "Condition": {
        "StringEquals": { "aws:PrincipalTag/team": "payments" },
        "Bool": { "aws:SecureTransport": "true" }
      }
    }
  ]
}
\`\`\`

| Element | What it does | Pitfalls |
|---|---|---|
| \`Version\` | Always \`"2012-10-17"\`. | Omitting it selects the 2008 grammar, where \`\${aws:username}\`-style policy variables don't work. |
| \`Sid\` | Optional label. | Use it: it makes simulator output and reviews readable. |
| \`Effect\` | \`Allow\` or \`Deny\`. | |
| \`Action\` / \`NotAction\` | \`service:Operation\`, wildcards allowed (\`s3:Get*\`). | \`"Effect":"Allow","NotAction":"iam:*"\` grants *every other action in AWS*, including ones released next year. |
| \`Resource\` / \`NotResource\` | ARNs, wildcards allowed. | Object and bucket ARNs differ: \`s3:ListBucket\` needs \`arn:aws:s3:::b\`, \`s3:GetObject\` needs \`arn:aws:s3:::b/*\`. \`arn:aws:s3:::prod*\` also matches \`prod-backup\`. |
| \`Condition\` | Operator → key → values. All operators must match (AND); values inside one key are OR. | A condition on a key that's **absent** from the request fails, unless you use an \`...IfExists\` operator. |
| \`Principal\` / \`NotPrincipal\` | Who the policy applies to. **Only** in resource-based and trust policies. | \`"Principal":"*"\` with no condition is public access. |

### Actions don't always match API names

Most actions map 1:1 to an API (\`sqs:SendMessage\`), but not all. \`s3:ListBucket\` authorizes the \`ListObjectsV2\` call, \`iam:PassRole\` isn't an API at all (it's checked when you hand a role to a service, e.g. \`lambda:CreateFunction\` with \`--role\`), and some operations need several actions. The **Service Authorization Reference** lists, per service, every action, the resource types it accepts, and the condition keys it supports. Keep it open whenever you write a policy.

### Condition keys you'll actually use

| Key | Example use |
|---|---|
| \`aws:PrincipalTag/<k>\`, \`aws:ResourceTag/<k>\` | ABAC: "you may touch resources whose \`team\` tag equals your \`team\` tag". |
| \`aws:SourceArn\`, \`aws:SourceAccount\` | In resource policies that trust a **service** principal: only *this* bucket's notifications may invoke the function (stops the confused deputy). |
| \`aws:PrincipalOrgID\` | "Anyone in my AWS Organization" without listing account IDs. |
| \`aws:MultiFactorAuthPresent\`, \`aws:MultiFactorAuthAge\` | Require recent MFA for destructive actions or for assuming an admin role. |
| \`aws:RequestedRegion\` | Keep workloads in approved regions. |
| \`aws:SecureTransport\` | Deny non-TLS access (classic bucket policy statement). |
| \`sts:ExternalId\` | Third-party role assumption (see the STS lesson). |
| Service keys (\`s3:x-amz-server-side-encryption\`, \`kms:ViaService\`, \`ec2:InstanceType\`) | Constrain *how* an action is used. |

## The policy types

This is where people get lost, so learn it as a table. Each type answers a different question:

| Type | Attached to | Question it answers | Grants access? |
|---|---|---|---|
| **Identity-based** (managed or inline) | user, group, role | What may *this principal* do? | Yes |
| **Resource-based** | bucket, queue, topic, key, secret, Lambda function… | Who may do what *to this resource*? Has a \`Principal\`. | Yes, including **cross-account** |
| **Trust policy** | a role (it's the role's resource policy) | Who may *assume* this role? | Only \`sts:AssumeRole*\` / \`sts:TagSession\` |
| **Permissions boundary** | user or role | What is the *maximum* this principal may ever do? | **No**: only limits |
| **Session policy** | passed to \`AssumeRole --policy\` | What may *this one session* do? | **No**: only limits |
| **SCP** (Organizations) | OU or account | What may *any principal in these accounts* do (except the management account)? | **No**: only limits |
| **RCP** (Organizations) | OU or account | What may be done *to resources in these accounts*, by anyone? | **No**: only limits |

The grants-versus-limits column is the key idea. **Effective permissions are the intersection** of everything that limits you, applied to the union of what grants you access. A boundary that allows \`s3:*\` gives a role nothing; it means that even if someone later attaches \`AdministratorAccess\`, the role still can't do anything outside S3.

### Managed vs inline

- **AWS managed** policies (\`arn:aws:iam::aws:policy/ReadOnlyAccess\`) are maintained by AWS and change under you. Fine as a starting point, and for service roles like \`AWSLambdaBasicExecutionRole\`. Too broad for most production roles.
- **Customer managed** policies are versioned (up to 5 versions, with a default), reusable, and the right choice for shared permission sets.
- **Inline** policies live and die with one principal. Good for strictly one-to-one permissions (this lab's deploy role). Easy to lose track of, so IaC is the only sane way to manage them.

### Where the permissions boundary earns its keep

Platform teams want developers to create roles for their own Lambdas without becoming able to create an admin role and escalate. The pattern: let developers call \`iam:CreateRole\` **only if** they attach the platform's boundary (\`"Condition":{"StringEquals":{"iam:PermissionsBoundary":"arn:aws:iam::…:policy/PlatformBoundary"}}\`), and deny them the right to change or remove that boundary. Whatever they put in the role, the boundary caps it.

## Try it: lint a policy before it ships

IAM Access Analyzer's **policy validation** catches syntax errors and dangerous patterns. Write a deliberately sloppy policy:

\`\`\`bash
cat > demo-sloppy.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:GetObject", "iam:PassRole"], "Resource": "*" }
  ]
}
EOF
aws accessanalyzer validate-policy --policy-type IDENTITY_POLICY \
  --policy-document file://demo-sloppy.json \
  --query 'findings[].{type:findingType,code:issueCode}'
\`\`\`

You get a \`SECURITY_WARNING\` (\`PASS_ROLE_WITH_STAR_IN_RESOURCE\`). \`iam:PassRole\` on \`*\` lets the holder give *any* role, including an admin role, to a Lambda function or EC2 instance it controls, and then act as that role: a classic privilege escalation. Run this command in CI on every policy change. It returns a non-empty \`findings\` list you can fail the build on.

> **On real AWS:** validate-policy also reports \`ERROR\` findings for actions that don't exist (a typo like \`s3:GetObjekt\`) and \`SUGGESTION\`s for redundant statements. The emulator implements the security checks but not the full action catalogue, so a typo may pass here.
`,
    },
    {
      id: "evaluation",
      kind: "reading",
      title: "How AWS decides: policy evaluation logic",
      minutes: 14,
      body: String.raw`
When a request arrives, AWS collects **every** policy that applies (the caller's identity policies, the resource's policy, boundaries, session policies, SCPs and RCPs) and evaluates them together. Order of statements, order of policies and which policy "came first" don't matter. Three rules cover 95% of cases:

1. **Everything starts denied** (implicit deny).
2. **An explicit \`Deny\` anywhere wins**, always. No \`Allow\` can override it.
3. Otherwise, the request needs an **\`Allow\`** from a policy that *grants* access, and must not be blocked by any policy that *limits* access (SCP, RCP, boundary, session policy).

<figure class="diagram">
<svg viewBox="0 0 640 470" role="img" aria-label="Policy evaluation flowchart: explicit deny, then organization policies, resource policy, permissions boundary, session policy, identity policy">
  <rect x="200" y="8" width="240" height="34" rx="8" class="d-box d-outer"/><text x="320" y="30" text-anchor="middle" class="d-label">Request: principal, action, resource, context</text>
  <rect x="170" y="64" width="300" height="40" rx="8" class="d-box"/><text x="320" y="89" text-anchor="middle" class="d-label">Explicit Deny in ANY applicable policy?</text>
  <rect x="170" y="126" width="300" height="40" rx="8" class="d-box"/><text x="320" y="151" text-anchor="middle" class="d-label">SCPs and RCPs allow it?</text>
  <rect x="170" y="188" width="300" height="40" rx="8" class="d-box"/><text x="320" y="213" text-anchor="middle" class="d-label">Same-account resource policy allows?</text>
  <rect x="170" y="250" width="300" height="40" rx="8" class="d-box"/><text x="320" y="275" text-anchor="middle" class="d-label">Permissions boundary allows?</text>
  <rect x="170" y="312" width="300" height="40" rx="8" class="d-box"/><text x="320" y="337" text-anchor="middle" class="d-label">Session policy allows? (if any)</text>
  <rect x="170" y="374" width="300" height="40" rx="8" class="d-box"/><text x="320" y="399" text-anchor="middle" class="d-label">Identity-based policy allows?</text>
  <rect x="520" y="64" width="110" height="40" rx="8" class="d-box d-danger"/><text x="575" y="83" text-anchor="middle" class="d-label">DENY</text><text x="575" y="97" text-anchor="middle" class="d-small">explicit</text>
  <rect x="520" y="164" width="110" height="168" rx="8" class="d-box d-danger"/><text x="575" y="244" text-anchor="middle" class="d-label">DENY</text><text x="575" y="260" text-anchor="middle" class="d-small">implicit</text>
  <rect x="10" y="188" width="110" height="40" rx="8" class="d-box d-ok"/><text x="65" y="213" text-anchor="middle" class="d-label">ALLOW</text>
  <rect x="10" y="374" width="110" height="40" rx="8" class="d-box d-ok"/><text x="65" y="399" text-anchor="middle" class="d-label">ALLOW</text>
  <rect x="520" y="374" width="110" height="40" rx="8" class="d-box d-danger"/><text x="575" y="393" text-anchor="middle" class="d-label">DENY</text><text x="575" y="407" text-anchor="middle" class="d-small">implicit</text>
  <path d="M320 42 V62" class="d-arrow"/>
  <path d="M470 84 H518" class="d-arrow"/><text x="494" y="78" text-anchor="middle" class="d-small">yes</text>
  <path d="M320 104 V124" class="d-arrow"/><text x="332" y="118" class="d-small">no</text>
  <path d="M470 146 H495 V180 H518" class="d-arrow"/><text x="494" y="140" text-anchor="middle" class="d-small">no</text>
  <path d="M320 166 V186" class="d-arrow"/><text x="332" y="180" class="d-small">yes</text>
  <path d="M170 208 H122" class="d-arrow"/><text x="146" y="202" text-anchor="middle" class="d-small">yes</text>
  <path d="M320 228 V248" class="d-arrow"/><text x="332" y="242" class="d-small">no / none</text>
  <path d="M470 270 H518" class="d-arrow"/><text x="494" y="264" text-anchor="middle" class="d-small">no</text>
  <path d="M320 290 V310" class="d-arrow"/><text x="332" y="304" class="d-small">yes / none</text>
  <path d="M470 324 H518" class="d-arrow"/><text x="494" y="318" text-anchor="middle" class="d-small">no</text>
  <path d="M320 352 V372" class="d-arrow"/><text x="332" y="366" class="d-small">yes / none</text>
  <path d="M170 394 H122" class="d-arrow"/><text x="146" y="388" text-anchor="middle" class="d-small">yes</text>
  <path d="M470 394 H518" class="d-arrow"/><text x="494" y="388" text-anchor="middle" class="d-small">no</text>
  <text x="320" y="446" text-anchor="middle" class="d-small">Cross-account: the caller's account must allow it (identity policy) AND the resource's account must allow it (resource or trust policy).</text>
  <text x="320" y="462" text-anchor="middle" class="d-small">A same-account resource-policy Allow can stand on its own; boundaries and session policies still cap role sessions in most cases.</text>
</svg>
<figcaption>Simplified single-account evaluation. Deny checks come first, limits are intersected, and the request needs at least one Allow from a policy that grants access.</figcaption>
</figure>

## Reading the chart like an engineer

- **"Allowed by identity policy" isn't enough.** If an SCP doesn't allow \`ec2:RunInstances\` in \`ap-south-1\`, no amount of \`AdministratorAccess\` helps. When an admin gets AccessDenied, suspect SCPs, boundaries and explicit denies in resource policies first.
- **Cross-account needs both sides.** For a role in account B to read a bucket in account A, B's identity policy must allow \`s3:GetObject\` on A's bucket **and** A's bucket policy must allow B's role. Missing either half gives the same AccessDenied. (AssumeRole works the same way: the caller's identity policy must allow \`sts:AssumeRole\` on the role, and the role's trust policy must name the caller.)
- **Explicit deny is your guardrail tool.** Write denies for things that must never happen (\`s3:DeleteBucket\` on the audit-log bucket, non-TLS access, leaving approved regions), and put them where the people being restricted can't edit them: SCPs, boundaries, resource policies.
- **Error messages tell you which branch you hit.** Modern AWS (and this emulator) say *"…because no identity-based policy allows…"*, *"…with an explicit deny in a resource-based policy"* or *"…because no session policy allows…"*. Read the end of the message before you change anything.

## Conditions in evaluation

A statement only "counts" if all its conditions match. That has two consequences people trip over:

- **Missing keys fail closed** for \`Allow\`: \`StringEquals aws:PrincipalTag/team = web\` doesn't match a principal with no \`team\` tag. For \`Deny\`, the same missing key means the deny *doesn't apply*, which can quietly open a hole. Use \`Null\` checks or \`...IfExists\` deliberately.
- **Multi-valued keys** (\`aws:TagKeys\`, \`aws:CalledVia\`) need \`ForAnyValue:\` / \`ForAllValues:\`. \`ForAllValues\` is *true for an empty set*, so a deny guarded by it may never fire.

## Watch the engine decide

The IAM policy simulator runs this exact logic against a principal's real attached policies. Build a role with one allow, one explicit deny and one conditional allow:

\`\`\`bash
cat > demo-trust.json <<'EOF'
{ "Version": "2012-10-17",
  "Statement": [{ "Effect": "Allow", "Principal": { "AWS": "arn:aws:iam::000000000000:root" }, "Action": "sts:AssumeRole" }] }
EOF
cat > demo-perms.json <<'EOF'
{ "Version": "2012-10-17",
  "Statement": [
    { "Sid": "ReadWriteObjects", "Effect": "Allow", "Action": "s3:*", "Resource": "arn:aws:s3:::demo-eval/*" },
    { "Sid": "NeverDelete", "Effect": "Deny", "Action": "s3:DeleteObject", "Resource": "*" },
    { "Sid": "UsEastOnly", "Effect": "Allow", "Action": "sqs:SendMessage", "Resource": "*",
      "Condition": { "StringEquals": { "aws:RequestedRegion": "us-east-1" } } }
  ] }
EOF
aws iam create-role --role-name demo-eval --assume-role-policy-document file://demo-trust.json --query Role.Arn
aws iam put-role-policy --role-name demo-eval --policy-name perms --policy-document file://demo-perms.json
\`\`\`

Now ask the engine three questions:

\`\`\`bash
aws iam simulate-principal-policy --policy-source-arn arn:aws:iam::000000000000:role/demo-eval \
  --action-names s3:GetObject s3:DeleteObject \
  --resource-arns arn:aws:s3:::demo-eval/report.csv \
  --query 'EvaluationResults[].[EvalActionName,EvalDecision]' --output table
aws iam simulate-principal-policy --policy-source-arn arn:aws:iam::000000000000:role/demo-eval \
  --action-names s3:PutBucketPolicy --resource-arns arn:aws:s3:::demo-eval \
  --query 'EvaluationResults[].[EvalActionName,EvalDecision]' --output table
\`\`\`

\`GetObject\` is \`allowed\`. \`DeleteObject\` is \`explicitDeny\` even though \`s3:*\` allows it. \`PutBucketPolicy\` on the **bucket** ARN is \`implicitDeny\`, because the allow only covers *objects* (\`demo-eval/*\`). The simulator matches the resource string you give it, so always pass the resource type the action really acts on. Ask about \`PutBucketPolicy\` on an object ARN and you'll get a meaningless \`allowed\`.

Now the condition:

\`\`\`bash
for region in us-east-1 eu-west-1; do
  aws iam simulate-principal-policy --policy-source-arn arn:aws:iam::000000000000:role/demo-eval \
    --action-names sqs:SendMessage --resource-arns "arn:aws:sqs:$region:000000000000:orders" \
    --context-entries "ContextKeyName=aws:RequestedRegion,ContextKeyValues=$region,ContextKeyType=string" \
    --query 'EvaluationResults[0].[EvalActionName,EvalDecision]' --output text
done
\`\`\`

The simulator fills in only the context you supply. Leave out \`--context-entries\` and the conditional allow fails closed (\`implicitDeny\`), which is exactly how the missing-key rule behaves in production.

> **On real AWS:** the simulator doesn't evaluate SCPs from your organization unless you run it from the management account, and it can't model every service-specific nuance. Treat it as a fast first answer, then confirm with a real call in a sandbox account.
`,
    },
    {
      id: "least-privilege",
      kind: "reading",
      title: "Least privilege in practice",
      minutes: 12,
      body: String.raw`
"Least privilege" is easy to say and hard to do, because nobody knows the exact permissions an application needs up front. Teams that do it well don't guess better. They run a **loop**: start narrow, observe, tighten, and automate the checks so permissions can't quietly widen again.

## The loop

1. **Start from the job, not the service.** "Deploys the static site and updates one Lambda's code" becomes six actions on two resources, not \`s3:*\` and \`lambda:*\`.
2. **Scope every Allow to resource ARNs.** \`"Resource": "*"\` is only acceptable for actions that don't support resource-level permissions (many \`List*\`/\`Describe*\` calls). The Service Authorization Reference tells you which those are.
3. **Lint** with Access Analyzer \`validate-policy\` in CI (you saw it in the previous lesson).
4. **Prove** what the policy does with \`simulate-principal-policy\`, including what it **must not** do. Put those assertions in a test, just as you would for code.
5. **Observe** in staging: CloudTrail shows every AccessDenied, with the action and resource that were missing.
6. **Trim**: IAM *last accessed* data (\`generate-service-last-accessed-details\`) and Access Analyzer **unused access** findings show permissions nobody has used in 90 days. Access Analyzer can also *generate* a policy from a role's actual CloudTrail activity.
7. **Guard**: Access Analyzer **external access** findings flag any bucket, key, role or secret shared outside your account or organization. Wire them to EventBridge and alert.

## Policies as tests

Here's the testing mindset applied to a policy. Assert both sides: the deploy role *can* upload to its bucket and *cannot* touch anything else.

\`\`\`bash
cat > demo-trust.json <<'EOF'
{ "Version": "2012-10-17",
  "Statement": [{ "Effect": "Allow", "Principal": { "AWS": "arn:aws:iam::000000000000:root" }, "Action": "sts:AssumeRole" }] }
EOF
aws iam create-role --role-name demo-lp --assume-role-policy-document file://demo-trust.json --query Role.Arn
aws iam put-role-policy --role-name demo-lp --policy-name upload --policy-document '{
  "Version": "2012-10-17",
  "Statement": [{ "Effect": "Allow", "Action": "s3:PutObject", "Resource": "arn:aws:s3:::demo-site/*" }] }'

expect() {  # expect <decision> <action> <resource>
  got=$(aws iam simulate-principal-policy --policy-source-arn arn:aws:iam::000000000000:role/demo-lp \
    --action-names "$2" --resource-arns "$3" --query 'EvaluationResults[0].EvalDecision' --output text)
  if [ "$got" = "$1" ]; then echo "ok    $2 $3 -> $got"; else echo "FAIL  $2 $3 -> $got (wanted $1)"; fi
}
expect allowed      s3:PutObject     arn:aws:s3:::demo-site/index.html
expect implicitDeny s3:PutObject     arn:aws:s3:::demo-site-backup/index.html
expect implicitDeny s3:DeleteBucket  arn:aws:s3:::demo-site
expect implicitDeny iam:PassRole     arn:aws:iam::000000000000:role/admin
\`\`\`

Notice the second assertion. \`arn:aws:s3:::demo-site*/*\` would have passed the first test and failed this one, and wildcard creep like that is the most common way policies widen over time.

## Conditions that close real holes

**The confused deputy.** When you let a *service* act on your resource (SNS sending to your queue, S3 invoking your Lambda), the service principal \`sns.amazonaws.com\` is shared by every AWS customer. Without a condition, another account could point *their* topic at *your* queue. Always pin the source:

\`\`\`json
{
  "Effect": "Allow",
  "Principal": { "Service": "sns.amazonaws.com" },
  "Action": "sqs:SendMessage",
  "Resource": "arn:aws:sqs:us-east-1:111122223333:orders",
  "Condition": { "ArnEquals": { "aws:SourceArn": "arn:aws:sns:us-east-1:111122223333:order-events" } }
}
\`\`\`

**ABAC with tags.** Instead of one policy per team, write one policy that compares the caller's tag to the resource's tag. This scales to hundreds of teams without new policies, but only if tag changes are themselves locked down (deny \`iam:TagRole\` and \`*:TagResource\` on the \`team\` key except for the platform role).

\`\`\`bash
aws iam create-role --role-name demo-abac --assume-role-policy-document file://demo-trust.json \
  --tags Key=team,Value=web --query Role.Arn
aws iam put-role-policy --role-name demo-abac --policy-name abac --policy-document '{
  "Version": "2012-10-17",
  "Statement": [{ "Effect": "Allow", "Action": "s3:PutObject", "Resource": "*",
    "Condition": { "StringEquals": { "aws:PrincipalTag/team": "web" } } }] }'
for team in web payments; do
  aws iam simulate-principal-policy --policy-source-arn arn:aws:iam::000000000000:role/demo-abac \
    --action-names s3:PutObject --resource-arns arn:aws:s3:::any/key \
    --context-entries "ContextKeyName=aws:PrincipalTag/team,ContextKeyValues=$team,ContextKeyType=string" \
    --query 'EvaluationResults[0].EvalDecision' --output text
done
\`\`\`

**MFA for dangerous roles.** Put \`"Bool": {"aws:MultiFactorAuthPresent": "true"}\` in the trust policy of a break-glass admin role, so a stolen laptop session without MFA can't assume it. (Federated SSO sessions carry MFA context from the IdP. Configure the requirement there too.)

## What a senior engineer does differently

- **Owns IAM in code.** Every role, policy and trust lives in Terraform or CloudFormation, reviewed in pull requests, with \`validate-policy\` and simulator assertions in CI. Console edits are drift.
- **Separates duties.** Deploy roles can update code but not their own permissions (no \`iam:Put*Policy\` on themselves). Only a pipeline-owned "IAM role" can change IAM, and it has a boundary.
- **Treats \`iam:PassRole\` as admin-adjacent.** Scope it to exact role ARNs and add \`iam:PassedToService\` so the role can only go to the intended service.
- **Plans for the outage side.** Over-tight policies cause incidents too. Roll new restrictions out in audit mode first: watch CloudTrail for denials in staging before enforcing in prod.

> **On real AWS:** Access Analyzer's unused-access and external-access analyzers are paid per analyzed resource or role per month; policy validation and policy generation are free. In this emulator you can create an analyzer (\`aws accessanalyzer create-analyzer --analyzer-name acct --type ACCOUNT\`), but there's no real account history for it to analyze.
`,
    },
    {
      id: "deploy-role",
      kind: "lab",
      title: "Lab: a least-privilege deploy role",
      minutes: 30,
      body: String.raw`
Your team's CI system runs as the role \`ci-runner\`. Today it deploys with a policy a contractor wrote years ago (look at \`deploy-policy.json\` in the lab folder), and anyone in the account may assume the deploy role. You'll replace both with something you'd defend in a security review.

The deploy job does exactly this:

- syncs the static site to the bucket \`web-assets-prod\` (\`aws s3 sync --delete\`: list, get, put and delete **objects**), and
- updates the code of one Lambda function, \`web-api\` in \`us-east-1\` (\`UpdateFunctionCode\`, plus \`GetFunction\` to wait for the update).

Nothing else. In particular it must not change bucket policies, delete buckets, change function configuration or pass roles.

The platform team has already created a managed policy \`PlatformBoundary\` that every pipeline role must carry as its permissions boundary.

## Workflow

1. Lint the inherited policy first, to see why it fails review:

\`\`\`bash
aws accessanalyzer validate-policy --policy-type IDENTITY_POLICY --policy-document file://deploy-policy.json \
  --query 'findings[].[findingType,issueCode]' --output text
\`\`\`

2. Fix \`trust-policy.json\` and \`deploy-policy.json\` in the lab folder, then create the role and attach the policy.
3. Prove the result with the simulator, and save the evidence.

> **On real AWS:** IAM is eventually consistent. A freshly created role or policy can take a few seconds to be usable everywhere, so pipelines that create a role and immediately assume it should retry \`AccessDenied\` for a short while. The emulator is immediately consistent.

Press **Prepare lab**, then work through the tasks.
`,
      lab: {
        files: {
          "trust-policy.json": String.raw`
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::000000000000:root" },
      "Action": "sts:AssumeRole"
    }
  ]
}
`,
          "deploy-policy.json": String.raw`
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "TODO-make-this-least-privilege",
      "Effect": "Allow",
      "Action": ["s3:*", "lambda:*", "iam:PassRole"],
      "Resource": "*"
    }
  ]
}
`,
        },
        setup: String.raw`
aws iam get-role --role-name ci-runner >/dev/null 2>&1 || \
  aws iam create-role --role-name ci-runner --description "Identity of the CI system" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"AWS":"arn:aws:iam::000000000000:root"},"Action":"sts:AssumeRole"}]}' >/dev/null
aws iam get-policy --policy-arn arn:aws:iam::000000000000:policy/PlatformBoundary >/dev/null 2>&1 || \
  aws iam create-policy --policy-name PlatformBoundary --description "Maximum permissions for pipeline roles" \
    --policy-document '{"Version":"2012-10-17","Statement":[{"Sid":"PipelineServices","Effect":"Allow","Action":["s3:*","lambda:*","logs:*","cloudwatch:*","cloudfront:*"],"Resource":"*"}]}' >/dev/null
echo "ci-runner role and PlatformBoundary policy are ready."
`,
        tasks: [
          {
            id: "trust",
            title: "Create the role with a tight trust policy",
            description:
              "Create the role `web-deployer`. Its trust policy must allow **only** the role `arn:aws:iam::000000000000:role/ci-runner` to `sts:AssumeRole`: not the account root, not `*`, no service principals. The check proves it by assuming `ci-runner` and then `web-deployer`, and by confirming your own user (`user/emulator`) is denied.",
            hints: [
              "Edit `trust-policy.json` so `Principal.AWS` is the `ci-runner` role ARN, then `aws iam create-role --role-name web-deployer --assume-role-policy-document file://trust-policy.json`.",
              "If the role already exists, change its trust policy with `aws iam update-assume-role-policy --role-name web-deployer --policy-document file://trust-policy.json`.",
            ],
            check: async (ctx) => {
              const r = await ctx.tryAws(["iam", "get-role", "--role-name", "web-deployer"]);
              if (!r.ok) return "Role `web-deployer` doesn't exist yet.";
              const trust = doc(r.data.Role.AssumeRolePolicyDocument);
              const want = roleArn(ctx, "ci-runner");
              for (const s of list(trust.Statement)) {
                if (s.Effect !== "Allow") continue;
                if (s.Principal === "*" || s.NotPrincipal) return "A trust statement uses `*` or `NotPrincipal`. Name the `ci-runner` role explicitly.";
                const p = s.Principal ?? {};
                if (p.Service || p.Federated) return "The trust policy also trusts a service or federated principal. Only `ci-runner` should be trusted.";
                const aws = list(p.AWS);
                const bad = aws.filter((a: string) => a !== want);
                if (bad.length) return `The trust policy also trusts ${bad.join(", ")}. Only \`${want}\` should be trusted.`;
              }
              const self = await ctx.sh(`${assumeCmd(roleArn(ctx, "web-deployer"), "check-self")} 2>&1`);
              if (self.code === 0) return "Your own user (`user/emulator`) can still assume `web-deployer`. Trust only `ci-runner`.";
              const chain = await ctx.sh(`set -e
read -r AK SK ST <<< "$(${assumeCmd(roleArn(ctx, "ci-runner"), "check-ci")})"
AWS_ACCESS_KEY_ID="$AK" AWS_SECRET_ACCESS_KEY="$SK" AWS_SESSION_TOKEN="$ST" \
  aws sts assume-role --role-arn ${roleArn(ctx, "web-deployer")} --role-session-name check-deploy --query AssumedRoleUser.Arn --output text`);
              if (chain.code !== 0) return `\`ci-runner\` can't assume \`web-deployer\`: ${chain.stderr.trim().split("\n").pop()}`;
              return true;
            },
          },
          {
            id: "policy",
            title: "Attach a least-privilege inline policy",
            description:
              "Attach an **inline** policy named `deploy` to `web-deployer` that allows exactly: `s3:PutObject`, `s3:GetObject` and `s3:DeleteObject` on objects in `web-assets-prod`; `s3:ListBucket` on the bucket `web-assets-prod`; `lambda:UpdateFunctionCode` and `lambda:GetFunction` on `arn:aws:lambda:us-east-1:000000000000:function:web-api`. The check runs the policy simulator against allowed **and** forbidden requests (other buckets, bucket-level changes, other functions, function configuration, `iam:PassRole`).",
            hints: [
              "You need three statements, because object actions, the bucket action and the Lambda actions take different resource ARNs: `arn:aws:s3:::web-assets-prod/*`, `arn:aws:s3:::web-assets-prod` and the function ARN.",
              "Watch out for `arn:aws:s3:::web-assets-prod*`: it also matches `web-assets-prod-backup`.",
              "`aws iam put-role-policy --role-name web-deployer --policy-name deploy --policy-document file://deploy-policy.json`",
            ],
            check: async (ctx) => {
              const r = await ctx.tryAws(["iam", "get-role-policy", "--role-name", "web-deployer", "--policy-name", "deploy"]);
              if (!r.ok) return "`web-deployer` has no inline policy named `deploy` yet.";
              const fn = "arn:aws:lambda:us-east-1:000000000000:function:web-api";
              const want: [string, string[], string][] = [
                ["allowed", ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"], "arn:aws:s3:::web-assets-prod/index.html"],
                ["allowed", ["s3:ListBucket"], "arn:aws:s3:::web-assets-prod"],
                ["allowed", ["lambda:UpdateFunctionCode", "lambda:GetFunction"], fn],
                ["denied", ["s3:PutObjectAcl"], "arn:aws:s3:::web-assets-prod/index.html"],
                ["denied", ["s3:PutObject"], "arn:aws:s3:::web-assets-prod-backup/index.html"],
                ["denied", ["s3:PutObject"], "arn:aws:s3:::other-bucket/index.html"],
                ["denied", ["s3:PutBucketPolicy", "s3:DeleteBucket"], "arn:aws:s3:::web-assets-prod"],
                ["denied", ["lambda:UpdateFunctionCode"], "arn:aws:lambda:us-east-1:000000000000:function:billing-api"],
                ["denied", ["lambda:UpdateFunctionConfiguration", "lambda:DeleteFunction"], fn],
                ["denied", ["iam:PassRole"], "arn:aws:iam::000000000000:role/admin"],
              ];
              for (const [expect, actions, resource] of want) {
                const d = await simulate(ctx, "web-deployer", actions, resource);
                for (const a of actions) {
                  const got = d[a];
                  if (expect === "allowed" && got !== "allowed") return `\`${a}\` on \`${resource}\` is ${got}; the deploy job needs it allowed.`;
                  if (expect === "denied" && got === "allowed") return `\`${a}\` on \`${resource}\` is allowed. The deploy job doesn't need it: remove it.`;
                }
              }
              const att = await ctx.aws(["iam", "list-attached-role-policies", "--role-name", "web-deployer"]);
              if ((att.AttachedPolicies ?? []).length)
                return `\`web-deployer\` also has managed policies attached (${att.AttachedPolicies.map((p: any) => p.PolicyName).join(", ")}). Use only the inline \`deploy\` policy.`;
              return true;
            },
          },
          {
            id: "boundary",
            title: "Apply the platform permissions boundary",
            description:
              "Set the customer managed policy `PlatformBoundary` as the **permissions boundary** of `web-deployer`. It caps the role at S3, Lambda, Logs, CloudWatch and CloudFront, whatever is attached to it later.",
            hints: [
              "The boundary's ARN is `arn:aws:iam::000000000000:policy/PlatformBoundary`.",
              "`aws iam put-role-permissions-boundary --role-name web-deployer --permissions-boundary <arn>`",
            ],
            check: async (ctx) => {
              const r = await ctx.tryAws(["iam", "get-role", "--role-name", "web-deployer"]);
              if (!r.ok) return "Role `web-deployer` doesn't exist yet.";
              const b = r.data.Role.PermissionsBoundary?.PermissionsBoundaryArn;
              const want = `arn:aws:iam::${ctx.account}:policy/PlatformBoundary`;
              if (!b) return "`web-deployer` has no permissions boundary yet.";
              if (b !== want) return `The boundary is \`${b}\`; expected \`${want}\`.`;
              return true;
            },
          },
          {
            id: "lint",
            title: "Pass the policy linter",
            description:
              "The `deploy` policy attached to the role must pass IAM Access Analyzer `validate-policy` (policy type `IDENTITY_POLICY`) with **no** `ERROR` or `SECURITY_WARNING` findings. The check validates the policy that's actually attached, not the local file.",
            hints: [
              "Run `aws accessanalyzer validate-policy --policy-type IDENTITY_POLICY --policy-document file://deploy-policy.json` on your file.",
              "If you changed the file after attaching it, attach it again with `put-role-policy`.",
            ],
            check: async (ctx) => {
              const r = await ctx.tryAws(["iam", "get-role-policy", "--role-name", "web-deployer", "--policy-name", "deploy"]);
              if (!r.ok) return "`web-deployer` has no inline policy named `deploy` yet.";
              const v = await ctx.tryAws([
                "accessanalyzer", "validate-policy", "--policy-type", "IDENTITY_POLICY",
                "--policy-document", JSON.stringify(doc(r.data.PolicyDocument)),
              ]);
              if (!v.ok) return `validate-policy failed: ${v.error.split("\n").pop()}`;
              const bad = (v.data.findings ?? []).filter((f: any) => f.findingType === "ERROR" || f.findingType === "SECURITY_WARNING");
              if (bad.length) return `Access Analyzer reports: ${bad.map((f: any) => `${f.findingType} ${f.issueCode}`).join(", ")}.`;
              return true;
            },
          },
          {
            id: "evidence",
            title: "Save the simulator evidence",
            description:
              "Run `simulate-principal-policy` for `web-deployer` with the actions `s3:PutObject` and `s3:DeleteBucket` against the resource `arn:aws:s3:::web-assets-prod/index.html`, and save the **full JSON output** to `simulation.json` in the lab folder. That file is the evidence you'd attach to the security review.",
            hints: [
              "`aws iam simulate-principal-policy --policy-source-arn arn:aws:iam::000000000000:role/web-deployer --action-names s3:PutObject s3:DeleteBucket --resource-arns arn:aws:s3:::web-assets-prod/index.html > simulation.json`",
            ],
            check: async (ctx) => {
              const f = await ctx.readFile("simulation.json");
              if (f === null) return "`simulation.json` not found in the lab folder.";
              let j: any;
              try {
                j = JSON.parse(f);
              } catch {
                return "`simulation.json` isn't valid JSON. Save the command's default JSON output (no `--output text` or `--query`).";
              }
              const res: any[] = j.EvaluationResults ?? [];
              const by = Object.fromEntries(res.map((e) => [e.EvalActionName, e.EvalDecision]));
              if (by["s3:PutObject"] !== "allowed") return `In simulation.json, s3:PutObject is ${by["s3:PutObject"] ?? "missing"}; expected allowed.`;
              if (!by["s3:DeleteBucket"]) return "simulation.json has no result for s3:DeleteBucket.";
              if (by["s3:DeleteBucket"] === "allowed") return "simulation.json shows s3:DeleteBucket allowed. Tighten the policy and run the simulation again.";
              return true;
            },
          },
        ],
        solution: String.raw`
cat > trust-policy.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "OnlyTheCiRunner",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::000000000000:role/ci-runner" },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF
cat > deploy-policy.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SyncSiteObjects",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::web-assets-prod/*"
    },
    {
      "Sid": "ListSiteBucket",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::web-assets-prod"
    },
    {
      "Sid": "DeployApiCode",
      "Effect": "Allow",
      "Action": ["lambda:UpdateFunctionCode", "lambda:GetFunction"],
      "Resource": "arn:aws:lambda:us-east-1:000000000000:function:web-api"
    }
  ]
}
EOF
aws accessanalyzer validate-policy --policy-type IDENTITY_POLICY --policy-document file://deploy-policy.json
aws iam create-role --role-name web-deployer --assume-role-policy-document file://trust-policy.json \
  --description "Deploys the web site and web-api code" --max-session-duration 3600
aws iam put-role-policy --role-name web-deployer --policy-name deploy --policy-document file://deploy-policy.json
aws iam put-role-permissions-boundary --role-name web-deployer \
  --permissions-boundary arn:aws:iam::000000000000:policy/PlatformBoundary
aws iam simulate-principal-policy --policy-source-arn arn:aws:iam::000000000000:role/web-deployer \
  --action-names s3:PutObject s3:DeleteBucket --resource-arns arn:aws:s3:::web-assets-prod/index.html > simulation.json
`,
      },
    },
    {
      id: "sts",
      kind: "reading",
      title: "STS, AssumeRole and cross-account access",
      minutes: 14,
      body: String.raw`
The **Security Token Service** turns "I am allowed to be this role" into actual credentials. Every role session in AWS, whether it's a Lambda invocation, an SSO login or a Terraform run, starts with an STS call.

| Call | Who uses it | Input |
|---|---|---|
| \`AssumeRole\` | humans with a profile, CI, cross-account automation, services on your behalf | existing AWS credentials |
| \`AssumeRoleWithWebIdentity\` | GitHub Actions, GitLab, EKS IRSA | an OIDC JWT from a trusted IdP |
| \`AssumeRoleWithSAML\` | enterprise SSO (directly, or via Identity Center) | a SAML assertion |
| \`GetSessionToken\` | an IAM user adding MFA to its own long-lived key | the user's key + MFA code |

## Two halves of a successful AssumeRole

1. The **caller** must be allowed to call \`sts:AssumeRole\` on the role ARN by its own identity policy. (Within the same account, a trust policy that names the caller's exact ARN is enough on its own.)
2. The role's **trust policy** must allow that caller, and its conditions (ExternalId, MFA, source IP, OIDC claims) must match.

STS then returns an access key, a secret, a **session token** and an expiry. The session's permissions are the role's policies, capped by the role's boundary and by any **session policy** passed in the call.

## Try it: assume a role from the shell

Create a role that anyone in the account may assume, but only with an **external ID**:

\`\`\`bash
cat > demo-sts-trust.json <<'EOF'
{ "Version": "2012-10-17",
  "Statement": [{ "Effect": "Allow", "Principal": { "AWS": "arn:aws:iam::000000000000:root" },
    "Action": "sts:AssumeRole",
    "Condition": { "StringEquals": { "sts:ExternalId": "vendor-7f3a" } } }] }
EOF
aws iam create-role --role-name demo-sts --assume-role-policy-document file://demo-sts-trust.json --query Role.Arn
aws sts assume-role --role-arn arn:aws:iam::000000000000:role/demo-sts --role-session-name try-1
\`\`\`

That fails with \`AccessDenied\`: the trust policy's condition didn't match. The emulator, like AWS, enforces trust policies. Pass the external ID and export the three values the way every CI script does:

\`\`\`bash
read -r AK SK ST <<< "$(aws sts assume-role --role-arn arn:aws:iam::000000000000:role/demo-sts \
  --role-session-name try-2 --external-id vendor-7f3a \
  --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text)"
export AWS_ACCESS_KEY_ID="$AK" AWS_SECRET_ACCESS_KEY="$SK" AWS_SESSION_TOKEN="$ST"
aws sts get-caller-identity
\`\`\`

You're now \`arn:aws:sts::000000000000:assumed-role/demo-sts/try-2\`. The role has no permission policies, so almost everything fails, which you can see right away:

\`\`\`bash
aws iam list-roles --max-items 1
\`\`\`

\`…because no identity-based policy allows the iam:ListRoles action\`. Drop the role and go back to your own identity. **Forgetting this step is the classic "why am I AccessDenied in my own terminal" mistake.**

\`\`\`bash
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
aws sts get-caller-identity --query Arn
\`\`\`

## Profiles: let the CLI assume for you

Exporting variables is fine in CI. For humans, put the role in a profile and let the CLI (and every SDK) call STS, cache the credentials and refresh them when they expire:

\`\`\`text
# ~/.aws/config
[profile prod-deployer]
role_arn          = arn:aws:iam::111122223333:role/deployer
source_profile    = sso-admin        # whose credentials call AssumeRole
role_session_name = alice            # shows up in CloudTrail
duration_seconds  = 3600
external_id       = vendor-7f3a      # if the trust policy requires it
mfa_serial        = arn:aws:iam::999999999999:mfa/alice   # prompts for a code
\`\`\`

Then \`aws s3 ls --profile prod-deployer\`, \`AWS_PROFILE=prod-deployer terraform plan\`, or \`aws configure export-credentials --profile prod-deployer --format env\` to print \`export\` lines for tools that only read environment variables. The CLI caches the session under \`~/.aws/cli/cache/\`. Terraform's AWS provider can also do it itself with an \`assume_role { role_arn = … }\` block, which is the standard way to deploy into many accounts from one pipeline.

## Session lifetime and chaining

- \`--duration-seconds\` runs from 900 up to the role's **MaxSessionDuration** (default 3600, max 43200). Ask for more and you get a \`ValidationError\`.
- **Role chaining** (using a role session to assume another role) is capped at **1 hour** on AWS, whatever the role's maximum. Long Terraform applies that chain roles fail at minute 61. Design for one hop, or refresh.
- Credentials can't be revoked individually. To kill leaked sessions, attach a policy that denies everything for sessions issued before now (\`aws:TokenIssueTime\`): the console's **Revoke active sessions** button does exactly this.

## Cross-account access

<figure class="diagram">
<svg viewBox="0 0 640 230" role="img" aria-label="A CI role in the tooling account assumes a deploy role in the prod account; both sides must allow it">
  <rect x="10" y="10" width="260" height="210" rx="10" class="d-box d-outer"/><text x="26" y="34" class="d-label">Tooling account 111111111111</text>
  <rect x="30" y="60" width="220" height="56" rx="8" class="d-box"/><text x="140" y="84" text-anchor="middle" class="d-label">role/ci-runner</text><text x="140" y="102" text-anchor="middle" class="d-small">identity policy: sts:AssumeRole</text>
  <rect x="30" y="140" width="220" height="56" rx="8" class="d-box d-dim"/><text x="140" y="164" text-anchor="middle" class="d-small">Resource: arn:aws:iam::</text><text x="140" y="180" text-anchor="middle" class="d-small">222222222222:role/deployer</text>
  <rect x="370" y="10" width="260" height="210" rx="10" class="d-box d-outer"/><text x="386" y="34" class="d-label">Prod account 222222222222</text>
  <rect x="390" y="60" width="220" height="56" rx="8" class="d-box d-accent"/><text x="500" y="84" text-anchor="middle" class="d-label">role/deployer</text><text x="500" y="102" text-anchor="middle" class="d-small">trust: 1111…:role/ci-runner</text>
  <rect x="390" y="140" width="220" height="56" rx="8" class="d-box"/><text x="500" y="164" text-anchor="middle" class="d-label">prod resources</text><text x="500" y="182" text-anchor="middle" class="d-small">via deployer's policies</text>
  <path d="M250 88 H388" class="d-arrow"/><text x="319" y="80" text-anchor="middle" class="d-small">sts:AssumeRole</text>
  <path d="M500 116 V138" class="d-arrow"/>
  <path d="M140 116 V138" class="d-arrow d-dashed"/>
</svg>
<figcaption>Hub-and-spoke: one CI identity in a tooling account, one narrowly scoped deploy role per target account. Both accounts must agree.</figcaption>
</figure>

The patterns you'll see in real organizations:

- **Hub-and-spoke deploy roles.** One CI identity, a \`deployer\` role in each workload account trusting exactly that identity. Adding an account means adding one role, not new keys.
- **Resource policies for data sharing.** For one bucket, key or queue, a resource policy naming the other account's role avoids a role hop. Remember that the other account's identity policy must allow it too, and that KMS-encrypted data also needs the **key policy** to allow the other account.
- **Third parties (SaaS vendors).** The vendor's account assumes a role in yours. Always require \`sts:ExternalId\` with a value the vendor generates per customer. Without it, the vendor is a **confused deputy**: another of its customers could enter *your* role ARN and have the vendor act on your account.
- **Organization-wide trust.** \`"Condition": {"StringEquals": {"aws:PrincipalOrgID": "o-abc123"}}\` instead of listing dozens of account IDs.

> **On real AWS:** a trust policy that names a principal that doesn't exist is rejected (\`MalformedPolicyDocument: Invalid principal\`). If you later delete and recreate the trusted role, the trust policy shows a unique ID (\`AROA…\`) instead of the ARN and **no longer matches** the new role: you must update the trust policy. The emulator doesn't validate principals, so you won't see either behaviour here.

## A teaser: OIDC federation for CI

The best CI credential is none at all. GitHub Actions, GitLab and most modern CI systems issue each job a signed OIDC token. You register the CI provider once (\`aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com …\`) and write a trust policy that only accepts tokens for *your repository and branch*:

\`\`\`json
{
  "Effect": "Allow",
  "Principal": { "Federated": "arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com" },
  "Action": "sts:AssumeRoleWithWebIdentity",
  "Condition": {
    "StringEquals": {
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
      "token.actions.githubusercontent.com:sub": "repo:acme/web:ref:refs/heads/main"
    }
  }
}
\`\`\`

No secrets live in CI, every job gets a fresh one-hour session, and the session name ties CloudTrail entries to the run. Module 13 builds this end to end, including the \`sub\`-claim mistakes that let any fork deploy to prod.
`,
    },
    {
      id: "assume-role",
      kind: "lab",
      title: "Lab: become the deploy role",
      minutes: 25,
      body: String.raw`
A release pipeline uploads build artifacts to the bucket \`release-artifacts\`. The bucket policy denies \`s3:PutObject\` to **everyone except** the role \`release-deployer\`, so the only way to ship is to become that role. \`release-deployer\` trusts exactly one principal: the IAM user \`ci-bot\`, whose (long-lived, regrettable) access key is in \`ci-bot.credentials\` in the lab folder.

You'll do what a pipeline does: get refused, assume the role properly, act as it, and then wire it into a CLI profile so nobody has to copy credentials by hand.

\`\`\`bash
cat ci-bot.credentials
aws iam get-role --role-name release-deployer --query Role.AssumeRolePolicyDocument
aws s3api get-bucket-policy --bucket release-artifacts --query Policy --output text
\`\`\`

## Using a credentials file for one command

The CLI reads \`AWS_SHARED_CREDENTIALS_FILE\` to find credentials, and \`--profile\` picks a section. Prefixing a single command keeps the rest of your shell unchanged:

\`\`\`text
AWS_SHARED_CREDENTIALS_FILE=./ci-bot.credentials aws sts get-caller-identity --profile ci-bot
\`\`\`

> **On real AWS:** you'd never keep a user's access key in a file next to your code. This lab uses it to stand in for "some other identity". In module 13 the same pipeline uses OIDC federation and the key disappears.

The checks look at **CloudTrail** for proof of what you did, just as an auditor would. CloudTrail records management events like \`AssumeRole\` and \`GetCallerIdentity\` with the caller's identity (and the session name for role sessions), including failed calls with their \`errorCode\`. S3 object uploads are *data events*, which CloudTrail doesn't record by default; that's why the bucket policy carries the proof for the upload task.

Press **Prepare lab** to create the user, role, bucket and credentials file.
`,
      lab: {
        files: {
          "build.txt": String.raw`
release 42
commit 9f3c2e1
built-by release pipeline
`,
        },
        setup: String.raw`
aws iam get-user --user-name ci-bot >/dev/null 2>&1 || aws iam create-user --user-name ci-bot >/dev/null
for k in $(aws iam list-access-keys --user-name ci-bot --query 'AccessKeyMetadata[].AccessKeyId' --output text); do
  aws iam delete-access-key --user-name ci-bot --access-key-id "$k"
done
read -r AK SK <<< "$(aws iam create-access-key --user-name ci-bot --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text)"
printf '[ci-bot]\naws_access_key_id = %s\naws_secret_access_key = %s\n' "$AK" "$SK" > ci-bot.credentials
chmod 600 ci-bot.credentials

TRUST='{"Version":"2012-10-17","Statement":[{"Sid":"OnlyCiBot","Effect":"Allow","Principal":{"AWS":"arn:aws:iam::000000000000:user/ci-bot"},"Action":"sts:AssumeRole"}]}'
if aws iam get-role --role-name release-deployer >/dev/null 2>&1; then
  aws iam update-assume-role-policy --role-name release-deployer --policy-document "$TRUST"
else
  aws iam create-role --role-name release-deployer --assume-role-policy-document "$TRUST" >/dev/null
fi
aws iam put-role-policy --role-name release-deployer --policy-name upload-artifacts --policy-document '{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:PutObject", "s3:GetObject"], "Resource": "arn:aws:s3:::release-artifacts/*" },
    { "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::release-artifacts" }
  ] }'

aws s3api head-bucket --bucket release-artifacts 2>/dev/null || aws s3api create-bucket --bucket release-artifacts >/dev/null
aws s3api put-bucket-policy --bucket release-artifacts --policy '{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "OnlyReleaseDeployerWrites",
    "Effect": "Deny",
    "Principal": "*",
    "Action": "s3:PutObject",
    "Resource": "arn:aws:s3:::release-artifacts/*",
    "Condition": { "ArnNotEquals": { "aws:PrincipalArn": "arn:aws:iam::000000000000:role/release-deployer" } }
  }] }'
echo "ci-bot, release-deployer and release-artifacts are ready."
`,
        tasks: [
          {
            id: "denied",
            title: "Get refused by the trust policy",
            description:
              "As your normal terminal identity (`user/emulator`, with no extra variables set), try to assume `arn:aws:iam::000000000000:role/release-deployer`. It must fail with `AccessDenied`, because the trust policy only names `ci-bot`. The check finds your failed attempt in CloudTrail.",
            hints: [
              "`aws sts assume-role --role-arn arn:aws:iam::000000000000:role/release-deployer --role-session-name me`",
              "If you already exported role credentials, run `unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN` first, and check with `aws sts get-caller-identity`.",
            ],
            check: async (ctx) => {
              const want = roleArn(ctx, "release-deployer");
              const ev = await trailEvents(ctx, "EventName", "AssumeRole");
              const hit = ev.find(
                (e) => e.detail.errorCode === "AccessDenied" && e.detail.requestParameters?.roleArn === want && e.detail.userIdentity?.arn?.endsWith(":user/emulator"),
              );
              if (!hit) return "CloudTrail has no denied AssumeRole on `release-deployer` from `user/emulator` yet.";
              return true;
            },
          },
          {
            id: "identity",
            title: "Assume the role as ci-bot and prove who you are",
            description:
              "Using **ci-bot's** credentials, assume `release-deployer` with the session name `release-42`. Export the temporary credentials (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`) in your shell, then save the output of `aws sts get-caller-identity` to `identity.json`.",
            hints: [
              "Call STS as ci-bot: `AWS_SHARED_CREDENTIALS_FILE=./ci-bot.credentials aws sts assume-role --profile ci-bot --role-arn … --role-session-name release-42`.",
              "Add `--query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text` and capture the three values with `read -r AK SK ST <<< \"$(…)\"`.",
              "`export AWS_ACCESS_KEY_ID=\"$AK\" AWS_SECRET_ACCESS_KEY=\"$SK\" AWS_SESSION_TOKEN=\"$ST\"`, then `aws sts get-caller-identity > identity.json`.",
            ],
            check: async (ctx) => {
              const f = await ctx.readFile("identity.json");
              if (f === null) return "`identity.json` not found in the lab folder.";
              let j: any;
              try {
                j = JSON.parse(f);
              } catch {
                return "`identity.json` isn't valid JSON. Save the default output of `aws sts get-caller-identity`.";
              }
              const want = `arn:aws:sts::${ctx.account}:assumed-role/release-deployer/release-42`;
              if (j.Arn !== want) return `identity.json says you were \`${j.Arn}\`; expected \`${want}\`.`;
              const ev = await trailEvents(ctx, "Username", "release-42");
              if (!ev.some((e) => e.EventName === "GetCallerIdentity"))
                return "CloudTrail has no GetCallerIdentity call from the session `release-42`. Run the command with the exported credentials.";
              // Note: the emulator's CloudTrail attributes AssumeRole calls signed with an IAM user's
              // own key to user/emulator, so match on the role and session name only.
              const assumed = (await trailEvents(ctx, "EventName", "AssumeRole")).some(
                (e) =>
                  !e.detail.errorCode &&
                  e.detail.requestParameters?.roleSessionName === "release-42" &&
                  e.detail.requestParameters?.roleArn === roleArn(ctx, "release-deployer"),
              );
              if (!assumed) return "CloudTrail shows no successful AssumeRole on `release-deployer` with session name `release-42`.";
              return true;
            },
          },
          {
            id: "upload",
            title: "Ship the artifact as the role",
            description:
              "While acting as `release-deployer`, upload `build.txt` to `s3://release-artifacts/releases/42/build.txt`. The bucket policy rejects this upload from anyone else, so the object's existence is the proof. Afterwards, `unset` the three variables to drop the role.",
            hints: [
              "`aws s3 cp build.txt s3://release-artifacts/releases/42/build.txt`, with the role's credentials still exported.",
              "If you get `explicit deny in a resource-based policy`, you're not acting as the role: check `aws sts get-caller-identity`.",
            ],
            check: async (ctx) => {
              const h = await ctx.tryAws(["s3api", "head-object", "--bucket", "release-artifacts", "--key", "releases/42/build.txt"]);
              if (!h.ok) return "`s3://release-artifacts/releases/42/build.txt` doesn't exist yet.";
              const same = await ctx.sh("aws s3 cp s3://release-artifacts/releases/42/build.txt - | cmp -s - build.txt");
              if (same.code !== 0) return "The uploaded object's content differs from `build.txt`.";
              return true;
            },
          },
          {
            id: "profile",
            title: "Let the CLI assume the role from a profile",
            description:
              "Create a config file `aws-config` in the lab folder with a profile named `deployer` that assumes `release-deployer` using `source_profile = ci-bot` and `role_session_name = release-cli`. The check runs `AWS_CONFIG_FILE=./aws-config AWS_SHARED_CREDENTIALS_FILE=./ci-bot.credentials aws sts get-caller-identity --profile deployer` and expects the `release-cli` session.",
            hints: [
              "Profiles in a config file are headed `[profile deployer]`. You need `role_arn`, `source_profile` and `role_session_name` lines.",
              "Try it yourself with the same command as the check. Unset any exported role credentials first, so you know the profile is doing the work.",
            ],
            check: async (ctx) => {
              const f = await ctx.readFile("aws-config");
              if (f === null) return "`aws-config` not found in the lab folder.";
              if (!/\[\s*profile\s+deployer\s*\]/.test(f)) return "`aws-config` has no `[profile deployer]` section.";
              const r = await ctx.sh(`H=$(mktemp -d); HOME="$H" AWS_CONFIG_FILE=./aws-config AWS_SHARED_CREDENTIALS_FILE=./ci-bot.credentials \
aws sts get-caller-identity --profile deployer --query Arn --output text; c=$?; rm -rf "$H"; exit $c`);
              if (r.code !== 0) return `The profile doesn't work yet: ${r.stderr.trim().split("\n").pop()}`;
              const want = `arn:aws:sts::${ctx.account}:assumed-role/release-deployer/release-cli`;
              if (r.stdout.trim() !== want) return `The profile resolves to \`${r.stdout.trim()}\`; expected \`${want}\`.`;
              return true;
            },
          },
        ],
        solution: String.raw`
# 1. Refused: user/emulator isn't in the trust policy.
if aws sts assume-role --role-arn arn:aws:iam::000000000000:role/release-deployer --role-session-name me 2>denied.txt; then
  echo "unexpected: assume-role succeeded" >&2; exit 1
fi
grep -q AccessDenied denied.txt

# 2. Assume the role as ci-bot and export the session.
read -r AK SK ST <<< "$(AWS_SHARED_CREDENTIALS_FILE=./ci-bot.credentials aws sts assume-role --profile ci-bot \
  --role-arn arn:aws:iam::000000000000:role/release-deployer --role-session-name release-42 \
  --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text)"
export AWS_ACCESS_KEY_ID="$AK" AWS_SECRET_ACCESS_KEY="$SK" AWS_SESSION_TOKEN="$ST"
aws sts get-caller-identity > identity.json

# 3. Act as the role, then drop it.
aws s3 cp build.txt s3://release-artifacts/releases/42/build.txt
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN

# 4. A profile that does the assume for you.
cat > aws-config <<'EOF'
[profile deployer]
role_arn = arn:aws:iam::000000000000:role/release-deployer
source_profile = ci-bot
role_session_name = release-cli
duration_seconds = 900
EOF
`,
      },
    },
  ],
  quiz: [
    {
      q: "A role has `AdministratorAccess` attached. A separate inline policy on the same role denies `s3:DeleteBucket` on `arn:aws:s3:::audit-logs`. An engineer using the role tries to delete that bucket. What happens?",
      options: [
        "It succeeds, because AdministratorAccess is an AWS managed policy and takes precedence",
        "It succeeds, because the Allow statement is more general",
        "It's denied: an explicit Deny in any applicable policy overrides every Allow",
        "It depends on which policy was attached first",
      ],
      answer: 2,
      explain:
        "AWS evaluates all applicable policies together, with no ordering. An explicit `Deny` that matches the request always wins. That's why guardrails are written as explicit denies, ideally somewhere the restricted people can't edit (an SCP, a boundary or a resource policy).",
    },
    {
      q: "Account A's bucket policy allows `arn:aws:iam::B:role/analytics` to `s3:GetObject`. The analytics role in account B has no policy mentioning S3. Reads fail with AccessDenied. Why?",
      options: [
        "Bucket policies can't grant access to other accounts",
        "Cross-account access needs both sides: account B's identity policy must also allow s3:GetObject on that bucket",
        "The role must be assumed with an external ID",
        "S3 requires an ACL for cross-account reads",
      ],
      answer: 1,
      explain:
        "Within one account, a resource-policy Allow can be enough on its own. **Across accounts**, the resource's account (bucket policy) and the caller's account (identity policy) must both allow it. If the objects are SSE-KMS encrypted, the KMS key policy must allow account B as well.",
    },
    {
      q: "You're onboarding a SaaS monitoring vendor that will assume a role in your account. Their docs ask you to trust their AWS account ID. What else should the trust policy require, and why?",
      options: [
        "aws:SecureTransport, so the AssumeRole call uses TLS",
        "An sts:ExternalId condition with the unique value the vendor gives you, so another of the vendor's customers can't trick the vendor into assuming your role",
        "aws:MultiFactorAuthPresent, so the vendor uses MFA",
        "Nothing: trusting their account ID is sufficient",
      ],
      answer: 1,
      explain:
        "The vendor's account acts for many customers. Without an external ID, any of its customers could enter *your* role ARN in the vendor's UI and the vendor would assume it: the **confused deputy** problem. A per-customer `sts:ExternalId` that only you and the vendor know closes it.",
    },
    {
      q: "Developers may create IAM roles for their Lambda functions. How do you stop one of them creating a role with `AdministratorAccess` and using it to escalate?",
      options: [
        "Remove iam:CreateRole and have the platform team create every role by hand",
        "Allow iam:CreateRole only with the condition iam:PermissionsBoundary = the platform boundary ARN, and deny changing or deleting that boundary",
        "Use an SCP that denies AdministratorAccess",
        "Tag the roles with owner=developer",
      ],
      answer: 1,
      explain:
        "A **permissions boundary** caps whatever is attached to a role. Requiring it at creation time (`iam:PermissionsBoundary` condition) and denying `iam:DeleteRolePermissionsBoundary` / `iam:PutRolePermissionsBoundary` lets developers self-serve without being able to exceed the boundary. Scope their `iam:PassRole` too.",
    },
    {
      q: "Your Lambda's resource policy allows `s3.amazonaws.com` to `lambda:InvokeFunction` with no conditions. What's the risk, and the fix?",
      options: [
        "No risk: only your buckets can invoke it",
        "Any S3 bucket in any account could be configured to invoke your function; add aws:SourceArn (your bucket) and aws:SourceAccount conditions",
        "S3 needs an IAM user to invoke functions",
        "The function will be invoked twice per event",
      ],
      answer: 1,
      explain:
        "Service principals are shared by all AWS customers. Pinning `aws:SourceArn` and `aws:SourceAccount` makes sure the service is acting for *your* resource, which prevents the cross-account confused deputy. `lambda add-permission --source-arn … --source-account …` sets these for you.",
    },
    {
      q: "A GitHub Actions workflow deploys with an IAM user's access key stored as a repository secret. What's the best replacement?",
      options: [
        "Rotate the key every 90 days with a scheduled job",
        "Store the key in Secrets Manager and fetch it at the start of each job",
        "Federate with GitHub's OIDC provider and let the job call AssumeRoleWithWebIdentity on a role whose trust policy pins the repository and branch in the sub claim",
        "Use the root user's key, which can't be restricted by mistake",
      ],
      answer: 2,
      explain:
        "OIDC federation removes the long-lived secret entirely. Each job gets a fresh, short-lived session, and the trust policy's `sub` condition (for example `repo:acme/web:ref:refs/heads/main`) decides which workflows may deploy. Rotation and storing the key elsewhere both keep a long-lived credential in play.",
    },
    {
      q: "A Terraform run assumes `tooling` and then, from that session, assumes `prod-deployer` with `duration_seconds = 7200`. `prod-deployer` has MaxSessionDuration 43200. On AWS the second AssumeRole fails. Why?",
      options: [
        "Role chaining limits the chained session to 1 hour, whatever the role's MaxSessionDuration",
        "prod-deployer needs MaxSessionDuration of at least 86400",
        "AssumeRole can't be called with temporary credentials",
        "duration_seconds only applies to SSO profiles",
      ],
      answer: 0,
      explain:
        "Sessions obtained by **role chaining** are capped at one hour. Long-running automation should assume the target role directly from its base credentials, or refresh credentials before they expire.",
    },
  ],
};
