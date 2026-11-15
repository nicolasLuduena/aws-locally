import type { CheckContext, Module } from "../types.ts";

// ------------------------------------------------------------------ template
// The platform template is assembled from parts so the lab's starter skeleton
// (with TODOs) and the reference solution can't drift apart.

const T_HEAD = String.raw`AWSTemplateFormatVersion: "2010-09-09"
Description: >-
  Order-processing platform: HTTP API -> orders Lambda -> DynamoDB + EventBridge
  -> SQS (+DLQ) -> fulfilment Lambda. One stack, least-privilege roles.

Parameters:
  Warehouse:
    Type: String
    Default: EU-1
    Description: Warehouse that fulfils orders (stored in the encrypted config secret)

Resources:
  # ---------------------------------------------------------------- config
  ConfigKey:
    Type: AWS::KMS::Key
    Properties:
      Description: Encrypts the platform configuration secret
      EnableKeyRotation: true
      KeyPolicy:
        Version: "2012-10-17"
        Statement:
          - Sid: AccountAdministersKeyThroughIam
            Effect: Allow
            Principal: { AWS: !Sub "arn:aws:iam::\${AWS::AccountId}:root" }
            Action: "kms:*"
            Resource: "*"
  ConfigKeyAlias:
    Type: AWS::KMS::Alias
    Properties:
      AliasName: !Sub "alias/\${AWS::StackName}-config"
      TargetKeyId: !Ref ConfigKey
  FulfilmentConfig:
    Type: AWS::SecretsManager::Secret
    Properties:
      Name: !Sub "\${AWS::StackName}/fulfilment-config"
      Description: Fulfilment worker configuration
      KmsKeyId: !Ref ConfigKey
      SecretString: !Sub '{"warehouse":"\${Warehouse}","carrierApiKey":"demo-not-a-real-key"}'

  # ---------------------------------------------------------------- data
  OrdersTable:
    Type: AWS::DynamoDB::Table
    Properties:
      TableName: !Sub "\${AWS::StackName}-orders"
      BillingMode: PAY_PER_REQUEST
      AttributeDefinitions: [{ AttributeName: orderId, AttributeType: S }]
      KeySchema: [{ AttributeName: orderId, KeyType: HASH }]
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true }

  # ---------------------------------------------------------------- queues
  FulfilmentDLQ:
    Type: AWS::SQS::Queue
    Properties:
      QueueName: !Sub "\${AWS::StackName}-fulfilment-dlq"
      MessageRetentionPeriod: 1209600 # 14 days: longer than the source queue's retention
  FulfilmentQueue:
    Type: AWS::SQS::Queue
    Properties:
      QueueName: !Sub "\${AWS::StackName}-fulfilment"
      VisibilityTimeout: 18 # 6x the worker's 3s timeout
`;

const T_REDRIVE = String.raw`      RedrivePolicy:
        deadLetterTargetArn: !GetAtt FulfilmentDLQ.Arn
        maxReceiveCount: 3
`;

const TODO_REDRIVE = String.raw`      # TODO 1: add a RedrivePolicy that moves a message to FulfilmentDLQ
      #         after 3 failed receives (deadLetterTargetArn, maxReceiveCount).
`;

const T_RULE = String.raw`
  # ---------------------------------------------------------------- events
  # Default bus: see the lab notes on custom buses in the emulator.
  OrderPlacedRule:
    Type: AWS::Events::Rule
    Properties:
      Name: !Sub "\${AWS::StackName}-order-placed"
      EventBusName: default
      EventPattern:
        source: [acme.orders]
        detail-type: [OrderPlaced]
      Targets:
        - Id: fulfilment-queue
          Arn: !GetAtt FulfilmentQueue.Arn
  FulfilmentQueuePolicy:
    Type: AWS::SQS::QueuePolicy
    Properties:
      Queues: [!Ref FulfilmentQueue]
      PolicyDocument:
        Version: "2012-10-17"
        Statement:
          - Sid: OnlyTheOrderPlacedRule
            Effect: Allow
            Principal: { Service: events.amazonaws.com }
            Action: sqs:SendMessage
            Resource: !GetAtt FulfilmentQueue.Arn
            Condition:
              ArnEquals: { "aws:SourceArn": !GetAtt OrderPlacedRule.Arn }
`;

const TODO_RULE = String.raw`
  # ---------------------------------------------------------------- events
  # TODO 2: OrderPlacedRule (AWS::Events::Rule) named "\${AWS::StackName}-order-placed"
  #         on the default bus, matching source "acme.orders" and detail-type
  #         "OrderPlaced", targeting FulfilmentQueue.
  #         FulfilmentQueuePolicy (AWS::SQS::QueuePolicy) that lets
  #         events.amazonaws.com sqs:SendMessage to FulfilmentQueue, but only
  #         when aws:SourceArn is that rule.
`;

const T_FUNCTIONS = String.raw`
  # ---------------------------------------------------------------- orders API
  OrdersLogGroup:
    Type: AWS::Logs::LogGroup
    Properties:
      LogGroupName: !Sub "/aws/lambda/\${AWS::StackName}-orders-api"
      RetentionInDays: 14
  OrdersFunctionRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: !Sub "\${AWS::StackName}-orders-api"
      AssumeRolePolicyDocument:
        Version: "2012-10-17"
        Statement:
          - Effect: Allow
            Principal: { Service: lambda.amazonaws.com }
            Action: sts:AssumeRole
      ManagedPolicyArns:
        - arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
      Policies:
        - PolicyName: orders-api
          PolicyDocument:
            Version: "2012-10-17"
            Statement:
              - Effect: Allow
                Action: dynamodb:PutItem
                Resource: !GetAtt OrdersTable.Arn
              - Effect: Allow
                Action: events:PutEvents
                Resource: !Sub "arn:aws:events:\${AWS::Region}:\${AWS::AccountId}:event-bus/default"
  OrdersFunction:
    Type: AWS::Lambda::Function
    DependsOn: OrdersLogGroup
    Properties:
      FunctionName: !Sub "\${AWS::StackName}-orders-api"
      Runtime: python3.12
      Handler: index.handler
      Timeout: 5
      Role: !GetAtt OrdersFunctionRole.Arn
      Environment:
        Variables:
          TABLE: !Ref OrdersTable
      Code:
        ZipFile: |
          import json, os, uuid, boto3
          ddb = boto3.client("dynamodb")
          events = boto3.client("events")

          def handler(event, context):
              body = json.loads(event.get("body") or "{}")
              items = body.get("items") or []
              if not items:
                  return {"statusCode": 400, "body": json.dumps({"error": "items is required"})}
              order_id = str(uuid.uuid4())
              ddb.put_item(
                  TableName=os.environ["TABLE"],
                  Item={"orderId": {"S": order_id}, "status": {"S": "PLACED"},
                        "items": {"S": json.dumps(items)}},
                  ConditionExpression="attribute_not_exists(orderId)",
              )
              events.put_events(Entries=[{
                  "Source": "acme.orders", "DetailType": "OrderPlaced",
                  "Detail": json.dumps({"orderId": order_id, "items": items}),
              }])
              print(json.dumps({"level": "INFO", "msg": "order placed", "orderId": order_id}))
              return {"statusCode": 201, "body": json.dumps({"orderId": order_id, "status": "PLACED"})}

  # ---------------------------------------------------------------- fulfilment worker
  FulfilmentLogGroup:
    Type: AWS::Logs::LogGroup
    Properties:
      LogGroupName: !Sub "/aws/lambda/\${AWS::StackName}-fulfilment"
      RetentionInDays: 14
  FulfilmentFunctionRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: !Sub "\${AWS::StackName}-fulfilment"
      AssumeRolePolicyDocument:
        Version: "2012-10-17"
        Statement:
          - Effect: Allow
            Principal: { Service: lambda.amazonaws.com }
            Action: sts:AssumeRole
      ManagedPolicyArns:
        - arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
`;

const T_WORKER_POLICY = String.raw`      Policies:
        - PolicyName: fulfilment
          PolicyDocument:
            Version: "2012-10-17"
            Statement:
              - Sid: ConsumeTheFulfilmentQueue
                Effect: Allow
                Action: [sqs:ReceiveMessage, sqs:DeleteMessage, sqs:GetQueueAttributes, sqs:ChangeMessageVisibility]
                Resource: !GetAtt FulfilmentQueue.Arn
              - Sid: UpdateOrderStatus
                Effect: Allow
                Action: dynamodb:UpdateItem
                Resource: !GetAtt OrdersTable.Arn
              - Sid: ReadConfig
                Effect: Allow
                Action: secretsmanager:GetSecretValue
                Resource: !Ref FulfilmentConfig
              - Sid: DecryptConfigViaSecretsManagerOnly
                Effect: Allow
                Action: kms:Decrypt
                Resource: !GetAtt ConfigKey.Arn
                Condition:
                  StringEquals: { "kms:ViaService": !Sub "secretsmanager.\${AWS::Region}.amazonaws.com" }
`;

const TODO_WORKER_POLICY = String.raw`      # TODO 3: add an inline policy (Policies:) with only what the worker needs:
      #   - sqs:ReceiveMessage, sqs:DeleteMessage, sqs:GetQueueAttributes,
      #     sqs:ChangeMessageVisibility on FulfilmentQueue
      #   - dynamodb:UpdateItem on OrdersTable
      #   - secretsmanager:GetSecretValue on FulfilmentConfig
      #   - kms:Decrypt on ConfigKey, only via Secrets Manager
      #     (condition kms:ViaService = secretsmanager.<region>.amazonaws.com)
`;

