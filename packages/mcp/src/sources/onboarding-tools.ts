/**
 * Conversational onboarding tools (GR-N3; onboarding-v2 design D5/D6/D9):
 *
 * - `create_workspace` — secret-free workspace creation from chat. Never
 *   takes wallet fields; the trial clock only starts at first publish, so
 *   an empty workspace is free and reversible.
 * - `connect_wallet` — browser handoff: secrets (NWC strings, macaroons)
 *   are entered on the dashboard payouts page, never in chat. The tool
 *   only ever reports connected yes/no.
 * - `get_onboarding_state` — the read-only glue that lets the agent drive
 *   the whole flow: workspace → wallet → draft → protect → publish.
 */

import { SITE_URL, getGatewayUrl } from "@bolthub/shared";
import { apiRequest } from "./node-tools.js";
import {
  requireAuth,
  resolveTenant,
  errorResult,
  textResult,
  type TenantRow,
} from "./seller-tools.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const DEFAULT_API_URL = "https://api.bolthub.ai";
/** get_onboarding_state actively probes origins; keep the fan-out small. */
const STATE_ORIGIN_CHECK_CAP = 2;

/**
 * Wallet guidance follows the standing order: LND primary, NWC easiest.
 * NWC must be an ALWAYS-ON service: the gateway mints invoices through
 * this connection whenever a buyer pays, so phone wallets (their wallet
 * service dies with the app) are a buyer-side tool, never a payout wallet.
 */
const WALLET_GUIDANCE = [
  "Wallet options on that page:",
  "- LND (recommended): your own node — self-sovereign, best for real volume. No node yet? Ask me to deploy one (deploy_node).",
  "- NWC (easiest): one-click from an always-on wallet service — Alby Hub or CoinOS. Phone wallets (Zeus, Alby Go) go offline when the app closes, and buyers can't pay while your wallet is unreachable.",
  "- LNbits (alternative): instance URL + admin key.",
].join("\n");

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 63);
}

async function isSlugFree(baseUrl: string, token: string, slug: string): Promise<boolean> {
  const res = await apiRequest<{ available: boolean }>(
    baseUrl,
    `/tenants/check-slug?slug=${encodeURIComponent(slug)}`,
    { token },
  );
  return res.available;
}

