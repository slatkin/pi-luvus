/**
 * Stream tailer for `/stream` follower panes: a plain Node script, not a TUI,
 * so any terminal can host it.
 *
 * Usage: node stream-tail.mjs --socket <path> --stream <thinking|tools>
 *
 * It connects to the session's unix socket, sends one hello record naming its
 * stream, prints a one-line header, then renders each newline-delimited JSON
 * record as readable text. The JSON envelope is transport only. When the
 * connection closes (the pi session ended or the pane was detached) it exits
 * 0; when the connection cannot be established it reports the failure on
 * stderr and exits non-zero.
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

/** The readable text of one record, or "" for a record worth skipping. */
function recordText(record) {
  if (!record || typeof record !== "object") return "";
  if (typeof record.text !== "string") return "";
  // Thinking text is prose that continues across records; print it verbatim.
  if (record.type === "thinking") return record.text;
  // Tool records are line-oriented; keep each one on its own line.
  return record.text.endsWith("\n") ? record.text : `${record.text}\n`;
}

const socket = createConnection(socketPath);

socket.setEncoding("utf8");

socket.on("connect", () => {
  socket.write(`${JSON.stringify({ hello: stream })}\n`);
  process.stdout.write(`pi-luvus ${stream} stream\n`);
});

let buffer = "";
socket.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      // A line that is not a record has no readable content to show.
      continue;
    }
    process.stdout.write(recordText(record));
  }
});

socket.on("end", () => {
  if (buffer.trim()) {
    try {
      process.stdout.write(recordText(JSON.parse(buffer)));
    } catch {
      // A trailing partial record has no readable content to show.
    }
  }
  buffer = "";
});

socket.on("error", (error) => {
  process.stderr.write(`stream-tail: cannot connect to ${socketPath}: ${error.message}\n`);
  process.exitCode = 1;
  socket.destroy();
});
