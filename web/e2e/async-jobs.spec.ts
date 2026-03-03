import { expect, test } from "@playwright/test";

test("queues async run job and observes terminal success", async ({ page }) => {
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

  await expect(page.getByText(/Connected\./)).toBeVisible();
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByText(/Job job_1 succeeded/)).toBeVisible();
});