export async function handleCreateWorkspace(
  args: { name: string; slug?: string; description?: string; tags?: string[]; wallet_node_id?: string },
  apiUrl?: string,
  authToken?: string,
): Promise<ToolResult> {
  const baseUrl = apiUrl ?? DEFAULT_API_URL;
  const authError = requireAuth(authToken);
  if (authError) return authError;

  if (!args.name?.trim()) {
    return errorResult("Provide a workspace name.");
  }

  try {
    let slug: string;
    if (args.slug) {
      // User-stated slug: taken is an error, not something to silently mutate.
      if (!(await isSlugFree(baseUrl, authToken!, args.slug))) {
        return errorResult(
          `The slug "${args.slug}" is already taken. Pick another (lowercase letters, digits, hyphens; 3-63 chars).`,
        );
      }
      slug = args.slug;
    } else {
      const base = slugify(args.name);
      if (base.length < 3) {
        return errorResult(
          "Couldn't derive a valid slug from that name (needs at least 3 slug-safe characters). Pass slug explicitly.",
        );
      }
      const candidates = [base, ...Array.from({ length: 4 }, (_, i) => `${base}-${i + 2}`)];
      let found: string | undefined;
      for (const candidate of candidates) {
        if (await isSlugFree(baseUrl, authToken!, candidate)) {
          found = candidate;
          break;
        }
      }
      if (!found) {
        return errorResult(
          `"${base}" and its numbered variants are all taken. Re-run with an explicit slug.`,
        );
      }
      slug = found;
    }

    // The create response also carries the workspace's gateway/HMAC secrets
    // for the dashboard's onboarding UI. They must never reach the chat, so
    // only the safe fields below are ever read out of it.
    const { tenant } = await apiRequest<{ tenant: TenantRow }>(baseUrl, "/tenants", {
      method: "POST",
      body: {
        name: args.name.trim(),
        slug,
        description: args.description,
        tags: args.tags,
      },
      token: authToken,
    });

    const head = [
      `Workspace "${tenant.name}" created (slug: ${tenant.slug}).`,
      `Gateway domain reserved: ${getGatewayUrl(tenant.slug, "/")}`,
      "",
      "It's free while empty — the 30-day trial only starts when you publish a first endpoint.",
    ];

    // Bind a deployed node as the payout wallet in the same call when the
    // caller passed one. Best-effort: a bind failure leaves the (already
    // created) workspace walletless rather than failing the whole create.
    if (args.wallet_node_id) {
      try {
        const bind = await apiRequest<{ connected: boolean; node?: NodeCapacity }>(
          baseUrl,
          `/nodes/${args.wallet_node_id}/connect-wallet`,
          { method: "POST", body: { tenantId: tenant.id }, token: authToken },
        );
        head.push(
          "",
          `Node ${args.wallet_node_id} is now the payout wallet (LND via Node Launcher, invoice-only macaroon copied server-side — nothing touched this chat).`,
        );
        const warning = nodeCapacityWarning(bind.node);
        if (warning) head.push(...warning);
        head.push("", "Next: list_api to draft your listing.");
        return textResult(head.join("\n"));
      } catch (bindErr) {
        head.push(
          "",
          `Workspace created, but binding node ${args.wallet_node_id} failed: ${bindErr instanceof Error ? bindErr.message : String(bindErr)}. Connect a wallet later with connect_wallet.`,
        );
        return textResult(head.join("\n"));
      }
    }

    // No node passed: if the account already has a ready node, point at it so
    // the agent can offer a one-call bind. A wallet stays optional until a
    // paid endpoint is published, so this is a suggestion, never a blocker.
    let walletHint =
      "Next: connect_wallet so payouts have somewhere to land, then list_api to draft your listing.";
    try {
      const { nodes } = await apiRequest<{ nodes: NodeRow[] }>(baseUrl, "/nodes", {
        token: authToken,
      });
      const bindable = nodes.filter((n) => n.status === "ready" && n.hasInvoicesMacaroon);
      if (bindable.length > 0) {
        walletHint =
          `Next: you already have a deployed node ready (${nodeLabel(bindable[0])}) — ` +
          `bind it as the payout wallet with connect_wallet node_id "${bindable[0].id}" ` +
          `(or re-create with wallet_node_id next time). Then list_api to draft your listing.`;
      }
    } catch {
      // Node lookup is advisory — never fail create over it.
    }

    head.push("", "A wallet is optional until you publish a paid endpoint; then it's required.", walletHint);
    return textResult(head.join("\n"));
  } catch (err) {
    return errorResult(
      `create_workspace failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

interface NodeRow {
  id: string;
  name: string | null;
  status: string;
  provider: string;
  tenantId: string | null;
  hasInvoicesMacaroon: boolean;
  /** From the capacity sweep (node-provisioning job); null = not measured yet. */
  activeChannelCount?: number | null;
  receivingCapacitySat?: number | null;
}

const nodeLabel = (n: NodeRow) => `${n.id}${n.name ? ` "${n.name}"` : ""} (${n.provider})`;

interface NodeCapacity {
  activeChannelCount?: number | null;
  receivingCapacitySat?: number | null;
}

/**
 * Reachable is NOT payable (smoke-test finding H1): a channel-less node
 * answers every REST probe and cannot receive a single sat. Returns the
 * warning block for a node with zero channels / zero inbound capacity,
 * a "not measured yet" note when the sweep hasn't run, or null when the
 * node genuinely can receive.
 */
export function nodeCapacityWarning(cap: NodeCapacity | undefined): string[] | null {
  if (!cap) return null;
  if (cap.activeChannelCount === 0 || cap.receivingCapacitySat === 0) {
    const reason =
      cap.activeChannelCount === 0
        ? "it has NO CHANNELS"
        : "its channels have NO INBOUND CAPACITY left";
    return [
      `WARNING: this node is reachable but CANNOT RECEIVE PAYMENTS — ${reason}. Every buyer payment will fail with a raw Lightning routing error until it has inbound liquidity.`,
      "To fix, get an inbound channel:",
      "  - Open a channel TO this node from another node you control (instant inbound from your own liquidity), or",
      "  - Buy an inbound channel from an LSP via the node's Lightning Terminal (Loop/Pool).",
      "Either way the channel open needs on-chain confirmations (typically 10-60 min); re-check with node_status afterwards.",
    ];
  }
  if (cap.activeChannelCount == null) {
    return [
      "Note: this node's channel capacity hasn't been measured yet (the monitoring sweep runs every ~5 minutes). Check node_status before publishing — a node without an inbound channel cannot receive payments.",
    ];
  }
  return null;
}

/** In-chat steps for self-hosted LND: everything here is non-secret
 *  guidance; only the macaroon paste happens in the browser. */
const SELF_HOSTED_LND_STEPS = [
  "Self-hosted LND (Umbrel, Start9, RaspiBlitz, Voltage, …) — I can walk you through it:",
  "  1. Expose LND's REST API over HTTPS. Home node? A Cloudflare Tunnel pointed at the REST port gives you a stable https:// host without opening your firewall.",
  "  2. Bake an invoice-only macaroon (bolthub only mints and looks up invoices; never hand over admin.macaroon):",
  "     lncli bakemacaroon info:read invoices:read invoices:write",
  `  3. Paste the REST host + baked macaroon at ${SITE_URL}/payouts (the macaroon is a secret, so that step stays in the browser).`,
].join("\n");

export async function handleConnectWallet(
  args: { tenant_id?: string; node_id?: string },
  apiUrl?: string,
  authToken?: string,
): Promise<ToolResult> {
  const baseUrl = apiUrl ?? DEFAULT_API_URL;
  const authError = requireAuth(authToken);
  if (authError) return authError;

  try {
    const resolved = await resolveTenant(baseUrl, authToken!, args.tenant_id);
    if ("error" in resolved) return resolved.error;

    // Explicit bind request: copy the deployed node's invoice-only macaroon
    // into this workspace's wallet config. Entirely server-side — no secret
    // ever enters this chat (see /nodes/:id/connect-wallet).
    if (args.node_id) {
      const bind = await apiRequest<{ connected: boolean; node?: NodeCapacity }>(
        baseUrl,
        `/nodes/${args.node_id}/connect-wallet`,
        {
          method: "POST",
          body: { tenantId: resolved.tenant.id },
          token: authToken,
        },
      );
      const lines = [
        `Node ${args.node_id} is now the payout wallet for "${resolved.tenant.name}" (LND via Node Launcher, invoice-only macaroon, copied server-side — nothing touched this chat).`,
        "Payouts settle directly to your node.",
      ];
      const warning = nodeCapacityWarning(bind.node);
      if (warning) {
        lines.push("", ...warning);
      } else if (bind.node?.receivingCapacitySat != null) {
        lines.push(
          `Inbound capacity: ~${bind.node.receivingCapacitySat} sats across ${bind.node.activeChannelCount} active channel(s) — the node can receive payments.`,
        );
      }
      lines.push("", "Next: get_onboarding_state for the full picture.");
      return textResult(lines.join("\n"));
    }

    const { tenant } = await apiRequest<{
      tenant: TenantRow & {
        walletConnected?: boolean;
        walletProvider?: string | null;
        walletReachable?: boolean | null;
        walletLastCheckedAt?: string | null;
      };
    }>(baseUrl, `/tenants/${resolved.tenant.id}`, { token: authToken });

    if (tenant.walletConnected) {
      if (tenant.walletReachable === false) {
        return errorResult(
          [
            `Wallet for "${tenant.name}" is connected but UNREACHABLE (last check ${tenant.walletLastCheckedAt ? String(tenant.walletLastCheckedAt).slice(0, 16).replace("T", " ") : "recently"}). Buyers can't pay while it's dark — every request fails at invoice creation.`,
            "Most common cause: an NWC connection from a phone wallet whose app is closed. Fix on the payouts page — switch to an always-on service (Alby Hub, CoinOS) or a direct LND connection, then run a connection test.",
            `${SITE_URL}/payouts`,
          ].join("\n"),
        );
      }
      // walletReachable null = never swept yet (the wallet-health job runs
      // every 30 min) — say so rather than silently omitting the verdict.
      const reachNote =
        tenant.walletReachable === true
          ? " Reachability checks are passing."
          : " First reachability check runs within ~30 minutes."
      return textResult(
        `Wallet connected for "${tenant.name}"${tenant.walletProvider ? ` (${tenant.walletProvider})` : ""}.${reachNote} Payouts land directly in that wallet — bolthub never holds funds. Next: get_onboarding_state for the full picture.`,
      );
    }

    // Not connected: prefer a deployed node when one is ready to bind —
    // that's the strongest wallet and the only fully chat-native path.
    const { nodes } = await apiRequest<{ nodes: NodeRow[] }>(baseUrl, "/nodes", {
      token: authToken,
    });
    const bindable = nodes.filter((n) => n.status === "ready" && n.hasInvoicesMacaroon);

    if (bindable.length === 1) {
      const node = bindable[0];
      return textResult(
        [
          `You have a deployed node ready: ${nodeLabel(node)}${node.tenantId ? " (currently paying out another workspace — binding here will move it)" : ""}${node.activeChannelCount === 0 ? " — NOTE: it has no channels yet, so it can't receive payments until it gets inbound liquidity (node_status has the fix steps)" : ""}.`,
          `To make it the payout wallet for "${tenant.name}", re-run connect_wallet with node_id "${node.id}". The credential copy is server-side; no secrets enter this chat.`,
          "",
          "Prefer a different wallet? Options:",
          WALLET_GUIDANCE,
          "",
          SELF_HOSTED_LND_STEPS,
        ].join("\n"),
      );
    }
    if (bindable.length > 1) {
      return textResult(
        [
          `You have ${bindable.length} deployed nodes ready. Re-run connect_wallet with node_id set to one of:`,
          ...bindable.map((n) => `  ${nodeLabel(n)}${n.tenantId ? " — currently bound to another workspace" : ""}`),
        ].join("\n"),
      );
    }

    return textResult(
      [
        `No wallet connected for "${tenant.name}" yet. A wallet is optional until you publish a paid endpoint — then it's required (publishing a paid endpoint without one is blocked). Wallet credentials are secrets, so they're entered in the browser — never in this chat.`,
        "",
        `1. Open: ${SITE_URL}/payouts`,
        `2. Make sure "${tenant.name}" is the selected workspace`,
        "3. Connect a wallet:",
        WALLET_GUIDANCE,
        "",
        SELF_HOSTED_LND_STEPS,
        "",
        "No node and no wallet service? deploy_node spins up your own LND node in ~5 minutes, and I can bind it here afterwards.",
        "When you're done, run connect_wallet again and I'll confirm it took.",
      ].join("\n"),
    );
  } catch (err) {
    return errorResult(
      `connect_wallet failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

interface StateEndpointRow {
  id: string;
  path: string;
  method: string;
  isActive: boolean;
  directoryListed: boolean;
  originId: string | null;
  origin?: { id: string; baseUrl: string } | null;
  pricingRules?: Array<{ pricingModel: string; priceSats: number }>;
}

export async function handleGetOnboardingState(
  args: { tenant_id?: string },
  apiUrl?: string,
  authToken?: string,
): Promise<ToolResult> {
  const baseUrl = apiUrl ?? DEFAULT_API_URL;
  const authError = requireAuth(authToken);
  if (authError) return authError;

  try {
    const resolved = await resolveTenant(baseUrl, authToken!, args.tenant_id);
    if ("error" in resolved) return resolved.error;

    const [{ tenant }, { endpoints }] = await Promise.all([
      apiRequest<{
        tenant: TenantRow & {
          walletConnected?: boolean;
          walletReachable?: boolean | null;
          walletConnectionMethod?: string | null;
        };
      }>(
        baseUrl,
        `/tenants/${resolved.tenant.id}`,
        { token: authToken },
      ),
      apiRequest<{ endpoints: StateEndpointRow[] }>(
        baseUrl,
        `/tenants/${resolved.tenant.id}/endpoints`,
        { token: authToken },
      ),
    ]);

    // A node-backed wallet can be reachable and still unable to receive
    // (zero channels / zero inbound). Pull the bound node's swept capacity
    // so the checklist reports payable, not just reachable (H1).
    let boundNode: NodeRow | undefined;
    if (tenant.walletConnected && tenant.walletConnectionMethod === "node_launcher") {
      try {
        const { nodes } = await apiRequest<{ nodes: NodeRow[] }>(baseUrl, "/nodes", {
          token: authToken,
        });
        boundNode = nodes.find((n) => n.tenantId === tenant.id);
      } catch {
        // Capacity is advisory here — never fail the whole state read for it.
      }
    }
    const nodeNotPayable =
      boundNode != null &&
      (boundNode.activeChannelCount === 0 || boundNode.receivingCapacitySat === 0);

    const drafts = endpoints.filter((e) => !e.directoryListed);
    const published = endpoints.filter((e) => e.directoryListed && e.isActive);
    const unpriced = endpoints.filter((e) => !e.pricingRules?.length);
    // Paid drafts + no wallet = the paid-publish gate (UR-68) would block a
    // publish_listing. Surface it so the agent connects a wallet first.
    const paidDrafts = drafts.filter((e) => (e.pricingRules?.length ?? 0) > 0);
    const gateWouldTrip = !tenant.walletConnected && paidDrafts.length > 0;
    const live = published.length > 0 && tenant.status === "active" && tenant.directoryListed;

    // Origin protection: probe up to the cap, worst verdict wins.
    const originIds = [...new Set(endpoints.map((e) => e.originId).filter((id): id is string => !!id))];
    let protection = "no origins yet";
    let protectionBad = false;
    if (originIds.length > 0) {
      const verdicts: string[] = [];
      for (const originId of originIds.slice(0, STATE_ORIGIN_CHECK_CAP)) {
        const { check } = await apiRequest<{ check: { verdict: string } }>(
          baseUrl,
          `/tenants/${tenant.id}/origins/${originId}/check`,
          { method: "POST", token: authToken },
        );
        verdicts.push(check.verdict);
      }
      const worstOrder = ["broken", "public", "unreachable", "inconclusive", "protected"];
      const worst = verdicts.sort((a, b) => worstOrder.indexOf(a) - worstOrder.indexOf(b))[0];
      protection = originIds.length > STATE_ORIGIN_CHECK_CAP ? `${worst} (first ${STATE_ORIGIN_CHECK_CAP} origins probed)` : worst;
      protectionBad = worst === "public" || worst === "broken" || worst === "unreachable";
    }

    const mark = (ok: boolean, warn = false) => (ok ? "[x]" : warn ? "[!]" : "[ ]");
    const lines = [
      `Onboarding state — "${tenant.name}" (${tenant.slug})`,
      "",
      `${mark(true)} Workspace created`,
      tenant.walletConnected && tenant.walletReachable === false
        ? `${mark(false, true)} Wallet connected but UNREACHABLE (buyers can't pay)`
        : nodeNotPayable
          ? `${mark(false, true)} Wallet connected (bolthub node) but NOT PAYABLE — ${boundNode!.activeChannelCount === 0 ? "the node has no channels" : "no inbound capacity"}, so buyers can't pay`
          : `${mark(!!tenant.walletConnected)} Wallet connected${tenant.walletReachable === true ? " (reachability checks passing)" : ""}${boundNode?.receivingCapacitySat ? ` (~${boundNode.receivingCapacitySat} sats inbound capacity)` : ""}`,
      `${mark(endpoints.length > 0)} Endpoints: ${drafts.length} draft, ${published.length} published${unpriced.length > 0 ? ` (${unpriced.length} UNPRICED)` : ""}`,
      `${mark(!protectionBad && originIds.length > 0, protectionBad)} Origin protection: ${protection}`,
      `${mark(live)} Listing live in the directory`,
      "",
      `Trial: ${tenant.trialEndsAt ? `ends ${String(tenant.trialEndsAt).slice(0, 10)}` : "not started (starts at first publish)"}`,
    ];

    let next: string;
    if (tenant.walletConnected && tenant.walletReachable === false)
      next = "fix the payout wallet — it's unreachable, so every buyer payment fails at invoice creation (connect_wallet has the details).";
    else if (nodeNotPayable)
      next = `get an inbound channel on node ${boundNode!.id} — it's reachable but can't receive a sat (open a channel to it from another node, or buy inbound via its Lightning Terminal; node_status has the steps).`;
    else if (!tenant.walletConnected)
      next = gateWouldTrip
        ? `connect_wallet — ${paidDrafts.length} paid draft endpoint(s) can't be published until a wallet is connected (the publish is blocked otherwise).`
        : "connect_wallet — payouts need somewhere to land.";
    else if (endpoints.length === 0) next = "list_api with your OpenAPI/Postman spec to draft the listing.";
    else if (protectionBad)
      next = "fix origin protection (analyze_listing has the evidence; no-code recipes: https://docs.bolthub.ai/docs/guides/origin-protection#no-code-platform-recipes).";
    else if (unpriced.length > 0) next = "set pricing on the unpriced endpoints (dashboard → Endpoints), then publish_listing.";
    else if (!live) next = "analyze_listing for a final audit, then publish_listing to go live.";
    else next = "you're live — get_earnings and usage_summary track how it's doing.";
    lines.push(`Next: ${next}`);

    return textResult(lines.join("\n"));
  } catch (err) {
    return errorResult(
      `get_onboarding_state failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
