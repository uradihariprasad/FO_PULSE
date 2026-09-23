/**
 * INTRADAY DYNAMIC SUPPORT & RESISTANCE ENGINE  (additive module)
 *
 * Builds multi-level live S/R zones (S1..S3 / R1..R3) for Stage-1 filtered
 * stocks by combining NINE independent evidence sources — never a single
 * indicator, never static once-a-day pivots:
 *
 *   1 swing structure (multi-candle confirmed)     6 wick-rejection clusters
 *   2 previous-day levels (PDH/PDL/PDC)            7 breakout/breakdown role reversal
 *   3 opening range (5m & 15m)                     8 futures price/OI confirmation
 *   4 VWAP interaction/acceptance                  9 option-chain CE/PE OI confirmation
 *   5 volume concentration nodes
 *
 * Candidates are clustered into zones using an ATR/volatility-adaptive width,
 * scored 0-100 (configurable weights), classified with a dynamic status
 * (strengthening / weakening / breakout risk / broken ...) using REAL tracked
 * history, and continuously re-evaluated. Recent interactions outweigh old
 * ones. Every number derives from actual Upstox data; unavailable inputs stay
 * null (N/A) and are excluded from scoring rather than substituted.
 *
 * This module is read-only with respect to the existing Stage 1 / Stage 2 /
 * Top-10 pipeline — it consumes their cached data and changes nothing.
 */

import type { Candle, FuturesMetrics } from "./types";
import type { OptionChainStrike } from "@/lib/upstox/types";
import { aggregate, atr, clamp, swings } from "./indicators";

/* ------------------------------ configuration ----------------------------- */

export interface SRWeights {
  priceStructure: number;
  tests: number;
  volume: number;
  vwap: number;
  prevDayOpeningRange: number;
  futures: number;
  options: number;
  recency: number;
}

/** Internally configurable — intentionally not exposed in the user settings UI. */
export const DEFAULT_SR_WEIGHTS: SRWeights = {
  priceStructure: 25,
  tests: 15,
  volume: 15,
  vwap: 10,
  prevDayOpeningRange: 10,
  futures: 10,
  options: 10,
  recency: 5,
};

export type SupportStatus =
  | "STRONG_SUPPORT"
  | "SUPPORT"
  | "WEAK_SUPPORT"
  | "SUPPORT_STRENGTHENING"
  | "SUPPORT_WEAKENING"
  | "BREAKDOWN_RISK"
  | "BROKEN_SUPPORT";

export type ResistanceStatus =
  | "STRONG_RESISTANCE"
  | "RESISTANCE"
  | "WEAK_RESISTANCE"
  | "RESISTANCE_STRENGTHENING"
  | "RESISTANCE_WEAKENING"
  | "BREAKOUT_RISK"
  | "BROKEN_RESISTANCE";

export type ZoneStatus = SupportStatus | ResistanceStatus;

export type TradeLocation =
  | "NEAR_STRONG_SUPPORT"
  | "NEAR_SUPPORT"
  | "MID_ZONE"
  | "NEAR_RESISTANCE"
  | "NEAR_STRONG_RESISTANCE"
  | "BREAKOUT_WATCH"
  | "BREAKDOWN_WATCH"
  | "INSUFFICIENT_DATA";

export type Confirmation = "CONFIRMED" | "CONTRADICTS" | "NEUTRAL" | "UNAVAILABLE";

export interface SRSourceTag {
  source: string;
  price: number;
  detail: string;
  weight: number;
}

export interface DynamicZone {
  id: string; // S1..S3 / R1..R3
  side: "SUPPORT" | "RESISTANCE";
  low: number;
  high: number;
  center: number;
  widthAbs: number;
  widthPct: number;
  confidence: number; // 0-100 == strength %
  status: ZoneStatus;
  statusLabel: string;
  tests: number;
  rejections: number;
  distancePct: number;
  distanceAbs: number;
  lastTouchAgoMin: number | null;
  sources: SRSourceTag[];
  sourceNames: string[];
  confirmations: {
    volume: Confirmation;
    vwap: Confirmation;
    futures: Confirmation;
    options: Confirmation;
    prevDayOr: Confirmation;
  };
  breakRisk: "LOW" | "MEDIUM" | "HIGH";
  roleReversed: boolean;
  scoreBreakdown: { key: string; label: string; weight: number; value: number | null; note: string }[];
  coveragePct: number;
  note: string;
}