const T_WORKER = String.raw`  FulfilmentFunction:
    Type: AWS::Lambda::Function
    DependsOn: FulfilmentLogGroup
    Properties:
      FunctionName: !Sub "\${AWS::StackName}-fulfilment"
      Runtime: python3.12
      Handler: index.handler
      Timeout: 3
      Role: !GetAtt FulfilmentFunctionRole.Arn
      Environment:
        Variables:
          TABLE: !Ref OrdersTable
          CONFIG_SECRET: !Ref FulfilmentConfig
      Code:
        ZipFile: |
          import json, os, boto3
          ddb = boto3.client("dynamodb")
          secrets = boto3.client("secretsmanager")
          _config = None

          def config():
              # Read once per execution environment, not once per message.
              global _config
              if _config is None:
                  raw = secrets.get_secret_value(SecretId=os.environ["CONFIG_SECRET"])["SecretString"]
                  _config = json.loads(raw)
              return _config

          def handler(event, context):
              failures = []
              for record in event["Records"]:
                  try:
                      detail = json.loads(record["body"])["detail"]
                      order_id = detail["orderId"]
                      ddb.update_item(
                          TableName=os.environ["TABLE"],
                          Key={"orderId": {"S": order_id}},
                          UpdateExpression="SET #s = :s, warehouse = :w",
                          ConditionExpression="attribute_exists(orderId)",
                          ExpressionAttributeNames={"#s": "status"},
                          ExpressionAttributeValues={":s": {"S": "FULFILLED"}, ":w": {"S": config()["warehouse"]}},
                      )
                      print(json.dumps({"level": "INFO", "msg": "order fulfilled", "orderId": order_id}))
                  except Exception as e:
                      print(json.dumps({"level": "ERROR", "msg": "fulfilment failed",
                                        "messageId": record["messageId"], "error": repr(e)}))
                      failures.append({"itemIdentifier": record["messageId"]})
              # Partial batch response: only the failed messages are retried.
              return {"batchItemFailures": failures}
`;

const T_ESM = String.raw`  FulfilmentMapping:
    Type: AWS::Lambda::EventSourceMapping
    Properties:
      FunctionName: !Ref FulfilmentFunction
      EventSourceArn: !GetAtt FulfilmentQueue.Arn
      BatchSize: 10
      FunctionResponseTypes: [ReportBatchItemFailures]
`;

const TODO_ESM = String.raw`  # TODO 4: FulfilmentMapping (AWS::Lambda::EventSourceMapping) from
  #         FulfilmentQueue to FulfilmentFunction, batch size 10, with
  #         FunctionResponseTypes [ReportBatchItemFailures].
`;

const T_API = String.raw`
  # ---------------------------------------------------------------- HTTP API
  HttpApi:
    Type: AWS::ApiGatewayV2::Api
    Properties:
      Name: !Sub "\${AWS::StackName}-api"
      ProtocolType: HTTP
  OrdersIntegration:
    Type: AWS::ApiGatewayV2::Integration
    Properties:
      ApiId: !Ref HttpApi
      IntegrationType: AWS_PROXY
      IntegrationUri: !GetAtt OrdersFunction.Arn
      PayloadFormatVersion: "2.0"
  PostOrdersRoute:
    Type: AWS::ApiGatewayV2::Route
    Properties:
      ApiId: !Ref HttpApi
      RouteKey: POST /orders
      Target: !Sub "integrations/\${OrdersIntegration}"
  DefaultStage:
    Type: AWS::ApiGatewayV2::Stage
    Properties:
      ApiId: !Ref HttpApi
      StageName: $default
      AutoDeploy: true
  ApiInvokePermission:
    Type: AWS::Lambda::Permission
    Properties:
      FunctionName: !Ref OrdersFunction
      Action: lambda:InvokeFunction
      Principal: apigateway.amazonaws.com
      SourceArn: !Sub "arn:aws:execute-api:\${AWS::Region}:\${AWS::AccountId}:\${HttpApi}/*/*/orders"
`;

const T_ALARM = String.raw`
  # ---------------------------------------------------------------- alerting
  AlertsTopic:
    Type: AWS::SNS::Topic
    Properties:
      TopicName: !Sub "\${AWS::StackName}-alerts"
  DlqAlarm:
    Type: AWS::CloudWatch::Alarm
    Properties:
      AlarmName: !Sub "\${AWS::StackName}-dlq-not-empty"
      AlarmDescription: >-
        Orders failed fulfilment 3 times. Runbook: find the cause in the
        fulfilment logs, fix, then redrive the DLQ (start-message-move-task).
      Namespace: AWS/SQS
      MetricName: ApproximateNumberOfMessagesVisible
      Dimensions:
        - Name: QueueName
          Value: !GetAtt FulfilmentDLQ.QueueName
      Statistic: Maximum
      Period: 60
      EvaluationPeriods: 1
      Threshold: 0
      ComparisonOperator: GreaterThanThreshold
      TreatMissingData: notBreaching
      AlarmActions: [!Ref AlertsTopic]
      OKActions: [!Ref AlertsTopic]
`;

const TODO_ALARM = String.raw`
  # ---------------------------------------------------------------- alerting
  # TODO 5: AlertsTopic (AWS::SNS::Topic) named "\${AWS::StackName}-alerts", and
  #         DlqAlarm (AWS::CloudWatch::Alarm) named "\${AWS::StackName}-dlq-not-empty"
  #         on AWS/SQS ApproximateNumberOfMessagesVisible for the DLQ
  #         (dimension QueueName), firing as soon as one message is there,
  #         treating missing data as not breaching, notifying AlertsTopic.
`;

const T_OUTPUTS = String.raw`
Outputs:
  ApiId:
    Value: !Ref HttpApi
  TableName:
    Value: !Ref OrdersTable
  QueueUrl:
    Value: !Ref FulfilmentQueue
  DlqUrl:
    Value: !Ref FulfilmentDLQ
`;

const T_ALARM_OUT = String.raw`  AlertsTopicArn:
    Value: !Ref AlertsTopic
`;

const TODO_ALARM_OUT = String.raw`  # TODO 5 (cont.): output AlertsTopicArn once the topic exists.
`;

const FULL_TEMPLATE =
  T_HEAD + T_REDRIVE + T_RULE + T_FUNCTIONS + T_WORKER_POLICY + T_WORKER + T_ESM + T_API + T_ALARM + T_OUTPUTS + T_ALARM_OUT;

const SKELETON_TEMPLATE =
  T_HEAD + TODO_REDRIVE + TODO_RULE + T_FUNCTIONS + TODO_WORKER_POLICY + T_WORKER + TODO_ESM + T_API + TODO_ALARM + T_OUTPUTS + TODO_ALARM_OUT;

// Packages the FulfilmentFunction's inline code from platform.yaml, so a hotfix
// ships exactly what the template says.
const PACKAGE_SCRIPT = String.raw`#!/usr/bin/env bash
# Package the FulfilmentFunction inline code (ZipFile) from platform.yaml into
# build/fulfilment.zip. The template stays the single source of truth: what you
# ship is byte for byte what the next "cloudformation deploy" would ship.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build
python3 - platform.yaml build/index.py <<'PY'
import sys
lines = open(sys.argv[1]).read().split("\n")
start = lines.index("  FulfilmentFunction:")
i = next(j for j in range(start, len(lines)) if lines[j].strip() == "ZipFile: |") + 1
out = []
while i < len(lines) and (lines[i].strip() == "" or lines[i].startswith(" " * 10)):
    out.append(lines[i][10:])
    i += 1
open(sys.argv[2], "w").write("\n".join(out).rstrip() + "\n")
PY
(cd build && rm -f fulfilment.zip && zip -q fulfilment.zip index.py)
echo "packaged build/fulfilment.zip ($(wc -l < build/index.py) lines)"
`;

// ------------------------------------------------------------------ check helpers

const asList = (x: any): any[] => (x === undefined || x === null ? [] : Array.isArray(x) ? x : [x]);
const GOOD_STACK = ["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"];

async function stackProblem(ctx: CheckContext, stack: string): Promise<string | null> {
  const r = await ctx.tryAws(["cloudformation", "describe-stacks", "--stack-name", stack]);
  if (!r.ok) return `Stack \`${stack}\` doesn't exist yet. Deploy platform.yaml with \`aws cloudformation deploy\`.`;
  const s = r.data.Stacks[0].StackStatus;
  if (!GOOD_STACK.includes(s))
    return `Stack \`${stack}\` is ${s}. Look at \`aws cloudformation describe-stack-events --stack-name ${stack}\` for the first FAILED event${s === "ROLLBACK_COMPLETE" ? ", then delete the stack and deploy again" : ""}.`;
  return null;
}

async function stackTypes(ctx: CheckContext, stack: string): Promise<string[]> {
  const r = await ctx.tryAws(["cloudformation", "describe-stack-resources", "--stack-name", stack]);
  return (r.data?.StackResources ?? []).map((x: any) => x.ResourceType);
}

async function queue(ctx: CheckContext, name: string): Promise<{ url: string; attrs: Record<string, string> } | null> {
  const u = await ctx.tryAws(["sqs", "get-queue-url", "--queue-name", name]);
  if (!u.ok) return null;
  const a = await ctx.aws(["sqs", "get-queue-attributes", "--queue-url", u.data.QueueUrl, "--attribute-names", "All"]);
  return { url: u.data.QueueUrl, attrs: a.Attributes ?? {} };
}

async function decide(ctx: CheckContext, role: string, action: string, resource: string, context?: string): Promise<string> {
  const args = ["iam", "simulate-principal-policy", "--policy-source-arn", `arn:aws:iam::${ctx.account}:role/${role}`, "--action-names", action, "--resource-arns", resource];
  if (context) args.push("--context-entries", context);
  const r = await ctx.aws(args);
  return r.EvaluationResults?.[0]?.EvalDecision ?? "unknown";
}

async function orderItem(ctx: CheckContext, table: string, id: string): Promise<any | null> {
  const r = await ctx.tryAws(["dynamodb", "get-item", "--table-name", table, "--key", JSON.stringify({ orderId: { S: id } })]);
  return r.ok ? (r.data?.Item ?? null) : null;
}

/** The FulfilmentFunction ZipFile code from a template, dedented and normalised. */
function templateWorkerCode(yaml: string): string | null {
  const lines = yaml.split("\n");
  const start = lines.indexOf("  FulfilmentFunction:");
  if (start < 0) return null;
  let i = lines.findIndex((l, j) => j > start && l.trim() === "ZipFile: |");
  if (i < 0) return null;
  const out: string[] = [];
  for (i++; i < lines.length && (lines[i].trim() === "" || lines[i].startsWith(" ".repeat(10))); i++) out.push(lines[i].slice(10));
  return normaliseCode(out.join("\n"));
}
const normaliseCode = (s: string) =>
  s
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .trim();

/** Download the code a function is running and return its index.py. */
async function deployedWorkerCode(ctx: CheckContext, fn: string): Promise<string | null> {
  const r = await ctx.sh(String.raw`set -e
u=$(aws lambda get-function --function-name ${fn} --query Code.Location --output text)
f=$(mktemp); curl -sSf --cacert "$AWS_CA_BUNDLE" -o "$f" "$u"
python3 -c 'import sys, zipfile; sys.stdout.write(zipfile.ZipFile(sys.argv[1]).read("index.py").decode())' "$f"
rm -f "$f"`);
  return r.code === 0 ? normaliseCode(r.stdout) : null;
}

