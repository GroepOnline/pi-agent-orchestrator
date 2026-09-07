import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SubagentScheduler } from "../src/schedule.js";
import { ScheduleStore } from "../src/schedule-store.js";

describe("SubagentScheduler Bounds Checks", () => {
  let tmp: string;
  let scheduler: SubagentScheduler;
  let store: ScheduleStore;
  let pi: any;
  let ctx: any;
  let manager: any;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "scheduler-test-bounds-"));
    store = await ScheduleStore.create(join(tmp, "store.json"));
    scheduler = new SubagentScheduler();
    pi = { events: { emit: () => {} } };
    ctx = { modelRegistry: {} };
    manager = { spawn: () => "agent-123", getRecord: () => ({ status: "completed" }) };
    await scheduler.start(pi, ctx, manager, store);
  });

  afterEach(() => {
    scheduler.stop();
    // maxRetries + retryDelay handles Windows file-locking races where the
    // fs.mkdir lock directory is briefly held open after release.
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("prevents updating a job with a prompt exceeding MAX_PROMPT_SIZE", async () => {
    const job = await scheduler.addJob({
      name: "test-bounds-job",
      description: "initial",
      schedule: "+10s",
      subagent_type: "general-purpose",
      prompt: "short prompt",
    });

    const hugePrompt = "a".repeat(50001); // MAX_PROMPT_SIZE is 50000

    await expect(
      scheduler.updateJob(job.id, { prompt: hugePrompt })
    ).rejects.toThrow(/Prompt must be a string <= 50000 characters/);
  });

  it("prevents updating a job with a name exceeding MAX_NAME_LENGTH", async () => {
    const job = await scheduler.addJob({
      name: "test-bounds-job",
      description: "initial",
      schedule: "+10s",
      subagent_type: "general-purpose",
      prompt: "short prompt",
    });

    const hugeName = "a".repeat(101); // MAX_NAME_LENGTH is 100

    await expect(
      scheduler.updateJob(job.id, { name: hugeName })
    ).rejects.toThrow(/Schedule name must be a string <= 100 characters/);
  });
});
