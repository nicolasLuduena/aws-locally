import type { CheckContext, Module } from "../types.ts";

// ------------------------------------------------------------------ helpers

async function queueAttrs(ctx: CheckContext, name: string): Promise<Record<string, string> | null> {
  const u = await ctx.tryAws(["sqs", "get-queue-url", "--queue-name", name]);
  if (!u.ok) return null;
  const a = await ctx.tryAws(["sqs", "get-queue-attributes", "--queue-url", u.data.QueueUrl, "--attribute-names", "All"]);
  return a.ok ? (a.data?.Attributes ?? {}) : null;
}

async function queueTags(ctx: CheckContext, name: string): Promise<Record<string, string>> {
  const u = await ctx.tryAws(["sqs", "get-queue-url", "--queue-name", name]);
  if (!u.ok) return {};
  const t = await ctx.tryAws(["sqs", "list-queue-tags", "--queue-url", u.data.QueueUrl]);
  return t.data?.Tags ?? {};
}

function parseJson(text: string | null): any | null {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Resource addresses ("module.queue[\"orders\"].aws_sqs_queue.this") in a v4 state document. */
function stateAddresses(state: any): string[] {
  const out: string[] = [];
  for (const r of state?.resources ?? []) {
    if (r.mode !== "managed") continue;
    for (const i of r.instances ?? []) {
      const idx = i.index_key === undefined ? "" : typeof i.index_key === "string" ? `["${i.index_key}"]` : `[${i.index_key}]`;
      const prefix = r.module ? `${r.module}.` : "";
      // for_each on a module puts the key on the module path, not the instance
      out.push(`${prefix}${r.type}.${r.name}${idx}`);
    }
  }
  return out;
}

const STATE_BUCKET = "tfstate-platform";
const STATE_KEY = "platform/dev/terraform.tfstate";

// ------------------------------------------------------------------ lab 1 files

const versionsTf = String.raw`
terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}
`;

const providersTf = String.raw`
# The endpoint is NOT set here. The provider (like every AWS SDK) reads
# AWS_ENDPOINT_URL from the environment, which the course terminal points at
# the emulator. The same code then works unchanged against real AWS.
provider "aws" {
  region = "us-east-1"

  # Emulator-friendly settings:
  s3_use_path_style           = true # http://endpoint/bucket, not http://bucket.endpoint
  skip_credentials_validation = true # don't call STS GetCallerIdentity at start-up
  skip_requesting_account_id  = true # don't derive the account ID via STS/IAM

  # Tags applied to every resource that supports them.
  default_tags {
    tags = {
      ManagedBy = "terraform"
      Env       = var.env
    }
  }
}
`;

const variablesTf = String.raw`
variable "env" {
  type        = string
  description = "Environment name."
  default     = "dev"

  validation {
    condition     = contains(["dev", "staging", "prod"], var.env)
    error_message = "env must be dev, staging or prod."
  }
}

variable "queues" {
  description = "One work queue (plus its DLQ) per entry. The key is the queue name."
  type = map(object({
    visibility_timeout = number
    max_receive_count  = number
  }))
  default = {
    orders   = { visibility_timeout = 30, max_receive_count = 3 }
    payments = { visibility_timeout = 60, max_receive_count = 5 }
  }
}
`;

const mainStarterTf = String.raw`
# TODO 1: an S3 bucket named "tf-lab-artifacts" (aws_s3_bucket) and, as a
#         separate resource, versioning Enabled on it (aws_s3_bucket_versioning).

# TODO 2: one instance of the local module ./modules/queue per entry in
#         var.queues, using for_each. Pass name, visibility_timeout and
#         max_receive_count from each.key / each.value.

# TODO 3: an output "queue_urls": a map from queue name to the module's
#         queue_url output, e.g. { for k, m in module.queue : k => m.queue_url }
`;

const mainSolutionTf = String.raw`
resource "aws_s3_bucket" "artifacts" {
  bucket = "tf-lab-artifacts"
}

resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  versioning_configuration {
    status = "Enabled"
  }
}

module "queue" {
  source   = "./modules/queue"
  for_each = var.queues

  name               = each.key
  visibility_timeout = each.value.visibility_timeout
  max_receive_count  = each.value.max_receive_count
}

output "queue_urls" {
  value = { for k, m in module.queue : k => m.queue_url }
}

output "bucket" {
  value = aws_s3_bucket.artifacts.bucket
}
`;

const moduleVariablesTf = String.raw`
variable "name" {
  type        = string
  description = "Queue name. The DLQ is named <name>-dlq."
}

variable "visibility_timeout" {
  type    = number
  default = 30
}

variable "max_receive_count" {
  type    = number
  default = 3

  validation {
    condition     = var.max_receive_count >= 1 && var.max_receive_count <= 1000
    error_message = "max_receive_count must be between 1 and 1000."
  }
}
`;

const moduleMainTf = String.raw`
# A queue that always comes with a dead-letter queue: the "paved road".
resource "aws_sqs_queue" "dlq" {
  name                      = "\${var.name}-dlq"
  message_retention_seconds = 1209600 # 14 days, the maximum
}

resource "aws_sqs_queue" "this" {
  name                       = var.name
  visibility_timeout_seconds = var.visibility_timeout

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = var.max_receive_count
  })
}
`;

const moduleOutputsTf = String.raw`
output "queue_url" {
  value = aws_sqs_queue.this.url
}

output "queue_arn" {
  value = aws_sqs_queue.this.arn
}

output "dlq_arn" {
  value = aws_sqs_queue.dlq.arn
}
`;

// ------------------------------------------------------------------ lab 2 files

const platformStarterTf = String.raw`
terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # TODO: a backend "s3" block that stores state in the bucket "tfstate-platform"
  #       under the key "platform/dev/terraform.tfstate", region us-east-1,
  #       with S3-native locking (use_lockfile) and encryption (encrypt).
  #       For the emulator also set:
  #         use_path_style              = true
  #         skip_credentials_validation = true
  #         skip_requesting_account_id  = true
  #       Do NOT set an endpoint: the backend reads AWS_ENDPOINT_URL too.
}

provider "aws" {
  region                      = "us-east-1"
  s3_use_path_style           = true
  skip_credentials_validation = true
  skip_requesting_account_id  = true
}

variable "release" {
  type        = string
  description = "The platform release currently deployed."
  default     = "v1"
}

resource "aws_ssm_parameter" "release" {
  name  = "/platform/dev/release"
  type  = "String"
  value = var.release
}

output "release_parameter_arn" {
  value = aws_ssm_parameter.release.arn
}
`;

const platformBackendBlock = String.raw`
  backend "s3" {
    bucket       = "tfstate-platform"
    key          = "platform/dev/terraform.tfstate"
    region       = "us-east-1"
    use_lockfile = true
    encrypt      = true

    use_path_style              = true
    skip_credentials_validation = true
    skip_requesting_account_id  = true
  }
`;

const platformSolutionTf = platformStarterTf.replace(/  # TODO: a backend[\s\S]*?AWS_ENDPOINT_URL too\.\n/, platformBackendBlock.replace(/^\n/, ""));
if (platformSolutionTf === platformStarterTf) throw new Error("platform backend TODO not found");

const appStarterTf = String.raw`
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region                      = "us-east-1"
  s3_use_path_style           = true
  skip_credentials_validation = true
  skip_requesting_account_id  = true
}

# TODO 1: a data "terraform_remote_state" "platform" source with backend "s3"
#         that reads the platform state (same bucket, key and region as the
#         platform backend, plus the three emulator settings).

# TODO 2: an aws_ssm_parameter named "/app/dev/platform-release-param"
#         (type String) whose value is the platform's release_parameter_arn
#         output, read through the remote state data source.
`;

const appSolutionTf = String.raw`
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region                      = "us-east-1"
  s3_use_path_style           = true
  skip_credentials_validation = true
  skip_requesting_account_id  = true
}

data "terraform_remote_state" "platform" {
  backend = "s3"
  config = {
    bucket                      = "tfstate-platform"
    key                         = "platform/dev/terraform.tfstate"
    region                      = "us-east-1"
    use_path_style              = true
    skip_credentials_validation = true
    skip_requesting_account_id  = true
  }
}

resource "aws_ssm_parameter" "platform_release_param" {
  name  = "/app/dev/platform-release-param"
  type  = "String"
  value = data.terraform_remote_state.platform.outputs.release_parameter_arn
}
`;

// ------------------------------------------------------------------ module

export const terraform: Module = {
  id: "terraform",
  number: "12",
  title: "Infrastructure as Code: Terraform",
  summary:
    "Write reusable Terraform for AWS, keep its state remote, locked and versioned in S3, and change live infrastructure safely with plans, imports, moved blocks and lifecycle rules.",
  services: ["Terraform", "S3", "SQS", "SSM"],
  lessons: [
    // ---------------------------------------------------------------- reading 1
    {
      id: "model",
      kind: "reading",
      title: "The Terraform model: configuration, graph, plan",
      minutes: 15,
      body: String.raw`
Terraform is a **desired-state engine**. You describe the infrastructure you want in HCL; Terraform compares that with what it last recorded (the *state*) and with what exists (the *refresh*), and computes the API calls that close the gap. Unlike CloudFormation it runs on *your* machine or CI runner, it talks directly to the AWS APIs through a **provider**, and it keeps its own record of the world in a state file.

## The building blocks

\`\`\`hcl
terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }   # >= 6.0, < 7.0
  }
}

provider "aws" {
  region = "us-east-1"
  default_tags { tags = { ManagedBy = "terraform", Team = "platform" } }
}

variable "env" {                       # an input
  type    = string
  default = "dev"
  validation {
    condition     = contains(["dev", "prod"], var.env)
    error_message = "env must be dev or prod."
  }
}

locals {                               # a named expression, computed once
  name_prefix = "orders-\${var.env}"
}

data "aws_caller_identity" "current" {}   # a read-only lookup

resource "aws_sqs_queue" "jobs" {      # something Terraform owns
  name                       = "\${local.name_prefix}-jobs"
  visibility_timeout_seconds = var.env == "prod" ? 120 : 30
}

output "jobs_arn" {                    # a value for humans and other configs
  value = aws_sqs_queue.jobs.arn
}
\`\`\`

| Block | Purpose | Pitfall |
|---|---|---|
| \`provider\` | A plugin that maps resources to API calls. Configured once per region/account (use \`alias\` for more) | Unpinned versions: a new major version changes behaviour under you |
| \`resource\` | An object Terraform creates, updates and deletes. Address: \`aws_sqs_queue.jobs\` | Renaming the block = destroy + create (unless you add a \`moved\` block) |
| \`data\` | Reads something Terraform doesn't own (an AMI, a VPC made by another team, your account ID) | Data sources run at every plan, so a slow or failing lookup breaks every plan |
| \`variable\` | Typed input from \`-var\`, \`*.tfvars\`, \`TF_VAR_x\` or a default | \`sensitive = true\` hides it in output, **not** in state |
| \`locals\` | Derived values, naming conventions | Overuse makes code hard to follow |
| \`output\` | Exposes values (CLI, \`terraform_remote_state\`, module callers) | Outputs of sensitive values must be marked \`sensitive\` |

The **lock file** \`.terraform.lock.hcl\`, written by \`terraform init\`, records the exact provider version and checksums chosen. **Commit it.** Without it, two engineers (or CI on two different days) can run different provider versions against the same state.

## Pointing the AWS provider at the emulator

The provider uses the AWS SDK for Go, so it reads the same environment as the CLI: \`AWS_ENDPOINT_URL\`, \`AWS_CA_BUNDLE\`, the credentials file and \`AWS_REGION\`. Three settings make it play nicely with a local endpoint:

\`\`\`hcl
provider "aws" {
  region                      = "us-east-1"
  s3_use_path_style           = true   # bucket in the path; there is no DNS for <bucket>.127.0.0.1
  skip_credentials_validation = true   # no STS call at start-up
  skip_requesting_account_id  = true   # don't look up the account via STS/IAM
}
\`\`\`

**Don't hard-code the endpoint.** Your course terminal points \`AWS_ENDPOINT_URL\` at an HTTP inspector proxy, the lab checker points it straight at the emulator over HTTPS, and CI might use yet another port. If the endpoint comes from the environment, one configuration works everywhere, including real AWS once you unset the variable. (If you ever need per-service overrides, the provider has an \`endpoints { sqs = "…" }\` block. Keep it out of shared modules.)

## The graph, plan and apply

<figure class="diagram">
<svg viewBox="0 0 640 230" role="img" aria-label="Terraform builds a dependency graph from references, then plan diffs desired against state and refreshed reality, then apply walks the graph in parallel">
  <rect x="10" y="20" width="120" height="44" rx="6" class="d-box"/><text x="70" y="47" text-anchor="middle" class="d-label">*.tf config</text>
  <rect x="10" y="90" width="120" height="44" rx="6" class="d-box"/><text x="70" y="117" text-anchor="middle" class="d-label">state</text>
  <rect x="10" y="160" width="120" height="44" rx="6" class="d-box d-dim"/><text x="70" y="181" text-anchor="middle" class="d-label">real AWS</text><text x="70" y="196" text-anchor="middle" class="d-small">via refresh</text>
  <rect x="190" y="70" width="130" height="84" rx="8" class="d-box d-accent"/><text x="255" y="100" text-anchor="middle" class="d-label">terraform plan</text><text x="255" y="120" text-anchor="middle" class="d-small">diff per address:</text><text x="255" y="136" text-anchor="middle" class="d-small">+ ~ -/+ -</text>
  <path d="M130 42 H160 V100 H188" class="d-arrow"/><path d="M130 112 H188" class="d-arrow"/><path d="M130 182 H160 V124 H188" class="d-arrow"/>
  <rect x="380" y="20" width="250" height="190" rx="8" class="d-box d-outer"/>
  <text x="396" y="42" class="d-label">terraform apply: walk the graph</text>
  <rect x="400" y="60" width="96" height="34" rx="5" class="d-box"/><text x="448" y="81" text-anchor="middle" class="d-small">dlq["orders"]</text>
  <rect x="514" y="60" width="100" height="34" rx="5" class="d-box"/><text x="564" y="81" text-anchor="middle" class="d-small">dlq["payments"]</text>
  <rect x="400" y="120" width="96" height="34" rx="5" class="d-box"/><text x="448" y="141" text-anchor="middle" class="d-small">this["orders"]</text>
  <rect x="514" y="120" width="100" height="34" rx="5" class="d-box"/><text x="564" y="141" text-anchor="middle" class="d-small">this["payments"]</text>
  <path d="M448 94 V118" class="d-arrow"/><path d="M564 94 V118" class="d-arrow"/>
  <text x="505" y="180" text-anchor="middle" class="d-small">independent nodes run in parallel (10 by default);</text>
  <text x="505" y="196" text-anchor="middle" class="d-small">a reference (dlq.arn) forces an order</text>
  <path d="M320 112 H378" class="d-arrow"/>
</svg>
<figcaption>Every reference such as <code>aws_sqs_queue.dlq.arn</code> is an edge. Terraform creates in dependency order, destroys in reverse order, and parallelises everything else.</figcaption>
</figure>

Read plan symbols carefully: \`+\` create, \`~\` update in place, \`-\` destroy, and **\`-/+\` destroy and then create a replacement** (marked \`# forces replacement\` next to the attribute responsible). \`-/+\` on a database is the line that should make you stop. Values shown as \`(known after apply)\` are computed by AWS; anything that depends on them can't be fully planned.

In CI, always **save the plan** and apply exactly that: \`terraform plan -out=tfplan\` then \`terraform apply tfplan\`. Applying without a saved plan re-plans, and the world may have changed since the reviewer looked. \`terraform show -json tfplan\` gives you a machine-readable plan to feed into policy checks.

## for_each vs count

\`\`\`hcl
resource "aws_sqs_queue" "by_count" {
  count = length(var.names)           # addresses: by_count[0], by_count[1], …
  name  = var.names[count.index]
}

resource "aws_sqs_queue" "by_key" {
  for_each = toset(var.names)         # addresses: by_key["orders"], by_key["payments"]
  name     = each.key
}
\`\`\`

With \`count\`, identity is a **position**. Remove the first name from the list and every later element shifts by one: Terraform plans to rename (really, replace) every queue after it. With \`for_each\`, identity is a **key**, so removing \`orders\` destroys only \`orders\`. Rule of thumb: **\`for_each\` for collections of things; \`count\` only for "zero or one"** (\`count = var.enable_alarms ? 1 : 0\`). \`for_each\` keys must be known at plan time, so key on names from variables, not on IDs that AWS generates.

## Try it

\`\`\`bash
mkdir -p demo-tf && cat > demo-tf/main.tf <<'EOF'
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}
provider "aws" {
  region                      = "us-east-1"
  s3_use_path_style           = true
  skip_credentials_validation = true
  skip_requesting_account_id  = true
}
variable "env" {
  type    = string
  default = "dev"
}
locals {
  prefix = "/demo-tf/\${var.env}"
}
data "aws_caller_identity" "current" {}
resource "aws_ssm_parameter" "settings" {
  for_each = { log_level = "info", feature_x = "off" }
  name     = "\${local.prefix}/\${each.key}"
  type     = "String"
  value    = each.value
}
output "parameter_names" {
  value = [for p in aws_ssm_parameter.settings : p.name]
}
output "account" {
  value = data.aws_caller_identity.current.account_id
}
EOF
terraform -chdir=demo-tf init
terraform -chdir=demo-tf plan
terraform -chdir=demo-tf apply -auto-approve
aws ssm get-parameters-by-path --path /demo-tf/dev --query 'Parameters[].[Name,Value]' --output text
\`\`\`

\`-chdir\` runs Terraform in that directory without changing your shell's. Watch the **API** tab during \`plan\`: refresh is a burst of read calls, one or more per resource. That's why huge configurations plan slowly and hit API throttling, and one reason to split them.
`,
    },
    // ---------------------------------------------------------------- reading 2
    {
      id: "state",
      kind: "reading",
      title: "State: remote, locked and private",
      minutes: 15,
      body: String.raw`
The **state** is Terraform's memory: a JSON document mapping every resource address in your code (\`module.queue["orders"].aws_sqs_queue.this\`) to a real object (\`https://sqs…/orders\`) plus all of its last-known attributes. Without it, Terraform can't tell "this queue is mine and should be updated" from "this queue belongs to someone else".

## Why state is sensitive

Terraform stores **every attribute** of every resource in state, in plain text: database master passwords, generated private keys from \`tls_private_key\`, secret values from \`aws_secretsmanager_secret_version\`, and access keys. \`sensitive = true\` only hides values from CLI output. Treat a state file like a secrets file:

- Never commit it. Add \`*.tfstate*\` and \`.terraform/\` to \`.gitignore\`.
- Store it in a bucket with encryption (SSE-KMS with a dedicated key is best), **Block Public Access**, a bucket policy that denies non-TLS access, and IAM that limits reads to the pipeline role and a few humans.
- Prefer designs that keep secrets *out* of state: let RDS manage the master password in Secrets Manager (\`manage_master_user_password = true\`), or create secrets outside Terraform and reference them by ARN. Newer Terraform versions also support *ephemeral* values and write-only attributes that never reach state.

## Remote state in S3

A local \`terraform.tfstate\` works for one person on one laptop. Teams need state that is **shared, locked and versioned**:

\`\`\`hcl
terraform {
  backend "s3" {
    bucket       = "acme-tfstate-123456789012"
    key          = "platform/prod/network.tfstate"   # one key per state
    region       = "us-east-1"
    encrypt      = true
    kms_key_id   = "alias/tfstate"
    use_lockfile = true                                # S3-native locking
  }
}
\`\`\`

Backend blocks can't use variables. Keep the per-environment parts out of the code with **partial configuration**: \`terraform init -backend-config=env/prod.s3.tfbackend\`.

<figure class="diagram">
<svg viewBox="0 0 640 220" role="img" aria-label="State locking with S3: a conditional PutObject of the .tflock object acquires the lock; a second writer gets 412 PreconditionFailed">
  <rect x="10" y="20" width="140" height="50" rx="6" class="d-box"/><text x="80" y="42" text-anchor="middle" class="d-label">CI job A</text><text x="80" y="58" text-anchor="middle" class="d-small">terraform apply</text>
  <rect x="10" y="140" width="140" height="50" rx="6" class="d-box d-dim"/><text x="80" y="162" text-anchor="middle" class="d-label">Engineer B</text><text x="80" y="178" text-anchor="middle" class="d-small">terraform apply</text>
  <rect x="330" y="20" width="300" height="180" rx="8" class="d-box d-outer"/>
  <text x="346" y="42" class="d-label">State bucket (versioned, encrypted)</text>
  <rect x="350" y="60" width="260" height="34" rx="5" class="d-box d-accent"/><text x="480" y="81" text-anchor="middle" class="d-small">platform/prod/network.tfstate.tflock</text>
  <rect x="350" y="110" width="260" height="34" rx="5" class="d-box"/><text x="480" y="131" text-anchor="middle" class="d-small">platform/prod/network.tfstate (v1, v2, v3 …)</text>
  <path d="M150 40 H348" class="d-arrow"/><text x="250" y="32" text-anchor="middle" class="d-small">PUT .tflock If-None-Match: *</text>
  <text x="250" y="56" text-anchor="middle" class="d-small">200: lock acquired</text>
  <path d="M150 160 H260 V86 H348" class="d-arrow d-dashed"/><text x="200" y="152" text-anchor="middle" class="d-small">same PUT</text>
  <rect x="170" y="186" width="150" height="26" rx="5" class="d-box d-danger"/><text x="245" y="203" text-anchor="middle" class="d-small">412: Error acquiring lock</text>
  <path d="M480 94 V108" class="d-arrow"/>
</svg>
<figcaption>With <code>use_lockfile = true</code>, the lock is just an object written with a conditional PUT. Only one writer can create it; the other gets 412 and stops. Unlock deletes the object.</figcaption>
</figure>

| | \`use_lockfile = true\` (S3 native) | \`dynamodb_table\` (legacy) |
|---|---|---|
| Since | Terraform 1.10 (GA in 1.11) | Terraform's early days |
| Mechanism | Conditional PUT (\`If-None-Match\`) of \`<key>.tflock\` | A conditional \`PutItem\` of a row \`LockID\` in a table |
| Extra infrastructure | None | A DynamoDB table with a \`LockID\` string key |
| Permissions | \`s3:GetObject\`, \`s3:PutObject\`, \`s3:DeleteObject\` on \`<key>.tflock\` | DynamoDB \`GetItem\`, \`PutItem\`, \`DeleteItem\` too |
| Status | Recommended | **Deprecated**, to be removed in a future version |

Migrating is safe in two steps: set both \`use_lockfile = true\` and \`dynamodb_table\` for a while (Terraform takes both locks), then remove \`dynamodb_table\` once every pipeline and engineer uses the new version.

When a run dies mid-apply, the lock stays. \`terraform force-unlock <LOCK_ID>\` removes it, but **only after you've confirmed nobody is running**. Unlocking under a live apply is how state gets corrupted. Use \`-lock-timeout=5m\` in CI so concurrent jobs wait instead of failing.

**Versioning on the state bucket is your undo button.** If a bad \`terraform state rm\` or a corrupted write happens, you can restore the previous object version. Enable versioning plus a lifecycle rule that expires noncurrent versions after, say, 90 days.

## Splitting state and environments

One state per **blast radius**: \`network\`, \`data\`, \`app\`, per environment. Large states plan slowly, need broad permissions, and turn every apply into a risk to everything.

| | Workspaces (\`terraform workspace new prod\`) | Directory per environment |
|---|---|---|
| Layout | One directory, state keys \`env:/prod/<key>\` | \`envs/dev/\`, \`envs/prod/\`, each with its own backend and \`tfvars\`, calling shared modules |
| Differences between envs | Only via \`terraform.workspace\` conditionals | Explicit and visible in each directory |
| Credentials / accounts | Same backend, often the same credentials | Each env can use its own account, role and state bucket |
| Risk | Easy to apply to the wrong workspace; prod and dev share one blast radius | Wrong-env mistakes are much harder |
| Good for | Short-lived copies (feature-branch envs, testing a module) | Long-lived environments, especially separate accounts |

Most mature teams use **directory per environment, one account per environment** (or a wrapper like Terragrunt) and keep workspaces for ephemeral copies.

## Reading other states, and state surgery

- \`data "terraform_remote_state"\` reads another configuration's **outputs**. It needs read access to that whole state file (secrets included), so for widely shared values prefer publishing them to SSM Parameter Store and reading them with \`data "aws_ssm_parameter"\`.
- \`terraform state list\` and \`terraform state show <addr>\` let you inspect state. \`terraform state rm\` makes Terraform forget a resource without destroying it. Prefer the declarative \`moved\`, \`import\` and \`removed\` blocks (next reading) over imperative \`state mv/rm\`: they are reviewed in a PR and replayed identically in every environment.
`,
    },
    // ---------------------------------------------------------------- reading 3
    {
      id: "changing",
      kind: "reading",
      title: "Changing live infrastructure safely",
      minutes: 15,
      body: String.raw`
Writing Terraform for an empty account is the easy part. The real work is changing a configuration that already manages production: refactoring without replacing, adopting resources that were clicked into existence, and making sure the next apply can't delete a database.

## Modules and versioning

A **module** is a directory of \`.tf\` files with variables (its inputs) and outputs (its interface). Every configuration is the *root module*. You call others:

\`\`\`hcl
module "orders_queue" {
  source  = "./modules/queue"                                     # local path
  # source  = "git::https://github.com/acme/tf-modules.git//queue?ref=v2.3.1"
  # source  = "terraform-aws-modules/sqs/aws"                     # registry
  # version = "~> 4.2"                                            # registry only
  name = "orders"
}
\`\`\`

- **Pin versions.** A registry module takes \`version = "~> 4.2"\`. A git module takes \`?ref=v2.3.1\`: a **tag**, never a branch, or every \`init\` may pull different code.
- Version shared modules with **semantic versioning**. A changed resource address or a new required variable is a *major* version. Ship a \`moved\` block inside the module so callers upgrade without replacement.
- Keep modules small and opinionated (a "queue with DLQ and alarms", a "service with its IAM role"). A module that exposes every argument of every resource is just indirection.

## Adopting existing resources: import blocks

\`\`\`bash
aws sqs create-queue --queue-name demo-tf-legacy
cat > demo-tf/import.tf <<'EOF'
import {
  to = aws_sqs_queue.legacy
  id = "https://sqs.us-east-1.amazonaws.com/000000000000/demo-tf-legacy"
}
EOF
terraform -chdir=demo-tf plan -generate-config-out=generated.tf
cat demo-tf/generated.tf
terraform -chdir=demo-tf apply -auto-approve
\`\`\`

The \`import\` block is declarative: it shows up in the plan (\`1 to import\`), goes through code review and runs in every environment. \`-generate-config-out\` writes a starting \`resource\` block. Tidy it (remove defaults, add variables) and aim for a plan that says **"1 to import, 0 to change"**: that proves your code describes the resource exactly. The \`id\` format differs per resource type (a queue URL, a parameter name, a bucket name); each resource's documentation has an "Import" section.

Treat generated configuration as a draft, not as an answer. It contains every attribute, including defaults and computed ones you should delete, and for some types it doesn't even validate. For \`aws_ssm_parameter\`, for example, the secret \`value\` is written as \`null # sensitive\` and \`terraform plan\` fails with "one of \`insecure_value,value,value_wo\` must be specified" until you supply the value (from a variable or a data source). Import one resource type at a time, review, and commit.

## Refactoring: moved blocks

Renaming \`aws_sqs_queue.q\` to \`aws_sqs_queue.orders\`, moving it into a module, or switching from \`count\` to \`for_each\` changes its address. Terraform sees "destroy the old one, create a new one". A \`moved\` block tells it they are the same object:

\`\`\`hcl
moved {
  from = aws_sqs_queue.q
  to   = module.orders_queue.aws_sqs_queue.this
}

moved {
  from = aws_sqs_queue.worker[0]          # count → for_each
  to   = aws_sqs_queue.worker["orders"]
}
\`\`\`

The plan then reads \`# aws_sqs_queue.q has moved to …\` with no destroy. Keep moved blocks around until every environment and every consumer of a shared module has applied them. The opposite operation is a \`removed\` block (\`lifecycle { destroy = false }\`): stop managing a resource without deleting it.

## Drift and refresh-only

Someone changes a resource by hand. On the next \`plan\`, Terraform refreshes, notices the difference, and plans to **put it back** to what the code says. Usually that's right. If the manual change was the correct fix, you need to see it *before* Terraform reverts it:

\`\`\`bash
aws ssm put-parameter --name /demo-tf/dev/log_level --value debug --overwrite
terraform -chdir=demo-tf plan -refresh-only
terraform -chdir=demo-tf plan
\`\`\`

(The parameter's value is sensitive, so the plan prints \`(sensitive value)\`; the \`version 1 -> 2\` line is your clue that it changed.) \`plan -refresh-only\` shows only what changed **outside** Terraform ("Objects have changed outside of Terraform") and proposes updating state, not infrastructure. The normal plan shows the change Terraform would make to undo it. Run a scheduled \`terraform plan -detailed-exitcode\` (exit 2 means changes are pending) in CI against every environment and alert on drift. Then fix it the boring way: codify the manual change, or let the next apply revert it.

## lifecycle: guard rails per resource

\`\`\`hcl
resource "aws_dynamodb_table" "orders" {
  # …
  deletion_protection_enabled = true          # the service-side guard rail

  lifecycle {
    prevent_destroy = true                    # plan fails if it would destroy this
    ignore_changes  = [read_capacity, write_capacity]   # managed by autoscaling
  }
}

resource "aws_launch_template" "web" {
  # …
  lifecycle { create_before_destroy = true }  # new one exists before the old goes
}
\`\`\`

| Setting | Use it for | Watch out |
|---|---|---|
| \`prevent_destroy\` | Tables, buckets, KMS keys, databases | It's in the code: deleting the resource block also deletes the guard. Pair it with service-side deletion protection and backups |
| \`create_before_destroy\` | Things referenced by others: launch templates, certificates, security groups | Unique names clash (use \`name_prefix\`); it propagates to dependencies |
| \`ignore_changes\` | Attributes another system owns (autoscaled capacity, an image tag set by deploys, tags added by a compliance tool) | Easy to hide real drift. Never \`ignore_changes = all\` without a comment explaining why |
| \`replace_triggered_by\` | Force replacement when something else changes | |

\`terraform apply -replace=ADDRESS\` deliberately replaces one resource (the successor to \`taint\`).

> **Senior habit:** treat any plan line with \`-\` or \`-/+\` on a stateful resource as a deploy blocker until a human has explained it. Most "Terraform deleted our database" stories are a rename without \`moved\`, a \`count\` index shift, or a \`# forces replacement\` nobody read.
`,
    },
    // ---------------------------------------------------------------- reading 4
    {
      id: "pipeline",
      kind: "reading",
      title: "Policy as code, pipelines, and Terraform vs CloudFormation",
      minutes: 12,
      body: String.raw`
Code review catches intent. Machines catch the rest: invalid arguments, insecure defaults, destructive plans. A good Terraform pipeline layers several checks, from cheapest to most expensive.

## The pipeline

| Stage | Command | Catches |
|---|---|---|
| Format | \`terraform fmt -check -recursive\` | Style noise in diffs |
| Validate | \`terraform init -backend=false && terraform validate\` | Syntax, wrong types, unknown arguments |
| Lint | **tflint** (with the AWS ruleset) | Invalid instance types, deprecated syntax, unused declarations, naming rules |
| Static security | **Checkov**, **Trivy** (formerly tfsec) | Public buckets, unencrypted volumes, \`0.0.0.0/0\` ingress, wildcard IAM |
| Plan | \`terraform plan -out=tfplan -lock-timeout=5m\` | What will actually change in *this* environment |
| Plan policy | **OPA/conftest** or **Sentinel** on \`terraform show -json tfplan\` | "No deletes of stateful types", "tags required", "only approved regions", cost limits |
| Approval | A human reads the plan summary posted on the PR | Intent |
| Apply | \`terraform apply tfplan\` | Exactly the reviewed plan, nothing new |

Static tools look at code; **plan policies** look at consequences, which is where destructive changes become visible. A conftest rule over the plan JSON:

\`\`\`text
package terraform

stateful := {"aws_dynamodb_table", "aws_db_instance", "aws_s3_bucket", "aws_rds_cluster"}

deny[msg] {
  rc := input.resource_changes[_]
  stateful[rc.type]
  rc.change.actions[_] == "delete"
  msg := sprintf("%s would be deleted or replaced; add the 'allow-destroy' label", [rc.address])
}
\`\`\`

Sentinel is HashiCorp's policy language for HCP Terraform and Terraform Enterprise. OPA is the open-source equivalent you can run anywhere.

Other pipeline habits:

- **Credentials:** CI assumes a role through OIDC (GitHub Actions → \`sts:AssumeRoleWithWebIdentity\`). Use separate roles for plan (read-only plus state access) and apply (write), and a separate role per environment. There should be no long-lived access keys anywhere.
- **Concurrency:** one apply per state at a time (the lock enforces it; the pipeline should queue rather than fail).
- **Pin everything:** Terraform version (\`required_version\` and the CI image), providers (lock file), modules (tags).
- **Test against an emulator:** a job that runs \`terraform apply\` against the AWS emulator and then checks the result catches broken references, bad IAM JSON and wrong ARNs before anything touches an account. The same config then runs unchanged against AWS.

## Terraform vs CloudFormation

| | CloudFormation | Terraform |
|---|---|---|
| Where it runs | AWS service, server-side | Your machine or CI runner |
| State | Managed by AWS, nothing to store | State file you must store, lock, encrypt and back up |
| Language | YAML/JSON plus intrinsic functions (CDK and SAM generate it) | HCL with expressions, loops and functions (CDKTF exists) |
| Scope | AWS only (plus registry extensions) | Any API with a provider: AWS, Cloudflare, GitHub, Datadog, Kubernetes… |
| Preview | Change sets | \`terraform plan\` |
| Failure handling | Automatic rollback to the last good state | No rollback: a partial apply stops where it failed; you fix forward |
| New AWS features | Often on launch day | Usually quickly, sometimes weeks later (the \`awscc\` provider, generated from the Cloud Control API, is faster) |
| Drift | \`detect-stack-drift\` | Every plan refreshes; \`plan -refresh-only\` |
| Adopting resources | Change set of type \`IMPORT\` | \`import\` blocks with config generation |
| Refactoring | Logical ID changes mean replacement | \`moved\` blocks |
| Multi-account fan-out | StackSets | A provider or root config per account (or Terragrunt and similar tools) |
| Cost | Free | Free CLI; HCP Terraform is paid for teams |

Neither is "better". CloudFormation wins on zero state management, automatic rollback and AWS-native integration (Service Catalog, Control Tower, StackSets). Terraform wins on multi-provider estates, expressiveness, refactoring tools and a faster plan loop. Many organisations use both: CloudFormation StackSets for the account baseline that AWS's own tools expect, and Terraform for everything teams build on top.

> **Note on licensing:** Terraform has used the Business Source License since version 1.6. **OpenTofu** is the open-source fork under the Linux Foundation. It's command-compatible for everything in this module, including the S3 backend and \`use_lockfile\`.
`,
    },
    // ---------------------------------------------------------------- lab 1
    {
      id: "first-apply",
      kind: "lab",
      title: "Lab: A module, for_each and default tags",
      minutes: 30,
      body: String.raw`
Your team wants every queue to come with a dead-letter queue, consistent tags, and no copy-pasted resource blocks. The lab folder contains a small, typical layout:

\`\`\`text
versions.tf          terraform + provider version constraints (done)
providers.tf         the AWS provider, emulator settings, default_tags (done)
variables.tf         env, and a map of queues to create (done)
main.tf              your work: TODO 1-3
modules/queue/       a reusable "queue with DLQ" module (done: read it)
\`\`\`

Read \`modules/queue/main.tf\` first: it's the module you'll call once per entry in \`var.queues\`. Then:

\`\`\`bash
terraform init
terraform fmt && terraform validate
terraform plan
terraform apply
\`\`\`

> Creating an SQS queue through Terraform takes about 25 seconds here (the provider waits for the queue's attributes to settle). The two DLQs are created in parallel, then the two main queues, so expect an apply of about a minute.
`,
      lab: {
        files: {
          "versions.tf": versionsTf,
          "providers.tf": providersTf,
          "variables.tf": variablesTf,
          "main.tf": mainStarterTf,
          "modules/queue/main.tf": moduleMainTf,
          "modules/queue/variables.tf": moduleVariablesTf,
          "modules/queue/outputs.tf": moduleOutputsTf,
          ".gitignore": ".terraform/\n*.tfstate\n*.tfstate.*\ntfplan\n",
        },
        tasks: [
          {
            id: "init",
            title: "Initialise the working directory",
            description:
              "Run `terraform init` in the lab folder, so that the AWS provider is installed and the dependency lock file **`.terraform.lock.hcl`** records the exact version.",
            hints: ["`terraform init`", "In a real repository you would commit `.terraform.lock.hcl`, but never `.terraform/`."],
            check: async (ctx) => {
              const lock = await ctx.readFile(".terraform.lock.hcl");
              if (lock === null) return "`.terraform.lock.hcl` not found. Run `terraform init` in the lab folder.";
              if (!lock.includes("registry.terraform.io/hashicorp/aws")) return "The lock file doesn't pin `hashicorp/aws`. Run `terraform init` again.";
              return true;
            },
          },
          {
            id: "bucket",
            title: "A versioned, tagged bucket",
            description:
              "Complete **TODO 1**: Terraform must manage an S3 bucket **`tf-lab-artifacts`** with versioning **Enabled** (a separate `aws_s3_bucket_versioning` resource). Thanks to `default_tags`, it must also carry the tags `ManagedBy=terraform` and `Env=dev` without you writing a `tags` argument. Apply.",
            hints: [
              "Since provider v4, bucket settings are separate resources that reference the bucket: `bucket = aws_s3_bucket.artifacts.id`.",
              "```hcl\nresource \"aws_s3_bucket_versioning\" \"artifacts\" {\n  bucket = aws_s3_bucket.artifacts.id\n  versioning_configuration {\n    status = \"Enabled\"\n  }\n}\n```",
            ],
            check: async (ctx) => {
              const h = await ctx.tryAws(["s3api", "head-bucket", "--bucket", "tf-lab-artifacts"]);
              if (!h.ok) return "Bucket `tf-lab-artifacts` doesn't exist yet.";
              const v = await ctx.tryAws(["s3api", "get-bucket-versioning", "--bucket", "tf-lab-artifacts"]);
              if (v.data?.Status !== "Enabled") return `Versioning is ${v.data?.Status ?? "not configured"}; expected Enabled.`;
              const t = await ctx.tryAws(["s3api", "get-bucket-tagging", "--bucket", "tf-lab-artifacts"]);
              const tags = Object.fromEntries((t.data?.TagSet ?? []).map((x: any) => [x.Key, x.Value]));
              if (tags.ManagedBy !== "terraform" || tags.Env !== "dev")
                return `The bucket's tags are ${JSON.stringify(tags)}; expected ManagedBy=terraform and Env=dev from default_tags. Did you create the bucket with Terraform?`;
              return true;
            },
          },
          {
            id: "queues",
            title: "One module instance per queue",
            description:
              "Complete **TODO 2**: call `./modules/queue` with **`for_each = var.queues`**. After apply, the queues `orders` and `payments` must exist, each redriving to its own `<name>-dlq` with the `max_receive_count` and `visibility_timeout` from the map (orders: 3 / 30 s, payments: 5 / 60 s), and tagged by `default_tags`.",
            hints: [
              "Inside a `for_each` block, `each.key` is the map key and `each.value` is the object.",
              "```hcl\nmodule \"queue\" {\n  source   = \"./modules/queue\"\n  for_each = var.queues\n\n  name               = each.key\n  visibility_timeout = each.value.visibility_timeout\n  max_receive_count  = each.value.max_receive_count\n}\n```\nAdding a module means running `terraform init` again.",
            ],
            check: async (ctx) => {
              const want: Record<string, { vt: string; mrc: number }> = {
                orders: { vt: "30", mrc: 3 },
                payments: { vt: "60", mrc: 5 },
              };
              for (const [name, w] of Object.entries(want)) {
                const a = await queueAttrs(ctx, name);
                if (!a) return `Queue \`${name}\` doesn't exist yet.`;
                if (!a.RedrivePolicy) return `Queue \`${name}\` has no redrive policy.`;
                const rp = JSON.parse(a.RedrivePolicy);
                const dlq = `arn:aws:sqs:${ctx.region}:${ctx.account}:${name}-dlq`;
                if (rp.deadLetterTargetArn !== dlq) return `Queue \`${name}\` redrives to ${rp.deadLetterTargetArn}; expected ${dlq}.`;
                if (Number(rp.maxReceiveCount) !== w.mrc) return `Queue \`${name}\` has maxReceiveCount ${rp.maxReceiveCount}; expected ${w.mrc}.`;
                if (a.VisibilityTimeout !== w.vt) return `Queue \`${name}\` has VisibilityTimeout ${a.VisibilityTimeout}; expected ${w.vt}.`;
                const tags = await queueTags(ctx, name);
                if (tags.ManagedBy !== "terraform") return `Queue \`${name}\` isn't tagged ManagedBy=terraform. Was it created by Terraform?`;
              }
              return true;
            },
          },
          {
            id: "state",
            title: "Outputs and state addresses",
            description:
              "Complete **TODO 3** (a `queue_urls` output mapping queue name to URL) and apply. The local state file `terraform.tfstate` must then contain the `queue_urls` output with both queues, and resources addressed by **key** (`module.queue[\"orders\"]…`), not by index.",
            hints: [
              "`output \"queue_urls\" { value = { for k, m in module.queue : k => m.queue_url } }`",
              "Inspect with `terraform output queue_urls` and `terraform state list`.",
            ],
            check: async (ctx) => {
              const st = parseJson(await ctx.readFile("terraform.tfstate"));
              if (!st) return "`terraform.tfstate` not found (or not valid JSON) in the lab folder. Run `terraform apply`.";
              const urls = st.outputs?.queue_urls?.value;
              if (!urls || typeof urls !== "object") return "The state has no `queue_urls` output yet. Complete TODO 3 and apply.";
              for (const k of ["orders", "payments"])
                if (!String(urls[k] ?? "").endsWith(`/${ctx.account}/${k}`)) return `\`queue_urls["${k}"]\` is \`${urls[k]}\`; expected the URL of queue \`${k}\`.`;
              const modules = new Set((st.resources ?? []).filter((r: any) => r.mode === "managed" && r.module).map((r: any) => r.module));
              for (const k of ["orders", "payments"])
                if (!modules.has(`module.queue["${k}"]`))
                  return `No resources under \`module.queue["${k}"]\` in state. Found: ${stateAddresses(st).join(", ") || "none"}.`;
              return true;
            },
          },
        ],
        solution: String.raw`
cat > main.tf <<'EOF'
${mainSolutionTf}
EOF
terraform init -input=false -no-color
terraform fmt -check -recursive
terraform validate -no-color
terraform apply -auto-approve -input=false -no-color
terraform output -json queue_urls
`,
      },
    },
    // ---------------------------------------------------------------- lab 2
    {
      id: "remote-state",
      kind: "lab",
      title: "Lab: Remote state with S3-native locking",
      minutes: 30,
      body: String.raw`
**Prepare lab** created the state bucket **\`tfstate-platform\`** the way a platform team would: versioning on, default encryption, public access blocked. (In real life that bucket is bootstrapped once, by a small separate config or a CloudFormation stack, because a config can't store its state in a bucket it's about to create.)

The lab folder has two configurations:

\`\`\`text
platform/main.tf     owns /platform/dev/release; you add the S3 backend
app/main.tf          reads the platform's outputs through remote state
\`\`\`

Work in \`platform/\` first (\`cd platform\`, or use \`terraform -chdir=platform …\`). Watch the **API** tab during \`apply\`: you'll see the \`PutObject\` of the \`.tflock\` object (with \`If-None-Match\`), the state write, and the \`DeleteObject\` that releases the lock.

\`\`\`bash
aws s3api list-object-versions --bucket tfstate-platform \
  --query '{versions: Versions[].[Key,VersionId,IsLatest], deleteMarkers: DeleteMarkers[].[Key,IsLatest]}'
\`\`\`

To see locking protect you, hold a fake lock and try to plan (then clean up):

\`\`\`bash
echo '{"ID":"fake-lock","Operation":"OperationTypeApply","Who":"alice@laptop"}' > lock.json
aws s3api put-object --bucket tfstate-platform --key platform/dev/terraform.tfstate.tflock --body lock.json
terraform -chdir=platform plan
terraform -chdir=platform force-unlock -force fake-lock
\`\`\`
`,
      lab: {
        files: {
          "platform/main.tf": platformStarterTf,
          "app/main.tf": appStarterTf,
          ".gitignore": ".terraform/\n*.tfstate\n*.tfstate.*\n",
        },
        setup: String.raw`
aws s3api create-bucket --bucket tfstate-platform
aws s3api put-bucket-versioning --bucket tfstate-platform --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket tfstate-platform \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
aws s3api put-public-access-block --bucket tfstate-platform \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
`,
        tasks: [
          {
            id: "backend",
            title: "Store platform state in S3",
            description:
              "Add a `backend \"s3\"` block to `platform/main.tf` (bucket `tfstate-platform`, key **`platform/dev/terraform.tfstate`**, `use_lockfile = true`, `encrypt = true`, and the emulator settings from the TODO). Run `terraform init` and `terraform apply` in `platform/`. The state object must exist in the bucket and track `aws_ssm_parameter.release`, and there must be **no** local state file in `platform/`.",
            hints: [
              "The backend block goes **inside** the `terraform { }` block.",
              "If you ran `apply` before adding the backend, `terraform init` offers to copy the local state into S3 (`-migrate-state`). Say yes, then delete `platform/terraform.tfstate`.",
              "```hcl\n  backend \"s3\" {\n    bucket       = \"tfstate-platform\"\n    key          = \"platform/dev/terraform.tfstate\"\n    region       = \"us-east-1\"\n    use_lockfile = true\n    encrypt      = true\n\n    use_path_style              = true\n    skip_credentials_validation = true\n    skip_requesting_account_id  = true\n  }\n```",
            ],
            check: async (ctx) => {
              const r = await ctx.sh(`aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null`);
              const st = parseJson(r.code === 0 ? r.stdout : null);
              if (!st) return `No state object at s3://${STATE_BUCKET}/${STATE_KEY} yet.`;
              if (!stateAddresses(st).includes("aws_ssm_parameter.release"))
                return "The remote state doesn't track `aws_ssm_parameter.release` yet. Run `terraform apply` in `platform/`.";
              const local = parseJson(await ctx.readFile("platform/terraform.tfstate"));
              if (local && (local.resources ?? []).length)
                return "`platform/terraform.tfstate` still holds resources: state lives in two places. Migrate it (`terraform init -migrate-state`) and delete the local file.";
              const p = await ctx.tryAws(["ssm", "get-parameter", "--name", "/platform/dev/release"]);
              if (!p.ok) return "Parameter `/platform/dev/release` doesn't exist. Run `terraform apply` in `platform/`.";
              return true;
            },
          },
          {
            id: "locking",
            title: "Prove the lock was taken and released",
            description:
              "The working directory must be initialised with **`use_lockfile = true`**, and the bucket's version history must show that a lock object **`platform/dev/terraform.tfstate.tflock`** was written and then released (its current version is a delete marker). Any `plan` or `apply` does this.",
            hints: [
              "`terraform init` records the backend settings in `platform/.terraform/terraform.tfstate`.",
              "List the lock's history: `aws s3api list-object-versions --bucket tfstate-platform --prefix platform/dev/terraform.tfstate.tflock`.",
              "If a lock is still held (its latest version isn't a delete marker), confirm nobody is running Terraform, then `terraform force-unlock <ID>`.",
            ],
            check: async (ctx) => {
              const be = parseJson(await ctx.readFile("platform/.terraform/terraform.tfstate"));
              if (!be?.backend) return "`platform/` isn't initialised with a backend yet. Run `terraform init` in `platform/`.";
              if (be.backend.type !== "s3") return `The backend type is ${be.backend.type}; expected s3.`;
              if (be.backend.config?.use_lockfile !== true) return "The S3 backend is initialised without `use_lockfile = true`. Add it and re-run `terraform init -reconfigure`.";
              const v = await ctx.tryAws(["s3api", "list-object-versions", "--bucket", STATE_BUCKET, "--prefix", `${STATE_KEY}.tflock`]);
              const versions = (v.data?.Versions ?? []).filter((x: any) => x.Key === `${STATE_KEY}.tflock`);
              const markers = (v.data?.DeleteMarkers ?? []).filter((x: any) => x.Key === `${STATE_KEY}.tflock`);
              if (!versions.length) return "No lock object was ever written. Run `terraform apply` in `platform/` with `use_lockfile = true`.";
              if (versions.some((x: any) => x.IsLatest))
                return "The lock object still exists, so the state is locked. If no Terraform run is active, release it with `terraform force-unlock`.";
              if (!markers.some((x: any) => x.IsLatest)) return "The lock's history has no current delete marker.";
              return true;
            },
          },
          {
            id: "history",
            title: "Use state versioning as an undo button",
            description:
              "Deploy release **`v2`** (set the `release` variable, for example with `-var release=v2`) and apply. The state object now has at least two versions. Write the **VersionId of the previous (non-current) version** of `platform/dev/terraform.tfstate` into **`previous-state-version.txt`** in the lab folder: that's the object you would restore if a state write went wrong.",
            hints: [
              "`terraform -chdir=platform apply -var release=v2`",
              "`` aws s3api list-object-versions --bucket tfstate-platform --prefix platform/dev/terraform.tfstate --query 'Versions[?Key==`platform/dev/terraform.tfstate` && !IsLatest].VersionId | [0]' --output text > previous-state-version.txt ``",
            ],
            check: async (ctx) => {
              const p = await ctx.tryAws(["ssm", "get-parameter", "--name", "/platform/dev/release"]);
              if (p.data?.Parameter?.Value !== "v2") return `\`/platform/dev/release\` is \`${p.data?.Parameter?.Value}\`; expected v2.`;
              const v = await ctx.tryAws(["s3api", "list-object-versions", "--bucket", STATE_BUCKET, "--prefix", STATE_KEY]);
              const versions = (v.data?.Versions ?? []).filter((x: any) => x.Key === STATE_KEY);
              if (versions.length < 2) return `The state object has ${versions.length} version(s); expected at least 2 after the v2 apply.`;
              const f = await ctx.readFile("previous-state-version.txt");
              if (f === null) return "`previous-state-version.txt` not found in the lab folder (the folder that contains `platform/` and `app/`).";
              const id = f.trim();
              const match = versions.find((x: any) => x.VersionId === id);
              if (!match) return `\`${id.slice(0, 60)}\` isn't a version of ${STATE_KEY}.`;
              if (match.IsLatest) return "That's the *current* version. Write the VersionId of a previous one.";
              return true;
            },
          },
          {
            id: "remote-read",
            title: "Read another configuration's outputs",
            description:
              "Complete the TODOs in `app/main.tf`: a `terraform_remote_state` data source reading the platform state, and an SSM parameter **`/app/dev/platform-release-param`** whose value is the platform's `release_parameter_arn` output. Init and apply in `app/` (its own state can stay local for this lab).",
            hints: [
              "The data source's `config` takes the same settings as the backend block (no `use_lockfile`: reads don't lock).",
              "Reference it as `data.terraform_remote_state.platform.outputs.release_parameter_arn`.",
            ],
            check: async (ctx) => {
              const p = await ctx.tryAws(["ssm", "get-parameter", "--name", "/app/dev/platform-release-param"]);
              if (!p.ok) return "Parameter `/app/dev/platform-release-param` doesn't exist yet.";
              const want = `arn:aws:ssm:${ctx.region}:${ctx.account}:parameter/platform/dev/release`;
              if (p.data.Parameter.Value !== want) return `Its value is \`${p.data.Parameter.Value}\`; expected \`${want}\`.`;
              const st = parseJson(await ctx.readFile("app/terraform.tfstate"));
              const usesRemote = (st?.resources ?? []).some((r: any) => r.mode === "data" && r.type === "terraform_remote_state");
              if (!usesRemote) return "`app/` state has no `terraform_remote_state` data source. Read the value through remote state, don't hard-code it.";
              return true;
            },
          },
        ],
        solution: String.raw`
cat > platform/main.tf <<'EOF'
${platformSolutionTf}
EOF
grep -q 'use_lockfile = true' platform/main.tf
terraform -chdir=platform init -input=false -no-color
terraform -chdir=platform apply -auto-approve -input=false -no-color
terraform -chdir=platform apply -auto-approve -input=false -no-color -var release=v2
test ! -f platform/terraform.tfstate
aws s3api list-object-versions --bucket tfstate-platform --prefix platform/dev/terraform.tfstate \
  --query 'Versions[?Key==\`platform/dev/terraform.tfstate\` && !IsLatest].VersionId | [0]' --output text > previous-state-version.txt
cat previous-state-version.txt

cat > app/main.tf <<'EOF'
${appSolutionTf}
EOF
terraform -chdir=app init -input=false -no-color
terraform -chdir=app apply -auto-approve -input=false -no-color
`,
      },
    },
  ],
  quiz: [
    {
      q: "A config creates `aws_sqs_queue.worker` with `count = length(var.names)` and `names = [\"a\", \"b\", \"c\"]`. You remove `\"a\"`. What does the plan show?",
      options: [
        "Destroy queue a only",
        "worker[0] and worker[1] are changed or replaced (to b and c) and worker[2] is destroyed: identity is the list position",
        "No changes, because Terraform matches by name",
        "An error: count can't shrink",
      ],
      answer: 1,
      explain:
        "With `count`, addresses are indexes. Removing the first element shifts every later element down one index, so Terraform wants worker[0] to become b (queue names force replacement), and so on. With `for_each = toset(var.names)` the addresses are `worker[\"a\"]`, `worker[\"b\"]`… and only a is destroyed. Moving an existing `count` resource to `for_each` needs `moved` blocks.",
    },
    {
      q: "Two engineers run `terraform apply` on the same S3-backed state at the same moment, with `use_lockfile = true`. What happens?",
      options: [
        "Both applies run; the last state write wins",
        "The first one creates `<key>.tflock` with a conditional PUT; the second gets 412 PreconditionFailed and stops with \"Error acquiring the state lock\"",
        "S3 merges the two state files",
        "The second waits forever",
      ],
      answer: 1,
      explain:
        "S3-native locking writes the lock object with `If-None-Match: *`, which only succeeds if the object doesn't exist. The loser fails immediately, or waits up to `-lock-timeout`. Without locking, both would write state and one set of changes would silently disappear from it.",
    },
    {
      q: "Your state bucket is encrypted and private, and your variables for the RDS password are marked `sensitive = true`. Is the password safe from anyone who can `s3:GetObject` the state?",
      options: [
        "Yes, sensitive values are encrypted inside the state",
        "No: `sensitive` only redacts CLI output. The password is in the state in plain text, so state read access is secret access. Keep it out of state (for example `manage_master_user_password`) and restrict who can read the state",
        "Yes, Terraform never writes passwords to state",
        "Only if you use workspaces",
      ],
      answer: 1,
      explain:
        "State stores every attribute in clear text. Bucket encryption protects against stolen disks, not against principals with read access. Minimise secrets in state and treat state access as access to every secret in it.",
    },
    {
      q: "You're moving `aws_dynamodb_table.orders` into a module `module.data`. What stops Terraform from destroying and recreating the table?",
      options: [
        "`lifecycle { create_before_destroy = true }`",
        "A `moved { from = aws_dynamodb_table.orders, to = module.data.aws_dynamodb_table.orders }` block, which makes the plan show a move and no destroy",
        "Running `terraform apply -refresh-only`",
        "Nothing: modules always recreate resources",
      ],
      answer: 1,
      explain:
        "The address changed, so without help Terraform sees one resource removed and one added. A `moved` block records the rename declaratively, and it's reviewed and applied in every environment. `prevent_destroy` would turn the accident into a plan error, which is a good additional guard rail.",
    },
    {
      q: "During an incident, someone raised a queue's visibility timeout in the console. Tomorrow's pipeline runs `terraform apply`. What happens, and how do you see it first?",
      options: [
        "Terraform ignores changes it didn't make",
        "The refresh notices the difference and the plan reverts it to the code's value. `terraform plan -refresh-only` shows the out-of-band change on its own, so you can decide to codify it first",
        "The apply fails with a drift error",
        "Terraform updates the code to match",
      ],
      answer: 1,
      explain:
        "Terraform converges reality on the code, so manual fixes are undone unless they are put in the code. Refresh-only plans (and scheduled `plan -detailed-exitcode` runs) surface drift without proposing infrastructure changes.",
    },
    {
      q: "Which statement about Terraform workspaces vs directory-per-environment is most accurate for long-lived prod and dev environments in separate AWS accounts?",
      options: [
        "Workspaces are better because the code can't diverge",
        "Directory per environment (calling shared, versioned modules) is usually better: each env has its own backend, credentials and visible differences, and wrong-environment applies are much harder",
        "They're identical except for naming",
        "Workspaces are required for remote state",
      ],
      answer: 1,
      explain:
        "Workspaces share one backend configuration and usually one set of credentials, and the active workspace is invisible state in your shell. They're great for short-lived copies. Long-lived, separately-accounted environments benefit from explicit directories, each with its own backend and role.",
    },
    {
      q: "You're choosing between CloudFormation and Terraform for a team that manages AWS plus Cloudflare DNS and GitHub repositories, and wants rename-safe refactoring. Which trade-off matters most?",
      options: [
        "CloudFormation is the only tool with a preview step",
        "Terraform covers all three providers in one plan and has `moved` blocks; you take on storing, locking and securing state and must fix forward after failed applies (no automatic rollback)",
        "Terraform rolls back automatically on failure",
        "CloudFormation can manage GitHub natively",
      ],
      answer: 1,
      explain:
        "Multi-provider scope and refactoring tools favour Terraform. The price is state management and no transactional rollback: a failed apply leaves what it did and you fix forward. CloudFormation previews (change sets) and rolls back automatically, but only manages what its registry supports.",
    },
  ],
};
