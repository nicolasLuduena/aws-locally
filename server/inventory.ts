// A read-only "console" for the emulator, which has no GUI of its own.
// Each section lists one kind of resource. After the proxy sees a mutating
// call, only the sections for that service are refreshed.

import { runAws, type RunEnv } from "./labs.ts";

export interface InvItem {
  name: string;
  detail?: string;
  status?: string;
}

export interface InvSection {
  id: string;
  title: string;
  group: string;
  items: InvItem[];
  error?: string;
}

export interface Subnet {
  id: string;
  cidr: string;
  az: string;
  name: string;
  public: boolean;
  instances: { id: string; state: string; ip: string; name: string }[];
}
export interface Vpc {
  id: string;
  cidr: string;
  name: string;
  isDefault: boolean;
  igw: string | null;
  nats: string[];
  subnets: Subnet[];
  securityGroups: { id: string; name: string; rules: string[] }[];
}

interface SectionDef {
  id: string;
  title: string;
  group: string;
  /** SigV4 service names whose mutations make this section stale. */
  services: string[];
  load: (aws: (args: string[]) => Promise<any>) => Promise<InvItem[]>;
}

const nameTag = (tags?: { Key: string; Value: string }[]) => tags?.find((t) => t.Key === "Name")?.Value ?? "";
const last = (arn: string) => arn.split(/[:/]/).pop() ?? arn;

