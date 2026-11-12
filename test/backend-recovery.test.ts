import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EXECUTION_PROVENANCE, isLocalExecutionBackend, recoverLocalExecutionBackend } from "../src/execution-backend.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
describe("execution restart provenance", () => {
  it.each([undefined, "local", "external"])("restores only local sessions with marker %s", marker => {
    const directory = mkdtempSync(join(tmpdir(), "backend-restart-"));
    directories.push(directory);
    const file = join(directory, "session.jsonl");
    const entries: unknown[] = [{ type: "session", version: 3, id: "test", timestamp: new Date().toISOString(), cwd: "/original-local" }];
    if (marker !== undefined) entries.push({ type: "custom", id: "marker", parentId: null, timestamp: new Date().toISOString(), customType: EXECUTION_PROVENANCE, data: marker });
    writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
    if (marker === "external") {
      expect(() => recoverLocalExecutionBackend(file)).toThrow("External execution binding unavailable");
    } else {
      const binding = recoverLocalExecutionBackend(file);
      expect(isLocalExecutionBackend(binding)).toBe(true);
      expect(binding.cwd).toBe("/original-local");
    }
  });
});
