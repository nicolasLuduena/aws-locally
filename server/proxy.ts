// An HTTP reverse proxy in front of the emulator. The learner's terminal points
// AWS_ENDPOINT_URL here, so every API call made by the CLI, Terraform or an SDK
// is recorded and shown in the UI's API inspector, then forwarded unchanged.
// The Host header is preserved, so SigV4 signatures still verify.

import { EventEmitter } from "node:events";
import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";

export interface ApiCall {
  id: number;
  time: number;
  durationMs: number;
  method: string;
  path: string;
  host: string;
  service: string;
  operation: string;
  status: number;
  errorCode: string;
  protocol: string;
  mutating: boolean;
  reqHeaders: Record<string, string>;
  reqBody: string;
  resHeaders: Record<string, string>;
  resBody: string;
}

const BODY_LIMIT = 16 * 1024;

export class InspectorProxy extends EventEmitter {
  private server: http.Server;
  private seq = 0;
  readonly calls: ApiCall[] = [];

  private listenPort: number;
  private target: { port: number; caFile: () => string };

  constructor(listenPort: number, target: { port: number; caFile: () => string }) {
    super();
    this.listenPort = listenPort;
    this.target = target;
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.listenPort, "127.0.0.1", () => resolve());
    });
  }

  clear() {
    this.calls.length = 0;
    this.emit("cleared");
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const started = Date.now();
    const reqChunks: Buffer[] = [];
    let reqSize = 0;
    let ca: string;
    try {
      ca = this.target.caFile();
    } catch {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("aws-locally: the emulator is not running. Start it from the course UI.\n");
      return;
    }

    const upstream = https.request(
      {
        host: "127.0.0.1",
        port: this.target.port,
        method: req.method,
        path: req.url,
        headers: req.headers,
        ca: readFileSync(ca),
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        const resChunks: Buffer[] = [];
        let resSize = 0;
        up.on("data", (c: Buffer) => {
          if (resSize < BODY_LIMIT) resChunks.push(c);
          resSize += c.length;
        });
        up.pipe(res);
        up.on("end", () => {
          this.record(req, Buffer.concat(reqChunks), reqSize, up, Buffer.concat(resChunks), resSize, started);
        });
      },
    );
    upstream.on("error", (err) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end(`aws-locally proxy: cannot reach the emulator (${err.message}).\n`);
    });
    req.on("data", (c: Buffer) => {
      if (reqSize < BODY_LIMIT) reqChunks.push(c);
      reqSize += c.length;
    });
    req.pipe(upstream);
  }

  private record(
    req: http.IncomingMessage,
    reqBody: Buffer,
    reqSize: number,
    up: http.IncomingMessage,
    resBody: Buffer,
    resSize: number,
    started: number,
  ) {
    const url = new URL(req.url ?? "/", "http://x");
    const headers = flat(req.headers);
    const host = headers["host"] ?? "";
    const reqText = bodyText(reqBody, reqSize, headers["content-type"]);
    const resHeaders = flat(up.headers);
    const resText = bodyText(resBody, resSize, resHeaders["content-type"]);
    const service = detectService(headers, url, host);
    const { operation, protocol } = detectOperation(service, req.method ?? "GET", url, headers, reqText);
    const status = up.statusCode ?? 0;
    const call: ApiCall = {
      id: ++this.seq,
      time: started,
      durationMs: Date.now() - started,
      method: req.method ?? "GET",
      path: redactQuery(url),
      host,
      service,
      operation,
      status,
      errorCode: status >= 400 ? detectError(resHeaders, resText) : "",
      protocol,
      mutating: isMutating(req.method ?? "GET", operation),
      reqHeaders: redactHeaders(headers),
      reqBody: reqText,
      resHeaders,
      resBody: resText,
    };
    this.calls.push(call);
    if (this.calls.length > 1000) this.calls.shift();
    this.emit("call", call);
  }
}

function flat(h: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) if (v !== undefined) out[k] = Array.isArray(v) ? v.join(", ") : v;
  return out;
}