const SECTIONS: SectionDef[] = [
  {
    id: "iam-roles",
    title: "IAM roles",
    group: "Identity",
    services: ["iam", "sts"],
    load: async (aws) =>
      ((await aws(["iam", "list-roles"])).Roles ?? [])
        .filter((r: any) => !/^\/(aws-service-role|service-role\/aws)/.test(r.Path))
        .map((r: any) => ({ name: r.RoleName, detail: trustSummary(r.AssumeRolePolicyDocument) })),
  },
  {
    id: "iam-users",
    title: "IAM users",
    group: "Identity",
    services: ["iam"],
    load: async (aws) => ((await aws(["iam", "list-users"])).Users ?? []).map((u: any) => ({ name: u.UserName, detail: u.Arn })),
  },
  {
    id: "iam-policies",
    title: "Customer managed policies",
    group: "Identity",
    services: ["iam"],
    load: async (aws) =>
      ((await aws(["iam", "list-policies", "--scope", "Local"])).Policies ?? []).map((p: any) => ({
        name: p.PolicyName,
        detail: `${p.AttachmentCount} attachment(s)`,
      })),
  },
  {
    id: "ec2-instances",
    title: "EC2 instances",
    group: "Compute",
    services: ["ec2", "autoscaling"],
    load: async (aws) =>
      ((await aws(["ec2", "describe-instances"])).Reservations ?? []).flatMap((r: any) =>
        r.Instances.map((i: any) => ({
          name: nameTag(i.Tags) || i.InstanceId,
          detail: `${i.InstanceId} · ${i.InstanceType} · ${i.PrivateIpAddress ?? "no ip"}`,
          status: i.State?.Name,
        })),
      ),
  },
  {
    id: "asg",
    title: "Auto Scaling groups",
    group: "Compute",
    services: ["autoscaling"],
    load: async (aws) =>
      ((await aws(["autoscaling", "describe-auto-scaling-groups"])).AutoScalingGroups ?? []).map((g: any) => ({
        name: g.AutoScalingGroupName,
        detail: `min ${g.MinSize} · desired ${g.DesiredCapacity} · max ${g.MaxSize} · ${g.Instances?.length ?? 0} instance(s)`,
      })),
  },
  {
    id: "elbv2",
    title: "Load balancers",
    group: "Compute",
    services: ["elasticloadbalancing"],
    load: async (aws) =>
      ((await aws(["elbv2", "describe-load-balancers"])).LoadBalancers ?? []).map((l: any) => ({
        name: l.LoadBalancerName,
        detail: `${l.Type} · ${l.Scheme} · ${l.DNSName}`,
        status: l.State?.Code,
      })),
  },
  {
    id: "lambda",
    title: "Lambda functions",
    group: "Serverless",
    services: ["lambda"],
    load: async (aws) =>
      ((await aws(["lambda", "list-functions"])).Functions ?? []).map((f: any) => ({
        name: f.FunctionName,
        detail: `${f.Runtime ?? f.PackageType} · ${f.Handler ?? ""} · ${f.MemorySize}MB · role ${last(f.Role)}`,
      })),
  },
  {
    id: "apis",
    title: "API Gateway APIs",
    group: "Serverless",
    services: ["apigateway"],
    load: async (aws) => {
      const v2 = ((await aws(["apigatewayv2", "get-apis"])).Items ?? []).map((a: any) => ({
        name: a.Name,
        detail: `${a.ProtocolType} · id ${a.ApiId}`,
      }));
      const v1 = ((await aws(["apigateway", "get-rest-apis"])).items ?? []).map((a: any) => ({
        name: a.name,
        detail: `REST · id ${a.id}`,
      }));
      return [...v2, ...v1];
    },
  },
  {
    id: "sfn",
    title: "Step Functions state machines",
    group: "Serverless",
    services: ["states"],
    load: async (aws) =>
      ((await aws(["stepfunctions", "list-state-machines"])).stateMachines ?? []).map((m: any) => ({
        name: m.name,
        detail: m.type,
      })),
  },
  {
    id: "ecs",
    title: "ECS clusters",
    group: "Containers",
    services: ["ecs"],
    load: async (aws) => {
      const arns: string[] = (await aws(["ecs", "list-clusters"])).clusterArns ?? [];
      if (!arns.length) return [];
      const d = await aws(["ecs", "describe-clusters", "--clusters", ...arns]);
      return (d.clusters ?? []).map((c: any) => ({
        name: c.clusterName,
        detail: `${c.activeServicesCount} service(s) · ${c.runningTasksCount} running task(s)`,
        status: c.status,
      }));
    },
  },
  {
    id: "ecr",
    title: "ECR repositories",
    group: "Containers",
    services: ["ecr"],
    load: async (aws) =>
      ((await aws(["ecr", "describe-repositories"])).repositories ?? []).map((r: any) => ({
        name: r.repositoryName,
        detail: r.repositoryUri,
      })),
  },
  {
    id: "s3",
    title: "S3 buckets",
    group: "Storage & data",
    services: ["s3"],
    load: async (aws) => ((await aws(["s3api", "list-buckets"])).Buckets ?? []).map((b: any) => ({ name: b.Name })),
  },
  {
    id: "dynamodb",
    title: "DynamoDB tables",
    group: "Storage & data",
    services: ["dynamodb"],
    load: async (aws) => ((await aws(["dynamodb", "list-tables"])).TableNames ?? []).map((n: string) => ({ name: n })),
  },
  {
    id: "rds",
    title: "RDS instances",
    group: "Storage & data",
    services: ["rds"],
    load: async (aws) =>
      ((await aws(["rds", "describe-db-instances"])).DBInstances ?? []).map((d: any) => ({
        name: d.DBInstanceIdentifier,
        detail: `${d.Engine} · ${d.DBInstanceClass}${d.MultiAZ ? " · Multi-AZ" : ""}`,
        status: d.DBInstanceStatus,
      })),
  },
  {
    id: "sqs",
    title: "SQS queues",
    group: "Messaging",
    services: ["sqs"],
    load: async (aws) => ((await aws(["sqs", "list-queues"]))?.QueueUrls ?? []).map((u: string) => ({ name: last(u), detail: u })),
  },
  {
    id: "sns",
    title: "SNS topics",
    group: "Messaging",
    services: ["sns"],
    load: async (aws) => ((await aws(["sns", "list-topics"])).Topics ?? []).map((t: any) => ({ name: last(t.TopicArn), detail: t.TopicArn })),
  },
  {
    id: "events",
    title: "EventBridge rules",
    group: "Messaging",
    services: ["events"],
    load: async (aws) =>
      ((await aws(["events", "list-rules"])).Rules ?? []).map((r: any) => ({
        name: r.Name,
        detail: r.EventPattern ?? r.ScheduleExpression ?? "",
        status: r.State,
      })),
  },
  {
    id: "kms",
    title: "KMS keys (aliases)",
    group: "Security",
    services: ["kms"],
    load: async (aws) =>
      ((await aws(["kms", "list-aliases"])).Aliases ?? [])
        .filter((a: any) => !a.AliasName.startsWith("alias/aws/"))
        .map((a: any) => ({ name: a.AliasName, detail: a.TargetKeyId ?? "" })),
  },
  {
    id: "secrets",
    title: "Secrets Manager",
    group: "Security",
    services: ["secretsmanager"],
    load: async (aws) =>
      ((await aws(["secretsmanager", "list-secrets"])).SecretList ?? []).map((s: any) => ({
        name: s.Name,
        detail: s.RotationEnabled ? "rotation on" : "rotation off",
      })),
  },
  {
    id: "ssm",
    title: "SSM parameters",
    group: "Security",
    services: ["ssm"],
    load: async (aws) =>
      ((await aws(["ssm", "describe-parameters"])).Parameters ?? []).map((p: any) => ({ name: p.Name, detail: p.Type })),
  },
  {
    id: "cfn",
    title: "CloudFormation stacks",
    group: "Operations",
    services: ["cloudformation"],
    load: async (aws) =>
      ((await aws(["cloudformation", "describe-stacks"])).Stacks ?? []).map((s: any) => ({
        name: s.StackName,
        status: s.StackStatus,
        detail: (s.Outputs ?? []).map((o: any) => `${o.OutputKey}=${o.OutputValue}`).join(" · "),
      })),
  },
  {
    id: "alarms",
    title: "CloudWatch alarms",
    group: "Operations",
    services: ["monitoring"],
    load: async (aws) =>
      ((await aws(["cloudwatch", "describe-alarms"])).MetricAlarms ?? []).map((a: any) => ({
        name: a.AlarmName,
        detail: `${a.Namespace}/${a.MetricName} ${a.ComparisonOperator} ${a.Threshold}`,
        status: a.StateValue,
      })),
  },
  {
    id: "logs",
    title: "CloudWatch log groups",
    group: "Operations",
    services: ["logs", "lambda"],
    load: async (aws) =>
      ((await aws(["logs", "describe-log-groups"])).logGroups ?? []).map((g: any) => ({
        name: g.logGroupName,
        detail: g.retentionInDays ? `retention ${g.retentionInDays}d` : "never expires",
      })),
  },
  {
    id: "route53",
    title: "Route 53 hosted zones",
    group: "Networking",
    services: ["route53"],
    load: async (aws) =>
      ((await aws(["route53", "list-hosted-zones"])).HostedZones ?? []).map((z: any) => ({
        name: z.Name,
        detail: `${z.Config?.PrivateZone ? "private" : "public"} · ${z.ResourceRecordSetCount} records`,
      })),
  },
];

