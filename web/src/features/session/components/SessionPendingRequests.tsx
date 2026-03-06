import {
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { CodexV2PendingRequest } from "../../../api";
import {
  describePendingRequest,
  type PendingRequestDescriptor,
  type PendingSchemaField,
  type PendingUserInputQuestion,
} from "../pending-request-utils";

type SessionPendingRequestsProps = {
  requests: CodexV2PendingRequest[];
  loading: boolean;
  error: string;
  resolvingRequestID: string;
  onRefresh: () => void;
  onResolve: (
    requestID: string,
    payload: {
      decision?: unknown;
      result?: unknown;
      error?: { code: number; message: string; data?: unknown };
    },
  ) => Promise<void>;
};

function isBusyRequest(
  resolvingRequestID: string,
  request: CodexV2PendingRequest,
): boolean {
  return resolvingRequestID.trim() !== "" && resolvingRequestID === request.request_id;
}

export function SessionPendingRequests({
  requests,
  loading,
  error,
  resolvingRequestID,
  onRefresh,
  onResolve,
}: SessionPendingRequestsProps) {
  const descriptors = useMemo(
    () =>
      requests.map((request) => ({
        request,
        descriptor: describePendingRequest(request),
      })),
    [requests],
  );
  const [jsonDrafts, setJsonDrafts] = useState<Record<string, string>>({});
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({});
  const [userInputSelections, setUserInputSelections] = useState<
    Record<string, Record<string, string>>
  >({});
  const [userInputOtherDrafts, setUserInputOtherDrafts] = useState<
    Record<string, Record<string, string>>
  >({});
  const [elicitationFieldDrafts, setElicitationFieldDrafts] = useState<
    Record<string, Record<string, string | boolean>>
  >({});

  useEffect(() => {
    setJsonDrafts((prev) => {
      const next = { ...prev };
      for (const { request, descriptor } of descriptors) {
        if (next[request.request_id]) continue;
        if (descriptor.kind === "mcp-form") {
          next[request.request_id] = "{}";
          continue;
        }
        if (descriptor.kind === "generic") {
          next[request.request_id] = "{}";
        }
      }
      return next;
    });
    setElicitationFieldDrafts((prev) => {
      const next = { ...prev };
      for (const { request, descriptor } of descriptors) {
        if (descriptor.kind !== "mcp-form" || !descriptor.fields) continue;
        if (next[request.request_id]) continue;
        const initial: Record<string, string | boolean> = {};
        for (const field of descriptor.fields) {
          initial[field.key] = field.type === "boolean" ? false : "";
        }
        next[request.request_id] = initial;
      }
      return next;
    });
  }, [descriptors]);

  if (requests.length === 0 && !error) {
    return null;
  }

  const setRequestError = (requestID: string, value: string) => {
    setLocalErrors((prev) => ({
      ...prev,
      [requestID]: value,
    }));
  };

  const clearRequestError = (requestID: string) => {
    setLocalErrors((prev) => {
      if (!prev[requestID]) return prev;
      const next = { ...prev };
      delete next[requestID];
      return next;
    });
  };

  const resolveDecision = async (
    request: CodexV2PendingRequest,
    value: string,
  ) => {
    clearRequestError(request.request_id);
    await onResolve(request.request_id, {
      result: {
        decision: value,
      },
    });
  };

  const onSubmitUserInput = async (
    request: CodexV2PendingRequest,
    descriptor: Extract<PendingRequestDescriptor, { kind: "tool-user-input" }>,
  ) => {
    const selections = userInputSelections[request.request_id] ?? {};
    const otherDrafts = userInputOtherDrafts[request.request_id] ?? {};
    const answers: Record<string, { answers: string[] }> = {};

    for (const question of descriptor.questions) {
      const selected = (selections[question.id] ?? "").trim();
      if (selected === "__other__") {
        const otherValue = (otherDrafts[question.id] ?? "").trim();
        if (!otherValue) {
          setRequestError(
            request.request_id,
            `Answer "${question.header}" before continuing.`,
          );
          return;
        }
        answers[question.id] = { answers: [otherValue] };
        continue;
      }
      if (!selected) {
        setRequestError(
          request.request_id,
          `Answer "${question.header}" before continuing.`,
        );
        return;
      }
      answers[question.id] = { answers: [selected] };
    }

    clearRequestError(request.request_id);
    await onResolve(request.request_id, {
      result: {
        answers,
      },
    });
  };

  const onSubmitMcpForm = async (
    request: CodexV2PendingRequest,
    descriptor: Extract<PendingRequestDescriptor, { kind: "mcp-form" }>,
  ) => {
    if (descriptor.fields && descriptor.fields.length > 0) {
      const drafts = elicitationFieldDrafts[request.request_id] ?? {};
      const content: Record<string, unknown> = {};
      for (const field of descriptor.fields) {
        const rawValue = drafts[field.key];
        if (field.type === "boolean") {
          content[field.key] = Boolean(rawValue);
          continue;
        }
        const textValue = typeof rawValue === "string" ? rawValue.trim() : "";
        if (!textValue) {
          if (field.required) {
            setRequestError(
              request.request_id,
              `Fill "${field.label}" before continuing.`,
            );
            return;
          }
          continue;
        }
        if (field.type === "number" || field.type === "integer") {
          const parsed = Number(textValue);
          if (!Number.isFinite(parsed)) {
            setRequestError(
              request.request_id,
              `"${field.label}" must be a valid number.`,
            );
            return;
          }
          content[field.key] =
            field.type === "integer" ? Math.trunc(parsed) : parsed;
          continue;
        }
        content[field.key] = textValue;
      }

      clearRequestError(request.request_id);
      await onResolve(request.request_id, {
        result: {
          action: "accept",
          content,
        },
      });
      return;
    }

    const draft = (jsonDrafts[request.request_id] ?? "").trim();
    if (!draft) {
      setRequestError(request.request_id, "Provide JSON content before continuing.");
      return;
    }
    try {
      const parsed = JSON.parse(draft) as unknown;
      clearRequestError(request.request_id);
      await onResolve(request.request_id, {
        result: {
          action: "accept",
          content: parsed,
        },
      });
    } catch {
      setRequestError(request.request_id, "JSON content is not valid.");
    }
  };

  const onSubmitGenericJSON = async (request: CodexV2PendingRequest) => {
    const draft = (jsonDrafts[request.request_id] ?? "").trim();
    try {
      const parsed = draft ? (JSON.parse(draft) as unknown) : {};
      clearRequestError(request.request_id);
      await onResolve(request.request_id, {
        result: parsed,
      });
    } catch {
      setRequestError(request.request_id, "JSON content is not valid.");
    }
  };

  return (
    <section className="pending-request-stack" aria-live="polite">
      <div className="pending-request-stack-head">
        <div>
          <strong>Continue session</strong>
          <small>
            {requests.length > 0
              ? `${requests.length} request${requests.length === 1 ? "" : "s"} waiting`
              : loading
                ? "Checking for server requests"
                : "No pending requests"}
          </small>
        </div>
        <button
          type="button"
          className="ghost"
          onClick={onRefresh}
          disabled={loading || resolvingRequestID.trim() !== ""}
        >
          Refresh
        </button>
      </div>

      {error ? (
        <p className="pending-request-error" role="alert">
          {error}
        </p>
      ) : null}

      {descriptors.map(({ request, descriptor }) => {
        const requestID = request.request_id;
        const busy = isBusyRequest(resolvingRequestID, request);
        const localError = localErrors[requestID] ?? "";
        return (
          <article
            key={requestID}
            className="pending-request-card"
            data-testid="pending-request-card"
          >
            <div className="pending-request-card-head">
              <div>
                <strong>{descriptor.title}</strong>
                <small>{request.method}</small>
              </div>
              <span className="pending-request-chip">
                {busy ? "resolving" : "waiting"}
              </span>
            </div>

            <p className="pending-request-summary">{descriptor.summary}</p>

            {renderDescriptorBody({
              descriptor,
              requestID,
              busy,
              jsonDrafts,
              setJsonDrafts,
              userInputSelections,
              setUserInputSelections,
              userInputOtherDrafts,
              setUserInputOtherDrafts,
              elicitationFieldDrafts,
              setElicitationFieldDrafts,
              onResolveDecision: (value) => {
                resolveDecision(request, value).catch(() => undefined);
              },
              onResolveUserInput: () => {
                onSubmitUserInput(
                  request,
                  descriptor as Extract<
                    PendingRequestDescriptor,
                    { kind: "tool-user-input" }
                  >,
                ).catch(() => undefined);
              },
              onResolveMcpForm: () => {
                onSubmitMcpForm(
                  request,
                  descriptor as Extract<PendingRequestDescriptor, { kind: "mcp-form" }>,
                ).catch(() => undefined);
              },
              onResolveMcpUrl: (action) => {
                onResolve(request.request_id, {
                  result: {
                    action,
                    content: null,
                  },
                }).catch(() => undefined);
              },
              onResolveGenericJSON: () => {
                onSubmitGenericJSON(request).catch(() => undefined);
              },
            })}

            {localError ? (
              <p className="pending-request-error" role="alert">
                {localError}
              </p>
            ) : null}
          </article>
        );
      })}
    </section>
  );
}

type RenderDescriptorBodyArgs = {
  descriptor: PendingRequestDescriptor;
  requestID: string;
  busy: boolean;
  jsonDrafts: Record<string, string>;
  setJsonDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  userInputSelections: Record<string, Record<string, string>>;
  setUserInputSelections: Dispatch<
    SetStateAction<Record<string, Record<string, string>>>
  >;
  userInputOtherDrafts: Record<string, Record<string, string>>;
  setUserInputOtherDrafts: Dispatch<
    SetStateAction<Record<string, Record<string, string>>>
  >;
  elicitationFieldDrafts: Record<string, Record<string, string | boolean>>;
  setElicitationFieldDrafts: Dispatch<
    SetStateAction<Record<string, Record<string, string | boolean>>>
  >;
  onResolveDecision: (value: string) => void;
  onResolveUserInput: () => void;
  onResolveMcpForm: () => void;
  onResolveMcpUrl: (action: "accept" | "decline" | "cancel") => void;
  onResolveGenericJSON: () => void;
};

function renderDescriptorBody(args: RenderDescriptorBodyArgs) {
  const {
    descriptor,
    requestID,
    busy,
    jsonDrafts,
    setJsonDrafts,
    userInputSelections,
    setUserInputSelections,
    userInputOtherDrafts,
    setUserInputOtherDrafts,
    elicitationFieldDrafts,
    setElicitationFieldDrafts,
    onResolveDecision,
    onResolveUserInput,
    onResolveMcpForm,
    onResolveMcpUrl,
    onResolveGenericJSON,
  } = args;

  switch (descriptor.kind) {
    case "command-approval":
      return (
        <>
          {descriptor.command ? (
            <pre className="pending-request-code">{descriptor.command}</pre>
          ) : null}
          {(descriptor.cwd || descriptor.reason) ? (
            <div className="pending-request-meta">
              {descriptor.cwd ? <span>cwd: {descriptor.cwd}</span> : null}
              {descriptor.reason ? <span>reason: {descriptor.reason}</span> : null}
            </div>
          ) : null}
          <div className="pending-request-actions">
            {descriptor.decisions.map((decision) => (
              <button
                key={decision.value}
                type="button"
                className={decision.value === "accept" ? "" : "ghost"}
                data-testid={`pending-request-decision-${decision.value}`}
                disabled={busy}
                onClick={() => onResolveDecision(decision.value)}
              >
                {busy ? "Working..." : decision.label}
              </button>
            ))}
          </div>
        </>
      );
    case "file-approval":
      return (
        <>
          {(descriptor.grantRoot || descriptor.reason) ? (
            <div className="pending-request-meta">
              {descriptor.grantRoot ? (
                <span>root: {descriptor.grantRoot}</span>
              ) : null}
              {descriptor.reason ? <span>reason: {descriptor.reason}</span> : null}
            </div>
          ) : null}
          <div className="pending-request-actions">
            {descriptor.decisions.map((decision) => (
              <button
                key={decision.value}
                type="button"
                className={decision.value === "accept" ? "" : "ghost"}
                data-testid={`pending-request-decision-${decision.value}`}
                disabled={busy}
                onClick={() => onResolveDecision(decision.value)}
              >
                {busy ? "Working..." : decision.label}
              </button>
            ))}
          </div>
        </>
      );
    case "tool-user-input":
      return (
        <>
          <div className="pending-request-form">
            {descriptor.questions.map((question) =>
              renderQuestion({
                question,
                requestID,
                busy,
                userInputSelections,
                setUserInputSelections,
                userInputOtherDrafts,
                setUserInputOtherDrafts,
              }),
            )}
          </div>
          <div className="pending-request-actions">
            <button
              type="button"
              data-testid="pending-request-submit-input"
              disabled={busy}
              onClick={onResolveUserInput}
            >
              {busy ? "Submitting..." : "Continue"}
            </button>
          </div>
        </>
      );
    case "mcp-form":
      return (
        <>
          {descriptor.message ? (
            <p className="pending-request-note">{descriptor.message}</p>
          ) : null}
          {descriptor.fields ? (
            <div className="pending-request-form">
              {descriptor.fields.map((field) =>
                renderSchemaField({
                  field,
                  requestID,
                  busy,
                  elicitationFieldDrafts,
                  setElicitationFieldDrafts,
                }),
              )}
            </div>
          ) : (
            <>
              <label className="pending-request-json">
                <span>JSON content</span>
                <textarea
                  data-testid="pending-request-json-input"
                  rows={8}
                  value={jsonDrafts[requestID] ?? ""}
                  disabled={busy}
                  onChange={(event) =>
                    setJsonDrafts((prev) => ({
                      ...prev,
                      [requestID]: event.target.value,
                    }))
                  }
                />
              </label>
              <details className="pending-request-schema">
                <summary>Requested schema</summary>
                <pre className="pending-request-code">{descriptor.schemaJSON}</pre>
              </details>
            </>
          )}
          <div className="pending-request-actions">
            <button type="button" disabled={busy} onClick={onResolveMcpForm}>
              {busy ? "Submitting..." : "Continue"}
            </button>
            <button
              type="button"
              className="ghost"
              disabled={busy}
              onClick={() => onResolveMcpUrl("decline")}
            >
              Decline
            </button>
            <button
              type="button"
              className="ghost"
              disabled={busy}
              onClick={() => onResolveMcpUrl("cancel")}
            >
              Cancel
            </button>
          </div>
        </>
      );
    case "mcp-url":
      return (
        <>
          {descriptor.message ? (
            <p className="pending-request-note">{descriptor.message}</p>
          ) : null}
          <div className="pending-request-link-row">
            <a href={descriptor.url} target="_blank" rel="noreferrer">
              Open authorization page
            </a>
            <span>{descriptor.serverName}</span>
          </div>
          <div className="pending-request-actions">
            <button
              type="button"
              data-testid="pending-request-accept-url"
              disabled={busy}
              onClick={() => onResolveMcpUrl("accept")}
            >
              {busy ? "Submitting..." : "Done"}
            </button>
            <button
              type="button"
              className="ghost"
              disabled={busy}
              onClick={() => onResolveMcpUrl("decline")}
            >
              Decline
            </button>
            <button
              type="button"
              className="ghost"
              disabled={busy}
              onClick={() => onResolveMcpUrl("cancel")}
            >
              Cancel
            </button>
          </div>
        </>
      );
    case "generic":
      return (
        <>
          <pre className="pending-request-code">{descriptor.paramsJSON}</pre>
          <label className="pending-request-json">
            <span>Response JSON</span>
            <textarea
              data-testid="pending-request-json-input"
              rows={8}
              value={jsonDrafts[requestID] ?? ""}
              disabled={busy}
              onChange={(event) =>
                setJsonDrafts((prev) => ({
                  ...prev,
                  [requestID]: event.target.value,
                }))
              }
            />
          </label>
          <div className="pending-request-actions">
            <button type="button" disabled={busy} onClick={onResolveGenericJSON}>
              {busy ? "Submitting..." : "Send JSON"}
            </button>
          </div>
        </>
      );
  }
}

function renderQuestion(args: {
  question: PendingUserInputQuestion;
  requestID: string;
  busy: boolean;
  userInputSelections: Record<string, Record<string, string>>;
  setUserInputSelections: Dispatch<
    SetStateAction<Record<string, Record<string, string>>>
  >;
  userInputOtherDrafts: Record<string, Record<string, string>>;
  setUserInputOtherDrafts: Dispatch<
    SetStateAction<Record<string, Record<string, string>>>
  >;
}) {
  const {
    question,
    requestID,
    busy,
    userInputSelections,
    setUserInputSelections,
    userInputOtherDrafts,
    setUserInputOtherDrafts,
  } = args;
  const selected = userInputSelections[requestID]?.[question.id] ?? "";
  const otherDraft = userInputOtherDrafts[requestID]?.[question.id] ?? "";
  return (
    <label key={question.id} className="pending-request-field">
      <span>{question.header}</span>
      {question.question ? (
        <small className="pending-request-field-copy">{question.question}</small>
      ) : null}
      {question.options.length > 0 ? (
        <div className="pending-request-option-row">
          {question.options.map((option) => (
            <button
              key={option.label}
              type="button"
              className={
                selected === option.label ? "pending-option selected" : "pending-option"
              }
              disabled={busy}
              onClick={() =>
                setUserInputSelections((prev) => ({
                  ...prev,
                  [requestID]: {
                    ...(prev[requestID] ?? {}),
                    [question.id]: option.label,
                  },
                }))
              }
            >
              {option.label}
            </button>
          ))}
          {question.isOther ? (
            <button
              type="button"
              className={
                selected === "__other__" ? "pending-option selected" : "pending-option"
              }
              disabled={busy}
              onClick={() =>
                setUserInputSelections((prev) => ({
                  ...prev,
                  [requestID]: {
                    ...(prev[requestID] ?? {}),
                    [question.id]: "__other__",
                  },
                }))
              }
            >
              Other
            </button>
          ) : null}
        </div>
      ) : null}
      {question.options.length > 0 && question.isOther && selected === "__other__" ? (
        <input
          type={question.isSecret ? "password" : "text"}
          value={otherDraft}
          disabled={busy}
          placeholder="Enter your answer"
          onChange={(event) =>
            setUserInputOtherDrafts((prev) => ({
              ...prev,
              [requestID]: {
                ...(prev[requestID] ?? {}),
                [question.id]: event.target.value,
              },
            }))
          }
        />
      ) : null}
      {question.options.length === 0 ? (
        <input
          type={question.isSecret ? "password" : "text"}
          value={otherDraft}
          disabled={busy}
          placeholder="Enter your answer"
          onChange={(event) => {
            const nextValue = event.target.value;
            setUserInputSelections((prev) => ({
              ...prev,
              [requestID]: {
                ...(prev[requestID] ?? {}),
                [question.id]: "__other__",
              },
            }));
            setUserInputOtherDrafts((prev) => ({
              ...prev,
              [requestID]: {
                ...(prev[requestID] ?? {}),
                [question.id]: nextValue,
              },
            }));
          }}
        />
      ) : null}
    </label>
  );
}

function renderSchemaField(args: {
  field: PendingSchemaField;
  requestID: string;
  busy: boolean;
  elicitationFieldDrafts: Record<string, Record<string, string | boolean>>;
  setElicitationFieldDrafts: Dispatch<
    SetStateAction<Record<string, Record<string, string | boolean>>>
  >;
}) {
  const {
    field,
    requestID,
    busy,
    elicitationFieldDrafts,
    setElicitationFieldDrafts,
  } = args;
  const value = elicitationFieldDrafts[requestID]?.[field.key];
  if (field.type === "boolean") {
    return (
      <label key={field.key} className="pending-request-toggle">
        <span>
          {field.label}
          {field.required ? " *" : ""}
        </span>
        <input
          type="checkbox"
          checked={Boolean(value)}
          disabled={busy}
          onChange={(event) =>
            setElicitationFieldDrafts((prev) => ({
              ...prev,
              [requestID]: {
                ...(prev[requestID] ?? {}),
                [field.key]: event.target.checked,
              },
            }))
          }
        />
      </label>
    );
  }
  return (
    <label key={field.key} className="pending-request-field">
      <span>
        {field.label}
        {field.required ? " *" : ""}
      </span>
      <input
        type={field.type === "number" || field.type === "integer" ? "number" : "text"}
        value={typeof value === "string" ? value : ""}
        disabled={busy}
        onChange={(event) =>
          setElicitationFieldDrafts((prev) => ({
            ...prev,
            [requestID]: {
              ...(prev[requestID] ?? {}),
              [field.key]: event.target.value,
            },
          }))
        }
      />
    </label>
  );
}
