import { normalizeAddress } from "../utils.mjs";
import { PonsV2CurveObserverAdapter } from "./pons-v2-adapter.mjs";
import { AdapterSkip, UniswapV2ObserverAdapter } from "./uniswap-v2-adapter.mjs";

export class MainnetObserverAdapter {
  constructor({ adapters } = {}) {
    this.id = "lintcha-mainnet-observer-chain-4663-v1";
    this.adapters = adapters ?? [new UniswapV2ObserverAdapter(), new PonsV2CurveObserverAdapter()];
  }

  decode(fixture, targetWallet) {
    const destination = normalizeAddress(fixture?.transaction?.to);
    const candidate = this.adapters.find((adapter) => {
      if (adapter instanceof UniswapV2ObserverAdapter) return destination === "0x89e5db8b5aa49aa85ac63f691524311aeb649eba";
      if (adapter instanceof PonsV2CurveObserverAdapter) {
        const curve = fixture?.context?.ponsV2Launch?.curve;
        return typeof curve === "string" && normalizeAddress(curve) === destination;
      }
      return false;
    });
    if (!candidate) throw new AdapterSkip("UNSUPPORTED_VENUE", destination);
    return candidate.decode(fixture, targetWallet);
  }
}
