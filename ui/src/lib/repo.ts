/**
 * Where a recorded repository can be opened, and what to call it.
 *
 * The Hub records a session's repository in the canonical form it uses
 * everywhere else: `host/owner/name`, lowercase host, no transport and no
 * credentials. Only github.com has a page this console can open, so anything
 * else keeps its full name and gets no link — showing a gitlab remote as a
 * github.com URL would be a 404 that looks like the repository is gone.
 */
export type RepoLink = {
  /** The name to show: `owner/name` for a repository, the whole string otherwise. */
  label: string;
  /** Where to open it, or "" when this console cannot. */
  href: string;
};

export function repoLink(canonical: string | null | undefined): RepoLink | null {
  const value = (canonical ?? "").trim();
  if (!value) {
    return null;
  }
  const [host, ...rest] = value.split("/");
  const slug = rest.join("/");
  if (host.toLowerCase() !== "github.com" || !slug) {
    return { label: value, href: "" };
  }
  return { label: slug, href: `https://github.com/${slug}` };
}