// ------------------------------------------------------------------ module

export const capstone: Module = {
  id: "capstone",
  number: "14",
  title: "Capstone: ship and operate an event-driven platform",
  summary:
    "Design, deploy and operate an order-processing platform from one CloudFormation template, then run a game day: find a poison message, fix it, and redrive the DLQ.",
  services: ["CloudFormation", "API Gateway", "Lambda", "DynamoDB", "EventBridge", "SQS", "SNS", "CloudWatch", "KMS", "Secrets Manager", "IAM"],
  lessons: [
    {
      id: "brief",
      kind: "reading",
      title: "The brief: an order-processing platform",
      minutes: 15,
      body: String.raw`
Acme's shop needs a new order pipeline. The requirements, as the product and on-call teams wrote them:

1. **Accept orders over HTTP** and answer in milliseconds, even if fulfilment is slow or down.
2. **Never lose an order.** Failures are retried, and anything that can't be processed is kept for a human.
3. **Page someone** when orders get stuck, with a runbook.
4. **Least privilege**: each function can touch only what it needs.
5. **Configuration that includes a credential** (the carrier API key) is encrypted with a customer-managed KMS key, never in environment variables or code.
6. **One CloudFormation template** creates all of it, so every environment (dev, staging, a game-day copy) is identical.

This module ties together everything from the course: IAM roles and resource policies, Lambda, DynamoDB, EventBridge, SQS with DLQs, KMS and Secrets Manager, CloudWatch alarms and SNS, IaC, and the operational habits from the CI/CD module.

## The architecture

<figure class="diagram">
<svg viewBox="0 0 640 400" role="img" aria-label="Client posts to an HTTP API, orders Lambda writes DynamoDB and publishes to EventBridge, a rule sends to SQS with a DLQ, a fulfilment Lambda updates DynamoDB; DLQ alarm notifies SNS">
  <rect x="10" y="10" width="620" height="380" rx="10" class="d-box d-outer"/>
  <text x="24" y="32" class="d-label">Stack: orders-platform (one template)</text>
  <rect x="24" y="56" width="86" height="48" rx="8" class="d-box d-dim"/><text x="67" y="84" text-anchor="middle" class="d-label">Client</text>
  <rect x="140" y="56" width="110" height="48" rx="8" class="d-box"/><text x="195" y="78" text-anchor="middle" class="d-label">HTTP API</text><text x="195" y="94" text-anchor="middle" class="d-small">POST /orders</text>
  <rect x="280" y="56" width="120" height="48" rx="8" class="d-box d-accent"/><text x="340" y="78" text-anchor="middle" class="d-label">orders-api λ</text><text x="340" y="94" text-anchor="middle" class="d-small">validate, write</text>
  <rect x="460" y="56" width="150" height="48" rx="8" class="d-box"/><text x="535" y="78" text-anchor="middle" class="d-label">DynamoDB orders</text><text x="535" y="94" text-anchor="middle" class="d-small">PLACED → FULFILLED</text>
  <path d="M110 80 H138" class="d-arrow"/><path d="M250 80 H278" class="d-arrow"/><path d="M400 80 H458" class="d-arrow"/>
  <text x="429" y="72" text-anchor="middle" class="d-small">PutItem</text>
  <rect x="280" y="140" width="120" height="48" rx="8" class="d-box"/><text x="340" y="162" text-anchor="middle" class="d-label">EventBridge</text><text x="340" y="178" text-anchor="middle" class="d-small">default bus</text>
  <path d="M340 104 V138" class="d-arrow"/><text x="348" y="125" class="d-small">OrderPlaced</text>
  <rect x="280" y="222" width="120" height="48" rx="8" class="d-box"/><text x="340" y="244" text-anchor="middle" class="d-label">rule</text><text x="340" y="260" text-anchor="middle" class="d-small">source + detail-type</text>
  <path d="M340 188 V220" class="d-arrow"/>
  <rect x="40" y="222" width="190" height="48" rx="8" class="d-box"/><text x="135" y="244" text-anchor="middle" class="d-label">SQS fulfilment</text><text x="135" y="260" text-anchor="middle" class="d-small">queue policy: only the rule</text>
  <path d="M280 246 H232" class="d-arrow"/>
  <rect x="40" y="316" width="190" height="48" rx="8" class="d-box d-danger"/><text x="135" y="338" text-anchor="middle" class="d-label">fulfilment DLQ</text><text x="135" y="354" text-anchor="middle" class="d-small">after 3 receives</text>
  <path d="M135 270 V314" class="d-arrow d-dashed"/>
  <rect x="460" y="222" width="150" height="48" rx="8" class="d-box d-accent"/><text x="535" y="244" text-anchor="middle" class="d-label">fulfilment λ</text><text x="535" y="260" text-anchor="middle" class="d-small">event source mapping</text>
  <path d="M232 230 C300 200 400 200 458 232" class="d-arrow d-dashed"/><text x="420" y="206" class="d-small">poll</text>
  <path d="M535 222 V106" class="d-arrow"/><text x="543" y="170" class="d-small">UpdateItem</text>
  <rect x="460" y="300" width="150" height="40" rx="8" class="d-box d-dim"/><text x="535" y="325" text-anchor="middle" class="d-small">Secrets Manager + KMS</text>
  <path d="M535 270 V298" class="d-arrow d-dashed"/>
  <rect x="270" y="316" width="140" height="48" rx="8" class="d-box"/><text x="340" y="338" text-anchor="middle" class="d-label">alarm → SNS</text><text x="340" y="354" text-anchor="middle" class="d-small">DLQ not empty</text>
  <path d="M230 340 H268" class="d-arrow d-dashed"/>
</svg>
<figcaption>The synchronous path ends at DynamoDB + EventBridge. Everything after the event is asynchronous, retried, and observable.</figcaption>
</figure>

## Walking the request

**1. HTTP API → orders Lambda.** An API Gateway HTTP API with a \`POST /orders\` route and a Lambda proxy integration (payload format 2.0). A \`AWS::Lambda::Permission\` lets \`apigateway.amazonaws.com\` invoke the function, scoped by \`SourceArn\` to this API's \`/orders\` route. The function validates the body, generates an \`orderId\`, writes the order as \`PLACED\` with \`attribute_not_exists(orderId)\` (no accidental overwrite), publishes \`OrderPlaced\` to EventBridge, and returns \`201\`. The client's latency is just those two writes.

**2. EventBridge → SQS.** A rule on the bus matches \`source: acme.orders\` and \`detail-type: OrderPlaced\` and targets the fulfilment queue. EventBridge needs permission to send: the **queue policy** allows \`events.amazonaws.com\` \`sqs:SendMessage\`, *only* when \`aws:SourceArn\` is this rule. Without the condition, any rule in any account that knew the queue ARN could inject messages. Why a queue between the event and the worker rather than targeting the Lambda directly? The queue gives you **buffering** (a spike is absorbed rather than throttled), **retries with a DLQ under your control**, and **concurrency control** (the event source mapping's \`MaximumConcurrency\` protects downstream systems).

**3. SQS → fulfilment Lambda.** An **event source mapping** polls the queue and invokes the worker with batches of up to 10 messages. The worker reports **partial batch failures** (\`ReportBatchItemFailures\`): it returns the IDs of only the messages that failed, so one bad message doesn't make nine good ones retry. Each failed message becomes visible again after the visibility timeout; after **3 receives** SQS moves it to the **DLQ**.

**4. Worker → DynamoDB.** \`UpdateItem\` sets \`status = FULFILLED\` and the warehouse, with \`attribute_exists(orderId)\` so a stray event can't create half an order. Setting a status is **idempotent**: SQS delivery is at-least-once, so the same message can arrive twice, and running it twice must be harmless.

**5. Config.** The worker reads its configuration (warehouse, carrier API key) from a Secrets Manager secret encrypted with a **customer-managed KMS key**, once per execution environment (cached in a module-level variable), not once per message. Its role can call \`kms:Decrypt\` on that key **only via Secrets Manager** (\`kms:ViaService\`), so the permission can't be used to decrypt anything else directly.

**6. Alerting.** A CloudWatch alarm fires when the DLQ has any message and notifies an SNS topic (which pages on-call). Its description is the first line of the runbook.

## The numbers that matter

| Setting | Value | Why |
|---|---|---|
| Worker timeout | 3 s | Short work; a hung call fails fast |
| Queue visibility timeout | 18 s | At least **6× the function timeout** (AWS's guidance for SQS event sources), so a message isn't redelivered while a slow batch is still running |
| \`maxReceiveCount\` | 3 | Enough for transient errors (throttling, a blip), few enough that poison messages reach the DLQ in under a minute |
| DLQ retention | 14 days | For standard queues, a message's age counts from when it was **first** enqueued, so the DLQ's retention must be longer than the source's or redriven messages can expire immediately |
| Log retention | 14 days | Lambda's default log groups never expire, and log storage is a slow-growing bill |

## Least privilege, per function

| Role | Allowed | Notably *not* allowed |
|---|---|---|
| \`orders-api\` | \`dynamodb:PutItem\` on the table, \`events:PutEvents\` on the bus, logs | Reading orders, updating them, anything on the queue |
| \`fulfilment\` | Receive/delete/change visibility on **its** queue, \`dynamodb:UpdateItem\` on the table, \`GetSecretValue\` on **its** secret, \`kms:Decrypt\` via Secrets Manager, logs | \`PutItem\`, \`Scan\`, other queues, the DLQ, other secrets |

The managed policy \`AWSLambdaSQSQueueExecutionRole\` would also make the event source mapping work, but it grants those SQS actions on \`Resource: "*"\`. Inline, resource-scoped statements are a few more lines and a lot less blast radius.

## Known design trade-offs

- **The dual write.** The orders function writes DynamoDB, *then* publishes the event. If \`PutEvents\` fails after the write, the order sits in \`PLACED\` forever. Production fixes: publish from a **DynamoDB Stream** (via EventBridge Pipes) so the event is derived from the committed write (the transactional outbox pattern), or run a reconciliation job that re-publishes orders stuck in \`PLACED\` longer than N minutes. Both are worth the complexity for money-moving systems.
- **No API authentication.** Fine for a lab, a blocker in a readiness review. Add a JWT authorizer (Cognito or your IdP) or IAM auth, and stage-level throttling.
- **Explicit resource names** (\`orders-platform-orders\`) make the labs easy to follow, but they block CloudFormation replacements (a replacement needs a *new* name) and collide if you deploy the stack twice in one account. Production templates usually let CloudFormation generate names, or prefix with the stack name as this one does.

> **On real AWS:** you'd normally publish to a **custom event bus** (\`AWS::Events::EventBus\`) owned by the orders domain. In the emulator, \`AWS::Events::EventBus\` in CloudFormation reports \`CREATE_COMPLETE\` but no bus is created, so a rule on it fails with "Event bus … does not exist". This template uses the default bus instead; the rule, queue policy and IAM scoping are otherwise identical.
`,
    },
    {
      id: "readiness",
      kind: "reading",
      title: "Operational readiness review",
      minutes: 12,
      body: String.raw`
An **operational readiness review (ORR)** is the checklist a service passes before it takes production traffic, and again after major changes. It isn't paperwork: each item exists because some team once got paged at 3 a.m. without it. Run it against the platform you're about to deploy, and be honest about which boxes are empty.

## Observability and alarms

| Check | For this platform | Why |
|---|---|---|
| Every async path has a DLQ **and** an alarm on it | \`dlq-not-empty\`: \`ApproximateNumberOfMessagesVisible > 0\` | A DLQ nobody watches is a slow data-loss bug |
| Alarm on **age**, not just depth | \`ApproximateAgeOfOldestMessage\` on the main queue above a few minutes | A stuck consumer shows as age climbing while depth looks "normal" |
| Errors and throttles on every function | \`Errors\`, \`Throttles\` per function, as rates where traffic varies | Throttling at the account concurrency limit fails silently from the caller's side |
| The customer's view | API \`5xx\` rate and p99 latency | Internal metrics can be green while users see errors |
| Alarms notify a human and say what to do | SNS → pager, \`AlarmDescription\` starts with the runbook | The person paged at night didn't build the system |
| \`TreatMissingData\` chosen deliberately | \`notBreaching\` for counts like DLQ depth | Default \`missing\` leaves alarms in \`INSUFFICIENT_DATA\`, which never pages |
| Structured logs with correlation IDs | JSON lines with \`orderId\` and \`messageId\` | \`filter-log-events\` / Logs Insights can find one order in seconds |

## Runbooks and redrive

Every alarm links to a runbook with: what it means, how to assess impact, the likely causes, the commands to diagnose, how to mitigate, and how to verify. For this platform the critical one is **DLQ redrive**:

\`\`\`text
# 1. How bad is it?
aws sqs get-queue-attributes --queue-url "$DLQ" --attribute-names ApproximateNumberOfMessages
# 2. Why? Errors in the worker's logs, then peek at a message without hiding it
aws logs filter-log-events --log-group-name /aws/lambda/orders-platform-fulfilment --filter-pattern ERROR
aws sqs receive-message --queue-url "$DLQ" --visibility-timeout 0 --attribute-names All
# 3. Fix the cause (code, config or data). 4. Move messages back, rate-limited
aws sqs start-message-move-task --source-arn "$DLQ_ARN" --max-number-of-messages-per-second 10
aws sqs list-message-move-tasks --source-arn "$DLQ_ARN"
\`\`\`

Rules: **never purge a DLQ** as a fix (those are customer orders), **never redrive before the fix** (messages just come back, and you've hidden the signal), and **rate-limit the redrive** so a backlog of thousands doesn't overwhelm the consumer or its dependencies.

## Data protection and backups

| Check | For this platform |
|---|---|
| Point-in-time recovery on stateful stores | \`PointInTimeRecoverySpecification\` on the table (35 days of restore points) |
| Stateful resources survive stack mistakes | Production: \`DeletionPolicy: Retain\` and \`UpdateReplacePolicy: Retain\` on the table, plus \`DeletionProtectionEnabled: true\` (left off here so the lab can tear down) |
| A *tested* restore | Restore to a new table in staging once a quarter and time it. An untested backup is a hope, not a plan |
| Encryption at rest with keys you control where it matters | CMK on the config secret, key rotation on |

## Least privilege and security

- One role per function, no \`*\` actions or resources, resource policies with \`aws:SourceArn\` conditions (queue policy, Lambda permission).
- No secrets in environment variables or templates. (The demo secret value in this template is a placeholder; real secrets are set out of band with \`put-secret-value\` or generated with \`GenerateSecretString\`, and rotated.)
- The deploy role (from the CI/CD module) can create these roles only with a permissions boundary.
- API authentication and throttling (see "known trade-offs" in the brief).
- IAM Access Analyzer finds anything shared outside the account; the emulator can't, so do it in the real account.

## Tagging and cost

Tag the stack (\`aws cloudformation deploy --tags app=orders-platform owner=platform-team cost-center=cc-1234\`), and CloudFormation propagates the tags to every resource that supports them. Activate them as **cost allocation tags** in Billing, or they won't appear in Cost Explorer.

What this platform costs at rest and per order (us-east-1, list prices, order of magnitude):

| Item | Fixed | Per million orders |
|---|---|---|
| KMS customer-managed key | ~$1/month | Decrypts are cached per environment: pennies |
| Secrets Manager secret | ~$0.40/month | ~$0.05 per 10k API calls, cached so negligible |
| HTTP API | none | ~$1 |
| Lambda (2 short invocations) | none | a few dollars at 128 MB |
| EventBridge custom events | none | ~$1 |
| SQS (send, receive, delete) | none | well under $2 |
| DynamoDB on-demand (1 write + 1 update) | storage | a few dollars |
| CloudWatch Logs | retention-driven | often the **largest** line: set retention, log JSON, don't log payloads |

Serverless costs scale with use; the traps are the always-on and the unbounded: log retention, NAT gateways (not used here), and alarms or dashboards multiplied across hundreds of resources.

## Deploy safety

- Changes go through the pipeline: lint, emulator integration test, staging, prod.
- Callers use Lambda **aliases** so a bad version can be canaried and rolled back (module 13). The capstone template omits aliases to stay readable; a production version would add \`AWS::Lambda::Version\` + \`AWS::Lambda::Alias\` with CodeDeploy, or SAM's \`AutoPublishAlias\`.
- Event schemas are versioned and consumers are **tolerant readers**, which you're about to need.

## Capacity and limits

- Lambda concurrency is an account-wide pool (1,000 by default per region). Set \`MaximumConcurrency\` on the event source mapping so a backlog can't starve the API's function.
- DynamoDB on-demand absorbs spikes up to double the previous peak instantly; beyond that, throttling. Know your peak.
- SQS standard queues have practically unlimited throughput; FIFO queues don't, and they block a message group behind a failing message, which turns a poison message into an outage for that group.
`,
    },
    {
      id: "game-day",
      kind: "reading",
      title: "Game day: a poison message in the DLQ",
      minutes: 10,
      body: String.raw`
A **game day** is a rehearsed incident. You break something on purpose, in a safe environment, and practise detecting, diagnosing and fixing it with the real tools and runbooks. Teams that run them find broken alarms, missing permissions for on-call, and runbook steps that no longer work *before* an outage does.

## Running one

- **Roles:** an *incident commander* (decides, keeps time, doesn't type), an *operator* (runs commands), a *scribe* (timestamps every observation and action). In a solo lab you're all three; keep notes anyway.
- **Rules:** use only the runbook, the logs and the APIs that on-call would have. No reading the source of the fault injection.
- **Exit criteria:** service restored, data intact, every DLQ message accounted for.
- **Afterwards:** a short, blameless review: what was slow to find, what was missing, which action items prevent it next time.

## The scenario

A legacy checkout service, retired "soon" for the last two years, still publishes \`OrderPlaced\` events. Its events use the **v1 schema**: \`order_id\` instead of \`orderId\`. The fulfilment worker reads \`detail["orderId"]\`, raises \`KeyError\`, reports the message as a batch item failure, and SQS retries it. After three receives, the message lands in the DLQ and the alarm pages you.

Nothing is "down": new orders from the main checkout flow are fulfilled normally. One customer's order is stuck in \`PLACED\`, and the longer nobody notices, the more of them pile up.

## The timeline you're aiming for

<figure class="diagram">
<svg viewBox="0 0 640 150" role="img" aria-label="Incident timeline: page, triage, diagnose, fix, redrive, verify">
  <path d="M20 70 H620" class="d-arrow"/>
  <rect x="20" y="40" width="80" height="60" rx="8" class="d-box d-danger"/><text x="60" y="66" text-anchor="middle" class="d-label">Page</text><text x="60" y="84" text-anchor="middle" class="d-small">alarm → SNS</text>
  <rect x="120" y="40" width="80" height="60" rx="8" class="d-box"/><text x="160" y="66" text-anchor="middle" class="d-label">Triage</text><text x="160" y="84" text-anchor="middle" class="d-small">how many?</text>
  <rect x="220" y="40" width="90" height="60" rx="8" class="d-box"/><text x="265" y="66" text-anchor="middle" class="d-label">Diagnose</text><text x="265" y="84" text-anchor="middle" class="d-small">logs + peek</text>
  <rect x="330" y="40" width="80" height="60" rx="8" class="d-box d-accent"/><text x="370" y="66" text-anchor="middle" class="d-label">Fix</text><text x="370" y="84" text-anchor="middle" class="d-small">ship code</text>
  <rect x="430" y="40" width="80" height="60" rx="8" class="d-box d-accent"/><text x="470" y="66" text-anchor="middle" class="d-label">Redrive</text><text x="470" y="84" text-anchor="middle" class="d-small">move task</text>
  <rect x="530" y="40" width="90" height="60" rx="8" class="d-box d-ok"/><text x="575" y="66" text-anchor="middle" class="d-label">Verify</text><text x="575" y="84" text-anchor="middle" class="d-small">DLQ 0, FULFILLED</text>
  <text x="320" y="130" text-anchor="middle" class="d-small">Fix before redrive. Redriving first just sends the message back to the DLQ.</text>
</svg>
<figcaption>Each step has a command in the runbook. The order matters.</figcaption>
</figure>

## Diagnosis techniques

**Read the logs first.** The worker logs structured JSON for every failure:

\`\`\`text
aws logs filter-log-events --log-group-name /aws/lambda/gameday-platform-fulfilment \
  --filter-pattern ERROR --query 'events[].message' --output text
\`\`\`

The \`error\` field (\`KeyError('orderId')\`) and the \`messageId\` tell you *what* failed and *which* message.

**Then peek at the message without taking it.** A normal \`receive-message\` hides the message for the queue's visibility timeout (30 seconds by default on the DLQ). If you then start a redrive, that hidden message isn't moved. Peek with a zero visibility timeout:

\`\`\`text
aws sqs receive-message --queue-url "$DLQ" --visibility-timeout 0 \
  --attribute-names All --query 'Messages[].{body: Body, attrs: Attributes}'
\`\`\`

Useful attributes: \`ApproximateReceiveCount\` (how many tries), \`DeadLetterQueueSourceArn\` (which queue it came from: redrive sends it back there), \`SentTimestamp\` (when the problem started). The body is the EventBridge envelope; the \`detail\` shows the v1 schema.

**Check the blast radius.** How many messages are in the DLQ? Are new orders still being fulfilled? (A quick scan for \`status = PLACED\` on a small table, or a metric on a large one.) This tells the incident commander whether it's one customer or everyone.

## Choosing the fix

| Option | When | Risk |
|---|---|---|
| **Fix the consumer** (accept both \`orderId\` and \`order_id\`) | The message is valid business data in a shape you should support | Low: a tolerant reader is the right long-term contract anyway |
| Fix the producer | The producer is yours and quick to change | Doesn't help messages already in the DLQ |
| Transform and re-send the messages | One-off bad data | Hand-crafted messages bypass validation; script it, review it |
| Discard | The data is truly junk (test traffic) | You must be sure. Archive the bodies first |

Here the order is real and the legacy producer won't change this week, so **fix the consumer**. The change is one line:

\`\`\`text
order_id = detail.get("orderId") or detail["order_id"]
\`\`\`

Ship it the way every change ships: in the template, through the pipeline. During an incident, a hotfix with \`update-function-code\` is acceptable **only if the same change is in the template** before you stand down; otherwise the next deploy silently reverts it and the incident comes back. The lab's packaging script builds the hotfix *from the template* for exactly this reason.

## Redrive and verify

\`start-message-move-task\` moves messages from the DLQ back to the queue they came from (\`DeadLetterQueueSourceArn\`), optionally rate-limited with \`--max-number-of-messages-per-second\`. \`list-message-move-tasks\` shows progress; \`cancel-message-move-task\` stops it. Then verify the outcome, not the action: the DLQ is empty, the source queue drained, and the affected order is \`FULFILLED\`.

## The review

Good action items from this scenario: contract tests between producers and consumers (or a schema registry), an alarm on \`ApproximateAgeOfOldestMessage\`, a dashboard of orders stuck in \`PLACED\`, and a date for retiring the legacy producer. "Be more careful" isn't an action item.
`,
    },
    {
      id: "ship-platform",
      kind: "lab",
      title: "Lab: deploy the platform and prove the flow",
      minutes: 45,
      body: String.raw`
The lab folder contains \`platform.yaml\`: a working skeleton with the config, table, queues, both functions and the HTTP API already written. Five \`# TODO\` blocks are yours. Finish them, deploy the stack \`orders-platform\`, and prove an order goes from HTTP to \`FULFILLED\`.

## Deploy

\`\`\`text
aws cloudformation deploy --stack-name orders-platform --template-file platform.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --tags app=orders-platform owner=platform-team cost-center=cc-1234
\`\`\`

If it fails, read the first \`FAILED\` event; the rest are usually consequences:

\`\`\`text
aws cloudformation describe-stack-events --stack-name orders-platform \
  --query 'StackEvents[?contains(ResourceStatus, \`FAILED\`)].[LogicalResourceId,ResourceStatusReason]' --output text
\`\`\`

> **Emulator gap: finish all five TODOs before your first deploy.** The emulator can't currently *update* a stack that already contains an SQS event source mapping: it tries to replace the mapping and conflicts with the existing one (\`ResourceConflict … event source mapping … already exists\`), then rolls back. Creating the stack works, and adding the mapping in an update works. If you need to change the stack after the mapping exists, delete it and deploy again:
> \`aws cloudformation delete-stack --stack-name orders-platform && aws cloudformation wait stack-delete-complete --stack-name orders-platform\`.
> On real AWS, updates leave the mapping alone unless its properties change.

## Prove it end to end

Get the API ID from the stack outputs, then POST an order through the emulator endpoint with the API's \`Host\` header, and save the response. A deployment pipeline's smoke test should first wait for the functions to be active, and retry a few times on a 5xx, because \`CREATE_COMPLETE\` doesn't mean "ready to serve":

\`\`\`text
aws lambda wait function-active-v2 --function-name orders-platform-orders-api
aws lambda wait function-active-v2 --function-name orders-platform-fulfilment
API=$(aws cloudformation describe-stacks --stack-name orders-platform \
  --query "Stacks[0].Outputs[?OutputKey=='ApiId'].OutputValue" --output text)
curl -sS --retry 4 --retry-delay 2 --cacert "$AWS_CA_BUNDLE" -X POST -H "Host: $API.execute-api.us-east-1.amazonaws.com" \
  -H 'content-type: application/json' -d '{"items":[{"sku":"BOOK-1","qty":2}]}' \
  "$AWS_ENDPOINT_URL/orders" | tee order.json
\`\`\`

(The course terminal also has \`apicall <api-id> /orders\` for GETs; use curl for the POST.) Then watch the order change from \`PLACED\` to \`FULFILLED\` within a few seconds:

\`\`\`text
aws dynamodb get-item --table-name orders-platform-orders \
  --key "{\"orderId\":{\"S\":\"$(jq -r .orderId order.json)\"}}"
\`\`\`

If it stays \`PLACED\`, follow the message: is it in the queue (rule and queue policy)? Is the mapping enabled? What does \`/aws/lambda/orders-platform-fulfilment\` say (permissions)?
`,
      lab: {
        files: { "platform.yaml": SKELETON_TEMPLATE },
        tasks: [
          {
            id: "deployed",
            title: "Deploy the stack with ownership tags",
            description:
              "Deploy `platform.yaml` as the stack `orders-platform` (it creates named IAM roles, so it needs `CAPABILITY_NAMED_IAM`), tagged `app=orders-platform`, `owner=<your team>` and `cost-center=<anything>`.",
            hints: [
              "`aws cloudformation deploy --stack-name orders-platform --template-file platform.yaml --capabilities CAPABILITY_NAMED_IAM --tags app=orders-platform owner=platform-team cost-center=cc-1234`",
              "Stack tags propagate to the resources, which is what makes cost allocation work.",
            ],
            check: async (ctx) => {
              const p = await stackProblem(ctx, "orders-platform");
              if (p) return p;
              const s = (await ctx.aws(["cloudformation", "describe-stacks", "--stack-name", "orders-platform"])).Stacks[0];
              const tags = Object.fromEntries((s.Tags ?? []).map((t: any) => [t.Key, t.Value]));
              if (tags.app !== "orders-platform") return `Stack tag \`app\` is ${JSON.stringify(tags.app)}; expected \`orders-platform\`. Pass \`--tags\` to \`cloudformation deploy\`.`;
              for (const k of ["owner", "cost-center"]) if (!tags[k]) return `The stack has no \`${k}\` tag.`;
              return true;
            },
          },
          {
            id: "routing",
            title: "Route OrderPlaced events to the queue (TODO 2)",
            description:
              "In the template, add the rule `orders-platform-order-placed` on the default bus (pattern: `source` `acme.orders`, `detail-type` `OrderPlaced`) targeting the fulfilment queue, and a queue policy that lets `events.amazonaws.com` send to it **only** from that rule (`aws:SourceArn`).",
            hints: [
              "Rule: `Type: AWS::Events::Rule` with `EventBusName: default`, `EventPattern`, and `Targets: [{Id: fulfilment-queue, Arn: !GetAtt FulfilmentQueue.Arn}]`.",
              "Queue policy: `Type: AWS::SQS::QueuePolicy`, `Queues: [!Ref FulfilmentQueue]`, and a statement with `Principal: {Service: events.amazonaws.com}`, `Action: sqs:SendMessage`, `Condition: {ArnEquals: {\"aws:SourceArn\": !GetAtt OrderPlacedRule.Arn}}`.",
            ],
            check: async (ctx) => {
              const p = await stackProblem(ctx, "orders-platform");
              if (p) return p;
              const types = await stackTypes(ctx, "orders-platform");
              if (!types.includes("AWS::Events::Rule")) return "The stack has no `AWS::Events::Rule`. Define the rule in platform.yaml, not with the CLI.";
              if (!types.includes("AWS::SQS::QueuePolicy")) return "The stack has no `AWS::SQS::QueuePolicy`.";
              const r = await ctx.tryAws(["events", "describe-rule", "--name", "orders-platform-order-placed"]);
              if (!r.ok) return "No rule named `orders-platform-order-placed` on the default bus.";
              const pat = JSON.parse(r.data.EventPattern ?? "{}");
              if (!asList(pat.source).includes("acme.orders") || !asList(pat["detail-type"]).includes("OrderPlaced"))
                return `The rule's pattern is ${r.data.EventPattern}; it should match source acme.orders and detail-type OrderPlaced.`;
              const qArn = `arn:aws:sqs:${ctx.region}:${ctx.account}:orders-platform-fulfilment`;
              const t = await ctx.aws(["events", "list-targets-by-rule", "--rule", "orders-platform-order-placed"]);
              if (!(t.Targets ?? []).some((x: any) => x.Arn === qArn)) return "The rule doesn't target the `orders-platform-fulfilment` queue.";
              const q = await queue(ctx, "orders-platform-fulfilment");
              if (!q?.attrs.Policy) return "The fulfilment queue has no queue policy, so EventBridge can't deliver to it.";
              const pol = JSON.parse(q.attrs.Policy);
              const ok = asList(pol.Statement).some((s: any) => {
                const svc = asList(s.Principal?.Service);
                const cond = s.Condition ?? {};
                const src = ["ArnEquals", "ArnLike", "StringEquals"].map((op) => cond[op]?.["aws:SourceArn"]).find(Boolean);
                return s.Effect === "Allow" && svc.includes("events.amazonaws.com") && asList(s.Action).includes("sqs:SendMessage") && src === r.data.Arn;
              });
              if (!ok)
                return `The queue policy must allow events.amazonaws.com sqs:SendMessage with an aws:SourceArn condition equal to the rule ARN (${r.data.Arn}).`;
              return true;
            },
          },
          {
            id: "worker",
            title: "Consume with retries, a DLQ and partial batch failures (TODOs 1 and 4)",
            description:
              "Give the fulfilment queue a redrive policy to `orders-platform-fulfilment-dlq` with `maxReceiveCount` **3**, and add an event source mapping from the queue to `orders-platform-fulfilment` with `ReportBatchItemFailures`. Keep the queue's visibility timeout at least 6× the function timeout.",
            hints: [
              "`RedrivePolicy: {deadLetterTargetArn: !GetAtt FulfilmentDLQ.Arn, maxReceiveCount: 3}` under the queue's `Properties`.",
              "`Type: AWS::Lambda::EventSourceMapping` with `FunctionName: !Ref FulfilmentFunction`, `EventSourceArn: !GetAtt FulfilmentQueue.Arn`, `BatchSize: 10`, `FunctionResponseTypes: [ReportBatchItemFailures]`.",
            ],
            check: async (ctx) => {
              const p = await stackProblem(ctx, "orders-platform");
              if (p) return p;
              const q = await queue(ctx, "orders-platform-fulfilment");
              if (!q) return "Queue `orders-platform-fulfilment` doesn't exist.";
              if (!q.attrs.RedrivePolicy) return "The fulfilment queue has no RedrivePolicy, so a poison message would retry until it expires.";
              const rp = JSON.parse(q.attrs.RedrivePolicy);
              const dlqArn = `arn:aws:sqs:${ctx.region}:${ctx.account}:orders-platform-fulfilment-dlq`;
              if (rp.deadLetterTargetArn !== dlqArn) return `The redrive target is ${rp.deadLetterTargetArn}; expected ${dlqArn}.`;
              if (Number(rp.maxReceiveCount) !== 3) return `maxReceiveCount is ${rp.maxReceiveCount}; expected 3.`;
              const types = await stackTypes(ctx, "orders-platform");
              if (!types.includes("AWS::Lambda::EventSourceMapping")) return "The stack has no `AWS::Lambda::EventSourceMapping`. Define it in platform.yaml.";
              const m = await ctx.aws(["lambda", "list-event-source-mappings", "--function-name", "orders-platform-fulfilment"]);
              const esm = (m.EventSourceMappings ?? []).find((x: any) => x.EventSourceArn === q.attrs.QueueArn);
              if (!esm) return "No event source mapping from the fulfilment queue to `orders-platform-fulfilment`.";
              if (esm.State !== "Enabled") return `The mapping is ${esm.State}; it should be Enabled.`;
              if (!asList(esm.FunctionResponseTypes).includes("ReportBatchItemFailures"))
                return "The mapping doesn't use `ReportBatchItemFailures`. Without it, one bad message makes the whole batch retry.";
              const fn = await ctx.aws(["lambda", "get-function-configuration", "--function-name", "orders-platform-fulfilment"]);
              if (Number(q.attrs.VisibilityTimeout) < 6 * fn.Timeout)
                return `Visibility timeout ${q.attrs.VisibilityTimeout}s is less than 6× the function timeout (${fn.Timeout}s).`;
              return true;
            },
          },
          {
            id: "least-privilege",
            title: "Least privilege for the worker (TODO 3)",
            description: String.raw`Give the worker's role (\`orders-platform-fulfilment\`) an inline policy with only what it needs. The checks simulate it:

- **allowed:** \`sqs:ReceiveMessage\`/\`DeleteMessage\`/\`GetQueueAttributes\` on the fulfilment queue, \`dynamodb:UpdateItem\` on the table, \`secretsmanager:GetSecretValue\` on the config secret, \`kms:Decrypt\` on the config key *when called via Secrets Manager*
- **denied:** receiving from any other queue, \`dynamodb:PutItem\` and \`dynamodb:Scan\`, \`kms:Decrypt\` called directly`,
            hints: [
              "Don't attach `AWSLambdaSQSQueueExecutionRole`: it grants SQS actions on every queue (`Resource: \"*\"`).",
              "Use `!GetAtt FulfilmentQueue.Arn`, `!GetAtt OrdersTable.Arn`, `!Ref FulfilmentConfig` (a secret's Ref is its ARN) and `!GetAtt ConfigKey.Arn` as resources.",
              "For KMS: `Condition: {StringEquals: {\"kms:ViaService\": !Sub \"secretsmanager.${AWS::Region}.amazonaws.com\"}}`.",
            ],
            check: async (ctx) => {
              const p = await stackProblem(ctx, "orders-platform");
              if (p) return p;
              const role = "orders-platform-fulfilment";
              const queueArn = `arn:aws:sqs:${ctx.region}:${ctx.account}:orders-platform-fulfilment`;
              const table = `arn:aws:dynamodb:${ctx.region}:${ctx.account}:table/orders-platform-orders`;
              const sec = await ctx.tryAws(["secretsmanager", "describe-secret", "--secret-id", "orders-platform/fulfilment-config"]);
              if (!sec.ok) return "Secret `orders-platform/fulfilment-config` doesn't exist.";
              const key = await ctx.tryAws(["kms", "describe-key", "--key-id", "alias/orders-platform-config"]);
              if (!key.ok) return "KMS alias `alias/orders-platform-config` doesn't exist.";
              const keyArn = key.data.KeyMetadata.Arn;
              const via = `ContextKeyName=kms:ViaService,ContextKeyValues=secretsmanager.${ctx.region}.amazonaws.com,ContextKeyType=string`;
              const allow: [string, string, string?][] = [
                ["sqs:ReceiveMessage", queueArn],
                ["sqs:DeleteMessage", queueArn],
                ["sqs:GetQueueAttributes", queueArn],
                ["dynamodb:UpdateItem", table],
                ["secretsmanager:GetSecretValue", sec.data.ARN],
                ["kms:Decrypt", keyArn, via],
              ];
              for (const [act, res, c] of allow) {
                const d = await decide(ctx, role, act, res, c);
                if (d !== "allowed") return `\`${act}\` on \`${res}\`${c ? " (via Secrets Manager)" : ""} is ${d}; the worker needs it.`;
              }
              const deny: [string, string, string?][] = [
                ["sqs:ReceiveMessage", `arn:aws:sqs:${ctx.region}:${ctx.account}:some-other-queue`],
                ["dynamodb:PutItem", table],
                ["dynamodb:Scan", table],
                ["kms:Decrypt", keyArn],
              ];
              for (const [act, res, c] of deny) {
                const d = await decide(ctx, role, act, res, c);
                if (d === "allowed")
                  return `\`${act}\` on \`${res}\`${act === "kms:Decrypt" ? " called directly (not via Secrets Manager)" : ""} is allowed; the worker shouldn't be able to do that.`;
              }
              return true;
            },
          },
          {
            id: "alarm",
            title: "Page on a non-empty DLQ (TODO 5)",
            description:
              "Add an SNS topic `orders-platform-alerts` and an alarm `orders-platform-dlq-not-empty` on `AWS/SQS` `ApproximateNumberOfMessagesVisible` for the DLQ (dimension `QueueName`), firing as soon as **one** message is there, with missing data treated as not breaching, and the topic as its alarm action.",
            hints: [
              "`Threshold: 0` with `ComparisonOperator: GreaterThanThreshold`, `Statistic: Maximum`, `Period: 60`, `EvaluationPeriods: 1`.",
              "`Dimensions: [{Name: QueueName, Value: !GetAtt FulfilmentDLQ.QueueName}]`, `AlarmActions: [!Ref AlertsTopic]`, `TreatMissingData: notBreaching`.",
            ],
            check: async (ctx) => {
              const p = await stackProblem(ctx, "orders-platform");
              if (p) return p;
              const types = await stackTypes(ctx, "orders-platform");
              if (!types.includes("AWS::CloudWatch::Alarm") || !types.includes("AWS::SNS::Topic")) return "The stack needs an `AWS::SNS::Topic` and an `AWS::CloudWatch::Alarm`.";
              const r = await ctx.tryAws(["cloudwatch", "describe-alarms", "--alarm-names", "orders-platform-dlq-not-empty"]);
              const al = r.data?.MetricAlarms?.[0];
              if (!al) return "Alarm `orders-platform-dlq-not-empty` doesn't exist.";
              if (al.Namespace !== "AWS/SQS" || al.MetricName !== "ApproximateNumberOfMessagesVisible")
                return `The alarm watches ${al.Namespace}/${al.MetricName}; expected AWS/SQS/ApproximateNumberOfMessagesVisible.`;
              const d = Object.fromEntries((al.Dimensions ?? []).map((x: any) => [x.Name, x.Value]));
              if (d.QueueName !== "orders-platform-fulfilment-dlq") return `Dimension QueueName is ${JSON.stringify(d.QueueName)}; it should be the DLQ, \`orders-platform-fulfilment-dlq\`.`;
              const fires1 =
                (al.ComparisonOperator === "GreaterThanThreshold" && al.Threshold >= 0 && al.Threshold < 1) ||
                (al.ComparisonOperator === "GreaterThanOrEqualToThreshold" && al.Threshold > 0 && al.Threshold <= 1);
              if (!fires1) return `The alarm is ${al.ComparisonOperator} ${al.Threshold}; it should fire on the first message.`;
              if (al.TreatMissingData !== "notBreaching") return `TreatMissingData is ${al.TreatMissingData ?? "missing"}; use notBreaching.`;
              const topic = `arn:aws:sns:${ctx.region}:${ctx.account}:orders-platform-alerts`;
              if (!asList(al.AlarmActions).includes(topic)) return `The alarm's actions are ${JSON.stringify(al.AlarmActions)}; it should notify ${topic}.`;
              return true;
            },
          },
          {
            id: "end-to-end",
            title: "Prove an order is fulfilled end to end",
            description:
              "POST an order (`{\"items\":[{\"sku\":\"BOOK-1\",\"qty\":2}]}`) to the API's `/orders` route, save the response to `order.json`, and wait until that order reaches status `FULFILLED`, with the warehouse from the encrypted config (`EU-1`).",
            hints: [
              "Get the API ID from the stack's `ApiId` output; see the curl command in the lab notes above.",
              "If the order stays `PLACED`, check, in order: messages in the queue, the mapping's State, and `aws logs filter-log-events --log-group-name /aws/lambda/orders-platform-fulfilment`.",
            ],
            check: async (ctx) => {
              const f = await ctx.readFile("order.json");
              if (f === null) return "`order.json` not found. Save the API's response to it.";
              let id: string | undefined;
              try {
                id = JSON.parse(f).orderId;
              } catch {
                return "`order.json` isn't the JSON response from the API.";
              }
              if (!id) return "`order.json` has no `orderId`. Did the API return an error?";
              const item = await orderItem(ctx, "orders-platform-orders", id);
              if (!item) return `Order ${id} isn't in \`orders-platform-orders\`.`;
              const st = item.status?.S;
              if (st !== "FULFILLED") return `Order ${id} is ${st}. Follow the message: queue → mapping → worker logs.`;
              if (item.warehouse?.S !== "EU-1") return `Order ${id} was fulfilled from warehouse ${item.warehouse?.S}; expected EU-1 from the config secret.`;
              return true;
            },
          },
        ],
        solution:
          String.raw`
cat > platform.yaml <<'EOF'
` +
          FULL_TEMPLATE +
          String.raw`EOF

aws cloudformation deploy --stack-name orders-platform --template-file platform.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --tags app=orders-platform owner=platform-team cost-center=cc-1234

# Stack CREATE_COMPLETE doesn't promise the functions are warm: wait for them,
# then smoke-test with a bounded retry (curl retries 5xx responses).
aws lambda wait function-active-v2 --function-name orders-platform-orders-api
aws lambda wait function-active-v2 --function-name orders-platform-fulfilment
API=$(aws cloudformation describe-stacks --stack-name orders-platform \
  --query "Stacks[0].Outputs[?OutputKey=='ApiId'].OutputValue" --output text)
curl -sS --fail --retry 4 --retry-delay 2 --cacert "$AWS_CA_BUNDLE" -X POST -H "Host: $API.execute-api.us-east-1.amazonaws.com" \
  -H 'content-type: application/json' -d '{"items":[{"sku":"BOOK-1","qty":2}]}' \
  "$AWS_ENDPOINT_URL/orders" > order.json
cat order.json
ID=$(jq -r .orderId order.json)

# The flow after the API is asynchronous: poll for the outcome, with a timeout.
for _ in $(seq 60); do
  S=$(aws dynamodb get-item --table-name orders-platform-orders --key "{\"orderId\":{\"S\":\"$ID\"}}" \
        --query Item.status.S --output text)
  [ "$S" = FULFILLED ] && break
  sleep 1
done
echo "order $ID is $S"
[ "$S" = FULFILLED ]
`,
      },
    },
    {
      id: "incident-drill",
      kind: "lab",
      title: "Lab: game day — the poison message",
      minutes: 35,
      body: String.raw`
**Prepare lab** deploys the full platform as the stack \`gameday-platform\` (\`platform.yaml\` in this folder is exactly what's deployed), places a couple of normal orders, and lets the legacy checkout service publish one v1-schema event. Within a minute it fails three times, lands in the DLQ, and the alarm \`gameday-platform-dlq-not-empty\` pages you. Preparing takes about a minute and a half, because the message really is retried three times.

The page was delivered to an SQS queue standing in for your pager:

\`\`\`bash
aws sqs receive-message --queue-url "$(aws sqs get-queue-url --queue-name gameday-pager --query QueueUrl --output text)" \
  --query 'Messages[0].Body' --output text | jq -r .Subject
\`\`\`

Work it like a real incident: **triage, diagnose, fix, redrive, verify**. The game-day reading has the commands. Resource names all start with \`gameday-platform-\`.

## Shipping the fix

On real AWS you'd change the worker's code in \`platform.yaml\` and ship it through the pipeline with \`aws cloudformation deploy\`. The emulator can't currently update a stack that contains an SQS event source mapping (see the previous lab), so this drill uses the incident hotfix path, without drift:

1. Edit the \`FulfilmentFunction\` inline code in \`platform.yaml\`.
2. Run \`./package-fulfilment.sh\`. It builds \`build/fulfilment.zip\` **from the template**, so the hotfix is exactly what the next real deploy would ship.
3. \`aws lambda update-function-code --function-name gameday-platform-fulfilment --zip-file fileb://build/fulfilment.zip\`, then \`aws lambda wait function-updated-v2 --function-name gameday-platform-fulfilment\`.

> **On real AWS** the DLQ alarm stays in ALARM until the queue is empty. In the emulator, SQS depth metrics don't reliably reach CloudWatch in lab time, so setup raised the alarm with \`aws cloudwatch set-alarm-state\` (the standard way to test an alarm's actions), and it may return to OK on its own after a minute. Don't use the alarm state as your success signal; use the queues and the order.
`,
      lab: {
        files: { "platform.yaml": FULL_TEMPLATE, "package-fulfilment.sh": PACKAGE_SCRIPT },
        setup: String.raw`
S=gameday-platform
aws cloudformation deploy --stack-name $S --template-file platform.yaml --capabilities CAPABILITY_NAMED_IAM \
  --tags app=orders-platform env=gameday owner=platform-team cost-center=cc-1234 >/dev/null
mkdir -p .gameday
aws lambda get-function --function-name $S-fulfilment --query Configuration.CodeSha256 --output text > .gameday/baseline-sha256

# The pager: an SQS queue subscribed to the alerts topic.
TOPIC=$(aws cloudformation describe-stacks --stack-name $S --query "Stacks[0].Outputs[?OutputKey=='AlertsTopicArn'].OutputValue" --output text)
PQ=$(aws sqs create-queue --queue-name gameday-pager --query QueueUrl --output text)
PARN=$(aws sqs get-queue-attributes --queue-url "$PQ" --attribute-names QueueArn --query Attributes.QueueArn --output text)
POLICY=$(jq -nc --arg q "$PARN" --arg t "$TOPIC" '{Version:"2012-10-17",Statement:[{Effect:"Allow",Principal:{Service:"sns.amazonaws.com"},Action:"sqs:SendMessage",Resource:$q,Condition:{ArnEquals:{"aws:SourceArn":$t}}}]}')
aws sqs set-queue-attributes --queue-url "$PQ" --attributes "$(jq -nc --arg p "$POLICY" '{Policy:$p}')"
aws sns subscribe --topic-arn "$TOPIC" --protocol sqs --notification-endpoint "$PARN" >/dev/null

# Normal traffic from the main checkout.
aws lambda wait function-active-v2 --function-name $S-orders-api
aws lambda wait function-active-v2 --function-name $S-fulfilment
API=$(aws cloudformation describe-stacks --stack-name $S --query "Stacks[0].Outputs[?OutputKey=='ApiId'].OutputValue" --output text)
for sku in MUG-7 BOOK-1; do
  curl -sS --fail --retry 4 --retry-delay 2 --cacert "$AWS_CA_BUNDLE" -X POST -H "Host: $API.execute-api.us-east-1.amazonaws.com" \
    -H 'content-type: application/json' -d "{\"items\":[{\"sku\":\"$sku\",\"qty\":1}]}" "$AWS_ENDPOINT_URL/orders" >/dev/null
done

# The legacy checkout writes its order, then publishes a v1-schema event (order_id, not orderId).
aws dynamodb put-item --table-name $S-orders \
  --item '{"orderId":{"S":"legacy-1042"},"status":{"S":"PLACED"},"items":{"S":"[{\"sku\":\"LAMP-3\",\"qty\":1}]"}}'
aws events put-events --entries "$(jq -nc '[{Source:"acme.orders",DetailType:"OrderPlaced",Detail:({order_id:"legacy-1042",schemaVersion:1,items:[{sku:"LAMP-3",qty:1}]}|tojson)}]')" >/dev/null

DLQ=$(aws sqs get-queue-url --queue-name $S-fulfilment-dlq --query QueueUrl --output text)
for _ in $(seq 150); do
  N=$(aws sqs get-queue-attributes --queue-url "$DLQ" --attribute-names ApproximateNumberOfMessages --query Attributes.ApproximateNumberOfMessages --output text)
  [ "$N" = 1 ] && break
  sleep 1
done
[ "$N" = 1 ] || { echo "the poison message never reached the DLQ" >&2; exit 1; }
aws cloudwatch set-alarm-state --alarm-name $S-dlq-not-empty --state-value ALARM \
  --state-reason "Threshold Crossed: 1 datapoint [1.0] was greater than the threshold (0.0)."
`,
        tasks: [
          {
            id: "triage",
            title: "Find the stuck order",
            description:
              "Diagnose without destroying evidence: find out which order is stuck and why. Write the stuck order's ID (and nothing else) to `poison-order-id.txt`.",
            hints: [
              "Start with `aws logs filter-log-events --log-group-name /aws/lambda/gameday-platform-fulfilment --filter-pattern ERROR`.",
              "Peek at the DLQ with `aws sqs receive-message --queue-url <dlq-url> --visibility-timeout 0 --attribute-names All`, then look at the `detail` inside the body.",
              "`... --query 'Messages[0].Body' --output text | jq -r .detail.order_id > poison-order-id.txt`",
            ],
            check: async ({ readFile }) => {
              const f = await readFile("poison-order-id.txt");
              if (f === null) return "`poison-order-id.txt` not found.";
              if (f.trim() !== "legacy-1042") return `The file says \`${f.trim().slice(0, 60)}\`. That isn't the stuck order: look at the DLQ message's \`detail\`.`;
              return true;
            },
          },
          {
            id: "fix",
            title: "Ship a fix that accepts both schemas, without drift",
            description:
              "Make the worker accept both `orderId` (v2) and `order_id` (v1) by changing the `FulfilmentFunction` code **in `platform.yaml`**, then deploy that exact code to `gameday-platform-fulfilment` (use `./package-fulfilment.sh`). The check downloads the running code and compares it with the template.",
            hints: [
              "The one-line change: `order_id = detail.get(\"orderId\") or detail[\"order_id\"]`. Keep the YAML indentation (the code is indented 10 spaces).",
              "`./package-fulfilment.sh && aws lambda update-function-code --function-name gameday-platform-fulfilment --zip-file fileb://build/fulfilment.zip`",
              "Then `aws lambda wait function-updated-v2 --function-name gameday-platform-fulfilment`.",
            ],
            check: async (ctx) => {
              const base = (await ctx.readFile(".gameday/baseline-sha256"))?.trim();
              const cur = await ctx.tryAws(["lambda", "get-function", "--function-name", "gameday-platform-fulfilment"]);
              if (!cur.ok) return "Function `gameday-platform-fulfilment` doesn't exist. Press Prepare lab again.";
              if (base && cur.data.Configuration.CodeSha256 === base) return "The worker is still running the original code. Ship your fix.";
              if (cur.data.Configuration.LastUpdateStatus && cur.data.Configuration.LastUpdateStatus !== "Successful")
                return `The code update is ${cur.data.Configuration.LastUpdateStatus}. Wait for it with \`aws lambda wait function-updated-v2\`.`;
              const yaml = await ctx.readFile("platform.yaml");
              const tmpl = yaml && templateWorkerCode(yaml);
              if (!tmpl) return "Couldn't find the `FulfilmentFunction` inline code in platform.yaml. Keep the template's structure.";
              if (!/order_id/.test(tmpl)) return "The template's worker code doesn't handle `order_id` yet. Fix it in platform.yaml, so the next deploy doesn't revert you.";
              const live = await deployedWorkerCode(ctx, "gameday-platform-fulfilment");
              if (live === null) return "Couldn't download the running code, or it has no `index.py` at the root of the zip.";
              if (live !== tmpl)
                return "The running code differs from the code in platform.yaml (drift). Package from the template with `./package-fulfilment.sh` and deploy that zip.";
              return true;
            },
          },
          {
            id: "redrive",
            title: "Redrive the DLQ and verify",
            description:
              "Move the message back to its source queue, let the fixed worker process it, and verify the outcome: the DLQ and the fulfilment queue are both empty (nothing in flight either), and **every** order in `gameday-platform-orders`, including `legacy-1042`, is `FULFILLED`.",
            hints: [
              "If you received the message without `--visibility-timeout 0`, it's hidden for 30 seconds and won't move until it's visible again.",
              "`aws sqs start-message-move-task --source-arn arn:aws:sqs:us-east-1:000000000000:gameday-platform-fulfilment-dlq --max-number-of-messages-per-second 10`",
              "Check progress with `aws sqs list-message-move-tasks --source-arn …`, then the order with `aws dynamodb get-item`.",
            ],
            check: async (ctx) => {
              for (const name of ["gameday-platform-fulfilment-dlq", "gameday-platform-fulfilment"]) {
                const q = await queue(ctx, name);
                if (!q) return `Queue \`${name}\` doesn't exist. Press Prepare lab again.`;
                const vis = Number(q.attrs.ApproximateNumberOfMessages ?? 0);
                const inflight = Number(q.attrs.ApproximateNumberOfMessagesNotVisible ?? 0);
                if (vis + inflight > 0)
                  return `\`${name}\` still has ${vis} visible and ${inflight} in-flight message(s).${name.endsWith("dlq") ? " Fix first, then start a message move task." : " Wait for the worker, or check its logs."}`;
              }
              const scan = await ctx.aws(["dynamodb", "scan", "--table-name", "gameday-platform-orders"]);
              const items = scan.Items ?? [];
              const legacy = items.find((i: any) => i.orderId?.S === "legacy-1042");
              if (!legacy) return "Order `legacy-1042` is missing from the table. Was it deleted? Press Prepare lab to start over.";
              const notDone = items.filter((i: any) => i.status?.S !== "FULFILLED");
              if (notDone.length)
                return `Not fulfilled yet: ${notDone.map((i: any) => `${i.orderId?.S} (${i.status?.S})`).join(", ")}. If the DLQ is empty but the order isn't fulfilled, the message may have been deleted instead of redriven.`;
              return true;
            },
          },
        ],
        solution: String.raw`
S=gameday-platform
DLQ=$(aws sqs get-queue-url --queue-name $S-fulfilment-dlq --query QueueUrl --output text)
DLQ_ARN=$(aws sqs get-queue-attributes --queue-url "$DLQ" --attribute-names QueueArn --query Attributes.QueueArn --output text)

# Triage: the worker's errors, then peek at the DLQ without hiding the message.
aws logs filter-log-events --log-group-name /aws/lambda/$S-fulfilment --filter-pattern ERROR \
  --query 'events[].message' --output text | head -3
aws sqs receive-message --queue-url "$DLQ" --visibility-timeout 0 --attribute-names All \
  --query 'Messages[0].Body' --output text | jq -r .detail.order_id > poison-order-id.txt
cat poison-order-id.txt

# Fix in the template (tolerant reader), package from the template, ship.
sed -i 's/order_id = detail\["orderId"\]/order_id = detail.get("orderId") or detail["order_id"]/' platform.yaml
grep -q 'detail.get("orderId") or detail\["order_id"\]' platform.yaml
./package-fulfilment.sh
aws lambda update-function-code --function-name $S-fulfilment --zip-file fileb://build/fulfilment.zip >/dev/null
aws lambda wait function-updated-v2 --function-name $S-fulfilment

# Redrive, rate-limited, then verify the outcome.
aws sqs start-message-move-task --source-arn "$DLQ_ARN" --max-number-of-messages-per-second 10
for _ in $(seq 90); do
  ST=$(aws dynamodb get-item --table-name $S-orders --key '{"orderId":{"S":"legacy-1042"}}' --query Item.status.S --output text)
  read -r V H < <(aws sqs get-queue-attributes --queue-url "$DLQ" \
    --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible \
    --query '[Attributes.ApproximateNumberOfMessages, Attributes.ApproximateNumberOfMessagesNotVisible]' --output text)
  N=$((V + H))
  [ "$ST" = FULFILLED ] && [ "$N" = 0 ] && break
  sleep 1
done
aws sqs list-message-move-tasks --source-arn "$DLQ_ARN" --query 'Results[0].[Status,ApproximateNumberOfMessagesMoved]' --output text
echo "legacy-1042 is $ST, DLQ has $N"
[ "$ST" = FULFILLED ]
`,
      },
    },
  ],
  quiz: [
    {
      q: "The fulfilment worker's timeout is 30 seconds and the queue's visibility timeout is also 30 seconds. Under load you see orders fulfilled twice and occasional DLQ messages for orders that are actually FULFILLED. What's the fix?",
      options: [
        "Lower maxReceiveCount to 1",
        "Raise the queue's visibility timeout to at least 6× the function timeout (here, 180 s), and keep the worker idempotent",
        "Switch to a FIFO queue",
        "Increase the batch size to 100",
      ],
      answer: 1,
      explain:
        "Messages become visible again while a slow batch is still running (the poller also waits for the batch window and retries throttled invokes), so they're delivered twice and their receive count climbs. AWS recommends a visibility timeout of at least six times the function timeout for SQS event sources. Idempotent processing makes the remaining duplicates harmless.",
    },
    {
      q: "Your worker processes a batch of 10 messages and one of them always fails. Without `ReportBatchItemFailures`, what happens?",
      options: [
        "Only the failing message is retried",
        "The whole batch is retried, so the nine good messages are processed again and can eventually reach the DLQ with the bad one",
        "The failing message is deleted automatically",
        "Lambda splits the batch in half and retries each half",
      ],
      answer: 1,
      explain:
        "Without partial batch responses, an exception (or any failure) fails the entire batch: every message becomes visible again and its receive count increases. Good messages get reprocessed and can be dead-lettered alongside the poison one. Return `batchItemFailures` with only the failed message IDs. (Bisecting batches is a Kinesis/DynamoDB Streams feature, not SQS.)",
    },
    {
      q: "The DLQ alarm pages you. What should you do first with the messages in the DLQ?",
      options: [
        "Start a redrive immediately so customers are unblocked",
        "Purge the DLQ so the alarm clears",
        "Read the worker's error logs and peek at a message with `--visibility-timeout 0` to find the cause, then fix it before redriving",
        "Increase maxReceiveCount so messages stay in the main queue longer",
      ],
      answer: 2,
      explain:
        "Redriving before the fix just sends the messages through three more failures and back to the DLQ. Purging deletes customer data. Diagnose first, without hiding the messages (a normal receive makes them invisible, and a move task then skips them), fix, then redrive at a controlled rate.",
    },
    {
      q: "During the incident you hotfix the worker with `aws lambda update-function-code`. A week later an unrelated template change is deployed, and the poison-message errors come back. Why?",
      options: [
        "Lambda reverts code updates after seven days",
        "The deploy re-applied the template's code, which never received the fix: the hotfix was drift",
        "The DLQ redrive policy expired",
        "CloudFormation always redeploys every function from scratch",
      ],
      answer: 1,
      explain:
        "CloudFormation deploys what the template says. A change made out of band is drift and gets overwritten the next time that resource is updated. Every hotfix must land in the source of truth before the incident is closed; packaging the hotfix from the template, as the lab does, makes that automatic.",
    },
    {
      q: "Why does the fulfilment role's `kms:Decrypt` statement have the condition `kms:ViaService = secretsmanager.us-east-1.amazonaws.com`?",
      options: [
        "Secrets Manager requires it to read any secret",
        "It limits the permission to decryption that Secrets Manager performs on the role's behalf, so the role can't call KMS directly to decrypt other data encrypted with that key",
        "It enables automatic key rotation",
        "It makes decryption faster by routing through Secrets Manager",
      ],
      answer: 1,
      explain:
        "When Secrets Manager decrypts a secret for a caller, it calls KMS with the caller's permissions and sets `kms:ViaService`. The condition means the grant only works in that path. A compromised function can read its own secret, but can't use the key as a general-purpose decryption oracle.",
    },
    {
      q: "The orders function writes the order to DynamoDB and then calls `PutEvents`. In production, a small number of orders stay in PLACED forever with nothing in any DLQ. What's the most likely cause and a robust fix?",
      options: [
        "The DLQ's retention is too short; raise it to 14 days",
        "The dual write: `PutEvents` failed (or the function timed out) after the DynamoDB write. Derive the event from a DynamoDB Stream (EventBridge Pipes / outbox) or add a reconciliation job",
        "EventBridge drops 1% of events by design",
        "The fulfilment queue policy is missing",
      ],
      answer: 1,
      explain:
        "Two writes to two systems can't be atomic. If the second one fails, there's no message to retry and no DLQ entry: the order is silently orphaned. Publishing from the table's change stream makes the event a consequence of the committed write (the transactional outbox pattern). A reconciliation sweep is the cheaper safety net.",
    },
    {
      q: "Which item would an operational readiness review flag as a blocker for this capstone platform as written?",
      options: [
        "The table uses on-demand billing",
        "The HTTP API has no authentication or throttling",
        "Each function has its own IAM role",
        "Log groups have 14-day retention",
      ],
      answer: 1,
      explain:
        "Anyone who can reach the API can create orders, and nothing limits the rate. A JWT or IAM authorizer and stage throttling are table stakes for a production API. The other items are deliberate, good choices.",
    },
  ],
};
