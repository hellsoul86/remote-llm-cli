import { useCallback, useEffect, useMemo, useState } from "react";

import {
  commitProjectGitChanges,
  getProjectGitStatus,
  revertProjectGitPaths,
  stageProjectGitPaths,
  type ProjectGitStatusResponse,
} from "../../api";

type ProjectReviewGitOptions = {
  enabled: boolean;
  token: string;
  projectID: string;
};

type ProjectReviewGitTone = "idle" | "success" | "error";

export function useProjectReviewGit({
  enabled,
  token,
  projectID,
}: ProjectReviewGitOptions) {
  const [status, setStatus] = useState<ProjectGitStatusResponse | null>(null);
  const [known, setKnown] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<
    "" | "stage" | "revert" | "commit"
  >("");
  const [message, setMessage] = useState("");
  const [tone, setTone] = useState<ProjectReviewGitTone>("idle");

  useEffect(() => {
    setStatus(null);
    setKnown(false);
    setLoading(false);
    setBusyAction("");
    setMessage("");
    setTone("idle");
  }, [enabled, projectID]);

  const refresh = useCallback(async () => {
    const trimmedToken = token.trim();
    const trimmedProjectID = projectID.trim();
    if (!enabled || !trimmedToken || !trimmedProjectID) {
      return;
    }
    setLoading(true);
    try {
      const next = await getProjectGitStatus(trimmedToken, trimmedProjectID);
      setStatus(next);
      setKnown(true);
      setMessage("");
      setTone("idle");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setTone("error");
    } finally {
      setLoading(false);
    }
  }, [enabled, projectID, token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const stagePath = useCallback(
    async (path: string) => {
      const trimmedToken = token.trim();
      const trimmedProjectID = projectID.trim();
      const trimmedPath = path.trim();
      if (!enabled || !trimmedToken || !trimmedProjectID || !trimmedPath) {
        return;
      }
      setBusyAction("stage");
      try {
        const resp = await stageProjectGitPaths(
          trimmedToken,
          trimmedProjectID,
          [trimmedPath],
        );
        setStatus(resp.status);
        setKnown(true);
        setMessage(`Staged ${trimmedPath}`);
        setTone("success");
      } catch (error) {
        const next = error instanceof Error ? error.message : String(error);
        setMessage(next);
        setTone("error");
      } finally {
        setBusyAction("");
      }
    },
    [enabled, projectID, token],
  );

  const revertPath = useCallback(
    async (path: string) => {
      const trimmedToken = token.trim();
      const trimmedProjectID = projectID.trim();
      const trimmedPath = path.trim();
      if (!enabled || !trimmedToken || !trimmedProjectID || !trimmedPath) {
        return;
      }
      setBusyAction("revert");
      try {
        const resp = await revertProjectGitPaths(
          trimmedToken,
          trimmedProjectID,
          [trimmedPath],
        );
        setStatus(resp.status);
        setKnown(true);
        setMessage(`Reverted ${trimmedPath}`);
        setTone("success");
      } catch (error) {
        const next = error instanceof Error ? error.message : String(error);
        setMessage(next);
        setTone("error");
      } finally {
        setBusyAction("");
      }
    },
    [enabled, projectID, token],
  );

  const commitChanges = useCallback(
    async (commitMessage: string) => {
      const trimmedToken = token.trim();
      const trimmedProjectID = projectID.trim();
      const trimmedMessage = commitMessage.trim();
      if (!enabled || !trimmedToken || !trimmedProjectID || !trimmedMessage) {
        return;
      }
      setBusyAction("commit");
      try {
        const resp = await commitProjectGitChanges(
          trimmedToken,
          trimmedProjectID,
          trimmedMessage,
        );
        setStatus(resp.status);
        setKnown(true);
        setMessage(`Committed staged changes: ${trimmedMessage}`);
        setTone("success");
      } catch (error) {
        const next = error instanceof Error ? error.message : String(error);
        setMessage(next);
        setTone("error");
      } finally {
        setBusyAction("");
      }
    },
    [enabled, projectID, token],
  );

  const changedPaths = useMemo(
    () =>
      status?.changed_paths?.map((item) => item.trim()).filter(Boolean) ?? [],
    [status],
  );
  const stagedPaths = useMemo(
    () =>
      status?.staged_paths?.map((item) => item.trim()).filter(Boolean) ?? [],
    [status],
  );
  const branch = useMemo(() => status?.branch?.trim() ?? "", [status]);

  return {
    known,
    loading,
    busyAction,
    message,
    tone,
    branch,
    changedPaths,
    stagedPaths,
    refresh,
    stagePath,
    revertPath,
    commitChanges,
  };
}