export interface DynamicSRResult {
  symbol: string;
  computedAt: string;
  ltp: number | null;
  vwap: number | null;
  atr: number | null;
  supports: DynamicZone[]; // S1 (nearest) .. S3
  resistances: DynamicZone[]; // R1 (nearest) .. R3
  nearestSupport: DynamicZone | null;
  nearestResistance: DynamicZone | null;
  distanceToSupportPct: number | null;
  distanceToResistancePct: number | null;
  location: TradeLocation;
  locationLabel: string;
  vwapRelation: "ABOVE" | "BELOW" | "AT" | "UNAVAILABLE";
  futuresConfirmation: Confirmation;
  futuresNote: string;
  optionsConfirmation: Confirmation;
  optionsNote: string;
  breakoutRisk: "LOW" | "MEDIUM" | "HIGH";
  breakdownRisk: "LOW" | "MEDIUM" | "HIGH";
  dataGaps: string[];
  insufficient: boolean;
}

/** Persistent per-symbol memory so strength can evolve with real history. */
export interface SRTracker {
  zones: Record<
    string,
    { conf: number; prevConf: number | null; firstSeen: number; lastSeen: number; brokenAt: number | null }
  >;
}

export function newSRTracker(): SRTracker {
  return { zones: {} };
}

export const STATUS_LABEL: Record<ZoneStatus, string> = {
  STRONG_SUPPORT: "Strong Support",
  SUPPORT: "Support",
  WEAK_SUPPORT: "Weak Support",
  SUPPORT_STRENGTHENING: "Support Strengthening",
  SUPPORT_WEAKENING: "Support Weakening",
  BREAKDOWN_RISK: "Breakdown Risk",
  BROKEN_SUPPORT: "Broken Support",
  STRONG_RESISTANCE: "Strong Resistance",
  RESISTANCE: "Resistance",
  WEAK_RESISTANCE: "Weak Resistance",
  RESISTANCE_STRENGTHENING: "Resistance Strengthening",
  RESISTANCE_WEAKENING: "Resistance Weakening",
  BREAKOUT_RISK: "Breakout Risk",
  BROKEN_RESISTANCE: "Broken Resistance",
};

export const LOCATION_LABEL: Record<TradeLocation, string> = {
  NEAR_STRONG_SUPPORT: "Near Strong Support",
  NEAR_SUPPORT: "Near Support",
  MID_ZONE: "Mid-Zone",
  NEAR_RESISTANCE: "Near Resistance",
  NEAR_STRONG_RESISTANCE: "Near Strong Resistance",
  BREAKOUT_WATCH: "Breakout Watch",
  BREAKDOWN_WATCH: "Breakdown Watch",
  INSUFFICIENT_DATA: "Insufficient Data",
};

/* --------------------------------- input ---------------------------------- */

export interface DynamicSRInput {
  symbol: string;
  ltp: number | null;
  vwap: number | null;
  candles1m: Candle[] | null;
  prevDay: { high: number | null; low: number | null; close: number | null };
  dailyAtr: number | null;
  futures: FuturesMetrics;
  optionChain: OptionChainStrike[] | null;
  tickSize: number | null;
  tracker: SRTracker;
  now: number;
  weights?: SRWeights;
}

interface RawLevel {
  source: string;
  price: number;
  detail: string;
  weight: number; // 0..1 evidence quality
  time?: number;
  structural?: boolean;
  volume?: boolean;
  prevDayOr?: boolean;
  vwap?: boolean;
  optionSide?: "CE" | "PE";
  reversal?: boolean;
}

/* ------------------------------- main engine ------------------------------ */

