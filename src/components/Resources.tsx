import { useState } from "react";
import { api, useApp, type Vpc } from "../api.ts";

export function Resources() {
  const { sections, network } = useApp((s) => s.inventory);
  const at = useApp((s) => s.inventoryAt);
  const running = useApp((s) => s.status.state === "running");
  const [busy, setBusy] = useState(false);
  const [showDefault, setShowDefault] = useState(false);

  const refresh = async () => {
    setBusy(true);
    try {
      await api("/api/inventory/refresh", {});
    } finally {
      setBusy(false);
    }
  };

  const groups = new Map<string, typeof sections>();
  for (const s of sections) groups.set(s.group, [...(groups.get(s.group) ?? []), s]);
  const nonEmpty = sections.filter((s) => s.items.length).length;
  const vpcs = network.filter((v) => showDefault || !v.isDefault);
  const defaults = network.filter((v) => v.isDefault).length;

  return (
    <div className="resources">
      <div className="pane-bar">
        <span className="muted sm">
          {running ? `${nonEmpty} resource types in use · updated ${at ? new Date(at).toLocaleTimeString([], { hour12: false }) : "—"}` : "Emulator is not running."}
        </span>
        <span className="grow" />
        {defaults > 0 && (
          <label className="toggle">
            <input type="checkbox" checked={showDefault} onChange={(e) => setShowDefault(e.target.checked)} /> default VPC
          </label>
        )}
        <button className="btn ghost sm" onClick={refresh} disabled={busy || !running}>
          {busy ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <div className="res-scroll">
        <p className="res-note muted sm">
          AWS Emulator has no console, so this one is read-only and built from the same describe and list APIs you'd use. It refreshes after each write you make in the terminal.
        </p>
        {vpcs.length > 0 && (
          <section className="res-group">
            <h3>Network topology</h3>
            {vpcs.map((v) => (
              <VpcMap key={v.id} vpc={v} />
            ))}
          </section>
        )}
        {[...groups.entries()].map(([group, secs]) => {
          const used = secs.filter((s) => s.items.length);
          const empty = secs.filter((s) => !s.items.length && !s.error);
          const errored = secs.filter((s) => s.error);
          return (
            <section className="res-group" key={group}>
              <h3>{group}</h3>
              {used.map((s) => (
                <div className="res-card" key={s.id}>
                  <div className="res-card-head">
                    <span>{s.title}</span>
                    <span className="count">{s.items.length}</span>
                  </div>
                  <ul>
                    {s.items.map((it, i) => (
                      <li key={i}>
                        <span className="res-name">{it.name}</span>
                        {it.status && <span className={`state state-${it.status.toLowerCase().replace(/[^a-z]+/g, "-")}`}>{it.status}</span>}
                        {it.detail && <span className="res-detail">{it.detail}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {empty.length > 0 && <div className="res-empty">{empty.map((s) => s.title).join(" · ")}: none</div>}
              {errored.map((s) => (
                <div className="res-empty err" key={s.id}>
                  {s.title}: {s.error}
                </div>
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function VpcMap({ vpc }: { vpc: Vpc }) {
  const azs = [...new Set(vpc.subnets.map((s) => s.az))].sort();
  return (
    <div className="vpc">
      <div className="vpc-head">
        <span className="vpc-title">
          {vpc.name || vpc.id}
          {vpc.isDefault && <span className="tag">default</span>}
        </span>
        <span className="mono sm muted">
          {vpc.id} · {vpc.cidr}
        </span>
        <span className="grow" />
        <span className={`gw ${vpc.igw ? "on" : ""}`} title={vpc.igw ?? "no internet gateway"}>
          IGW {vpc.igw ? "attached" : "none"}
        </span>
        {vpc.nats.length > 0 && <span className="gw on">NAT ×{vpc.nats.length}</span>}
      </div>
      {azs.length === 0 ? (
        <div className="muted sm vpc-empty">No subnets yet.</div>
      ) : (
        <div className="az-grid" style={{ gridTemplateColumns: `repeat(${azs.length}, minmax(0, 1fr))` }}>
          {azs.map((az) => (
            <div className="az" key={az}>
              <div className="az-label">{az}</div>
              {vpc.subnets
                .filter((s) => s.az === az)
                .map((s) => (
                  <div className={`subnet ${s.public ? "public" : "private"}`} key={s.id}>
                    <div className="subnet-head">
                      <span>{s.name || s.id}</span>
                      <span className="subnet-kind">{s.public ? "public" : "private"}</span>
                    </div>
                    <div className="mono xs muted">{s.cidr}</div>
                    {s.instances.length > 0 && (
                      <div className="insts">
                        {s.instances.map((i) => (
                          <span key={i.id} className={`inst state-${i.state}`} title={`${i.id} ${i.state}`}>
                            {i.name || i.id.slice(-6)} <span className="muted">{i.ip}</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
            </div>
          ))}
        </div>
      )}
      {vpc.securityGroups.filter((g) => g.name !== "default" || g.rules.length).length > 0 && (
        <div className="sgs">
          {vpc.securityGroups
            .filter((g) => g.name !== "default")
            .map((g) => (
              <div className="sg" key={g.id}>
                <b>{g.name}</b> <span className="mono xs muted">{g.id}</span>
                {g.rules.length
                  ? g.rules.map((r, i) => (
                      <div key={i} className="mono xs">
                        {r.replace(/sg-[0-9a-f]+/g, (id) => vpc.securityGroups.find((x) => x.id === id)?.name ?? id)}
                      </div>
                    )) : <div className="xs muted">no inbound rules</div>}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
