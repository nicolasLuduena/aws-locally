import { useMemo, useState } from "react";
import { api, useApp, type ApiCall } from "../api.ts";
import { highlight } from "./Markdown.tsx";

const SERVICE_HUE: Record<string, number> = {};
function hue(service: string) {
  if (SERVICE_HUE[service] === undefined) {
    let h = 0;
    for (const c of service) h = (h * 31 + c.charCodeAt(0)) % 360;
    SERVICE_HUE[service] = h;
  }
  return SERVICE_HUE[service];
}

export function ServiceChip({ service }: { service: string }) {
  return (
    <span className="svc-chip" style={{ ["--h" as any]: hue(service) }}>
      {service}
    </span>
  );
}

const time = (t: number) => new Date(t).toLocaleTimeString([], { hour12: false });

export function Inspector() {
  const calls = useApp((s) => s.calls);
  const [selected, setSelected] = useState<number | null>(null);
  const [filter, setFilter] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [hideReads, setHideReads] = useState(false);

  const shown = useMemo(() => {
    const f = filter.toLowerCase();
    return calls
      .filter((c) => (!errorsOnly || c.status >= 400) && (!hideReads || c.mutating))
      .filter((c) => !f || `${c.service} ${c.operation} ${c.path} ${c.errorCode}`.toLowerCase().includes(f))
      .slice()
      .reverse();
  }, [calls, filter, errorsOnly, hideReads]);
  const sel = calls.find((c) => c.id === selected) ?? null;
  const stats = useMemo(() => {
    const errs = calls.filter((c) => c.status >= 400).length;
    return { total: calls.length, errs };
  }, [calls]);

  return (
    <div className="inspector">
      <div className="pane-bar">
        <input className="input sm" placeholder="Filter: service, operation, error…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label className="toggle">
          <input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} /> errors
        </label>
        <label className="toggle">
          <input type="checkbox" checked={hideReads} onChange={(e) => setHideReads(e.target.checked)} /> writes only
        </label>
        <span className="grow" />
        <span className="muted sm">
          {stats.total} calls{stats.errs ? ` · ${stats.errs} errors` : ""}
        </span>
        <button className="btn ghost sm" onClick={() => api("/api/calls/clear", {})}>
          Clear
        </button>
      </div>
      <div className={`insp-body${sel ? " has-detail" : ""}`}>
        <div className="call-list" role="list">
          {shown.length === 0 && (
            <div className="empty">
              <p>No API calls yet.</p>
              <p className="muted">Run any command in the terminal (for example <code>aws s3 ls</code>) and every HTTP request the CLI sends will appear here.</p>
            </div>
          )}
          {shown.map((c) => (
            <button key={c.id} role="listitem" className={`call-row${c.id === selected ? " sel" : ""}${c.status >= 400 ? " err" : ""}`} onClick={() => setSelected(c.id === selected ? null : c.id)}>
              <span className="call-time">{time(c.time)}</span>
              <ServiceChip service={c.service} />
              <span className="call-op">
                {c.mutating && <span className="dot-write" title="mutating call" />}
                {c.operation}
              </span>
              <span className={`call-status s${String(c.status)[0]}`}>{c.status}</span>
              <span className="call-ms">{c.durationMs}ms</span>
              {c.errorCode && <span className="call-err">{c.errorCode}</span>}
            </button>
          ))}
        </div>
        {sel && <CallDetail call={sel} onClose={() => setSelected(null)} />}
      </div>
    </div>
  );
}

function pretty(body: string, headers: Record<string, string>): { text: string; lang: string } {
  const ct = headers["content-type"] ?? "";
  if (!body) return { text: "", lang: "" };
  if (/json/.test(ct) || /^[{[]/.test(body.trim())) {
    try {
      return { text: JSON.stringify(JSON.parse(body), null, 2), lang: "json" };
    } catch {}
  }
  if (/xml/.test(ct) || body.trim().startsWith("<")) {
    let depth = 0;
    const text = body
      .replace(/>\s*</g, ">\n<")
      .split("\n")
      .map((line) => {
        if (/^<\//.test(line)) depth = Math.max(0, depth - 1);
        const out = "  ".repeat(depth) + line;
        if (/^<[^!?/][^>]*[^/]>$/.test(line) && !/<\/.+>$/.test(line)) depth++;
        return out;
      })
      .join("\n");
    return { text, lang: "xml" };
  }
  return { text: body, lang: "" };
}

function CallDetail({ call, onClose }: { call: ApiCall; onClose: () => void }) {
  const req = pretty(call.reqBody, call.reqHeaders);
  const res = pretty(call.resBody, call.resHeaders);
  const interesting = (h: Record<string, string>) =>
    Object.entries(h).filter(([k]) => /^(host|content-type|x-amz-target|authorization|x-amz-date|x-amz-content-sha256|x-amzn-requestid|x-amzn-errortype|x-amz-request-id|location|etag)$/.test(k));
  return (
    <div className="call-detail">
      <div className="detail-head">
        <div>
          <div className="detail-title">
            <ServiceChip service={call.service} /> {call.operation}
          </div>
          <div className="mono sm muted">
            {call.method} {call.path}
          </div>
        </div>
        <button className="btn ghost sm" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="detail-meta">
        <span>
          status <b className={`call-status s${String(call.status)[0]}`}>{call.status}</b>
        </span>
        <span>
          protocol <b>{call.protocol}</b>
        </span>
        <span>
          latency <b>{call.durationMs} ms</b>
        </span>
        {call.errorCode && (
          <span>
            error <b className="call-err">{call.errorCode}</b>
          </span>
        )}
      </div>
      <h4>Request headers</h4>
      <pre className="hdrs">
        {interesting(call.reqHeaders).map(([k, v]) => (
          <div key={k}>
            <span className="tk-key">{k}</span>: {v}
          </div>
        ))}
      </pre>
      {req.text && (
        <>
          <h4>Request body</h4>
          <pre className="http-body" dangerouslySetInnerHTML={{ __html: highlight(req.text, req.lang) }} />
        </>
      )}
      <h4>Response</h4>
      <pre className="hdrs">
        {interesting(call.resHeaders).map(([k, v]) => (
          <div key={k}>
            <span className="tk-key">{k}</span>: {v}
          </div>
        ))}
      </pre>
      {res.text ? <pre className="http-body" dangerouslySetInnerHTML={{ __html: highlight(res.text, res.lang) }} /> : <p className="muted sm">Empty body.</p>}
    </div>
  );
}
