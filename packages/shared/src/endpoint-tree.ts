/**
 * Path-derived endpoint hierarchy builder.
 *
 * Turns a flat list of endpoints into a Version → Category → Subcategory
 * → Endpoint tree by parsing each endpoint's URL `path`. The builder is
 * pure and framework-agnostic (no React / DOM / @heroui), so it lives in
 * `@bolthub/shared` and is exercised directly by `bun test`. The Hub and
 * the Dashboard both consume it; each attaches its own opaque `payload`
 * to every endpoint (the Hub uses the original index + slug to drive the
 * playground; the Dashboard carries the endpoint object to navigate).
 *
 * When the paths don't yield meaningful structure (too few endpoints,
 * mostly single-segment paths, inconsistent shapes) the builder reports
 * `hierarchical: false` and the caller renders the always-populated,
 * alphabetical `flat` list instead — a graceful fallback to today's flat
 * endpoint list with zero visual regression.
 */

export interface TreeEndpointInput<TLeaf> {
  /** Raw URL path, e.g. "/v1/weather/current" or "weather". */
  path: string;
  /** HTTP method, e.g. "GET". Used on the leaf badge + as a sort tiebreak. */
  method: string;
  /** Optional human title; preferred over the derived path segment as the leaf label. */
  title?: string | null;
  /** Opaque caller data carried through to the matching leaf node. */
  payload: TLeaf;
}

export interface BuildEndpointTreeOptions {
  /** Below this endpoint count the tree is never built (flat fallback). Default 4. */
  minEndpointsForTree?: number;
  /** Fraction of endpoints that must start with a version segment to enable a Version level. Default 0.6. */
  versionCoverageThreshold?: number;
  /** Max number of grouping levels below an (optional) version level. Default 2. */
  maxDepth?: number;
  /** Min fraction of endpoints that must nest under a group for the tree to be considered useful. Default 0.5. */
  minNestedFraction?: number;
}

export type TreeNodeKind = "version" | "group" | "leaf";

export interface TreeLeafNode<TLeaf> {
  kind: "leaf";
  /** Stable, unique key for React lists. */
  id: string;
  /** Display label — the endpoint title, or the derived last path segment. */
  label: string;
  method: string;
  /** Full original path (for tooltips / monospace display). */
  path: string;
  title: string | null;
  payload: TLeaf;
}

export interface TreeBranchNode<TLeaf> {
  kind: "version" | "group";
  /** Display label, e.g. "v1" or "weather" (may be a "/"-joined compressed chain). */
  label: string;
  /** Stable key — also used to track expand/collapse state. */
  key: string;
  children: TreeNode<TLeaf>[];
  /** Total leaves anywhere under this branch (rendered as a count badge). */
  leafCount: number;
}

export type TreeNode<TLeaf> = TreeBranchNode<TLeaf> | TreeLeafNode<TLeaf>;

export interface EndpointTree<TLeaf> {
  /** True when the caller should render `roots`; false ⇒ render `flat`. */
  hierarchical: boolean;
  /** 0..1 structure-quality score (exposed mainly for tests/tuning). */
  confidence: number;
  /** Nested nodes, sorted at every level. Empty when not hierarchical. */
  roots: TreeNode<TLeaf>[];
  /** Every endpoint as a flat leaf, alphabetical. Always populated. */
  flat: TreeLeafNode<TLeaf>[];
}

const DEFAULTS = {
  minEndpointsForTree: 4,
  versionCoverageThreshold: 0.6,
  maxDepth: 2,
  minNestedFraction: 0.5,
} as const;