function bodyText(buf: Buffer, size: number, contentType = ""): string {
  if (size === 0) return "";
  const textual = /json|xml|text|x-www-form-urlencoded|x-amz-json|yaml/.test(contentType) || contentType === "";
  if (!textual || buf.includes(0)) return `[${size} bytes, ${contentType || "binary"}]`;
  let s = buf.toString("utf8");
  if (/x-www-form-urlencoded/.test(contentType)) {
    try {
      s = [...new URLSearchParams(s)].map(([k, v]) => `${k}=${v}`).join("\n");
    } catch {}
  }
  if (size > BODY_LIMIT) s = s.slice(0, BODY_LIMIT) + `\n… [truncated, ${size} bytes total]`;
  // Base64 zips inside JSON (e.g. Lambda CreateFunction) are noise.
  return s.replace(/"ZipFile"\s*:\s*"[^"]{200,}"/g, '"ZipFile":"<base64 zip omitted>"');
}

function redactHeaders(h: Record<string, string>): Record<string, string> {
  const out = { ...h };
  if (out.authorization) out.authorization = out.authorization.replace(/Signature=([0-9a-f]{8})[0-9a-f]+/, "Signature=$1…");
  return out;
}

function redactQuery(url: URL): string {
  const p = new URLSearchParams(url.search);
  if (p.has("X-Amz-Signature")) p.set("X-Amz-Signature", p.get("X-Amz-Signature")!.slice(0, 8) + "…");
  const q = p.toString();
  return decodeURIComponent(url.pathname) + (q ? "?" + q : "");
}

function detectService(h: Record<string, string>, url: URL, host: string): string {
  if (/\.execute-api\./.test(host)) return "execute-api";
  const scope = /Credential=[^/]+\/\d{8}\/[^/]+\/([^/]+)\//.exec(h.authorization ?? "")?.[1];
  if (scope) return scope;
  const q = url.searchParams.get("X-Amz-Credential");
  if (q) return q.split("/")[3] ?? "unknown";
  return "unsigned";
}

function detectOperation(
  service: string,
  method: string,
  url: URL,
  h: Record<string, string>,
  body: string,
): { operation: string; protocol: string } {
  const target = h["x-amz-target"];
  if (target) return { operation: target.split(".").pop() ?? target, protocol: "json" };
  const rpc = /\/service\/[^/]+\/operation\/([^/?]+)/.exec(url.pathname);
  if (rpc) return { operation: rpc[1], protocol: "rpc-v2-cbor" };
  const action = url.searchParams.get("Action") ?? /^Action=(\w+)/m.exec(body)?.[1];
  if (action) return { operation: action, protocol: "query" };
  if (service === "s3") return { operation: s3Operation(method, url, h), protocol: "rest-xml" };
  if (service === "lambda") return { operation: lambdaOperation(method, url.pathname), protocol: "rest-json" };
  if (service === "execute-api") return { operation: `${method} ${url.pathname}`, protocol: "http" };
  return { operation: `${method} ${decodeURIComponent(url.pathname)}`, protocol: "rest" };
}

function s3Operation(method: string, url: URL, h: Record<string, string>): string {
  const parts = url.pathname.split("/").filter(Boolean);
  const keys = [...url.searchParams.keys()].filter((k) => !k.startsWith("X-Amz-") && k !== "x-id");
  const sub = keys.find((k) =>
    /^(versioning|lifecycle|policy|encryption|tagging|cors|acl|website|notification|logging|replication|ownershipControls|publicAccessBlock|object-lock|versions|uploads|uploadId|location|delete|accelerate|requestPayment|intelligent-tiering|inventory|metrics|analytics|retention|legal-hold|attributes)$/.test(k),
  );
  const cap = (s: string) =>
    s
      .split("-")
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join("");
  const verb = method === "PUT" ? "Put" : method === "DELETE" ? "Delete" : method === "POST" ? "Post" : method === "HEAD" ? "Head" : "Get";
  if (parts.length === 0) return "ListBuckets";
  if (parts.length === 1) {
    if (sub === "versions") return "ListObjectVersions";
    if (sub === "uploads") return "ListMultipartUploads";
    if (sub === "delete") return "DeleteObjects";
    if (sub === "location") return "GetBucketLocation";
    if (sub) return `${verb}Bucket${cap(sub)}`;
    if (method === "PUT") return "CreateBucket";
    if (method === "DELETE") return "DeleteBucket";
    if (method === "HEAD") return "HeadBucket";
    return url.searchParams.get("list-type") === "2" ? "ListObjectsV2" : "ListObjects";
  }
  if (sub === "uploads") return "CreateMultipartUpload";
  if (sub === "uploadId") return method === "PUT" ? "UploadPart" : method === "POST" ? "CompleteMultipartUpload" : method === "DELETE" ? "AbortMultipartUpload" : "ListParts";
  if (sub) return `${verb}Object${cap(sub)}`;
  if (method === "PUT") return h["x-amz-copy-source"] ? "CopyObject" : "PutObject";
  if (method === "DELETE") return "DeleteObject";
  if (method === "HEAD") return "HeadObject";
  return "GetObject";
}

