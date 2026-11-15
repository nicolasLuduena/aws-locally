import type { CheckContext, Module } from "../types.ts";

// ---------------------------------------------------------------- helpers

type Ctx = Pick<CheckContext, "aws" | "tryAws">;

const AMI_PARAM = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64";
const tagOf = (r: any, key: string) => (r?.Tags ?? []).find((t: any) => t.Key === key)?.Value;

async function vpcId({ aws }: Ctx, name: string): Promise<string | null> {
  const d = await aws(["ec2", "describe-vpcs", "--filters", `Name=tag:Name,Values=${name}`]);
  return d.Vpcs?.[0]?.VpcId ?? null;
}

async function subnetIds({ aws }: Ctx, vpc: string): Promise<Record<string, string>> {
  const d = await aws(["ec2", "describe-subnets", "--filters", `Name=vpc-id,Values=${vpc}`]);
  return Object.fromEntries((d.Subnets ?? []).filter((s: any) => tagOf(s, "Name")).map((s: any) => [tagOf(s, "Name"), s.SubnetId]));
}

async function sgId({ aws }: Ctx, vpc: string, name: string): Promise<string | null> {
  const d = await aws(["ec2", "describe-security-groups", "--filters", `Name=vpc-id,Values=${vpc}`, `Name=group-name,Values=${name}`]);
  return d.SecurityGroups?.[0]?.GroupId ?? null;
}

async function ltVersion({ tryAws }: Ctx, name: string, version: string): Promise<any | string> {
  const r = await tryAws(["ec2", "describe-launch-template-versions", "--launch-template-name", name, "--versions", version]);
  if (!r.ok) return `Launch template \`${name}\` doesn't exist yet.`;
  return r.data.LaunchTemplateVersions?.[0] ?? `Launch template \`${name}\` has no version ${version}.`;
}

async function asg({ aws }: Ctx, name: string): Promise<any | null> {
  const d = await aws(["autoscaling", "describe-auto-scaling-groups", "--auto-scaling-group-names", name]);
  return d.AutoScalingGroups?.[0] ?? null;
}

const inService = (g: any) => (g.Instances ?? []).filter((i: any) => i.LifecycleState === "InService");
const profileName = (p: any) => p?.Name ?? String(p?.Arn ?? "").split("/").pop();

/** Decode base64 user data (atob exists in Node and browsers). */
function decode(b64: string): string {
  try {
    return atob(b64);
  } catch {
    return "";
  }
}

async function tg({ tryAws }: Ctx, name: string): Promise<any | null> {
  const r = await tryAws(["elbv2", "describe-target-groups", "--names", name]);
  return r.ok ? r.data.TargetGroups?.[0] ?? null : null;
}

async function alb({ tryAws }: Ctx, name: string): Promise<any | null> {
  const r = await tryAws(["elbv2", "describe-load-balancers", "--names", name]);
  return r.ok ? r.data.LoadBalancers?.[0] ?? null : null;
}

const forwardsTo = (action: any, tgArn: string) =>
  action?.Type === "forward" &&
  (action.TargetGroupArn === tgArn || (action.ForwardConfig?.TargetGroups ?? []).some((t: any) => t.TargetGroupArn === tgArn));

const pathValues = (rule: any): string[] =>
  (rule.Conditions ?? [])
    .filter((c: any) => c.Field === "path-pattern")
    .flatMap((c: any) => c.PathPatternConfig?.Values ?? c.Values ?? []);

// ---------------------------------------------------------------- lab setups

const LT_SETUP = String.raw`
if [ "$(aws ec2 describe-vpcs --filters Name=tag:Name,Values=compute-vpc --query 'length(Vpcs)' --output text)" = "0" ]; then
  VPC=$(aws ec2 create-vpc --cidr-block 10.2.0.0/16 \
    --tag-specifications 'ResourceType=vpc,Tags=[{Key=Name,Value=compute-vpc}]' --query Vpc.VpcId --output text)
  aws ec2 create-subnet --vpc-id "$VPC" --cidr-block 10.2.16.0/20 --availability-zone us-east-1a \
    --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=app-a}]' >/dev/null
  aws ec2 create-subnet --vpc-id "$VPC" --cidr-block 10.2.32.0/20 --availability-zone us-east-1b \
    --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=app-b}]' >/dev/null
  SG=$(aws ec2 create-security-group --vpc-id "$VPC" --group-name web-app-sg --description "Web app instances" --query GroupId --output text)
  aws ec2 authorize-security-group-ingress --group-id "$SG" --protocol tcp --port 8080 --cidr 10.2.0.0/16 >/dev/null
fi
VPC=$(aws ec2 describe-vpcs --filters Name=tag:Name,Values=compute-vpc --query 'Vpcs[0].VpcId' --output text)
echo "compute-vpc: $VPC"
aws ec2 describe-subnets --filters Name=vpc-id,Values="$VPC" --query 'Subnets[].[Tags[?Key==\`Name\`]|[0].Value, SubnetId, AvailabilityZone]' --output text
aws ec2 describe-security-groups --filters Name=vpc-id,Values="$VPC" Name=group-name,Values=web-app-sg --query 'SecurityGroups[0].[GroupName, GroupId]' --output text
`;

const ALB_SETUP = String.raw`
if [ "$(aws ec2 describe-vpcs --filters Name=tag:Name,Values=edge-vpc --query 'length(Vpcs)' --output text)" = "0" ]; then
  VPC=$(aws ec2 create-vpc --cidr-block 10.3.0.0/16 \
    --tag-specifications 'ResourceType=vpc,Tags=[{Key=Name,Value=edge-vpc}]' --query Vpc.VpcId --output text)
  mk() { aws ec2 create-subnet --vpc-id "$VPC" --cidr-block "$2" --availability-zone "$3" \
    --tag-specifications "ResourceType=subnet,Tags=[{Key=Name,Value=$1}]" --query Subnet.SubnetId --output text; }
  PA=$(mk public-a 10.3.0.0/24 us-east-1a); PB=$(mk public-b 10.3.1.0/24 us-east-1b)
  AA=$(mk app-a 10.3.16.0/20 us-east-1a);   AB=$(mk app-b 10.3.32.0/20 us-east-1b)
  IGW=$(aws ec2 create-internet-gateway --query InternetGateway.InternetGatewayId --output text)
  aws ec2 attach-internet-gateway --internet-gateway-id "$IGW" --vpc-id "$VPC"
  RT=$(aws ec2 create-route-table --vpc-id "$VPC" \
    --tag-specifications 'ResourceType=route-table,Tags=[{Key=Name,Value=public-rt}]' --query RouteTable.RouteTableId --output text)
  aws ec2 create-route --route-table-id "$RT" --destination-cidr-block 0.0.0.0/0 --gateway-id "$IGW" >/dev/null
  aws ec2 associate-route-table --route-table-id "$RT" --subnet-id "$PA" >/dev/null
  aws ec2 associate-route-table --route-table-id "$RT" --subnet-id "$PB" >/dev/null
  ALB_SG=$(aws ec2 create-security-group --vpc-id "$VPC" --group-name alb-sg --description "Public ALB" --query GroupId --output text)
  aws ec2 authorize-security-group-ingress --group-id "$ALB_SG" --protocol tcp --port 80 --cidr 0.0.0.0/0 >/dev/null
  aws ec2 authorize-security-group-ingress --group-id "$ALB_SG" --protocol tcp --port 443 --cidr 0.0.0.0/0 >/dev/null
  APP_SG=$(aws ec2 create-security-group --vpc-id "$VPC" --group-name app-sg --description "App instances" --query GroupId --output text)
  aws ec2 authorize-security-group-ingress --group-id "$APP_SG" --protocol tcp --port 8080 --source-group "$ALB_SG" >/dev/null
  AMI=$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 --query Parameter.Value --output text)
  aws ec2 create-launch-template --launch-template-name app-lt --launch-template-data \
    "{\"ImageId\":\"$AMI\",\"InstanceType\":\"t3.micro\",\"SecurityGroupIds\":[\"$APP_SG\"],\"MetadataOptions\":{\"HttpTokens\":\"required\",\"HttpPutResponseHopLimit\":1}}" >/dev/null
  aws autoscaling create-auto-scaling-group --auto-scaling-group-name app-asg \
    --launch-template 'LaunchTemplateName=app-lt,Version=$Default' \
    --min-size 2 --max-size 8 --desired-capacity 2 --vpc-zone-identifier "$AA,$AB"
fi
VPC=$(aws ec2 describe-vpcs --filters Name=tag:Name,Values=edge-vpc --query 'Vpcs[0].VpcId' --output text)
echo "edge-vpc: $VPC"
aws ec2 describe-subnets --filters Name=vpc-id,Values="$VPC" --query 'Subnets[].[Tags[?Key==\`Name\`]|[0].Value, SubnetId, AvailabilityZone]' --output text
aws ec2 describe-security-groups --filters Name=vpc-id,Values="$VPC" --query 'SecurityGroups[?GroupName!=\`default\`].[GroupName, GroupId]' --output text
`;

