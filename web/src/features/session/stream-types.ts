import type { TimelineState } from "../../domains/session";

export type SessionRunStreamState = {
  runID: string;
  stdout: string;
  streamSeen: boolean;
  assistantFinalized: boolean;
  failureHints: string[];
  eventParseOffset: number;
  surfacedEventKeys: Set<string>;
};

export type SessionStreamHealthState =
  | "offline"
  | "connecting"
  | "live"
  | "reconnecting"
  | "error";

export type SessionStreamHealth = {
  state: SessionStreamHealthState;
  retries: number;
  lastEventAt: number;
  updatedAt: number;
  lastError: string;
};

export type CodexRuntimeCard = {
  key: string;
  title: string;
  body: string;
  state: TimelineState;
};
