import { writeFileSync } from "node:fs";

/** A summary over this many chars is cut; the full text goes to a file. */
export const REPORT_CAP_CHARS = 16000;
/** How much of an over-cap summary the parent still receives. */
export const REPORT_HEAD_CHARS = 12000;
/** Tail kept when a Claude pane's screen text stands in for the summary. */
export const SCREEN_SUMMARY_CHARS = 8000;

/** Sidecar that holds the full report, next to the session's `.exit` and `.msg` files. */
export function getReportFile(sessionFile: string): string {
  return `${sessionFile}.report.md`;
}

/**
 * Return the summary unchanged unless it is extreme. An extreme one is saved
 * in full, then cut to its head with a pointer to the file. If the save
 * fails, return the full text: never cut without a full copy.
 */
export function capSummary(summary: string, sessionFile: string | undefined): string {
  if (!sessionFile || summary.length <= REPORT_CAP_CHARS) return summary;
  const file = getReportFile(sessionFile);
  try {
    writeFileSync(file, summary, "utf8");
  } catch {
    return summary;
  }
  const lineEnd = summary.lastIndexOf("\n", REPORT_HEAD_CHARS);
  const head = summary.slice(0, lineEnd > 0 ? lineEnd : REPORT_HEAD_CHARS);
  return `${head}\n\n[Report truncated: ${head.length}/${summary.length} chars shown. Full report: ${file}. Read it before you act on findings.]`;
}
