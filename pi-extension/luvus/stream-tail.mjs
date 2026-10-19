/**
 * Stream tailer for `/stream` follower panes: a plain Node script, not a TUI,
 * so any terminal can host it.
 *
 * Usage: node stream-tail.mjs --socket <path> --stream <thinking|tools>
 *
 * It connects to the session's unix socket, sends one hello record naming its
 * stream, prints a one-line header, and copies every received record to
 * stdout. When the connection closes (the pi session ended or the pane was
 * detached) it exits 0; when the connection cannot be established it reports
 * the failure on stderr and exits non-zero.
 */
import { createConnection } from "node:net";

const STREAMS = ["thinking", "tools"];

function usage() {
  process.stderr.write("usage: node stream-tail.mjs --socket <path> --stream <thinking|tools>\n");
  process.exit(2);
}

const argv = process.argv.slice(2);
let socketPath;
let stream;
for (let i = 0; i < argv.length; i += 2) {
  if (argv[i] === "--socket") socketPath = argv[i + 1];
  else if (argv[i] === "--stream") stream = argv[i + 1];
  else usage();
}
if (!socketPath || !stream || !STREAMS.includes(stream)) usage();

const socket = createConnection(socketPath);

socket.setEncoding("utf8");

socket.on("connect", () => {
  socket.write(`${JSON.stringify({ hello: stream })}\n`);
  process.stdout.write(`pi-luvus ${stream} stream\n`);
});

socket.on("data", (chunk) => {
  process.stdout.write(chunk);
});

socket.on("error", (error) => {
  process.stderr.write(`stream-tail: cannot connect to ${socketPath}: ${error.message}\n`);
  process.exitCode = 1;
  socket.destroy();
});
