import { Marked } from "marked";
import { useMemo, useRef, type MouseEvent } from "react";
import { runInTerminal } from "../api.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Tiny tokenizing highlighter: enough for bash, JSON, YAML and HCL. */
export function highlight(code: string, lang: string): string {
  const rules: [RegExp, string][] =
    lang === "json"
      ? [
          [/"(?:\\.|[^"\\])*"(?=\s*:)/y, "tk-key"],
          [/"(?:\\.|[^"\\])*"/y, "tk-str"],
          [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y, "tk-num"],
          [/\b(?:true|false|null)\b/y, "tk-kw"],
        ]
      : lang === "yaml" || lang === "yml"
        ? [
            [/#[^\n]*/y, "tk-com"],
            [/(?:^|(?<=\n))\s*-?\s*[\w.\/-]+(?=:)/y, "tk-key"],
            [/"(?:\\.|[^"\\])*"|'[^']*'/y, "tk-str"],
            [/!\w+/y, "tk-kw"],
            [/\b\d+\b/y, "tk-num"],
          ]
        : lang === "hcl" || lang === "terraform" || lang === "tf"
          ? [
              [/#[^\n]*|\/\/[^\n]*/y, "tk-com"],
              [/"(?:\\.|[^"\\])*"/y, "tk-str"],
              [/\b(?:resource|data|variable|output|module|provider|terraform|locals|backend|for_each|count|true|false)\b/y, "tk-kw"],
              [/\b\d+\b/y, "tk-num"],
            ]
          : lang === "bash" || lang === "sh" || lang === "shell"
            ? [
                [/#[^\n]*/y, "tk-com"],
                [/"(?:\\.|[^"\\])*"|'[^']*'/y, "tk-str"],
                [/\$\{?[A-Za-z_][\w]*\}?|\$\(/y, "tk-var"],
                [/(?<=^|\n|\|\s?|&&\s?|\$\(|;\s?)\s*(?:aws|terraform|curl|jq|zip|cat|echo|export|cd|ls|for|do|done|if|then|fi|while|sleep|git|docker|kubectl)\b/y, "tk-cmd"],
                [/(?<=\s)--?[\w-]+/y, "tk-flag"],
              ]
            : [];
  if (!rules.length) return esc(code);
  let out = "";
  let i = 0;
  let plain = "";
  outer: while (i < code.length) {
    for (const [re, cls] of rules) {
      re.lastIndex = i;
      const m = re.exec(code);
      if (m && m[0].length) {
        out += esc(plain);
        plain = "";
        out += `<span class="${cls}">${esc(m[0])}</span>`;
        i += m[0].length;
        continue outer;
      }
    }
    plain += code[i++];
  }
  return out + esc(plain);
}

const RUNNABLE = new Set(["bash", "sh", "shell"]);

const marked = new Marked({
  gfm: true,
  renderer: {
    code({ text, lang }) {
      const l = (lang ?? "").trim().split(/\s+/)[0];
      const runnable = RUNNABLE.has(l);
      const tools = `<div class="code-tools">${l ? `<span class="code-lang">${esc(l)}</span>` : ""}${
        runnable ? `<button class="code-btn run" data-act="run" title="Type into the terminal and run">▶ Run</button>` : ""
      }<button class="code-btn" data-act="copy" title="Copy">Copy</button></div>`;
      return `<div class="code-block${runnable ? " runnable" : ""}">${tools}<pre><code data-lang="${esc(l)}">${highlight(text, l)}</code></pre></div>`;
    },
    link({ href, text }) {
      const ext = /^https?:/.test(href);
      return `<a href="${esc(href)}"${ext ? ' target="_blank" rel="noreferrer"' : ""}>${text}</a>`;
    },
  },
});

export function renderMarkdown(md: string): string {
  return marked.parse(md, { async: false }) as string;
}

export function Markdown({ source, className = "prose" }: { source: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  const ref = useRef<HTMLDivElement>(null);
  const onClick = (e: MouseEvent) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
    if (!btn) return;
    const code = btn.closest(".code-block")?.querySelector("code")?.textContent ?? "";
    if (btn.dataset.act === "copy") {
      navigator.clipboard?.writeText(code);
      flash(btn, "Copied");
    } else {
      runInTerminal(code);
      flash(btn, "Sent ✓");
    }
  };
  return <div ref={ref} className={className} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}

function flash(btn: HTMLButtonElement, text: string) {
  const prev = btn.textContent;
  btn.textContent = text;
  btn.disabled = true;
  setTimeout(() => {
    btn.textContent = prev;
    btn.disabled = false;
  }, 1200);
}