function trustSummary(doc: any): string {
  try {
    const d = typeof doc === "string" ? JSON.parse(decodeURIComponent(doc)) : doc;
    const principals = (d.Statement ?? []).flatMap((s: any) => {
      const p = s.Principal ?? {};
      return [p.Service, p.AWS, p.Federated].flat().filter(Boolean);
    });
    return principals.length ? `trusts ${principals.map((p: string) => last(p)).join(", ")}` : "";
  } catch {
    return "";
  }
}

export class Inventory {
  private cache = new Map<string, InvSection>();
  private network: Vpc[] = [];

  private re: () => RunEnv;
  constructor(re: () => RunEnv) {
    this.re = re;
  }

  private aws = async (args: string[]) => {
    const r = await runAws(args, this.re(), 20_000);
    if (!r.ok) throw new Error(r.code || r.error.split("\n")[0]);
    return r.data ?? {};
  };

  snapshot() {
    return {
      sections: SECTIONS.map((s) => this.cache.get(s.id) ?? { id: s.id, title: s.title, group: s.group, items: [] }),
      network: this.network,
    };
  }

  clear() {
    this.cache.clear();
    this.network = [];
  }

  /** Refresh everything, or only the sections affected by these services. */
  async refresh(services?: string[]) {
    const defs = services ? SECTIONS.filter((s) => s.services.some((x) => services.includes(x))) : SECTIONS;
    const jobs: (() => Promise<void>)[] = defs.map((d) => async () => {
      try {
        const items = await d.load(this.aws);
        this.cache.set(d.id, { id: d.id, title: d.title, group: d.group, items });
      } catch (e: any) {
        this.cache.set(d.id, { id: d.id, title: d.title, group: d.group, items: [], error: String(e.message ?? e) });
      }
    });
    if (!services || services.includes("ec2") || services.includes("autoscaling")) {
      jobs.push(async () => {
        try {
          this.network = await this.loadNetwork();
        } catch {
          this.network = [];
        }
      });
    }
    await pool(jobs, 8);
  }