export const compute: Module = {
  id: "compute",
  number: "03",
  title: "Compute: EC2, Auto Scaling & Load Balancing",
  summary:
    "Run fleets, not servers: golden AMIs, launch templates with instance profiles and IMDSv2, self-healing Auto Scaling groups behind an Application Load Balancer, and immutable rolling deploys.",
  services: ["EC2", "EBS", "Auto Scaling", "ELBv2", "IAM", "SSM"],
  lessons: [
    // ------------------------------------------------------------------ 1
    {
      id: "instances",
      kind: "reading",
      title: "Instances, AMIs and EBS",
      minutes: 15,
      body: String.raw`
An EC2 instance is a virtual machine on the **Nitro** system: a lightweight hypervisor plus dedicated cards that handle networking, storage and security, which is why nearly all of a host's CPU is available to you. To run one well in production you choose three things: an **instance type** (how much hardware), an **AMI** (what it boots), and **EBS volumes** (where its disks live).

## Reading an instance type

\`m7g.2xlarge\` decodes as: family **m** (general purpose), generation **7**, attribute **g** (AWS Graviton, ARM64), size **2xlarge** (8 vCPU, 32 GiB). Each size step doubles the resources and the price.

| Family | Shape | Use for |
|---|---|---|
| **t** (t3, t4g) | Burstable: a CPU-credit baseline | Low, spiky load: dev boxes, small internal tools |
| **m** (m7i, m7g) | Balanced, 4 GiB per vCPU | The default for web and app servers |
| **c** (c7i, c7g) | Compute-heavy, 2 GiB per vCPU | CPU-bound APIs, batch jobs, encoding |
| **r / x** (r7i, x2idn) | Memory-heavy, 8+ GiB per vCPU | Caches, in-memory analytics, big JVMs |
| **i / d** (i4i, d3) | Fast local NVMe or dense HDD | Self-managed databases, Kafka, search |
| **g / p / inf / trn** | GPUs and ML accelerators | Training, inference, rendering |

Attribute letters to know: **g** = Graviton, **a** = AMD, **i** = Intel, **d** = local NVMe instance store, **n** = more network bandwidth, **e** = extra memory or storage, **flex** = cheaper "most of the time" performance.

How a senior engineer sizes:

- **Start from measurements**, not guesses. Load-test, watch CPU, memory (needs the CloudWatch agent: EC2 doesn't report memory by itself), network and EBS throughput, then pick the family whose ratio fits. **AWS Compute Optimizer** gives right-sizing recommendations from real usage.
- **Prefer Graviton** for anything that compiles for ARM64 (most interpreted languages, JVMs and Go/Rust/containers). It is typically 20–40% better on price-performance.
- **Beware burstable instances in production.** A \`t3\` earns CPU credits below its baseline (for example 10% for \`t3.micro\`) and spends them above it. In \`unlimited\` mode, the default for t3, sustained load bills you for surplus credits. In \`standard\` mode, the instance is throttled to its baseline once credits run out. Either surprises people.
- **Scale out, not up.** Several medium instances across AZs beat one large instance: you survive the loss of one, and an Auto Scaling group can add more.
- Newer generations are usually faster *and* cheaper. Old generations linger in IaC for years; upgrade them deliberately.

## AMIs and golden images

An **Amazon Machine Image** is a recipe for a root disk: one or more EBS snapshots, plus metadata (architecture, boot mode, virtualisation type) and launch permissions. AMIs are **regional**: copy them to every region you deploy to.

**Never hard-code AMI IDs.** They differ per region and change with every patch release. Resolve the latest Amazon Linux through the public SSM parameter, and pin the *result* into your launch template version so each deploy is reproducible:

\`\`\`bash
aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
  --query Parameter.Value --output text
aws ec2 describe-images --image-ids "$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 --query Parameter.Value --output text)" \
  --query 'Images[0].{name: Name, arch: Architecture, root: RootDeviceType}'
\`\`\`

There are two ways to get software onto a box, and production fleets use both:

| | Bake (golden AMI) | Bootstrap (user data at boot) |
|---|---|---|
| Build | Packer or EC2 Image Builder, in CI | cloud-init script on first boot |
| Boot time | Fast: everything is already installed | Slow: installs on every launch |
| Failure mode | Fails in CI, before deploy | Fails at 3 a.m. when the package mirror is down |
| Drift | None: every instance is identical | Two instances launched a week apart can differ |
| Good for | OS patches, runtimes, agents, the app itself | Per-environment config, secrets lookup, registration |

A **golden image pipeline** builds a hardened AMI from the latest base image on a schedule (CIS benchmarks, security agents, CloudWatch agent, SSM agent), runs tests against it, shares it to workload accounts, and **deprecates** old AMIs. Scaling out then takes seconds instead of minutes, which matters when a traffic spike arrives.

> **On real AWS:** \`create-image\` snapshots a running instance into an AMI. The emulator doesn't implement \`CreateImage\` (it returns 501), so in this course AMIs come from the SSM parameter. In a real pipeline, Packer or Image Builder calls it for you.

## EBS: network block storage

An EBS volume is a network-attached disk that lives in **one AZ** and attaches to instances in that AZ only. It's replicated inside the AZ, but an AZ failure still takes it with it, which is why durable data needs snapshots or a multi-AZ service.

| Type | Performance | Use for |
|---|---|---|
| **gp3** | 3,000 IOPS and 125 MiB/s baseline *regardless of size*, provisionable up to 16,000 IOPS / 1,000 MiB/s | The default for almost everything |
| gp2 | IOPS scale with size (3 per GiB), with burst credits | Legacy. Migrate to gp3: it's about 20% cheaper and has no credit cliff |
| **io2 Block Express** | Up to 256,000 IOPS, 99.999% durability, sub-ms latency | Large relational databases |
| st1 / sc1 | Throughput-optimised and cold HDD | Big sequential reads: logs, data lakes. Can't be a boot volume |
| Instance store | Local NVMe, very fast, **lost when the instance stops** | Caches, scratch space, replicated data stores |

Things that bite:

- **Encrypt everything**: turn on account-level *EBS encryption by default* in every region (\`aws ec2 enable-ebs-encryption-by-default\`). Encryption is transparent and has no measurable performance cost, and you can't encrypt an existing volume in place.
- **Snapshots are incremental** and stored in S3 (regionally). The first one copies all used blocks; later ones store only changed blocks. Automate them with **Data Lifecycle Manager** or **AWS Backup**, and test restores.
- A volume restored from a snapshot **loads lazily**: first reads of each block come from S3 and are slow. Pre-warm it, or enable Fast Snapshot Restore, before putting a restored database volume under load.
- \`DeleteOnTermination\` defaults to **true** for the root volume and **false** for extra volumes, so terminated instances leave orphaned volumes behind that you keep paying for.

Try a gp3 volume with provisioned performance, then snapshot it:

\`\`\`bash
VOL=$(aws ec2 create-volume --availability-zone us-east-1a --size 50 --volume-type gp3 \
  --iops 6000 --throughput 250 --encrypted \
  --tag-specifications 'ResourceType=volume,Tags=[{Key=Name,Value=demo-data}]' --query VolumeId --output text)
aws ec2 wait volume-available --volume-ids "$VOL"
aws ec2 create-snapshot --volume-id "$VOL" --description "demo nightly" --query '[SnapshotId, State]'
\`\`\`

Note the \`creating\` → \`available\` transition and the waiter: EBS is asynchronous, like every control plane.
`,
    },
    // ------------------------------------------------------------------ 2
    {
      id: "bootstrap-identity",
      kind: "reading",
      title: "User data, instance profiles and IMDSv2",
      minutes: 14,
      body: String.raw`
An instance needs two things at boot: **configuration** (what to run, with which settings) and **identity** (permission to call AWS APIs). User data provides the first; an instance profile, served through the instance metadata service, provides the second.

## User data and cloud-init

**User data** is up to 16 KB of text you attach at launch (base64-encoded in the API). On Amazon Linux, Ubuntu and most other images, **cloud-init** reads it on the **first boot only** and runs it as **root**:

- A script starting with \`#!\` runs as a shell script (cloud-init's \`scripts-user\` stage, late in boot).
- \`#cloud-config\` YAML declaratively installs packages, writes files, creates users and runs commands.
- Several parts can be combined in a MIME multipart document.

Output lands in \`/var/log/cloud-init-output.log\`: the first place to look when an instance comes up "healthy" but the app isn't running. Changing user data on a launch template affects only *new* instances, and a reboot doesn't re-run it.

\`\`\`yaml
#cloud-config
package_update: true
packages: [nginx]
write_files:
  - path: /etc/app/env
    content: |
      APP_ENV=prod
runcmd:
  - systemctl enable --now nginx
\`\`\`

Rules of thumb:

- **Keep user data thin.** Install software in the AMI. Use user data for the small, per-environment remainder: write config, fetch secrets, start services, register with a service. The longer user data runs, the longer every scale-out takes, and the more ways it can fail.
- **Never put secrets in user data.** Anyone with \`ec2:DescribeInstanceAttribute\` can read it, and any process on the box can read it from the metadata service. Fetch secrets at boot from Secrets Manager or SSM Parameter Store, using the instance's role.
- **Fail loudly**: \`set -euo pipefail\`. A script that half-succeeds produces an instance that passes EC2 health checks but serves errors.

## Instance profiles: never put keys on boxes

An **instance profile** is a container for one IAM role that you attach to an instance. The instance then gets **temporary credentials** for that role, rotated automatically (they expire after a few hours and are refreshed well before), and every AWS SDK and the CLI find them on their own through the default credential chain.

This replaces the worst anti-pattern in AWS: long-lived access keys in \`~/.aws/credentials\`, environment variables or config files on servers. Those keys get baked into AMIs, copied into backups, committed to Git, and never rotated. With a role, there is nothing to leak that lasts longer than a few hours, and CloudTrail shows exactly which instance made each call.

\`\`\`bash
aws iam create-role --role-name demo-ec2-role --query Role.Arn --assume-role-policy-document '{
  "Version": "2012-10-17",
  "Statement": [{"Effect": "Allow", "Principal": {"Service": "ec2.amazonaws.com"}, "Action": "sts:AssumeRole"}]
}'
aws iam attach-role-policy --role-name demo-ec2-role --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
aws iam create-instance-profile --instance-profile-name demo-ec2-profile --query InstanceProfile.Arn
aws iam add-role-to-instance-profile --instance-profile-name demo-ec2-profile --role-name demo-ec2-role
\`\`\`

The trust policy names the **EC2 service** as the principal that may assume the role. \`AmazonSSMManagedInstanceCore\` lets the SSM agent register the instance, which gives you **Session Manager** shell access with no SSH keys, no port 22, no bastion host, and every session logged. That's the modern default. Add the app's own least-privilege permissions as a separate policy.

## The instance metadata service, and why IMDSv2

Every instance can reach a link-local HTTP service at \`169.254.169.254\` that returns its ID, AZ, network details, user data, and, at \`/latest/meta-data/iam/security-credentials/<role>\`, the role's temporary credentials.

<figure class="diagram">
<svg viewBox="0 0 640 230" role="img" aria-label="With IMDSv2 the SDK first PUTs for a session token, then sends the token with a GET to fetch role credentials, then signs AWS API calls with them">
  <rect x="10" y="10" width="300" height="210" rx="10" class="d-box d-outer"/><text x="26" y="32" class="d-label">EC2 instance</text>
  <rect x="30" y="50" width="140" height="150" rx="8" class="d-box"/><text x="100" y="78" text-anchor="middle" class="d-label">App + SDK</text><text x="100" y="98" text-anchor="middle" class="d-small">default credential</text><text x="100" y="114" text-anchor="middle" class="d-small">provider chain</text>
  <rect x="350" y="50" width="130" height="80" rx="8" class="d-box d-accent"/><text x="415" y="80" text-anchor="middle" class="d-label">IMDS</text><text x="415" y="100" text-anchor="middle" class="d-small">169.254.169.254</text>
  <rect x="510" y="50" width="120" height="80" rx="8" class="d-box"/><text x="570" y="80" text-anchor="middle" class="d-label">Instance</text><text x="570" y="100" text-anchor="middle" class="d-small">profile → role</text>
  <rect x="350" y="150" width="280" height="56" rx="8" class="d-box d-ok"/><text x="490" y="174" text-anchor="middle" class="d-label">AWS APIs (S3, SQS, …)</text><text x="490" y="192" text-anchor="middle" class="d-small">SigV4 with temporary credentials</text>
  <path d="M170 66 H348" class="d-arrow"/><text x="260" y="60" text-anchor="middle" class="d-small">1. PUT /api/token (TTL)</text>
  <path d="M348 90 H172" class="d-arrow d-dashed"/><text x="260" y="84" text-anchor="middle" class="d-small">token</text>
  <path d="M170 116 H348" class="d-arrow"/><text x="260" y="110" text-anchor="middle" class="d-small">2. GET …/security-credentials</text>
  <path d="M480 90 H508" class="d-arrow d-dashed"/>
  <path d="M170 178 H348" class="d-arrow"/><text x="260" y="172" text-anchor="middle" class="d-small">3. signed API call</text>
</svg>
<figcaption>IMDSv2 requires a session token obtained with an HTTP PUT. A plain GET, which is all most SSRF bugs can make, gets nothing.</figcaption>
</figure>

**IMDSv1** answers any plain \`GET\`. If your app has a **server-side request forgery** bug (it fetches a URL an attacker controls), the attacker points it at \`http://169.254.169.254/latest/meta-data/iam/security-credentials/\` and walks away with your role's credentials. That's how the 2019 Capital One breach exfiltrated over 100 million records.

**IMDSv2** requires a session token: first \`PUT /latest/api/token\` with a TTL header, then send the token as a header on every request. SSRF bugs almost never let an attacker choose the method and headers, and a PUT carrying an \`X-Forwarded-For\` header is refused. The token response also has an IP **hop limit** (TTL): with \`HttpPutResponseHopLimit=1\`, the token can't leave the instance. Use **2** on hosts that run containers with bridge networking, because the container is one extra hop away.

Enforce it everywhere:

- In every launch template: \`MetadataOptions: {HttpTokens: required, HttpPutResponseHopLimit: 1}\`.
- As the **account default** per region: \`aws ec2 modify-instance-metadata-defaults --http-tokens required\`.
- With an SCP or IAM condition that denies \`ec2:RunInstances\` unless \`ec2:MetadataHttpTokens\` is \`required\`.

Launch an instance into a default subnet with all of this applied, and look at what you get:

\`\`\`bash
AMI=$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 --query Parameter.Value --output text)
SUBNET=$(aws ec2 describe-subnets --filters Name=default-for-az,Values=true --query 'Subnets[0].SubnetId' --output text)
IID=$(aws ec2 run-instances --image-id "$AMI" --instance-type t3.micro --subnet-id "$SUBNET" \
  --iam-instance-profile Name=demo-ec2-profile \
  --metadata-options HttpTokens=required,HttpPutResponseHopLimit=1,HttpEndpoint=enabled \
  --user-data '#!/bin/bash
echo hello from user data > /tmp/hello' \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=demo-web}]' --query 'Instances[0].InstanceId' --output text)
aws ec2 wait instance-running --instance-ids "$IID"
aws ec2 describe-instances --instance-ids "$IID" --query 'Reservations[0].Instances[0].{state: State.Name, ip: PrivateIpAddress, az: Placement.AvailabilityZone, profile: IamInstanceProfile.Arn, imds: MetadataOptions.HttpTokens}'
aws ec2 describe-instance-attribute --instance-id "$IID" --attribute userData --query UserData.Value --output text | base64 -d
\`\`\`

The CLI base64-encodes \`--user-data\` for you. In a launch template's JSON you encode it yourself. The last command shows why secrets don't belong there: user data is readable by anyone with describe permissions.

> **On real AWS:** the instance would boot, cloud-init would run the script, and the SDK on the box would pick up \`demo-ec2-role\` credentials from IMDS. The emulator is control plane only: the instance gets an ID, a private IP and a \`running\` state, but no VM boots, so nothing serves \`169.254.169.254\` and user data never executes.
`,
    },
    // ------------------------------------------------------------------ 3
    {
      id: "auto-scaling",
      kind: "reading",
      title: "Launch templates and Auto Scaling groups",
      minutes: 16,
      body: String.raw`
In production you don't launch instances: you describe the instance you want in a **launch template**, and an **Auto Scaling group** (ASG) keeps the right number of them running, across AZs, replacing any that fail. Even a "single server" belongs in an ASG with min = max = 1: it then heals itself.

## Launch templates and versioning

A launch template holds everything \`run-instances\` would take: AMI, instance type, instance profile, security groups, user data, metadata options, EBS mappings, tags. Templates are **versioned and immutable**: every change creates a new numbered version.

- Create new versions *from* an existing one with \`--source-version\` and pass only what changes. Everything else is inherited.
- Two moving aliases: **\`$Latest\`** (the newest version) and **\`$Default\`** (a version you promote explicitly with \`modify-launch-template --default-version\`).
- Point the ASG at **\`$Default\`** or at an explicit number, never at \`$Latest\`. With \`$Latest\`, anyone who creates a version, even a draft for testing, changes what the next scale-out launches, in the middle of the night, with no deploy.
- Launch *configurations* are the deprecated predecessor. New accounts can't create them; migrate any you find.

## Capacity: min, max, desired

| Setting | Meaning |
|---|---|
| \`MinSize\` | Never fewer. Size it to survive an AZ loss at baseline traffic. |
| \`MaxSize\` | Never more. A blast-radius and cost guard against runaway scaling. |
| \`DesiredCapacity\` | The current target. Scaling policies and humans move it between min and max. |

The ASG spreads instances evenly across the subnets (AZs) you give it and **rebalances** if one AZ gets ahead. If an AZ has no capacity for your instance type, it launches in the others. Give it subnets in at least two AZs, ideally three.

## Health checks: what "unhealthy" means

- **EC2** health checks (the default) only notice a dead VM: a failed status check or a stopped instance. A box whose app has crashed is still "healthy".
- **ELB** health checks also mark an instance unhealthy when the load balancer's target group reports it unhealthy. **Turn this on for every ASG behind a load balancer**, or the ASG will happily keep a fleet of broken instances.
- The **health check grace period** (for example 120 s) keeps the ASG from killing instances that are still booting. Set it a bit longer than your real boot-to-healthy time. Too short gives you a launch–kill loop; too long delays the replacement of genuinely bad instances.

Unhealthy instances are **terminated and replaced**, not repaired. That's the point: instances are cattle, and their state belongs elsewhere (RDS, S3, EFS, a cache).

## Scaling policies

| Policy | How it works | Use when |
|---|---|---|
| **Target tracking** | "Keep average CPU at 50%" or "1,000 requests per target". The ASG creates and manages the CloudWatch alarms for you. | The default for most services |
| **Step scaling** | Your alarm, with steps: +1 when 10–20% over the threshold, +3 above that | You need asymmetric or aggressive reactions |
| Simple scaling | One alarm, one adjustment, then a cooldown | Legacy. Use step scaling instead. |
| **Scheduled** | Set min/max/desired on a cron expression | Known patterns: business hours, a nightly batch, a launch event |
| **Predictive** | Forecasts from 14 days of history and scales ahead of the curve | Strongly cyclical traffic with slow-booting instances |

Pick a metric that tracks *load*: \`ALBRequestCountPerTarget\` is often better than CPU for web tiers, because it doesn't depend on how efficient the code is. Scale out fast and in slowly. Target tracking does this by design, scaling in conservatively. Set **instance warmup** so new instances' cold-start metrics don't trigger more scaling.

> **On real AWS:** scheduled actions work as described. The emulator doesn't implement \`PutScheduledUpdateGroupAction\` (it returns 501), so the labs use target tracking only.

## Lifecycle hooks and warm pools

A **lifecycle hook** pauses an instance in \`Pending:Wait\` (on launch) or \`Terminating:Wait\` (on termination) for up to the heartbeat timeout, and emits an EventBridge event. Your automation does its work, then calls \`complete-lifecycle-action\`:

- **On launch**: wait for a configuration step to finish, or register with service discovery, before the instance takes traffic.
- **On termination**: drain a queue worker, upload logs, deregister from a cluster.

The \`DefaultResult\` (\`CONTINUE\` or \`ABANDON\`) applies if nobody answers before the timeout. **Warm pools** keep pre-initialised, stopped instances ready, so scale-out takes seconds even with a slow boot.

## Paying less: Spot and Savings Plans

- **Spot instances** are spare EC2 capacity at up to 90% off, which AWS can reclaim with a **two-minute warning**. They suit stateless, fault-tolerant fleets: web tiers behind an ALB, CI runners, batch and queue workers. Use a **mixed instances policy** on the ASG: an on-demand base (for example 2 instances), Spot above it, the \`price-capacity-optimized\` allocation strategy, **many instance types** (\`m7i.large\`, \`m6i.large\`, \`m7a.large\`, …) so one capacity pool running dry doesn't hurt, and **Capacity Rebalancing** so the ASG replaces at-risk instances proactively.
- **Savings Plans** are a 1- or 3-year commitment to a dollar amount of compute per hour, in return for up to about 70% off on-demand prices. Compute Savings Plans apply across instance families, regions, Fargate and Lambda. Commit to your *steady-state baseline*, and cover peaks with on-demand and Spot.

\`\`\`bash
aws ec2 describe-spot-price-history --instance-types m7i.large m7g.large --product-descriptions Linux/UNIX \
  --max-items 4 --query 'SpotPriceHistory[].[InstanceType, AvailabilityZone, SpotPrice]' --output table
\`\`\`

## Try it: templates and the two aliases

\`\`\`bash
AMI=$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 --query Parameter.Value --output text)
aws ec2 create-launch-template --launch-template-name demo-lt --version-description "v1 baseline" \
  --launch-template-data "{\"ImageId\":\"$AMI\",\"InstanceType\":\"t3.micro\",\"MetadataOptions\":{\"HttpTokens\":\"required\"}}" \
  --query 'LaunchTemplate.[LaunchTemplateId, DefaultVersionNumber, LatestVersionNumber]'
aws ec2 create-launch-template-version --launch-template-name demo-lt --source-version 1 \
  --version-description "v2 bigger" --launch-template-data '{"InstanceType":"t3.small"}' --query LaunchTemplateVersion.VersionNumber
aws ec2 describe-launch-template-versions --launch-template-name demo-lt --versions '$Default' '$Latest' \
  --query 'LaunchTemplateVersions[].{v: VersionNumber, default: DefaultVersion, type: LaunchTemplateData.InstanceType, imds: LaunchTemplateData.MetadataOptions.HttpTokens}'
\`\`\`

Version 2 inherited the IMDSv2 setting from version 1 and only changed the type. \`$Latest\` is now 2, but \`$Default\` is still 1, so an ASG on \`$Default\` keeps launching \`t3.micro\` until you promote version 2.
`,
    },
    // ------------------------------------------------------------------ 4
    {
      id: "load-balancing",
      kind: "reading",
      title: "Elastic Load Balancing: ALB, NLB and GWLB",
      minutes: 15,
      body: String.raw`
A load balancer gives a fleet one stable entry point, spreads traffic across healthy targets in several AZs, and takes unhealthy ones out of rotation. Elastic Load Balancing v2 (\`elbv2\`) has three types:

| | **ALB** (Application) | **NLB** (Network) | **GWLB** (Gateway) |
|---|---|---|---|
| Layer | 7: HTTP/1.1, HTTP/2, gRPC, WebSocket | 4: TCP, UDP, TLS | 3: IP packets (GENEVE) |
| Routing | Host, path, header, method, query string, source IP | Port only | To appliance fleets |
| Addresses | DNS name; node IPs change as it scales | **Static IP or Elastic IP per AZ** | — |
| Client IP | In \`X-Forwarded-For\` | Preserved | Preserved |
| Extras | TLS termination with ACM, WAF, OIDC/Cognito auth, redirects, fixed responses | Millions of requests per second, very low latency, PrivateLink services | Inline firewalls and IDS (Palo Alto, Fortinet…) |
| Typical use | Web apps and APIs | Non-HTTP protocols, static IPs for allow-lists, extreme throughput | Central traffic inspection |

Most web workloads want an ALB. Reach for an NLB when you need static IPs, non-HTTP protocols, or a PrivateLink endpoint service.

## Anatomy: listener → rules → target group → targets

<figure class="diagram">
<svg viewBox="0 0 640 300" role="img" aria-label="An ALB listener evaluates rules by priority and forwards to target groups whose health-checked targets are instances in two AZs">
  <rect x="10" y="20" width="110" height="60" rx="8" class="d-box"/><text x="65" y="46" text-anchor="middle" class="d-label">Clients</text><text x="65" y="64" text-anchor="middle" class="d-small">internet</text>
  <rect x="150" y="10" width="200" height="280" rx="10" class="d-box d-outer"/><text x="164" y="32" class="d-label">ALB (public subnets, 2 AZs)</text>
  <rect x="166" y="44" width="168" height="40" rx="6" class="d-box d-accent"/><text x="250" y="69" text-anchor="middle" class="d-label">Listener HTTPS :443</text>
  <rect x="166" y="100" width="168" height="40" rx="6" class="d-box d-danger"/><text x="250" y="118" text-anchor="middle" class="d-small">prio 5  /admin/*</text><text x="250" y="132" text-anchor="middle" class="d-small">fixed-response 403</text>
  <rect x="166" y="152" width="168" height="40" rx="6" class="d-box"/><text x="250" y="170" text-anchor="middle" class="d-small">prio 10  /api/*</text><text x="250" y="184" text-anchor="middle" class="d-small">forward api-tg</text>
  <rect x="166" y="204" width="168" height="40" rx="6" class="d-box"/><text x="250" y="222" text-anchor="middle" class="d-small">default</text><text x="250" y="236" text-anchor="middle" class="d-small">forward web-tg</text>
  <path d="M120 50 H164" class="d-arrow"/>
  <rect x="390" y="140" width="110" height="64" rx="8" class="d-box d-accent"/><text x="445" y="166" text-anchor="middle" class="d-label">api-tg</text><text x="445" y="184" text-anchor="middle" class="d-small">GET /api/healthz</text>
  <rect x="390" y="214" width="110" height="64" rx="8" class="d-box d-accent"/><text x="445" y="240" text-anchor="middle" class="d-label">web-tg</text><text x="445" y="258" text-anchor="middle" class="d-small">GET /healthz</text>
  <path d="M334 172 H388" class="d-arrow"/><path d="M334 228 H388" class="d-arrow"/>
  <rect x="530" y="140" width="100" height="40" rx="6" class="d-box d-ok"/><text x="580" y="165" text-anchor="middle" class="d-small">api ASG (a, b)</text>
  <rect x="530" y="200" width="100" height="36" rx="6" class="d-box d-ok"/><text x="580" y="223" text-anchor="middle" class="d-small">web i-1 (AZ a)</text>
  <rect x="530" y="244" width="100" height="36" rx="6" class="d-box d-ok"/><text x="580" y="267" text-anchor="middle" class="d-small">web i-2 (AZ b)</text>
  <path d="M500 172 H528" class="d-arrow"/><path d="M500 236 H528" class="d-arrow"/><path d="M500 256 H528" class="d-arrow"/>
</svg>
<figcaption>Rules are evaluated in priority order (lowest first). The first match wins; the default action catches the rest. Each target group health-checks its own targets.</figcaption>
</figure>

- A **listener** is a protocol and port (\`HTTPS:443\`). Production ALBs terminate TLS with an **ACM certificate** and a modern security policy (for example \`ELBSecurityPolicy-TLS13-1-2-2021-06\`), plus an \`HTTP:80\` listener whose only action is a **301 redirect to HTTPS**.
- **Rules** have a priority (1–50,000), conditions (\`path-pattern\`, \`host-header\`, \`http-header\`, \`query-string\`, \`source-ip\`, \`http-request-method\`) and actions (\`forward\`, \`redirect\`, \`fixed-response\`, \`authenticate-oidc\`). A \`forward\` can split traffic across several target groups **by weight**, which is how you do canary and blue/green at the load balancer.
- A **target group** routes to instances, IPs or Lambda functions on a port. An ASG attached to a target group **registers and deregisters its instances automatically**.

## Health checks

Each target group probes each target (for example \`GET /healthz\` every 10 s; 2 successes = healthy; 3 failures = unhealthy; expect \`200\`). Design the endpoint carefully:

- It should answer "**can this instance serve traffic?**", cheaply. Checking that the process is up and its config loaded is right. Checking every downstream dependency is wrong: when the database blips, *every* target fails its check at once and the ALB has nothing to route to.
- If all targets in a target group are unhealthy, the ALB **fails open** and routes to all of them anyway, on the theory that something is better than nothing.
- With an ASG on **ELB health checks**, a target that fails here gets replaced, not just bypassed.

## Draining, cross-zone, and the knobs that matter

- **Deregistration delay** (default **300 s**): when a target is deregistered (scale-in, deploy), the ALB stops sending it *new* requests but lets in-flight ones finish for up to this long. Five minutes makes every deploy and scale-in slow. Set it a little longer than your slowest normal request: 30 s is typical for APIs.
- **Slow start**: ramps traffic to new targets gradually, for caches and JITs that need warming.
- **Cross-zone load balancing** spreads requests evenly across *all* healthy targets in all AZs, not just those in the node's own AZ. It's always on for ALBs (free) and off by default for NLBs (where cross-AZ traffic is billed). With it off and uneven AZs, the instances in the smaller AZ get overloaded.
- **Idle timeout** (60 s default): raise it for long-polling or WebSocket clients.
- \`routing.http.drop_invalid_header_fields.enabled\`: turn it on. It drops malformed headers that are a request-smuggling vector, and security scanners flag ALBs without it.
- **Security groups**: the ALB has its own SG (443 from the world). Targets allow the app port **only from the ALB's SG**, as in the VPC module.

## Try it: an ALB that answers by itself

The emulator's ALBs really serve HTTP on their \`DNSName\`, so you can watch rules and fixed responses work. Build one in the default subnets:

\`\`\`bash
SUBNETS=$(aws ec2 describe-subnets --filters Name=default-for-az,Values=true --query 'Subnets[0:2].SubnetId' --output text)
LB=$(aws elbv2 create-load-balancer --name demo-alb --type application --scheme internet-facing --subnets $SUBNETS \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text)
aws elbv2 wait load-balancer-available --load-balancer-arns "$LB"
LSN=$(aws elbv2 create-listener --load-balancer-arn "$LB" --protocol HTTP --port 80 \
  --default-actions 'Type=fixed-response,FixedResponseConfig={StatusCode=404,ContentType=text/plain,MessageBody=no route}' \
  --query 'Listeners[0].ListenerArn' --output text)
aws elbv2 create-rule --listener-arn "$LSN" --priority 10 --conditions Field=path-pattern,Values='/status' \
  --actions 'Type=fixed-response,FixedResponseConfig={StatusCode=200,ContentType=text/plain,MessageBody=all good}' >/dev/null
DNS=$(aws elbv2 describe-load-balancers --load-balancer-arns "$LB" --query 'LoadBalancers[0].DNSName' --output text)
curl -s -w '  [%{http_code}]\n' "http://$DNS/status"
curl -s -w '  [%{http_code}]\n' "http://$DNS/anything-else"
\`\`\`

Now forward the default action to a target group with no targets, and you get the ALB's own \`503\`:

\`\`\`bash
VPC=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)
TG=$(aws elbv2 create-target-group --name demo-tg --protocol HTTP --port 8080 --vpc-id "$VPC" \
  --query 'TargetGroups[0].TargetGroupArn' --output text)
aws elbv2 modify-listener --listener-arn "$LSN" --default-actions Type=forward,TargetGroupArn="$TG" >/dev/null
curl -s -o /dev/null -w '[%{http_code}]\n' "http://$DNS/"
\`\`\`

Learn the ALB's own status codes, because they tell you where to look: **503** means no healthy targets are registered; **502** means a target answered badly or reset the connection; **504** means a target didn't answer before the idle timeout. In the emulator, instances never boot, so a target group with registered instances returns 502.

> **On real AWS:** an internet-facing ALB requires its VPC to have an internet gateway, and an HTTPS listener requires an **issued** ACM certificate. The emulator accepts both without checking, so it can't catch those mistakes for you. The labs use plain HTTP listeners.
`,
    },
    // ------------------------------------------------------------------ 5
    {
      id: "deployments",
      kind: "reading",
      title: "Deploying to fleets: mutable vs immutable",
      minutes: 10,
      body: String.raw`
There are two ways to change what a fleet runs.

**Mutable (in-place)**: log in, or push with SSM Run Command, Ansible or CodeDeploy, and update the software on the existing instances. It's fast and uses no extra capacity. But every instance slowly becomes unique ("configuration drift"), a half-failed deploy leaves a mixed fleet that's hard to reason about, and rollback means running the deploy *again* in reverse, under pressure.

**Immutable**: never change a running instance. Build a new AMI (or container image), create a new launch template version that points at it, and **replace** the instances. Rollback means pointing back at the previous version, which still exists, unchanged.

| | Mutable | Immutable |
|---|---|---|
| Speed | Fast | Slower (launch + warm-up) |
| Extra capacity | None | Temporary surge, or reduced capacity while rolling |
| Drift | Accumulates | None: every instance comes from one artifact |
| Rollback | Re-run a deploy | Switch back to the previous version |
| Tested artifact | The deploy *process* | The exact image that runs in production |

Production fleets should be immutable. Treat in-place changes as an emergency tool, and follow any emergency change with a proper immutable rollout.

## Rolling with instance refresh

An ASG **instance refresh** replaces instances in batches so the fleet always keeps \`MinHealthyPercentage\` of its capacity healthy:

<figure class="diagram">
<svg viewBox="0 0 640 170" role="img" aria-label="Instance refresh pipeline: bake an AMI, create a launch template version, start an instance refresh that replaces instances in batches, with checkpoints and auto rollback">
  <rect x="10" y="50" width="110" height="64" rx="8" class="d-box"/><text x="65" y="78" text-anchor="middle" class="d-label">Bake AMI</text><text x="65" y="96" text-anchor="middle" class="d-small">Packer / CI</text>
  <rect x="140" y="50" width="120" height="64" rx="8" class="d-box"/><text x="200" y="78" text-anchor="middle" class="d-label">LT version N+1</text><text x="200" y="96" text-anchor="middle" class="d-small">set as $Default</text>
  <rect x="280" y="50" width="130" height="64" rx="8" class="d-box d-accent"/><text x="345" y="78" text-anchor="middle" class="d-label">Instance refresh</text><text x="345" y="96" text-anchor="middle" class="d-small">MinHealthy 90%</text>
  <rect x="430" y="50" width="90" height="64" rx="8" class="d-box"/><text x="475" y="78" text-anchor="middle" class="d-label">Checkpoint</text><text x="475" y="96" text-anchor="middle" class="d-small">at 25%: watch</text>
  <rect x="540" y="20" width="90" height="50" rx="8" class="d-box d-ok"/><text x="585" y="50" text-anchor="middle" class="d-label">Complete</text>
  <rect x="540" y="96" width="90" height="50" rx="8" class="d-box d-danger"/><text x="585" y="120" text-anchor="middle" class="d-label">Roll back</text><text x="585" y="136" text-anchor="middle" class="d-small">alarm fired</text>
  <path d="M120 82 H138" class="d-arrow"/><path d="M260 82 H278" class="d-arrow"/><path d="M410 82 H428" class="d-arrow"/>
  <path d="M520 70 L538 50" class="d-arrow"/><path d="M520 94 L538 116" class="d-arrow d-dashed"/>
</svg>
<figcaption>An immutable rollout. Old instances are replaced batch by batch; alarms or a failed health check roll the group back to the previous launch template version.</figcaption>
</figure>

- \`MinHealthyPercentage\` (default 90) controls batch size: with 10 instances and 90%, it replaces one at a time. \`MaxHealthyPercentage\` above 100 launches replacements *before* terminating old instances, which keeps full capacity at the cost of a temporary surge.
- **Instance warmup** tells the refresh how long a new instance needs before it counts as healthy capacity.
- **Checkpoints** (\`CheckpointPercentages: [25, 50]\`) pause the rollout so you, or an alarm, can judge the new version on real traffic.
- **Auto rollback** with CloudWatch alarms reverts to the previous configuration automatically if the error rate climbs.
- **Skip matching** leaves instances that already run the desired configuration alone, so a retried refresh doesn't churn the whole fleet.

## Blue/green and canary at the load balancer

For a bigger change, run a **second ASG** (green) next to the current one (blue), each in its own target group. Shift traffic with a **weighted forward** on the listener (90/10, then 50/50, then 0/100), watching error rates at each step. Rollback is a single listener update and takes effect in seconds. The cost is double capacity during the switch.

## What a senior engineer does

1. One artifact per release (AMI or image), built and tested in CI, with the git SHA in its name and tags.
2. Launch templates in IaC; ASGs pinned to an explicit version or \`$Default\`, never \`$Latest\`.
3. ELB health checks on the ASG, a realistic grace period, and a deregistration delay that matches real request times.
4. Rollouts by instance refresh with checkpoints and alarm-driven auto rollback, or weighted blue/green for risky changes.
5. No SSH: Session Manager for access, and no state on instances, so replacing one is never scary.

> **On real AWS:** an instance refresh takes minutes per batch, because each new instance boots, runs user data and must pass health checks. In the emulator, instances "launch" instantly, so a refresh finishes in a second or two. The API calls, states and results are the same.
`,
    },
    // ------------------------------------------------------------------ lab A
    {
      id: "fleet",
      kind: "lab",
      title: "Lab: A self-healing fleet from a launch template",
      minutes: 40,
      body: String.raw`
You'll build the core of every EC2 workload: an IAM role delivered through an instance profile, a launch template that enforces IMDSv2 and encrypted gp3 storage, an Auto Scaling group across two AZs, a termination lifecycle hook, and finally an **immutable rollout** of a new template version with an instance refresh.

**Prepare lab** creates \`compute-vpc\` (\`10.2.0.0/16\`) with private subnets \`app-a\` (us-east-1a) and \`app-b\` (us-east-1b), and a security group \`web-app-sg\`, and prints their IDs. The lab folder contains:

- \`user-data.sh\`: the boot script. Read it: it uses IMDSv2 to find its AZ.
- \`lt-data.template.json\`: launch template data with three placeholders for you to fill in: \`__AMI__\`, \`__SG__\` and \`__USERDATA__\`.

Useful lookups:

\`\`\`bash
VPC=$(aws ec2 describe-vpcs --filters Name=tag:Name,Values=compute-vpc --query 'Vpcs[0].VpcId' --output text)
SG=$(aws ec2 describe-security-groups --filters Name=vpc-id,Values=$VPC Name=group-name,Values=web-app-sg --query 'SecurityGroups[0].GroupId' --output text)
sub() { aws ec2 describe-subnets --filters Name=vpc-id,Values=$VPC Name=tag:Name,Values=$1 --query 'Subnets[0].SubnetId' --output text; }
echo "$VPC $SG $(sub app-a) $(sub app-b)"
\`\`\`

> **On real AWS:** these instances would boot, run \`user-data.sh\`, and serve \`/healthz\` on port 8080. Here they reach \`running\` and \`InService\` without a VM behind them, which is all the control plane, and your IaC, ever sees.
`,
      lab: {
        files: {
          "user-data.sh": String.raw`
#!/bin/bash
# Runs ONCE, as root, on the instance's first boot (cloud-init's scripts-user stage).
# Output goes to /var/log/cloud-init-output.log. Heavy installs belong in the AMI.
set -euxo pipefail

# IMDSv2: get a session token with a PUT, then send it on every metadata request.
TOKEN=$(curl -sfX PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 300')
AZ=$(curl -sf -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/placement/availability-zone)

dnf install -y nginx
cat > /etc/nginx/conf.d/app.conf <<EOF
server {
  listen 8080;
  location = /healthz { return 200 "ok from $AZ\n"; }
}
EOF
systemctl enable --now nginx
`,
          "lt-data.template.json": String.raw`
{
  "ImageId": "__AMI__",
  "InstanceType": "t3.micro",
  "IamInstanceProfile": { "Name": "web-ec2-profile" },
  "SecurityGroupIds": ["__SG__"],
  "UserData": "__USERDATA__",
  "MetadataOptions": { "HttpTokens": "required", "HttpPutResponseHopLimit": 1, "HttpEndpoint": "enabled" },
  "BlockDeviceMappings": [
    { "DeviceName": "/dev/xvda", "Ebs": { "VolumeSize": 20, "VolumeType": "gp3", "Encrypted": true, "DeleteOnTermination": true } }
  ],
  "TagSpecifications": [
    { "ResourceType": "instance", "Tags": [{ "Key": "app", "Value": "web" }] }
  ]
}
`,
        },
        setup: LT_SETUP,
        tasks: [
          {
            id: "role",
            title: "An identity for the instances",
            description:
              "Create an IAM role `web-ec2-role` that **EC2** can assume (`ec2.amazonaws.com`), attach the AWS managed policy `AmazonSSMManagedInstanceCore` (Session Manager access instead of SSH), and put the role in an instance profile named `web-ec2-profile`.",
            hints: [
              "The trust policy's principal is `{\"Service\": \"ec2.amazonaws.com\"}` with action `sts:AssumeRole`.",
              "`aws iam attach-role-policy --role-name web-ec2-role --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore`",
              "`aws iam create-instance-profile --instance-profile-name web-ec2-profile`, then `aws iam add-role-to-instance-profile --instance-profile-name web-ec2-profile --role-name web-ec2-role`.",
            ],
            check: async ({ aws, tryAws }) => {
              const r = await tryAws(["iam", "get-role", "--role-name", "web-ec2-role"]);
              if (!r.ok) return "Role `web-ec2-role` doesn't exist yet.";
              if (!JSON.stringify(r.data.Role.AssumeRolePolicyDocument ?? "").includes("ec2.amazonaws.com"))
                return "web-ec2-role's trust policy must allow the service principal ec2.amazonaws.com.";
              const att = await aws(["iam", "list-attached-role-policies", "--role-name", "web-ec2-role"]);
              if (!(att.AttachedPolicies ?? []).some((p: any) => p.PolicyName === "AmazonSSMManagedInstanceCore"))
                return "Attach the managed policy AmazonSSMManagedInstanceCore to web-ec2-role.";
              const p = await tryAws(["iam", "get-instance-profile", "--instance-profile-name", "web-ec2-profile"]);
              if (!p.ok) return "Instance profile `web-ec2-profile` doesn't exist yet.";
              if (!(p.data.InstanceProfile.Roles ?? []).some((x: any) => x.RoleName === "web-ec2-role"))
                return "web-ec2-profile doesn't contain web-ec2-role (add-role-to-instance-profile).";
              return true;
            },
          },
          {
            id: "launch-template",
            title: "A hardened launch template",
            description: String.raw`Create launch template \`web-lt\` from \`lt-data.template.json\`, with the placeholders filled in:

- \`__AMI__\`: the latest Amazon Linux 2023 AMI, resolved from SSM parameter \`/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64\`
- \`__SG__\`: the ID of \`web-app-sg\`
- \`__USERDATA__\`: \`user-data.sh\`, **base64-encoded on one line**

Keep everything else as it is: \`t3.micro\`, instance profile \`web-ec2-profile\`, IMDSv2 required with hop limit 1, and an encrypted 20 GiB gp3 root volume.`,
            hints: [
              "`AMI=$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 --query Parameter.Value --output text)` and `UD=$(base64 < user-data.sh | tr -d '\\n')`.",
              "`sed -e \"s|__AMI__|$AMI|\" -e \"s|__SG__|$SG|\" -e \"s|__USERDATA__|$UD|\" lt-data.template.json > lt-data.json` (`|` as the delimiter, because base64 can contain `/`).",
              "`aws ec2 create-launch-template --launch-template-name web-lt --version-description \"v1 baseline\" --launch-template-data file://lt-data.json`",
            ],
            check: async (ctx) => {
              const v = await ltVersion(ctx, "web-lt", "1");
              if (typeof v === "string") return v;
              const d = v.LaunchTemplateData ?? {};
              const ami = await ctx.aws(["ssm", "get-parameter", "--name", AMI_PARAM]);
              if (d.ImageId !== ami.Parameter.Value) return `Version 1's ImageId is ${d.ImageId}; expected the AL2023 AMI from SSM (${ami.Parameter.Value}).`;
              if (d.InstanceType !== "t3.micro") return `Version 1's InstanceType is ${d.InstanceType}; expected t3.micro.`;
              if (profileName(d.IamInstanceProfile) !== "web-ec2-profile") return "Version 1 doesn't use the instance profile web-ec2-profile.";
              const vpc = await vpcId(ctx, "compute-vpc");
              const sg = vpc && (await sgId(ctx, vpc, "web-app-sg"));
              if (!sg) return "web-app-sg is missing. Press Prepare lab.";
              const sgs = [...(d.SecurityGroupIds ?? []), ...(d.NetworkInterfaces ?? []).flatMap((n: any) => n.Groups ?? [])];
              if (!sgs.includes(sg)) return `Version 1 doesn't attach web-app-sg (${sg}).`;
              const m = d.MetadataOptions ?? {};
              if (m.HttpTokens !== "required") return "IMDSv2 isn't enforced: MetadataOptions.HttpTokens must be `required`.";
              if (m.HttpPutResponseHopLimit !== 1) return `HttpPutResponseHopLimit is ${m.HttpPutResponseHopLimit ?? "unset"}; use 1 (no containers on these hosts).`;
              const root = (d.BlockDeviceMappings ?? []).find((b: any) => b.DeviceName === "/dev/xvda")?.Ebs;
              if (!root) return "No block device mapping for the root volume /dev/xvda.";
              if (root.VolumeType !== "gp3" || root.Encrypted !== true || root.VolumeSize !== 20) return "The root volume should be an encrypted 20 GiB gp3 volume.";
              const file = await ctx.readFile("user-data.sh");
              if (!d.UserData) return "Version 1 has no user data.";
              if (file !== null && decode(d.UserData).trim() !== file.trim())
                return "Version 1's user data doesn't decode to the contents of user-data.sh. Encode the file with `base64 < user-data.sh | tr -d '\\n'`.";
              return true;
            },
          },
          {
            id: "asg",
            title: "An Auto Scaling group across two AZs",
            description:
              "Create Auto Scaling group `web-asg` from `web-lt` at version **`$Default`** (not `$Latest`), with min `2`, max `6`, desired `2`, across subnets `app-a` and `app-b`, and a health check grace period of `120` seconds. It should end up with two `InService` instances, one per AZ.",
            hints: [
              "`--launch-template 'LaunchTemplateName=web-lt,Version=$Default'` (single quotes, so the shell doesn't expand `$Default`).",
              "`--vpc-zone-identifier \"$(sub app-a),$(sub app-b)\"`: one comma-separated string.",
              "`aws autoscaling create-auto-scaling-group --auto-scaling-group-name web-asg --launch-template 'LaunchTemplateName=web-lt,Version=$Default' --min-size 2 --max-size 6 --desired-capacity 2 --vpc-zone-identifier … --health-check-grace-period 120`",
            ],
            check: async (ctx) => {
              const g = await asg(ctx, "web-asg");
              if (!g) return "Auto Scaling group `web-asg` doesn't exist yet.";
              const lt = g.LaunchTemplate ?? g.MixedInstancesPolicy?.LaunchTemplate?.LaunchTemplateSpecification;
              if (lt?.LaunchTemplateName !== "web-lt") return "web-asg should launch from the template web-lt.";
              if (lt.Version !== "$Default") return `web-asg uses launch template version \`${lt.Version ?? "(none)"}\`; pin it to \`$Default\`.`;
              if (g.MinSize !== 2 || g.MaxSize !== 6) return `Min/max is ${g.MinSize}/${g.MaxSize}; expected 2/6.`;
              if (g.HealthCheckGracePeriod !== 120) return `Health check grace period is ${g.HealthCheckGracePeriod}s; expected 120.`;
              const vpc = await vpcId(ctx, "compute-vpc");
              const subs = vpc ? await subnetIds(ctx, vpc) : {};
              const zone = String(g.VPCZoneIdentifier ?? "").split(",");
              for (const n of ["app-a", "app-b"]) if (!zone.includes(subs[n])) return `web-asg doesn't use subnet ${n}.`;
              const live = inService(g);
              if (live.length !== g.DesiredCapacity || g.DesiredCapacity < 2) return `${live.length} instance(s) InService; expected ${Math.max(2, g.DesiredCapacity)}.`;
              if (new Set(live.map((i: any) => i.AvailabilityZone)).size < 2) return "The InService instances aren't spread across two AZs.";
              return true;
            },
          },
          {
            id: "lifecycle-hook",
            title: "Drain before termination",
            description:
              "Add a lifecycle hook `drain-on-terminate` to `web-asg` on the **instance terminating** transition, with a heartbeat timeout of `300` seconds and a default result of `CONTINUE`. On real AWS, an automation would use this window to drain work and ship logs, then call `complete-lifecycle-action`.",
            hints: [
              "The transition is `autoscaling:EC2_INSTANCE_TERMINATING`.",
              "`aws autoscaling put-lifecycle-hook --auto-scaling-group-name web-asg --lifecycle-hook-name drain-on-terminate --lifecycle-transition autoscaling:EC2_INSTANCE_TERMINATING --heartbeat-timeout 300 --default-result CONTINUE`",
            ],
            check: async ({ tryAws }) => {
              const r = await tryAws(["autoscaling", "describe-lifecycle-hooks", "--auto-scaling-group-name", "web-asg"]);
              if (!r.ok) return "web-asg doesn't exist yet.";
              const h = (r.data.LifecycleHooks ?? []).find((x: any) => x.LifecycleHookName === "drain-on-terminate");
              if (!h) return "No lifecycle hook named drain-on-terminate on web-asg.";
              if (h.LifecycleTransition !== "autoscaling:EC2_INSTANCE_TERMINATING") return `The hook fires on ${h.LifecycleTransition}; it should fire on autoscaling:EC2_INSTANCE_TERMINATING.`;
              if (h.HeartbeatTimeout !== 300) return `Heartbeat timeout is ${h.HeartbeatTimeout}; expected 300.`;
              if (h.DefaultResult !== "CONTINUE") return `Default result is ${h.DefaultResult}; expected CONTINUE.`;
              return true;
            },
          },
          {
            id: "rollout",
            title: "Roll out version 2 immutably",
            description: String.raw`Ship a change the immutable way:

1. Create version **2** of \`web-lt\` **from version 1**, changing only the instance type to \`t3.small\` (everything else, including IMDSv2, the profile and the user data, must be inherited).
2. Make version 2 the **default** version.
3. Start an **instance refresh** on \`web-asg\` with \`MinHealthyPercentage\` 50 (one instance at a time with two instances), and wait for it to finish.

When you're done, every \`InService\` instance should be a \`t3.small\`.`,
            hints: [
              "`aws ec2 create-launch-template-version --launch-template-name web-lt --source-version 1 --version-description \"v2 t3.small\" --launch-template-data '{\"InstanceType\":\"t3.small\"}'`",
              "`aws ec2 modify-launch-template --launch-template-name web-lt --default-version 2`. The ASG uses `$Default`, so new launches now get version 2, but existing instances stay on version 1 until they're replaced.",
              "`aws autoscaling start-instance-refresh --auto-scaling-group-name web-asg --preferences '{\"MinHealthyPercentage\":50,\"InstanceWarmup\":60}'`, then poll `aws autoscaling describe-instance-refreshes --auto-scaling-group-name web-asg --query 'InstanceRefreshes[0].Status'` until it's `Successful`.",
            ],
            check: async (ctx) => {
              const lt = await ctx.tryAws(["ec2", "describe-launch-templates", "--launch-template-names", "web-lt"]);
              if (!lt.ok) return "Launch template web-lt doesn't exist yet.";
              const v2 = await ltVersion(ctx, "web-lt", "2");
              if (typeof v2 === "string") return "web-lt has no version 2 yet.";
              const d = v2.LaunchTemplateData ?? {};
              if (d.InstanceType !== "t3.small") return `Version 2's InstanceType is ${d.InstanceType}; expected t3.small.`;
              if (d.MetadataOptions?.HttpTokens !== "required" || profileName(d.IamInstanceProfile) !== "web-ec2-profile" || !d.UserData)
                return "Version 2 lost settings from version 1 (IMDSv2, instance profile or user data). Create it with --source-version 1 and pass only the instance type.";
              if (lt.data.LaunchTemplates[0].DefaultVersionNumber !== 2) return `web-lt's default version is ${lt.data.LaunchTemplates[0].DefaultVersionNumber}; promote version 2.`;
              const r = await ctx.tryAws(["autoscaling", "describe-instance-refreshes", "--auto-scaling-group-name", "web-asg"]);
              const refreshes = (r.data?.InstanceRefreshes ?? []).sort((a: any, b: any) => String(b.StartTime).localeCompare(String(a.StartTime)));
              if (!refreshes.length) return "No instance refresh has been started on web-asg.";
              if (refreshes[0].Status !== "Successful") return `The latest instance refresh is ${refreshes[0].Status}; wait for Successful.`;
              const g = await asg(ctx, "web-asg");
              const live = inService(g);
              const old = live.filter((i: any) => i.InstanceType !== "t3.small");
              if (!live.length) return "web-asg has no InService instances.";
              if (old.length) return `${old.length} InService instance(s) are still ${old[0].InstanceType}. Run the instance refresh after promoting version 2.`;
              return true;
            },
          },
        ],
        solution: String.raw`
aws iam create-role --role-name web-ec2-role --assume-role-policy-document '{
  "Version": "2012-10-17",
  "Statement": [{"Effect": "Allow", "Principal": {"Service": "ec2.amazonaws.com"}, "Action": "sts:AssumeRole"}]
}' >/dev/null
aws iam attach-role-policy --role-name web-ec2-role --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
aws iam create-instance-profile --instance-profile-name web-ec2-profile >/dev/null
aws iam add-role-to-instance-profile --instance-profile-name web-ec2-profile --role-name web-ec2-role

VPC=$(aws ec2 describe-vpcs --filters Name=tag:Name,Values=compute-vpc --query 'Vpcs[0].VpcId' --output text)
SG=$(aws ec2 describe-security-groups --filters Name=vpc-id,Values=$VPC Name=group-name,Values=web-app-sg --query 'SecurityGroups[0].GroupId' --output text)
sub() { aws ec2 describe-subnets --filters Name=vpc-id,Values=$VPC Name=tag:Name,Values=$1 --query 'Subnets[0].SubnetId' --output text; }
AMI=$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 --query Parameter.Value --output text)
UD=$(base64 < user-data.sh | tr -d '\n')
sed -e "s|__AMI__|$AMI|" -e "s|__SG__|$SG|" -e "s|__USERDATA__|$UD|" lt-data.template.json > lt-data.json
aws ec2 create-launch-template --launch-template-name web-lt --version-description "v1 baseline" \
  --launch-template-data file://lt-data.json >/dev/null

aws autoscaling create-auto-scaling-group --auto-scaling-group-name web-asg \
  --launch-template 'LaunchTemplateName=web-lt,Version=$Default' \
  --min-size 2 --max-size 6 --desired-capacity 2 --health-check-grace-period 120 \
  --vpc-zone-identifier "$(sub app-a),$(sub app-b)"

aws autoscaling put-lifecycle-hook --auto-scaling-group-name web-asg --lifecycle-hook-name drain-on-terminate \
  --lifecycle-transition autoscaling:EC2_INSTANCE_TERMINATING --heartbeat-timeout 300 --default-result CONTINUE

aws ec2 create-launch-template-version --launch-template-name web-lt --source-version 1 \
  --version-description "v2 t3.small" --launch-template-data '{"InstanceType":"t3.small"}' >/dev/null
aws ec2 modify-launch-template --launch-template-name web-lt --default-version 2 >/dev/null
aws autoscaling start-instance-refresh --auto-scaling-group-name web-asg \
  --preferences '{"MinHealthyPercentage":50,"InstanceWarmup":60}' >/dev/null
for i in $(seq 60); do
  STATUS=$(aws autoscaling describe-instance-refreshes --auto-scaling-group-name web-asg --query 'InstanceRefreshes[0].Status' --output text)
  echo "refresh: $STATUS"
  [ "$STATUS" = Successful ] && break
  sleep 2
done
`,
      },
    },
    // ------------------------------------------------------------------ lab B
    {
      id: "alb",
      kind: "lab",
      title: "Lab: An Application Load Balancer in front of the fleet",
      minutes: 40,
      body: String.raw`
**Prepare lab** builds \`edge-vpc\` (\`10.3.0.0/16\`): public subnets \`public-a\`/\`public-b\` behind an internet gateway, private subnets \`app-a\`/\`app-b\`, security groups \`alb-sg\` (80 and 443 from the world) and \`app-sg\` (8080 from \`alb-sg\` only), and an Auto Scaling group \`app-asg\` (two instances from launch template \`app-lt\`). It prints all the IDs.

You'll put an internet-facing ALB in front of that ASG: target groups with real health checks, a listener with path-based rules, ELB health checks on the ASG, and a request-count target-tracking policy.

\`\`\`bash
VPC=$(aws ec2 describe-vpcs --filters Name=tag:Name,Values=edge-vpc --query 'Vpcs[0].VpcId' --output text)
sub() { aws ec2 describe-subnets --filters Name=vpc-id,Values=$VPC Name=tag:Name,Values=$1 --query 'Subnets[0].SubnetId' --output text; }
sg()  { aws ec2 describe-security-groups --filters Name=vpc-id,Values=$VPC Name=group-name,Values=$1 --query 'SecurityGroups[0].GroupId' --output text; }
echo "$VPC $(sub public-a) $(sub public-b) $(sg alb-sg)"
\`\`\`

The emulator's ALB serves real HTTP on its \`DNSName\`, so you can \`curl\` your rules. Because the instances never boot, anything that reaches \`web-tg\` returns **502**, and anything that reaches an empty target group returns **503**. Those are exactly the codes you'd see on AWS with a broken or empty fleet.

> **On real AWS:** you'd also add an \`HTTPS:443\` listener with an ACM certificate and turn the \`HTTP:80\` listener into a 301 redirect. This lab sticks to HTTP because the emulator doesn't validate certificates.
`,
      lab: {
        setup: ALB_SETUP,
        tasks: [
          {
            id: "target-group",
            title: "A target group with a real health check",
            description: String.raw`Create target group \`web-tg\` in \`edge-vpc\`: protocol \`HTTP\`, port \`8080\`, target type \`instance\`. Health check: path \`/healthz\`, every \`10\` seconds, \`2\` successes to become healthy, \`3\` failures to become unhealthy, expecting HTTP \`200\`. Then lower its **deregistration delay** from the default 300 seconds to \`30\`.`,
            hints: [
              "`aws elbv2 create-target-group --name web-tg --protocol HTTP --port 8080 --vpc-id $VPC --target-type instance --health-check-path /healthz --health-check-interval-seconds 10 --healthy-threshold-count 2 --unhealthy-threshold-count 3 --matcher HttpCode=200`",
              "`aws elbv2 modify-target-group-attributes --target-group-arn $TG --attributes Key=deregistration_delay.timeout_seconds,Value=30`",
            ],
            check: async (ctx) => {
              const t = await tg(ctx, "web-tg");
              if (!t) return "Target group `web-tg` doesn't exist yet.";
              const vpc = await vpcId(ctx, "edge-vpc");
              if (t.VpcId !== vpc) return "web-tg must be in edge-vpc.";
              if (t.Protocol !== "HTTP" || t.Port !== 8080 || t.TargetType !== "instance") return `web-tg is ${t.Protocol}:${t.Port} (${t.TargetType}); expected HTTP:8080 with target type instance.`;
              if (t.HealthCheckPath !== "/healthz") return `Health check path is ${t.HealthCheckPath}; expected /healthz.`;
              if (t.HealthCheckIntervalSeconds !== 10) return `Health check interval is ${t.HealthCheckIntervalSeconds}s; expected 10.`;
              if (t.HealthyThresholdCount !== 2 || t.UnhealthyThresholdCount !== 3)
                return `Thresholds are healthy=${t.HealthyThresholdCount}, unhealthy=${t.UnhealthyThresholdCount}; expected 2 and 3.`;
              if (t.Matcher?.HttpCode !== "200") return `The matcher expects ${t.Matcher?.HttpCode}; expected 200.`;
              const a = await ctx.aws(["elbv2", "describe-target-group-attributes", "--target-group-arn", t.TargetGroupArn]);
              const dd = (a.Attributes ?? []).find((x: any) => x.Key === "deregistration_delay.timeout_seconds")?.Value;
              if (dd !== "30") return `Deregistration delay is ${dd}s; set it to 30 so deploys and scale-ins don't wait 5 minutes per instance.`;
              return true;
            },
          },
          {
            id: "load-balancer",
            title: "An internet-facing ALB",
            description:
              "Create an **internet-facing application** load balancer `web-alb` in the two **public** subnets, with security group `alb-sg`. Enable the attribute `routing.http.drop_invalid_header_fields.enabled`. Wait until it's `active`.",
            hints: [
              "`aws elbv2 create-load-balancer --name web-alb --type application --scheme internet-facing --subnets $(sub public-a) $(sub public-b) --security-groups $(sg alb-sg)`",
              "`aws elbv2 modify-load-balancer-attributes --load-balancer-arn $LB --attributes Key=routing.http.drop_invalid_header_fields.enabled,Value=true`, then `aws elbv2 wait load-balancer-available --load-balancer-arns $LB`.",
            ],
            check: async (ctx) => {
              const lb = await alb(ctx, "web-alb");
              if (!lb) return "Load balancer `web-alb` doesn't exist yet.";
              if (lb.Type !== "application") return `web-alb is a ${lb.Type} load balancer; expected application.`;
              if (lb.Scheme !== "internet-facing") return `web-alb's scheme is ${lb.Scheme}; expected internet-facing.`;
              const vpc = await vpcId(ctx, "edge-vpc");
              if (lb.VpcId !== vpc) return "web-alb must be in edge-vpc.";
              const subs = await subnetIds(ctx, vpc!);
              const used = (lb.AvailabilityZones ?? []).map((z: any) => z.SubnetId).sort();
              const want = [subs["public-a"], subs["public-b"]].sort();
              if (JSON.stringify(used) !== JSON.stringify(want)) return "web-alb must use exactly the public subnets public-a and public-b. Its nodes need the internet gateway route.";
              const albSg = await sgId(ctx, vpc!, "alb-sg");
              if (JSON.stringify(lb.SecurityGroups ?? []) !== JSON.stringify([albSg])) return "web-alb should have exactly one security group: alb-sg.";
              if (lb.State?.Code !== "active") return `web-alb is ${lb.State?.Code}; wait for active.`;
              const a = await ctx.aws(["elbv2", "describe-load-balancer-attributes", "--load-balancer-arn", lb.LoadBalancerArn]);
              const drop = (a.Attributes ?? []).find((x: any) => x.Key === "routing.http.drop_invalid_header_fields.enabled")?.Value;
              if (drop !== "true") return "Enable routing.http.drop_invalid_header_fields.enabled on web-alb.";
              return true;
            },
          },
          {
            id: "listener",
            title: "A listener that forwards to web-tg",
            description: "Add an `HTTP:80` listener to `web-alb` whose **default action** forwards to `web-tg`.",
            hints: [
              "`aws elbv2 create-listener --load-balancer-arn $LB --protocol HTTP --port 80 --default-actions Type=forward,TargetGroupArn=$TG`",
            ],
            check: async (ctx) => {
              const lb = await alb(ctx, "web-alb");
              if (!lb) return "Create web-alb first.";
              const t = await tg(ctx, "web-tg");
              if (!t) return "Create web-tg first.";
              const ls = await ctx.aws(["elbv2", "describe-listeners", "--load-balancer-arn", lb.LoadBalancerArn]);
              const l = (ls.Listeners ?? []).find((x: any) => x.Port === 80);
              if (!l) return "web-alb has no listener on port 80.";
              if (l.Protocol !== "HTTP") return `The port 80 listener uses ${l.Protocol}; expected HTTP.`;
              if (!forwardsTo(l.DefaultActions?.[0], t.TargetGroupArn)) return "The port 80 listener's default action doesn't forward to web-tg.";
              return true;
            },
          },
          {
            id: "rules",
            title: "Path-based rules",
            description: String.raw`Add two rules to the port 80 listener:

- Priority \`5\`: requests matching \`/admin/*\` get a **fixed response** \`403\` (\`text/plain\`, body \`Forbidden\`). Admin endpoints should never be reachable from the internet.
- Priority \`10\`: requests matching \`/api/*\` **forward** to a new target group \`api-tg\` (HTTP, port 8080, \`edge-vpc\`, health check path \`/api/healthz\`). A separate API fleet would register there; for now, it stays empty.

Then try it: \`curl -s -o /dev/null -w '%{http_code}\n' "http://$DNS/admin/users"\` should print \`403\`, \`/api/orders\` should print \`503\` (no targets), and \`/\` should print \`502\` (targets that never answer).`,
            hints: [
              "Fixed response: `--actions 'Type=fixed-response,FixedResponseConfig={StatusCode=403,ContentType=text/plain,MessageBody=Forbidden}'`.",
              "`aws elbv2 create-rule --listener-arn $LSN --priority 5 --conditions Field=path-pattern,Values='/admin/*' --actions …`. Quote the pattern so the shell doesn't expand the `*`.",
              "`DNS=$(aws elbv2 describe-load-balancers --names web-alb --query 'LoadBalancers[0].DNSName' --output text)`",
            ],
            check: async (ctx) => {
              const lb = await alb(ctx, "web-alb");
              if (!lb) return "Create web-alb first.";
              const ls = await ctx.aws(["elbv2", "describe-listeners", "--load-balancer-arn", lb.LoadBalancerArn]);
              const l = (ls.Listeners ?? []).find((x: any) => x.Port === 80);
              if (!l) return "Create the port 80 listener first.";
              const rules = (await ctx.aws(["elbv2", "describe-rules", "--listener-arn", l.ListenerArn])).Rules ?? [];
              const admin = rules.find((r: any) => pathValues(r).includes("/admin/*"));
              if (!admin) return "No rule matches the path pattern /admin/*.";
              if (admin.Priority !== "5") return `The /admin/* rule has priority ${admin.Priority}; expected 5.`;
              const fr = admin.Actions?.[0];
              if (fr?.Type !== "fixed-response" || String(fr.FixedResponseConfig?.StatusCode) !== "403") return "The /admin/* rule should return a fixed response with status 403.";
              const api = await tg(ctx, "api-tg");
              if (!api) return "Target group `api-tg` doesn't exist yet.";
              if (api.Port !== 8080 || api.Protocol !== "HTTP" || api.HealthCheckPath !== "/api/healthz") return "api-tg should be HTTP:8080 with health check path /api/healthz.";
              const apiRule = rules.find((r: any) => pathValues(r).includes("/api/*"));
              if (!apiRule) return "No rule matches the path pattern /api/*.";
              if (apiRule.Priority !== "10") return `The /api/* rule has priority ${apiRule.Priority}; expected 10.`;
              if (!forwardsTo(apiRule.Actions?.[0], api.TargetGroupArn)) return "The /api/* rule should forward to api-tg.";
              // The emulator's ALB serves real HTTP; confirm the rule works end to end when it's reachable.
              const r = await ctx.sh(`curl -s -o /dev/null -m 5 -w '%{http_code}' "http://${lb.DNSName}/admin/users"`);
              const code = r.stdout.trim();
              if (code && code !== "000" && code !== "403") return `GET /admin/users returned ${code} through the ALB; expected 403.`;
              return true;
            },
          },
          {
            id: "attach-asg",
            title: "Attach the fleet, with ELB health checks",
            description:
              "Attach `app-asg` to `web-tg`, and switch the ASG to **ELB health checks** with a `120` second grace period, so instances that fail the target group's health check get replaced, not just skipped. Both instances should then show up as registered targets of `web-tg`.",
            hints: [
              "`aws autoscaling attach-load-balancer-target-groups --auto-scaling-group-name app-asg --target-group-arns $TG`",
              "`aws autoscaling update-auto-scaling-group --auto-scaling-group-name app-asg --health-check-type ELB --health-check-grace-period 120`",
              "Look at `aws elbv2 describe-target-health --target-group-arn $TG`.",
            ],
            check: async (ctx) => {
              const g = await asg(ctx, "app-asg");
              if (!g) return "app-asg is missing. Press Prepare lab.";
              const t = await tg(ctx, "web-tg");
              if (!t) return "Create web-tg first.";
              if (!(g.TargetGroupARNs ?? []).includes(t.TargetGroupArn)) return "app-asg isn't attached to web-tg.";
              if (g.HealthCheckType !== "ELB") return `app-asg uses ${g.HealthCheckType} health checks; switch to ELB.`;
              if (g.HealthCheckGracePeriod !== 120) return `Health check grace period is ${g.HealthCheckGracePeriod}s; expected 120.`;
              const h = await ctx.aws(["elbv2", "describe-target-health", "--target-group-arn", t.TargetGroupArn]);
              const ids = new Set((h.TargetHealthDescriptions ?? []).map((x: any) => x.Target?.Id));
              const missing = inService(g).filter((i: any) => !ids.has(i.InstanceId));
              if (!ids.size || missing.length) return `${missing.length || "The"} ASG instance(s) aren't registered in web-tg yet.`;
              return true;
            },
          },
          {
            id: "scaling-policy",
            title: "Scale on requests per target",
            description: String.raw`Add a **target tracking** scaling policy \`req-per-target\` to \`app-asg\` that keeps the predefined metric \`ALBRequestCountPerTarget\` at \`500\` requests per target. This metric needs a \`ResourceLabel\` that identifies the load balancer *and* target group, in the form \`app/web-alb/<id>/targetgroup/web-tg/<id>\`: the ARN suffixes of each, joined with \`/\`.`,
            hints: [
              "The load balancer part is everything after `:loadbalancer/` in its ARN; the target group part is everything after the last `:` of its ARN.",
              "`LABEL=\"\\${LB#*:loadbalancer/}/\\${TG##*:}\"` builds it in bash.",
              "`aws autoscaling put-scaling-policy --auto-scaling-group-name app-asg --policy-name req-per-target --policy-type TargetTrackingScaling --target-tracking-configuration \"{\\\"PredefinedMetricSpecification\\\":{\\\"PredefinedMetricType\\\":\\\"ALBRequestCountPerTarget\\\",\\\"ResourceLabel\\\":\\\"$LABEL\\\"},\\\"TargetValue\\\":500}\"`",
            ],
            check: async (ctx) => {
              const lb = await alb(ctx, "web-alb");
              const t = await tg(ctx, "web-tg");
              if (!lb || !t) return "Create web-alb and web-tg first.";
              const r = await ctx.tryAws(["autoscaling", "describe-policies", "--auto-scaling-group-name", "app-asg", "--policy-names", "req-per-target"]);
              const p = r.data?.ScalingPolicies?.[0];
              if (!p) return "No scaling policy named req-per-target on app-asg.";
              if (p.PolicyType !== "TargetTrackingScaling") return `req-per-target is ${p.PolicyType}; expected TargetTrackingScaling.`;
              const cfg = p.TargetTrackingConfiguration ?? {};
              const spec = cfg.PredefinedMetricSpecification ?? {};
              if (spec.PredefinedMetricType !== "ALBRequestCountPerTarget") return `The policy tracks ${spec.PredefinedMetricType ?? "a custom metric"}; expected ALBRequestCountPerTarget.`;
              if (Number(cfg.TargetValue) !== 500) return `Target value is ${cfg.TargetValue}; expected 500.`;
              const want = `${lb.LoadBalancerArn.split(":loadbalancer/")[1]}/${t.TargetGroupArn.split(":").pop()}`;
              if (spec.ResourceLabel !== want) return `ResourceLabel is \`${spec.ResourceLabel}\`; expected \`${want}\`.`;
              return true;
            },
          },
        ],
        solution: String.raw`
VPC=$(aws ec2 describe-vpcs --filters Name=tag:Name,Values=edge-vpc --query 'Vpcs[0].VpcId' --output text)
sub() { aws ec2 describe-subnets --filters Name=vpc-id,Values=$VPC Name=tag:Name,Values=$1 --query 'Subnets[0].SubnetId' --output text; }
sg()  { aws ec2 describe-security-groups --filters Name=vpc-id,Values=$VPC Name=group-name,Values=$1 --query 'SecurityGroups[0].GroupId' --output text; }

TG=$(aws elbv2 create-target-group --name web-tg --protocol HTTP --port 8080 --vpc-id "$VPC" --target-type instance \
  --health-check-path /healthz --health-check-interval-seconds 10 --healthy-threshold-count 2 \
  --unhealthy-threshold-count 3 --matcher HttpCode=200 --query 'TargetGroups[0].TargetGroupArn' --output text)
aws elbv2 modify-target-group-attributes --target-group-arn "$TG" --attributes Key=deregistration_delay.timeout_seconds,Value=30 >/dev/null

LB=$(aws elbv2 create-load-balancer --name web-alb --type application --scheme internet-facing \
  --subnets "$(sub public-a)" "$(sub public-b)" --security-groups "$(sg alb-sg)" \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text)
aws elbv2 modify-load-balancer-attributes --load-balancer-arn "$LB" \
  --attributes Key=routing.http.drop_invalid_header_fields.enabled,Value=true >/dev/null
aws elbv2 wait load-balancer-available --load-balancer-arns "$LB"

LSN=$(aws elbv2 create-listener --load-balancer-arn "$LB" --protocol HTTP --port 80 \
  --default-actions Type=forward,TargetGroupArn="$TG" --query 'Listeners[0].ListenerArn' --output text)
aws elbv2 create-rule --listener-arn "$LSN" --priority 5 --conditions Field=path-pattern,Values='/admin/*' \
  --actions 'Type=fixed-response,FixedResponseConfig={StatusCode=403,ContentType=text/plain,MessageBody=Forbidden}' >/dev/null
API_TG=$(aws elbv2 create-target-group --name api-tg --protocol HTTP --port 8080 --vpc-id "$VPC" \
  --health-check-path /api/healthz --query 'TargetGroups[0].TargetGroupArn' --output text)
aws elbv2 create-rule --listener-arn "$LSN" --priority 10 --conditions Field=path-pattern,Values='/api/*' \
  --actions Type=forward,TargetGroupArn="$API_TG" >/dev/null

aws autoscaling attach-load-balancer-target-groups --auto-scaling-group-name app-asg --target-group-arns "$TG"
aws autoscaling update-auto-scaling-group --auto-scaling-group-name app-asg --health-check-type ELB --health-check-grace-period 120

LABEL="\${LB#*:loadbalancer/}/\${TG##*:}"
aws autoscaling put-scaling-policy --auto-scaling-group-name app-asg --policy-name req-per-target \
  --policy-type TargetTrackingScaling \
  --target-tracking-configuration "{\"PredefinedMetricSpecification\":{\"PredefinedMetricType\":\"ALBRequestCountPerTarget\",\"ResourceLabel\":\"$LABEL\"},\"TargetValue\":500}" >/dev/null

DNS=$(aws elbv2 describe-load-balancers --names web-alb --query 'LoadBalancers[0].DNSName' --output text)
for p in /admin/users /api/orders /; do echo "$p -> $(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://$DNS$p")"; done
`,
      },
    },
  ],
  quiz: [
    {
      q: "A security review finds an SSRF bug in your app: it fetches arbitrary URLs supplied by users. The instances run with an IAM role. Which launch-template setting most directly prevents the bug from leaking the role's credentials?",
      options: [
        "Disable user data",
        "`MetadataOptions.HttpTokens=required` (IMDSv2) with a hop limit of 1",
        "Use a larger instance type",
        "Attach AmazonSSMManagedInstanceCore",
      ],
      answer: 1,
      explain:
        "IMDSv1 answers a plain GET, which is exactly what an SSRF bug can make. IMDSv2 requires a session token obtained with a PUT and a custom header, which SSRF almost never allows, and a hop limit of 1 keeps the token from leaving the host. Enforce it in every launch template and as the account default. (Fixing the SSRF bug is still required.)",
    },
    {
      q: "Your ASG points at launch template version `$Latest`. A colleague creates a new version to test a different AMI and doesn't touch the ASG. What happens?",
      options: [
        "Nothing until someone updates the ASG",
        "The next instance the ASG launches (a scale-out or a replacement) uses the untested version",
        "All instances are replaced immediately",
        "The ASG rejects the new version",
      ],
      answer: 1,
      explain:
        "`$Latest` moves every time a version is created, so the next launch, possibly at 3 a.m. during a scale-out, picks up the draft. Existing instances aren't touched. Pin ASGs to `$Default` (promoted deliberately) or an explicit version number, and roll changes out with an instance refresh.",
    },
    {
      q: "An app's process crashes on some instances, but the ASG never replaces them, and the ALB stops sending them traffic. What's missing?",
      options: [
        "A step-scaling policy",
        "The ASG uses EC2 health checks. Switch it to ELB health checks so target-group failures mark the instances unhealthy.",
        "Cross-zone load balancing",
        "A longer deregistration delay",
      ],
      answer: 1,
      explain:
        "EC2 health checks only catch a dead VM. With `HealthCheckType=ELB`, an instance that fails the target group's health check is also marked unhealthy and replaced. Pair it with a health check grace period a bit longer than real boot time.",
    },
    {
      q: "Every deploy takes 25 minutes, mostly spent with instances in `draining` after an instance refresh starts. Requests to the API finish in under 2 seconds. What's the fix?",
      options: [
        "Lower the target group's deregistration delay from its 300 s default to around 30 s",
        "Disable health checks during deploys",
        "Raise MinHealthyPercentage to 100",
        "Switch to a Network Load Balancer",
      ],
      answer: 0,
      explain:
        "The deregistration delay is how long the ALB waits for in-flight requests on a deregistering target. The default is 300 s, which is far longer than this API's requests, so each batch waits about 5 minutes. Set it just above your slowest normal request.",
    },
    {
      q: "Your health check endpoint verifies the database, the cache and two third-party APIs. One of the third-party APIs has a 2-minute outage. What's the likely result?",
      options: [
        "Only requests that use that API fail",
        "Every target fails its health check at once. The ALB fails open, and with ELB health checks the ASG may start replacing perfectly good instances.",
        "The ALB automatically routes around the third-party API",
        "Nothing: health checks ignore third-party failures",
      ],
      answer: 1,
      explain:
        "Deep health checks turn a dependency blip into a fleet-wide failure. Health checks should answer \"can *this instance* serve?\" (the process is up, its config is loaded). Handle dependency failures in the app with timeouts, retries and graceful degradation, and surface them through metrics and alarms.",
    },
    {
      q: "A team wants to cut the cost of a stateless web tier behind an ALB by 60%+ without risking an outage when capacity is reclaimed. Which design fits?",
      options: [
        "All Spot, one instance type, in one AZ",
        "A mixed instances policy: a small on-demand base, Spot above it with price-capacity-optimized allocation, several instance types across AZs, and Capacity Rebalancing on",
        "Reserved Instances for the peak capacity",
        "Burstable t3 instances in unlimited mode",
      ],
      answer: 1,
      explain:
        "Spot works when the fleet tolerates losing instances at two minutes' notice. Diversifying across instance types and AZs keeps one exhausted capacity pool from taking out the fleet, the on-demand base guarantees a floor, and Capacity Rebalancing replaces at-risk instances early. Commit to the steady baseline with a Savings Plan, not to the peak.",
    },
    {
      q: "Why do production teams prefer immutable deploys (new AMI → new launch template version → instance refresh) over updating packages on running instances?",
      options: [
        "They're faster",
        "They need no extra capacity",
        "Every instance runs the exact artifact that was tested, there's no drift, and rollback means switching back to the previous version, which still exists unchanged",
        "AWS doesn't allow SSH",
      ],
      answer: 2,
      explain:
        "In-place updates are fast but accumulate drift, can leave a half-updated fleet, and roll back by deploying again under pressure. Immutable rollouts trade some speed and temporary capacity for reproducibility and trivial rollback, and instance refresh checkpoints with auto rollback make them safe.",
    },
  ],
};