export function computeDynamicSR(input: DynamicSRInput): DynamicSRResult {
  const W = input.weights ?? DEFAULT_SR_WEIGHTS;
  const gaps: string[] = [];
  const ltp = input.ltp;
  const c1 = input.candles1m ?? [];

  const empty = (reason: string): DynamicSRResult => {
    gaps.push(reason);
    return {
      symbol: input.symbol,
      computedAt: new Date(input.now).toISOString(),
      ltp,
      vwap: input.vwap,
      atr: null,
      supports: [],
      resistances: [],
      nearestSupport: null,
      nearestResistance: null,
      distanceToSupportPct: null,
      distanceToResistancePct: null,
      location: "INSUFFICIENT_DATA",
      locationLabel: LOCATION_LABEL.INSUFFICIENT_DATA,
      vwapRelation: "UNAVAILABLE",
      futuresConfirmation: "UNAVAILABLE",
      futuresNote: "UNAVAILABLE",
      optionsConfirmation: "UNAVAILABLE",
      optionsNote: "UNAVAILABLE",
      breakoutRisk: "LOW",
      breakdownRisk: "LOW",
      dataGaps: gaps,
      insufficient: true,
    };
  };

  if (ltp == null || !Number.isFinite(ltp) || ltp <= 0) return empty("Live price unavailable");
  if (c1.length < 20) return empty("INSUFFICIENT DATA — fewer than 20 one-minute candles");

  const c3 = aggregate(c1, 3);
  const c5 = aggregate(c1, 5);

  // Adaptive clustering width: ATR-driven, volatility aware, tick-respecting.
  const intradayAtr = atr(c5, 14);
  const atrRef = input.dailyAtr ?? (intradayAtr != null ? intradayAtr * 3 : null);
  const volPct = atrRef != null ? (atrRef / ltp) * 100 : null;
  // Tight, volatility-adaptive band: ~10% of daily ATR / half a 5-min ATR.
  // Wide bands would swallow price and inflate touch counts.
  const clusterWidth = clamp(
    Math.max(
      atrRef != null ? atrRef * 0.1 : 0,
      intradayAtr != null ? intradayAtr * 0.5 : 0,
      ltp * 0.0008,
      (input.tickSize ?? 0) * 2,
    ),
    ltp * 0.0008,
    ltp * 0.006, // hard cap: a zone may never exceed 0.6% of price
  );

  const levels: RawLevel[] = [];
  const lastTime = c1[c1.length - 1].t;
  const recencyOf = (t?: number) => (t ? clamp(1 - (lastTime - t) / (3.5 * 3600_000), 0.25, 1) : 0.6);

  /* ---------------- 1. swing structure (multi-candle confirmed) ---------- */
  const sw5 = c5.length >= 12 ? swings(c5, 2) : [];
  const sw3 = c3.length >= 18 ? swings(c3, 3) : [];
  for (const s of sw5.slice(-12)) {
    levels.push({
      source: "SWING_5M",
      price: s.price,
      detail: `${s.kind === "HIGH" ? "5-min swing high" : "5-min swing low"}`,
      weight: 0.72 * recencyOf(s.time) + 0.28,
      time: s.time,
      structural: true,
    });
  }
  for (const s of sw3.slice(-10)) {
    levels.push({
      source: "SWING_3M",
      price: s.price,
      detail: `${s.kind === "HIGH" ? "3-min swing high" : "3-min swing low"}`,
      weight: 0.55 * recencyOf(s.time) + 0.2,
      time: s.time,
      structural: true,
    });
  }
  if (sw5.length === 0 && sw3.length === 0) gaps.push("no confirmed swings yet");

  /* ---------------- 2. previous-day levels ------------------------------- */
  if (input.prevDay.high != null)
    levels.push({ source: "PDH", price: input.prevDay.high, detail: "Previous day high", weight: 0.9, prevDayOr: true, structural: true });
  if (input.prevDay.low != null)
    levels.push({ source: "PDL", price: input.prevDay.low, detail: "Previous day low", weight: 0.9, prevDayOr: true, structural: true });
  if (input.prevDay.close != null)
    levels.push({ source: "PDC", price: input.prevDay.close, detail: "Previous day close", weight: 0.75, prevDayOr: true });
  if (input.prevDay.high == null) gaps.push("previous-day OHLC unavailable");

  /* ---------------- 3. opening range (5m & 15m) -------------------------- */
  const orb = (mins: number, tag: string) => {
    const slice = c1.slice(0, Math.min(mins, c1.length));
    if (slice.length < Math.min(mins, 5)) return;
    const hi = Math.max(...slice.map((c) => c.h));
    const lo = Math.min(...slice.map((c) => c.l));
    levels.push({ source: `OR${tag}_HIGH`, price: hi, detail: `Opening range ${tag} high`, weight: 0.8, prevDayOr: true, structural: true });
    levels.push({ source: `OR${tag}_LOW`, price: lo, detail: `Opening range ${tag} low`, weight: 0.8, prevDayOr: true, structural: true });
  };
  orb(5, "5m");
  orb(15, "15m");

  /* ---------------- 4. VWAP interaction ---------------------------------- */
  let vwapTouches = 0;
  if (input.vwap != null && input.vwap > 0) {
    const tol = clusterWidth * 0.8;
    for (const c of c1) if (c.l <= input.vwap + tol && c.h >= input.vwap - tol) vwapTouches++;
    levels.push({
      source: "VWAP",
      price: input.vwap,
      detail: `VWAP (${vwapTouches} interactions)`,
      weight: clamp(0.5 + vwapTouches / 60, 0.5, 0.95),
      vwap: true,
    });
  } else {
    gaps.push("VWAP unavailable");
  }

  /* ---------------- 5. volume concentration nodes ------------------------ */
  {
    const binW = Math.max(clusterWidth * 0.6, ltp * 0.0008);
    const bins = new Map<number, { vol: number; last: number }>();
    let total = 0;
    for (const c of c1) {
      if (c.v <= 0) continue;
      const tp = (c.h + c.l + c.c) / 3;
      const k = Math.round(tp / binW) * binW;
      const cur = bins.get(k) ?? { vol: 0, last: 0 };
      cur.vol += c.v;
      cur.last = Math.max(cur.last, c.t);
      bins.set(k, cur);
      total += c.v;
    }
    if (bins.size > 2 && total > 0) {
      const ranked = [...bins.entries()].sort((a, b) => b[1].vol - a[1].vol);
      const avg = total / bins.size;
      for (const [price, info] of ranked.slice(0, 5)) {
        if (info.vol < avg * 1.6) continue;
        levels.push({
          source: "VOLUME_NODE",
          price,
          detail: `High-volume node (${((info.vol / total) * 100).toFixed(1)}% of day volume)`,
          weight: clamp(info.vol / ranked[0][1].vol, 0.45, 1),
          time: info.last,
          volume: true,
        });
      }
    } else {
      gaps.push("insufficient volume distribution");
    }
  }

  /* ---------------- 6. wick-rejection clusters --------------------------- */
  {
    const bin = Math.max(clusterWidth * 0.7, ltp * 0.001);
    const upper = new Map<number, { n: number; last: number }>();
    const lower = new Map<number, { n: number; last: number }>();
    for (const c of c3.slice(-80)) {
      const range = c.h - c.l;
      if (range <= 0) continue;
      const body = Math.abs(c.c - c.o);
      const upWick = c.h - Math.max(c.c, c.o);
      const dnWick = Math.min(c.c, c.o) - c.l;
      // a genuine rejection: wick dominates the candle, not every minor tail
      if (upWick > range * 0.5 && upWick > body) {
        const k = Math.round(c.h / bin) * bin;
        const e = upper.get(k) ?? { n: 0, last: 0 };
        e.n++; e.last = Math.max(e.last, c.t);
        upper.set(k, e);
      }
      if (dnWick > range * 0.5 && dnWick > body) {
        const k = Math.round(c.l / bin) * bin;
        const e = lower.get(k) ?? { n: 0, last: 0 };
        e.n++; e.last = Math.max(e.last, c.t);
        lower.set(k, e);
      }
    }
    for (const [price, e] of upper) {
      if (e.n < 2) continue; // require repeated rejection
      levels.push({ source: "REJECTION_UP", price, detail: `${e.n} upper-wick rejections`, weight: clamp(0.45 + e.n * 0.15, 0.45, 1) * recencyOf(e.last), time: e.last, structural: true });
    }
    for (const [price, e] of lower) {
      if (e.n < 2) continue;
      levels.push({ source: "REJECTION_DOWN", price, detail: `${e.n} lower-wick rejections`, weight: clamp(0.45 + e.n * 0.15, 0.45, 1) * recencyOf(e.last), time: e.last, structural: true });
    }
  }

  /* ---------------- 9. option-chain OI levels (confirmation input) ------- */
  const optionLevels = extractOptionLevels(input.optionChain, ltp);
  for (const o of optionLevels) {
    levels.push({
      source: o.side === "CE" ? "CE_OI" : "PE_OI",
      price: o.strike,
      detail: o.detail,
      weight: o.weight,
      optionSide: o.side,
    });
  }
  if (!input.optionChain || input.optionChain.length === 0) gaps.push("option chain unavailable");

  if (levels.length === 0) return empty("no S/R evidence available");

  /* ------------------------------ clustering ----------------------------- */
  const sorted = [...levels].sort((a, b) => a.price - b.price);
  const clusters: RawLevel[][] = [];
  let cur: RawLevel[] = [];
  for (const l of sorted) {
    if (!cur.length || l.price - cur[cur.length - 1].price <= clusterWidth) cur.push(l);
    else {
      clusters.push(cur);
      cur = [l];
    }
  }
  if (cur.length) clusters.push(cur);

  /* -------------------- interaction / break analysis --------------------- */
  const breakBuf = Math.max((intradayAtr ?? 0) * 0.25, ltp * 0.0008);
  const zones: DynamicZone[] = [];

  for (const cl of clusters) {
    const wsum = cl.reduce((a, l) => a + l.weight, 0) || 1;
    const center = cl.reduce((a, l) => a + l.price * l.weight, 0) / wsum;
    const low = Math.min(...cl.map((l) => l.price));
    const high = Math.max(...cl.map((l) => l.price));
    // Chained clustering can stretch a band far beyond the adaptive width —
    // clamp it around the weighted centre so zones stay actionable.
    const maxHalf = clusterWidth * 0.85;
    const zLow = Math.max(Math.min(low, center - clusterWidth * 0.35), center - maxHalf);
    const zHigh = Math.min(Math.max(high, center + clusterWidth * 0.35), center + maxHalf);

    // real interactions with this zone
    let tests = 0;
    let rejections = 0;
    let closesAbove = 0;
    let closesBelow = 0;
    let lastTouch: number | null = null;
    let volAtZone = 0;
    let volSamples = 0;
    for (const c of c3) {
      const touched = c.l <= zHigh && c.h >= zLow;
      if (touched) {
        tests++;
        lastTouch = c.t;
        volAtZone += c.v;
        volSamples++;
        // A rejection = price traded INTO the zone but closed back outside it,
        // on the side it approached from. Wicks alone are not enough: the
        // candle must close beyond the boundary.
        const approachedFromBelow = c.o < zLow;
        const approachedFromAbove = c.o > zHigh;
        if (approachedFromBelow && c.h >= zLow && c.c < zLow) rejections++; // repelled downward
        if (approachedFromAbove && c.l <= zHigh && c.c > zHigh) rejections++; // repelled upward
      }
      if (c.c > zHigh + breakBuf) closesAbove++;
      if (c.c < zLow - breakBuf) closesBelow++;
    }

    const side: "SUPPORT" | "RESISTANCE" = center <= ltp ? "SUPPORT" : "RESISTANCE";

    // --------- breakout / breakdown validation (never wick-only) ---------
    const recent = c5.slice(-6);
    const decisiveAbove = recent.filter((c) => c.c > zHigh + breakBuf).length;
    const decisiveBelow = recent.filter((c) => c.c < zLow - breakBuf).length;
    const volExpansion = (() => {
      if (c5.length < 10) return null;
      const last = c5[c5.length - 1].v;
      const prior = c5.slice(-9, -1).map((x) => x.v);
      const avg = prior.reduce((a, b) => a + b, 0) / (prior.length || 1);
      return avg > 0 ? last / avg : null;
    })();
    const accepted = (dir: "UP" | "DOWN") =>
      dir === "UP" ? decisiveAbove >= 2 && ltp > zHigh + breakBuf : decisiveBelow >= 2 && ltp < zLow - breakBuf;

    // role reversal: broken resistance now below price => support (and vice versa)
    const roleReversed =
      (side === "SUPPORT" && closesAbove >= 2 && cl.some((l) => l.source.includes("HIGH") || l.source === "REJECTION_UP" || l.source === "PDH")) ||
      (side === "RESISTANCE" && closesBelow >= 2 && cl.some((l) => l.source.includes("LOW") || l.source === "REJECTION_DOWN" || l.source === "PDL"));

    /* --------------------------- scoring 0-100 -------------------------- */
    const uniqueStructural = new Set(cl.filter((l) => l.structural).map((l) => l.source)).size;
    const parts: { key: string; label: string; weight: number; value: number | null; note: string }[] = [];

    parts.push({
      key: "priceStructure",
      label: "Price structure",
      weight: W.priceStructure,
      value: clamp(uniqueStructural * 26 + (cl.length >= 3 ? 16 : 0), 0, 100),
      note: `${uniqueStructural} independent structural source(s), ${cl.length} level(s) merged`,
    });

    parts.push({
      key: "tests",
      label: "Tests / rejections",
      weight: W.tests,
      value: tests > 0 ? clamp(Math.min(tests, 10) * 7 + rejections * 12, 0, 100) : 0,
      note: `${tests} touch(es), ${rejections} rejection(s)`,
    });

    const volNode = cl.find((l) => l.volume);
    const volValue = (() => {
      if (volNode) return clamp(60 + volNode.weight * 40, 0, 100);
      if (volSamples > 0 && c3.length > 0) {
        const avgVol = c3.reduce((a, c) => a + c.v, 0) / c3.length;
        const zoneAvg = volAtZone / volSamples;
        return avgVol > 0 ? clamp((zoneAvg / avgVol) * 50, 0, 100) : null;
      }
      return null;
    })();
    parts.push({
      key: "volume",
      label: "Volume confirmation",
      weight: W.volume,
      value: volValue,
      note: volNode ? volNode.detail : volValue != null ? "traded volume measured at zone" : "volume data N/A",
    });

    const vwapValue = (() => {
      if (input.vwap == null) return null;
      const hasVwap = cl.some((l) => l.vwap);
      const alignedSide = side === "SUPPORT" ? ltp >= input.vwap : ltp <= input.vwap;
      let v = hasVwap ? 82 : 46;
      if (alignedSide) v += 14;
      return clamp(v, 0, 100);
    })();
    parts.push({
      key: "vwap",
      label: "VWAP / market structure",
      weight: W.vwap,
      value: vwapValue,
      note: input.vwap == null ? "VWAP N/A" : cl.some((l) => l.vwap) ? "zone coincides with VWAP" : "VWAP context applied",
    });

    const pdOr = cl.filter((l) => l.prevDayOr);
    parts.push({
      key: "prevDayOpeningRange",
      label: "Prev-day / opening range",
      weight: W.prevDayOpeningRange,
      value: pdOr.length ? clamp(58 + pdOr.length * 20, 0, 100) : 18,
      note: pdOr.length ? pdOr.map((l) => l.detail).join(", ") : "no PD/OR coincidence",
    });

    const fut = futuresConfirmationFor(side, input.futures);
    parts.push({
      key: "futures",
      label: "Futures confirmation",
      weight: W.futures,
      value: fut.value,
      note: fut.note,
    });

    const opt = optionConfirmationFor(side, cl, optionLevels, ltp);
    parts.push({ key: "options", label: "Options OI confirmation", weight: W.options, value: opt.value, note: opt.note });

    const recencyValue = lastTouch != null ? clamp(recencyOf(lastTouch) * 100, 0, 100) : 30;
    parts.push({
      key: "recency",
      label: "Recency",
      weight: W.recency,
      value: recencyValue,
      note: lastTouch != null ? `last interaction ${Math.round((lastTime - lastTouch) / 60000)} min ago` : "no recent interaction",
    });

    let wUsed = 0;
    let acc = 0;
    let wTotal = 0;
    for (const p of parts) {
      wTotal += p.weight;
      if (p.value == null) continue;
      wUsed += p.weight;
      acc += p.weight * p.value;
    }
    const coverage = wTotal > 0 ? wUsed / wTotal : 0;
    let confidence = wUsed > 0 ? Math.round((acc / wUsed) * Math.sqrt(coverage)) : 0;

    // stale / invalidated zones must decay, never stay equally strong
    const distancePct = (Math.abs(center - ltp) / ltp) * 100;
    if (distancePct > 3) confidence = Math.round(confidence * 0.82);
    const brokenNow =
      (side === "SUPPORT" && accepted("DOWN")) || (side === "RESISTANCE" && accepted("UP"));
    if (brokenNow) confidence = Math.round(confidence * 0.55);

    /* ----------------------- dynamic status via tracker ------------------ */
    const key = `${side}:${(Math.round(center / Math.max(clusterWidth, 0.01)) * Math.max(clusterWidth, 0.01)).toFixed(2)}`;
    const prior = input.tracker.zones[key];
    const prevConf = prior ? prior.conf : null;
    input.tracker.zones[key] = {
      conf: confidence,
      prevConf,
      firstSeen: prior?.firstSeen ?? input.now,
      lastSeen: input.now,
      brokenAt: brokenNow ? input.now : (prior?.brokenAt ?? null),
    };
    const delta = prevConf != null ? confidence - prevConf : 0;

    // proximity + momentum => break risk
    const nearPct = distancePct;
    const volExpanding = volExpansion != null && volExpansion >= 1.2;
    let breakRisk: "LOW" | "MEDIUM" | "HIGH" = "LOW";
    if (nearPct <= 0.35 && volExpanding) breakRisk = "HIGH";
    else if (nearPct <= 0.6) breakRisk = "MEDIUM";

    const status = classifyStatus(side, confidence, delta, brokenNow, breakRisk, roleReversed);

    zones.push({
      id: "",
      side,
      low: zLow,
      high: zHigh,
      center,
      widthAbs: zHigh - zLow,
      widthPct: ((zHigh - zLow) / ltp) * 100,
      confidence: clamp(confidence, 0, 100),
      status,
      statusLabel: STATUS_LABEL[status],
      tests,
      rejections,
      distancePct,
      distanceAbs: Math.abs(center - ltp),
      lastTouchAgoMin: lastTouch != null ? Math.round((lastTime - lastTouch) / 60000) : null,
      sources: cl.map((l) => ({ source: l.source, price: l.price, detail: l.detail, weight: Math.round(l.weight * 100) / 100 })),
      sourceNames: [...new Set(cl.map((l) => l.source))],
      confirmations: {
        volume: volValue == null ? "UNAVAILABLE" : volValue >= 58 ? "CONFIRMED" : volValue >= 35 ? "NEUTRAL" : "CONTRADICTS",
        vwap: vwapValue == null ? "UNAVAILABLE" : vwapValue >= 60 ? "CONFIRMED" : "NEUTRAL",
        futures: fut.confirmation,
        options: opt.confirmation,
        prevDayOr: pdOr.length ? "CONFIRMED" : "NEUTRAL",
      },
      breakRisk,
      roleReversed,
      scoreBreakdown: parts.map((p) => ({ ...p, value: p.value == null ? null : Math.round(p.value) })),
      coveragePct: Math.round(coverage * 100),
      note: roleReversed
        ? side === "SUPPORT"
          ? "former resistance now acting as support (role reversal)"
          : "former support now acting as resistance (role reversal)"
        : brokenNow
          ? "recently broken with candle-close confirmation"
          : "",
    });
  }

  /* --------------------------- select S1..S3 / R1..R3 -------------------- */
  const supports = zones
    .filter((z) => z.side === "SUPPORT" && z.status !== "BROKEN_SUPPORT")
    .sort((a, b) => b.center - a.center)
    .slice(0, 3);
  const resistances = zones
    .filter((z) => z.side === "RESISTANCE" && z.status !== "BROKEN_RESISTANCE")
    .sort((a, b) => a.center - b.center)
    .slice(0, 3);
  supports.forEach((z, i) => (z.id = `S${i + 1}`));
  resistances.forEach((z, i) => (z.id = `R${i + 1}`));

  const nS = supports[0] ?? null;
  const nR = resistances[0] ?? null;

  /* ------------------------- trade-location context ---------------------- */
  const location = classifyLocation(ltp, nS, nR);

  const vwapRelation: DynamicSRResult["vwapRelation"] =
    input.vwap == null
      ? "UNAVAILABLE"
      : Math.abs(ltp - input.vwap) / ltp < 0.0008
        ? "AT"
        : ltp > input.vwap
          ? "ABOVE"
          : "BELOW";

  const futTop = futuresConfirmationFor(nR ? "RESISTANCE" : "SUPPORT", input.futures);
  const optTop = nR
    ? optionConfirmationFor("RESISTANCE", [], optionLevels, ltp)
    : optionConfirmationFor("SUPPORT", [], optionLevels, ltp);

  return {
    symbol: input.symbol,
    computedAt: new Date(input.now).toISOString(),
    ltp,
    vwap: input.vwap,
    atr: atrRef,
    supports,
    resistances,
    nearestSupport: nS,
    nearestResistance: nR,
    distanceToSupportPct: nS ? ((ltp - nS.center) / ltp) * 100 : null,
    distanceToResistancePct: nR ? ((nR.center - ltp) / ltp) * 100 : null,
    location,
    locationLabel: LOCATION_LABEL[location],
    vwapRelation,
    futuresConfirmation: futTop.confirmation,
    futuresNote: futTop.note,
    optionsConfirmation: optTop.confirmation,
    optionsNote: optTop.note,
    breakoutRisk: nR?.breakRisk ?? "LOW",
    breakdownRisk: nS?.breakRisk ?? "LOW",
    dataGaps: gaps,
    insufficient: supports.length === 0 && resistances.length === 0,
  };
}