function cmp(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/** Strip protocol+host, query and hash, then split into non-empty segments. */
function normalizePath(path: string): string[] {
  let p = (path ?? "").trim();
  const protoIdx = p.indexOf("://");
  if (protoIdx !== -1) {
    const after = p.slice(protoIdx + 3);
    const slash = after.indexOf("/");
    p = slash === -1 ? "" : after.slice(slash);
  }
  p = p.split("?")[0].split("#")[0];
  return p
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Path parameters (collapsed for grouping, kept verbatim in the full path). */
function isParam(seg: string): boolean {
  if (seg.startsWith("{") && seg.endsWith("}")) return true;
  if (seg.startsWith(":")) return true;
  if (/^\d+$/.test(seg)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) {
    return true;
  }
  return false;
}

/** A leading API version segment, e.g. "v1", "v2.1", or "2024-01". */
function isVersion(seg: string): boolean {
  return /^v\d+([._-]?\d+)*$/i.test(seg) || /^\d{4}-\d{2}(-\d{2})?$/.test(seg);
}

interface Placement<TLeaf> {
  groupPath: string[];
  leaf: TreeLeafNode<TLeaf>;
}

function countLeaves<TLeaf>(nodes: TreeNode<TLeaf>[]): number {
  let total = 0;
  for (const n of nodes) {
    total += n.kind === "leaf" ? 1 : n.leafCount;
  }
  return total;
}

/**
 * Recursively groups placements by their `groupPath`. Branches sort
 * before leaves, each block alphabetically. Non-root single-child branch
 * chains are compressed into one node ("a" → "a/b") so a category that
 * only ever leads to another category doesn't waste a level.
 */
function buildLevel<TLeaf>(
  items: Placement<TLeaf>[],
  keyPrefix: string,
  isRoot: boolean,
): TreeNode<TLeaf>[] {
  const leaves: TreeLeafNode<TLeaf>[] = [];
  const groups = new Map<string, { label: string; items: Placement<TLeaf>[] }>();

  for (const item of items) {
    if (item.groupPath.length === 0) {
      leaves.push(item.leaf);
      continue;
    }
    const seg = item.groupPath[0];
    const lc = seg.toLowerCase();
    let g = groups.get(lc);
    if (!g) {
      g = { label: seg, items: [] };
      groups.set(lc, g);
    }
    g.items.push({ groupPath: item.groupPath.slice(1), leaf: item.leaf });
  }

  const branches: TreeBranchNode<TLeaf>[] = [];
  for (const [lc, g] of groups) {
    const key = keyPrefix ? `${keyPrefix}/${lc}` : lc;
    let children = buildLevel(g.items, key, false);
    let label = g.label;
    let nodeKey = key;

    if (!isRoot) {
      while (children.length === 1 && children[0].kind !== "leaf") {
        const only = children[0] as TreeBranchNode<TLeaf>;
        label = `${label}/${only.label}`;
        nodeKey = only.key;
        children = only.children;
      }
    }

    branches.push({
      kind: "group",
      label,
      key: nodeKey,
      children,
      leafCount: countLeaves(children),
    });
  }

  branches.sort((a, b) => cmp(a.label, b.label));
  leaves.sort((a, b) => cmp(a.label, b.label) || cmp(a.method, b.method));

  return [...branches, ...leaves];
}

/**
 * Build a path-derived endpoint tree. See the module doc for behavior.
 * The caller is expected to group endpoints by their API (Origin) first
 * and call this per group; the builder owns only the within-API
 * version/category structure.
 */
export function buildEndpointTree<TLeaf>(
  endpoints: TreeEndpointInput<TLeaf>[],
  options: BuildEndpointTreeOptions = {},
): EndpointTree<TLeaf> {
  const opts = { ...DEFAULTS, ...options };

  const placements: Placement<TLeaf>[] = [];
  let versionedCount = 0;
  const distinctVersions = new Set<string>();
  let nestedCount = 0;

  endpoints.forEach((ep, i) => {
    const segs = normalizePath(ep.path);

    if (segs.length > 0 && isVersion(segs[0])) {
      versionedCount++;
      distinctVersions.add(segs[0].toLowerCase());
    }

    const nonParam = segs.filter((s) => !isParam(s));
    let groupSegs: string[];
    let leafSeg: string;
    if (nonParam.length === 0) {
      groupSegs = [];
      leafSeg = segs.join("/");
    } else {
      groupSegs = nonParam.slice(0, -1);
      leafSeg = nonParam[nonParam.length - 1];
    }

    if (groupSegs.length > opts.maxDepth) {
      const extra = groupSegs.slice(opts.maxDepth);
      groupSegs = groupSegs.slice(0, opts.maxDepth);
      leafSeg = [...extra, leafSeg].join("/");
    }

    if (groupSegs.length > 0) nestedCount++;

    const title = ep.title?.trim() ? ep.title.trim() : null;
    const label = title ?? (leafSeg || `${ep.method} ${ep.path}`.trim());

    placements.push({
      groupPath: groupSegs,
      leaf: {
        kind: "leaf",
        id: `${ep.path}|${ep.method}|${i}`,
        label,
        method: ep.method,
        path: ep.path,
        title,
        payload: ep.payload,
      },
    });
  });

  const flat = placements
    .map((p) => p.leaf)
    .sort((a, b) => cmp(a.label, b.label) || cmp(a.method, b.method));

  const total = endpoints.length;
  const versionCoverage = total > 0 ? versionedCount / total : 0;
  const versionActive =
    distinctVersions.size >= 2 && versionCoverage >= opts.versionCoverageThreshold;
  const nestedFraction = total > 0 ? nestedCount / total : 0;

  const roots = buildLevel(placements, "", true);

  if (versionActive) {
    for (const node of roots) {
      if (node.kind === "group" && isVersion(node.label)) {
        (node as TreeBranchNode<TLeaf>).kind = "version";
      }
    }
  }

  const hierarchical =
    total >= opts.minEndpointsForTree &&
    nestedFraction >= opts.minNestedFraction &&
    roots.some((n) => n.kind !== "leaf");

  return {
    hierarchical,
    confidence: total < opts.minEndpointsForTree ? 0 : nestedFraction,
    roots: hierarchical ? roots : [],
    flat,
  };
}
