import type { CodexV2PendingRequest } from "../../api";

type PendingRequestOption = {
  label: string;
  description: string;
};

export type PendingRequestDecision = {
  value: string;
  label: string;
};

export type PendingUserInputQuestion = {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: PendingRequestOption[];
};

export type PendingSchemaField = {
  key: string;
  label: string;
  type: "string" | "number" | "integer" | "boolean";
  required: boolean;
};

export type PendingRequestDescriptor =
  | {
      kind: "command-approval";
      title: string;
      summary: string;
      command: string;
      cwd: string;
      reason: string;
      decisions: PendingRequestDecision[];
    }
  | {
      kind: "file-approval";
      title: string;
      summary: string;
      grantRoot: string;
      reason: string;
      decisions: PendingRequestDecision[];
    }
  | {
      kind: "tool-user-input";
      title: string;
      summary: string;
      questions: PendingUserInputQuestion[];
    }
  | {
      kind: "mcp-form";
      title: string;
      summary: string;
      serverName: string;
      message: string;
      fields: PendingSchemaField[] | null;
      schemaJSON: string;
    }
  | {
      kind: "mcp-url";
      title: string;
      summary: string;
      serverName: string;
      message: string;
      url: string;
    }
  | {
      kind: "generic";
      title: string;
      summary: string;
      paramsJSON: string;
    };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function prettyMethodLabel(method: string): string {
  const normalized = method.trim();
  switch (normalized) {
    case "item/commandExecution/requestApproval":
      return "Command approval";
    case "item/fileChange/requestApproval":
      return "File approval";
    case "item/tool/requestUserInput":
      return "Input requested";
    case "mcpServer/elicitation/request":
      return "MCP input";
    default:
      return normalized || "Server request";
  }
}

function summarizeDecision(value: string): string {
  switch (value) {
    case "accept":
      return "Allow";
    case "acceptForSession":
      return "Allow for session";
    case "decline":
      return "Decline";
    case "cancel":
      return "Cancel";
    default:
      return value;
  }
}

function simpleDecisionList(
  raw: unknown,
  fallback: string[],
): PendingRequestDecision[] {
  const seen = new Set<string>();
  const out: PendingRequestDecision[] = [];
  for (const item of asArray(raw)) {
    if (typeof item !== "string") continue;
    const value = item.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push({
      value,
      label: summarizeDecision(value),
    });
  }
  if (out.length > 0) return out;
  return fallback.map((value) => ({
    value,
    label: summarizeDecision(value),
  }));
}

function questionList(raw: unknown): PendingUserInputQuestion[] {
  const out: PendingUserInputQuestion[] = [];
  for (const item of asArray(raw)) {
    const record = asRecord(item);
    if (!record) continue;
    const id = asString(record.id);
    if (!id) continue;
    out.push({
      id,
      header: asString(record.header) || id,
      question: asString(record.question),
      isOther: asBoolean(record.isOther),
      isSecret: asBoolean(record.isSecret),
      options: asArray(record.options)
        .map((option) => {
          const optionRecord = asRecord(option);
          if (!optionRecord) return null;
          const label = asString(optionRecord.label);
          if (!label) return null;
          return {
            label,
            description: asString(optionRecord.description),
          };
        })
        .filter((item): item is PendingRequestOption => item !== null),
    });
  }
  return out;
}

function parseSimpleSchemaFields(raw: unknown): PendingSchemaField[] | null {
  const schema = asRecord(raw);
  if (!schema || asString(schema.type) !== "object") return null;
  const properties = asRecord(schema.properties);
  if (!properties) return null;
  const requiredSet = new Set(
    asArray(schema.required)
      .map((item) => asString(item))
      .filter((item) => item !== ""),
  );
  const out: PendingSchemaField[] = [];
  for (const [key, value] of Object.entries(properties)) {
    const field = asRecord(value);
    if (!field) return null;
    const type = asString(field.type);
    if (
      type !== "string" &&
      type !== "number" &&
      type !== "integer" &&
      type !== "boolean"
    ) {
      return null;
    }
    out.push({
      key,
      label: asString(field.title) || key,
      type,
      required: requiredSet.has(key),
    });
  }
  return out.length > 0 ? out : null;
}