/* ------------------------------- classifiers ------------------------------ */

function classifyStatus(
  side: "SUPPORT" | "RESISTANCE",
  conf: number,
  delta: number,
  broken: boolean,
  risk: "LOW" | "MEDIUM" | "HIGH",
  roleReversed: boolean,
): ZoneStatus {
  if (side === "SUPPORT") {
    if (broken) return "BROKEN_SUPPORT";
    if (risk === "HIGH" && conf < 70) return "BREAKDOWN_RISK";
    if (delta >= 6) return "SUPPORT_STRENGTHENING";
    if (delta <= -6) return "SUPPORT_WEAKENING";
    if (conf >= 75 || (roleReversed && conf >= 68)) return "STRONG_SUPPORT";
    if (conf >= 55) return "SUPPORT";
    return "WEAK_SUPPORT";
  }
  if (broken) return "BROKEN_RESISTANCE";
  if (risk === "HIGH" && conf < 70) return "BREAKOUT_RISK";
  if (delta >= 6) return "RESISTANCE_STRENGTHENING";
  if (delta <= -6) return "RESISTANCE_WEAKENING";
  if (conf >= 75 || (roleReversed && conf >= 68)) return "STRONG_RESISTANCE";
  if (conf >= 55) return "RESISTANCE";
  return "WEAK_RESISTANCE";
}

