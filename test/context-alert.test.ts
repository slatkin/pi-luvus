import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { parseContextAlertConfig, DEFAULT_CONTEXT_ALERT_THRESHOLD_TOKENS } from "../pi-extension/luvus/context-alert.ts";
import { loadStatusConfig, parseStatusConfig } from "../pi-extension/luvus/status.ts";

const DEFAULT_THRESHOLD = { kind: "tokens", value: DEFAULT_CONTEXT_ALERT_THRESHOLD_TOKENS };

describe("context-alert config", () => {
  it("with no contextAlert block the alert is off with the default threshold", () => {
    assert.deepEqual(parseContextAlertConfig(undefined), {
      enabled: false,
      threshold: DEFAULT_THRESHOLD,
    });
    assert.deepEqual(parseStatusConfig({}).contextAlert, {
      enabled: false,
      threshold: DEFAULT_THRESHOLD,
    });
  });

  it("enabled with no threshold means 200000 tokens", () => {
    assert.deepEqual(parseContextAlertConfig({ enabled: true }), {
      enabled: true,
      threshold: DEFAULT_THRESHOLD,
    });
  });

  it("parses an absolute token threshold", () => {
    assert.deepEqual(parseContextAlertConfig({ enabled: true, threshold: 150000 }), {
      enabled: true,
      threshold: { kind: "tokens", value: 150000 },
    });
  });

  it("parses percentage thresholds", () => {
    assert.deepEqual(parseContextAlertConfig({ enabled: true, threshold: "80%" }), {
      enabled: true,
      threshold: { kind: "percent", value: 80 },
    });
    assert.deepEqual(parseContextAlertConfig({ enabled: true, threshold: "80.5%" }), {
      enabled: true,
      threshold: { kind: "percent", value: 80.5 },
    });
  });

  it("rejects an unknown contextAlert key", () => {
    assert.throws(
      () => parseContextAlertConfig({ enabled: true, level: "error" }),
      /contextAlert has unsupported key\(s\): level/,
    );
  });

  it("rejects an invalid contextAlert block and enabled value", () => {
    assert.throws(() => parseContextAlertConfig("yes"), /contextAlert must be an object/);
    assert.throws(() => parseContextAlertConfig({ enabled: "yes" }), /contextAlert\.enabled must be a boolean/);
  });

  it("rejects invalid thresholds with an error that names contextAlert.threshold", () => {
    for (const threshold of [0, -5, 1.5, "0%", "120%", "80", "abc%", true]) {
      assert.throws(
        () => parseContextAlertConfig({ enabled: true, threshold }),
        /contextAlert\.threshold/,
        `threshold ${JSON.stringify(threshold)} must be rejected`,
      );
    }
  });

  it("parseStatusConfig wires contextAlert through", () => {
    assert.deepEqual(
      parseStatusConfig({ contextAlert: { enabled: true, threshold: "80%" } }).contextAlert,
      { enabled: true, threshold: { kind: "percent", value: 80 } },
    );
  });

  it("loadStatusConfig loads the updated example config", () => {
    const examplePath = fileURLToPath(new URL("../config.json.example", import.meta.url));
    const config = loadStatusConfig(examplePath);
    assert.deepEqual(config.contextAlert, {
      enabled: false,
      threshold: DEFAULT_THRESHOLD,
    });
  });
});
