import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capSummary, getReportFile, REPORT_CAP_CHARS } from "../pi-extension/luvus/report-cap.ts";

const session = () => join(mkdtempSync(join(tmpdir(), "report-cap-")), "s.jsonl");

test("passes a summary at the cap through unchanged", () => {
  const text = "x".repeat(REPORT_CAP_CHARS);
  assert.equal(capSummary(text, session()), text);
});

test("saves an over-cap summary and returns a head with a pointer", () => {
  const file = session();
  const text = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
  const out = capSummary(text, file);
  assert.ok(out.length < text.length);
  assert.ok(out.startsWith("line 0\n"));
  assert.ok(out.includes(getReportFile(file)));
  assert.equal(readFileSync(getReportFile(file), "utf8"), text);
});

test("returns the full text when the report cannot be saved", () => {
  const text = "x".repeat(REPORT_CAP_CHARS + 1);
  assert.equal(capSummary(text, "/nonexistent-dir/s.jsonl"), text);
});