function classifyLocation(ltp: number, s: DynamicZone | null, r: DynamicZone | null): TradeLocation {
  if (!s && !r) return "INSUFFICIENT_DATA";
  const ds = s ? ((ltp - s.center) / ltp) * 100 : Infinity;
  const dr = r ? ((r.center - ltp) / ltp) * 100 : Infinity;
  if (r && dr <= 0.35 && r.breakRisk === "HIGH") return "BREAKOUT_WATCH";
  if (s && ds <= 0.35 && s.breakRisk === "HIGH") return "BREAKDOWN_WATCH";
  if (s && ds <= 0.5) return s.confidence >= 75 ? "NEAR_STRONG_SUPPORT" : "NEAR_SUPPORT";
  if (r && dr <= 0.5) return r.confidence >= 75 ? "NEAR_STRONG_RESISTANCE" : "NEAR_RESISTANCE";
  return "MID_ZONE";
}

function futuresConfirmationFor(
  side: "SUPPORT" | "RESISTANCE",
  f: FuturesMetrics,
): { value: number | null; confirmation: Confirmation; note: string } {
  if (f.signal === "UNAVAILABLE") return { value: null, confirmation: "UNAVAILABLE", note: "futures UNAVAILABLE" };
  if (f.signal === "NEUTRAL") return { value: 50, confirmation: "NEUTRAL", note: "futures positioning ambiguous" };
  const bullish = f.signal === "LONG_BUILDUP" || f.signal === "SHORT_COVERING";
  const txt = `${f.signal.replaceAll("_", " ").toLowerCase()} characteristics`;
  // bullish positioning supports supports holding; bearish supports resistance holding
  const aligned = side === "SUPPORT" ? bullish : !bullish;
  return {
    value: aligned ? 88 : 26,
    confirmation: aligned ? "CONFIRMED" : "CONTRADICTS",
    note: txt,
  };
}

