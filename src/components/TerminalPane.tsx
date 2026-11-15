import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import { api, onTerminal, sendWs } from "../api.ts";

const THEME = {
  background: "#0b0e13",
  foreground: "#d6dce4",
  cursor: "#ffb547",
  cursorAccent: "#0b0e13",
  selectionBackground: "#2b3a52",
  black: "#1b222c",
  red: "#ff6b6b",
  green: "#5fd38d",
  yellow: "#ffb547",
  blue: "#6cb6ff",
  magenta: "#d2a8ff",
  cyan: "#56d4dd",
  white: "#d6dce4",
  brightBlack: "#5c6773",
  brightRed: "#ff8f8f",
  brightGreen: "#8ae5ad",
  brightYellow: "#ffd08a",
  brightBlue: "#9bcbff",
  brightMagenta: "#e2c5ff",
  brightCyan: "#8de8ee",
  brightWhite: "#f5f7fa",
};

export function TerminalPane({ visible }: { visible: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<{ term: Terminal; fit: FitAddon } | null>(null);

  useEffect(() => {
    const term = new Terminal({
      fontFamily: '"JetBrains Mono", "Fira Code", ui-monospace, "SF Mono", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 10000,
      theme: THEME,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    termRef.current = { term, fit };
    const off = onTerminal((m) => {
      if (m.kind === "history") {
        term.reset();
        term.write(m.data);
      } else if (m.kind === "reset") term.reset();
      else term.write(m.data);
    });
    term.onData((d) => sendWs({ type: "term-in", data: d }));
    const resize = () => {
      if (!host.current || host.current.offsetParent === null) return;
      try {
        fit.fit();
        sendWs({ type: "resize", rows: term.rows, cols: term.cols });
      } catch {}
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host.current!);
    const t = setInterval(resize, 2000); // catch the first fit after connect
    return () => {
      off();
      ro.disconnect();
      clearInterval(t);
      term.dispose();
    };
  }, []);

  useEffect(() => {
    if (!visible || !termRef.current) return;
    const { term, fit } = termRef.current;
    requestAnimationFrame(() => {
      try {
        fit.fit();
        sendWs({ type: "resize", rows: term.rows, cols: term.cols });
      } catch {}
      term.focus();
    });
  }, [visible]);

  return (
    <div className="term-wrap">
      <div className="pane-bar">
        <span className="muted">bash · AWS_ENDPOINT_URL → inspector → emulator</span>
        <span className="grow" />
        <button className="btn ghost sm" onClick={() => termRef.current?.term.clear()}>
          Clear
        </button>
        <button className="btn ghost sm" onClick={() => api("/api/terminal/restart", {})} title="Kill and restart the shell">
          New shell
        </button>
      </div>
      <div className="term-host" ref={host} />
    </div>
  );
}
