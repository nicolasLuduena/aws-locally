import type { CheckContext, Module } from "../types.ts";

// ------------------------------------------------------------------ helpers
const ACCT = "000000000000";
const REGION = "us-east-1";
const IMAGE = `${ACCT}.dkr.ecr.${REGION}.amazonaws.com/shop/api:1.0.0`;
const PARAM_ARN = `arn:aws:ssm:${REGION}:${ACCT}:parameter/shop/prod/db-password`;
const QUEUE_ARN = `arn:aws:sqs:${REGION}:${ACCT}:shop-orders`;

const list = (x: any): any[] => (x == null ? [] : Array.isArray(x) ? x : [x]);
const statements = (doc: any): any[] => list(doc?.Statement);
const parseDoc = (d: any) => (typeof d === "string" ? JSON.parse(decodeURIComponent(d)) : d);
/** IAM-style wildcard match, case-insensitive. */
const globMatch = (pattern: string, value: string) =>
  new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i").test(value);

/** Returns a failure string, or null when the role trusts exactly ecs-tasks.amazonaws.com. */
async function ecsTrustProblem(ctx: CheckContext, role: string): Promise<string | null> {
  const r = await ctx.tryAws(["iam", "get-role", "--role-name", role]);
  if (!r.ok) return `Role \`${role}\` doesn't exist yet.`;
  const allow = statements(parseDoc(r.data.Role.AssumeRolePolicyDocument)).filter((s) => s.Effect === "Allow");
  const ok = allow.some(
    (s) => list(s.Principal?.Service).includes("ecs-tasks.amazonaws.com") && list(s.Action).some((a: string) => globMatch(a, "sts:AssumeRole")),
  );
  if (!ok) return `The trust policy of \`${role}\` must allow the service principal \`ecs-tasks.amazonaws.com\` to call \`sts:AssumeRole\`.`;
  const extra = allow.filter(
    (s) => s.Principal === "*" || list(s.Principal?.AWS).length > 0 || list(s.Principal?.Service).some((p: string) => p !== "ecs-tasks.amazonaws.com"),
  );
  if (extra.length) return `The trust policy of \`${role}\` trusts more than \`ecs-tasks.amazonaws.com\`. Only ECS tasks should be able to assume it.`;
  return null;
}

async function decision(ctx: CheckContext, role: string, action: string, resource?: string): Promise<string> {
  const args = ["iam", "simulate-principal-policy", "--policy-source-arn", `arn:aws:iam::${ACCT}:role/${role}`, "--action-names", action];
  if (resource) args.push("--resource-arns", resource);
  const r = await ctx.aws(args);
  return r.EvaluationResults?.[0]?.EvalDecision ?? "unknown";
}

async function sgId(ctx: CheckContext, name: string): Promise<string | null> {
  const r = await ctx.tryAws(["ec2", "describe-security-groups", "--filters", `Name=group-name,Values=${name}`]);
  return r.ok ? (r.data.SecurityGroups?.[0]?.GroupId ?? null) : null;
}

// Shared by the Fargate lab: recreates everything the ECR/IAM lab produced, plus a network and an ALB.
const FARGATE_SETUP = String.raw`
TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole","Condition":{"StringEquals":{"aws:SourceAccount":"000000000000"}}}]}'
for r in shop-api-execution shop-api-task; do
  aws iam get-role --role-name $r >/dev/null 2>&1 || aws iam create-role --role-name $r --assume-role-policy-document "$TRUST" >/dev/null
done
aws iam attach-role-policy --role-name shop-api-execution --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
aws iam put-role-policy --role-name shop-api-execution --policy-name read-db-secret --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"ssm:GetParameters","Resource":"arn:aws:ssm:us-east-1:000000000000:parameter/shop/prod/db-password"}]}'
aws iam put-role-policy --role-name shop-api-task --policy-name send-orders --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"sqs:SendMessage","Resource":"arn:aws:sqs:us-east-1:000000000000:shop-orders"}]}'
aws ssm put-parameter --name /shop/prod/db-password --type SecureString --value 'change-me' --overwrite >/dev/null
aws sqs create-queue --queue-name shop-orders >/dev/null
aws ecr describe-repositories --repository-names shop/api >/dev/null 2>&1 || \
  aws ecr create-repository --repository-name shop/api --image-tag-mutability IMMUTABLE --image-scanning-configuration scanOnPush=true >/dev/null

VPC=$(aws ec2 describe-vpcs --filters Name=tag:Name,Values=shop-vpc --query 'Vpcs[0].VpcId' --output text)
if [ "$VPC" = None ]; then
  VPC=$(aws ec2 create-vpc --cidr-block 10.20.0.0/16 --tag-specifications 'ResourceType=vpc,Tags=[{Key=Name,Value=shop-vpc}]' --query Vpc.VpcId --output text)
fi
subnet() {
  local id
  id=$(aws ec2 describe-subnets --filters "Name=tag:Name,Values=$1" --query 'Subnets[0].SubnetId' --output text)
  if [ "$id" = None ]; then
    id=$(aws ec2 create-subnet --vpc-id "$VPC" --cidr-block "$2" --availability-zone "$3" \
      --tag-specifications "ResourceType=subnet,Tags=[{Key=Name,Value=$1}]" --query Subnet.SubnetId --output text)
  fi
  echo "$id"
}
PUB_A=$(subnet shop-public-a 10.20.0.0/24 us-east-1a)
PUB_B=$(subnet shop-public-b 10.20.1.0/24 us-east-1b)
PRIV_A=$(subnet shop-private-a 10.20.10.0/24 us-east-1a)
PRIV_B=$(subnet shop-private-b 10.20.11.0/24 us-east-1b)
sg() {
  local id
  id=$(aws ec2 describe-security-groups --filters "Name=group-name,Values=$1" "Name=vpc-id,Values=$VPC" --query 'SecurityGroups[0].GroupId' --output text)
  [ "$id" != None ] || id=$(aws ec2 create-security-group --group-name "$1" --description "$2" --vpc-id "$VPC" --query GroupId --output text)
  echo "$id"
}
ALB_SG=$(sg shop-alb "Internet-facing ALB for shop-api")
TASK_SG=$(sg shop-api-tasks "shop-api Fargate tasks")
aws ec2 authorize-security-group-ingress --group-id "$ALB_SG" --protocol tcp --port 80 --cidr 0.0.0.0/0 >/dev/null 2>&1 || true

ALB=$(aws elbv2 describe-load-balancers --names shop-alb --query 'LoadBalancers[0].LoadBalancerArn' --output text 2>/dev/null) || \
  ALB=$(aws elbv2 create-load-balancer --name shop-alb --subnets "$PUB_A" "$PUB_B" --security-groups "$ALB_SG" --query 'LoadBalancers[0].LoadBalancerArn' --output text)
TG=$(aws elbv2 describe-target-groups --names shop-api-tg --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null) || \
  TG=$(aws elbv2 create-target-group --name shop-api-tg --protocol HTTP --port 8080 --vpc-id "$VPC" --target-type ip \
    --health-check-path /healthz --health-check-interval-seconds 15 --healthy-threshold-count 2 --query 'TargetGroups[0].TargetGroupArn' --output text)
aws elbv2 modify-target-group-attributes --target-group-arn "$TG" --attributes Key=deregistration_delay.timeout_seconds,Value=30 >/dev/null
if [ "$(aws elbv2 describe-listeners --load-balancer-arn "$ALB" --query 'length(Listeners)')" = 0 ]; then
  aws elbv2 create-listener --load-balancer-arn "$ALB" --protocol HTTP --port 80 --default-actions "Type=forward,TargetGroupArn=$TG" >/dev/null
fi

cat > lab.env <<EOF
# source lab.env   (IDs created by Prepare lab)
export VPC_ID=$VPC
export SUBNET_A=$PRIV_A
export SUBNET_B=$PRIV_B
export ALB_SG=$ALB_SG
export TASK_SG=$TASK_SG
export TG_ARN=$TG
EOF
echo "Network ready. Run: source lab.env"
`;