interface OptLevel { strike: number; side: "CE" | "PE"; oi: number; oiChange: number | null; weight: number; detail: string; unwinding: boolean }

function extractOptionLevels(chain: OptionChainStrike[] | null, spot: number): OptLevel[] {
  if (!chain || chain.length === 0 || spot <= 0) return [];
  const rows = chain.filter((s) => s.strike_price != null && Math.abs(s.strike_price! - spot) / spot <= 0.08);
  if (!rows.length) return [];
  const maxCe = Math.max(...rows.map((r) => r.call_options?.market_data?.oi ?? 0), 1);
  const maxPe = Math.max(...rows.map((r) => r.put_options?.market_data?.oi ?? 0), 1);
  const out: OptLevel[] = [];
  for (const r of rows) {
    const strike = r.strike_price!;
    const ce = r.call_options?.market_data;
    const pe = r.put_options?.market_data;
    if (ce?.oi != null && ce.oi > maxCe * 0.45) {
      const chg = ce.prev_oi != null ? ce.oi - ce.prev_oi : null;
      const unwind = chg != null && chg < -maxCe * 0.01;
      out.push({
        strike, side: "CE", oi: ce.oi, oiChange: chg,
        weight: clamp(ce.oi / maxCe, 0.4, 1) * (unwind ? 0.65 : 1),
        detail: `CE OI ${(ce.oi / 1000).toFixed(0)}K${chg != null ? ` (${chg >= 0 ? "+" : ""}${(chg / 1000).toFixed(0)}K)` : ""}${unwind ? " — unwinding" : chg != null && chg > 0 ? " — fresh writing" : ""}`,
        unwinding: unwind,
      });
    }
    if (pe?.oi != null && pe.oi > maxPe * 0.45) {
      const chg = pe.prev_oi != null ? pe.oi - pe.prev_oi : null;
      const unwind = chg != null && chg < -maxPe * 0.01;
      out.push({
        strike, side: "PE", oi: pe.oi, oiChange: chg,
        weight: clamp(pe.oi / maxPe, 0.4, 1) * (unwind ? 0.65 : 1),
        detail: `PE OI ${(pe.oi / 1000).toFixed(0)}K${chg != null ? ` (${chg >= 0 ? "+" : ""}${(chg / 1000).toFixed(0)}K)` : ""}${unwind ? " — unwinding" : chg != null && chg > 0 ? " — fresh writing" : ""}`,
        unwinding: unwind,
      });
    }
  }
  return out;
}

