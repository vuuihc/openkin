import type { SheetOption } from "../components/ui/SheetSelect";

/**
 * The label a directory chip shows on one line.
 *
 * A full path is a column, not a chip: the last segment is what a person
 * recognizes, and the two chip surfaces are narrow. An empty value has no
 * label; the root is its own name.
 */
export function directoryLabel(cwd: string): string {
  const trimmed = cwd.trim();
  if (!trimmed) return "";
  const path = trimmed.replace(/\/+$/, "");
  if (!path) return "/";
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** The last `depth` segments of a path, without its leading slash. */
function trailingSegments(cwd: string, depth: number): string {
  const path = cwd.trim().replace(/\/+$/, "");
  if (!path) return "/";
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0) return "/";
  return parts.slice(Math.max(0, parts.length - depth)).join("/");
}

/**
 * The directory filter's options: one row per distinct working directory,
 * labelled by its last segment.
 *
 * Two projects can both sit in a directory called `one`. Labelling both
 * "one" would make the filter a choice between two identical rows, so a
 * colliding pair grows the shortest trailing suffix that tells them apart —
 * `alpha/one` and `beta/one`, not the whole path, which would push the
 * distinguishing segment off a narrow chip. Empty values are not directories;
 * duplicates are one option, not two.
 */
export function directoryOptions(cwds: string[]): SheetOption[] {
  const unique = [...new Set(cwds.map((cwd) => cwd.trim()).filter(Boolean))];
  const labels = unique.map((cwd) => ({ cwd, label: directoryLabel(cwd) }));
  const count = new Map<string, number>();
  for (const { label } of labels) count.set(label, (count.get(label) ?? 0) + 1);
  const options = labels.map(({ cwd, label }) => {
    if ((count.get(label) ?? 0) < 2) return { id: cwd, label };
    const segments = cwd.trim().replace(/\/+$/, "").split("/").filter(Boolean).length;
    let depth = 1;
    while (depth < segments) {
      const suffix = trailingSegments(cwd, depth);
      const collides = unique.some(
        (other) => other !== cwd && trailingSegments(other, depth) === suffix,
      );
      if (!collides) break;
      depth += 1;
    }
    return { id: cwd, label: trailingSegments(cwd, depth) };
  });
  // Stable alphabetical order so the menu does not move between loads, with
  // the path as the tie-break for labels that still read the same.
  options.sort((a, b) => {
    if (a.label !== b.label) return a.label < b.label ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return options;
}
