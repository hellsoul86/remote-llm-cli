import type { Dispatch, FormEvent, SetStateAction } from "react";
import { deleteHost, probeHost, type Host, upsertHost } from "../../api";
import type { AddHostForm } from "../../domains/ops";
import type { TimelineEntry } from "../../domains/session";

type CreateHostActionsDeps = {
  authPhase: "checking" | "locked" | "ready";
  token: string;
  hostForm: AddHostForm;
  editingHostID: string;
  setHostForm: Dispatch<SetStateAction<AddHostForm>>;
  setEditingHostID: Dispatch<SetStateAction<string>>;
  setAddingHost: Dispatch<SetStateAction<boolean>>;
  setOpsHostBusyID: Dispatch<SetStateAction<string>>;
  setOpsNotice: Dispatch<SetStateAction<string>>;
  setSelectedHostIDs: Dispatch<SetStateAction<string[]>>;
  addTimelineEntry: (
    entry: Omit<TimelineEntry, "id" | "createdAt">,
    threadID?: string,
  ) => void;
  loadWorkspace: (authToken: string) => Promise<void>;
};

const EMPTY_HOST_FORM: AddHostForm = {
  name: "",
  connectionMode: "ssh",
  host: "",
  user: "",
  workspace: "",
};

export function createHostActions(deps: CreateHostActionsDeps) {
  const canRun = () => deps.authPhase === "ready" && deps.token.trim() !== "";

  const onCancelHostEdit = () => {
    deps.setEditingHostID("");
    deps.setHostForm(EMPTY_HOST_FORM);
    deps.setOpsNotice("Canceled host edit.");
  };

  const onStartEditHost = (host: Host) => {
    deps.setEditingHostID(host.id);
    deps.setHostForm({
      name: host.name,
      connectionMode: host.connection_mode === "local" ? "local" : "ssh",
      host: host.host,
      user: host.user ?? "",
      workspace: host.workspace ?? "",
    });
    deps.setOpsNotice(`Editing host ${host.name}.`);
  };

  const onAddHost = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canRun()) return;

    const mode = deps.hostForm.connectionMode ?? "ssh";
    if (!deps.hostForm.name.trim() || (mode === "ssh" && !deps.hostForm.host.trim())) {
      const validationMessage =
        mode === "ssh"
          ? "name and host are required for ssh mode."
          : "name is required.";
      deps.addTimelineEntry({
        kind: "system",
        state: "error",
        title: "Host Validation",
        body: validationMessage,
      });
      return;
    }

    const hostName = deps.hostForm.name.trim();
    const editing = deps.editingHostID;

    deps.setAddingHost(true);
    try {
      await upsertHost(deps.token, {
        id: editing || undefined,
        name: hostName,
        connection_mode: mode,
        host: deps.hostForm.host.trim() || undefined,
        user: deps.hostForm.user.trim() || undefined,
        workspace: deps.hostForm.workspace.trim() || undefined,
      });
      deps.setHostForm(EMPTY_HOST_FORM);
      deps.setEditingHostID("");
      await deps.loadWorkspace(deps.token);
      deps.addTimelineEntry({
        kind: "system",
        state: "success",
        title: editing ? "Host Updated" : "Host Saved",
        body: `${editing ? "Updated" : "Saved"} host ${hostName}.`,
      });
      deps.setOpsNotice(`${editing ? "Updated" : "Saved"} host ${hostName}.`);
    } catch (error) {
      deps.addTimelineEntry({
        kind: "system",
        state: "error",
        title: "Host Save Failed",
        body: String(error),
      });
    } finally {
      deps.setAddingHost(false);
    }
  };

  const onProbeHost = async (host: Host) => {
    if (!canRun()) return;
    deps.setOpsHostBusyID(host.id);
    deps.setOpsNotice(`Probing ${host.name}...`);
    try {
      const result = await probeHost(deps.token, host.id, { preflight: true });
      const ssh = result.ssh?.ok ? "ok" : "fail";
      const codex = result.codex?.ok ? "ok" : "fail";
      const login = result.codex_login?.ok ? "ok" : "fail";
      const sshErr = result.ssh?.error ? ` ssh_error=${result.ssh.error}` : "";
      const codexErr = result.codex?.error
        ? ` codex_error=${result.codex.error}`
        : "";
      const loginErr = result.codex_login?.error
        ? ` login_error=${result.codex_login.error}`
        : "";
      deps.setOpsNotice(
        `Probe ${host.name}: ssh=${ssh} codex=${codex} login=${login}${sshErr}${codexErr}${loginErr}`,
      );
    } catch (error) {
      deps.setOpsNotice(`Probe failed for ${host.name}: ${String(error)}`);
    } finally {
      deps.setOpsHostBusyID("");
    }
  };

  const onDeleteHost = async (host: Host) => {
    if (!canRun()) return;
    if (typeof window !== "undefined") {
      const confirmed = window.confirm(`Delete host '${host.name}'?`);
      if (!confirmed) return;
    }

    deps.setOpsHostBusyID(host.id);
    try {
      await deleteHost(deps.token, host.id);
      deps.setSelectedHostIDs((prev) => prev.filter((id) => id !== host.id));
      if (deps.editingHostID === host.id) {
        onCancelHostEdit();
      }
      await deps.loadWorkspace(deps.token);
      deps.setOpsNotice(`Deleted host ${host.name}.`);
    } catch (error) {
      deps.setOpsNotice(`Delete failed for ${host.name}: ${String(error)}`);
    } finally {
      deps.setOpsHostBusyID("");
    }
  };

  return {
    onAddHost,
    onStartEditHost,
    onCancelHostEdit,
    onProbeHost,
    onDeleteHost,
  };
}