function lambdaOperation(method: string, path: string): string {
  const p = path.replace(/^\/[\d-]+/, "");
  const rules: [string, RegExp, string][] = [
    ["POST", /^\/functions\/?$/, "CreateFunction"],
    ["GET", /^\/functions\/?$/, "ListFunctions"],
    ["POST", /^\/functions\/[^/]+\/invocations$/, "Invoke"],
    ["POST", /^\/functions\/[^/]+\/invoke-async\/?$/, "InvokeAsync"],
    ["GET", /^\/functions\/[^/]+\/configuration$/, "GetFunctionConfiguration"],
    ["PUT", /^\/functions\/[^/]+\/configuration$/, "UpdateFunctionConfiguration"],
    ["PUT", /^\/functions\/[^/]+\/code$/, "UpdateFunctionCode"],
    ["POST", /^\/functions\/[^/]+\/versions$/, "PublishVersion"],
    ["GET", /^\/functions\/[^/]+\/versions$/, "ListVersionsByFunction"],
    ["POST", /^\/functions\/[^/]+\/aliases$/, "CreateAlias"],
    ["GET", /^\/functions\/[^/]+\/aliases$/, "ListAliases"],
    ["PUT", /^\/functions\/[^/]+\/aliases\/[^/]+$/, "UpdateAlias"],
    ["GET", /^\/functions\/[^/]+\/aliases\/[^/]+$/, "GetAlias"],
    ["POST", /^\/functions\/[^/]+\/policy$/, "AddPermission"],
    ["GET", /^\/functions\/[^/]+\/policy$/, "GetPolicy"],
    ["PUT", /^\/functions\/[^/]+\/concurrency$/, "PutFunctionConcurrency"],
    ["GET", /^\/functions\/[^/]+$/, "GetFunction"],
    ["DELETE", /^\/functions\/[^/]+$/, "DeleteFunction"],
    ["POST", /^\/event-source-mappings\/?$/, "CreateEventSourceMapping"],
    ["GET", /^\/event-source-mappings\/?$/, "ListEventSourceMappings"],
    ["GET", /^\/event-source-mappings\/[^/]+$/, "GetEventSourceMapping"],
    ["DELETE", /^\/event-source-mappings\/[^/]+$/, "DeleteEventSourceMapping"],
    ["POST", /^\/layers\/[^/]+\/versions$/, "PublishLayerVersion"],
  ];
  for (const [m, re, op] of rules) if (m === method && re.test(p)) return op;
  return `${method} ${path}`;
}

function detectError(h: Record<string, string>, body: string): string {
  const t = h["x-amzn-errortype"];
  if (t) return t.split(":")[0].split("#").pop() ?? t;
  const xml = /<Code>([^<]+)<\/Code>/.exec(body)?.[1];
  if (xml) return xml;
  try {
    const j = JSON.parse(body);
    const ty = j.__type ?? j.code ?? j.Code;
    if (typeof ty === "string") return ty.split("#").pop() ?? ty;
  } catch {}
  return "";
}

const READ_OPS = /^(Get|List|Describe|Head|Lookup|Query|Scan|Receive|Simulate|BatchGet|Search|Filter|Select|Test|Validate|Estimate|Preview|Check|Detect|Invoke|Decrypt|Encrypt|GenerateDataKey|Sign|Verify|Assume|Start(Query|LiveTail))/;

function isMutating(method: string, operation: string): boolean {
  if (/^(GET|HEAD) /.test(operation) || method === "HEAD") return false;
  if (READ_OPS.test(operation)) return /^(Invoke|Start)/.test(operation) ? true : false;
  return method !== "GET";
}