  private async loadNetwork(): Promise<Vpc[]> {
    const [vpcs, subnets, insts, igws, nats, rts, sgs] = await Promise.all([
      this.aws(["ec2", "describe-vpcs"]),
      this.aws(["ec2", "describe-subnets"]),
      this.aws(["ec2", "describe-instances"]),
      this.aws(["ec2", "describe-internet-gateways"]),
      this.aws(["ec2", "describe-nat-gateways"]),
      this.aws(["ec2", "describe-route-tables"]),
      this.aws(["ec2", "describe-security-groups"]),
    ]);
    const instances = (insts.Reservations ?? []).flatMap((r: any) => r.Instances);
    const routeTables: any[] = rts.RouteTables ?? [];
    const isPublic = (subnetId: string, vpcId: string) => {
      const explicit = routeTables.find((t) => t.Associations?.some((a: any) => a.SubnetId === subnetId));
      const main = routeTables.find((t) => t.VpcId === vpcId && t.Associations?.some((a: any) => a.Main));
      const rt = explicit ?? main;
      return !!rt?.Routes?.some((r: any) => r.DestinationCidrBlock === "0.0.0.0/0" && r.GatewayId?.startsWith("igw-"));
    };
    return (vpcs.Vpcs ?? []).map((v: any) => ({
      id: v.VpcId,
      cidr: v.CidrBlock,
      name: nameTag(v.Tags),
      isDefault: !!v.IsDefault,
      igw: (igws.InternetGateways ?? []).find((g: any) => g.Attachments?.some((a: any) => a.VpcId === v.VpcId))?.InternetGatewayId ?? null,
      nats: (nats.NatGateways ?? []).filter((n: any) => n.VpcId === v.VpcId && n.State !== "deleted").map((n: any) => n.NatGatewayId),
      subnets: (subnets.Subnets ?? [])
        .filter((s: any) => s.VpcId === v.VpcId)
        .sort((a: any, b: any) => a.AvailabilityZone.localeCompare(b.AvailabilityZone) || a.CidrBlock.localeCompare(b.CidrBlock))
        .map((s: any) => ({
          id: s.SubnetId,
          cidr: s.CidrBlock,
          az: s.AvailabilityZone,
          name: nameTag(s.Tags),
          public: isPublic(s.SubnetId, v.VpcId),
          instances: instances
            .filter((i: any) => i.SubnetId === s.SubnetId && i.State?.Name !== "terminated")
            .map((i: any) => ({ id: i.InstanceId, state: i.State?.Name, ip: i.PrivateIpAddress ?? "", name: nameTag(i.Tags) })),
        })),
      securityGroups: (sgs.SecurityGroups ?? [])
        .filter((g: any) => g.VpcId === v.VpcId)
        .map((g: any) => ({
          id: g.GroupId,
          name: g.GroupName,
          rules: (g.IpPermissions ?? []).map((p: any) => {
            const port = p.IpProtocol === "-1" ? "all" : p.FromPort === p.ToPort ? `${p.FromPort}` : `${p.FromPort}-${p.ToPort}`;
            const src = [...(p.IpRanges ?? []).map((r: any) => r.CidrIp), ...(p.UserIdGroupPairs ?? []).map((u: any) => u.GroupId)].join(", ");
            return `in ${p.IpProtocol === "-1" ? "" : p.IpProtocol + "/"}${port} ← ${src || "?"}`;
          }),
        })),
    }));
  }
}

async function pool(jobs: (() => Promise<void>)[], n: number) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, jobs.length) }, async () => {
      while (i < jobs.length) await jobs[i++]();
    }),
  );
}
