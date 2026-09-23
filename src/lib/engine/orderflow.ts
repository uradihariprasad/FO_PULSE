/**
 * ORDER FLOW DOMINANCE engine — fully additive, independent module.
 *
 * Computes a BUYER-DOMINANCE and SELLER-DOMINANCE score (0-100) per symbol
 * from REAL Upstox data already flowing through the scanner:
 *   - top-5 bid/ask depth quantities & order counts (batch quote feed)
 *   - total buy/sell quantities (batch quote feed)
 *   - 1-minute candle caches, price snapshot rings
 *   - existing Stage-1 metrics (RVOL / RS / RS-acceleration / VWAP / trend)
 *   - existing futures positioning interpretation (price + OI)
 *
 * It makes NO additional Upstox requests and does not touch the existing
 * Stage 1 -> Stage 2 -> Top-10 pipeline in any way.
 * Data integrity: missing values stay null (N/A); stale data is excluded
 * from ranked output; no zero-substitution anywhere.
 */

import type { FullMarketQuote } from "@/lib/upstox/types";
import type { Candle, ScannerConfig, Stage1Metrics } from "./types";
import type { PriceSnap } from "./stage1";
import { clamp } from "./indicators";

export type DominanceTrend =
  | "ACCELERATING"
  | "WEAKENING"
  | "STABLE"
  | "REVERSING"
  | "UNAVAILABLE";

export type DominanceBand = "VERY STRONG" | "STRONG" | "MODERATE" | "BELOW THRESHOLD";

export interface FlowComponent {
  key: string;
  label: string;
  weight: number;
  buyerValue: number | null; // 0-100 towards buyer dominance
  sellerValue: number | null; // 0-100 towards seller dominance
  evidence: string; // raw real figures, e.g. "bid 8.2L / ask 6.9L"
}

export interface OrderFlowResult {
  symbol: string;
  computedAt: string;
  buyerScore: number;
  sellerScore: number;
  buyerConfidence: "HIGH" | "MEDIUM" | "LOW";
  sellerConfidence: "HIGH" | "MEDIUM" | "LOW";
  buyerBand: DominanceBand;
  sellerBand: DominanceBand;
  buyerTrend: DominanceTrend;
  sellerTrend: DominanceTrend;
  conflictingFlow: boolean;
  components: FlowComponent[];
  alignedForBuyer: number;
  alignedForSeller: number;
  conflictCount: number;
  coveragePct: number; // components availability 0-100
  dataFresh: boolean; // false => excluded from ranking
  dataStatus: string;
  rankable: boolean;
  notes: string[];
}

/* ------------------------------ small helpers ---------------------------- */

