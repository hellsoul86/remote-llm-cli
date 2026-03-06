export type SessionAlert = {
  id: string;
  threadID: string;
  title: string;
  body: string;
};

export type SessionLastStatus =
  | "idle"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

export type SessionTreeSession = {
  id: string;
  title: string;
  pinned: boolean;
  activeJobID: string;
  unreadDone: boolean;
  lastJobStatus: SessionLastStatus;
  updatedAt: string;
};

export type SessionTreeProject = {
  id: string;
  hostID: string;
  title: string;
  path: string;
  updatedAt: string;
  sessions: SessionTreeSession[];
};

export type SessionTreeHost = {
  hostID: string;
  hostName: string;
  hostAddress: string;
  projects: SessionTreeProject[];
};

export type SessionTreePrefs = {
  projectFilter: string;
  collapsedHostIDs: string[];
};
