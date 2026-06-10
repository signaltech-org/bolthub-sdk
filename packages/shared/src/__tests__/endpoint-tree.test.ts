import { describe, test, expect } from "bun:test";
import {
  buildEndpointTree,
  type TreeBranchNode,
  type TreeNode,
} from "../endpoint-tree";

// Minimal helper: every test endpoint carries its own index as payload so
// we can assert the payload survives the round-trip into the matching leaf.
function ep(path: string, method = "GET", title?: string) {
  return { path, method, title, payload: { path, method } };
}

function findBranch<T>(nodes: TreeNode<T>[], label: string): TreeBranchNode<T> {
  const node = nodes.find((n) => n.kind !== "leaf" && n.label === label);
  if (!node || node.kind === "leaf") {
    throw new Error(`branch "${label}" not found in [${nodes.map((n) => n.label).join(", ")}]`);
  }
  return node;
}

describe("buildEndpointTree — flat fallback", () => {
  test("below the minimum endpoint count → flat, not hierarchical", () => {
    const t = buildEndpointTree([ep("/v1/a/x"), ep("/v1/a/y"), ep("/v1/b/z")]);
    expect(t.hierarchical).toBe(false);
    expect(t.confidence).toBe(0);
    expect(t.roots).toEqual([]);
    expect(t.flat).toHaveLength(3);
  });

  test("all single-segment paths → flat even with enough endpoints", () => {
    const t = buildEndpointTree([
      ep("/weather"),
      ep("/forecast"),
      ep("/alerts"),
      ep("/radar"),
    ]);
    expect(t.hierarchical).toBe(false);
    expect(t.flat.map((l) => l.label)).toEqual([
      "alerts",
      "forecast",
      "radar",
      "weather",
    ]);
  });

  test("empty input → flat, empty", () => {
    const t = buildEndpointTree([]);
    expect(t.hierarchical).toBe(false);
    expect(t.flat).toEqual([]);
    expect(t.roots).toEqual([]);
  });
});

describe("buildEndpointTree — versioned hierarchy", () => {
  test("two versions build Version → Category → Endpoint, alphabetical", () => {
    const t = buildEndpointTree([
      ep("/v2/weather/current"),
      ep("/v1/weather/forecast"),
      ep("/v1/weather/current"),
      ep("/v2/weather/alerts"),
    ]);
    expect(t.hierarchical).toBe(true);

    // version nodes first, alphabetical/numeric
    expect(t.roots.map((n) => n.label)).toEqual(["v1", "v2"]);
    const v1 = findBranch(t.roots, "v1");
    expect(v1.kind).toBe("version");

    const weather = findBranch(v1.children, "weather");
    expect(weather.kind).toBe("group");
    expect(weather.leafCount).toBe(2);
    expect(weather.children.map((n) => n.label)).toEqual(["current", "forecast"]);
  });

  test("a single version is treated as a normal group, not a Version level", () => {
    const t = buildEndpointTree([
      ep("/v1/weather/current"),
      ep("/v1/weather/forecast"),
      ep("/v1/users/list"),
      ep("/v1/users/get"),
    ]);
    expect(t.hierarchical).toBe(true);
    const v1 = findBranch(t.roots, "v1");
    expect(v1.kind).toBe("group"); // not "version" — only one distinct version
  });

  test("numeric versions sort naturally (v2 before v10)", () => {
    const t = buildEndpointTree([
      ep("/v10/a/x"),
      ep("/v2/a/x"),
      ep("/v2/a/y"),
      ep("/v10/a/y"),
    ]);
    expect(t.roots.map((n) => n.label)).toEqual(["v2", "v10"]);
  });
});