function fmtQty(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "N/A";
  if (n >= 1e7) return `${(n / 1e7).toFixed(2)} Cr`;
  if (n >= 1e5) return `${(n / 1e5).toFixed(2)} L`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} K`;
  return `${Math.round(n)}`;
}

export function bandOf(score: number): DominanceBand {
  if (score >= 80) return "VERY STRONG";
  if (score >= 70) return "STRONG";
  if (score >= 60) return "MODERATE";
  return "BELOW THRESHOLD";
}

/* ----------------------------- main calculator ---------------------------- */

export interface OrderFlowInput {
  symbol: string;
  eq: FullMarketQuote | null;
  metrics: Stage1Metrics;
  ring: PriceSnap[];
  candles1m: Candle[] | null;
  config: ScannerConfig;
  now: number;
  history: { ts: number; buyer: number; seller: number }[];
}

export function computeOrderFlow(input: OrderFlowInput): OrderFlowResult {
  const { eq, metrics, config } = input;
  const notes: string[] = [];
  const components: FlowComponent[] = [];
  const ltp = metrics.ltp;

  /* ------------------ depth imbalance (weight 20) ------------------ */
  {
    const buy = eq?.depth?.buy ?? [];
    const sell = eq?.depth?.sell ?? [];
    const bidQty = buy.reduce((a, d) => a + (d.quantity || 0), 0);
    const askQty = sell.reduce((a, d) => a + (d.quantity || 0), 0);
    if (buy.length + sell.length > 0 && bidQty + askQty > 0) {
      const imb = (bidQty - askQty) / (bidQty + askQty); // -1..1, real
      const buyerV = clamp(50 + imb * 50, 0, 100);
      components.push({
        key: "depth",
        label: "Depth imbalance",
        weight: 20,
        buyerValue: buyerV,
        sellerValue: 100 - buyerV,
        evidence: `bid ${fmtQty(bidQty)} / ask ${fmtQty(askQty)} (top-5 levels)`,
      });
    } else {
      components.push({ key: "depth", label: "Depth imbalance", weight: 20, buyerValue: null, sellerValue: null, evidence: "depth N/A" });
    }
  }

  /* ------------------ order-count imbalance (weight 10) ------------------ */
  {
    const buy = eq?.depth?.buy ?? [];
    const sell = eq?.depth?.sell ?? [];
    const bidOrders = buy.reduce((a, d) => a + (d.orders || 0), 0);
    const askOrders = sell.reduce((a, d) => a + (d.orders || 0), 0);
    const tbq = typeof eq?.total_buy_quantity === "number" ? eq!.total_buy_quantity! : null;
    const tsq = typeof eq?.total_sell_quantity === "number" ? eq!.total_sell_quantity! : null;
    if (bidOrders + askOrders > 0) {
      const imb = (bidOrders - askOrders) / (bidOrders + askOrders);
      const buyerV = clamp(50 + imb * 50, 0, 100);
      const support =
        tbq != null && tsq != null && tbq + tsq > 0
          ? ` · totals ${fmtQty(tbq)}/${fmtQty(tsq)}`
          : "";
      components.push({
        key: "orders",
        label: "Order-count imbalance",
        weight: 10,
        buyerValue: buyerV,
        sellerValue: 100 - buyerV,
        evidence: `${bidOrders} vs ${askOrders} orders${support}`,
      });
    } else {
      components.push({
        key: "orders",
        label: "Order-count imbalance",
        weight: 10,
        buyerValue: null,
        sellerValue: null,
        evidence: tbq != null && tsq != null ? `totals ${fmtQty(tbq)}/${fmtQty(tsq)} · depth orders N/A` : "order data N/A",
      });
    }
  }

  /* ------------------ price-action pressure (weight 20) ------------------ */
  {
    let used = 0;
    let sum = 0;
    let wsum = 0;
    const ev: string[] = [];

    // intraday range position
    if (metrics.dayHigh != null && metrics.dayLow != null && ltp != null && metrics.dayHigh > metrics.dayLow) {
      const rangePos = ((ltp - metrics.dayLow) / (metrics.dayHigh - metrics.dayLow)) * 100;
      sum += rangePos * 0.4;
      wsum += 0.4;
      used++;
      ev.push(`range ${Math.round(rangePos)}%`);
      if (metrics.dayHigh - ltp <= ltp * 0.003) ev.push("near day high");
      if (ltp - metrics.dayLow <= ltp * 0.003) ev.push("near day low");
    }
    // short-term returns
    if (metrics.return5mPct != null || metrics.return15mPct != null) {
      const r5 = metrics.return5mPct ?? 0;
      const r15 = metrics.return15mPct ?? 0;
      const retScore = clamp(50 + r5 * 45 + r15 * 28, 0, 100);
      sum += retScore * 0.35;
      wsum += 0.35;
      used++;
      ev.push(`5m ${r5 >= 0 ? "+" : ""}${r5.toFixed(2)}% 15m ${r15 >= 0 ? "+" : ""}${r15.toFixed(2)}%`);
    }
    // candle direction from real 1-min bars
    const cs = input.candles1m;
    if (cs && cs.length >= 8) {
      const last10 = cs.slice(-10);
      const ups = last10.filter((c) => c.c > c.o).length;
      const closeScore = (ups / last10.length) * 100;
      sum += closeScore * 0.15;
      wsum += 0.15;
      used++;
      ev.push(`${ups}/${last10.length} up-candles`);
    }
    // price acceleration from Stage-1 snapshot returns
    if (metrics.priceAccel != null) {
      const a = clamp(50 + metrics.priceAccel * 60, 0, 100);
      sum += a * 0.1;
      wsum += 0.1;
      used++;
    }
    if (used >= 2) {
      const buyerV = clamp(sum / wsum, 0, 100);
      components.push({
        key: "price",
        label: "Price pressure",
        weight: 20,
        buyerValue: buyerV,
        sellerValue: 100 - buyerV,
        evidence: ev.join(" · ") || "N/A",
      });
    } else {
      components.push({ key: "price", label: "Price pressure", weight: 20, buyerValue: null, sellerValue: null, evidence: "INSUFFICIENT intraday data" });
    }
  }

  /* ------------------ volume / RVOL (weight 15, direction-neutral) ------------------ */
  {
    if (metrics.rvol != null) {
      const v = clamp((metrics.rvol / (2 * config.rvolThreshold)) * 100, 0, 100);
      components.push({
        key: "rvol",
        label: "Volume / RVOL",
        weight: 15,
        buyerValue: v,
        sellerValue: v,
        evidence: `RVOL ${metrics.rvol.toFixed(2)}x${metrics.dayVolume != null ? ` · day vol ${fmtQty(metrics.dayVolume)}` : ""}`,
      });
    } else {
      components.push({ key: "rvol", label: "Volume / RVOL", weight: 15, buyerValue: null, sellerValue: null, evidence: "RVOL N/A" });
    }
  }

  /* ------------------ futures positioning (weight 20) ------------------ */
  {
    const sig = metrics.futures.signal;
    if (sig === "UNAVAILABLE") {
      components.push({ key: "futures", label: "Futures positioning", weight: 20, buyerValue: null, sellerValue: null, evidence: "UNAVAILABLE" });
    } else if (sig === "NEUTRAL") {
      components.push({ key: "futures", label: "Futures positioning", weight: 20, buyerValue: 50, sellerValue: 50, evidence: "AMBIGUOUS (insignificant price/OI move)" });
    } else {
      const table: Record<string, [number, number, string]> = {
        LONG_BUILDUP: [95, 15, "long-buildup characteristics (price + OI rising)"],
        SHORT_BUILDUP: [15, 95, "short-buildup characteristics (price falling, OI rising)"],
        SHORT_COVERING: [72, 30, "short-covering characteristics (price rising, OI falling)"],
        LONG_UNWINDING: [28, 72, "long-unwinding characteristics (price + OI falling)"],
      };
      const [bv, sv, txt] = table[sig] ?? [50, 50, sig];
      const d: string[] = [txt];
      if (metrics.futures.priceChangePct != null) d.push(`price ${metrics.futures.priceChangePct >= 0 ? "+" : ""}${metrics.futures.priceChangePct.toFixed(2)}%`);
      if (metrics.futures.oiChange != null) d.push(`ΔOI ${metrics.futures.oiChange >= 0 ? "+" : ""}${fmtQty(metrics.futures.oiChange)}`);
      components.push({ key: "futures", label: "Futures positioning", weight: 20, buyerValue: bv, sellerValue: sv, evidence: d.join(" · ") });
    }
  }

  /* ------------------ VWAP persistence (weight 10) ------------------ */
  let vwapFlips = 999; // unknown — treated as unstable for confidence
  {
    const vwap = metrics.vwap;
    if (vwap != null && ltp != null && input.ring.length >= 4) {
      const window = input.ring.slice(-20);
      let above = 0;
      let flips = 0;
      let prevSide: boolean | null = null;
      for (const s of window) {
        const isAbove = s.ltp >= vwap;
        if (isAbove) above++;
        if (prevSide !== null && isAbove !== prevSide) flips++;
        prevSide = isAbove;
      }
      vwapFlips = flips;
      const frac = above / window.length;
      const buyerV = clamp(frac * 100 * 0.9 + (ltp >= vwap ? 10 : 0), 0, 100);
      components.push({
        key: "vwap",
        label: "VWAP persistence",
        weight: 10,
        buyerValue: buyerV,
        sellerValue: 100 - buyerV,
        evidence: `${Math.round(frac * 100)}% of last snapshots above VWAP · ${flips} crossings`,
      });
      if (flips >= 5) notes.push("frequent VWAP crossings — conviction reduced");
    } else {
      components.push({ key: "vwap", label: "VWAP persistence", weight: 10, buyerValue: null, sellerValue: null, evidence: "VWAP/snapshots N/A" });
    }
  }

  /* ------------------ momentum acceleration (weight 5) ------------------ */
  {
    if (metrics.rsAccelPct != null) {
      const buyerV = clamp(50 + metrics.rsAccelPct * 60, 0, 100);
      components.push({
        key: "accel",
        label: "Momentum acceleration",
        weight: 5,
        buyerValue: buyerV,
        sellerValue: 100 - buyerV,
        evidence: `RS accel ${metrics.rsAccelPct >= 0 ? "+" : ""}${metrics.rsAccelPct.toFixed(2)}%`,
      });
    } else {
      components.push({ key: "accel", label: "Momentum acceleration", weight: 5, buyerValue: null, sellerValue: null, evidence: "N/A" });
    }
  }

  /* --------------------- scoring with coverage dampening ------------------- */
  const totalW = components.reduce((a, c) => a + c.weight, 0);
  const scoreFor = (side: "buyer" | "seller") => {
    let wsum = 0;
    let acc = 0;
    for (const c of components) {
      const v = side === "buyer" ? c.buyerValue : c.sellerValue;
      if (v == null) continue;
      wsum += c.weight;
      acc += c.weight * v;
    }
    if (wsum === 0) return { score: 0, coverage: 0 };
    const coverage = wsum / totalW;
    const base = acc / wsum;
    return { score: Math.round(base * Math.sqrt(coverage)), coverage };
  };
  const buy = scoreFor("buyer");
  const sell = scoreFor("seller");
  const buyerScore = buy.score;
  const sellerScore = sell.score;
  const coveragePct = Math.round(Math.max(buy.coverage, sell.coverage) * 100);

  /* ------------------- signal agreement & conflict logic ------------------- */
  const directional = components.filter((c) => c.key !== "rvol");
  const alignedForBuyer = directional.filter((c) => c.buyerValue != null && c.buyerValue >= 62).length;
  const alignedForSeller = directional.filter((c) => c.sellerValue != null && c.sellerValue >= 62).length;
  // count only MATERIAL contradictions (firmly opposing evidence, ≤28)
  const conflictFor = (side: "buyer" | "seller") =>
    directional.filter((c) => {
      const v = side === "buyer" ? c.buyerValue : c.sellerValue;
      return v != null && v <= 28;
    }).length;
  const conflictCount = Math.max(conflictFor("buyer"), conflictFor("seller"));
  const conflictingFlow = conflictCount >= 2;
  if (conflictingFlow) notes.push("CONFLICTING FLOW — independent signals materially disagree");

  const cap = (score: number, aligned: number) => {
    let s = score;
    if (aligned >= 5) s = Math.min(100, s + 4); // broad agreement bonus
    if (conflictingFlow) s = Math.min(s, 55); // never rank conflicting flow
    return s;
  };
  const finalBuyer = cap(buyerScore, alignedForBuyer);
  const finalSeller = cap(sellerScore, alignedForSeller);

  /* ------------------------------ confidence ------------------------------ */
  const fresh = metrics.dataStatus === "LIVE" || metrics.dataStatus === "RECENT";
  const confFor = (side: "buyer" | "seller", aligned: number) => {
    const cov = side === "buyer" ? buy.coverage : sell.coverage;
    if (!fresh) return "LOW" as const;
    if (conflictingFlow) return "LOW" as const;
    if (cov >= 0.75 && aligned >= 4 && vwapFlips <= 4) return "HIGH" as const;
    if (cov >= 0.5 && aligned >= 3) return "MEDIUM" as const;
    return "LOW" as const;
  };
  const buyerConfidence = confFor("buyer", alignedForBuyer);
  const sellerConfidence = confFor("seller", alignedForSeller);

  /* ------------------------------ trend from history ----------------------- */
  const trendOf = (hist: number[]): DominanceTrend => {
    if (hist.length < 3) return hist.length < 2 ? "UNAVAILABLE" : "STABLE";
    const [a, b, c] = hist.slice(-3); // oldest -> newest
    const d1 = c - b;
    const d2 = b - a;
    if (d1 > 0 && d2 > 0 && c - a >= 6) return "ACCELERATING";
    if (d1 < 0 && d2 < 0 && a - c >= 6) return "WEAKENING";
    if ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) return "REVERSING";
    return "STABLE";
  };
  const buyerTrend = trendOf(input.history.map((h) => h.buyer).concat(finalBuyer));
  const sellerTrend = trendOf(input.history.map((h) => h.seller).concat(finalSeller));

  const rankable = fresh && coveragePct >= 40 && (finalBuyer >= 60 || finalSeller >= 60);
  if (!fresh) notes.push(`${metrics.dataStatus} data — excluded from dominance ranking`);

  return {
    symbol: input.symbol,
    computedAt: new Date(input.now).toISOString(),
    buyerScore: finalBuyer,
    sellerScore: finalSeller,
    buyerConfidence,
    sellerConfidence,
    buyerBand: bandOf(finalBuyer),
    sellerBand: bandOf(finalSeller),
    buyerTrend,
    sellerTrend,
    conflictingFlow,
    components,
    alignedForBuyer,
    alignedForSeller,
    conflictCount,
    coveragePct,
    dataFresh: fresh,
    dataStatus: metrics.dataStatus,
    rankable,
    notes,
  };
}

export const ORDERFLOW_MIN_RANK_SCORE = 60;
