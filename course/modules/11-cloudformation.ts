import type { CheckContext, Module } from "../types.ts";

// ------------------------------------------------------------------ helpers

async function stack(ctx: CheckContext, name: string): Promise<any | null> {
  const r = await ctx.tryAws(["cloudformation", "describe-stacks", "--stack-name", name]);
  return r.ok ? (r.data?.Stacks?.[0] ?? null) : null;
}

const settled = (status: string) => /^(CREATE|UPDATE|IMPORT)_COMPLETE$/.test(status);

async function queueAttrs(ctx: CheckContext, name: string): Promise<Record<string, string> | null> {
  const u = await ctx.tryAws(["sqs", "get-queue-url", "--queue-name", name]);
  if (!u.ok) return null;
  const a = await ctx.tryAws(["sqs", "get-queue-attributes", "--queue-url", u.data.QueueUrl, "--attribute-names", "All"]);
  return a.ok ? (a.data?.Attributes ?? {}) : null;
}

async function exportsMap(ctx: CheckContext): Promise<Record<string, string>> {
  const r = await ctx.tryAws(["cloudformation", "list-exports"]);
  const out: Record<string, string> = {};
  for (const e of r.data?.Exports ?? []) out[e.Name] = e.Value;
  return out;
}

async function topicExists(ctx: CheckContext, name: string): Promise<boolean> {
  const r = await ctx.tryAws(["sns", "get-topic-attributes", "--topic-arn", `arn:aws:sns:${ctx.region}:${ctx.account}:${name}`]);
  return r.ok;
}

// ------------------------------------------------------------------ templates

// The lab-1 starter: deployable as-is, but missing the three things the tasks ask for.
const ordersStarter = String.raw`
AWSTemplateFormatVersion: "2010-09-09"
Description: Orders messaging and storage for one environment.

Parameters:
  Env:
    Type: String
    AllowedValues: [dev, test, prod]
    Description: Environment name. Used in every physical resource name.
  RetentionSeconds:
    Type: Number
    Default: 345600
    MinValue: 60
    MaxValue: 1209600
    Description: How long the main queue keeps unconsumed messages (seconds).

Mappings:
  EnvConfig:
    dev:  { MaxReceiveCount: 3, VisibilityTimeout: 30 }
    test: { MaxReceiveCount: 3, VisibilityTimeout: 30 }
    prod: { MaxReceiveCount: 5, VisibilityTimeout: 120 }

Conditions:
  IsProd: !Equals [!Ref Env, prod]

Resources:
  DeadLetterQueue:
    Type: AWS::SQS::Queue
    Properties:
      QueueName: !Sub "orders-\${Env}-dlq"
      MessageRetentionPeriod: 1209600   # 14 days, the maximum: time to investigate

  Queue:
    Type: AWS::SQS::Queue
    Properties:
      QueueName: !Sub "orders-\${Env}"
      MessageRetentionPeriod: !Ref RetentionSeconds
      VisibilityTimeout: !FindInMap [EnvConfig, !Ref Env, VisibilityTimeout]
      # TODO 1: add a RedrivePolicy that moves a message to DeadLetterQueue
      #         (deadLetterTargetArn: use !GetAtt) after MaxReceiveCount
      #         receives (maxReceiveCount: use !FindInMap on EnvConfig).

  Table:
    Type: AWS::DynamoDB::Table
    # TODO 2: this table holds customer orders. Make sure that neither deleting
    #         the stack nor a replacement can ever delete the data.
    Properties:
      TableName: !Sub "orders-\${Env}"
      BillingMode: PAY_PER_REQUEST
      AttributeDefinitions:
        - { AttributeName: orderId, AttributeType: S }
      KeySchema:
        - { AttributeName: orderId, KeyType: HASH }

  Topic:
    Type: AWS::SNS::Topic
    Properties:
      TopicName: !Join ["-", [orders, !Ref Env, events]]

Outputs:
  TableName:
    Value: !Ref Table
  # TODO 3: output QueueUrl (!Ref Queue), QueueArn (!GetAtt Queue.Arn) and
  #         TopicArn (!Ref Topic), each exported as <stack name>-<OutputKey>,
  #         for example orders-dev-QueueUrl. Use !Sub with \${AWS::StackName}.
`;

// The completed template (lab-1 solution, lab-2 starting point).
const ordersComplete = String.raw`
AWSTemplateFormatVersion: "2010-09-09"
Description: Orders messaging and storage for one environment.

Parameters:
  Env:
    Type: String
    AllowedValues: [dev, test, prod]
    Description: Environment name. Used in every physical resource name.
  RetentionSeconds:
    Type: Number
    Default: 345600
    MinValue: 60
    MaxValue: 1209600
    Description: How long the main queue keeps unconsumed messages (seconds).

Mappings:
  EnvConfig:
    dev:  { MaxReceiveCount: 3, VisibilityTimeout: 30 }
    test: { MaxReceiveCount: 3, VisibilityTimeout: 30 }
    prod: { MaxReceiveCount: 5, VisibilityTimeout: 120 }

Conditions:
  IsProd: !Equals [!Ref Env, prod]

Resources:
  DeadLetterQueue:
    Type: AWS::SQS::Queue
    Properties:
      QueueName: !Sub "orders-\${Env}-dlq"
      MessageRetentionPeriod: 1209600   # 14 days, the maximum: time to investigate

  Queue:
    Type: AWS::SQS::Queue
    Properties:
      QueueName: !Sub "orders-\${Env}"
      MessageRetentionPeriod: !Ref RetentionSeconds
      VisibilityTimeout: !FindInMap [EnvConfig, !Ref Env, VisibilityTimeout]
      RedrivePolicy:
        deadLetterTargetArn: !GetAtt DeadLetterQueue.Arn
        maxReceiveCount: !FindInMap [EnvConfig, !Ref Env, MaxReceiveCount]

  Table:
    Type: AWS::DynamoDB::Table
    DeletionPolicy: Retain
    UpdateReplacePolicy: Retain
    Properties:
      TableName: !Sub "orders-\${Env}"
      BillingMode: PAY_PER_REQUEST
      AttributeDefinitions:
        - { AttributeName: orderId, AttributeType: S }
      KeySchema:
        - { AttributeName: orderId, KeyType: HASH }

  Topic:
    Type: AWS::SNS::Topic
    Properties:
      TopicName: !Join ["-", [orders, !Ref Env, events]]

Outputs:
  TableName:
    Value: !Ref Table
  QueueUrl:
    Value: !Ref Queue
    Export:
      Name: !Sub "\${AWS::StackName}-QueueUrl"
  QueueArn:
    Value: !GetAtt Queue.Arn
    Export:
      Name: !Sub "\${AWS::StackName}-QueueArn"
  TopicArn:
    Value: !Ref Topic
    Export:
      Name: !Sub "\${AWS::StackName}-TopicArn"
`;

const consumerStarter = String.raw`
AWSTemplateFormatVersion: "2010-09-09"
Description: Consumes the orders-dev contract through its exports only.

Parameters:
  ProducerStack:
    Type: String
    Default: orders-dev
    Description: The stack whose exports this stack imports.

Resources:
  # Done for you: SNS may only deliver to the queue if the queue policy allows it.
  # Note the long form: !ImportValue cannot wrap the short form !Sub directly.
  QueuePolicy:
    Type: AWS::SQS::QueuePolicy
    Properties:
      Queues:
        - Fn::ImportValue: !Sub "\${ProducerStack}-QueueUrl"
      PolicyDocument:
        Version: "2012-10-17"
        Statement:
          - Effect: Allow
            Principal: { Service: sns.amazonaws.com }
            Action: sqs:SendMessage
            Resource:
              Fn::ImportValue: !Sub "\${ProducerStack}-QueueArn"
            Condition:
              ArnEquals:
                aws:SourceArn:
                  Fn::ImportValue: !Sub "\${ProducerStack}-TopicArn"

  # TODO 1: an AWS::SNS::Subscription that subscribes the imported queue
  #         (Protocol sqs, Endpoint = the imported QueueArn) to the imported
  #         TopicArn.

  # TODO 2: an AWS::SSM::Parameter named /orders/dev/queue-url (Type String)
  #         whose Value is the imported QueueUrl.
`;

const consumerComplete = String.raw`
AWSTemplateFormatVersion: "2010-09-09"
Description: Consumes the orders-dev contract through its exports only.

Parameters:
  ProducerStack:
    Type: String
    Default: orders-dev
    Description: The stack whose exports this stack imports.

Resources:
  QueuePolicy:
    Type: AWS::SQS::QueuePolicy
    Properties:
      Queues:
        - Fn::ImportValue: !Sub "\${ProducerStack}-QueueUrl"
      PolicyDocument:
        Version: "2012-10-17"
        Statement:
          - Effect: Allow
            Principal: { Service: sns.amazonaws.com }
            Action: sqs:SendMessage
            Resource:
              Fn::ImportValue: !Sub "\${ProducerStack}-QueueArn"
            Condition:
              ArnEquals:
                aws:SourceArn:
                  Fn::ImportValue: !Sub "\${ProducerStack}-TopicArn"

  Subscription:
    Type: AWS::SNS::Subscription
    Properties:
      Protocol: sqs
      TopicArn:
        Fn::ImportValue: !Sub "\${ProducerStack}-TopicArn"
      Endpoint:
        Fn::ImportValue: !Sub "\${ProducerStack}-QueueArn"

  QueueUrlParameter:
    Type: AWS::SSM::Parameter
    Properties:
      Name: /orders/dev/queue-url
      Type: String
      Value:
        Fn::ImportValue: !Sub "\${ProducerStack}-QueueUrl"
`;

