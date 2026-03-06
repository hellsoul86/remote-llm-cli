import type { FormEvent } from "react";

import type { AddHostForm } from "../../../domains/ops";

type OpsHostFormPanelProps = {
  editingHostID: string;
  hostForm: AddHostForm;
  onHostFormChange: (next: AddHostForm) => void;
  addingHost: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancelEdit: () => void;
};

export function OpsHostFormPanel({
  editingHostID,
  hostForm,
  onHostFormChange,
  addingHost,
  onSubmit,
  onCancelEdit,
}: OpsHostFormPanelProps) {
  return (
    <section className="inspect-block">
      <h3>{editingHostID ? "Edit Host" : "Add Host"}</h3>
      <form className="host-form" onSubmit={onSubmit}>
        <input
          placeholder="name"
          value={hostForm.name}
          onChange={(event) =>
            onHostFormChange({
              ...hostForm,
              name: event.target.value,
            })
          }
        />
        <label>
          connection mode
          <select
            value={hostForm.connectionMode}
            onChange={(event) =>
              onHostFormChange({
                ...hostForm,
                connectionMode: event.target.value as "ssh" | "local",
              })
            }
          >
            <option value="ssh">ssh</option>
            <option value="local">local</option>
          </select>
        </label>
        <input
          placeholder={
            hostForm.connectionMode === "local"
              ? "host (optional for local mode)"
              : "host"
          }
          value={hostForm.host}
          onChange={(event) =>
            onHostFormChange({
              ...hostForm,
              host: event.target.value,
            })
          }
        />
        <input
          placeholder="user"
          value={hostForm.user}
          onChange={(event) =>
            onHostFormChange({
              ...hostForm,
              user: event.target.value,
            })
          }
        />
        <input
          placeholder="workspace"
          value={hostForm.workspace}
          onChange={(event) =>
            onHostFormChange({
              ...hostForm,
              workspace: event.target.value,
            })
          }
        />
        <div className="ops-actions-row">
          <button type="submit" disabled={addingHost}>
            {addingHost
              ? "Saving..."
              : editingHostID
                ? "Update Host"
                : "Save Host"}
          </button>
          {editingHostID ? (
            <button
              type="button"
              className="ghost"
              onClick={onCancelEdit}
            >
              Cancel Edit
            </button>
          ) : null}
        </div>
      </form>
    </section>
  );
}
