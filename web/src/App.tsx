import { FormEvent, useEffect, useState } from "react";
import {
  healthz,
  listAudit,
  listHosts,
  listRuns,
  listRuntimes,
  runFanout,
  upsertHost,
  type AuditEvent,
  type Host,
  type RunRecord,
  type RunResponse,
  type RuntimeInfo
} from "./api";

const TOKEN_KEY = "remote_llm_access_key";

export function App() {
  const [token, setToken] = useState<string>(() => localStorage.getItem(TOKEN_KEY) ?? "");
  const [health, setHealth] = useState<string>("checking");
  const [hosts, setHosts] = useState<Host[]>([]);
  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([]);
  const [message, setMessage] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [runLoading, setRunLoading] = useState(false);
  const [runPrompt, setRunPrompt] = useState("summarize current repo state and risks");
  const [runWorkdir, setRunWorkdir] = useState("");
  const [runFanoutValue, setRunFanoutValue] = useState("3");
  const [runAllHosts, setRunAllHosts] = useState(true);
  const [selectedHostIDs, setSelectedHostIDs] = useState<string[]>([]);
  const [runStatus, setRunStatus] = useState<number | null>(null);
  const [runResult, setRunResult] = useState<RunResponse | null>(null);
  const [runHistory, setRunHistory] = useState<RunRecord[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);

  useEffect(() => {
    healthz()
      .then((h) => setHealth(`ok (${h.timestamp})`))
      .catch((e) => setHealth(`error: ${String(e)}`));
  }, []);

  async function refresh() {
    if (!token.trim()) {
      setMessage("set access key first");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const [nextHosts, nextRuntimes, nextRuns, nextAudit] = await Promise.all([
        listHosts(token),
        listRuntimes(token),
        listRuns(token, 20),
        listAudit(token, 80)
      ]);
      setHosts(nextHosts);
      setRuntimes(nextRuntimes);
      setRunHistory(nextRuns);
      setAuditEvents(nextAudit);
      setSelectedHostIDs((prev) => prev.filter((id) => nextHosts.some((h) => h.id === id)));
      setMessage(`loaded ${nextHosts.length} hosts, ${nextRuns.length} runs, ${nextAudit.length} events`);
    } catch (e) {
      setMessage(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function onAddHost(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const host = String(form.get("host") ?? "").trim();
    const user = String(form.get("user") ?? "").trim();
    const workspace = String(form.get("workspace") ?? "").trim();
    if (!name || !host) {
      setMessage("name and host are required");
      return;
    }
    try {
      await upsertHost(token, { name, host, user, workspace });
      setMessage(`host ${name} saved`);
      await refresh();
      e.currentTarget.reset();
    } catch (err) {
      setMessage(String(err));
    }
  }

  function toggleHost(id: string) {
    setSelectedHostIDs((prev) => {
      if (prev.includes(id)) return prev.filter((v) => v !== id);
      return [...prev, id];
    });
  }

  async function onRunCodex(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!token.trim()) {
      setMessage("set access key first");
      return;
    }
    if (!runPrompt.trim()) {
      setMessage("prompt is required");
      return;
    }
    if (!runAllHosts && selectedHostIDs.length === 0) {
      setMessage("select at least one host or enable all hosts");
      return;
    }

    const fanout = Math.max(1, Number.parseInt(runFanoutValue, 10) || 1);
    setRunLoading(true);
    setRunResult(null);
    setRunStatus(null);
    setMessage("");
    try {
      const { status, body } = await runFanout(token, {
        runtime: "codex",
        prompt: runPrompt.trim(),
        fanout,
        all_hosts: runAllHosts,
        host_ids: runAllHosts ? undefined : selectedHostIDs,
        workdir: runWorkdir.trim() || undefined
      });
      setRunStatus(status);
      setRunResult(body);
      setMessage(`run finished with HTTP ${status}, failed=${body.summary.failed}`);
      const [nextRuns, nextAudit] = await Promise.all([listRuns(token, 20), listAudit(token, 80)]);
      setRunHistory(nextRuns);
      setAuditEvents(nextAudit);
    } catch (err) {
      setMessage(String(err));
    } finally {
      setRunLoading(false);
    }
  }

  return (
    <div className="page">
      <header>
        <h1>remote-llm console</h1>
        <p>Universal runtime controller. Codex runtime is enabled first.</p>
      </header>

      <section className="card">
        <h2>Server</h2>
        <p>Health: {health}</p>
      </section>

      <section className="card">
        <h2>Access Key</h2>
        <input
          type="password"
          value={token}
          onChange={(e) => {
            setToken(e.target.value);
            localStorage.setItem(TOKEN_KEY, e.target.value);
          }}
          placeholder="rlm_xxx.yyy"
        />
        <button onClick={refresh} disabled={loading}>
          {loading ? "Loading..." : "Refresh"}
        </button>
      </section>

      <section className="card">
        <h2>Runtimes</h2>
        <ul>
          {runtimes.map((r) => (
            <li key={r.name}>
              <code>{r.name}</code> non-interactive={String(r.capabilities.supports_non_interactive_exec)}
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>Add Host</h2>
        <form onSubmit={onAddHost} className="grid">
          <input name="name" placeholder="name" required />
          <input name="host" placeholder="hostname or ip" required />
          <input name="user" placeholder="user" />
          <input name="workspace" placeholder="/home/user/workspace" />
          <button type="submit">Save Host</button>
        </form>
      </section>

      <section className="card">
        <h2>Hosts</h2>
        <ul>
          {hosts.map((h) => (
            <li key={h.id}>
              <strong>{h.name}</strong> {h.user ? `${h.user}@` : ""}
              {h.host}:{h.port}
              {h.workspace ? ` (${h.workspace})` : ""}
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>Run Codex (Fanout)</h2>
        <form onSubmit={onRunCodex} className="grid">
          <textarea
            value={runPrompt}
            onChange={(e) => setRunPrompt(e.target.value)}
            placeholder="prompt"
            rows={4}
            className="wide"
          />
          <input
            value={runWorkdir}
            onChange={(e) => setRunWorkdir(e.target.value)}
            placeholder="optional workdir override"
            className="wide"
          />
          <label>
            fanout
            <input value={runFanoutValue} onChange={(e) => setRunFanoutValue(e.target.value)} />
          </label>
          <label className="inline">
            <input type="checkbox" checked={runAllHosts} onChange={(e) => setRunAllHosts(e.target.checked)} />
            all hosts
          </label>
          <button type="submit" disabled={runLoading}>
            {runLoading ? "Running..." : "Run Codex"}
          </button>
        </form>

        {!runAllHosts ? (
          <div className="host-grid">
            {hosts.map((h) => (
              <label key={h.id} className="inline">
                <input type="checkbox" checked={selectedHostIDs.includes(h.id)} onChange={() => toggleHost(h.id)} />
                {h.name}
              </label>
            ))}
          </div>
        ) : null}

        {runResult ? (
          <div className="run-result">
            <p>
              status={runStatus} total={runResult.summary.total} ok={runResult.summary.succeeded} failed=
              {runResult.summary.failed} fanout={runResult.summary.fanout} duration={runResult.summary.duration_ms}ms
            </p>
            <ul>
              {runResult.targets.map((t) => (
                <li key={t.host.id}>
                  <strong>{t.host.name}</strong> ok={String(t.ok)} exit={t.result.exit_code ?? "n/a"} dur=
                  {t.result.duration_ms ?? 0}ms {t.error ? ` error=${t.error}` : ""}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section className="card">
        <h2>Recent Runs</h2>
        {runHistory.length === 0 ? (
          <p>no runs yet</p>
        ) : (
          <ul>
            {runHistory.map((r) => (
              <li key={r.id}>
                <strong>{r.runtime}</strong> http={r.status_code} hosts={r.total_hosts} ok={r.succeeded_hosts} failed=
                {r.failed_hosts} fanout={r.fanout} dur={r.duration_ms}ms prompt="{r.prompt_preview}"
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>Audit Events</h2>
        {auditEvents.length === 0 ? (
          <p>no audit events yet</p>
        ) : (
          <ul>
            {auditEvents.map((e) => (
              <li key={e.id}>
                <code>{e.timestamp}</code> {e.action} {e.method} {e.path} status={e.status_code} dur={e.duration_ms}ms
                {e.created_by_key_id ? ` key=${e.created_by_key_id}` : ""}
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer>{message}</footer>
    </div>
  );
}
