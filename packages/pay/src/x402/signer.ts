/**
 * Buyer-side EIP-3009 signer — the concrete {@link X402Signer} that
 * {@link x402Payer} delegates to.
 *
 * Builds the `TransferWithAuthorization` EIP-712 typed data from the offer's
 * payment requirements and hands it to an injected account for signing. The
 * account is structurally viem's `LocalAccount` (`{ address, signTypedData }`),
 * so a viem account drops straight in; wrap other libraries (ethers v6:
 * `{ address, signTypedData: (p) => wallet.signTypedData(p.domain, p.types, p.message) }`)
 * in a one-line adapter. No on-chain dependency is pulled in.
 */

import { randomBytes } from "node:crypto";
import type { X402PaymentPayload, X402Requirements } from "../rails/x402";
import type { X402Signer } from "../payers/x402";

/** EIP-712 typed-data signing surface; structurally matches viem's `LocalAccount`. */
export interface Eip712Account {
  /** The buyer's address (the `from` of the authorization). */
  address: string;
  signTypedData(parameters: {
    domain: { name: string; version: string; chainId: number; verifyingContract: string };
    types: Record<string, Array<{ name: string; type: string }>>;
    primaryType: "TransferWithAuthorization";
    message: Record<string, unknown>;
  }): Promise<string>;
}

/** x402 network name → EVM chain id, for the networks the ecosystem uses today. */
const CHAIN_IDS: Record<string, number> = {
  base: 8453,
  "base-sepolia": 84532,
  avalanche: 43114,
  "avalanche-fuji": 43113,
  ethereum: 1,
  sepolia: 11155111,
  polygon: 137,
  "polygon-amoy": 80002,
};

const TRANSFER_WITH_AUTHORIZATION = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
];

export interface Eip3009SignerOptions {
  /** The signing account (viem `LocalAccount`-shaped). */
  account: Eip712Account;
  /** Extra/override network → chainId entries, merged over the built-ins. */
  chainIds?: Record<string, number>;
  /** Clock, for tests. Returns Unix seconds. */
  now?: () => number;
}

/** Build an {@link X402Signer} that signs EIP-3009 `transferWithAuthorization` payloads. */
export function eip3009Signer(options: Eip3009SignerOptions): X402Signer {
  if (!options.account) throw new Error("eip3009Signer: `account` is required");
  const chainIds = { ...CHAIN_IDS, ...options.chainIds };
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));

  return {
    async authorize(requirements: X402Requirements): Promise<X402PaymentPayload> {
      const chainId = chainIds[requirements.network];
      if (chainId === undefined) {
        throw new Error(
          `eip3009Signer: unknown network "${requirements.network}" — pass its chain id via \`chainIds\``,
        );
      }

      // Token domain name/version ride in requirements.extra (the seller knows
      // its token); USDC's canonical values are the fallback.
      const extra = (requirements.extra ?? {}) as { name?: string; version?: string };
      const domain = {
        name: extra.name ?? "USD Coin",
        version: extra.version ?? "2",
        chainId,
        verifyingContract: requirements.asset,
      };

      const authorization = {
        from: options.account.address,
        to: requirements.payTo,
        value: requirements.maxAmountRequired,
        validAfter: "0", // valid immediately; expiry is what bounds the window
        validBefore: String(now() + Math.max(requirements.maxTimeoutSeconds, 60)),
        nonce: `0x${randomBytes(32).toString("hex")}`,
      };

      const signature = await options.account.signTypedData({
        domain,
        types: { TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION },
        primaryType: "TransferWithAuthorization",
        message: {
          ...authorization,
          // uint256 fields are signed as bigints; the JSON payload keeps strings.
          value: BigInt(authorization.value),
          validAfter: BigInt(authorization.validAfter),
          validBefore: BigInt(authorization.validBefore),
        },
      });

      return {
        x402Version: 1,
        scheme: requirements.scheme,
        network: requirements.network,
        payload: { signature, authorization },
      };
    },
  };
}