describe("buildEndpointTree — params & shapes", () => {
  test("path params collapse for grouping but the full path is preserved", () => {
    const t = buildEndpointTree([
      ep("/users/{id}"),
      ep("/users/{id}/posts"),
      ep("/users/list"),
      ep("/users/search"),
    ]);
    expect(t.hierarchical).toBe(true);
    const users = findBranch(t.roots, "users");
    // {id} alone → leaf "users"? no: nonParam=[users] → leaf "users" under root.
    // /users/{id}/posts → nonParam=[users, posts] → group users, leaf posts.
    const labels = users.children.map((n) => n.label).sort();
    expect(labels).toContain("posts");
    expect(labels).toContain("list");
    expect(labels).toContain("search");
    // a leaf still carries its real, param-bearing path
    const posts = users.children.find((n) => n.label === "posts");
    expect(posts?.kind).toBe("leaf");
    if (posts?.kind === "leaf") {
      expect(posts.path).toBe("/users/{id}/posts");
    }
  });

  test("same path, different methods → sibling leaves", () => {
    const t = buildEndpointTree([
      ep("/v1/items/thing", "GET"),
      ep("/v1/items/thing", "POST"),
      ep("/v1/items/other", "GET"),
      ep("/v1/items/more", "GET"),
    ]);
    const items = findBranch(findBranch(t.roots, "v1").children, "items");
    const things = items.children.filter((n) => n.label === "thing");
    expect(things).toHaveLength(2);
    expect(things.map((n) => (n.kind === "leaf" ? n.method : "")).sort()).toEqual([
      "GET",
      "POST",
    ]);
  });

  test("title overrides the derived segment as the leaf label", () => {
    const t = buildEndpointTree([
      ep("/v1/w/current", "GET", "Current Weather"),
      ep("/v1/w/forecast", "GET", "Forecast"),
      ep("/v1/u/list", "GET", "List Users"),
      ep("/v1/u/get", "GET", "Get User"),
    ]);
    expect(t.flat.map((l) => l.label).sort()).toEqual([
      "Current Weather",
      "Forecast",
      "Get User",
      "List Users",
    ]);
  });
});

describe("buildEndpointTree — normalization & depth", () => {
  test("query strings, trailing slashes and full URLs normalize to the same shape", () => {
    const t = buildEndpointTree([
      ep("/v1/weather/current?lat=1&lon=2"),
      ep("https://api.example.com/v1/weather/forecast/"),
      ep("/v1/weather/alerts"),
      ep("/v1/weather/radar"),
    ]);
    const weather = findBranch(findBranch(t.roots, "v1").children, "weather");
    expect(weather.children.map((n) => n.label).sort()).toEqual([
      "alerts",
      "current",
      "forecast",
      "radar",
    ]);
  });

  test("paths deeper than maxDepth fold the tail into the leaf label", () => {
    const t = buildEndpointTree([
      ep("/a/b/c/d"),
      ep("/a/b/c/e"),
      ep("/a/b/f/g"),
      ep("/a/b/f/h"),
    ]);
    // maxDepth=2 → groups capped to [a, b]; the remaining "c/d" etc fold
    // into the leaf label. Root-level "a" is never single-child compressed.
    const aNode = findBranch(t.roots, "a");
    const bNode = findBranch(aNode.children, "b");
    expect(bNode.children.map((n) => n.label).sort()).toEqual([
      "c/d",
      "c/e",
      "f/g",
      "f/h",
    ]);
  });

  test("payload round-trips untouched", () => {
    const t = buildEndpointTree([
      ep("/v1/a/x"),
      ep("/v1/a/y"),
      ep("/v1/b/z"),
      ep("/v1/b/w"),
    ]);
    for (const leaf of t.flat) {
      expect(leaf.payload).toEqual({ path: leaf.path, method: leaf.method });
    }
  });
});

describe("buildEndpointTree — single-child chain compression", () => {
  test("non-root single-child branch chains compress into one label", () => {
    // maxDepth=3 so the structure isn't folded into leaves. "users" has a
    // single child branch "profile" → compressed to "users/profile".
    // (Root-level "api" is never compressed.)
    const t = buildEndpointTree(
      [
        ep("/api/users/profile/get"),
        ep("/api/users/profile/update"),
        ep("/api/orders/list"),
        ep("/api/orders/create"),
      ],
      { maxDepth: 3 },
    );
    const api = findBranch(t.roots, "api");
    const labels = api.children.map((n) => n.label);
    expect(labels).toContain("users/profile");
    expect(labels).toContain("orders");
  });
});
