// Minimal ambient types for the `macaroon` package (rogpeppe's js-macaroon),
// which ships no .d.ts. Only the surface delegate.ts (and its test) uses.
declare module "macaroon" {
  export interface MacaroonCaveat {
    identifier: Uint8Array;
    location?: string;
    vid?: Uint8Array;
  }
  export interface Macaroon {
    addFirstPartyCaveat(caveatId: string | Uint8Array): void;
    exportBinary(): Uint8Array;
    exportJSON(): unknown;
    readonly location?: string;
    readonly identifier: Uint8Array;
    readonly signature: Uint8Array;
    readonly caveats: MacaroonCaveat[];
  }
  export function importMacaroon(data: Uint8Array): Macaroon;
  export function newMacaroon(opts: {
    version: number;
    rootKey: Uint8Array | string;
    identifier: Uint8Array | string;
    location?: string;
  }): Macaroon;
}
