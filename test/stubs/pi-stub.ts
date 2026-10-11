/**
 * Stub child for the run-wrapper tests. It records its argv and environment
 * as JSON, writes a configured `.exit` sidecar, then exits with a configured
 * code or dies from a configured signal. All configuration comes from its own
 * environment, so the wrapper still starts it with a plain argv array.
 *
 * Env:
 *   PI_STUB_RECORD     file to write `{ args, env }` to
 *   PI_STUB_EXIT       sidecar path (usually `<session>.exit`)
 *   PI_STUB_EXIT_BODY  sidecar text; unset means no sidecar, like a crash
 *   PI_STUB_CODE       exit code (default 0)
 *   PI_STUB_SIGNAL     signal to die from instead of exiting
 *   PI_STUB_DELAY_MS   stay alive this long after recording, before exiting
 */
import { writeFileSync } from "node:fs";

const { PI_STUB_RECORD, PI_STUB_EXIT, PI_STUB_EXIT_BODY, PI_STUB_CODE, PI_STUB_SIGNAL, PI_STUB_DELAY_MS } =
  process.env;

if (PI_STUB_RECORD) {
  writeFileSync(PI_STUB_RECORD, JSON.stringify({ args: process.argv.slice(2), env: process.env }, null, 2));
}
if (PI_STUB_DELAY_MS) {
  await new Promise((resolve) => setTimeout(resolve, Number(PI_STUB_DELAY_MS)));
}
if (PI_STUB_EXIT && PI_STUB_EXIT_BODY !== undefined) {
  writeFileSync(PI_STUB_EXIT, PI_STUB_EXIT_BODY);
}
if (PI_STUB_SIGNAL) {
  process.kill(process.pid, PI_STUB_SIGNAL as NodeJS.Signals);
} else {
  process.exit(Number(PI_STUB_CODE ?? "0"));
}