function safeJSON(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return "{}";
  }
}

export function describePendingRequest(
  request: CodexV2PendingRequest,
): PendingRequestDescriptor {
  const params = asRecord(request.params) ?? {};
  switch (request.method.trim()) {
    case "item/commandExecution/requestApproval": {
      const command = asString(params.command);
      const cwd = asString(params.cwd);
      const reason = asString(params.reason);
      return {
        kind: "command-approval",
        title: "Approve command",
        summary:
          reason ||
          (command ? `Codex wants to run \`${command}\`.` : "Codex wants to run a command."),
        command,
        cwd,
        reason,
        decisions: simpleDecisionList(params.availableDecisions, [
          "accept",
          "decline",
          "cancel",
        ]),
      };
    }
    case "item/fileChange/requestApproval": {
      const grantRoot = asString(params.grantRoot);
      const reason = asString(params.reason);
      return {
        kind: "file-approval",
        title: "Approve file changes",
        summary:
          reason ||
          (grantRoot
            ? `Codex wants write access under \`${grantRoot}\`.`
            : "Codex wants to write files."),
        grantRoot,
        reason,
        decisions: [
          {
            value: "accept",
            label: "Allow",
          },
          {
            value: "acceptForSession",
            label: "Allow for session",
          },
          {
            value: "decline",
            label: "Decline",
          },
          {
            value: "cancel",
            label: "Cancel",
          },
        ],
      };
    }
    case "item/tool/requestUserInput": {
      const questions = questionList(params.questions);
      return {
        kind: "tool-user-input",
        title: "Input required",
        summary:
          questions.length === 1
            ? questions[0].question || questions[0].header
            : `${questions.length} answers are needed before Codex can continue.`,
        questions,
      };
    }
    case "mcpServer/elicitation/request": {
      const mode = asString(params.mode);
      const serverName = asString(params.serverName) || "MCP server";
      const message = asString(params.message);
      if (mode === "url") {
        return {
          kind: "mcp-url",
          title: "Open MCP authorization",
          summary: `${serverName} needs a browser step before Codex can continue.`,
          serverName,
          message,
          url: asString(params.url),
        };
      }
      const requestedSchema = params.requestedSchema;
      return {
        kind: "mcp-form",
        title: "Provide MCP input",
        summary: `${serverName} needs structured input before Codex can continue.`,
        serverName,
        message,
        fields: parseSimpleSchemaFields(requestedSchema),
        schemaJSON: safeJSON(requestedSchema),
      };
    }
    default:
      return {
        kind: "generic",
        title: prettyMethodLabel(request.method),
        summary: "This Codex version requested a server-side interaction the web client does not natively label yet.",
        paramsJSON: safeJSON(request.params),
      };
  }
}

export function pendingRequestsStatusCopy(
  requests: CodexV2PendingRequest[],
): string {
  if (requests.length === 0) return "";
  const first = requests[0];
  switch (first.method.trim()) {
    case "item/commandExecution/requestApproval":
      return requests.length === 1
        ? "Awaiting command approval."
        : `Awaiting ${requests.length} approvals.`;
    case "item/fileChange/requestApproval":
      return requests.length === 1
        ? "Awaiting file approval."
        : `Awaiting ${requests.length} approvals.`;
    case "item/tool/requestUserInput":
      return requests.length === 1
        ? "Waiting for your input."
        : `Waiting for ${requests.length} replies.`;
    case "mcpServer/elicitation/request":
      return requests.length === 1
        ? "Waiting for MCP input."
        : `Waiting for ${requests.length} MCP inputs.`;
    default:
      return requests.length === 1
        ? "Waiting for a server request response."
        : `Waiting for ${requests.length} server request responses.`;
  }
}
