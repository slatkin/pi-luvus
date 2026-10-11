/**
 * One slug builder for the names this package derives from free text: Luvus
 * pane names, scratch file stems, and artifact file names. The callers differ
 * in which characters survive and how the result is capped, so those axes are
 * options rather than separate near-copies.
 */
export interface SlugifyOptions {
  /** Result when the name has no usable characters left. Default: "subagent". */
  fallback?: string;
  /** Lowercase the result. Default: true. */
  lowercase?: boolean;
  /** Keep underscores instead of dropping them. Default: false. */
  keepUnderscore?: boolean;
  /**
   * true  — replace each run of dropped characters with "-".
   * false — drop each run of dropped non-space characters, and replace each run
   *         of whitespace with "-".
   * Default: true.
   */
  hyphenate?: boolean;
  /** Collapse runs of "-" into a single "-". Default: true. */
  collapse?: boolean;
  /** Truncate the result to this many characters. */
  maxLength?: number;
  /** Prefix "s-" when the result does not start with a letter. */
  ensureLeadingLetter?: boolean;
}

/** Characters dropped when slugifying, selected by the caller's keep rules. */
function droppedPattern(hyphenate: boolean, lowercase: boolean, keepUnderscore: boolean): RegExp {
  if (!hyphenate) return lowercase ? /[^a-z0-9\s-]+/g : /[^A-Za-z0-9\s-]+/g;
  if (keepUnderscore) return lowercase ? /[^a-z0-9_-]+/g : /[^A-Za-z0-9_-]+/g;
  return lowercase ? /[^a-z0-9-]+/g : /[^A-Za-z0-9-]+/g;
}

export function slugifyName(name: string, options: SlugifyOptions = {}): string {
  const {
    fallback = "subagent",
    lowercase = true,
    keepUnderscore = false,
    hyphenate = true,
    collapse = true,
    maxLength,
    ensureLeadingLetter = false,
  } = options;

  const source = lowercase ? name.toLowerCase() : name;
  let slug = source.replace(droppedPattern(hyphenate, lowercase, keepUnderscore), hyphenate ? "-" : "");
  if (!hyphenate) slug = slug.replace(/\s+/g, "-");
  if (collapse) slug = slug.replace(/-+/g, "-");
  slug = slug.replace(/^-+/, "").replace(/-+$/, "");
  if (slug.length === 0) slug = fallback;
  if (maxLength !== undefined) slug = slug.slice(0, maxLength);
  if (ensureLeadingLetter && !/^[a-z]/.test(slug)) {
    slug = `s-${slug.slice(0, (maxLength ?? 32) - 2)}`;
  }
  return slug;
}