function optionConfirmationFor(
  side: "SUPPORT" | "RESISTANCE",
  cluster: RawLevel[],
  optionLevels: OptLevel[],
  spot: number,
): { value: number | null; confirmation: Confirmation; note: string } {
  if (optionLevels.length === 0) return { value: null, confirmation: "UNAVAILABLE", note: "option chain UNAVAILABLE" };
  const inCluster = cluster.filter((l) => l.optionSide);
  if (inCluster.length > 0) {
    // options must CONFIRM price structure, never define the zone alone
    const wantSide = side === "SUPPORT" ? "PE" : "CE";
    const matching = inCluster.filter((l) => l.optionSide === wantSide);
    const opposing = inCluster.filter((l) => l.optionSide !== wantSide);
    const hasPriceEvidence = cluster.some((l) => !l.optionSide);
    if (matching.length && hasPriceEvidence) {
      const det = matching.map((m) => m.detail).join("; ");
      const unwinding = det.includes("unwinding");
      return {
        value: unwinding ? 62 : 90,
        confirmation: "CONFIRMED",
        note: `${wantSide} OI aligns with zone — ${det}`,
      };
    }
    if (matching.length && !hasPriceEvidence) {
      return { value: 48, confirmation: "NEUTRAL", note: `${wantSide} OI present but no price-structure evidence` };
    }
    if (opposing.length) {
      return { value: 30, confirmation: "CONTRADICTS", note: `${opposing[0].optionSide} OI dominates this strike` };
    }
  }
  // nearest significant OI on the expected side
  const wantSide = side === "SUPPORT" ? "PE" : "CE";
  const cands = optionLevels.filter((o) => (side === "SUPPORT" ? o.strike <= spot * 1.005 : o.strike >= spot * 0.995) && o.side === wantSide);
  if (!cands.length) return { value: 45, confirmation: "NEUTRAL", note: `no dominant ${wantSide} OI near price` };
  const best = cands.sort((a, b) => b.weight - a.weight)[0];
  return { value: 58, confirmation: "NEUTRAL", note: `nearest ${wantSide} wall ${best.strike} — ${best.detail}` };
}
