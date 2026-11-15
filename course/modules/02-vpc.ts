import type { CheckContext, Module } from "../types.ts";

// ---------------------------------------------------------------- helpers
// Checks look resources up by Name tag inside one VPC, so leftovers from other
// labs (or the emulator's default VPC, 172.31.0.0/16) never confuse them.

type Ctx = Pick<CheckContext, "aws" | "tryAws">;

const tagOf = (r: any, key: string) => (r?.Tags ?? []).find((t: any) => t.Key === key)?.Value;

async function vpcByName({ aws }: Ctx, name: string): Promise<any | null> {
  const d = await aws(["ec2", "describe-vpcs", "--filters", `Name=tag:Name,Values=${name}`]);
  return d.Vpcs?.[0] ?? null;
}

async function subnetsByName({ aws }: Ctx, vpcId: string): Promise<Record<string, any>> {
  const d = await aws(["ec2", "describe-subnets", "--filters", `Name=vpc-id,Values=${vpcId}`]);
  return Object.fromEntries((d.Subnets ?? []).filter((s: any) => tagOf(s, "Name")).map((s: any) => [tagOf(s, "Name"), s]));
}

async function routeTableByName({ aws }: Ctx, vpcId: string, name: string): Promise<any | null> {
  const d = await aws(["ec2", "describe-route-tables", "--filters", `Name=vpc-id,Values=${vpcId}`, `Name=tag:Name,Values=${name}`]);
  return d.RouteTables?.[0] ?? null;
}

async function sgByName({ aws }: Ctx, vpcId: string, name: string): Promise<any | null> {
  const d = await aws(["ec2", "describe-security-groups", "--filters", `Name=vpc-id,Values=${vpcId}`, `Name=group-name,Values=${name}`]);
  return d.SecurityGroups?.[0] ?? null;
}

const assocSubnets = (rt: any): string[] => (rt.Associations ?? []).filter((a: any) => a.SubnetId).map((a: any) => a.SubnetId);
const defaultRoute = (rt: any) => (rt.Routes ?? []).find((r: any) => r.DestinationCidrBlock === "0.0.0.0/0");

// Lab 1's plan: name, CIDR, AZ, tier.
const PLAN: [string, string, string, string][] = [
  ["public-a", "10.0.0.0/24", "us-east-1a", "public"],
  ["public-b", "10.0.1.0/24", "us-east-1b", "public"],
  ["app-a", "10.0.16.0/20", "us-east-1a", "app"],
  ["app-b", "10.0.32.0/20", "us-east-1b", "app"],
  ["data-a", "10.0.48.0/24", "us-east-1a", "data"],
  ["data-b", "10.0.49.0/24", "us-east-1b", "data"],
];

async function labVpc(ctx: Ctx, name: string): Promise<any | string> {
  const v = await vpcByName(ctx, name);
  return v ?? `No VPC tagged Name=${name} found.`;
}

/** Ingress permissions as flat (proto, from, to, source) tuples. */
function flatIngress(sg: any): { proto: string; from?: number; to?: number; cidr?: string; group?: string }[] {
  const out: any[] = [];
  for (const p of sg.IpPermissions ?? []) {
    const base = { proto: p.IpProtocol, from: p.FromPort, to: p.ToPort };
    for (const r of p.IpRanges ?? []) out.push({ ...base, cidr: r.CidrIp });
    for (const r of p.Ipv6Ranges ?? []) out.push({ ...base, cidr: r.CidrIpv6 });
    for (const g of p.UserIdGroupPairs ?? []) out.push({ ...base, group: g.GroupId });
    for (const pl of p.PrefixListIds ?? []) out.push({ ...base, cidr: pl.PrefixListId });
  }
  return out;
}

/** Checks a tier SG allows exactly one TCP port from exactly one source SG. */
async function checkTierSg(ctx: Ctx, vpcId: string, name: string, port: number, sourceName: string): Promise<true | string> {
  const sg = await sgByName(ctx, vpcId, name);
  if (!sg) return `No security group named \`${name}\` in sec-vpc.`;
  const src = await sgByName(ctx, vpcId, sourceName);
  if (!src) return `\`${sourceName}\` must exist first: \`${name}\` references it.`;
  const rules = flatIngress(sg);
  if (!rules.length) return `\`${name}\` has no inbound rules yet.`;
  const cidr = rules.find((r) => r.cidr);
  if (cidr) return `\`${name}\` allows traffic from ${cidr.cidr}. It should only allow the \`${sourceName}\` security group, never a CIDR.`;
  const good = rules.find((r) => r.proto === "tcp" && r.from === port && r.to === port && r.group === src.GroupId);
  if (!good) return `\`${name}\` has no rule allowing TCP ${port} from \`${sourceName}\` (${src.GroupId}).`;
  const extra = rules.find((r) => r !== good);
  if (extra) return `\`${name}\` has an extra inbound rule (${extra.proto} ${extra.from ?? "all"}-${extra.to ?? "all"} from ${extra.group}). Allow only TCP ${port} from \`${sourceName}\`.`;
  return true;
}

// Setup for lab 2: a VPC with the six tiered subnets, created only once.
const SEC_SETUP = String.raw`
if [ "$(aws ec2 describe-vpcs --filters Name=tag:Name,Values=sec-vpc --query 'length(Vpcs)' --output text)" = "0" ]; then
  VPC=$(aws ec2 create-vpc --cidr-block 10.1.0.0/16 \
    --tag-specifications 'ResourceType=vpc,Tags=[{Key=Name,Value=sec-vpc}]' --query Vpc.VpcId --output text)
  while read -r name cidr az tier; do
    aws ec2 create-subnet --vpc-id "$VPC" --cidr-block "$cidr" --availability-zone "$az" \
      --tag-specifications "ResourceType=subnet,Tags=[{Key=Name,Value=$name},{Key=tier,Value=$tier}]" >/dev/null
  done <<'PLAN'
public-a 10.1.0.0/24  us-east-1a public
public-b 10.1.1.0/24  us-east-1b public
app-a    10.1.16.0/20 us-east-1a app
app-b    10.1.32.0/20 us-east-1b app
data-a   10.1.48.0/24 us-east-1a data
data-b   10.1.49.0/24 us-east-1b data
PLAN
fi
echo "sec-vpc: $(aws ec2 describe-vpcs --filters Name=tag:Name,Values=sec-vpc --query 'Vpcs[0].VpcId' --output text)"
`;

