type TimelineNoiseEntryLike = {
  kind: string;
  title: string;
  body: string;
};

const CODEX_PROTOCOL_NOISE_FRAGMENTS = [
  `"type":"thread.started"`,
  `"type":"turn.started"`,
  `"type":"turn.completed"`,
  `"type":"response.started"`,
];

function normalizedLine(value: string): string {
  return value.trim();
}

export function isCodexProtocolNoiseLine(line: string): boolean {
  const normalized = normalizedLine(line);
  if (!normalized) return true;
  if (/^done\.?$/i.test(normalized)) return true;
  if (/^connected\.\s*hosts=\d+/i.test(normalized)) return true;
  if (
    /^[a-z0-9_.-]+\s+(done|failed|completed|started)\b/i.test(normalized) &&
    /\b(status|exit|error|hint|stderr)=/i.test(normalized)
  ) {
    return true;
  }
  for (const fragment of CODEX_PROTOCOL_NOISE_FRAGMENTS) {
    if (normalized.includes(fragment)) return true;
  }
  return false;
}

function allBodyLinesAreNoise(body: string): boolean {
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length === 0) return true;
  return lines.every((line) => isCodexProtocolNoiseLine(line));
}

export function isLegacySessionNoiseEntry(
  entry: TimelineNoiseEntryLike,
): boolean {
  if (entry.kind !== "system") return false;
  const title = entry.title.trim().toLowerCase();
  const body = entry.body.trim();
  if (title === "connected" || title === "connection failed") {
    return true;
  }
  if (title === "server completed" || title === "response started") {
    return true;
  }
  if (!body) return false;
  return allBodyLinesAreNoise(body);
}