// ------------------------------------------------------------------ module

export const cloudformation: Module = {
  id: "cloudformation",
  number: "11",
  title: "Infrastructure as Code: CloudFormation",
  summary:
    "Write parameterised CloudFormation templates, ship changes through reviewed change sets, protect stateful resources from replacement and deletion, and compose stacks with exports.",
  services: ["CloudFormation", "SQS", "SNS", "DynamoDB", "SSM"],
  lessons: [
    // ---------------------------------------------------------------- reading 1
    {
      id: "templates",
      kind: "reading",
      title: "Why IaC, and the anatomy of a template",
      minutes: 14,
      body: String.raw`
Every resource you have created so far with the CLI has one problem: the only record of it is the resource itself. Nobody can review it before it exists, nobody can rebuild it identically in another account, and nobody can tell whether what is running today is what was intended. **Infrastructure as Code** fixes that by making a text file the source of truth and a tool responsible for making reality match it.

## What IaC buys you

| Property | Without IaC | With IaC |
|---|---|---|
| **Reproducibility** | "Click what Dave clicked in 2023" | The same template builds dev, staging and prod |
| **Review** | Changes appear in prod, then in Slack | Changes are pull requests with a diff and a plan |
| **Drift** | Nobody knows what was changed by hand | Drift detection compares reality with the template |
| **Disaster recovery** | Weeks of archaeology | Redeploy the stacks into a new account or region |
| **Audit** | CloudTrail, if you know what to look for | \`git log\` tells you who changed what and why |

The cost is discipline: once a resource is managed by a tool, **changing it by hand is a bug**. The tool will either undo your change or, worse, keep a stale idea of the world and make a bad decision later.

## CloudFormation in one paragraph

You hand CloudFormation a **template** (YAML or JSON) and parameter values. It creates a **stack**: a named, versioned group of resources that it creates, updates and deletes as a unit. CloudFormation itself is the state store, so there is no state file for you to lose or lock. It runs server-side in your account, it is free (you pay for the resources), and it rolls back on failure.

## Template anatomy

\`\`\`yaml
AWSTemplateFormatVersion: "2010-09-09"
Description: Orders queue for one environment.

Parameters:              # inputs, validated before anything is created
  Env:
    Type: String
    AllowedValues: [dev, prod]

Mappings:                # static lookup tables keyed by a value
  EnvConfig:
    dev:  { MaxReceiveCount: 3 }
    prod: { MaxReceiveCount: 5 }

Conditions:              # booleans computed from parameters
  IsProd: !Equals [!Ref Env, prod]

Resources:               # the only required section
  DeadLetterQueue:
    Type: AWS::SQS::Queue
    Properties:
      QueueName: !Sub "orders-\${Env}-dlq"
  Queue:
    Type: AWS::SQS::Queue
    Properties:
      QueueName: !Sub "orders-\${Env}"
      VisibilityTimeout: !If [IsProd, 120, 30]
      RedrivePolicy:
        deadLetterTargetArn: !GetAtt DeadLetterQueue.Arn
        maxReceiveCount: !FindInMap [EnvConfig, !Ref Env, MaxReceiveCount]
  Alarm:
    Type: AWS::CloudWatch::Alarm
    Condition: IsProd      # only created when IsProd is true
    Properties: { ... }

Outputs:                 # values other people and stacks need
  QueueUrl:
    Value: !Ref Queue
    Export:
      Name: !Sub "\${AWS::StackName}-QueueUrl"
\`\`\`

- **Parameters** have types (\`String\`, \`Number\`, \`List<…>\`, \`AWS::EC2::VPC::Id\`, \`AWS::SSM::Parameter::Value<String>\`) and constraints (\`AllowedValues\`, \`MinValue\`, \`AllowedPattern\`). Validate aggressively: a typo caught at parameter validation costs nothing, a typo caught mid-deploy costs a rollback. Mark secrets \`NoEcho: true\`, but prefer dynamic references (\`{{resolve:secretsmanager:…}}\`) so the secret never passes through parameters at all.
- **Mappings** are for values that differ per environment or region but are not secret and change rarely. Keep the matrix small; a huge mapping is a sign you want separate parameter files.
- **Conditions** switch whole resources (\`Condition: IsProd\`) or individual properties (\`!If\`). Use \`AWS::NoValue\` to drop a property entirely: \`!If [IsProd, 7, !Ref AWS::NoValue]\`.
- **Resources** each have a **logical ID** (\`Queue\`, your name for it in the template) and get a **physical ID** (the real queue URL). The logical ID is the identity CloudFormation tracks. Rename it and CloudFormation sees "delete one, create another".
- **Outputs** expose values. **Exports** make an output importable by other stacks in the same account and region.

## Intrinsic functions

| Function | Returns | Example |
|---|---|---|
| \`!Ref X\` | A parameter's value, or the resource's *primary* identifier (queue URL, topic ARN, table name, bucket name) | \`!Ref Queue\` |
| \`!GetAtt X.Attr\` | A named attribute of a resource | \`!GetAtt Queue.Arn\` |
| \`!Sub "…\${X}…"\` | String interpolation with Refs, GetAtts (\`\${Queue.Arn}\`) and pseudo-parameters | \`!Sub "arn:aws:s3:::\${Bucket}/*"\` |
| \`!Join [sep, [a, b]]\` | Concatenation | \`!Join ["-", [orders, !Ref Env]]\` |
| \`!If [cond, a, b]\` | a or b | \`!If [IsProd, 120, 30]\` |
| \`!FindInMap [map, key1, key2]\` | A mapping value | \`!FindInMap [EnvConfig, !Ref Env, MaxReceiveCount]\` |
| \`!ImportValue name\` | Another stack's export | \`!ImportValue network-VpcId\` |
| \`!Select\`, \`!Split\`, \`!GetAZs\`, \`!Cidr\` | List helpers | \`!Select [0, !GetAZs ""]\` |

What \`!Ref\` returns differs per resource type, so check the resource's documentation page ("Return values"). \`!Ref\` on an SQS queue is its URL, not its ARN, and that mistake is a classic.

Pseudo-parameters are always available: \`AWS::StackName\`, \`AWS::Region\`, \`AWS::AccountId\`, \`AWS::Partition\`, \`AWS::URLSuffix\`, \`AWS::NoValue\`. Use \`AWS::Partition\` in ARNs (\`arn:\${AWS::Partition}:…\`) and your template also works in GovCloud and China.

## Dependency ordering

CloudFormation builds a dependency graph from your references. Because \`Queue\` uses \`!GetAtt DeadLetterQueue.Arn\`, the DLQ is created first and deleted last. Everything without a dependency is created **in parallel**. You only need \`DependsOn\` when a dependency exists that no reference expresses, for example:

- an EC2 instance that needs the internet gateway *attachment* to exist before user data can download packages;
- an API Gateway deployment that must come after all of its methods;
- a Lambda function whose role policy must exist before an event source mapping is created (otherwise the mapping fails its permission check).

Don't sprinkle \`DependsOn\` everywhere "to be safe": it serialises the deploy and hides the real graph. Circular references are rejected at validation time ("Circular dependency between resources"). The usual fix is to split a resource, for example create the security group rule as a separate \`AWS::EC2::SecurityGroupIngress\` instead of inline.

## Try it

\`\`\`bash
cat > demo-queue.yaml <<'EOF'
Parameters:
  Env: { Type: String, AllowedValues: [dev, prod], Default: dev }
Conditions:
  IsProd: !Equals [!Ref Env, prod]
Resources:
  Queue:
    Type: AWS::SQS::Queue
    Properties:
      QueueName: !Sub "demo-cfn-\${Env}"
      VisibilityTimeout: !If [IsProd, 120, 30]
Outputs:
  QueueArn:
    Value: !GetAtt Queue.Arn
EOF
aws cloudformation validate-template --template-body file://demo-queue.yaml
aws cloudformation deploy --stack-name demo-cfn --template-file demo-queue.yaml
aws cloudformation describe-stacks --stack-name demo-cfn --query 'Stacks[0].{status: StackStatus, outputs: Outputs}'
\`\`\`

Open the **API** tab: \`deploy\` is not one call. It is \`CreateChangeSet\`, a waiter, \`ExecuteChangeSet\` and another waiter. That is the subject of the next reading.

> **Senior habit:** never hard-code physical names you don't need. A resource with a custom name (\`QueueName\`, \`TableName\`, \`BucketName\`) can't be replaced without a name clash, can't be deployed twice in one account, and collides across stacks. Name things that humans or other systems must find by name (and parameterise the name). Let CloudFormation generate the rest.
`,
    },
    // ---------------------------------------------------------------- reading 2
    {
      id: "lifecycle",
      kind: "reading",
      title: "Stack lifecycle, change sets and replacement",
      minutes: 16,
      body: String.raw`
A stack is a state machine. Knowing its states is the difference between "the deploy is stuck" and "I know exactly which call to make".

## Stack states

<figure class="diagram">
<svg viewBox="0 0 640 300" role="img" aria-label="CloudFormation stack state machine: create, update, rollback and the failed states">
  <rect x="10" y="20" width="150" height="40" rx="6" class="d-box"/><text x="85" y="45" text-anchor="middle" class="d-label">CREATE_IN_PROGRESS</text>
  <rect x="245" y="20" width="150" height="40" rx="6" class="d-box d-ok"/><text x="320" y="45" text-anchor="middle" class="d-label">CREATE_COMPLETE</text>
  <rect x="10" y="110" width="150" height="40" rx="6" class="d-box d-dim"/><text x="85" y="135" text-anchor="middle" class="d-label">ROLLBACK_IN_PROGRESS</text>
  <rect x="10" y="200" width="150" height="40" rx="6" class="d-box d-danger"/><text x="85" y="225" text-anchor="middle" class="d-label">ROLLBACK_COMPLETE</text>
  <text x="85" y="258" text-anchor="middle" class="d-small">dead end: delete and recreate</text>
  <rect x="245" y="110" width="150" height="40" rx="6" class="d-box"/><text x="320" y="135" text-anchor="middle" class="d-label">UPDATE_IN_PROGRESS</text>
  <rect x="480" y="110" width="150" height="40" rx="6" class="d-box d-ok"/><text x="555" y="135" text-anchor="middle" class="d-label">UPDATE_COMPLETE</text>
  <rect x="245" y="200" width="150" height="40" rx="6" class="d-box d-dim"/><text x="320" y="225" text-anchor="middle" class="d-label">UPDATE_ROLLBACK_…</text>
  <rect x="480" y="200" width="150" height="40" rx="6" class="d-box d-ok"/><text x="555" y="217" text-anchor="middle" class="d-label">UPDATE_ROLLBACK</text><text x="555" y="232" text-anchor="middle" class="d-small">_COMPLETE (usable)</text>
  <rect x="245" y="262" width="150" height="34" rx="6" class="d-box d-danger"/><text x="320" y="284" text-anchor="middle" class="d-label">UPDATE_ROLLBACK_FAILED</text>
  <path d="M160 40 H243" class="d-arrow"/><text x="202" y="32" text-anchor="middle" class="d-small">ok</text>
  <path d="M85 60 V108" class="d-arrow"/><text x="92" y="88" class="d-small">a resource fails</text>
  <path d="M85 150 V198" class="d-arrow"/>
  <path d="M320 60 V108" class="d-arrow"/><text x="327" y="88" class="d-small">update</text>
  <path d="M395 130 H478" class="d-arrow"/><text x="437" y="122" text-anchor="middle" class="d-small">ok</text>
  <path d="M320 150 V198" class="d-arrow"/><text x="327" y="178" class="d-small">fails</text>
  <path d="M395 220 H478" class="d-arrow"/>
  <path d="M320 240 V260" class="d-arrow d-dashed"/><text x="327" y="254" class="d-small">rollback itself fails</text>
  <path d="M555 110 V88 H385 V108" class="d-arrow d-dashed"/><text x="480" y="82" text-anchor="middle" class="d-small">next update</text>
</svg>
<figcaption>Every successful operation ends in a <code>*_COMPLETE</code> state. <code>ROLLBACK_COMPLETE</code> (a failed <em>create</em>) and <code>UPDATE_ROLLBACK_FAILED</code> are the two states that need a human.</figcaption>
</figure>

- **Create fails** → CloudFormation deletes what it created → \`ROLLBACK_COMPLETE\`. The stack can't be updated from here. Read the events, **delete the stack**, fix the template, create again. (\`--disable-rollback\` or \`--on-failure DO_NOTHING\` keeps the half-built resources for debugging; delete them afterwards.)
- **Update fails** → CloudFormation reverts every resource to its previous configuration → \`UPDATE_ROLLBACK_COMPLETE\`. The stack is healthy on the old version, and you can deploy again.
- **Rollback fails** → \`UPDATE_ROLLBACK_FAILED\`. Typical causes: someone deleted a resource by hand, so it can't be restored; a dependency outside the stack changed; a permission the old version needed was removed. Fix the underlying cause, then \`aws cloudformation continue-update-rollback --stack-name X\`, optionally with \`--resources-to-skip LogicalId\` for resources you have repaired or accept as lost. Skipping marks them as rolled back without touching them, so CloudFormation's record and reality now disagree until your next update.
- \`*_IN_PROGRESS\` states can last up to the timeout of the slowest resource. A stuck custom resource waits an hour by default. You can \`cancel-update-stack\` an in-progress update (it then rolls back).

The **events** are your log. Read them bottom-up and find the *first* \`*_FAILED\`. Every later failure is usually just "cancelled because something else failed":

\`\`\`bash
cat > demo-broken.yaml <<'EOF'
Resources:
  Queue:
    Type: AWS::SQS::Queue
    Properties: { QueueName: demo-rollback-q }
  Table:
    Type: AWS::DynamoDB::Table
    DependsOn: Queue
    Properties:
      TableName: ab
      BillingMode: PAY_PER_REQUEST
      AttributeDefinitions: [{ AttributeName: pk, AttributeType: S }]
      KeySchema: [{ AttributeName: pk, KeyType: HASH }]
EOF
aws cloudformation deploy --stack-name demo-rollback --template-file demo-broken.yaml
aws cloudformation describe-stack-events --stack-name demo-rollback \
  --query 'StackEvents[].[LogicalResourceId,ResourceStatus,ResourceStatusReason]' --output text
aws sqs list-queues
aws cloudformation delete-stack --stack-name demo-rollback
\`\`\`

The queue was created, then the table failed validation (a name of 2 characters), and the rollback deleted the queue again. Nothing half-built is left behind.

## Change sets: the plan step

An update can create, modify, **replace** or delete resources, and some of those actions destroy data. Never run an update you haven't previewed. A **change set** is CloudFormation's plan: it computes what an update would do, without doing it.

<figure class="diagram">
<svg viewBox="0 0 640 210" role="img" aria-label="Change set deploy flow: template to create-change-set, review, execute, and either complete or roll back">
  <rect x="10" y="30" width="110" height="50" rx="6" class="d-box"/><text x="65" y="52" text-anchor="middle" class="d-label">Template</text><text x="65" y="68" text-anchor="middle" class="d-small">+ parameters</text>
  <rect x="150" y="30" width="130" height="50" rx="6" class="d-box d-accent"/><text x="215" y="52" text-anchor="middle" class="d-label">CreateChangeSet</text><text x="215" y="68" text-anchor="middle" class="d-small">diff vs live stack</text>
  <rect x="310" y="30" width="130" height="50" rx="6" class="d-box d-accent"/><text x="375" y="52" text-anchor="middle" class="d-label">Review</text><text x="375" y="68" text-anchor="middle" class="d-small">Add/Modify/Remove</text>
  <rect x="470" y="30" width="160" height="50" rx="6" class="d-box"/><text x="550" y="52" text-anchor="middle" class="d-label">ExecuteChangeSet</text><text x="550" y="68" text-anchor="middle" class="d-small">only this one</text>
  <path d="M120 55 H148" class="d-arrow"/><path d="M280 55 H308" class="d-arrow"/><path d="M440 55 H468" class="d-arrow"/>
  <path d="M375 80 V120 H215 V82" class="d-arrow d-dashed"/><text x="295" y="114" text-anchor="middle" class="d-small">Replace on a database? fix, recreate</text>
  <rect x="380" y="140" width="120" height="44" rx="6" class="d-box d-ok"/><text x="440" y="167" text-anchor="middle" class="d-label">UPDATE_COMPLETE</text>
  <rect x="510" y="140" width="120" height="44" rx="6" class="d-box d-danger"/><text x="570" y="160" text-anchor="middle" class="d-label">rollback</text><text x="570" y="175" text-anchor="middle" class="d-small">to previous version</text>
  <path d="M530 80 V100 H440 V138" class="d-arrow"/><path d="M570 80 V138" class="d-arrow"/>
  <text x="20" y="160" class="d-small">In CI: the PR job creates the change set and</text>
  <text x="20" y="176" class="d-small">posts its Changes; the merge job executes that</text>
  <text x="20" y="192" class="d-small">exact change set after approval.</text>
</svg>
<figcaption><code>aws cloudformation deploy</code> runs all four steps in one go. In a pipeline, split them so a human (or a policy check) sees the plan before it is executed.</figcaption>
</figure>

\`\`\`bash
aws cloudformation create-change-set --stack-name demo-cfn --change-set-name to-prod \
  --template-body file://demo-queue.yaml --parameters ParameterKey=Env,ParameterValue=prod
aws cloudformation wait change-set-create-complete --stack-name demo-cfn --change-set-name to-prod
aws cloudformation describe-change-set --stack-name demo-cfn --change-set-name to-prod \
  --query 'Changes[].ResourceChange.{id: LogicalResourceId, action: Action, replace: Replacement, props: Details[].Target.Name}'
aws cloudformation delete-change-set --stack-name demo-cfn --change-set-name to-prod
\`\`\`

Each change has:

- **Action**: \`Add\`, \`Modify\`, \`Remove\` (also \`Import\`, \`Dynamic\`).
- **Replacement**: \`False\` (updated in place), \`True\` (a **new physical resource** is created and the old one deleted), or \`Conditional\` (depends on a value only known at deploy time, so treat it as \`True\`).
- **Details**: which property caused it, and its \`RequiresRecreation\` (\`Never\`, \`Conditionally\`, \`Always\`).

Here, changing \`Env\` changes \`QueueName\`, and a queue can't be renamed, so the queue is **replaced**. A change set that fails with "The submitted information didn't contain changes" is not an error in practice: there is nothing to do. \`deploy --no-fail-on-empty-changeset\` treats that as success.

## Replacement vs in-place updates

Every property in the resource reference has an **Update requires** line: *No interruption*, *Some interruptions* or *Replacement*. Learn the dangerous ones for the resources you own:

| Resource | Replaces on change of… | In place |
|---|---|---|
| \`AWS::SQS::Queue\` | \`QueueName\`, \`FifoQueue\` | timeouts, retention, redrive, policy |
| \`AWS::SNS::Topic\` | \`TopicName\`, \`FifoTopic\` | display name, subscriptions, policy |
| \`AWS::DynamoDB::Table\` | \`TableName\`, \`KeySchema\`, attribute types of key attributes | billing mode, GSIs, TTL, PITR, tags |
| \`AWS::RDS::DBInstance\` | \`DBInstanceIdentifier\`, \`Engine\`, \`KmsKeyId\`, \`DBSubnetGroupName\`, AZ… | instance class (with downtime), storage size |
| \`AWS::S3::Bucket\` | \`BucketName\` | everything else |
| \`AWS::EC2::Instance\` | \`ImageId\`, \`SubnetId\`, \`KeyName\`, \`AvailabilityZone\` | \`InstanceType\` (stop/start), tags |
| any resource | its **logical ID** | |

Replacement creates the new resource first, repoints dependents, and deletes the old one in the cleanup phase. For a queue that means in-flight messages are lost. For a **table, bucket or database it means the data is deleted**. Two traps make it worse:

1. **Custom names block replacement.** CloudFormation can't create the new \`orders-prod\` table while the old one exists, so the update fails with "CloudFormation cannot update a stack when a custom-named resource requires replacing". That failure is a guard rail, not a bug: rename the resource if you really mean to replace it.
2. **Renaming a logical ID** while "just tidying the template" is a delete-and-create. Use resource import or, in CDK, override the logical ID to keep it stable.

> **Senior habit:** in CI, fail the pipeline when a change set contains \`Replacement: True\` or \`Remove\` for any stateful type (\`AWS::DynamoDB::Table\`, \`AWS::RDS::*\`, \`AWS::S3::Bucket\`, \`AWS::EFS::FileSystem\`, \`AWS::Logs::LogGroup\`) unless the PR carries an explicit override label. It takes ten lines of \`jq\` and prevents the worst day of your year.

> **On the emulator:** change sets, replacement detection, rollback, and events behave like AWS for SQS, SNS, SSM and most of what this course uses. One gap: updating the properties of an existing \`AWS::DynamoDB::Table\` in place isn't implemented. The update fails with a \`NotImplemented\` reason and the stack rolls back cleanly. The emulator also reports a \`KeySchema\` change as \`Replacement: False\`, which on AWS is \`True\`. The labs avoid table updates.
`,
    },
    // ---------------------------------------------------------------- reading 3
    {
      id: "protection",
      kind: "reading",
      title: "Protecting stateful resources and detecting drift",
      minutes: 14,
      body: String.raw`
A stack can delete everything it created with one API call. That is a feature for ephemeral environments and a hazard for production. CloudFormation gives you four independent layers of protection. Use all of them for anything that holds data.

## DeletionPolicy and UpdateReplacePolicy

These are resource *attributes* (siblings of \`Type\` and \`Properties\`, not properties):

\`\`\`yaml
Table:
  Type: AWS::DynamoDB::Table
  DeletionPolicy: Retain          # when the resource leaves the stack
  UpdateReplacePolicy: Retain     # when an update replaces it
  Properties: { ... }
\`\`\`

| Value | On delete or replace | Supported by |
|---|---|---|
| \`Delete\` (default) | The resource is deleted | everything |
| \`Retain\` | The resource is left in place, unmanaged | everything |
| \`Snapshot\` | A final snapshot is taken, then it's deleted | RDS instances and clusters, EBS volumes, ElastiCache, Redshift, Neptune, DocumentDB |
| \`RetainExceptOnCreate\` | Retained, except when the *create* itself failed and rolls back | everything |

**DeletionPolicy** applies when the resource is removed from the template or the whole stack is deleted. **UpdateReplacePolicy** applies to the *old* physical resource when an update replaces it. Without it, a replacement deletes the old table even if \`DeletionPolicy: Retain\` is set. Always set both together on stateful resources. \`RetainExceptOnCreate\` is a good default: a failed first deploy doesn't leave orphans around, but a live table is never deleted.

What "Retain" means in practice: the resource survives, **CloudFormation forgets it**, and you now own an unmanaged resource. To bring it back under management, use a change set of type \`IMPORT\` (\`--change-set-type IMPORT --resources-to-import …\`). Retained resources still cost money and still hold names, so a later stack that tries to create \`orders-prod\` again fails with "already exists".

> **On real AWS:** for S3 buckets, \`Delete\` fails anyway if the bucket isn't empty, and the stack ends in \`DELETE_FAILED\`. That's a guard rail too, but don't rely on it.

## Stack policies

A **stack policy** is a JSON document attached to a stack that says which *update actions* are allowed on which resources. Once you set one, everything not explicitly allowed is denied:

\`\`\`json
{
  "Statement": [
    { "Effect": "Allow", "Action": "Update:*", "Principal": "*", "Resource": "*" },
    { "Effect": "Deny",
      "Action": ["Update:Replace", "Update:Delete"],
      "Principal": "*",
      "Resource": "LogicalResourceId/Table" }
  ]
}
\`\`\`

Actions are \`Update:Modify\`, \`Update:Replace\`, \`Update:Delete\` and \`Update:*\`. An update that would violate it fails before touching the resource ("Action denied by stack policy") and rolls back. Stack policies **only govern stack updates**: they don't stop \`delete-stack\`, and they don't stop someone calling \`DeleteTable\` directly. Override for one deliberate update with \`--stack-policy-during-update-body\`.

## Termination protection

\`\`\`bash
aws cloudformation update-termination-protection --stack-name demo-cfn --enable-termination-protection
aws cloudformation delete-stack --stack-name demo-cfn
\`\`\`

The delete is refused with a \`ValidationError\`. Turn it on for every production stack (and every stack other stacks import from). It's a cheap seatbelt against the "wrong terminal tab" incident. Disabling it requires its own API call, which you can deny in IAM or in an SCP for production accounts.

## The four layers together

| Threat | DeletionPolicy | UpdateReplacePolicy | Stack policy | Termination protection | IAM / SCP |
|---|---|---|---|---|---|
| Someone deletes the stack | ✅ data survives | | | ✅ refused | ✅ |
| A template change replaces the table | | ✅ old table kept | ✅ refused | | |
| A resource is removed from the template | ✅ | | ✅ refused | | |
| Someone calls \`DeleteTable\` directly | | | | | ✅ only this |

Add the service's own protection on top: \`DeletionProtectionEnabled\` on DynamoDB tables and RDS, versioning and Object Lock on S3 buckets, and backups (AWS Backup, PITR) that live outside the stack.

## Drift detection

**Drift** is when a resource no longer matches its template because something changed it outside CloudFormation: a console click during an incident, a script, another tool. CloudFormation doesn't notice on its own, and a later update only touches the properties that changed *in the template*. So drift silently survives deploys until it bites.

\`\`\`bash
QURL=$(aws sqs get-queue-url --queue-name demo-cfn-dev --query QueueUrl --output text)
aws sqs set-queue-attributes --queue-url "$QURL" --attributes VisibilityTimeout=300
DID=$(aws cloudformation detect-stack-drift --stack-name demo-cfn --query StackDriftDetectionId --output text)
aws cloudformation describe-stack-drift-detection-status --stack-drift-detection-id "$DID" \
  --query '{status: DetectionStatus, drift: StackDriftStatus}'
aws cloudformation describe-stack-resource-drifts --stack-name demo-cfn \
  --query 'StackResourceDrifts[].{id: LogicalResourceId, status: StackResourceDriftStatus, diff: PropertyDifferences}'
\`\`\`

Detection is asynchronous: poll the status until \`DETECTION_COMPLETE\`. Resources come back \`IN_SYNC\`, \`MODIFIED\` (with exact property differences), \`DELETED\` or \`NOT_CHECKED\` (not every type supports drift detection). Detection only checks properties **you set in the template**. A property you never specified isn't compared.

What to do about drift:

1. **Decide which side is right.** If the manual change was a correct incident fix, put it in the template and deploy. If it was wrong, revert it.
2. To revert, set the value by hand back to the template's value, or change the property in the template (even temporarily) so CloudFormation issues an update. Redeploying an unchanged template does nothing ("No changes").
3. **Prevent it:** run drift detection on a schedule (an EventBridge rule plus a Lambda, or the AWS Config rule \`cloudformation-stack-drift-detection-check\`), alert on \`DRIFTED\`, and give humans read-only console access in production so that "break-glass" changes are rare and audited.
`,
    },
    // ---------------------------------------------------------------- reading 4
    {
      id: "composition",
      kind: "reading",
      title: "Composing stacks, generators and CI",
      minutes: 14,
      body: String.raw`
One giant stack is easy to start and painful to live with: every change risks everything, deploys get slow, and you hit the 500-resource limit. Real estates split by **lifecycle and ownership**: a network stack that changes twice a year, data stacks that must never be replaced, application stacks that deploy ten times a day. Then they need to share values.

## Cross-stack references: Export / ImportValue

<figure class="diagram">
<svg viewBox="0 0 640 190" role="img" aria-label="A producer stack exports values; consumer stacks import them, which locks the export">
  <rect x="10" y="30" width="220" height="130" rx="8" class="d-box d-outer"/>
  <text x="26" y="52" class="d-label">Stack orders-dev (producer)</text>
  <rect x="30" y="66" width="180" height="30" rx="5" class="d-box"/><text x="120" y="86" text-anchor="middle" class="d-small">Queue, Topic, Table</text>
  <rect x="30" y="108" width="180" height="40" rx="5" class="d-box d-accent"/><text x="120" y="124" text-anchor="middle" class="d-small">Export orders-dev-QueueUrl</text><text x="120" y="140" text-anchor="middle" class="d-small">Export orders-dev-TopicArn</text>
  <rect x="410" y="30" width="220" height="60" rx="8" class="d-box"/>
  <text x="426" y="54" class="d-label">Stack orders-consumer</text><text x="426" y="74" class="d-small">!ImportValue orders-dev-QueueUrl</text>
  <rect x="410" y="110" width="220" height="60" rx="8" class="d-box d-dim"/>
  <text x="426" y="134" class="d-label">Stack billing-worker</text><text x="426" y="154" class="d-small">!ImportValue orders-dev-TopicArn</text>
  <path d="M210 120 H300 V60 H408" class="d-arrow"/><path d="M300 125 V140 H408" class="d-arrow"/>
  <text x="310" y="100" class="d-small">resolved at deploy</text>
  <text x="250" y="184" class="d-small">While imported, the export can't change or be deleted.</text>
</svg>
<figcaption>Exports are a hard contract: CloudFormation refuses to change or delete an export that any stack imports.</figcaption>
</figure>

An export name is unique per account and region. Importing creates a **strong, enforced dependency**: while \`orders-consumer\` imports \`orders-dev-TopicArn\`, any update that would change the topic's ARN (for example a replacement) fails with "Cannot update export … as it is in use", and deleting the producer fails too. \`aws cloudformation list-imports --export-name X\` tells you who depends on you.

That strength is both the point and the pain. To change an exported value you must first remove the import from every consumer, then change the producer, then re-add the imports. Good practice:

- Export **stable identifiers** only (VPC ID, subnet IDs, a KMS key ARN), never values that change with routine updates.
- Prefix export names with the stack name (\`!Sub "\${AWS::StackName}-VpcId"\`) so they can't collide.
- Note the YAML gotcha: \`!ImportValue !Sub "…"\` is invalid. Write \`Fn::ImportValue: !Sub "\${Producer}-QueueUrl"\`.

## The alternative: SSM parameters

The producer writes \`/orders/dev/queue-url\` as an \`AWS::SSM::Parameter\`. Consumers read it with a parameter of type \`AWS::SSM::Parameter::Value<String>\` (resolved at each deploy) or a dynamic reference \`{{resolve:ssm:/orders/dev/queue-url}}\`.

| | Export / ImportValue | SSM parameter |
|---|---|---|
| Coupling | Enforced: producer can't break consumers | Loose: producer can change it, consumers pick it up on next deploy |
| Cross-region / cross-account | No (same account and region only) | Cross-region by reading the other region's parameter; cross-account with shared parameters (advanced tier) |
| Readable by non-CFN tools | Via \`list-exports\` only | Terraform, apps, scripts all read SSM |
| Changing the value | Painful (unwire every consumer first) | Easy, but consumers may run stale until redeployed |
| Discoverability | \`list-imports\` shows dependents | No built-in dependency tracking |

Use exports for a few foundational, never-changing values within one account. Use SSM parameters for anything that crosses tools, regions or teams, or that may change.

## Nested stacks

\`AWS::CloudFormation::Stack\` deploys another template (from S3) as a **child stack**, passing parameters in and reading \`!GetAtt Child.Outputs.X\` back. The parent and its children deploy and roll back as one unit. Nested stacks are for **reusing components** (a standard "queue with DLQ and alarms" module) inside one deployable. Cross-stack exports are for **separately deployed** layers. \`aws cloudformation package\` uploads local child templates and rewrites the \`TemplateURL\`s for you. Change sets can include nested stacks (\`--include-nested-stacks\`), so review those too.

## StackSets

A **StackSet** deploys one template to many accounts and regions: GuardDuty in every region, a baseline IAM role in every account, CloudTrail organisation-wide. With the \`SERVICE_MANAGED\` permission model it integrates with AWS Organizations and **auto-deploys to new accounts** as they join an OU. Tune \`MaxConcurrentPercentage\` and \`FailureTolerancePercentage\` so a bad template stops after the first few accounts instead of breaking all of them.

> **On the emulator:** there is one account and one region, so you can create a StackSet but not see a real fan-out. Practise StackSets in a sandbox organisation.

## CDK and SAM: generators of CloudFormation

- **AWS SAM** is a template *transform* (\`Transform: AWS::Serverless-2016-10-31\`): \`AWS::Serverless::Function\` expands into a function, role, permissions and event sources. The \`sam\` CLI builds, packages and deploys it.
- **AWS CDK** lets you write TypeScript or Python that **synthesises** CloudFormation (\`cdk synth\` → \`cdk.out/*.template.json\`). Constructs encode best practice (an \`s3.Bucket\` with encryption, a queue with a DLQ), and loops and types replace copy-paste.

Both end up as **stacks and change sets**, so everything in this module still applies: replacement rules, DeletionPolicy (\`removalPolicy: RemovalPolicy.RETAIN\` in CDK), drift and stack states. Senior habits for CDK: commit and review the \`cdk diff\` output, pin logical IDs of stateful resources, and never let a refactor that moves a construct silently rename its logical ID.

## Linting and policy in CI

| Tool | What it catches | When |
|---|---|---|
| \`aws cloudformation validate-template\` | Syntax and structure only | Cheap smoke test |
| **cfn-lint** | Invalid properties and values against the resource specs, bad \`!GetAtt\`s, unused parameters, deprecated runtimes | Every commit / pre-commit hook |
| **cfn-guard** | *Your* rules: "every table has \`DeletionPolicy: Retain\`", "no bucket without encryption", "no \`0.0.0.0/0\` ingress" | Every PR, as a blocking check |
| Checkov / cfn-nag | Large libraries of built-in security rules | Every PR |
| Change set review | What will actually change in *this* account | Before every execute |

A cfn-guard rule reads like this:

\`\`\`text
let tables = Resources.*[ Type == 'AWS::DynamoDB::Table' ]
rule tables_are_retained when %tables !empty {
  %tables.DeletionPolicy == 'Retain'
  %tables.UpdateReplacePolicy == 'Retain'
}
\`\`\`

A mature CloudFormation pipeline: lint and guard on every push → create a change set against the target stack in the PR → post the change set summary and block on stateful \`Replace\`/\`Remove\` → a human approves → execute *that* change set → wait for the stack, alarm on \`UPDATE_ROLLBACK_*\` → run scheduled drift detection afterwards. Deploys use a dedicated, least-privilege deployment role (\`--role-arn\`), so nobody needs admin rights to ship.
`,
    },
    // ---------------------------------------------------------------- lab 1
    {
      id: "deploy-stack",
      kind: "lab",
      title: "Lab: Deploy a parameterised stack",
      minutes: 30,
      body: String.raw`
You own the orders messaging layer: a queue with a dead-letter queue, a DynamoDB table and an SNS topic, deployed per environment from one template. The starter template in this lab folder, \`orders.yaml\`, deploys as-is but has three \`TODO\`s, each a classic production gap:

1. The queue has no **dead-letter queue** wired in, so poison messages retry until retention expires.
2. The table has the default **DeletionPolicy** (\`Delete\`): deleting the stack deletes every order.
3. Nothing is **exported**, so other stacks would have to hard-code ARNs.

Useful commands:

\`\`\`bash
aws cloudformation validate-template --template-body file://orders.yaml
aws cloudformation deploy --stack-name orders-dev --template-file orders.yaml --parameter-overrides Env=dev
aws cloudformation describe-stack-events --stack-name orders-dev \
  --query 'StackEvents[?contains(ResourceStatus, \`FAILED\`)].[LogicalResourceId,ResourceStatusReason]' --output text
aws cloudformation list-exports
\`\`\`

\`deploy\` is idempotent: run it again after each edit and it creates a change set for just the difference. Press **Prepare lab**, then work through the tasks.
`,
      lab: {
        files: { "orders.yaml": ordersStarter },
        tasks: [
          {
            id: "deploy",
            title: "Deploy orders-dev",
            description:
              "Deploy `orders.yaml` as a stack named **`orders-dev`** with the parameter **`Env=dev`**. The stack must reach a `*_COMPLETE` state.",
            hints: [
              "`aws cloudformation deploy --stack-name … --template-file … --parameter-overrides Env=dev`",
              "If the create failed, the stack is in `ROLLBACK_COMPLETE`. Read the events, delete the stack with `aws cloudformation delete-stack --stack-name orders-dev`, fix the template and deploy again.",
            ],
            check: async (ctx) => {
              const s = await stack(ctx, "orders-dev");
              if (!s) return "Stack `orders-dev` doesn't exist yet.";
              if (!settled(s.StackStatus))
                return `Stack status is ${s.StackStatus}${s.StackStatusReason ? ` (${s.StackStatusReason})` : ""}. It should be CREATE_COMPLETE or UPDATE_COMPLETE.`;
              const env = (s.Parameters ?? []).find((p: any) => p.ParameterKey === "Env")?.ParameterValue;
              if (env !== "dev") return `Parameter Env is \`${env}\`; expected \`dev\`.`;
              return true;
            },
          },
          {
            id: "dlq",
            title: "Wire the dead-letter queue",
            description:
              "Complete **TODO 1**: the queue `orders-dev` must have a redrive policy whose target is the stack's `orders-dev-dlq` queue (use `!GetAtt`), with `maxReceiveCount` taken from the `EnvConfig` mapping (3 for dev). Deploy the change.",
            hints: [
              "`RedrivePolicy` is a property of the queue with two keys: `deadLetterTargetArn` and `maxReceiveCount`.",
              "```yaml\n      RedrivePolicy:\n        deadLetterTargetArn: !GetAtt DeadLetterQueue.Arn\n        maxReceiveCount: !FindInMap [EnvConfig, !Ref Env, MaxReceiveCount]\n```",
            ],
            check: async (ctx) => {
              const a = await queueAttrs(ctx, "orders-dev");
              if (!a) return "Queue `orders-dev` doesn't exist yet. Deploy the stack first.";
              if (!a.RedrivePolicy) return "Queue `orders-dev` has no RedrivePolicy yet. Complete TODO 1 and deploy again.";
              const rp = JSON.parse(a.RedrivePolicy);
              const want = `arn:aws:sqs:${ctx.region}:${ctx.account}:orders-dev-dlq`;
              if (rp.deadLetterTargetArn !== want) return `The redrive target is ${rp.deadLetterTargetArn}; expected ${want}.`;
              if (Number(rp.maxReceiveCount) !== 3) return `maxReceiveCount is ${rp.maxReceiveCount}; the dev value in EnvConfig is 3.`;
              return true;
            },
          },
          {
            id: "exports",
            title: "Export the contract",
            description:
              "Complete **TODO 3**: add outputs `QueueUrl`, `QueueArn` and `TopicArn`, exported as **`orders-dev-QueueUrl`**, **`orders-dev-QueueArn`** and **`orders-dev-TopicArn`** (build the names from `AWS::StackName`, don't hard-code `orders-dev`). Deploy.",
            hints: [
              "An output has a `Value` and an optional `Export: { Name: … }`.",
              "```yaml\n  QueueUrl:\n    Value: !Ref Queue\n    Export:\n      Name: !Sub \"${AWS::StackName}-QueueUrl\"\n```\n`!Ref` on a queue is its URL; use `!GetAtt Queue.Arn` for the ARN. `!Ref` on a topic is its ARN.",
            ],
            check: async (ctx) => {
              const ex = await exportsMap(ctx);
              const want: Record<string, string> = {
                "orders-dev-QueueUrl": `/${ctx.account}/orders-dev`,
                "orders-dev-QueueArn": `arn:aws:sqs:${ctx.region}:${ctx.account}:orders-dev`,
                "orders-dev-TopicArn": `arn:aws:sns:${ctx.region}:${ctx.account}:orders-dev-events`,
              };
              for (const [name, v] of Object.entries(want)) {
                if (!(name in ex)) return `Export \`${name}\` doesn't exist yet. Exports so far: ${Object.keys(ex).join(", ") || "none"}.`;
                const ok = name.endsWith("QueueUrl") ? ex[name].endsWith(v) : ex[name] === v;
                if (!ok) return `Export \`${name}\` is \`${ex[name]}\`, which isn't right. Expected ${name.endsWith("QueueUrl") ? "the queue URL" : v}.`;
              }
              return true;
            },
          },
          {
            id: "protect",
            title: "Turn on termination protection",
            description: "Enable **termination protection** on `orders-dev`, so a `delete-stack` against it is refused.",
            hints: ["`aws cloudformation update-termination-protection --stack-name orders-dev --enable-termination-protection`"],
            check: async (ctx) => {
              const s = await stack(ctx, "orders-dev");
              if (!s) return "Stack `orders-dev` doesn't exist yet.";
              if (s.EnableTerminationProtection !== true) return "Termination protection is still off on `orders-dev`.";
              return true;
            },
          },
          {
            id: "retain",
            title: "Prove the table survives a stack delete",
            description:
              "Complete **TODO 2** (protect the table against both deletion and replacement). Then prove it: deploy the same template as a second stack, **`orders-test`** with `Env=test`, and **delete** that stack. Afterwards the stack and the queue `orders-test` must be gone, but the table **`orders-test`** must still exist.",
            hints: [
              "`DeletionPolicy` and `UpdateReplacePolicy` are attributes at the same level as `Type`, not under `Properties`.",
              "Deploy with `--stack-name orders-test --parameter-overrides Env=test`, then `aws cloudformation delete-stack --stack-name orders-test && aws cloudformation wait stack-delete-complete --stack-name orders-test`.",
              "If you deleted `orders-test` before adding the policies, the table is gone: fix the template, deploy and delete again.",
            ],
            check: async (ctx) => {
              const s = await stack(ctx, "orders-test");
              if (s && s.StackStatus !== "DELETE_COMPLETE")
                return `Stack \`orders-test\` still exists (${s.StackStatus}). Deploy it, then delete it.`;
              const t = await ctx.tryAws(["dynamodb", "describe-table", "--table-name", "orders-test"]);
              if (!t.ok)
                return "Table `orders-test` doesn't exist. Either you haven't deployed and deleted `orders-test` yet, or the table was deleted with the stack: check TODO 2.";
              if (await queueAttrs(ctx, "orders-test"))
                return "Queue `orders-test` still exists. Delete the `orders-test` stack (and wait for DELETE_COMPLETE).";
              return true;
            },
          },
        ],
        solution: String.raw`
cat > orders.yaml <<'EOF'
${ordersComplete}
EOF
aws cloudformation validate-template --template-body file://orders.yaml > /dev/null
aws cloudformation deploy --stack-name orders-dev --template-file orders.yaml --parameter-overrides Env=dev
aws cloudformation update-termination-protection --stack-name orders-dev --enable-termination-protection
aws cloudformation deploy --stack-name orders-test --template-file orders.yaml --parameter-overrides Env=test
aws cloudformation delete-stack --stack-name orders-test
aws cloudformation wait stack-delete-complete --stack-name orders-test
aws dynamodb describe-table --table-name orders-test --query Table.TableStatus
`,
      },
    },
    // ---------------------------------------------------------------- lab 2
    {
      id: "change-sets",
      kind: "lab",
      title: "Lab: Change sets, drift and cross-stack imports",
      minutes: 35,
      body: String.raw`
**Prepare lab** deploys the finished \`orders.yaml\` as \`orders-dev\` (\`Env=dev\`) and then simulates a teammate who, during last week's cost review, shortened the DLQ's retention **by hand in the console**.

You have two change requests:

1. The consumers are slow, so raise the **dev visibility timeout** from 30 to **60** seconds (in the \`EnvConfig\` mapping).
2. The product team wants the topic renamed from \`orders-<env>-events\` to **\`orders-<env>-notifications\`**.

One of these is harmless and one replaces a resource. Find out which **before** you execute anything. Then find the drift, and finally build a consumer stack that wires itself up purely through \`orders-dev\`'s exports.

Useful commands:

\`\`\`bash
aws cloudformation describe-change-set --stack-name orders-dev --change-set-name v2 \
  --query 'Changes[].ResourceChange.[LogicalResourceId,Action,Replacement]' --output text
aws cloudformation detect-stack-drift --stack-name orders-dev
\`\`\`

> Order matters here. If the consumer stack imported \`orders-dev-TopicArn\` *before* you renamed the topic, CloudFormation would refuse the update ("Cannot update export … as it is in use"). Try it afterwards if you're curious.
`,
      lab: {
        files: { "orders.yaml": ordersComplete, "consumer.yaml": consumerStarter },
        setup: String.raw`
aws cloudformation deploy --stack-name orders-dev --template-file orders.yaml --parameter-overrides Env=dev
DLQ=$(aws sqs get-queue-url --queue-name orders-dev-dlq --query QueueUrl --output text)
aws sqs set-queue-attributes --queue-url "$DLQ" --attributes MessageRetentionPeriod=86400
`,
        tasks: [
          {
            id: "change-set",
            title: "Create change set v2",
            description:
              "Edit `orders.yaml` to make both changes (dev `VisibilityTimeout` 60, topic name `orders-<env>-notifications`). Then create a change set named **`v2`** on `orders-dev`. Don't execute it yet: read it first.",
            hints: [
              "Change the `dev:` line of `EnvConfig`, and the last word of the topic's `!Join`.",
              "`Env` has no default, so pass `--parameters ParameterKey=Env,UsePreviousValue=true ParameterKey=RetentionSeconds,UsePreviousValue=true`.",
              "`aws cloudformation create-change-set --stack-name orders-dev --change-set-name v2 --template-body file://orders.yaml --parameters …` then `aws cloudformation wait change-set-create-complete --stack-name orders-dev --change-set-name v2`.",
            ],
            check: async (ctx) => {
              const r = await ctx.tryAws(["cloudformation", "describe-change-set", "--stack-name", "orders-dev", "--change-set-name", "v2"]);
              if (!r.ok) return "Change set `v2` doesn't exist on `orders-dev` yet.";
              if (r.data.Status === "FAILED")
                return `Change set v2 FAILED: ${r.data.StatusReason}. Delete it (\`aws cloudformation delete-change-set\`), fix the template and create it again.`;
              const ch = (r.data.Changes ?? []).map((c: any) => c.ResourceChange);
              const q = ch.find((c: any) => c.LogicalResourceId === "Queue");
              const t = ch.find((c: any) => c.LogicalResourceId === "Topic");
              if (!q) return "Change set v2 doesn't change `Queue`. Did you change the dev VisibilityTimeout in EnvConfig?";
              if (!t) return "Change set v2 doesn't change `Topic`. Did you rename the topic?";
              return true;
            },
          },
          {
            id: "findings",
            title: "Record which resources are replaced",
            description:
              "Write the change set's findings to **`changes.txt`**: one line per changed resource, in the form `<LogicalResourceId> <Action> <Replacement>` (for example `Foo Modify False`). This is exactly what `--query 'Changes[].ResourceChange.[LogicalResourceId,Action,Replacement]' --output text` prints.",
            hints: [
              "`aws cloudformation describe-change-set --stack-name orders-dev --change-set-name v2 --query 'Changes[].ResourceChange.[LogicalResourceId,Action,Replacement]' --output text > changes.txt`",
            ],
            check: async (ctx) => {
              const f = await ctx.readFile("changes.txt");
              if (f === null) return "`changes.txt` not found in the lab folder.";
              const rows = Object.fromEntries(
                f
                  .split("\n")
                  .map((l) => l.trim().split(/\s+/))
                  .filter((p) => p.length >= 3)
                  .map((p) => [p[0], { action: p[1], replace: p[2] }]),
              );
              const r = await ctx.tryAws(["cloudformation", "describe-change-set", "--stack-name", "orders-dev", "--change-set-name", "v2"]);
              if (!r.ok) return "Change set `v2` doesn't exist, so there is nothing to compare `changes.txt` with.";
              for (const c of (r.data.Changes ?? []).map((x: any) => x.ResourceChange)) {
                const row = rows[c.LogicalResourceId];
                if (!row) return `\`changes.txt\` has no line for \`${c.LogicalResourceId}\`, which change set v2 changes.`;
                if (row.action !== c.Action || row.replace !== String(c.Replacement))
                  return `\`changes.txt\` says \`${c.LogicalResourceId} ${row.action} ${row.replace}\`, but the change set says \`${c.Action} ${c.Replacement}\`.`;
              }
              if (rows.Topic?.replace !== "True") return "Look again: renaming a topic can't be done in place.";
              return true;
            },
          },
          {
            id: "execute",
            title: "Execute v2",
            description:
              "You've confirmed that only the (stateless) topic is replaced. Execute change set **`v2`** and wait for the update. Afterwards `orders-dev` must be `UPDATE_COMPLETE`, the queue's visibility timeout must be 60, and `orders-dev-notifications` must have **replaced** `orders-dev-events`.",
            hints: [
              "`aws cloudformation execute-change-set --stack-name orders-dev --change-set-name v2`",
              "`aws cloudformation wait stack-update-complete --stack-name orders-dev`",
            ],
            check: async (ctx) => {
              const s = await stack(ctx, "orders-dev");
              if (!s) return "Stack `orders-dev` doesn't exist. Press Prepare lab.";
              if (s.StackStatus !== "UPDATE_COMPLETE")
                return `Stack status is ${s.StackStatus}${s.StackStatusReason ? ` (${s.StackStatusReason})` : ""}; expected UPDATE_COMPLETE.`;
              const a = await queueAttrs(ctx, "orders-dev");
              if (a?.VisibilityTimeout !== "60") return `Queue \`orders-dev\` has VisibilityTimeout ${a?.VisibilityTimeout}; expected 60.`;
              if (!(await topicExists(ctx, "orders-dev-notifications"))) return "Topic `orders-dev-notifications` doesn't exist yet.";
              if (await topicExists(ctx, "orders-dev-events"))
                return "The old topic `orders-dev-events` still exists. Has the update finished its cleanup phase?";
              return true;
            },
          },
          {
            id: "drift",
            title: "Find the drift",
            description:
              "Run **drift detection** on `orders-dev`. Write the logical ID of the drifted resource and the drifted property path to **`drift.txt`** (for example `Foo /SomeProperty`).",
            hints: [
              "`aws cloudformation detect-stack-drift --stack-name orders-dev` returns a detection ID; poll `describe-stack-drift-detection-status` until `DETECTION_COMPLETE`.",
              "`aws cloudformation describe-stack-resource-drifts --stack-name orders-dev --stack-resource-drift-status-filters MODIFIED --query 'StackResourceDrifts[].[LogicalResourceId,PropertyDifferences[0].PropertyPath]' --output text > drift.txt`",
            ],
            check: async (ctx) => {
              const s = await stack(ctx, "orders-dev");
              const st = s?.DriftInformation?.StackDriftStatus;
              if (st !== "DRIFTED") return `The stack's drift status is ${st ?? "unknown"}. Run drift detection on \`orders-dev\`.`;
              const f = await ctx.readFile("drift.txt");
              if (f === null) return "`drift.txt` not found in the lab folder.";
              if (!/DeadLetterQueue/.test(f)) return "`drift.txt` should name the drifted resource by its logical ID.";
              if (!/MessageRetentionPeriod/.test(f)) return "`drift.txt` should include the drifted property path.";
              return true;
            },
          },
          {
            id: "consumer",
            title: "Deploy a consumer that imports the exports",
            description:
              "Complete the two TODOs in `consumer.yaml` (an SNS subscription from the imported topic to the imported queue, and an SSM parameter **`/orders/dev/queue-url`** holding the imported queue URL). Deploy it as **`orders-consumer`**. No ARN or URL may be hard-coded: everything comes from `Fn::ImportValue`.",
            hints: [
              "Copy the pattern from `QueuePolicy`: `Fn::ImportValue: !Sub \"${ProducerStack}-TopicArn\"`.",
              "Subscription properties: `Protocol: sqs`, `TopicArn`, `Endpoint` (the queue ARN). Parameter properties: `Name`, `Type: String`, `Value`.",
              "`aws cloudformation deploy --stack-name orders-consumer --template-file consumer.yaml`, then `aws cloudformation list-imports --export-name orders-dev-TopicArn`.",
            ],
            check: async (ctx) => {
              const s = await stack(ctx, "orders-consumer");
              if (!s) return "Stack `orders-consumer` doesn't exist yet.";
              if (!settled(s.StackStatus)) return `Stack \`orders-consumer\` is ${s.StackStatus}; expected CREATE_COMPLETE or UPDATE_COMPLETE.`;
              for (const name of ["orders-dev-TopicArn", "orders-dev-QueueUrl"]) {
                const imp = await ctx.tryAws(["cloudformation", "list-imports", "--export-name", name]);
                if (!(imp.data?.Imports ?? []).includes("orders-consumer")) return `\`orders-consumer\` doesn't import \`${name}\`.`;
              }
              const p = await ctx.tryAws(["ssm", "get-parameter", "--name", "/orders/dev/queue-url"]);
              if (!p.ok) return "SSM parameter `/orders/dev/queue-url` doesn't exist.";
              if (!String(p.data.Parameter.Value).endsWith(`/${ctx.account}/orders-dev`))
                return `\`/orders/dev/queue-url\` is \`${p.data.Parameter.Value}\`; expected the orders-dev queue URL.`;
              const topic = `arn:aws:sns:${ctx.region}:${ctx.account}:orders-dev-notifications`;
              const subs = await ctx.tryAws(["sns", "list-subscriptions-by-topic", "--topic-arn", topic]);
              const want = `arn:aws:sqs:${ctx.region}:${ctx.account}:orders-dev`;
              if (!(subs.data?.Subscriptions ?? []).some((x: any) => x.Protocol === "sqs" && x.Endpoint === want))
                return "`orders-dev-notifications` has no SQS subscription to `orders-dev`.";
              return true;
            },
          },
        ],
        solution: String.raw`
sed -i 's/dev:  { MaxReceiveCount: 3, VisibilityTimeout: 30 }/dev:  { MaxReceiveCount: 3, VisibilityTimeout: 60 }/' orders.yaml
sed -i 's/\[orders, !Ref Env, events\]/[orders, !Ref Env, notifications]/' orders.yaml
grep -q 'VisibilityTimeout: 60 }' orders.yaml
grep -q 'notifications]' orders.yaml
aws cloudformation create-change-set --stack-name orders-dev --change-set-name v2 \
  --template-body file://orders.yaml \
  --parameters ParameterKey=Env,UsePreviousValue=true ParameterKey=RetentionSeconds,UsePreviousValue=true
aws cloudformation wait change-set-create-complete --stack-name orders-dev --change-set-name v2
aws cloudformation describe-change-set --stack-name orders-dev --change-set-name v2 \
  --query 'Changes[].ResourceChange.[LogicalResourceId,Action,Replacement]' --output text > changes.txt
cat changes.txt
aws cloudformation execute-change-set --stack-name orders-dev --change-set-name v2
aws cloudformation wait stack-update-complete --stack-name orders-dev

DID=$(aws cloudformation detect-stack-drift --stack-name orders-dev --query StackDriftDetectionId --output text)
for _ in $(seq 60); do
  S=$(aws cloudformation describe-stack-drift-detection-status --stack-drift-detection-id "$DID" --query DetectionStatus --output text)
  [ "$S" != "DETECTION_IN_PROGRESS" ] && break
  sleep 1
done
aws cloudformation describe-stack-resource-drifts --stack-name orders-dev --stack-resource-drift-status-filters MODIFIED \
  --query 'StackResourceDrifts[].[LogicalResourceId,PropertyDifferences[0].PropertyPath]' --output text > drift.txt
cat drift.txt

cat > consumer.yaml <<'EOF'
${consumerComplete}
EOF
aws cloudformation deploy --stack-name orders-consumer --template-file consumer.yaml
`,
      },
    },
  ],
  quiz: [
    {
      q: "A PR changes `KeySchema` on the `AWS::DynamoDB::Table` named `orders-prod`, which has no DeletionPolicy or UpdateReplacePolicy. What happens if you run `aws cloudformation deploy` on real AWS?",
      options: [
        "The table's key schema is altered in place, keeping the data",
        "CloudFormation tries to replace the table; because it has a custom name, the update fails and rolls back. Without the custom name, it would have created a new empty table and deleted the old one",
        "CloudFormation creates a GSI with the new key instead",
        "The change is ignored because key schemas are immutable",
      ],
      answer: 1,
      explain:
        "`KeySchema` requires **replacement**. With a custom `TableName`, CloudFormation can't create the new table alongside the old one, so it fails with \"cannot update a stack when a custom-named resource requires replacing\". That's the lucky case. With a generated name it would succeed, and the old table (with all its data) would be deleted in cleanup. A change set shows `Replacement: True` beforehand, and `UpdateReplacePolicy: Retain` would keep the old table.",
    },
    {
      q: "A stack's first deploy failed and it's now in `ROLLBACK_COMPLETE`. A colleague runs `deploy` again with a fixed template and gets an error. What should they do?",
      options: [
        "Run `continue-update-rollback`",
        "Delete the stack and create it again: a stack whose creation rolled back can't be updated",
        "Set termination protection, then update",
        "Wait an hour for the stack to time out",
      ],
      answer: 1,
      explain:
        "`ROLLBACK_COMPLETE` means the *create* failed and everything was rolled back. The stack is a tombstone with nothing in it, and the only valid operation is delete. `continue-update-rollback` is for `UPDATE_ROLLBACK_FAILED`.",
    },
    {
      q: "An update failed, and the rollback also failed because someone deleted a Lambda function by hand. The stack is in `UPDATE_ROLLBACK_FAILED`. What's the right sequence?",
      options: [
        "Delete the stack: the state is unrecoverable",
        "Fix or recreate what blocks the rollback (or accept losing it), then run `continue-update-rollback`, optionally with `--resources-to-skip` for the resource you can't restore",
        "Run `cancel-update-stack`",
        "Deploy the new template again; it overrides the failed rollback",
      ],
      answer: 1,
      explain:
        "`continue-update-rollback` retries the rollback. `--resources-to-skip` tells CloudFormation to mark the listed resources as rolled back without touching them. Then the stack reaches `UPDATE_ROLLBACK_COMPLETE` and you can deploy again, fixing the skipped resource in that next update. `cancel-update-stack` only applies while an update is *in progress*.",
    },
    {
      q: "A table has `DeletionPolicy: Retain` but no `UpdateReplacePolicy`. A template change causes the table to be replaced. What happens to the old table?",
      options: [
        "It's retained, because DeletionPolicy covers replacement",
        "It's deleted: DeletionPolicy only applies when the resource leaves the stack, and replacement is governed by UpdateReplacePolicy (default Delete)",
        "CloudFormation refuses the update",
        "It's snapshotted",
      ],
      answer: 1,
      explain:
        "The two attributes cover different events. DeletionPolicy applies when the resource is removed from the template or the stack is deleted. UpdateReplacePolicy applies to the *old* physical resource after a replacement. Set both on every stateful resource, and add a stack policy that denies `Update:Replace` on it for a hard stop.",
    },
    {
      q: "Stack `network` exports `network-VpcId`, imported by 12 application stacks. You need to replace the VPC. What will CloudFormation do if you deploy the change to `network` directly?",
      options: [
        "Update the export and redeploy the 12 consumers automatically",
        "Refuse the update, because an export that's in use can't change value; you must remove the imports from consumers first (or move them to SSM parameters)",
        "Update the export; consumers pick up the new value on their next deploy",
        "Delete the consumers",
      ],
      answer: 1,
      explain:
        "Exports in use are locked: \"Cannot update export network-VpcId as it is in use by …\". That's the strong-coupling trade-off of Export/ImportValue. For values that may change, publish them as SSM parameters, which consumers resolve at deploy time without CloudFormation enforcing the dependency.",
    },
    {
      q: "Someone raised a queue's visibility timeout in the console during an incident. Next week you deploy an unrelated change to the same stack. What happens to the manual change?",
      options: [
        "CloudFormation reverts it, because every deploy enforces the whole template",
        "It survives: CloudFormation only updates properties that changed in the template. Drift detection reports it as MODIFIED until someone fixes the template or reverts the change",
        "The deploy fails because of drift",
        "CloudFormation imports the change into the template",
      ],
      answer: 1,
      explain:
        "CloudFormation compares the new template with the *previous template*, not with reality. Drift survives deploys silently. Run drift detection on a schedule, then either codify the manual change (if it was right) or revert it.",
    },
    {
      q: "Your pipeline uses `aws cloudformation deploy` directly on merge. What's the most valuable change to make it safe for stateful stacks?",
      options: [
        "Add `--disable-rollback`",
        "Split it: create a change set in the PR, fail on `Replacement: True` or `Remove` for stateful types, require approval, then execute that exact change set",
        "Run `validate-template` first",
        "Deploy at night",
      ],
      answer: 1,
      explain:
        "`validate-template` (and cfn-lint) check syntax, not consequences. Only a change set against the live stack tells you what *this* update will replace or delete. Reviewing it, with an automatic block on destructive actions for stateful types, is CloudFormation's equivalent of reviewing a `terraform plan`.",
    },
  ],
};