export const vpc: Module = {
  id: "vpc",
  number: "02",
  title: "Networking: VPC from first principles",
  summary:
    "Plan address space, build a multi-AZ VPC with public, private and isolated tiers, and layer security groups, NACLs, endpoints and flow logs the way production networks are built.",
  services: ["VPC", "EC2", "CloudWatch Logs", "IAM"],
  lessons: [
    // ------------------------------------------------------------------ 1
    {
      id: "cidr-subnets",
      kind: "reading",
      title: "Address space, CIDR planning and subnets",
      minutes: 14,
      body: String.raw`
A **VPC** (Virtual Private Cloud) is a private, software-defined IPv4 (and optionally IPv6) network that lives in **one region** of **one account**. Nothing gets in or out of it unless you add a gateway and a route. Every EC2 instance, RDS database, Lambda function attached to a VPC, load balancer and EKS pod gets its IP address from it. Most production network incidents trace back to decisions made in the first ten minutes of creating one, so take the address plan seriously.

## CIDR in one minute

A CIDR block like \`10.0.0.0/16\` means "the first 16 bits are fixed, the remaining 16 bits are yours": 2^16 = 65,536 addresses. Each extra bit on the prefix halves the block.

| Prefix | Addresses | Typical use |
|---|---|---|
| \`/16\` | 65,536 | The largest VPC CIDR AWS allows. A sensible default for a workload VPC. |
| \`/20\` | 4,096 | An application subnet for EKS or a busy Auto Scaling group |
| \`/24\` | 256 | A public subnet (load balancers, NAT gateways) or a data subnet |
| \`/28\` | 16 | The **smallest** subnet AWS allows |

VPC CIDRs must be between \`/16\` and \`/28\`, and should come from RFC 1918 space (\`10.0.0.0/8\`, \`172.16.0.0/12\`, \`192.168.0.0/16\`). A block must also be *aligned*: \`10.0.16.0/20\` is valid because 16 is a multiple of 16, but \`10.0.8.0/20\` is not a real /20 boundary.

## Plan for the networks you'll connect later

The CIDR you choose today has to coexist with every network you'll ever connect: other VPCs, on-premises ranges over VPN or Direct Connect, partner networks, a second region. **Two networks with overlapping CIDRs cannot be routed to each other.** VPC peering refuses them outright, Transit Gateway can't route between them, and the fix is "rebuild one of them", which in production means a migration project.

What a senior engineer does:

- **Allocate from a central plan**, never ad hoc. Larger organisations use **Amazon VPC IPAM** to hand out non-overlapping blocks per account and region. A spreadsheet in Git is the minimum.
- **Never use the default \`172.31.0.0/16\`**, or anything else the AWS default VPC uses, for real workloads. Every account has the same default VPC CIDR, so they all overlap with each other.
- **Avoid \`10.0.0.0/16\`** in real organisations for the same reason: every tutorial uses it, so it collides with every acquired company and every contractor's VPN. (This lab uses it, which proves the point.)
- **Size for the biggest consumer.** EKS with the VPC CNI gives *every pod* a VPC IP address. A 50-node cluster running 30 pods per node needs 1,500+ addresses in its subnets. Lambda in a VPC, interface endpoints, and load balancers that scale out all consume IPs too. Running out of IPs in a subnet is a classic 3 a.m. outage: new instances and pods simply fail to launch.
- You can add **secondary CIDR blocks** to a VPC later (up to 5 by default), which rescues an undersized VPC, but it makes routing and firewall rules messier. Get the primary block right.

## Subnets are zonal

A **subnet** is a slice of the VPC's CIDR that lives in exactly **one Availability Zone**. An instance in subnet \`app-a\` is physically in \`us-east-1a\`. That has two consequences:

1. **High availability means one subnet per tier per AZ.** "Run it in two subnets in two AZs" is how you survive the loss of a zone. Load balancers, Auto Scaling groups and RDS Multi-AZ all ask you for subnets in at least two AZs, and ALBs refuse to be created otherwise.
2. **Subnet CIDRs can't overlap within a VPC**, and they can't be resized. If you need a bigger one, you create a new subnet and migrate to it.

## AWS keeps five addresses in every subnet

In every subnet AWS reserves the **first four and the last** address. For \`10.0.0.0/24\`:

| Address | Reserved for |
|---|---|
| \`10.0.0.0\` | Network address |
| \`10.0.0.1\` | The VPC router |
| \`10.0.0.2\` | Amazon-provided DNS (the VPC base + 2) |
| \`10.0.0.3\` | Reserved for future use |
| \`10.0.0.255\` | Broadcast address (VPCs don't support broadcast, but it's reserved anyway) |

So a \`/24\` gives you **251** usable addresses and a \`/28\` gives you **11**. Remember the \`.2\` resolver: on-premises DNS forwarders and Route 53 Resolver rules point at it.

## Try it

Create a demo VPC and a subnet, and look at the usable address count:

\`\`\`bash
DEMO_VPC=$(aws ec2 create-vpc --cidr-block 10.99.0.0/16 \
  --tag-specifications 'ResourceType=vpc,Tags=[{Key=Name,Value=demo-vpc}]' --query Vpc.VpcId --output text)
aws ec2 create-subnet --vpc-id "$DEMO_VPC" --cidr-block 10.99.0.0/24 --availability-zone us-east-1a \
  --query 'Subnet.{id: SubnetId, az: AvailabilityZone, usable: AvailableIpAddressCount}'
\`\`\`

\`usable\` is 251, not 256. Now ask for a subnet that overlaps the first one, and then one that's smaller than \`/28\`:

\`\`\`bash
aws ec2 create-subnet --vpc-id "$DEMO_VPC" --cidr-block 10.99.0.128/25 --availability-zone us-east-1b
aws ec2 create-subnet --vpc-id "$DEMO_VPC" --cidr-block 10.99.1.0/29 --availability-zone us-east-1b
\`\`\`

You get \`InvalidSubnet.Conflict\` and \`InvalidSubnet.Range\`, the same errors AWS returns. Your IaC pipeline sees exactly these errors when someone's CIDR plan is wrong, so it's worth recognising them.

## A layout that scales

A common production plan for one workload VPC (\`/16\`) across three AZs:

\`\`\`text
10.42.0.0/16  workload VPC (prod, us-east-1)
  10.42.0.0/24    public-a      ALBs, NAT gateways. Small: few things live here.
  10.42.1.0/24    public-b
  10.42.2.0/24    public-c
  10.42.16.0/20   app-a         Instances, containers, pods. Big.
  10.42.32.0/20   app-b
  10.42.48.0/20   app-c
  10.42.64.0/24   data-a        RDS, ElastiCache. Small, no internet route.
  10.42.65.0/24   data-b
  10.42.66.0/24   data-c
  10.42.128.0/17  (unallocated: room for a new tier or a fourth AZ)
\`\`\`

Leave unallocated space on purpose. Tag subnets with their tier (\`tier=app\`) so IaC and tools can find them by tag rather than by hard-coded ID: the AWS Load Balancer Controller for Kubernetes, for example, discovers subnets through the \`kubernetes.io/role/elb\` tags.

> **On real AWS:** every account comes with a **default VPC** (\`172.31.0.0/16\`) with a public subnet in every AZ and an internet gateway. It exists for quick experiments. Production accounts usually delete it, so that nothing launches into a network nobody designed. The emulator also creates a default VPC with three subnets, which is why the labs' checks look resources up by \`Name\` tag.
`,
    },
    // ------------------------------------------------------------------ 2
    {
      id: "routing",
      kind: "reading",
      title: "Routing: internet gateways, NAT and route tables",
      minutes: 15,
      body: String.raw`
Here is the single most important sentence in AWS networking: **a subnet is "public" or "private" only because of the route table associated with it.** There is no checkbox. A public subnet is one whose route table sends \`0.0.0.0/0\` to an **internet gateway**. A private subnet sends it somewhere else (a NAT gateway), or nowhere at all.

## Route tables

Every subnet is associated with exactly one **route table**. A route table that isn't explicitly associated with a subnet does nothing. Every VPC has a **main route table**, which any subnet *without* an explicit association uses implicitly.

Every route table starts with a **local route** for the VPC CIDR (\`10.0.0.0/16 → local\`) that you can't delete: everything inside a VPC can always reach everything else inside it at the routing layer. You restrict that traffic with security groups, not routes.

When a packet leaves an ENI, the VPC router picks the **most specific matching route (longest prefix match)**:

| Destination | Target | Matches |
|---|---|---|
| \`10.0.0.0/16\` | local | other subnets in this VPC |
| \`10.50.0.0/16\` | \`pcx-…\` (peering) | a peered VPC |
| \`10.0.0.0/8\` | \`tgw-…\` (Transit Gateway) | the rest of the corporate network |
| \`pl-…\` (S3 prefix list) | \`vpce-…\` | S3, through a gateway endpoint |
| \`0.0.0.0/0\` | \`nat-…\` | everything else, to the internet via NAT |

A packet to \`10.50.3.7\` matches \`10.0.0.0/8\` *and* \`10.50.0.0/16\`. The \`/16\` is longer, so it goes over the peering connection. A packet to \`10.0.4.4\` matches \`10.0.0.0/16\` (local), which always wins for in-VPC addresses. A packet to \`52.94.1.1\` only matches \`0.0.0.0/0\`. Order in the table doesn't matter: only prefix length does.

> **Pitfall:** don't put an internet route on the **main** route table. Any subnet someone creates later without an explicit association silently becomes public. Keep the main table local-only and associate every subnet explicitly in IaC.

## Internet gateway (IGW)

An IGW is a horizontally scaled, highly available VPC attachment that does two things: it routes traffic between the VPC and the internet, and it performs **1:1 NAT between an instance's private IP and its public IP**. That last point is why a public subnet needs three things before an instance is reachable from the internet:

1. a route \`0.0.0.0/0 → igw-…\` in the subnet's route table;
2. a **public IPv4 address** on the instance (auto-assigned with \`MapPublicIpOnLaunch\` on the subnet, or an Elastic IP);
3. a security group (and NACL) that allows the traffic.

Missing any one of the three is the classic "why can't I reach my instance" ticket. An IGW has no bandwidth limit and costs nothing by itself, but since February 2024 AWS charges for **every public IPv4 address** (about $3.60 a month each), which is one more reason to keep instances in private subnets behind a load balancer.

## NAT gateway: outbound-only internet for private subnets

Instances in private subnets still need outbound internet: OS updates, pulling container images, calling third-party APIs. A **NAT gateway** sits in a *public* subnet with an Elastic IP. Private route tables send \`0.0.0.0/0\` to it, and it translates the private source address to its own public one. Connections can go out and replies can come back, but nothing on the internet can open a connection in.

What bites people:

- **A NAT gateway is zonal.** If all three AZs' private subnets route through one NAT gateway in \`us-east-1a\`, losing that AZ cuts off outbound internet for the whole VPC, and you pay **cross-AZ data transfer** on every byte from the other AZs. The production pattern is **one NAT gateway per AZ, and one private route table per AZ** pointing at its local NAT gateway.
- **It's expensive.** About $0.045 an hour (roughly $33 a month) per NAT gateway, *plus* $0.045 per GB processed. A fleet pulling container images or shipping logs to S3 through NAT can cost more than the instances. Gateway endpoints (next lesson) make S3 and DynamoDB traffic free.
- **It's a capacity limit.** One NAT gateway supports about 55,000 simultaneous connections to a single destination IP and port. Very chatty workloads hit \`ErrorPortAllocation\`. Watch the CloudWatch metric of the same name.
- For dev environments, one NAT gateway (or a NAT instance) is a reasonable cost trade-off. Decide it explicitly and write it down.

**Isolated subnets** have no \`0.0.0.0/0\` route at all. Databases belong there: they never need to start a connection to the internet, so don't give them a path to it. If they need an AWS API, use a VPC endpoint.

For IPv6, an **egress-only internet gateway** plays the NAT role: outbound-only, but without address translation, because IPv6 addresses are globally unique.

## The classic three-tier, two-AZ layout

<figure class="diagram">
<svg viewBox="0 0 640 380" role="img" aria-label="A VPC across two availability zones with public, app and data subnets, an internet gateway, NAT gateways per AZ and the route tables for each tier">
  <rect x="10" y="40" width="620" height="330" rx="10" class="d-box d-outer"/>
  <text x="26" y="62" class="d-label">VPC 10.0.0.0/16</text>
  <rect x="260" y="4" width="120" height="30" rx="6" class="d-box d-accent"/><text x="320" y="24" text-anchor="middle" class="d-label">Internet gateway</text>
  <path d="M320 34 V72" class="d-arrow"/>
  <rect x="26" y="72" width="290" height="286" rx="8" class="d-box d-dim"/><text x="40" y="92" class="d-small">AZ us-east-1a</text>
  <rect x="324" y="72" width="290" height="286" rx="8" class="d-box d-dim"/><text x="338" y="92" class="d-small">AZ us-east-1b</text>
  <rect x="40" y="100" width="262" height="70" rx="6" class="d-box d-ok"/><text x="54" y="120" class="d-label">public-a 10.0.0.0/24</text><text x="54" y="138" class="d-small">ALB node, NAT gateway A</text><text x="54" y="156" class="d-small">rt: 0.0.0.0/0 → igw</text>
  <rect x="338" y="100" width="262" height="70" rx="6" class="d-box d-ok"/><text x="352" y="120" class="d-label">public-b 10.0.1.0/24</text><text x="352" y="138" class="d-small">ALB node, NAT gateway B</text><text x="352" y="156" class="d-small">rt: 0.0.0.0/0 → igw</text>
  <rect x="40" y="186" width="262" height="70" rx="6" class="d-box"/><text x="54" y="206" class="d-label">app-a 10.0.16.0/20</text><text x="54" y="224" class="d-small">instances / containers</text><text x="54" y="242" class="d-small">rt-a: 0.0.0.0/0 → NAT A</text>
  <rect x="338" y="186" width="262" height="70" rx="6" class="d-box"/><text x="352" y="206" class="d-label">app-b 10.0.32.0/20</text><text x="352" y="224" class="d-small">instances / containers</text><text x="352" y="242" class="d-small">rt-b: 0.0.0.0/0 → NAT B</text>
  <rect x="40" y="272" width="262" height="70" rx="6" class="d-box d-accent"/><text x="54" y="292" class="d-label">data-a 10.0.48.0/24</text><text x="54" y="310" class="d-small">RDS primary</text><text x="54" y="328" class="d-small">rt: local only (isolated)</text>
  <rect x="338" y="272" width="262" height="70" rx="6" class="d-box d-accent"/><text x="352" y="292" class="d-label">data-b 10.0.49.0/24</text><text x="352" y="310" class="d-small">RDS standby</text><text x="352" y="328" class="d-small">rt: local only (isolated)</text>
  <path d="M250 186 V172" class="d-arrow d-dashed"/><path d="M548 186 V172" class="d-arrow d-dashed"/>
</svg>
<figcaption>Public subnets hold only what must face the internet. Each AZ's app tier egresses through its own NAT gateway, so losing one AZ doesn't take out the other's internet access. Data subnets have no internet route at all.</figcaption>
</figure>

## Try it: a route needs a target in the same VPC

\`\`\`bash
DEMO_VPC=$(aws ec2 describe-vpcs --filters Name=tag:Name,Values=demo-vpc --query 'Vpcs[0].VpcId' --output text)
DEMO_RT=$(aws ec2 create-route-table --vpc-id "$DEMO_VPC" \
  --tag-specifications 'ResourceType=route-table,Tags=[{Key=Name,Value=demo-public-rt}]' --query RouteTable.RouteTableId --output text)
DEMO_IGW=$(aws ec2 create-internet-gateway --query InternetGateway.InternetGatewayId --output text)
aws ec2 create-route --route-table-id "$DEMO_RT" --destination-cidr-block 0.0.0.0/0 --gateway-id "$DEMO_IGW"
\`\`\`

That fails: the IGW isn't attached to this VPC yet ("belong to different networks"). Attach it and try again:

\`\`\`bash
aws ec2 attach-internet-gateway --internet-gateway-id "$DEMO_IGW" --vpc-id "$DEMO_VPC"
aws ec2 create-route --route-table-id "$DEMO_RT" --destination-cidr-block 0.0.0.0/0 --gateway-id "$DEMO_IGW"
aws ec2 describe-route-tables --route-table-ids "$DEMO_RT" --query 'RouteTables[0].Routes[].[DestinationCidrBlock, GatewayId, State]' --output table
\`\`\`

The local route was there from the start. The table still isn't associated with any subnet, so it isn't affecting anything yet. In the lab you'll associate it.

> **On real AWS:** a route can show \`State: blackhole\` when its target is gone (a deleted NAT gateway, a terminated instance). Traffic matching it is dropped silently. Alarm on it in IaC drift checks: \`aws ec2 describe-route-tables --filters Name=route.state,Values=blackhole\`.
`,
    },
    // ------------------------------------------------------------------ 3
    {
      id: "sg-nacl",
      kind: "reading",
      title: "Security groups vs network ACLs",
      minutes: 14,
      body: String.raw`
AWS gives you two packet filters inside a VPC. They look similar on the console and behave completely differently. Knowing exactly how they differ is what lets you debug a timeout in five minutes instead of five hours.

| | Security group (SG) | Network ACL (NACL) |
|---|---|---|
| Attached to | an **ENI** (instance, ALB, RDS, Lambda, endpoint…) | a **subnet** |
| State | **Stateful**: a reply to allowed traffic is allowed automatically | **Stateless**: replies must be allowed explicitly, both ways |
| Rules | **Allow only** | **Allow and deny** |
| Evaluation | All rules are evaluated together. Any match allows. | **In rule-number order**; first match wins; \`*\` (deny all) at the end |
| Sources | CIDRs, prefix lists, **other security groups** | CIDRs only |
| Default | New SG: no inbound, all outbound | Default NACL: allow all. A new custom NACL: **deny all** |

## The path of one packet

<figure class="diagram">
<svg viewBox="0 0 640 300" role="img" aria-label="A request from the ALB to an app instance crosses the ALB's security group outbound, both subnets' NACLs and the app security group inbound; the reply skips the security groups but crosses both NACLs again">
  <rect x="10" y="10" width="300" height="280" rx="10" class="d-box d-outer"/><text x="24" y="32" class="d-label">public-a subnet</text>
  <rect x="330" y="10" width="300" height="280" rx="10" class="d-box d-outer"/><text x="344" y="32" class="d-label">app-a subnet</text>
  <rect x="24" y="110" width="80" height="60" rx="6" class="d-box d-accent"/><text x="64" y="138" text-anchor="middle" class="d-label">ALB</text><text x="64" y="156" text-anchor="middle" class="d-small">ENI</text>
  <rect x="116" y="96" width="70" height="88" rx="6" class="d-box"/><text x="151" y="130" text-anchor="middle" class="d-small">alb-sg</text><text x="151" y="146" text-anchor="middle" class="d-small">outbound</text><text x="151" y="162" text-anchor="middle" class="d-small">stateful</text>
  <rect x="226" y="60" width="70" height="200" rx="6" class="d-box d-dim"/><text x="261" y="150" text-anchor="middle" class="d-small">NACL</text><text x="261" y="166" text-anchor="middle" class="d-small">out / in</text>
  <rect x="344" y="60" width="70" height="200" rx="6" class="d-box d-dim"/><text x="379" y="150" text-anchor="middle" class="d-small">NACL</text><text x="379" y="166" text-anchor="middle" class="d-small">in / out</text>
  <rect x="454" y="96" width="70" height="88" rx="6" class="d-box"/><text x="489" y="130" text-anchor="middle" class="d-small">app-sg</text><text x="489" y="146" text-anchor="middle" class="d-small">inbound</text><text x="489" y="162" text-anchor="middle" class="d-small">stateful</text>
  <rect x="540" y="110" width="80" height="60" rx="6" class="d-box d-accent"/><text x="580" y="138" text-anchor="middle" class="d-label">app</text><text x="580" y="156" text-anchor="middle" class="d-small">:8080</text>
  <path d="M104 124 H114" class="d-arrow"/><path d="M186 124 H224" class="d-arrow"/><path d="M296 124 H342" class="d-arrow"/><path d="M414 124 H452" class="d-arrow"/><path d="M524 124 H538" class="d-arrow"/>
  <text x="320" y="84" text-anchor="middle" class="d-small">request → dst port 8080</text>
  <path d="M540 220 H416" class="d-arrow d-dashed"/><path d="M344 220 H298" class="d-arrow d-dashed"/><path d="M226 220 H106" class="d-arrow d-dashed"/>
  <text x="320" y="246" text-anchor="middle" class="d-small">reply ← dst port 1024–65535 (ephemeral)</text>
  <text x="166" y="210" text-anchor="middle" class="d-small">SGs: reply tracked,</text><text x="166" y="224" text-anchor="middle" class="d-small">no rule needed</text>
</svg>
<figcaption>A request crosses four filters. The reply skips both security groups, because they track connections, but must pass both NACLs again, because NACLs don't. Inside one subnet, NACLs don't apply at all.</figcaption>
</figure>

## Security groups: your primary tool

Security groups are where almost all of your filtering should live, for three reasons:

1. **Stateful.** You write rules for the direction the connection is opened. The reply is tracked and allowed.
2. **They can reference other security groups.** "Allow TCP 8080 from \`alb-sg\`" means "from any ENI that has \`alb-sg\` attached", whatever its IP is right now. As the ALB scales out or the Auto Scaling group replaces instances, the rule stays correct. That's identity-based network policy, and it's why IP-based rules inside a VPC are a smell.
3. **They're per-ENI**, so two instances in the same subnet can have completely different exposure.

The tiered pattern you'll build in the lab:

\`\`\`text
alb-sg  inbound  tcp/443  from 0.0.0.0/0      the only thing facing the internet
app-sg  inbound  tcp/8080 from sg:alb-sg      only the load balancer can reach the app
db-sg   inbound  tcp/5432 from sg:app-sg      only the app can reach the database
\`\`\`

A compromised host elsewhere in the VPC, even in the same subnet, can't reach the database, because it doesn't carry \`app-sg\`.

Pitfalls and limits:

- **Outbound is allow-all by default.** That's convenient and usually acceptable for app tiers that call many APIs. For data tiers, remove it: a database has no reason to open connections, and removing egress takes away an exfiltration path.
- **Changes apply to existing connections differently.** Removing a rule doesn't always cut tracked connections immediately. Don't rely on SG edits as an instant kill switch during an incident; NACL denies are immediate.
- Quotas: 60 inbound and 60 outbound rules per SG and 5 SGs per ENI by default (adjustable, but the product of the two is capped). Rule sprawl is a sign that you should be using SG references or managed prefix lists.
- **Never \`0.0.0.0/0\` on SSH (22) or RDP (3389).** Use SSM Session Manager instead (module 03), and then you need no inbound rule at all.

## Network ACLs: coarse guard rails

NACLs are evaluated at the subnet boundary, in rule-number order, and **don't track connections**. If you allow inbound TCP 5432 to a data subnet, you must also allow **outbound** traffic to the client's *ephemeral* port, because the reply goes to whatever source port the client picked: 32768–60999 on Linux, 49152–65535 on Windows, and anything from 1024 upward for ELB and NAT gateway. Most teams allow \`1024-65535\` for return traffic.

Forgetting the ephemeral range is the #1 NACL bug. The symptom is a **timeout**, not a refusal: the SYN arrives, the SYN-ACK is dropped on the way out, and the client waits.

Use NACLs for:

- **Explicit denies.** SGs can't deny, so blocking a hostile CIDR quickly is a NACL job (low rule number, \`deny\`).
- **Subnet-level guard rails** that hold even if someone attaches an over-permissive SG: "nothing but the app subnets may talk to the data subnets."
- Compliance frameworks that require a second, independent layer.

Keep them simple. Number rules in steps of 10 or 100 so you can insert one later. Every VPC has a default NACL that allows everything; a NACL you create starts with only the \`*\` deny rules.

## Try it

\`\`\`bash
DEMO_VPC=$(aws ec2 describe-vpcs --filters Name=tag:Name,Values=demo-vpc --query 'Vpcs[0].VpcId' --output text)
WEB=$(aws ec2 create-security-group --vpc-id "$DEMO_VPC" --group-name demo-web --description "demo web tier" --query GroupId --output text)
API=$(aws ec2 create-security-group --vpc-id "$DEMO_VPC" --group-name demo-api --description "demo api tier" --query GroupId --output text)
aws ec2 authorize-security-group-ingress --group-id "$API" \
  --ip-permissions "IpProtocol=tcp,FromPort=8080,ToPort=8080,UserIdGroupPairs=[{GroupId=$WEB,Description=from-web-tier}]"
aws ec2 describe-security-group-rules --filters Name=group-id,Values="$API" \
  --query 'SecurityGroupRules[].{egress: IsEgress, proto: IpProtocol, port: FromPort, cidr: CidrIpv4, fromSg: ReferencedGroupInfo.GroupId}' --output table
\`\`\`

The rule references \`demo-web\` by ID, and the default all-outbound egress rule is there too. Now look at the demo VPC's default NACL: it allows everything both ways (rule 100), ahead of the final \`*\` deny (rule 32767):

\`\`\`bash
aws ec2 describe-network-acls --filters Name=vpc-id,Values="$DEMO_VPC" Name=default,Values=true \
  --query 'NetworkAcls[0].Entries[].[Egress, RuleNumber, Protocol, RuleAction, CidrBlock]' --output table
\`\`\`

> **On real AWS:** the emulator stores and validates these rules, but no packets flow between instances, because no VM boots. To debug real traffic, use **VPC Reachability Analyzer**: it evaluates routes, SGs and NACLs along a path and tells you which hop blocks it, without sending a packet.
`,
    },
    // ------------------------------------------------------------------ 4
    {
      id: "connectivity",
      kind: "reading",
      title: "Endpoints, peering, Transit Gateway and flow logs",
      minutes: 14,
      body: String.raw`
A VPC rarely lives alone. It needs to reach AWS APIs, other VPCs, and on-premises networks, and you need evidence of what traffic actually flowed. This lesson covers the building blocks for each.

## VPC endpoints: reach AWS without the internet

By default, a call from a private instance to \`s3.us-east-1.amazonaws.com\` goes out through the NAT gateway to S3's *public* endpoint. That works, but it has three costs: you pay NAT data processing on every byte, the traffic needs an internet path, and you can't write a bucket policy that says "only from my network". **VPC endpoints** fix all three.

| | Gateway endpoint | Interface endpoint (PrivateLink) |
|---|---|---|
| Services | **S3 and DynamoDB only** | Almost every AWS service, plus your own and partners' services |
| How | Adds a route to a **prefix list** in the route tables you choose | Creates an **ENI with a private IP** in each subnet you choose |
| DNS | Unchanged: the public name, routed privately | **Private DNS** makes the public name resolve to the ENI's private IP |
| Security | Endpoint policy | Endpoint policy **and** a security group on the ENI |
| Cost | **Free** | About $0.01 per hour per AZ, plus $0.01 per GB |

Every VPC that has private subnets should have **S3 and DynamoDB gateway endpoints**. They cost nothing and remove what is often the largest line item on a NAT bill: container image layers in ECR are stored in S3, and so are logs and artifacts.

Interface endpoints let **isolated** subnets, with no NAT at all, call AWS APIs: \`ssm\`, \`ssmmessages\` and \`ec2messages\` for Session Manager, \`ecr.api\` and \`ecr.dkr\` for pulling images, \`logs\`, \`sts\`, \`secretsmanager\`, \`kms\`. They cost money per AZ, so a shared-services VPC that hosts them centrally for many VPCs is common at scale.

Endpoints are also a **security control**. An endpoint policy can restrict *which* buckets are reachable through it (blocking data exfiltration to an attacker's bucket), and a bucket policy can require \`aws:SourceVpce\` so the bucket is only readable from inside your network:

\`\`\`json
{
  "Effect": "Deny",
  "Principal": "*",
  "Action": "s3:*",
  "Resource": ["arn:aws:s3:::prod-data", "arn:aws:s3:::prod-data/*"],
  "Condition": { "StringNotEquals": { "aws:SourceVpce": "vpce-0abc123" } }
}
\`\`\`

(A blanket deny like this also locks out your own console and pipeline access. Real policies add exceptions for specific roles.)

Try a gateway endpoint against the demo VPC. Watch it add a route whose destination is a **prefix list**, the managed set of S3's IP ranges:

\`\`\`bash
DEMO_VPC=$(aws ec2 describe-vpcs --filters Name=tag:Name,Values=demo-vpc --query 'Vpcs[0].VpcId' --output text)
DEMO_RT=$(aws ec2 describe-route-tables --filters Name=tag:Name,Values=demo-public-rt --query 'RouteTables[0].RouteTableId' --output text)
aws ec2 create-vpc-endpoint --vpc-id "$DEMO_VPC" --vpc-endpoint-type Gateway \
  --service-name com.amazonaws.us-east-1.s3 --route-table-ids "$DEMO_RT" --query 'VpcEndpoint.[VpcEndpointId, State]'
aws ec2 describe-route-tables --route-table-ids "$DEMO_RT" \
  --query 'RouteTables[0].Routes[].[DestinationCidrBlock || DestinationPrefixListId, GatewayId || NatGatewayId]' --output table
aws ec2 describe-prefix-lists --query 'PrefixLists[?PrefixListName==\`com.amazonaws.us-east-1.s3\`]'
\`\`\`

A prefix-list route is more specific than \`0.0.0.0/0\` for those addresses, so S3 traffic takes the endpoint and everything else still takes the default route.

## Connecting VPCs: peering vs Transit Gateway

**VPC peering** is a private, one-to-one link between two VPCs (same or different account or region). It has no bandwidth bottleneck, no hourly charge, and the lowest latency. But:

- It's **non-transitive**. If A peers with B and B peers with C, A can't reach C through B. Neither can A use B's NAT gateway, IGW or VPN.
- **CIDRs must not overlap.**
- Both sides must add routes, and both sides' SGs must allow the traffic.
- At *n* VPCs, a full mesh is n(n-1)/2 connections. At 10 VPCs that's 45 peerings and 90 route-table edits. That's where peering stops scaling.

**Transit Gateway (TGW)** is a regional cloud router. Each VPC, VPN and Direct Connect gateway attaches **once**, and TGW route tables decide who can reach whom. It's hub-and-spoke, so it's transitive by design. You can **segment** with multiple route tables: prod and dev both reach shared services, but not each other. It also lets you send all egress through one inspection VPC. You pay for it: about $0.05 per hour per attachment plus $0.02 per GB processed, so very high-volume pairs sometimes get a direct peering alongside it.

Rule of thumb: a handful of VPCs that rarely change, use peering. An organisation with many accounts, on-premises connectivity, or a need for central inspection, use Transit Gateway, usually owned by a network account and shared with others through AWS RAM.

Overlapping CIDRs bite immediately. Try to peer a new VPC that reuses the demo VPC's range:

\`\`\`bash
DEMO_VPC=$(aws ec2 describe-vpcs --filters Name=tag:Name,Values=demo-vpc --query 'Vpcs[0].VpcId' --output text)
CLASH=$(aws ec2 create-vpc --cidr-block 10.99.0.0/16 \
  --tag-specifications 'ResourceType=vpc,Tags=[{Key=Name,Value=demo-clash}]' --query Vpc.VpcId --output text)
aws ec2 create-vpc-peering-connection --vpc-id "$DEMO_VPC" --peer-vpc-id "$CLASH" --query 'VpcPeeringConnection.Status'
\`\`\`

The peering connection goes straight to \`failed\`: "overlapping CIDR range". There is no workaround short of renumbering one VPC, which is why the CIDR plan in the first lesson matters so much.

> **On real AWS:** a non-overlapping peering connection waits in \`pending-acceptance\` until the accepter runs \`accept-vpc-peering-connection\`. The emulator doesn't implement that accept call (it returns 501), so the labs don't depend on peering.

## VPC Flow Logs: what actually happened

Flow logs record metadata for each network flow on ENIs in a VPC, subnet or single interface: source and destination address and port, protocol, packets, bytes, and whether it was **ACCEPT**ed or **REJECT**ed by SGs and NACLs. They don't capture payloads (that's Traffic Mirroring).

\`\`\`text
2 000000000000 eni-0a1b2c 10.0.16.25 10.0.48.10 49152 5432 6 10 840 1700000000 1700000060 ACCEPT OK
2 000000000000 eni-0a1b2c 203.0.113.9 10.0.0.12 51515 22 6 1 60 1700000000 1700000060 REJECT OK
\`\`\`

Use them for incident response ("did anything talk to that IP?"), for debugging ("REJECT on the return path means it's a NACL, because SGs never reject replies"), and for compliance. Send them to **CloudWatch Logs** for quick queries with Logs Insights, or to **S3** (cheaper at volume, queried with Athena). Delivery to CloudWatch needs an IAM role that \`vpc-flow-logs.amazonaws.com\` can assume. Flow logs are billed per GB ingested, so busy production VPCs often log only \`REJECT\`, or use a custom format with a longer aggregation interval.

A few things flow logs **don't** record: traffic to the Amazon DNS resolver, the instance metadata service (\`169.254.169.254\`), DHCP, and the Windows license activation endpoint.

## What a senior engineer sets up from day one

1. A CIDR from the central plan. No overlap, room to grow.
2. Subnets per tier per AZ, tagged; every subnet explicitly associated; the main route table local-only.
3. NAT per AZ in prod (one is acceptable in dev, written down as a decision).
4. S3 and DynamoDB gateway endpoints on every private route table.
5. SG-to-SG references between tiers; no \`0.0.0.0/0\` except on the internet-facing load balancer.
6. Flow logs on, retained long enough for incident response.
7. All of it in IaC, because a hand-built VPC can't be reviewed, reproduced or diffed.
`,
    },
    // ------------------------------------------------------------------ lab 1
    {
      id: "build-vpc",
      kind: "lab",
      title: "Lab: Build a 2-AZ, three-tier VPC",
      minutes: 40,
      body: String.raw`
You'll build the network from the routing lesson's diagram: a \`/16\` VPC across two AZs with **public**, **app** (private, outbound through NAT) and **data** (isolated) subnets, plus a free S3 gateway endpoint.

\`cidr-plan.txt\` in the lab folder holds the subnet plan. Use it in a loop instead of typing six commands:

\`\`\`text
grep -v '^#' cidr-plan.txt | while read -r name cidr az tier; do
  echo "$name $cidr $az $tier"
done
\`\`\`

Capture every ID in a shell variable as you go (\`VPC=$(… --query Vpc.VpcId --output text)\`), and tag everything with a \`Name\`: the checks find resources by \`Name\` tag. Use \`--tag-specifications\` at creation time so a resource is never untagged, even briefly.

To save cost, this lab uses **one** NAT gateway, as a dev environment would. In production, you'd build one per AZ, each with its own app route table.

Press **Prepare lab**, then work through the tasks. Check each one as you go: the failure messages tell you exactly what's missing.
`,
      lab: {
        files: {
          "cidr-plan.txt": String.raw`
# name     cidr           az           tier
public-a   10.0.0.0/24    us-east-1a   public
public-b   10.0.1.0/24    us-east-1b   public
app-a      10.0.16.0/20   us-east-1a   app
app-b      10.0.32.0/20   us-east-1b   app
data-a     10.0.48.0/24   us-east-1a   data
data-b     10.0.49.0/24   us-east-1b   data
`,
        },
        tasks: [
          {
            id: "vpc",
            title: "Create the VPC",
            description:
              "Create a VPC with CIDR `10.0.0.0/16`, tagged `Name=lab-vpc`, with **DNS support** and **DNS hostnames** both enabled. (Hostnames are off by default on new VPCs, and interface endpoints with private DNS need both.)",
            hints: [
              "`aws ec2 create-vpc --cidr-block 10.0.0.0/16 --tag-specifications 'ResourceType=vpc,Tags=[{Key=Name,Value=lab-vpc}]'`",
              "Each attribute is a separate call: `aws ec2 modify-vpc-attribute --vpc-id $VPC --enable-dns-hostnames '{\"Value\":true}'` (and the same with `--enable-dns-support`).",
            ],
            check: async (ctx) => {
              const v = await labVpc(ctx, "lab-vpc");
              if (typeof v === "string") return v;
              if (v.CidrBlock !== "10.0.0.0/16") return `lab-vpc has CIDR ${v.CidrBlock}; expected 10.0.0.0/16.`;
              for (const attr of ["enableDnsSupport", "enableDnsHostnames"]) {
                const a = await ctx.aws(["ec2", "describe-vpc-attribute", "--vpc-id", v.VpcId, "--attribute", attr]);
                const key = attr[0].toUpperCase() + attr.slice(1);
                if (a[key]?.Value !== true) return `\`${attr}\` is not enabled on lab-vpc.`;
              }
              return true;
            },
          },
          {
            id: "subnets",
            title: "Create the six subnets",
            description:
              "Create the six subnets in `cidr-plan.txt` inside `lab-vpc`, each in its listed AZ and tagged with `Name=<name>` and `tier=<tier>` (for example `Name=app-a`, `tier=app`).",
            hints: [
              "`aws ec2 create-subnet --vpc-id $VPC --cidr-block … --availability-zone … --tag-specifications \"ResourceType=subnet,Tags=[{Key=Name,Value=$name},{Key=tier,Value=$tier}]\"`",
              "Loop over the plan: `grep -v '^#' cidr-plan.txt | while read -r name cidr az tier; do aws ec2 create-subnet … ; done`. Use double quotes around the tag spec so the shell expands `$name` and `$tier`.",
            ],
            check: async (ctx) => {
              const v = await labVpc(ctx, "lab-vpc");
              if (typeof v === "string") return v;
              const subs = await subnetsByName(ctx, v.VpcId);
              for (const [name, cidr, az, tier] of PLAN) {
                const s = subs[name];
                if (!s) return `No subnet tagged Name=${name} in lab-vpc.`;
                if (s.CidrBlock !== cidr) return `${name} has CIDR ${s.CidrBlock}; the plan says ${cidr}.`;
                if (s.AvailabilityZone !== az) return `${name} is in ${s.AvailabilityZone}; the plan says ${az}.`;
                if (tagOf(s, "tier") !== tier) return `${name} should be tagged tier=${tier}.`;
              }
              return true;
            },
          },
          {
            id: "public-routing",
            title: "Make the public subnets public",
            description: String.raw`Create an internet gateway tagged \`Name=lab-igw\` and attach it to \`lab-vpc\`. Create a route table tagged \`Name=public-rt\` with a default route (\`0.0.0.0/0\`) to the IGW, and associate it with \`public-a\` and \`public-b\`. Turn on **auto-assign public IPv4** (\`MapPublicIpOnLaunch\`) on both public subnets. Leave the VPC's **main** route table alone: it must keep only the local route.`,
            hints: [
              "Create and attach: `aws ec2 create-internet-gateway --tag-specifications 'ResourceType=internet-gateway,Tags=[{Key=Name,Value=lab-igw}]'`, then `aws ec2 attach-internet-gateway`.",
              "`aws ec2 create-route-table --vpc-id $VPC --tag-specifications …`, then `aws ec2 create-route --route-table-id $PUB_RT --destination-cidr-block 0.0.0.0/0 --gateway-id $IGW`.",
              "Look subnet IDs up by tag: `aws ec2 describe-subnets --filters Name=vpc-id,Values=$VPC Name=tag:Name,Values=public-a --query 'Subnets[0].SubnetId' --output text`. Then `aws ec2 associate-route-table --route-table-id $PUB_RT --subnet-id …` and `aws ec2 modify-subnet-attribute --subnet-id … --map-public-ip-on-launch`.",
            ],
            check: async (ctx) => {
              const v = await labVpc(ctx, "lab-vpc");
              if (typeof v === "string") return v;
              const igws = await ctx.aws(["ec2", "describe-internet-gateways", "--filters", "Name=tag:Name,Values=lab-igw"]);
              const igw = igws.InternetGateways?.[0];
              if (!igw) return "No internet gateway tagged Name=lab-igw.";
              if (!(igw.Attachments ?? []).some((a: any) => a.VpcId === v.VpcId && a.State === "available"))
                return "lab-igw isn't attached to lab-vpc.";
              const rt = await routeTableByName(ctx, v.VpcId, "public-rt");
              if (!rt) return "No route table tagged Name=public-rt in lab-vpc.";
              const def = defaultRoute(rt);
              if (def?.GatewayId !== igw.InternetGatewayId) return "public-rt needs a 0.0.0.0/0 route to lab-igw.";
              const subs = await subnetsByName(ctx, v.VpcId);
              for (const n of ["public-a", "public-b"]) {
                const s = subs[n];
                if (!s) return `Subnet ${n} is missing (complete the previous task).`;
                if (!assocSubnets(rt).includes(s.SubnetId)) return `public-rt isn't associated with ${n}.`;
                if (s.MapPublicIpOnLaunch !== true) return `${n} doesn't auto-assign public IPv4 addresses (MapPublicIpOnLaunch is false).`;
              }
              const main = await ctx.aws(["ec2", "describe-route-tables", "--filters", `Name=vpc-id,Values=${v.VpcId}`, "Name=association.main,Values=true"]);
              const m = main.RouteTables?.[0];
              if (m && defaultRoute(m)) return "The VPC's main route table has a 0.0.0.0/0 route. Remove it: any subnet without an explicit association would silently become public.";
              return true;
            },
          },
          {
            id: "nat",
            title: "Add a NAT gateway",
            description:
              "Allocate an Elastic IP and create a **public** NAT gateway in `public-a`, tagged `Name=nat-a`. Wait until it's `available` before you route to it.",
            hints: [
              "`EIP=$(aws ec2 allocate-address --domain vpc --query AllocationId --output text)`",
              "`aws ec2 create-nat-gateway --subnet-id $PUBLIC_A --allocation-id $EIP --tag-specifications 'ResourceType=natgateway,Tags=[{Key=Name,Value=nat-a}]'`",
              "`aws ec2 wait nat-gateway-available --nat-gateway-ids $NAT`",
            ],
            check: async (ctx) => {
              const v = await labVpc(ctx, "lab-vpc");
              if (typeof v === "string") return v;
              const d = await ctx.aws(["ec2", "describe-nat-gateways", "--filter", "Name=tag:Name,Values=nat-a", `Name=vpc-id,Values=${v.VpcId}`]);
              const nat = (d.NatGateways ?? []).find((n: any) => n.State !== "deleted" && n.State !== "failed");
              if (!nat) return "No NAT gateway tagged Name=nat-a in lab-vpc.";
              const subs = await subnetsByName(ctx, v.VpcId);
              if (nat.SubnetId !== subs["public-a"]?.SubnetId)
                return "nat-a must live in public-a. A NAT gateway in a private subnet has no route to the internet itself.";
              if (nat.State !== "available") return `nat-a is ${nat.State}; wait for it to become available.`;
              if (!(nat.NatGatewayAddresses ?? []).some((a: any) => a.PublicIp)) return "nat-a has no public IP (did you pass --allocation-id?).";
              return true;
            },
          },
          {
            id: "private-routing",
            title: "Route the app and data tiers",
            description: String.raw`Create two more route tables in \`lab-vpc\`:

- \`app-rt\` with \`0.0.0.0/0\` → \`nat-a\`, associated with \`app-a\` and \`app-b\` (private: outbound only).
- \`data-rt\` with **no** default route at all, associated with \`data-a\` and \`data-b\` (isolated).`,
            hints: [
              "A route to a NAT gateway uses `--nat-gateway-id`, not `--gateway-id`.",
              "`data-rt` needs nothing but the local route it's created with. Just create it and associate it.",
            ],
            check: async (ctx) => {
              const v = await labVpc(ctx, "lab-vpc");
              if (typeof v === "string") return v;
              const subs = await subnetsByName(ctx, v.VpcId);
              const app = await routeTableByName(ctx, v.VpcId, "app-rt");
              if (!app) return "No route table tagged Name=app-rt in lab-vpc.";
              const def = defaultRoute(app);
              if (!def?.NatGatewayId) return "app-rt needs a 0.0.0.0/0 route to the NAT gateway (use --nat-gateway-id).";
              const nats = await ctx.aws(["ec2", "describe-nat-gateways", "--filter", "Name=tag:Name,Values=nat-a"]);
              if (!(nats.NatGateways ?? []).some((n: any) => n.NatGatewayId === def.NatGatewayId)) return "app-rt's default route points at a NAT gateway that isn't nat-a.";
              for (const n of ["app-a", "app-b"])
                if (!subs[n] || !assocSubnets(app).includes(subs[n].SubnetId)) return `app-rt isn't associated with ${n}.`;
              const data = await routeTableByName(ctx, v.VpcId, "data-rt");
              if (!data) return "No route table tagged Name=data-rt in lab-vpc.";
              if (defaultRoute(data)) return "data-rt has a 0.0.0.0/0 route. The data tier should be isolated: local routes (and endpoints) only.";
              for (const n of ["data-a", "data-b"])
                if (!subs[n] || !assocSubnets(data).includes(subs[n].SubnetId)) return `data-rt isn't associated with ${n}.`;
              return true;
            },
          },
          {
            id: "s3-endpoint",
            title: "Add a free S3 gateway endpoint",
            description:
              "Create a **gateway** VPC endpoint for S3 (`com.amazonaws.us-east-1.s3`) in `lab-vpc`, attached to both `app-rt` and `data-rt`, so S3 traffic from those tiers never touches the NAT gateway or the internet.",
            hints: [
              "`aws ec2 create-vpc-endpoint --vpc-id $VPC --vpc-endpoint-type Gateway --service-name com.amazonaws.us-east-1.s3 --route-table-ids $APP_RT $DATA_RT`",
            ],
            check: async (ctx) => {
              const v = await labVpc(ctx, "lab-vpc");
              if (typeof v === "string") return v;
              const d = await ctx.aws(["ec2", "describe-vpc-endpoints", "--filters", `Name=vpc-id,Values=${v.VpcId}`, "Name=service-name,Values=com.amazonaws.us-east-1.s3"]);
              const ep = (d.VpcEndpoints ?? []).find((e: any) => e.VpcEndpointType === "Gateway" && e.State !== "deleted");
              if (!ep) return "No S3 gateway endpoint in lab-vpc. (An Interface endpoint costs money; for S3 inside the VPC, use Gateway.)";
              for (const n of ["app-rt", "data-rt"]) {
                const rt = await routeTableByName(ctx, v.VpcId, n);
                if (!rt || !(ep.RouteTableIds ?? []).includes(rt.RouteTableId)) return `The S3 endpoint isn't attached to ${n}.`;
              }
              return true;
            },
          },
        ],
        solution: String.raw`
VPC=$(aws ec2 create-vpc --cidr-block 10.0.0.0/16 \
  --tag-specifications 'ResourceType=vpc,Tags=[{Key=Name,Value=lab-vpc}]' --query Vpc.VpcId --output text)
aws ec2 modify-vpc-attribute --vpc-id "$VPC" --enable-dns-support '{"Value":true}'
aws ec2 modify-vpc-attribute --vpc-id "$VPC" --enable-dns-hostnames '{"Value":true}'

grep -v '^#' cidr-plan.txt | while read -r name cidr az tier; do
  [ -n "$name" ] || continue
  aws ec2 create-subnet --vpc-id "$VPC" --cidr-block "$cidr" --availability-zone "$az" \
    --tag-specifications "ResourceType=subnet,Tags=[{Key=Name,Value=$name},{Key=tier,Value=$tier}]" >/dev/null
done
sub() { aws ec2 describe-subnets --filters Name=vpc-id,Values="$VPC" Name=tag:Name,Values="$1" --query 'Subnets[0].SubnetId' --output text; }

IGW=$(aws ec2 create-internet-gateway \
  --tag-specifications 'ResourceType=internet-gateway,Tags=[{Key=Name,Value=lab-igw}]' --query InternetGateway.InternetGatewayId --output text)
aws ec2 attach-internet-gateway --internet-gateway-id "$IGW" --vpc-id "$VPC"
PUB_RT=$(aws ec2 create-route-table --vpc-id "$VPC" \
  --tag-specifications 'ResourceType=route-table,Tags=[{Key=Name,Value=public-rt}]' --query RouteTable.RouteTableId --output text)
aws ec2 create-route --route-table-id "$PUB_RT" --destination-cidr-block 0.0.0.0/0 --gateway-id "$IGW"
for n in public-a public-b; do
  aws ec2 associate-route-table --route-table-id "$PUB_RT" --subnet-id "$(sub $n)" >/dev/null
  aws ec2 modify-subnet-attribute --subnet-id "$(sub $n)" --map-public-ip-on-launch
done

EIP=$(aws ec2 allocate-address --domain vpc --query AllocationId --output text)
NAT=$(aws ec2 create-nat-gateway --subnet-id "$(sub public-a)" --allocation-id "$EIP" \
  --tag-specifications 'ResourceType=natgateway,Tags=[{Key=Name,Value=nat-a}]' --query NatGateway.NatGatewayId --output text)
aws ec2 wait nat-gateway-available --nat-gateway-ids "$NAT"

APP_RT=$(aws ec2 create-route-table --vpc-id "$VPC" \
  --tag-specifications 'ResourceType=route-table,Tags=[{Key=Name,Value=app-rt}]' --query RouteTable.RouteTableId --output text)
aws ec2 create-route --route-table-id "$APP_RT" --destination-cidr-block 0.0.0.0/0 --nat-gateway-id "$NAT"
DATA_RT=$(aws ec2 create-route-table --vpc-id "$VPC" \
  --tag-specifications 'ResourceType=route-table,Tags=[{Key=Name,Value=data-rt}]' --query RouteTable.RouteTableId --output text)
for n in app-a app-b; do aws ec2 associate-route-table --route-table-id "$APP_RT" --subnet-id "$(sub $n)" >/dev/null; done
for n in data-a data-b; do aws ec2 associate-route-table --route-table-id "$DATA_RT" --subnet-id "$(sub $n)" >/dev/null; done

aws ec2 create-vpc-endpoint --vpc-id "$VPC" --vpc-endpoint-type Gateway \
  --service-name com.amazonaws.us-east-1.s3 --route-table-ids "$APP_RT" "$DATA_RT" >/dev/null
`,
      },
    },
    // ------------------------------------------------------------------ lab 2
    {
      id: "security-layers",
      kind: "lab",
      title: "Lab: Tiered security groups, a NACL and flow logs",
      minutes: 35,
      body: String.raw`
**Prepare lab** creates \`sec-vpc\` (\`10.1.0.0/16\`) with the same six-subnet layout as the previous lab:

\`\`\`text
public-a 10.1.0.0/24   app-a 10.1.16.0/20   data-a 10.1.48.0/24
public-b 10.1.1.0/24   app-b 10.1.32.0/20   data-b 10.1.49.0/24
\`\`\`

You'll lock it down in layers: tiered **security groups** that reference each other, a **NACL** that fences off the data subnets even if someone attaches a sloppy SG, and **flow logs** so you can see what was accepted and rejected.

Start by capturing the VPC ID:

\`\`\`bash
VPC=$(aws ec2 describe-vpcs --filters Name=tag:Name,Values=sec-vpc --query 'Vpcs[0].VpcId' --output text); echo "$VPC"
\`\`\`

Remember that SG names are only unique *per VPC*, so always pass \`--vpc-id\` when you create one, and use the **group ID** (\`sg-…\`) when you reference one.
`,
      lab: {
        setup: SEC_SETUP,
        tasks: [
          {
            id: "alb-sg",
            title: "Internet-facing tier: alb-sg",
            description:
              "In `sec-vpc`, create a security group named `alb-sg` that allows inbound **TCP 443 from anywhere** (`0.0.0.0/0`) and nothing else inbound. This is the only SG in the design that accepts traffic from the internet.",
            hints: [
              "`aws ec2 create-security-group --vpc-id $VPC --group-name alb-sg --description \"Public ALB\" --query GroupId --output text`",
              "`aws ec2 authorize-security-group-ingress --group-id $ALB_SG --protocol tcp --port 443 --cidr 0.0.0.0/0`",
            ],
            check: async (ctx) => {
              const v = await labVpc(ctx, "sec-vpc");
              if (typeof v === "string") return v + " Press Prepare lab.";
              const sg = await sgByName(ctx, v.VpcId, "alb-sg");
              if (!sg) return "No security group named `alb-sg` in sec-vpc.";
              const rules = flatIngress(sg);
              if (!rules.some((r) => r.proto === "tcp" && r.from === 443 && r.to === 443 && r.cidr === "0.0.0.0/0"))
                return "alb-sg doesn't allow TCP 443 from 0.0.0.0/0.";
              const extra = rules.find((r) => !(r.proto === "tcp" && r.from === 443 && r.to === 443 && (r.cidr === "0.0.0.0/0" || r.cidr === "::/0")));
              if (extra) return `alb-sg has an extra inbound rule (${extra.proto} ${extra.from ?? "all"}-${extra.to ?? "all"} from ${extra.cidr ?? extra.group}). Only 443 should be open.`;
              return true;
            },
          },
          {
            id: "app-sg",
            title: "App tier: only from the ALB",
            description:
              "Create `app-sg` in `sec-vpc` allowing inbound **TCP 8080 only from `alb-sg`** (a security-group reference, not a CIDR). Nothing else inbound.",
            hints: [
              "`--source-group $ALB_SG` instead of `--cidr`.",
              "`aws ec2 authorize-security-group-ingress --group-id $APP_SG --protocol tcp --port 8080 --source-group $ALB_SG`",
            ],
            check: async (ctx) => {
              const v = await labVpc(ctx, "sec-vpc");
              if (typeof v === "string") return v + " Press Prepare lab.";
              return checkTierSg(ctx, v.VpcId, "app-sg", 8080, "alb-sg");
            },
          },
          {
            id: "db-sg",
            title: "Data tier: only from the app, and no egress",
            description:
              "Create `db-sg` in `sec-vpc` allowing inbound **TCP 5432 only from `app-sg`**. Then **remove the default allow-all outbound rule**: a database never needs to open connections, and with no egress rule, a compromised database can't phone home. (Replies to allowed inbound connections still work, because SGs are stateful.)",
            hints: [
              "Ingress is the same pattern as app-sg, with port 5432 and `--source-group $APP_SG`.",
              "`aws ec2 revoke-security-group-egress --group-id $DB_SG --protocol all --cidr 0.0.0.0/0`",
            ],
            check: async (ctx) => {
              const v = await labVpc(ctx, "sec-vpc");
              if (typeof v === "string") return v + " Press Prepare lab.";
              const r = await checkTierSg(ctx, v.VpcId, "db-sg", 5432, "app-sg");
              if (r !== true) return r;
              const sg = await sgByName(ctx, v.VpcId, "db-sg");
              if ((sg.IpPermissionsEgress ?? []).length) return "db-sg still has outbound rules. Revoke the default allow-all egress rule.";
              return true;
            },
          },
          {
            id: "data-nacl",
            title: "Fence the data subnets with a NACL",
            description: String.raw`Create a network ACL tagged \`Name=data-nacl\` in \`sec-vpc\` and associate it with \`data-a\` and \`data-b\`. Because NACLs are **stateless**, it needs rules in both directions:

- **Inbound** allow TCP \`5432\` from each app subnet: \`10.1.16.0/20\` and \`10.1.32.0/20\`.
- **Outbound** allow TCP \`1024-65535\` (the return traffic to the clients' ephemeral ports) to each app subnet.

Everything else falls through to the final \`*\` deny.`,
            hints: [
              "`aws ec2 create-network-acl --vpc-id $VPC --tag-specifications 'ResourceType=network-acl,Tags=[{Key=Name,Value=data-nacl}]'`. Add rules with `aws ec2 create-network-acl-entry --network-acl-id $NACL --rule-number 100 --protocol tcp --port-range From=5432,To=5432 --cidr-block 10.1.16.0/20 --rule-action allow --ingress` (use `--egress` for outbound; rule numbers are per direction).",
              "Subnets are always associated with *some* NACL, so you **replace** the association: find the current one with `aws ec2 describe-network-acls --filters Name=association.subnet-id,Values=$SUBNET --query \"NetworkAcls[0].Associations[?SubnetId=='$SUBNET'].NetworkAclAssociationId\" --output text`.",
              "Then `aws ec2 replace-network-acl-association --association-id $ASSOC --network-acl-id $NACL`. Do it for both data subnets.",
            ],
            check: async (ctx) => {
              const v = await labVpc(ctx, "sec-vpc");
              if (typeof v === "string") return v + " Press Prepare lab.";
              const d = await ctx.aws(["ec2", "describe-network-acls", "--filters", `Name=vpc-id,Values=${v.VpcId}`, "Name=tag:Name,Values=data-nacl"]);
              const acl = d.NetworkAcls?.[0];
              if (!acl) return "No network ACL tagged Name=data-nacl in sec-vpc.";
              const subs = await subnetsByName(ctx, v.VpcId);
              const assoc = (acl.Associations ?? []).map((a: any) => a.SubnetId);
              for (const n of ["data-a", "data-b"]) if (!assoc.includes(subs[n]?.SubnetId)) return `data-nacl isn't associated with ${n}.`;
              for (const n of ["app-a", "app-b", "public-a", "public-b"])
                if (assoc.includes(subs[n]?.SubnetId)) return `data-nacl is associated with ${n}; it should only guard the data subnets.`;
              const entries = (acl.Entries ?? []).filter((e: any) => e.RuleNumber < 32767);
              const allows = (egress: boolean, cidr: string, from: number, to: number) =>
                entries.some(
                  (e: any) =>
                    e.Egress === egress && e.RuleAction === "allow" && e.CidrBlock === cidr && (e.Protocol === "6" || e.Protocol === "-1") &&
                    (e.Protocol === "-1" || (e.PortRange?.From <= from && e.PortRange?.To >= to)),
                );
              for (const cidr of ["10.1.16.0/20", "10.1.32.0/20"]) {
                if (!allows(false, cidr, 5432, 5432)) return `No inbound rule allows TCP 5432 from ${cidr}.`;
                if (!allows(true, cidr, 1024, 65535))
                  return `No outbound rule allows TCP 1024-65535 to ${cidr}. Without it, Postgres replies are dropped and clients time out: NACLs are stateless.`;
              }
              const wide = entries.find((e: any) => e.RuleAction === "allow" && e.CidrBlock === "0.0.0.0/0");
              if (wide) return `data-nacl rule ${wide.RuleNumber} allows 0.0.0.0/0. Only the app subnets should get through.`;
              return true;
            },
          },
          {
            id: "flow-logs",
            title: "Turn on VPC flow logs",
            description: String.raw`Record every flow in \`sec-vpc\` to CloudWatch Logs:

1. Create the log group \`/vpc/sec-vpc/flow-logs\` (with a retention period: logs that never expire are a cost leak).
2. Create an IAM role \`vpc-flow-logs-role\` that **\`vpc-flow-logs.amazonaws.com\`** can assume, with an inline policy allowing \`logs:CreateLogStream\`, \`logs:PutLogEvents\`, \`logs:DescribeLogGroups\` and \`logs:DescribeLogStreams\`.
3. Create a flow log on the VPC with traffic type \`ALL\`, delivering to that log group with that role.`,
            hints: [
              "`aws logs create-log-group --log-group-name /vpc/sec-vpc/flow-logs` and `aws logs put-retention-policy --log-group-name /vpc/sec-vpc/flow-logs --retention-in-days 30`.",
              "The trust policy's principal is `{\"Service\": \"vpc-flow-logs.amazonaws.com\"}`. Attach permissions with `aws iam put-role-policy --role-name vpc-flow-logs-role --policy-name deliver --policy-document file://…`.",
              "`aws ec2 create-flow-logs --resource-type VPC --resource-ids $VPC --traffic-type ALL --log-destination-type cloud-watch-logs --log-group-name /vpc/sec-vpc/flow-logs --deliver-logs-permission-arn arn:aws:iam::000000000000:role/vpc-flow-logs-role`",
            ],
            check: async (ctx) => {
              const v = await labVpc(ctx, "sec-vpc");
              if (typeof v === "string") return v + " Press Prepare lab.";
              const lg = await ctx.aws(["logs", "describe-log-groups", "--log-group-name-prefix", "/vpc/sec-vpc/flow-logs"]);
              const group = (lg.logGroups ?? []).find((g: any) => g.logGroupName === "/vpc/sec-vpc/flow-logs");
              if (!group) return "Log group `/vpc/sec-vpc/flow-logs` doesn't exist.";
              if (!group.retentionInDays) return "The log group never expires. Set a retention policy (put-retention-policy).";
              const role = await ctx.tryAws(["iam", "get-role", "--role-name", "vpc-flow-logs-role"]);
              if (!role.ok) return "Role `vpc-flow-logs-role` doesn't exist.";
              const trust = JSON.stringify(role.data.Role.AssumeRolePolicyDocument ?? "");
              if (!trust.includes("vpc-flow-logs.amazonaws.com")) return "vpc-flow-logs-role's trust policy must allow the service principal vpc-flow-logs.amazonaws.com.";
              const inline = await ctx.aws(["iam", "list-role-policies", "--role-name", "vpc-flow-logs-role"]);
              const attached = await ctx.aws(["iam", "list-attached-role-policies", "--role-name", "vpc-flow-logs-role"]);
              if (!(inline.PolicyNames ?? []).length && !(attached.AttachedPolicies ?? []).length)
                return "vpc-flow-logs-role has no permissions policy, so it couldn't write to CloudWatch Logs.";
              const fl = await ctx.aws(["ec2", "describe-flow-logs", "--filter", `Name=resource-id,Values=${v.VpcId}`]);
              const f = (fl.FlowLogs ?? []).find((x: any) => x.LogGroupName === "/vpc/sec-vpc/flow-logs");
              if (!f) return "No flow log on sec-vpc delivers to /vpc/sec-vpc/flow-logs.";
              if (f.TrafficType !== "ALL") return `The flow log captures ${f.TrafficType}; this task asks for ALL.`;
              if (!String(f.DeliverLogsPermissionArn ?? "").endsWith(":role/vpc-flow-logs-role")) return "The flow log should deliver using vpc-flow-logs-role.";
              return true;
            },
          },
        ],
        solution: String.raw`
VPC=$(aws ec2 describe-vpcs --filters Name=tag:Name,Values=sec-vpc --query 'Vpcs[0].VpcId' --output text)
sub() { aws ec2 describe-subnets --filters Name=vpc-id,Values="$VPC" Name=tag:Name,Values="$1" --query 'Subnets[0].SubnetId' --output text; }

ALB_SG=$(aws ec2 create-security-group --vpc-id "$VPC" --group-name alb-sg --description "Public ALB" --query GroupId --output text)
aws ec2 authorize-security-group-ingress --group-id "$ALB_SG" --protocol tcp --port 443 --cidr 0.0.0.0/0 >/dev/null
APP_SG=$(aws ec2 create-security-group --vpc-id "$VPC" --group-name app-sg --description "App tier" --query GroupId --output text)
aws ec2 authorize-security-group-ingress --group-id "$APP_SG" --protocol tcp --port 8080 --source-group "$ALB_SG" >/dev/null
DB_SG=$(aws ec2 create-security-group --vpc-id "$VPC" --group-name db-sg --description "Postgres" --query GroupId --output text)
aws ec2 authorize-security-group-ingress --group-id "$DB_SG" --protocol tcp --port 5432 --source-group "$APP_SG" >/dev/null
aws ec2 revoke-security-group-egress --group-id "$DB_SG" --protocol all --cidr 0.0.0.0/0 >/dev/null

NACL=$(aws ec2 create-network-acl --vpc-id "$VPC" \
  --tag-specifications 'ResourceType=network-acl,Tags=[{Key=Name,Value=data-nacl}]' --query NetworkAcl.NetworkAclId --output text)
n=100
for cidr in 10.1.16.0/20 10.1.32.0/20; do
  aws ec2 create-network-acl-entry --network-acl-id "$NACL" --ingress --rule-number $n --protocol tcp \
    --port-range From=5432,To=5432 --cidr-block "$cidr" --rule-action allow
  aws ec2 create-network-acl-entry --network-acl-id "$NACL" --egress --rule-number $n --protocol tcp \
    --port-range From=1024,To=65535 --cidr-block "$cidr" --rule-action allow
  n=$((n + 10))
done
for s in data-a data-b; do
  SID=$(sub $s)
  ASSOC=$(aws ec2 describe-network-acls --filters Name=association.subnet-id,Values="$SID" \
    --query "NetworkAcls[0].Associations[?SubnetId=='$SID'].NetworkAclAssociationId" --output text)
  aws ec2 replace-network-acl-association --association-id "$ASSOC" --network-acl-id "$NACL" >/dev/null
done

aws logs create-log-group --log-group-name /vpc/sec-vpc/flow-logs
aws logs put-retention-policy --log-group-name /vpc/sec-vpc/flow-logs --retention-in-days 30
aws iam create-role --role-name vpc-flow-logs-role --assume-role-policy-document '{
  "Version": "2012-10-17",
  "Statement": [{"Effect": "Allow", "Principal": {"Service": "vpc-flow-logs.amazonaws.com"}, "Action": "sts:AssumeRole"}]
}' >/dev/null
aws iam put-role-policy --role-name vpc-flow-logs-role --policy-name deliver --policy-document '{
  "Version": "2012-10-17",
  "Statement": [{"Effect": "Allow", "Resource": "*",
    "Action": ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogGroups", "logs:DescribeLogStreams"]}]
}'
aws ec2 create-flow-logs --resource-type VPC --resource-ids "$VPC" --traffic-type ALL \
  --log-destination-type cloud-watch-logs --log-group-name /vpc/sec-vpc/flow-logs \
  --deliver-logs-permission-arn arn:aws:iam::000000000000:role/vpc-flow-logs-role >/dev/null
`,
      },
    },
  ],
  quiz: [
    {
      q: "Your company runs VPCs `10.0.0.0/16` (prod) and `10.0.0.0/16` (an acquired company's VPC). Leadership wants them connected next week. What's the realistic answer?",
      options: [
        "Create a VPC peering connection and add routes on both sides",
        "Attach both to a Transit Gateway; it handles the overlap",
        "Peering and Transit Gateway can't route between overlapping CIDRs; one side needs renumbering, or you expose specific services with PrivateLink or private NAT",
        "Add a secondary CIDR to one VPC and the overlap goes away",
      ],
      answer: 2,
      explain:
        "Overlapping ranges can't be routed to each other: peering fails outright and TGW can't decide which side a destination belongs to. Adding a secondary CIDR doesn't remove the overlapping primary. The practical options are exposing specific services through **PrivateLink** (an NLB plus an endpoint service, which doesn't care about overlap), a private NAT gateway, or renumbering. That's why central CIDR planning matters on day one.",
    },
    {
      q: "An instance in a subnet whose route table has `0.0.0.0/0 → igw-…` can't be reached from the internet on port 443. Its security group allows 443 from 0.0.0.0/0. What's the most likely missing piece?",
      options: [
        "A NAT gateway in the subnet",
        "The instance has no public IPv4 address (the subnet doesn't auto-assign one, and no Elastic IP is attached)",
        "The VPC needs DNS hostnames enabled",
        "A gateway endpoint for EC2",
      ],
      answer: 1,
      explain:
        "Inbound internet access needs three things: a route to an IGW, a **public IP** on the instance (the IGW does 1:1 NAT between it and the private IP), and SG/NACL rules that allow the traffic. NAT gateways are for *outbound* traffic from private subnets. In practice, the better fix is to put an ALB in front and keep the instance private.",
    },
    {
      q: "You add a custom NACL to your data subnets that allows inbound TCP 5432 from the app subnets. Connections from the app now time out (no error, just a hang). The SGs are correct. Why?",
      options: [
        "NACLs are stateless: the outbound reply to the client's ephemeral port (1024-65535) isn't allowed, so the SYN-ACK is dropped",
        "NACL rules take 15 minutes to propagate",
        "The NACL needs a rule allowing outbound TCP 5432",
        "Security groups and NACLs can't both be used on one subnet",
      ],
      answer: 0,
      explain:
        "A new custom NACL denies everything not explicitly allowed, in both directions. The reply goes from port 5432 to the client's **ephemeral** source port, so you need an outbound allow for TCP 1024-65535 to the app subnets. Outbound 5432 is the wrong direction. A timeout rather than a refusal is the classic sign of a dropped reply.",
    },
    {
      q: "Your NAT gateway bill is larger than your EC2 bill. The workloads pull images from ECR and ship logs and artifacts to S3. What's the highest-impact, lowest-risk change?",
      options: [
        "Move the instances to public subnets",
        "Add an S3 gateway endpoint to the private route tables (free), and consider interface endpoints for ECR",
        "Replace the NAT gateway with a larger instance type",
        "Enable VPC flow logs",
      ],
      answer: 1,
      explain:
        "S3 gateway endpoints cost nothing and take all S3 traffic off the NAT path, and ECR image layers are served from S3. Interface endpoints for `ecr.api`/`ecr.dkr` cost a little per hour but avoid NAT processing for the API calls. Moving instances to public subnets trades a cost problem for a security problem.",
    },
    {
      q: "Your app subnets in three AZs all route `0.0.0.0/0` to a single NAT gateway in us-east-1a. What are the two problems?",
      options: [
        "There are none: NAT gateways are regional",
        "Losing us-east-1a cuts off outbound internet for all three AZs, and traffic from the other AZs pays cross-AZ data transfer",
        "NAT gateways can only serve subnets in their own AZ, so the other AZs have no internet access now",
        "It breaks inbound traffic through the ALB",
      ],
      answer: 1,
      explain:
        "A NAT gateway is a **zonal** resource. Routing other AZs through it works, but it creates a single-AZ dependency and cross-AZ charges. Production uses one NAT gateway per AZ and one private route table per AZ. Inbound ALB traffic doesn't use NAT at all.",
    },
    {
      q: "A route table has `10.0.0.0/8 → tgw-1`, `10.20.0.0/16 → pcx-2`, and `0.0.0.0/0 → nat-3`. Where does a packet to 10.20.5.9 go?",
      options: ["tgw-1, because it's listed first", "pcx-2, because /16 is the longest matching prefix", "nat-3, the default route", "It's dropped, because two routes match"],
      answer: 1,
      explain:
        "VPC routing uses **longest prefix match**. Both 10.0.0.0/8 and 10.20.0.0/16 match, and /16 is more specific, so the packet takes the peering connection. The order of routes in the table is irrelevant.",
    },
    {
      q: "Why does the app tier's security group allow port 8080 from `sg-alb` rather than from the public subnets' CIDRs?",
      options: [
        "SG references are faster to evaluate",
        "CIDR rules aren't allowed in security groups inside a VPC",
        "An SG reference allows exactly the ENIs that carry alb-sg, whatever their IPs, so it stays correct as the ALB scales and excludes anything else that lands in those subnets",
        "SG references also open the return path through the NACL",
      ],
      answer: 2,
      explain:
        "SG-to-SG references are identity-based: they match the *group membership* of the source ENI, not its address. A CIDR rule would also admit a NAT gateway, a bastion, or anything else that ever gets an IP in the public subnets, and it can't follow the ALB's changing node IPs precisely. NACLs are independent of SGs.",
    },
  ],
};
