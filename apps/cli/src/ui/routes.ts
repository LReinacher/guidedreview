/**
 * Hash routes for the local review UI. The review, settings, and the source
 * viewer share one document, so a declaration can be opened in a new tab with
 * nothing but a URL.
 */

export type AppRouteName = "review" | "settings" | "about" | "source";

export interface AppRoute {
  name: AppRouteName;
  params: URLSearchParams;
}

export function parseAppHash(hash: string): AppRoute {
  const raw = hash.replace(/^#\/?/, "");
  const separator = raw.indexOf("?");
  const name = (separator === -1 ? raw : raw.slice(0, separator)).toLowerCase();
  const params = new URLSearchParams(separator === -1 ? "" : raw.slice(separator + 1));
  if (name === "settings" || name === "about" || name === "source") return { name, params };
  return { name: "review", params };
}

/** URL of the source viewer for one file, optionally scrolled to a line. */
export function sourceViewUrl(path: string, line?: number): string {
  const params = new URLSearchParams({ path });
  if (line != null && line > 0) params.set("line", String(line));
  return `/#source?${params.toString()}`;
}
