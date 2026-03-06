export function normalizeSessionTitle(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  if (/^session(\s+\d+)?$/i.test(collapsed)) return "";
  if (collapsed.length <= 72) return collapsed;
  return `${collapsed.slice(0, 69).trimEnd()}...`;
}

export function isGenericSessionTitle(title: string): boolean {
  return /^session(\s+\d+)?$/i.test(title.trim());
}

export function deriveSessionTitleFromPrompt(prompt: string): string {
  const normalized = prompt
    .replace(/[`*_#>\[\]\(\){}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";
  const sentenceMatch = normalized.match(/^(.{1,88}?)([.!?。！？]|$)/);
  const sentence = (sentenceMatch?.[1] ?? normalized).trim();
  const words = sentence.split(" ").filter((word) => word.trim() !== "");
  const compact = words.slice(0, 10).join(" ");
  return normalizeSessionTitle(compact);
}

export function clipStreamText(raw: string, maxChars = 3600): string {
  if (raw.length <= maxChars) return raw;
  return `${raw.slice(raw.length - maxChars)}\n...[stream truncated for UI]...`;
}

export function projectTitleFromPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "Untitled Project";
  const segments = trimmed.split("/").filter((part) => part.trim() !== "");
  const tail = segments[segments.length - 1];
  return tail?.trim() || trimmed;
}

export function resolveProjectTitle(path: string, title?: string): string {
  const explicit = title?.trim() ?? "";
  if (explicit) return explicit;
  return projectTitleFromPath(path);
}