export const containers: Module = {
  id: "containers",
  number: "08",
  title: "Containers: ECR, ECS & EKS",
  summary:
    "Ship containers the way production teams do: immutable images in ECR, Fargate services with correctly split IAM roles, injected secrets, safe deployments and auto scaling, and know when EKS is worth its cost.",
  services: ["ECR", "ECS", "Fargate", "EKS", "IAM", "ELB", "Application Auto Scaling"],
  lessons: [
    // ---------------------------------------------------------------- ECR
    {
      id: "ecr",
      kind: "reading",
      title: "Images and ECR",
      minutes: 14,
      body: String.raw`
A container image is a **manifest** (a small JSON document) that points at a **config blob** and an ordered list of **layer blobs**, each named by the SHA-256 of its content. A registry stores blobs and manifests; a **tag** like \`1.4.2\` is just a movable pointer to a manifest. That one fact explains most container supply-chain incidents: *the tag you deployed yesterday may not point at the same bytes today*.

**Amazon ECR** is AWS's private OCI registry. One registry per account per region (\`<account>.dkr.ecr.<region>.amazonaws.com\`), containing **repositories** (\`shop/api\`, \`shop/worker\`). Authentication uses IAM: \`aws ecr get-login-password\` returns a token, valid for 12 hours, that \`docker login\` accepts.

## What \`docker push\` actually does

Every push is a handful of ECR API calls: upload each missing layer (\`InitiateLayerUpload\` → \`UploadLayerPart\` → \`CompleteLayerUpload\`), then \`PutImage\` with the manifest and a tag. You can do it by hand, which makes immutability visible:

\`\`\`bash
aws ecr create-repository --repository-name demo/web \
  --image-tag-mutability IMMUTABLE --image-scanning-configuration scanOnPush=true \
  --query 'repository.{uri: repositoryUri, tags: imageTagMutability}'

# a minimal image config blob, uploaded the way docker would
echo '{"architecture":"amd64","os":"linux","rootfs":{"type":"layers","diff_ids":[]},"config":{}}' > config.json
DIGEST="sha256:$( (sha256sum config.json 2>/dev/null || shasum -a 256 config.json) | cut -d' ' -f1)"
SIZE=$(( $(wc -c < config.json) ))
UPLOAD=$(aws ecr initiate-layer-upload --repository-name demo/web --query uploadId --output text)
aws ecr upload-layer-part --repository-name demo/web --upload-id "$UPLOAD" \
  --part-first-byte 0 --part-last-byte $((SIZE - 1)) --layer-part-blob fileb://config.json >/dev/null
aws ecr complete-layer-upload --repository-name demo/web --upload-id "$UPLOAD" --layer-digests "$DIGEST"

MANIFEST=$(jq -nc --arg d "$DIGEST" --argjson s "$SIZE" '{schemaVersion:2,
  mediaType:"application/vnd.docker.distribution.manifest.v2+json",
  config:{mediaType:"application/vnd.docker.container.image.v1+json",size:$s,digest:$d},layers:[]}')
aws ecr put-image --repository-name demo/web --image-tag 1.0.0 --image-manifest "$MANIFEST" --query image.imageId
\`\`\`

Now try to move the tag. Change one byte of the manifest (a different digest) and push it as \`1.0.0\` again:

\`\`\`bash
aws ecr put-image --repository-name demo/web --image-tag 1.0.0 \
  --image-manifest "$(echo "$MANIFEST" | jq -c '.annotations={"rebuild":"yes"}')"
\`\`\`

\`ImageTagAlreadyExistsException\`: the tag is pinned forever. That is what you want for release tags. (Re-pushing the *identical* manifest under the same tag is refused too, with \`ImageAlreadyExistsException\`. Pushing the same digest under a *new* tag is fine.)

## Tags, digests and immutability

| Reference | Example | Moves? | Use it for |
|---|---|---|---|
| Mutable tag | \`:latest\`, \`:main\` | Yes, every push | Local dev only |
| Immutable tag | \`:1.4.2\`, \`:git-3f9c2ab\` | Never (with \`IMMUTABLE\`) | What pipelines deploy |
| Digest | \`@sha256:9b1e…\` | Never, by definition | Exact provenance, signing, audits |

What a senior engineer does:

- Turn on **\`IMMUTABLE\`** for every repository a pipeline deploys from, and tag images with the **git SHA** (plus a semver tag for releases). Rollback is then "deploy the previous tag", and it is guaranteed to be the previous bytes.
- Never deploy \`:latest\`. Two tasks started an hour apart could run different code, and your task definition no longer says what's running. ECS now resolves a tag to a digest when a deployment starts, so all tasks *in one deployment* agree, but the task definition still doesn't tell a reader which build it is.
- Sign images (AWS Signer with Notation, or Sigstore cosign) and verify at admission time if you're regulated.

## Scanning

- **Basic scanning** (\`scanOnPush=true\` per repository, or a registry-wide rule) scans OS packages for CVEs when an image is pushed. It's free, and only as good as the day you pushed.
- **Enhanced scanning** hands the registry to **Amazon Inspector**: continuous re-scanning as new CVEs are published, OS **and** language packages (npm, pip, Maven, Go modules), and findings in Security Hub. This is what production uses, because the image you pushed six months ago and still run is where the new critical CVE lives.
- A scan result is a signal, not a gate, unless you make it one. Gate in the pipeline (fail the build on new criticals with a fix available) rather than at the registry.

## Lifecycle policies: cap what you keep

Every CI build pushes an image, and storage costs $0.10/GB-month. Without a policy a busy repository holds thousands of images nobody can deploy. A **lifecycle policy** is a list of rules, evaluated in \`rulePriority\` order (lowest number first). Each image is expired by at most one rule:

\`\`\`json
{ "rules": [
  { "rulePriority": 1, "description": "Untagged layers from failed or superseded pushes",
    "selection": { "tagStatus": "untagged", "countType": "sinceImagePushed", "countUnit": "days", "countNumber": 7 },
    "action": { "type": "expire" } },
  { "rulePriority": 2, "description": "Keep the newest 30 of everything else",
    "selection": { "tagStatus": "any", "countType": "imageCountMoreThan", "countNumber": 30 },
    "action": { "type": "expire" } }
]}
\`\`\`

Pitfalls that bite:

- A rule with \`tagStatus: any\` **must have the highest \`rulePriority\`**. ECR rejects the policy otherwise (the emulator enforces this too).
- Count-based rules don't know what's *running*. If you keep 10 images and ship 15 times on a busy day, the image your service rolls back to is gone, and the rollback fails with \`CannotPullContainerError\`. Size the count to your rollback window, or protect releases with a \`tagPatternList: ["release-*"]\` rule that keeps more.
- Use \`aws ecr start-lifecycle-policy-preview\` before you apply a new policy to an old repository. Expiry is permanent.

## Cross-account pulls

The standard layout is one **shared-services** account that owns ECR, and workload accounts that pull from it. Two policies must both allow the pull:

1. A **repository policy** (a resource policy) in the registry account that grants the pull actions to the other account: \`ecr:BatchGetImage\`, \`ecr:GetDownloadUrlForLayer\`, \`ecr:BatchCheckLayerAvailability\`. For a whole organisation, use \`"Principal": "*"\` with a \`aws:PrincipalOrgID\` condition instead of listing accounts.
2. An **identity policy** on the pulling role (usually the ECS execution role) that allows the same actions on that repository ARN, plus \`ecr:GetAuthorizationToken\` on \`*\`.

Grant **pull only**. A workload account that can \`PutImage\` into your shared repository can replace what every other account runs.

## Network path: the bill you don't expect

Tasks in private subnets reach ECR through a NAT gateway by default, and NAT charges $0.045 per GB processed. A 500 MB image pulled by 200 tasks during a deployment is 100 GB of NAT traffic, every deployment. Add **VPC endpoints**: \`com.amazonaws.<region>.ecr.api\` and \`ecr.dkr\` (interface endpoints), plus the **S3 gateway endpoint** (free), because layers are actually served from S3. Add \`logs\`, \`ssm\` and \`secretsmanager\` endpoints too if you want tasks to start with no internet route at all.

Other ECR features worth knowing: **replication** (cross-region and cross-account, for multi-region DR), **pull-through cache** (mirror Docker Hub, Quay or ECR Public, which avoids Docker Hub's rate limits and gives you a copy you control), and **KMS** encryption with a customer-managed key.

> **On real AWS vs the emulator:** ECR here implements repositories, policies, lifecycle validation and the layer-upload API faithfully. Lifecycle rules are stored and previewable, but nothing ages, so expiry never actually happens in a short session.
`,
    },
    // ---------------------------------------------------------------- ECS model
    {
      id: "ecs-model",
      kind: "reading",
      title: "ECS: the object model and the two roles",
      minutes: 16,
      body: String.raw`
ECS is AWS's own container orchestrator. It has far fewer concepts than Kubernetes, and that's the main reason to pick it. You need four nouns.

| Object | What it is | Lifecycle |
|---|---|---|
| **Cluster** | A namespace for tasks and services, plus the **capacity providers** that supply compute | Long-lived; one per environment or team |
| **Task definition** | A versioned, *immutable* JSON blueprint: images, CPU/memory, ports, roles, env, secrets, logging, health checks | Every change registers a new revision: \`shop-api:1\`, \`shop-api:2\`… |
| **Task** | One running instance of a task definition: one or more containers that share a network namespace and lifecycle | Ephemeral. Replaced, never patched |
| **Service** | A controller that keeps *N* copies of a task running, replaces failures, registers them with a load balancer, and runs deployments | Long-lived. This is what your IaC manages |

Use \`run-task\` for one-off and batch jobs (migrations, reports), and **services** for anything that should stay up. A scheduled job is an EventBridge Scheduler rule that calls \`RunTask\`.

## Task definitions

The fields that matter in production:

- **\`cpu\` / \`memory\`** at the task level. On Fargate only fixed combinations exist: 256 CPU units (0.25 vCPU) allows 512 MB–2 GB, 1024 allows 2–8 GB, and so on up to 16 vCPU / 120 GB. An invalid pair is rejected at registration.
- **\`essential\`**: if an essential container exits, the whole task stops. Sidecars (log routers, proxies) are often non-essential.
- **\`healthCheck\`**: a container-level command (\`CMD-SHELL curl -f localhost:8080/healthz\`). It's separate from the load balancer health check, and both matter.
- **\`stopTimeout\`**: how long ECS waits between SIGTERM and SIGKILL (default 30 s, max 120 s on Fargate). Your app must drain in-flight requests on SIGTERM, or every deployment drops requests.
- **\`runtimePlatform\`**: \`ARM64\` (Graviton) is ~20% cheaper on Fargate for the same vCPU/GB. Build multi-arch images and use it.

## The two roles: execution role vs task role

This is the #1 source of ECS confusion, and of over-privileged production roles. A task definition takes **two different IAM roles**, used by **two different actors** at **two different times**.

<figure class="diagram">
<svg viewBox="0 0 640 300" role="img" aria-label="The execution role is used by the ECS agent to pull images, ship logs and fetch secrets; the task role is used by application code to call AWS APIs">
  <text x="70" y="20" text-anchor="middle" class="d-small">EXECUTION role</text>
  <rect x="10" y="30" width="120" height="44" rx="6" class="d-box"/><text x="70" y="57" text-anchor="middle" class="d-label">ECR</text>
  <rect x="10" y="100" width="120" height="44" rx="6" class="d-box"/><text x="70" y="127" text-anchor="middle" class="d-label">CloudWatch Logs</text>
  <rect x="10" y="170" width="120" height="44" rx="6" class="d-box"/><text x="70" y="190" text-anchor="middle" class="d-label">SSM / Secrets</text><text x="70" y="206" text-anchor="middle" class="d-small">Manager</text>
  <rect x="160" y="30" width="320" height="250" rx="10" class="d-box d-outer"/>
  <text x="176" y="50" class="d-label">Task (Fargate micro-VM, own ENI)</text>
  <rect x="180" y="62" width="280" height="62" rx="8" class="d-box d-accent"/>
  <text x="320" y="88" text-anchor="middle" class="d-label">ECS agent / Fargate platform</text>
  <text x="320" y="106" text-anchor="middle" class="d-small">before and around container start</text>
  <rect x="180" y="176" width="280" height="80" rx="8" class="d-box d-ok"/>
  <text x="320" y="204" text-anchor="middle" class="d-label">Your container (app code)</text>
  <text x="320" y="222" text-anchor="middle" class="d-small">SDK fetches creds from 169.254.170.2</text>
  <text x="320" y="238" text-anchor="middle" class="d-small">for its whole lifetime</text>
  <path d="M180 75 L132 54" class="d-arrow"/>
  <path d="M180 93 L132 122" class="d-arrow"/>
  <path d="M180 110 L132 190" class="d-arrow"/>
  <path d="M320 124 V174" class="d-arrow d-dashed"/>
  <text x="328" y="148" class="d-small">image, env vars, secrets</text>
  <text x="570" y="128" text-anchor="middle" class="d-small">TASK role</text>
  <rect x="510" y="138" width="120" height="40" rx="6" class="d-box"/><text x="570" y="163" text-anchor="middle" class="d-label">SQS</text>
  <rect x="510" y="188" width="120" height="40" rx="6" class="d-box"/><text x="570" y="213" text-anchor="middle" class="d-label">S3</text>
  <rect x="510" y="238" width="120" height="40" rx="6" class="d-box"/><text x="570" y="263" text-anchor="middle" class="d-label">DynamoDB</text>
  <path d="M460 200 L508 160" class="d-arrow"/>
  <path d="M460 214 H508" class="d-arrow"/>
  <path d="M460 230 L508 256" class="d-arrow"/>
</svg>
<figcaption>The execution role belongs to the platform; the task role belongs to your code. Both trust <code>ecs-tasks.amazonaws.com</code>, and they should share no permissions.</figcaption>
</figure>

| | Execution role (\`executionRoleArn\`) | Task role (\`taskRoleArn\`) |
|---|---|---|
| Who uses it | The ECS agent / Fargate platform | Your application, through the AWS SDK |
| When | Pulling the image, creating log streams, resolving \`secrets\` at start | Every AWS call your code makes, for the life of the task |
| Typical permissions | \`AmazonECSTaskExecutionRolePolicy\` (ECR pull + \`logs:CreateLogStream\`/\`PutLogEvents\`), plus \`ssm:GetParameters\` / \`secretsmanager:GetSecretValue\` (+ \`kms:Decrypt\` for a customer-managed key) on *specific* secrets | Exactly what the app does: \`sqs:SendMessage\` on one queue, \`s3:GetObject\` on one prefix |
| Symptom when wrong | Task never starts: \`CannotPullContainerError\`, \`ResourceInitializationError: unable to pull secrets\` | Task runs, app logs \`AccessDenied\` |
| Also needed for | | ECS Exec (\`ssmmessages:*\`), X-Ray daemon, FireLens to S3 |

Both roles have the same **trust policy**: the service principal \`ecs-tasks.amazonaws.com\` may \`sts:AssumeRole\`. Add an \`aws:SourceAccount\` (or \`aws:SourceArn\`) condition so that only ECS acting *for your account* can assume them (the "confused deputy" protection):

\`\`\`json
{ "Version": "2012-10-17",
  "Statement": [{ "Effect": "Allow",
    "Principal": { "Service": "ecs-tasks.amazonaws.com" },
    "Action": "sts:AssumeRole",
    "Condition": { "StringEquals": { "aws:SourceAccount": "000000000000" } } }] }
\`\`\`

Anti-patterns you will find in real accounts: one role used as both (the app can now read every secret the platform injects, and pull any image); \`AmazonECSTaskExecutionRolePolicy\` attached to the task role "to make it work"; a task role with \`s3:*\` on \`*\`. Each service gets **its own** pair of roles.

## Secrets injection

Never put secrets in \`environment\`. Task definitions are readable by anyone with \`ecs:DescribeTaskDefinition\`, they're stored in every revision forever, and they show up in CloudTrail and IaC state. Use \`secrets\`:

\`\`\`json
"secrets": [
  { "name": "DB_PASSWORD", "valueFrom": "arn:aws:ssm:us-east-1:000000000000:parameter/shop/prod/db-password" },
  { "name": "STRIPE_KEY",  "valueFrom": "arn:aws:secretsmanager:us-east-1:000000000000:secret:shop/stripe-AbCdEf:api_key::" }
]
\`\`\`

At task start the **execution role** fetches each value and injects it as an environment variable. The task definition only ever contains the *reference*. The Secrets Manager form \`secret-arn:json-key:version-stage:version-id\` pulls one key out of a JSON secret.

The catch: values are read **once, at start**. Rotate a secret and running tasks keep the old value until they're replaced (\`aws ecs update-service --force-new-deployment\`). Apps that need live rotation (database credentials rotated every 30 days) should read Secrets Manager at runtime with a cache, using the **task** role.

See the difference for yourself:

\`\`\`bash
aws iam create-role --role-name demo-exec --assume-role-policy-document \
  '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}' --query Role.Arn
aws ssm put-parameter --name /demo/api-key --type SecureString --value hunter2 --overwrite
cat > demo-td.json <<'EOF'
{ "family": "demo-secrets", "networkMode": "awsvpc", "requiresCompatibilities": ["FARGATE"],
  "cpu": "256", "memory": "512", "executionRoleArn": "arn:aws:iam::000000000000:role/demo-exec",
  "containerDefinitions": [{ "name": "app", "image": "public.ecr.aws/docker/library/busybox:1.36", "essential": true,
    "environment": [{ "name": "BAD_IDEA", "value": "hunter2" }],
    "secrets": [{ "name": "API_KEY", "valueFrom": "/demo/api-key" }] }] }
EOF
aws ecs register-task-definition --cli-input-json file://demo-td.json \
  --query 'taskDefinition.containerDefinitions[0].{environment: environment, secrets: secrets}'
\`\`\`

Anyone who can describe the task definition sees \`hunter2\` in plain text; for \`API_KEY\` they see only the parameter name. Remove \`executionRoleArn\` and registration fails: ECS requires an execution role as soon as you use \`secrets\`.

## Logging with awslogs

The \`awslogs\` log driver ships stdout/stderr to CloudWatch Logs, using the **execution role**:

\`\`\`json
"logConfiguration": { "logDriver": "awslogs", "options": {
  "awslogs-group": "/ecs/shop-api", "awslogs-region": "us-east-1",
  "awslogs-stream-prefix": "api", "mode": "non-blocking", "max-buffer-size": "25m" } }
\`\`\`

- Streams are named \`<prefix>/<container-name>/<task-id>\`, so every log line traces back to one task. Always set a prefix.
- **Create the log group in IaC, with retention.** The \`awslogs-create-group\` option needs \`logs:CreateLogGroup\`, which the managed execution policy doesn't include, and the groups it creates never expire.
- \`mode: non-blocking\` buffers in memory so that a CloudWatch slowdown can't block your app's writes to stdout. The trade-off is that you can drop lines when the buffer fills. For most services, availability beats a complete log.
- Log **JSON**, one object per line. CloudWatch Logs Insights and metric filters can then query fields directly (module 10).
- For routing to other destinations (OpenSearch, S3, Datadog), use **FireLens**, a Fluent Bit sidecar configured through \`logConfiguration.logDriver: awsfirelens\`.

> **On real AWS vs the emulator:** the emulator validates task definitions like AWS does (Fargate CPU/memory pairs, \`awsvpc\` only, an execution role when secrets are used) and records them. It then really tries to pull the image when a task starts, so an image it can't reach fails exactly as it would in AWS.
`,
    },
    // ---------------------------------------------------------------- ECR + roles lab
    {
      id: "ecr-and-roles",
      kind: "lab",
      title: "Lab: A registry and least-privilege task roles",
      minutes: 30,
      body: String.raw`
You're setting up the **shop/api** service's supply chain and identities. Prepare lab has created:

- an SSM SecureString \`/shop/prod/db-password\` (the database password the service will receive), and
- an SQS queue \`shop-orders\` (the only AWS resource the app talks to).

A starter \`trust-policy.json\` is in the lab folder. It's deliberately incomplete.

Your goals: a hardened ECR repository, a cross-account pull grant for the staging account \`111122223333\`, and two separate, least-privilege roles. Checks use \`iam simulate-principal-policy\` to ask "would this role be allowed to …?", which is how you would unit-test IAM in a pipeline.
`,
      lab: {
        files: {
          "trust-policy.json": String.raw`
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "REPLACE-ME" },
      "Action": "sts:AssumeRole"
    }
  ]
}
`,
        },
        setup: String.raw`
aws ssm put-parameter --name /shop/prod/db-password --type SecureString --value 'change-me' --overwrite >/dev/null
aws sqs create-queue --queue-name shop-orders >/dev/null
echo "Prepared /shop/prod/db-password and the shop-orders queue."
`,
        tasks: [
          {
            id: "repo",
            title: "Create a hardened repository",
            description:
              "Create an ECR repository named `shop/api` with **immutable tags** and **scan on push** enabled.",
            hints: [
              "Both are flags of `aws ecr create-repository`: `--image-tag-mutability` and `--image-scanning-configuration`.",
              "If the repository already exists, use `aws ecr put-image-tag-mutability` and `aws ecr put-image-scanning-configuration` instead of recreating it.",
              "`aws ecr create-repository --repository-name shop/api --image-tag-mutability IMMUTABLE --image-scanning-configuration scanOnPush=true`",
            ],
            check: async ({ tryAws }) => {
              const r = await tryAws(["ecr", "describe-repositories", "--repository-names", "shop/api"]);
              if (!r.ok) return "Repository `shop/api` doesn't exist yet.";
              const repo = r.data.repositories[0];
              if (!String(repo.imageTagMutability).startsWith("IMMUTABLE"))
                return `Tag mutability is ${repo.imageTagMutability}; expected IMMUTABLE, so a release tag can never be re-pointed.`;
              if (!repo.imageScanningConfiguration?.scanOnPush) return "Scan on push is disabled.";
              return true;
            },
          },
          {
            id: "lifecycle",
            title: "Cap what the repository keeps",
            description: String.raw`Attach a lifecycle policy to \`shop/api\` with two rules:

1. expire **untagged** images **7 days** after they were pushed, and
2. keep at most **30** images of any tag status (expire the rest).

Mind the rule ordering.`,
            hints: [
              "Write the policy to a file (for example `lifecycle-policy.json`) and pass it with `--lifecycle-policy-text file://lifecycle-policy.json`.",
              "Rule 1: `selection: {tagStatus: untagged, countType: sinceImagePushed, countUnit: days, countNumber: 7}`. Rule 2: `{tagStatus: any, countType: imageCountMoreThan, countNumber: 30}`. Each has `action: {type: expire}`.",
              "The `tagStatus: any` rule must have the highest `rulePriority` (give it 2, and the untagged rule 1).",
            ],
            check: async ({ tryAws }) => {
              const r = await tryAws(["ecr", "get-lifecycle-policy", "--repository-name", "shop/api"]);
              if (!r.ok) return "No lifecycle policy on `shop/api` yet.";
              const rules: any[] = JSON.parse(r.data.lifecyclePolicyText).rules ?? [];
              const sel = (x: any) => x.selection ?? {};
              const untagged = rules.find(
                (x) => sel(x).tagStatus === "untagged" && sel(x).countType === "sinceImagePushed",
              );
              if (!untagged) return "No rule expires untagged images by age (`tagStatus: untagged`, `countType: sinceImagePushed`).";
              if (sel(untagged).countNumber !== 7 || sel(untagged).countUnit !== "days")
                return `The untagged rule expires after ${sel(untagged).countNumber} ${sel(untagged).countUnit}; expected 7 days.`;
              const cap = rules.find((x) => sel(x).tagStatus === "any" && sel(x).countType === "imageCountMoreThan");
              if (!cap) return "No rule caps the total image count (`tagStatus: any`, `countType: imageCountMoreThan`).";
              if (sel(cap).countNumber !== 30) return `The count rule keeps ${sel(cap).countNumber} images; expected 30.`;
              return true;
            },
          },
          {
            id: "cross-account",
            title: "Let staging pull, and only pull",
            description:
              "Add a repository policy to `shop/api` that lets the staging account **111122223333** pull images: `ecr:BatchGetImage`, `ecr:GetDownloadUrlForLayer` and `ecr:BatchCheckLayerAvailability`. It must **not** be able to push or delete.",
            hints: [
              "Repository policies are resource policies: they need a `Principal`. Use `{\"AWS\": \"arn:aws:iam::111122223333:root\"}` to delegate to the whole account.",
              "`aws ecr set-repository-policy --repository-name shop/api --policy-text file://repo-policy.json`",
              "Avoid `ecr:*`. It includes `ecr:PutImage`, `ecr:BatchDeleteImage` and the layer-upload actions.",
            ],
            check: async ({ tryAws }) => {
              const r = await tryAws(["ecr", "get-repository-policy", "--repository-name", "shop/api"]);
              if (!r.ok) return "`shop/api` has no repository policy yet.";
              const grants = statements(JSON.parse(r.data.policyText)).filter(
                (s) => s.Effect === "Allow" && (s.Principal === "*" || list(s.Principal?.AWS).some((p: string) => String(p).includes("111122223333"))),
              );
              if (!grants.length) return "No Allow statement names account 111122223333 as a principal.";
              const actions = grants.flatMap((s) => list(s.Action)) as string[];
              const allowed = (a: string) => actions.some((p) => globMatch(p, a));
              for (const need of ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"])
                if (!allowed(need)) return `The policy doesn't grant \`${need}\`, which a pull needs.`;
              for (const bad of ["ecr:PutImage", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:BatchDeleteImage", "ecr:DeleteRepository"])
                if (allowed(bad)) return `The policy also grants \`${bad}\`. Staging should only be able to pull.`;
              return true;
            },
          },
          {
            id: "execution-role",
            title: "Create the execution role",
            description: String.raw`Create the role \`shop-api-execution\` for the **ECS platform**:

- it trusts only \`ecs-tasks.amazonaws.com\` (fix \`trust-policy.json\`, ideally with an \`aws:SourceAccount\` condition),
- it has the AWS managed policy \`AmazonECSTaskExecutionRolePolicy\` attached, so it can pull from ECR and write logs, and
- it can read the secret \`/shop/prod/db-password\` (\`ssm:GetParameters\`) and **no other** parameters.`,
            hints: [
              "Set `\"Service\": \"ecs-tasks.amazonaws.com\"` in `trust-policy.json`, then `aws iam create-role --role-name shop-api-execution --assume-role-policy-document file://trust-policy.json`.",
              "The managed policy ARN is `arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy`.",
              "Add an inline policy with `aws iam put-role-policy` that allows `ssm:GetParameters` on `arn:aws:ssm:us-east-1:000000000000:parameter/shop/prod/db-password`.",
            ],
            check: async (ctx) => {
              const t = await ecsTrustProblem(ctx, "shop-api-execution");
              if (t) return t;
              const att = await ctx.aws(["iam", "list-attached-role-policies", "--role-name", "shop-api-execution"]);
              if (!att.AttachedPolicies.some((p: any) => p.PolicyName === "AmazonECSTaskExecutionRolePolicy"))
                return "`AmazonECSTaskExecutionRolePolicy` isn't attached, so the platform couldn't pull the image or write logs.";
              if ((await decision(ctx, "shop-api-execution", "ssm:GetParameters", PARAM_ARN)) !== "allowed")
                return "The role can't `ssm:GetParameters` on `/shop/prod/db-password`, so the task would fail with `ResourceInitializationError: unable to pull secrets`.";
              const other = `arn:aws:ssm:${REGION}:${ACCT}:parameter/payments/prod/stripe-key`;
              if ((await decision(ctx, "shop-api-execution", "ssm:GetParameters", other)) === "allowed")
                return "The role can read *other* teams' parameters too (try `/payments/prod/stripe-key`). Scope the Resource to the shop's parameter.";
              return true;
            },
          },
          {
            id: "task-role",
            title: "Create the task role",
            description: String.raw`Create the role \`shop-api-task\` for the **application code**. It trusts only \`ecs-tasks.amazonaws.com\` and can do exactly one thing: \`sqs:SendMessage\` to the \`shop-orders\` queue.

It must **not** be able to read the database secret (the platform injects it), pull images, or delete the queue.`,
            hints: [
              "Reuse the fixed `trust-policy.json`.",
              "Inline policy: `{\"Effect\":\"Allow\",\"Action\":\"sqs:SendMessage\",\"Resource\":\"arn:aws:sqs:us-east-1:000000000000:shop-orders\"}`.",
              "Don't attach `AmazonECSTaskExecutionRolePolicy` here. Check yourself with `aws iam simulate-principal-policy --policy-source-arn arn:aws:iam::000000000000:role/shop-api-task --action-names sqs:SendMessage sqs:DeleteQueue ecr:GetAuthorizationToken`.",
            ],
            check: async (ctx) => {
              const t = await ecsTrustProblem(ctx, "shop-api-task");
              if (t) return t;
              if ((await decision(ctx, "shop-api-task", "sqs:SendMessage", QUEUE_ARN)) !== "allowed")
                return "The task role can't `sqs:SendMessage` to `shop-orders`.";
              if ((await decision(ctx, "shop-api-task", "sqs:DeleteQueue", QUEUE_ARN)) === "allowed")
                return "The task role can delete the queue. Grant only `sqs:SendMessage`.";
              if ((await decision(ctx, "shop-api-task", "ssm:GetParameters", PARAM_ARN)) === "allowed")
                return "The task role can read the database secret. Only the execution role needs that.";
              if ((await decision(ctx, "shop-api-task", "ecr:GetAuthorizationToken")) === "allowed")
                return "The task role has ECR permissions. That looks like the execution policy attached to the wrong role.";
              return true;
            },
          },
        ],
        solution: String.raw`
aws ecr create-repository --repository-name shop/api \
  --image-tag-mutability IMMUTABLE --image-scanning-configuration scanOnPush=true

cat > lifecycle-policy.json <<'EOF'
{ "rules": [
  { "rulePriority": 1, "description": "Expire untagged images after 7 days",
    "selection": { "tagStatus": "untagged", "countType": "sinceImagePushed", "countUnit": "days", "countNumber": 7 },
    "action": { "type": "expire" } },
  { "rulePriority": 2, "description": "Keep at most 30 images",
    "selection": { "tagStatus": "any", "countType": "imageCountMoreThan", "countNumber": 30 },
    "action": { "type": "expire" } } ] }
EOF
aws ecr put-lifecycle-policy --repository-name shop/api --lifecycle-policy-text file://lifecycle-policy.json

cat > repo-policy.json <<'EOF'
{ "Version": "2012-10-17",
  "Statement": [{ "Sid": "StagingPull", "Effect": "Allow",
    "Principal": { "AWS": "arn:aws:iam::111122223333:root" },
    "Action": ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"] }] }
EOF
aws ecr set-repository-policy --repository-name shop/api --policy-text file://repo-policy.json

cat > trust-policy.json <<'EOF'
{ "Version": "2012-10-17",
  "Statement": [{ "Effect": "Allow",
    "Principal": { "Service": "ecs-tasks.amazonaws.com" },
    "Action": "sts:AssumeRole",
    "Condition": { "StringEquals": { "aws:SourceAccount": "000000000000" } } }] }
EOF
aws iam create-role --role-name shop-api-execution --assume-role-policy-document file://trust-policy.json
aws iam attach-role-policy --role-name shop-api-execution \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
aws iam put-role-policy --role-name shop-api-execution --policy-name read-db-secret --policy-document \
  '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"ssm:GetParameters","Resource":"arn:aws:ssm:us-east-1:000000000000:parameter/shop/prod/db-password"}]}'

aws iam create-role --role-name shop-api-task --assume-role-policy-document file://trust-policy.json
aws iam put-role-policy --role-name shop-api-task --policy-name send-orders --policy-document \
  '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"sqs:SendMessage","Resource":"arn:aws:sqs:us-east-1:000000000000:shop-orders"}]}'
`,
      },
    },
    // ---------------------------------------------------------------- capacity, networking, deployments
    {
      id: "ecs-runtime",
      kind: "reading",
      title: "Capacity, networking and deployments",
      minutes: 18,
      body: String.raw`
## Fargate vs EC2 capacity

A cluster gets compute from **capacity providers**. A service's **capacity provider strategy** says how to split tasks across them: \`base\` tasks go to the first provider, and the rest are split by \`weight\`.

| | Fargate / Fargate Spot | EC2 (Auto Scaling group capacity provider) |
|---|---|---|
| You manage | Nothing below the task | AMIs, patching, the ECS agent, instance sizing, draining |
| Billing | Per task vCPU-second and GB-second | Per instance, whether it's full or empty |
| Isolation | Each task in its own micro-VM | Tasks share a kernel |
| Limits | No privileged containers, no host networking or daemons, ephemeral storage 20–200 GB | GPUs, any instance type, daemon tasks, local NVMe |
| Scaling | Task start ~30–60 s | Tasks wait for instances when the cluster is full (managed scaling grows the ASG) |
| Cost sweet spot | Spiky or small workloads; teams without platform engineers | Large, steady fleets at high bin-packing utilisation |

**Fargate Spot** runs on spare capacity at up to 70% off, with a two-minute SIGTERM warning before reclaim. A common production strategy is \`FARGATE base=2 weight=1\` plus \`FARGATE_SPOT weight=3\`: the first two tasks are always on-demand, and three of every four extra tasks are Spot. Only do this for stateless services that handle SIGTERM.

For EC2 capacity providers, enable **managed scaling** (ECS grows and shrinks the ASG to a target utilisation) and **managed termination protection** (ECS won't let the ASG kill an instance that still runs tasks). AWS also offers **ECS Managed Instances**, where AWS runs and patches the EC2 fleet for you, a middle ground between the two columns.

## awsvpc networking

With the \`awsvpc\` network mode (required on Fargate, recommended on EC2), **every task gets its own elastic network interface**: its own private IP in your subnet, and **its own security groups**. That changes how you design networks:

- Security groups are per *service*, not per host. The task SG for \`shop-api\` allows port 8080 **from the ALB's security group** (a source-group reference, not a CIDR), and nothing else.
- Target groups must use **\`target-type ip\`**, because targets are task IPs, not instances.
- Every task consumes an IP. A /24 subnet holds ~250 tasks. Size task subnets generously (/20 or larger) and spread them across at least two AZs.
- Tasks in private subnets need a route to ECR, CloudWatch Logs and SSM/Secrets Manager: a NAT gateway or VPC endpoints. "Task stuck in PROVISIONING, then \`ResourceInitializationError\`" is usually this.
- On EC2 instances, ENIs per instance are limited (an m5.large supports 3). Enable **ENI trunking** (\`awsvpcTrunking\`) to raise task density.

## The ALB integration

A service with \`loadBalancers\` registers each task's IP and port in a target group when the task starts, and **deregisters it before stopping it**. Three timers decide whether deployments drop requests:

| Setting | Default | What to do |
|---|---|---|
| \`healthCheckGracePeriodSeconds\` (service) | 0 | Set it longer than your app's startup (JVMs: 60–120 s). Otherwise ECS kills tasks that fail health checks while still warming up, and deploys loop |
| \`deregistration_delay.timeout_seconds\` (target group) | 300 s | The ALB stops sending *new* requests and waits this long for in-flight ones. 300 s makes every deploy five minutes slower; 30 s suits most APIs |
| \`stopTimeout\` (container) | 30 s | Time between SIGTERM and SIGKILL. Must cover draining your longest request |

## Rolling deployments

Updating a service's task definition starts a **deployment**. With the default rolling controller, two percentages of \`desiredCount\` bound it:

- **\`minimumHealthyPercent\`**: the floor of healthy tasks that must keep running during the deployment.
- **\`maximumPercent\`**: the ceiling of total tasks (old + new) allowed to exist.

| desired | min% | max% | What happens | Trade-off |
|---|---|---|---|---|
| 4 | 100 | 200 | Starts 4 new, waits for healthy, then stops 4 old | Full capacity throughout; needs 2× capacity briefly |
| 4 | 50 | 100 | Stops 2 old, starts 2 new, repeats | No extra capacity; runs at half capacity during deploys |
| 4 | 100 | 125 | Replaces one task at a time | Slow but gentle; good for EC2 clusters with little headroom |
| 4 | 100 | 100 | **Nothing can happen**: it can't stop old tasks or start new ones | A stuck deployment. Classic misconfiguration |
| 1 | 0 | 100 | Stops the only task, then starts the new one | Downtime on every deploy |

## The deployment circuit breaker

Without protection, a broken image means ECS retries forever: tasks start, crash, get replaced, crash again, and the service sits at reduced capacity while it burns money and pages nobody. The **deployment circuit breaker** watches a deployment. If tasks keep failing to reach RUNNING or failing health checks (the threshold scales with \`desiredCount\`: 50% of it, at least 3 and at most 200 failed tasks), it marks the deployment **FAILED**. With \`rollback=true\` it then redeploys the **last deployment that completed**.

\`\`\`text
--deployment-configuration "deploymentCircuitBreaker={enable=true,rollback=true},minimumHealthyPercent=100,maximumPercent=200"
\`\`\`

The breaker only sees task health. Add **CloudWatch alarm rollback** (\`deploymentConfiguration.alarms\`) to roll back on *application* signals too, such as 5xx rate or p99 latency during the bake period. A deployment that starts fine but returns 500s is invisible to the circuit breaker. Wire the \`SERVICE_DEPLOYMENT_FAILED\` event (from EventBridge) to your chat channel: a rollback that nobody notices means the bad commit stays on main.

Note that a service's *first* deployment has nothing to roll back to. It just stays FAILED, which you will see in the next lab.

## Blue/green

Rolling deployments mix old and new versions behind one target group for a while. **Blue/green** stands up the full new version (green) next to the old (blue), tests it, then shifts traffic between two target groups:

- The classic implementation is **CodeDeploy** (\`deploymentController type=CODE_DEPLOY\`): a production listener, an optional test listener, traffic shifting (\`AllAtOnce\`, \`Canary10Percent5Minutes\`, \`Linear10PercentEvery1Minute\`), Lambda lifecycle hooks to run smoke tests, and alarm-based automatic rollback. Instant rollback is just moving the listener back while blue is still up.
- ECS now also supports **blue/green natively** in the ECS deployment controller (\`strategy: BLUE_GREEN\`, with a bake time and lifecycle hooks), with no CodeDeploy application to manage. Prefer it for new services.

Choose blue/green when mixed versions are unacceptable (schema changes, session-format changes) or when you need a test listener before production traffic moves. Rolling plus the circuit breaker and alarms is enough for most stateless services.

## Service auto scaling

ECS services scale through **Application Auto Scaling**: you register the service's \`DesiredCount\` as a scalable target with bounds, and attach policies.

\`\`\`text
aws application-autoscaling register-scalable-target --service-namespace ecs \
  --resource-id service/shop/shop-api --scalable-dimension ecs:service:DesiredCount --min-capacity 2 --max-capacity 6
aws application-autoscaling put-scaling-policy ... --policy-type TargetTrackingScaling \
  --target-tracking-scaling-policy-configuration '{"TargetValue":60,"PredefinedMetricSpecification":{"PredefinedMetricType":"ECSServiceAverageCPUUtilization"}}'
\`\`\`

- **Target tracking** is the default choice: "keep average CPU at 60%". It creates and owns the CloudWatch alarms. For request-driven APIs, \`ALBRequestCountPerTarget\` tracks load better than CPU.
- **Step scaling** gives explicit thresholds; **scheduled scaling** pre-warms for known peaks. Queue workers should scale on *backlog per task* (queue depth ÷ running tasks), not CPU.
- **min capacity ≥ 2**, spread across AZs. A single task means an AZ outage or a deployment takes you down.
- Scale-out should be fast and scale-in slow (the default cooldowns already lean this way).
- **IaC drift:** auto scaling changes \`desiredCount\`, and your next \`terraform apply\` resets it. Use \`lifecycle { ignore_changes = [desired_count] }\`.

Try the validation fidelity, which needs no other resources:

\`\`\`bash
cat > bad-td.json <<'EOF'
{ "family": "demo-bad", "networkMode": "awsvpc", "requiresCompatibilities": ["FARGATE"],
  "cpu": "256", "memory": "4096",
  "containerDefinitions": [{ "name": "app", "image": "busybox", "essential": true }] }
EOF
aws ecs register-task-definition --cli-input-json file://bad-td.json
\`\`\`

> **On real AWS vs the emulator:** ECS services here really schedule tasks, attach ENIs with private IPs, try to pull the image, and run the circuit breaker. Because the image pull is real, the emulator can't bring an unpullable task to RUNNING, so the lab focuses on wiring and on diagnosing a failed deployment. Avoid \`aws ecs wait services-stable\` on a deployment that can't succeed: it waits until it times out.
`,
    },
    // ---------------------------------------------------------------- Fargate service lab
    {
      id: "fargate-service",
      kind: "lab",
      title: "Lab: A Fargate service with guardrails",
      minutes: 40,
      body: String.raw`
Time to run \`shop/api\` on Fargate behind an ALB. Prepare lab has created:

- the roles \`shop-api-execution\` and \`shop-api-task\` (as in the previous lab), the SSM parameter \`/shop/prod/db-password\`, the \`shop-orders\` queue and the \`shop/api\` ECR repository;
- a VPC with public and private subnets in two AZs, an internet-facing ALB \`shop-alb\` (listener on :80), and a target group \`shop-api-tg\` (\`target-type ip\`, port 8080, 30 s deregistration delay);
- two security groups: \`shop-alb\` (open on :80) and \`shop-api-tasks\` (no ingress yet);
- \`lab.env\`, which exports \`SUBNET_A\`, \`SUBNET_B\`, \`ALB_SG\`, \`TASK_SG\` and \`TG_ARN\`. Run \`source lab.env\` first;
- a starter \`taskdef.json\` with the gaps you need to fill.

There is a twist. The release pipeline was meant to push \`shop/api:1.0.0\`, but it never did. You will deploy anyway, see the circuit breaker stop the deployment, and find out why from the API, the way you would during an incident.
`,
      lab: {
        files: {
          "taskdef.json": String.raw`
{
  "family": "shop-api",
  "requiresCompatibilities": ["FARGATE"],
  "networkMode": "awsvpc",
  "cpu": "256",
  "memory": "512",
  "runtimePlatform": { "cpuArchitecture": "X86_64", "operatingSystemFamily": "LINUX" },
  "executionRoleArn": "TODO",
  "taskRoleArn": "TODO",
  "containerDefinitions": [
    {
      "name": "api",
      "image": "000000000000.dkr.ecr.us-east-1.amazonaws.com/shop/api:1.0.0",
      "essential": true,
      "stopTimeout": 30,
      "portMappings": [{ "containerPort": 8080, "protocol": "tcp" }],
      "environment": [
        { "name": "QUEUE_URL", "value": "https://sqs.us-east-1.amazonaws.com/000000000000/shop-orders" }
      ],
      "secrets": []
    }
  ]
}
`,
        },
        setup: FARGATE_SETUP,
        tasks: [
          {
            id: "log-group",
            title: "Create the log group, with retention",
            description: "Create the CloudWatch Logs group `/ecs/shop-api` with a **30-day** retention.",
            hints: [
              "`aws logs create-log-group --log-group-name /ecs/shop-api`",
              "`aws logs put-retention-policy --log-group-name /ecs/shop-api --retention-in-days 30`",
            ],
            check: async ({ tryAws }) => {
              const r = await tryAws(["logs", "describe-log-groups", "--log-group-name-prefix", "/ecs/shop-api"]);
              const g = r.data?.logGroups?.find((x: any) => x.logGroupName === "/ecs/shop-api");
              if (!g) return "Log group `/ecs/shop-api` doesn't exist yet.";
              if (g.retentionInDays !== 30) return `Retention is ${g.retentionInDays ?? "never expire"}; expected 30 days.`;
              return true;
            },
          },
          {
            id: "taskdef",
            title: "Register the task definition",
            description: String.raw`Complete \`taskdef.json\` and register it (family \`shop-api\`):

- \`executionRoleArn\` is \`shop-api-execution\`, and \`taskRoleArn\` is \`shop-api-task\` (don't swap them);
- the \`api\` container injects \`DB_PASSWORD\` from \`/shop/prod/db-password\` through **\`secrets\`** (never \`environment\`);
- logs go through the **awslogs** driver to \`/ecs/shop-api\` in \`us-east-1\`, with stream prefix \`api\`.

Keep the image \`000000000000.dkr.ecr.us-east-1.amazonaws.com/shop/api:1.0.0\`, port 8080, 256 CPU / 512 MB.`,
            hints: [
              "Role ARNs look like `arn:aws:iam::000000000000:role/shop-api-execution`.",
              "`\"secrets\": [{\"name\": \"DB_PASSWORD\", \"valueFrom\": \"arn:aws:ssm:us-east-1:000000000000:parameter/shop/prod/db-password\"}]`",
              "`\"logConfiguration\": {\"logDriver\": \"awslogs\", \"options\": {\"awslogs-group\": \"/ecs/shop-api\", \"awslogs-region\": \"us-east-1\", \"awslogs-stream-prefix\": \"api\"}}`, then `aws ecs register-task-definition --cli-input-json file://taskdef.json`.",
            ],
            check: async ({ tryAws }) => {
              const r = await tryAws(["ecs", "describe-task-definition", "--task-definition", "shop-api"]);
              if (!r.ok) return "No `shop-api` task definition registered yet.";
              const td = r.data.taskDefinition;
              const exec = String(td.executionRoleArn ?? "");
              const task = String(td.taskRoleArn ?? "");
              if (exec.endsWith("role/shop-api-task") && task.endsWith("role/shop-api-execution"))
                return "The roles are swapped: the *platform* uses the execution role, your *code* uses the task role.";
              if (!exec.endsWith("role/shop-api-execution")) return `executionRoleArn is \`${exec || "unset"}\`; expected the \`shop-api-execution\` role.`;
              if (!task.endsWith("role/shop-api-task")) return `taskRoleArn is \`${task || "unset"}\`; expected the \`shop-api-task\` role.`;
              if (td.networkMode !== "awsvpc" || !list(td.requiresCompatibilities).includes("FARGATE"))
                return "The task definition must be Fargate-compatible with networkMode awsvpc.";
              const c = (td.containerDefinitions ?? []).find((x: any) => x.name === "api");
              if (!c) return "No container named `api`.";
              if (c.image !== IMAGE) return `The image is \`${c.image}\`; keep \`${IMAGE}\` for this lab.`;
              if (!(c.portMappings ?? []).some((p: any) => p.containerPort === 8080)) return "The `api` container should expose port 8080.";
              if ((c.environment ?? []).some((e: any) => e.name === "DB_PASSWORD"))
                return "`DB_PASSWORD` is in `environment`, so anyone who can describe the task definition can read it. Move it to `secrets`.";
              const s = (c.secrets ?? []).find((x: any) => x.name === "DB_PASSWORD");
              if (!s) return "No `DB_PASSWORD` entry in the container's `secrets`.";
              if (!String(s.valueFrom).endsWith("parameter/shop/prod/db-password") && s.valueFrom !== "/shop/prod/db-password")
                return `DB_PASSWORD comes from \`${s.valueFrom}\`; expected the \`/shop/prod/db-password\` parameter.`;
              const lc = c.logConfiguration;
              if (lc?.logDriver !== "awslogs") return "The `api` container has no awslogs log configuration.";
              const o = lc.options ?? {};
              if (o["awslogs-group"] !== "/ecs/shop-api") return `awslogs-group is \`${o["awslogs-group"]}\`; expected /ecs/shop-api.`;
              if (o["awslogs-region"] !== "us-east-1") return "Set `awslogs-region` to us-east-1.";
              if (o["awslogs-stream-prefix"] !== "api") return "Set `awslogs-stream-prefix` to `api`, so each stream maps to a task.";
              return true;
            },
          },
          {
            id: "cluster",
            title: "Create the cluster",
            description:
              "Create the ECS cluster `shop` with the **FARGATE** and **FARGATE_SPOT** capacity providers and **Container Insights** enabled.",
            hints: [
              "`aws ecs create-cluster --cluster-name shop --capacity-providers FARGATE FARGATE_SPOT ...`",
              "Container Insights is a cluster setting: `--settings name=containerInsights,value=enabled`.",
            ],
            check: async ({ tryAws }) => {
              const r = await tryAws(["ecs", "describe-clusters", "--clusters", "shop", "--include", "SETTINGS"]);
              const c = r.data?.clusters?.find((x: any) => x.clusterName === "shop" && x.status === "ACTIVE");
              if (!c) return "Cluster `shop` doesn't exist yet.";
              const cps = c.capacityProviders ?? [];
              if (!cps.includes("FARGATE") || !cps.includes("FARGATE_SPOT"))
                return `Capacity providers are [${cps.join(", ")}]; expected FARGATE and FARGATE_SPOT.`;
              const ci = (c.settings ?? []).find((s: any) => s.name === "containerInsights")?.value;
              if (ci !== "enabled" && ci !== "enhanced") return "Container Insights isn't enabled.";
              return true;
            },
          },
          {
            id: "network",
            title: "Let only the ALB reach the tasks",
            description:
              "Allow inbound TCP **8080** on the `shop-api-tasks` security group **from the `shop-alb` security group** (a source-group rule, not a CIDR). Nothing else may reach the tasks.",
            hints: [
              "`aws ec2 authorize-security-group-ingress --group-id $TASK_SG --protocol tcp --port 8080 --source-group $ALB_SG`",
            ],
            check: async (ctx) => {
              const task = await sgId(ctx, "shop-api-tasks");
              const alb = await sgId(ctx, "shop-alb");
              if (!task || !alb) return "The lab security groups are missing. Press Prepare lab again.";
              const g = (await ctx.aws(["ec2", "describe-security-groups", "--group-ids", task])).SecurityGroups[0];
              const perms: any[] = g.IpPermissions ?? [];
              if (perms.some((p) => (p.IpRanges ?? []).length || (p.Ipv6Ranges ?? []).length))
                return "`shop-api-tasks` allows traffic from a CIDR range. Tasks should only be reachable from the ALB's security group.";
              const ok = perms.some(
                (p) => p.IpProtocol === "tcp" && p.FromPort <= 8080 && p.ToPort >= 8080 && (p.UserIdGroupPairs ?? []).some((u: any) => u.GroupId === alb),
              );
              if (!ok) return "No rule allows TCP 8080 from the `shop-alb` security group.";
              return true;
            },
          },
          {
            id: "service",
            title: "Create the service with a circuit breaker",
            description: String.raw`Create the service \`shop-api\` in cluster \`shop\`:

- the latest \`shop-api\` task definition, **2** tasks, on Fargate;
- in the two **private** subnets (\`SUBNET_A\`, \`SUBNET_B\`) with the \`shop-api-tasks\` security group and **no public IP**;
- registered in \`shop-api-tg\` as container \`api\`, port 8080, with a **60 s** health-check grace period;
- rolling deployments with **minimumHealthyPercent 100 / maximumPercent 200**, and the **deployment circuit breaker enabled with rollback**.`,
            hints: [
              "`source lab.env` first. Network: `--network-configuration \"awsvpcConfiguration={subnets=[$SUBNET_A,$SUBNET_B],securityGroups=[$TASK_SG],assignPublicIp=DISABLED}\"`.",
              "Load balancer: `--load-balancers \"targetGroupArn=$TG_ARN,containerName=api,containerPort=8080\" --health-check-grace-period-seconds 60`.",
              "`--deployment-configuration \"deploymentCircuitBreaker={enable=true,rollback=true},minimumHealthyPercent=100,maximumPercent=200\"`, plus `--launch-type FARGATE` (or a FARGATE capacity provider strategy) and `--desired-count 2`.",
            ],
            check: async (ctx) => {
              const r = await ctx.tryAws(["ecs", "describe-services", "--cluster", "shop", "--services", "shop-api"]);
              if (!r.ok) return "Cluster `shop` doesn't exist yet.";
              const s = r.data.services?.find((x: any) => x.status === "ACTIVE");
              if (!s) return "Service `shop-api` doesn't exist in cluster `shop` yet.";
              if (!String(s.taskDefinition).includes("task-definition/shop-api:")) return "The service doesn't use the `shop-api` task definition.";
              if (s.desiredCount !== 2) return `desiredCount is ${s.desiredCount}; expected 2.`;
              const fargate =
                s.launchType === "FARGATE" || (s.capacityProviderStrategy ?? []).some((c: any) => String(c.capacityProvider).startsWith("FARGATE"));
              if (!fargate) return "The service should run on Fargate (launch type or capacity provider strategy).";
              const net = s.networkConfiguration?.awsvpcConfiguration ?? {};
              const subs = await ctx.aws(["ec2", "describe-subnets", "--filters", "Name=tag:Name,Values=shop-private-a,shop-private-b"]);
              const priv = (subs.Subnets ?? []).map((x: any) => x.SubnetId).sort();
              if (JSON.stringify([...(net.subnets ?? [])].sort()) !== JSON.stringify(priv))
                return "The service should use exactly the two private subnets (`SUBNET_A` and `SUBNET_B` from lab.env).";
              const task = await sgId(ctx, "shop-api-tasks");
              if (JSON.stringify(net.securityGroups ?? []) !== JSON.stringify([task])) return "The service should use only the `shop-api-tasks` security group.";
              if (net.assignPublicIp === "ENABLED") return "Tasks in private subnets must not get public IPs.";
              const tg = (await ctx.aws(["elbv2", "describe-target-groups", "--names", "shop-api-tg"])).TargetGroups[0].TargetGroupArn;
              const lb = (s.loadBalancers ?? []).find((l: any) => l.targetGroupArn === tg);
              if (!lb) return "The service isn't registered with the `shop-api-tg` target group.";
              if (lb.containerName !== "api" || lb.containerPort !== 8080) return "Register container `api` on port 8080 with the target group.";
              if ((s.healthCheckGracePeriodSeconds ?? 0) < 60) return `The health-check grace period is ${s.healthCheckGracePeriodSeconds ?? 0}s; expected 60.`;
              const dc = s.deploymentConfiguration ?? {};
              if (dc.minimumHealthyPercent !== 100 || dc.maximumPercent !== 200)
                return `Deployment bounds are min ${dc.minimumHealthyPercent}% / max ${dc.maximumPercent}%; expected 100 / 200.`;
              if (!dc.deploymentCircuitBreaker?.enable) return "The deployment circuit breaker isn't enabled.";
              if (!dc.deploymentCircuitBreaker?.rollback) return "The circuit breaker is on, but rollback is off.";
              return true;
            },
          },
          {
            id: "autoscaling",
            title: "Scale between 2 and 6 tasks on CPU",
            description:
              "Register `shop-api`'s desired count with Application Auto Scaling (**min 2, max 6**) and add a **target-tracking** policy that keeps average service CPU at **60%**.",
            hints: [
              "The resource ID is `service/shop/shop-api` and the dimension is `ecs:service:DesiredCount`.",
              "`aws application-autoscaling register-scalable-target --service-namespace ecs --resource-id service/shop/shop-api --scalable-dimension ecs:service:DesiredCount --min-capacity 2 --max-capacity 6`",
              "`aws application-autoscaling put-scaling-policy --service-namespace ecs --resource-id service/shop/shop-api --scalable-dimension ecs:service:DesiredCount --policy-name cpu60 --policy-type TargetTrackingScaling --target-tracking-scaling-policy-configuration '{\"TargetValue\":60,\"PredefinedMetricSpecification\":{\"PredefinedMetricType\":\"ECSServiceAverageCPUUtilization\"}}'`",
            ],
            check: async ({ tryAws }) => {
              const base = ["--service-namespace", "ecs", "--resource-id", "service/shop/shop-api"];
              const t = await tryAws(["application-autoscaling", "describe-scalable-targets", "--service-namespace", "ecs", "--resource-ids", "service/shop/shop-api"]);
              const target = t.data?.ScalableTargets?.[0];
              if (!target) return "`service/shop/shop-api` isn't registered as a scalable target yet.";
              if (target.MinCapacity !== 2 || target.MaxCapacity !== 6)
                return `Capacity bounds are ${target.MinCapacity}–${target.MaxCapacity}; expected 2–6.`;
              const p = await tryAws(["application-autoscaling", "describe-scaling-policies", ...base]);
              const tt = (p.data?.ScalingPolicies ?? []).find(
                (x: any) =>
                  x.PolicyType === "TargetTrackingScaling" &&
                  x.TargetTrackingScalingPolicyConfiguration?.PredefinedMetricSpecification?.PredefinedMetricType === "ECSServiceAverageCPUUtilization",
              );
              if (!tt) return "No target-tracking policy on ECSServiceAverageCPUUtilization yet.";
              if (tt.TargetTrackingScalingPolicyConfiguration.TargetValue !== 60)
                return `The policy targets ${tt.TargetTrackingScalingPolicyConfiguration.TargetValue}% CPU; expected 60.`;
              return true;
            },
          },
          {
            id: "diagnose",
            title: "Diagnose the failed deployment",
            description: String.raw`Watch the service's deployment until the circuit breaker marks it **FAILED** (\`rolloutState\`). Then find out *why* the tasks died: write the \`stoppedReason\` of one of the service's stopped tasks into \`failure.txt\`.`,
            hints: [
              "`aws ecs describe-services --cluster shop --services shop-api --query 'services[0].deployments[].{state: rolloutState, failed: failedTasks, reason: rolloutStateReason}'`. Give it up to a minute.",
              "Stopped tasks stay visible for a while: `aws ecs list-tasks --cluster shop --service-name shop-api --desired-status STOPPED`.",
              "`aws ecs describe-tasks --cluster shop --tasks <arn> --query 'tasks[0].stoppedReason' --output text > failure.txt`",
            ],
            check: async ({ tryAws, aws, readFile }) => {
              const r = await tryAws(["ecs", "describe-services", "--cluster", "shop", "--services", "shop-api"]);
              const s = r.data?.services?.find((x: any) => x.status === "ACTIVE");
              if (!s) return "Service `shop-api` doesn't exist yet.";
              const states = (s.deployments ?? []).map((d: any) => d.rolloutState);
              if (!states.includes("FAILED"))
                return `No deployment has failed yet (rolloutState: ${states.join(", ") || "none"}). The circuit breaker needs a few failed tasks; check again shortly.`;
              const f = await readFile("failure.txt");
              if (f === null) return "`failure.txt` not found in the lab folder.";
              const got = f.trim();
              if (/CannotPullContainerError/i.test(got)) return true;
              const stopped = await aws(["ecs", "list-tasks", "--cluster", "shop", "--service-name", "shop-api", "--desired-status", "STOPPED"]);
              if (stopped.taskArns?.length) {
                const d = await aws(["ecs", "describe-tasks", "--cluster", "shop", "--tasks", ...stopped.taskArns.slice(0, 100)]);
                if ((d.tasks ?? []).some((t: any) => t.stoppedReason && got === String(t.stoppedReason).trim())) return true;
              }
              return "`failure.txt` doesn't contain a stopped task's `stoppedReason`. Look at `describe-tasks` for a STOPPED task.";
            },
          },
        ],
        solution: String.raw`
source lab.env
aws logs create-log-group --log-group-name /ecs/shop-api
aws logs put-retention-policy --log-group-name /ecs/shop-api --retention-in-days 30

cat > taskdef.json <<'EOF'
{
  "family": "shop-api",
  "requiresCompatibilities": ["FARGATE"],
  "networkMode": "awsvpc",
  "cpu": "256",
  "memory": "512",
  "runtimePlatform": { "cpuArchitecture": "X86_64", "operatingSystemFamily": "LINUX" },
  "executionRoleArn": "arn:aws:iam::000000000000:role/shop-api-execution",
  "taskRoleArn": "arn:aws:iam::000000000000:role/shop-api-task",
  "containerDefinitions": [{
    "name": "api",
    "image": "000000000000.dkr.ecr.us-east-1.amazonaws.com/shop/api:1.0.0",
    "essential": true,
    "stopTimeout": 30,
    "portMappings": [{ "containerPort": 8080, "protocol": "tcp" }],
    "environment": [{ "name": "QUEUE_URL", "value": "https://sqs.us-east-1.amazonaws.com/000000000000/shop-orders" }],
    "secrets": [{ "name": "DB_PASSWORD", "valueFrom": "arn:aws:ssm:us-east-1:000000000000:parameter/shop/prod/db-password" }],
    "logConfiguration": { "logDriver": "awslogs", "options": {
      "awslogs-group": "/ecs/shop-api", "awslogs-region": "us-east-1", "awslogs-stream-prefix": "api", "mode": "non-blocking" } }
  }]
}
EOF
aws ecs register-task-definition --cli-input-json file://taskdef.json --query taskDefinition.taskDefinitionArn

aws ecs create-cluster --cluster-name shop --capacity-providers FARGATE FARGATE_SPOT \
  --default-capacity-provider-strategy capacityProvider=FARGATE,weight=1,base=1 \
  --settings name=containerInsights,value=enabled >/dev/null

aws ec2 authorize-security-group-ingress --group-id "$TASK_SG" --protocol tcp --port 8080 --source-group "$ALB_SG" >/dev/null

aws ecs create-service --cluster shop --service-name shop-api --task-definition shop-api --desired-count 2 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNET_A,$SUBNET_B],securityGroups=[$TASK_SG],assignPublicIp=DISABLED}" \
  --load-balancers "targetGroupArn=$TG_ARN,containerName=api,containerPort=8080" \
  --health-check-grace-period-seconds 60 \
  --deployment-configuration "deploymentCircuitBreaker={enable=true,rollback=true},minimumHealthyPercent=100,maximumPercent=200" \
  --query 'service.serviceArn'

aws application-autoscaling register-scalable-target --service-namespace ecs --resource-id service/shop/shop-api \
  --scalable-dimension ecs:service:DesiredCount --min-capacity 2 --max-capacity 6 >/dev/null
aws application-autoscaling put-scaling-policy --service-namespace ecs --resource-id service/shop/shop-api \
  --scalable-dimension ecs:service:DesiredCount --policy-name cpu60 --policy-type TargetTrackingScaling \
  --target-tracking-scaling-policy-configuration '{"TargetValue":60,"PredefinedMetricSpecification":{"PredefinedMetricType":"ECSServiceAverageCPUUtilization"}}' >/dev/null

# The circuit breaker is asynchronous: poll the rollout state (with a timeout) instead of using services-stable.
STATE=""
for _ in $(seq 1 90); do
  STATE=$(aws ecs describe-services --cluster shop --services shop-api --query 'services[0].deployments[0].rolloutState' --output text)
  [ "$STATE" = FAILED ] && break
  sleep 2
done
echo "rolloutState=$STATE"
[ "$STATE" = FAILED ]
TASK=$(aws ecs list-tasks --cluster shop --service-name shop-api --desired-status STOPPED --query 'taskArns[0]' --output text)
aws ecs describe-tasks --cluster shop --tasks "$TASK" --query 'tasks[0].stoppedReason' --output text > failure.txt
cat failure.txt
`,
      },
    },
    // ---------------------------------------------------------------- EKS
    {
      id: "eks",
      kind: "reading",
      title: "EKS for operators, and ECS vs EKS",
      minutes: 16,
      body: String.raw`
**Amazon EKS** runs upstream Kubernetes. AWS operates the **control plane**: API servers and etcd, spread across three AZs, patched and backed up, for $0.10 per cluster-hour. You operate everything else: the **data plane** (where pods run), add-ons, upgrades, and the Kubernetes objects themselves.

<figure class="diagram">
<svg viewBox="0 0 640 260" role="img" aria-label="The EKS control plane runs in an AWS-managed VPC and reaches worker nodes in your VPC through cross-account ENIs">
  <rect x="10" y="20" width="200" height="220" rx="10" class="d-box d-dim"/>
  <text x="26" y="44" class="d-label">AWS-managed VPC</text>
  <rect x="30" y="60" width="160" height="60" rx="8" class="d-box d-accent"/>
  <text x="110" y="86" text-anchor="middle" class="d-label">API servers</text>
  <text x="110" y="104" text-anchor="middle" class="d-small">multi-AZ, managed</text>
  <rect x="30" y="140" width="160" height="60" rx="8" class="d-box d-accent"/>
  <text x="110" y="166" text-anchor="middle" class="d-label">etcd</text>
  <text x="110" y="184" text-anchor="middle" class="d-small">encrypted, backed up</text>
  <rect x="250" y="20" width="380" height="220" rx="10" class="d-box d-outer"/>
  <text x="266" y="44" class="d-label">Your VPC (subnets in 2+ AZs)</text>
  <rect x="270" y="62" width="110" height="40" rx="6" class="d-box"/>
  <text x="325" y="87" text-anchor="middle" class="d-small">control-plane ENIs</text>
  <rect x="400" y="62" width="210" height="80" rx="8" class="d-box d-ok"/>
  <text x="505" y="86" text-anchor="middle" class="d-label">Nodes</text>
  <text x="505" y="104" text-anchor="middle" class="d-small">managed node groups /</text>
  <text x="505" y="120" text-anchor="middle" class="d-small">Karpenter / Fargate</text>
  <rect x="400" y="160" width="210" height="60" rx="8" class="d-box"/>
  <text x="505" y="184" text-anchor="middle" class="d-label">Pods</text>
  <text x="505" y="202" text-anchor="middle" class="d-small">VPC IPs via the VPC CNI</text>
  <path d="M190 90 H268" class="d-arrow"/>
  <path d="M380 82 H398" class="d-arrow"/>
  <path d="M505 142 V158" class="d-arrow"/>
  <text x="229" y="82" text-anchor="middle" class="d-small">kubelet,</text>
  <text x="229" y="110" text-anchor="middle" class="d-small">exec, logs</text>
</svg>
<figcaption>AWS owns the left box. Everything in your VPC, including how pods get IP addresses, is yours to run.</figcaption>
</figure>

## Data plane options

| Option | What it is | Choose it when |
|---|---|---|
| **Managed node groups** | EKS-managed Auto Scaling groups of EC2 nodes; AMI updates roll through with cordon and drain | A steady baseline; teams that want predictable, simple nodes |
| **Self-managed nodes** | Your own ASGs and AMIs | Custom OS or kernel needs. Rarely worth it now |
| **Fargate profiles** | Each pod runs in its own micro-VM; selected by namespace and labels | Isolated or bursty jobs. No DaemonSets, no GPUs, no privileged pods; per-pod sizing overhead |
| **Karpenter** | A controller that watches *pending pods* and launches right-sized EC2 instances directly (no ASG), mixes Spot and on-demand, and consolidates under-used nodes | Most production clusters with variable load. It usually cuts compute cost significantly |
| **EKS Auto Mode** | AWS runs Karpenter, the VPC CNI, the load balancer controller, EBS CSI and the node OS for you | You want EKS without operating the core add-ons |

Node group pitfalls: a node group spans the subnets you give it, so give it subnets in several AZs. Cluster Autoscaler plus ASGs reacts slowly to mixed instance needs, which is why Karpenter replaced it in most shops. And every node needs a node IAM role with \`AmazonEKSWorkerNodePolicy\`, \`AmazonEC2ContainerRegistryReadOnly\` and the CNI policy.

## Who can talk to the cluster: access entries

Historically, IAM-to-Kubernetes mapping lived in the \`aws-auth\` ConfigMap: one typo there locked everybody out. Use **access entries** (\`authenticationMode: API\`). They map IAM principals to Kubernetes permissions through the EKS API, so IaC and CloudTrail can see them, and a broken ConfigMap can't brick the cluster. Set \`--access-config authenticationMode=API\` at creation; the default is still \`CONFIG_MAP\`.

## Pod IAM: IRSA and Pod Identity

Pods must **never** use the node's instance role: every pod on the node would share it. Give each workload its own role:

| | IRSA (IAM Roles for Service Accounts) | EKS Pod Identity |
|---|---|---|
| Mechanism | The cluster's OIDC issuer signs a service-account token; the SDK calls \`sts:AssumeRoleWithWebIdentity\` | The Pod Identity Agent (an add-on) hands out credentials; association is an EKS API object |
| Setup per cluster | An IAM OIDC provider per cluster | Install the add-on once |
| Trust policy | \`Federated: <oidc-provider-arn>\`, conditions on \`sub = system:serviceaccount:<ns>:<sa>\` | \`Service: pods.eks.amazonaws.com\`, actions \`sts:AssumeRole\` **and** \`sts:TagSession\` |
| Reuse a role across clusters | Edit the trust policy for each cluster's OIDC provider | Same role, new association. No trust policy change |
| Works on | EKS, self-managed Kubernetes, Fargate | EKS on EC2 nodes |

For new EKS clusters, prefer **Pod Identity**. The session tags it adds (cluster name, namespace, service account) also enable ABAC policies.

## The VPC CNI and IP exhaustion

The default **Amazon VPC CNI** gives every pod a real VPC IP from secondary IPs on the node's ENIs. Pods are first-class VPC citizens (security groups, flow logs, no overlay), but it has a cost:

- **Max pods per node** = ENIs × (IPs per ENI − 1) + 2. An m5.large is capped at 29 pods however small they are.
- Each node pre-allocates a **warm pool** of IPs. Big clusters in /24 subnets run out of addresses, and new pods sit in \`ContainerCreating\` with "failed to assign an IP address to container".

Fixes, in order of preference: plan big subnets from the start (/19 or larger for nodes); enable **prefix delegation** (each ENI slot gets a /28, about 16 IPs, which raises pod density and makes allocation faster); use **custom networking** with a secondary VPC CIDR from \`100.64.0.0/10\` just for pods; or run an **IPv6** cluster, where exhaustion disappears. Tune \`WARM_IP_TARGET\` / \`MINIMUM_IP_TARGET\` instead of the default warm ENI behaviour on large nodes.

## Add-ons and upgrades

The core components (\`vpc-cni\`, \`kube-proxy\`, \`coredns\`, \`aws-ebs-csi-driver\`, \`eks-pod-identity-agent\`) are **EKS add-ons**: versioned, installed and upgraded through the EKS API (\`aws eks create-addon\`, \`describe-addon-versions\`). Manage them in IaC, pinned to versions compatible with your Kubernetes version. The AWS Load Balancer Controller, ExternalDNS and cert-manager are Helm charts you own.

Kubernetes ships three minor versions a year, and EKS supports each for about **14 months** of standard support, then 12 months of **extended support** at $0.60 per cluster-hour (6× the price). Upgrades are a recurring project, not an event:

1. Read the release's removed APIs, and check your manifests and Helm charts (EKS **upgrade insights**, or \`pluto\`/\`kubent\`).
2. Upgrade the **control plane**, one minor version at a time (1.30 → 1.31 → 1.32). There's no downgrade.
3. Upgrade the **add-ons** to versions that match.
4. Roll the **nodes** (managed node group update, or Karpenter drift replaces them). Respect PodDisruptionBudgets.

Many teams do blue/green *clusters* for big jumps: build a new cluster, shift traffic with DNS or the load balancer, delete the old one.

## Try it

Here an EKS cluster is a real control-plane object, and it even serves a Kubernetes API \`/version\` endpoint:

\`\`\`bash
VPC=$(aws ec2 create-vpc --cidr-block 10.60.0.0/16 --query Vpc.VpcId --output text)
SA=$(aws ec2 create-subnet --vpc-id $VPC --cidr-block 10.60.0.0/19 --availability-zone us-east-1a --query Subnet.SubnetId --output text)
SB=$(aws ec2 create-subnet --vpc-id $VPC --cidr-block 10.60.32.0/19 --availability-zone us-east-1b --query Subnet.SubnetId --output text)
aws iam create-role --role-name demo-eks-cluster --assume-role-policy-document \
  '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"eks.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
aws eks create-cluster --name demo-single-az --role-arn arn:aws:iam::000000000000:role/demo-eks-cluster \
  --resources-vpc-config subnetIds=$SA
\`\`\`

The single-AZ attempt is rejected: EKS needs subnets in at least two AZs. Now do it properly, with access entries:

\`\`\`bash
aws eks create-cluster --name demo --role-arn arn:aws:iam::000000000000:role/demo-eks-cluster \
  --resources-vpc-config subnetIds=$SA,$SB --access-config authenticationMode=API --query cluster.status
aws eks wait cluster-active --name demo
curl -sk "$(aws eks describe-cluster --name demo --query cluster.endpoint --output text)/version"; echo
\`\`\`

Pod Identity validates the role's trust policy. This role trusts EKS the *cluster* service, not pods, so it's refused:

\`\`\`bash
aws eks create-pod-identity-association --cluster-name demo --namespace shop --service-account api \
  --role-arn arn:aws:iam::000000000000:role/demo-eks-cluster
aws iam create-role --role-name demo-pod-role --assume-role-policy-document \
  '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"pods.eks.amazonaws.com"},"Action":["sts:AssumeRole","sts:TagSession"]}]}' >/dev/null
aws eks create-pod-identity-association --cluster-name demo --namespace shop --service-account api \
  --role-arn arn:aws:iam::000000000000:role/demo-pod-role --query association.associationArn
\`\`\`

## ECS or EKS?

| Question | ECS | EKS |
|---|---|---|
| Concepts to learn | ~4 (cluster, task def, task, service) | Dozens (pods, deployments, services, ingress, CRDs, RBAC…) |
| Control plane cost | Free | $0.10/h per cluster ($0.60/h on extended support) |
| Upgrades | None: AWS versions the API | 3 Kubernetes minors a year, each with deprecations |
| AWS integration | Native: IAM per task, ALB, Secrets, Cloud Map, Service Connect | Through controllers you install and upgrade |
| Portability | AWS only | Any Kubernetes; same manifests on-prem or on other clouds |
| Ecosystem | AWS features | Helm, operators, service meshes, GitOps (Argo CD, Flux) |
| Platform team needed | Optional | Realistically yes, for any non-trivial cluster |
| Best fit | AWS-centric teams shipping services, small platform teams | Orgs already standardised on Kubernetes, multi-cloud, heavy use of operators |

The honest senior answer: **default to ECS on Fargate** unless you have a concrete reason for Kubernetes (existing expertise and tooling, portability requirements, an operator you depend on). EKS's power comes with an operating cost that never goes away: upgrades, add-ons, CNI tuning, and RBAC. Both are good. Running both "for flexibility" is the expensive option.

> **On real AWS vs the emulator:** clusters, node groups (which launch emulated EC2 instances), Fargate profiles, add-ons and Pod Identity associations are control-plane objects here. The API server answers \`/version\`, but don't expect to schedule real pods: test EKS IaC and IAM wiring here, and workloads in a real or kind cluster.
`,
    },
  ],
  quiz: [
    {
      q: "A new Fargate service's tasks start, and its logs show `AccessDenied` when the code calls `s3:GetObject` on its bucket. Which change fixes it with least privilege?",
      options: [
        "Add s3:GetObject on the bucket to the task definition's execution role",
        "Add s3:GetObject on the bucket's objects to the task definition's task role",
        "Attach AmazonECSTaskExecutionRolePolicy to the task role",
        "Add a bucket policy that allows ecs-tasks.amazonaws.com",
      ],
      answer: 1,
      explain:
        "Application code gets its credentials from the **task role** (through the container credentials endpoint). The execution role is only used by the platform to pull images, write logs and resolve secrets. Granting the service principal in a bucket policy would let *any* ECS task in any account that names your bucket through.",
    },
    {
      q: "Tasks for a service in private subnets go PROVISIONING → STOPPED with `ResourceInitializationError: unable to pull secrets or registry auth`. The app's code hasn't changed. What are the two most likely causes?",
      options: [
        "The task role lacks secretsmanager:GetSecretValue, or the container healthCheck is wrong",
        "The execution role lacks permission to read the secret (or kms:Decrypt for its CMK), or there's no network path from the subnets to Secrets Manager/SSM and ECR (no NAT or VPC endpoints)",
        "The ALB health check path is wrong, or the deregistration delay is too long",
        "minimumHealthyPercent is 100, or the circuit breaker is disabled",
      ],
      answer: 1,
      explain:
        "Secrets are resolved by the platform **before** the container starts, using the **execution role**, over the task's ENI. So it's either IAM on the execution role or routing (NAT, or `ssm`/`secretsmanager`/`ecr.api`/`ecr.dkr` interface endpoints plus the S3 gateway endpoint). Health checks only matter once the container runs.",
    },
    {
      q: "A service has desiredCount 4, minimumHealthyPercent 100 and maximumPercent 100. A new task definition is deployed. What happens?",
      options: [
        "ECS replaces one task at a time",
        "ECS stops all four tasks and starts four new ones",
        "The deployment can't make progress: it may not drop below 4 healthy tasks or exceed 4 total",
        "ECS ignores the limits and uses 50/200",
      ],
      answer: 2,
      explain:
        "To replace a task, ECS must either start a new one first (needs max > 100%) or stop an old one first (needs min < 100%). With 100/100 neither is allowed. Use 100/200 for zero-downtime deployments with spare capacity, or 50/100 when you can't add capacity.",
    },
    {
      q: "During an incident you roll a service back to `shop/api:1.8.0`, but the new tasks fail with `CannotPullContainerError: ... not found`. The repository has a lifecycle policy that keeps 10 images. What's the root cause, and what's the durable fix?",
      options: [
        "ECR scan on push quarantined the image; disable scanning",
        "The lifecycle policy expired 1.8.0 after more than 10 newer pushes; size the count to the rollback window, or keep release tags with a separate tag-pattern rule",
        "IMMUTABLE tags can't be redeployed; switch to MUTABLE",
        "The execution role lost ecr:BatchGetImage after the last deployment",
      ],
      answer: 1,
      explain:
        "Count-based lifecycle rules know nothing about what you might deploy. On a busy repository 10 images can be a single day. Keep release images longer (a `tagPatternList` rule for `release-*` or semver tags with a higher count) and expire CI and PR images aggressively. Immutability is what makes the rollback *safe*: 1.8.0 still means the same bytes.",
    },
    {
      q: "New pods in an EKS cluster are stuck in ContainerCreating with \"failed to assign an IP address to container\". Nodes have plenty of CPU and memory. Which change addresses the cause?",
      options: [
        "Increase the node group's maximum size",
        "Enable prefix delegation on the VPC CNI and/or give pods larger subnets (for example a secondary 100.64.0.0/10 CIDR with custom networking)",
        "Switch the cluster's authentication mode to API",
        "Install the Pod Identity Agent add-on",
      ],
      answer: 1,
      explain:
        "With the VPC CNI every pod uses a real VPC IP, and nodes keep warm pools of them. Small subnets run dry long before CPU does. Prefix delegation (a /28 per ENI slot) raises per-node density and allocation speed; larger or secondary pod subnets, or IPv6, fix the address supply itself. Adding nodes in the same exhausted subnets makes it worse.",
    },
    {
      q: "Your team runs 15 stateless HTTP services on AWS, has two platform engineers, and has no Kubernetes experience or portability requirement. What's the most defensible platform choice?",
      options: [
        "EKS with self-managed nodes, for maximum control",
        "EKS on Fargate, to avoid nodes",
        "ECS on Fargate, with ALB integration and per-service task roles",
        "EC2 instances with Docker Compose",
      ],
      answer: 2,
      explain:
        "ECS on Fargate gives you per-task IAM, ALB integration, deployments with circuit breakers, and auto scaling, with no control-plane upgrades or add-ons to run. EKS earns its operating cost when you need the Kubernetes ecosystem or portability, neither of which applies here.",
    },
    {
      q: "The database password in Secrets Manager was rotated an hour ago. The service's tasks, injected through `secrets` in the task definition, still connect with the old password. Why, and what do you do now?",
      options: [
        "The execution role is cached; detach and reattach it",
        "ECS injects secret values only when a task starts; force a new deployment so tasks restart with the new value (and plan runtime fetching for live rotation)",
        "Secrets Manager rotation needs 24 hours to propagate",
        "The task definition must be re-registered with the new password in environment",
      ],
      answer: 1,
      explain:
        "`secrets` are resolved once, at task start, into environment variables. `aws ecs update-service --force-new-deployment` replaces the tasks. For credentials rotated on a schedule, have the app read Secrets Manager at runtime with a short cache, or use rotation with overlapping old and new credentials so running tasks keep working until they're replaced.",
    },
  ],
};
