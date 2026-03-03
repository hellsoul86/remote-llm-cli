import { expect, test } from "@playwright/test";

test("queues async run job and observes terminal success", async ({ page }) => {
  let jobPollCount = 0;
  let eventPollCount = 0;

  await page.route("**/v1/healthz", async (route) => {
    await route.fulfill({ status: 200, json: { ok: true, timestamp: "2026-03-02T00:00:00Z" } });
  });
  await page.route("**/v1/hosts", async (route, request) => {
    if (request.method() === "GET") {
      await route.fulfill({
        status: 200,
        json: {
          hosts: [{ id: "local_1", name: "local-default", connection_mode: "local", host: "localhost", user: "", port: 22, workspace: "/srv/work" }]
        }
      });
      return;
    }
    await route.fallback();
  });
  await page.route("**/v1/runtimes", async (route) => {
    await route.fulfill({
      status: 200,
      json: {
        runtimes: [
          {
            name: "codex",
            capabilities: {
              supports_non_interactive_exec: true,
              supports_interactive_session: false,
              supports_structured_output: true,
              supports_file_patch_mode: false,
              supports_cost_metrics: false
            }
          }
        ]
      }
    });
  });
  await page.route("**/v1/runs**", async (route) => {
    await route.fulfill({ status: 200, json: { runs: [] } });
  });
  await page.route("**/v1/codex/models**", async (route) => {
    await route.fulfill({
      status: 200,
      json: {
        runtime: "codex",
        default_model: "gpt-5-codex",
        models: ["gpt-5-codex", "gpt-5"]
      }
    });
  });
  await page.route("**/v1/codex/sessions/discover", async (route) => {
    await route.fulfill({
      status: 200,
      json: {
        operation: "codex_sessions_discover",
        summary: { total: 1, succeeded: 1, failed: 0, fanout: 1, duration_ms: 5, started_at: "2026-03-02T00:00:00Z", finished_at: "2026-03-02T00:00:00Z" },
        targets: [
          {
            host: { id: "local_1", name: "local-default", connection_mode: "local", host: "localhost", user: "", port: 22, workspace: "/srv/work" },
            ok: true,
            sessions: [
              {
                session_id: "session_cli_1",
                thread_name: "Session 1",
                cwd: "/srv/work",
                path: "/home/ecs-user/.codex/sessions/rollout-session_cli_1.jsonl",
                updated_at: "2026-03-02T00:00:00Z",
                size_bytes: 128
              }
            ]
          }
        ]
      }
    });
  });
  await page.route("**/v1/audit**", async (route) => {
    await route.fulfill({ status: 200, json: { events: [] } });
  });
  await page.route("**/v1/metrics", async (route) => {
    await route.fulfill({
      status: 200,
      json: {
        jobs: { total: 1, pending: 0, running: 0, succeeded: 1, failed: 0, canceled: 0, retry_attempts: 0 },
        queue: { depth: 0, workers_total: 3, workers_active: 0, worker_utilization: 0 },
        success_rate: 1
      }
    });
  });
  await page.route("**/v1/admin/retention", async (route, request) => {
    if (request.method() === "GET") {
      await route.fulfill({
        status: 200,
        json: { retention: { run_records_max: 500, run_jobs_max: 1000, audit_events_max: 5000 } }
      });
      return;
    }
    if (request.method() === "POST") {
      await route.fulfill({
        status: 200,
        json: { retention: { run_records_max: 500, run_jobs_max: 1000, audit_events_max: 5000 } }
      });
      return;
    }
    await route.fallback();
  });
  await page.route("**/v1/jobs/run", async (route) => {
    await route.fulfill({
      status: 202,
      json: {
        job: {
          id: "job_1",
          type: "run",
          status: "pending",
          runtime: "codex",
          prompt_preview: "smoke",
          queued_at: "2026-03-02T00:00:00Z",
          total_hosts: 1,
          fanout: 1
        }
      }
    });
  });
  await page.route("**/v1/jobs/job_1", async (route) => {
    jobPollCount += 1;
    if (jobPollCount < 2) {
      await route.fulfill({
        status: 200,
        json: {
          job: {
            id: "job_1",
            type: "run",
            status: "running",
            runtime: "codex",
            prompt_preview: "smoke",
            queued_at: "2026-03-02T00:00:00Z",
            started_at: "2026-03-02T00:00:01Z"
          }
        }
      });
      return;
    }
    await route.fulfill({
      status: 200,
      json: {
        job: {
          id: "job_1",
          type: "run",
          status: "succeeded",
          runtime: "codex",
          prompt_preview: "smoke",
          queued_at: "2026-03-02T00:00:00Z",
          started_at: "2026-03-02T00:00:01Z",
          finished_at: "2026-03-02T00:00:02Z",
          result_status: 200,
          total_hosts: 1,
          succeeded_hosts: 1,
          failed_hosts: 0,
          fanout: 1,
          duration_ms: 1000,
          response: {
            runtime: "codex",
            summary: {
              total: 1,
              succeeded: 1,
              failed: 0,
              fanout: 1,
              retry_count: 0,
              retry_backoff_ms: 1000,
              duration_ms: 1000,
              started_at: "2026-03-02T00:00:01Z",
              finished_at: "2026-03-02T00:00:02Z"
            },
            targets: []
          }
        }
      }
    });
  });
  await page.route("**/v1/jobs/job_1/events**", async (route) => {
    eventPollCount += 1;
    if (eventPollCount === 1) {
      await route.fulfill({
        status: 200,
        json: {
          job_id: "job_1",
          after: 0,
          next_after: 4,
          events: [
            { seq: 1, job_id: "job_1", type: "job.running", created_at: "2026-03-02T00:00:00Z" },
            { seq: 2, job_id: "job_1", type: "target.started", host_name: "local-default", attempt: 1, created_at: "2026-03-02T00:00:00Z" },
            { seq: 3, job_id: "job_1", type: "target.stdout", host_name: "local-default", chunk: "stream-one\\n", created_at: "2026-03-02T00:00:00Z" },
            { seq: 4, job_id: "job_1", type: "target.done", host_name: "local-default", status: "ok", exit_code: 0, created_at: "2026-03-02T00:00:00Z" }
          ]
        }
      });
      return;
    }
    await route.fulfill({
      status: 200,
      json: {
        job_id: "job_1",
        after: 4,
        next_after: 4,
        events: []
      }
    });
  });
  await page.route("**/v1/jobs**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const url = new URL(route.request().url());
    if (url.pathname !== "/v1/jobs") {
      await route.fallback();
      return;
    }
    const status = jobPollCount < 2 ? "running" : "succeeded";
    await route.fulfill({
      status: 200,
      json: {
        jobs: [
          {
            id: "job_1",
            type: "run",
            status,
            runtime: "codex",
            prompt_preview: "smoke",
            queued_at: "2026-03-02T00:00:00Z",
            result_status: status === "succeeded" ? 200 : undefined,
            total_hosts: 1,
            succeeded_hosts: status === "succeeded" ? 1 : 0,
            failed_hosts: 0,
            fanout: 1,
            duration_ms: status === "succeeded" ? 1000 : 0
          }
        ]
      }
    });
  });

  await page.goto("/");
  await page.getByPlaceholder("rlm_xxx.yyy").fill("rlm_test.token");
  await page.getByRole("button", { name: "Unlock Workspace" }).click();

  await expect(page.getByRole("button", { name: "Session 1" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await page.getByPlaceholder("Tell codex what to do in this workspace...").fill("smoke");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByText(/stream-one/)).toBeVisible();
  await expect(
    page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Projects" }) })
      .locator(".session-chip-tree.active small")
  ).toHaveText("succeeded");
  await expect(page.getByText(/Job job_1 succeeded/)).toHaveCount(0);
});

test("renders final codex assistant message from job response when stream is missing", async ({ page }) => {
  let jobPollCount = 0;

  await page.route("**/v1/healthz", async (route) => {
    await route.fulfill({ status: 200, json: { ok: true, timestamp: "2026-03-02T00:00:00Z" } });
  });
  await page.route("**/v1/hosts", async (route, request) => {
    if (request.method() === "GET") {
      await route.fulfill({
        status: 200,
        json: {
          hosts: [{ id: "local_1", name: "local-default", connection_mode: "local", host: "localhost", user: "", port: 22, workspace: "/srv/work" }]
        }
      });
      return;
    }
    await route.fallback();
  });
  await page.route("**/v1/runtimes", async (route) => {
    await route.fulfill({
      status: 200,
      json: {
        runtimes: [
          {
            name: "codex",
            capabilities: {
              supports_non_interactive_exec: true,
              supports_interactive_session: false,
              supports_structured_output: true,
              supports_file_patch_mode: false,
              supports_cost_metrics: false
            }
          }
        ]
      }
    });
  });
  await page.route("**/v1/runs**", async (route) => {
    await route.fulfill({ status: 200, json: { runs: [] } });
  });
  await page.route("**/v1/codex/models**", async (route) => {
    await route.fulfill({
      status: 200,
      json: {
        runtime: "codex",
        default_model: "gpt-5-codex",
        models: ["gpt-5-codex", "gpt-5"]
      }
    });
  });
  await page.route("**/v1/codex/sessions/discover", async (route) => {
    await route.fulfill({
      status: 200,
      json: {
        operation: "codex_sessions_discover",
        summary: { total: 1, succeeded: 1, failed: 0, fanout: 1, duration_ms: 5, started_at: "2026-03-02T00:00:00Z", finished_at: "2026-03-02T00:00:00Z" },
        targets: [
          {
            host: { id: "local_1", name: "local-default", connection_mode: "local", host: "localhost", user: "", port: 22, workspace: "/srv/work" },
            ok: true,
            sessions: [
              {
                session_id: "session_cli_1",
                thread_name: "Session 1",
                cwd: "/srv/work",
                path: "/home/ecs-user/.codex/sessions/rollout-session_cli_1.jsonl",
                updated_at: "2026-03-02T00:00:00Z",
                size_bytes: 128
              }
            ]
          }
        ]
      }
    });
  });
  await page.route("**/v1/audit**", async (route) => {
    await route.fulfill({ status: 200, json: { events: [] } });
  });
  await page.route("**/v1/metrics", async (route) => {
    await route.fulfill({
      status: 200,
      json: {
        jobs: { total: 1, pending: 0, running: 0, succeeded: 1, failed: 0, canceled: 0, retry_attempts: 0 },
        queue: { depth: 0, workers_total: 3, workers_active: 0, worker_utilization: 0 },
        success_rate: 1
      }
    });
  });
  await page.route("**/v1/admin/retention", async (route, request) => {
    if (request.method() === "GET") {
      await route.fulfill({
        status: 200,
        json: { retention: { run_records_max: 500, run_jobs_max: 1000, audit_events_max: 5000 } }
      });
      return;
    }
    if (request.method() === "POST") {
      await route.fulfill({
        status: 200,
        json: { retention: { run_records_max: 500, run_jobs_max: 1000, audit_events_max: 5000 } }
      });
      return;
    }
    await route.fallback();
  });
  await page.route("**/v1/jobs/run", async (route) => {
    await route.fulfill({
      status: 202,
      json: {
        job: {
          id: "job_2",
          type: "run",
          status: "pending",
          runtime: "codex",
          prompt_preview: "smoke",
          queued_at: "2026-03-02T00:00:00Z",
          total_hosts: 1,
          fanout: 1
        }
      }
    });
  });
  await page.route("**/v1/jobs/job_2", async (route) => {
    jobPollCount += 1;
    if (jobPollCount < 2) {
      await route.fulfill({
        status: 200,
        json: {
          job: {
            id: "job_2",
            type: "run",
            status: "running",
            runtime: "codex",
            prompt_preview: "smoke",
            queued_at: "2026-03-02T00:00:00Z",
            started_at: "2026-03-02T00:00:01Z"
          }
        }
      });
      return;
    }
    await route.fulfill({
      status: 200,
      json: {
        job: {
          id: "job_2",
          type: "run",
          status: "succeeded",
          runtime: "codex",
          prompt_preview: "smoke",
          queued_at: "2026-03-02T00:00:00Z",
          started_at: "2026-03-02T00:00:01Z",
          finished_at: "2026-03-02T00:00:02Z",
          result_status: 200,
          total_hosts: 1,
          succeeded_hosts: 1,
          failed_hosts: 0,
          fanout: 1,
          duration_ms: 1000,
          response: {
            runtime: "codex",
            summary: {
              total: 1,
              succeeded: 1,
              failed: 0,
              fanout: 1,
              retry_count: 0,
              retry_backoff_ms: 1000,
              duration_ms: 1000,
              started_at: "2026-03-02T00:00:01Z",
              finished_at: "2026-03-02T00:00:02Z"
            },
            targets: [
              {
                host: { id: "local_1", name: "local-default", connection_mode: "local", host: "localhost", user: "", port: 22, workspace: "/srv/work" },
                ok: true,
                result: {
                  stdout:
                    '{"type":"item.completed","item":{"type":"agent_message","text":"Remote codex response line 1\\\\nRemote codex response line 2"}}\n'
                }
              }
            ]
          }
        }
      }
    });
  });
  await page.route("**/v1/jobs/job_2/events**", async (route) => {
    await route.fulfill({
      status: 200,
      json: {
        job_id: "job_2",
        after: 0,
        next_after: 3,
        events: [
          { seq: 1, job_id: "job_2", type: "job.running", created_at: "2026-03-02T00:00:00Z" },
          { seq: 2, job_id: "job_2", type: "target.started", host_name: "local-default", attempt: 1, created_at: "2026-03-02T00:00:00Z" },
          { seq: 3, job_id: "job_2", type: "target.done", host_name: "local-default", status: "ok", exit_code: 0, created_at: "2026-03-02T00:00:00Z" }
        ]
      }
    });
  });
  await page.route("**/v1/jobs**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const url = new URL(route.request().url());
    if (url.pathname !== "/v1/jobs") {
      await route.fallback();
      return;
    }
    const status = jobPollCount < 2 ? "running" : "succeeded";
    await route.fulfill({
      status: 200,
      json: {
        jobs: [
          {
            id: "job_2",
            type: "run",
            status,
            runtime: "codex",
            prompt_preview: "smoke",
            queued_at: "2026-03-02T00:00:00Z",
            result_status: status === "succeeded" ? 200 : undefined,
            total_hosts: 1,
            succeeded_hosts: status === "succeeded" ? 1 : 0,
            failed_hosts: 0,
            fanout: 1,
            duration_ms: status === "succeeded" ? 1000 : 0
          }
        ]
      }
    });
  });

  await page.goto("/");
  await page.getByPlaceholder("rlm_xxx.yyy").fill("rlm_test.token");
  await page.getByRole("button", { name: "Unlock Workspace" }).click();

  await expect(page.getByRole("button", { name: "Session 1" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await page.getByPlaceholder("Tell codex what to do in this workspace...").fill("smoke");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByText(/Remote codex response line 1/)).toBeVisible();
  await expect(page.getByText(/Remote codex response line 2/)).toBeVisible();
  await expect(page.getByText(/^Done\.$/)).toHaveCount(0);
});
