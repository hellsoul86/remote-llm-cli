import { type FormEvent } from "react";

type TokenGateProps = {
  tokenInput: string;
  authPhase: "checking" | "locked";
  authError: string;
  apiBase: string;
  onTokenInputChange: (value: string) => void;
  onSubmitToken: (event: FormEvent<HTMLFormElement>) => void;
};

export function TokenGate({
  tokenInput,
  authPhase,
  authError,
  apiBase,
  onTokenInputChange,
  onSubmitToken,
}: TokenGateProps) {
  return (
    <div className="gate-shell">
      <div className="gate-noise" />
      <section className="gate-card">
        <p className="gate-eyebrow">codex workspace</p>
        <h1>Sign In</h1>
        <p className="gate-copy">
          Use your personal access token to unlock Codex.
        </p>
        <form onSubmit={onSubmitToken} className="gate-form">
          <label>
            Access Token
            <input
              placeholder="rlm_xxx.yyy"
              value={tokenInput}
              onChange={(event) => onTokenInputChange(event.target.value)}
              autoComplete="off"
            />
          </label>
          <button type="submit" disabled={authPhase === "checking"}>
            {authPhase === "checking" ? "Verifying..." : "Unlock Codex"}
          </button>
        </form>
        {authError ? <p className="gate-error">{authError}</p> : null}
        <p className="gate-hint">API base: {apiBase || "not configured"}</p>
      </section>
    </div>
  );
}
