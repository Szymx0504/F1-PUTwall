import { useMemo, useEffect, useState, useRef } from "react";
import type { Driver, TrackMapData } from "../../types";
import type { QualLap, QualCarData } from "../../lib/api";
import { api, fmt, bestLapsByDriver } from "../../lib/api";

/* ── Constants ──────────────────────────────────────────────────────── */

const NUM_MINI = 25;
const W = 500;
const H = 400;
const PAD = 30;
const TRACK_STROKE = 6;

/* ── Helpers ────────────────────────────────────────────────────────── */

/** Convert hex to HSL components (h: 0–360, s: 0–100, l: 0–100) */
function hexToHsl(hex: string): [number, number, number] {
    const h = hex.replace("#", "");
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b),
        min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l * 100];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let hue = 0;
    if (max === r) hue = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) hue = ((b - r) / d + 2) / 6;
    else hue = ((r - g) / d + 4) / 6;
    return [hue * 360, s * 100, l * 100];
}

/**
 * Derive a perceptually distinct but team-authentic variant of a team colour
 * for the secondary teammate. Works entirely from the colour itself:
 * - If the base colour is dark (l < 45), the variant is lighter (+18L, +10S)
 * - If it's light/vivid (l ≥ 45), the variant is darker (−15L, +8S)
 * Same hue, clearly related, but distinguishable on a dark track background.
 */
function teammateVariant(hex: string): string {
    const [hue, sat, lit] = hexToHsl(hex);
    const isDark = lit < 45;
    const newL = isDark ? Math.min(lit + 32, 92) : Math.max(lit - 28, 12);
    const newS = Math.min(sat + (isDark ? 18 : 15), 100);
    return `hsl(${hue.toFixed(1)},${newS.toFixed(1)}%,${newL.toFixed(1)}%)`;
}

function computeDistances(data: QualCarData[]): number[] {
    if (!data.length) return [];
    const d = [0];
    for (let i = 1; i < data.length; i++) {
        const dt = Math.max(
            (new Date(data[i].date).getTime() -
                new Date(data[i - 1].date).getTime()) /
                1000,
            0,
        );
        d.push(d[i - 1] + ((data[i - 1].speed + data[i].speed) / 2 / 3.6) * dt);
    }
    return d;
}

type Pt = { x: number; y: number };
type Bounds = { minX: number; maxX: number; minY: number; maxY: number };

function arcLengths(pts: { x: number; y: number }[]): number[] {
    const d = [0];
    for (let i = 1; i < pts.length; i++) {
        const dx = pts[i].x - pts[i - 1].x;
        const dy = pts[i].y - pts[i - 1].y;
        d.push(d[i - 1] + Math.sqrt(dx * dx + dy * dy));
    }
    return d;
}

/**
 * Trim the GPS outline to exactly one lap by removing the S/F approach overlap.
 * The outline covers lap_start → next_lap_start, so the S/F straight is
 * traversed twice (departure at the start, approach at the end).
 * Strategy: compare tail points (last 20%) against head points (first 15%).
 * If a tail point is spatially close to ANY head point, it's on the same
 * physical road and is part of the overlap.
 */
function trimToOneLap(pts: Pt[]): Pt[] {
    const n = pts.length;
    if (n < 30) return pts;

    // Average inter-point spacing → sets the proximity threshold
    let totalLen = 0;
    for (let i = 1; i < n; i++) {
        const dx = pts[i].x - pts[i - 1].x;
        const dy = pts[i].y - pts[i - 1].y;
        totalLen += Math.sqrt(dx * dx + dy * dy);
    }
    const avgStep = totalLen / (n - 1);
    const threshSq = avgStep * 10 * (avgStep * 10); // 10× spacing

    const headLen = Math.ceil(n * 0.15); // first 15%
    const searchFrom = Math.floor(n * 0.8); // search last 20%

    // Walk backward from end: find contiguous block of tail points
    // that are spatially close to any head point (= same physical road)
    let cutIdx = n;
    let gap = 0;
    for (let i = n - 1; i >= searchFrom; i--) {
        let near = false;
        for (let j = 0; j < headLen; j++) {
            const dx = pts[i].x - pts[j].x;
            const dy = pts[i].y - pts[j].y;
            if (dx * dx + dy * dy < threshSq) {
                near = true;
                break;
            }
        }
        if (near) {
            cutIdx = i;
            gap = 0;
        } else if (cutIdx < n) {
            gap++;
            if (gap > 3) break; // tolerate up to 3 noisy points
        }
    }

    // Safety: must trim at least 1 point and not more than 20%
    console.log("[trimToOneLap]", {
        n,
        avgStep: avgStep.toFixed(2),
        thresh: Math.sqrt(threshSq).toFixed(2),
        headLen,
        searchFrom,
        cutIdx,
        trimmed: cutIdx < n - 1 && cutIdx >= n * 0.8,
        tailDists: Array.from(
            { length: Math.min(10, n - searchFrom) },
            (_, k) => {
                const i = n - 1 - k;
                let minD = Infinity;
                for (let j = 0; j < headLen; j++) {
                    const dx = pts[i].x - pts[j].x;
                    const dy = pts[i].y - pts[j].y;
                    minD = Math.min(minD, Math.sqrt(dx * dx + dy * dy));
                }
                return `[${i}]=${minD.toFixed(1)}`;
            },
        ),
    });
    if (cutIdx >= n - 1 || cutIdx < n * 0.8) return pts;

    return [...pts.slice(0, cutIdx), { x: pts[0].x, y: pts[0].y }];
}

function computeBounds(pts: Pt[]): Bounds {
    let minX = Infinity,
        maxX = -Infinity,
        minY = Infinity,
        maxY = -Infinity;
    for (const p of pts) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
    }
    return { minX, maxX, minY, maxY };
}

function toCanvas(x: number, y: number, b: Bounds): { px: number; py: number } {
    const rx = b.maxX - b.minX || 1;
    const ry = b.maxY - b.minY || 1;
    const scale = Math.min((W - PAD * 2) / rx, (H - PAD * 2) / ry);
    return {
        px: W / 2 + (x - (b.minX + b.maxX) / 2) * scale,
        py: H / 2 - (y - (b.minY + b.maxY) / 2) * scale,
    };
}

/** Interpolate time at a given distance along a driver's telemetry */
function timeAtDistance(
    distances: number[],
    data: QualCarData[],
    targetDist: number,
): number | null {
    if (!distances.length) return null;
    if (targetDist <= distances[0]) return new Date(data[0].date).getTime();
    if (targetDist >= distances[distances.length - 1])
        return new Date(data[data.length - 1].date).getTime();
    let lo = 0,
        hi = distances.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (distances[mid] <= targetDist) lo = mid;
        else hi = mid;
    }
    const frac =
        (targetDist - distances[lo]) / (distances[hi] - distances[lo] || 1);
    const tLo = new Date(data[lo].date).getTime();
    const tHi = new Date(data[hi].date).getTime();
    return tLo + (tHi - tLo) * frac;
}

/* ── Per-minisector result (one winner + all times) ─────────────────── */

interface MiniResult {
    idx: number;
    bestNum: number | null;
    bestTime: number | null;
    color: string;
    name: string;
    /** All driver times for this minisector, keyed by driver_number */
    allTimes: Map<number, number>;
    /**
     * True when this winner shares a team colour with at least one other driver
     * in the active set — signals that a pinstripe overlay should be drawn so
     * teammates are visually distinguishable on the map.
     */
    pinstripe?: boolean;
}

/* ── Props ──────────────────────────────────────────────────────────── */

interface Props {
    drivers: Driver[];
    laps: QualLap[];
    carDataMap: Map<number, QualCarData[]>;
    sessionKey: number;
    focusDrivers: number[];
    onFocusDrivers: (nums: number[]) => void;
}

/* ── Tooltip state ──────────────────────────────────────────────────── */

interface TooltipInfo {
    segIdx: number;
    /** Winner in current view (all-drivers or focused subset) */
    color: string;
    name: string;
    time: number | null;
    svgX: number;
    svgY: number;
    /** Per-driver breakdown when multiple drivers are focused */
    breakdown?: {
        num: number;
        color: string;
        name: string;
        time: number | null;
    }[];
}

/* ── Component ──────────────────────────────────────────────────────── */

export default function MiniSectorMap({
    drivers,
    laps,
    carDataMap,
    sessionKey,
    focusDrivers = [],
    onFocusDrivers = () => {},
}: Props) {
    /* ── Hover / tooltip state ───────────────────────────────────────── */

    const [hoveredSegment, setHoveredSegment] = useState<number | null>(null);
    const [tooltip, setTooltip] = useState<TooltipInfo | null>(null);
    const svgRef = useRef<SVGSVGElement>(null);

    /* ── 3 main sectors ─────────────────────────────────────────────── */

    const sectors = useMemo(() => {
        const bestByDriver = bestLapsByDriver(laps);
        const sectorKeys: (keyof QualLap)[] = [
            "duration_sector_1",
            "duration_sector_2",
            "duration_sector_3",
        ];
        return sectorKeys.map((key, idx) => {
            let bestNum: number | null = null;
            let bestTime = Infinity;
            bestByDriver.forEach((lap, num) => {
                const t = lap[key] as number | null;
                if (t != null && t < bestTime) {
                    bestTime = t;
                    bestNum = num;
                }
            });
            const driver = drivers.find((d) => d.driver_number === bestNum);
            return {
                label: `S${idx + 1}`,
                driverNumber: bestNum,
                time: bestTime === Infinity ? null : bestTime,
                color: `#${driver?.team_colour ?? "888888"}`,
                name: driver?.name_acronym ?? String(bestNum),
                fullName: driver
                    ? `${driver.first_name} ${driver.last_name}`
                    : String(bestNum),
            };
        });
    }, [laps, drivers]);

    /* ── Fetch track outline ────────────────────────────────────────── */

    const [trackData, setTrackData] = useState<TrackMapData | null>(null);
    useEffect(() => {
        if (!sessionKey) return;
        let cancelled = false;
        api.getTrackMap(sessionKey)
            .then((d) => {
                if (!cancelled) setTrackData(d);
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, [sessionKey]);

    /* ── Minisector analysis from telemetry ──────────────────────────── */

    const miniSectorData = useMemo(() => {
        if (!carDataMap.size) return null;

        // Only include drivers who actually participated in this Q segment.
        // carDataMap is built from all session telemetry and may include drivers
        // eliminated in Q1/Q2 whose best-lap data was recorded in an earlier segment.
        // Cross-referencing against `laps` (already filtered to the active segment
        // by QualifyingAnalysis) ensures we only show drivers active in this Q.
        const eligibleDrivers = new Set(
            laps
                .filter((l) => l.lap_duration != null)
                .map((l) => l.driver_number),
        );

        // Best lap per driver — used to trim telemetry to the real lap duration
        // so that totalDist ≈ one actual lap (no overshoot past S/F).
        const bestByDriver = bestLapsByDriver(laps);

        const driverData: {
            num: number;
            data: QualCarData[];
            distances: number[];
            totalDist: number;
        }[] = [];
        let maxDist = 0;
        carDataMap.forEach((rawData, num) => {
            // Skip drivers not active in the current Q segment
            if (eligibleDrivers.size > 0 && !eligibleDrivers.has(num)) return;

            // Trim telemetry to the driver's actual lap duration.
            // The backend fetches up to next-lap-start or lap_duration + 2 s,
            // so the raw data overshoots the S/F line, inflating totalDist and
            // causing minisector boundaries to extend beyond the real lap.
            let data = rawData;
            const bestLap = bestByDriver.get(num);
            if (bestLap?.lap_duration && rawData.length >= 2) {
                const t0 = new Date(rawData[0].date).getTime();
                const tEnd = t0 + bestLap.lap_duration * 1000;
                // Binary-search for the last sample within the lap
                let lo = 0,
                    hi = rawData.length - 1;
                while (lo < hi) {
                    const mid = (lo + hi + 1) >> 1;
                    if (new Date(rawData[mid].date).getTime() <= tEnd) lo = mid;
                    else hi = mid - 1;
                }
                data = rawData.slice(0, lo + 1);
            }

            const distances = computeDistances(data);
            const totalDist = distances[distances.length - 1] ?? 0;
            if (totalDist > 0) {
                driverData.push({ num, data, distances, totalDist });
                if (totalDist > maxDist) maxDist = totalDist;
            }
        });
        if (!driverData.length || maxDist <= 0) return null;

        const boundaries: number[] = [];
        for (let i = 0; i <= NUM_MINI; i++)
            boundaries.push((i / NUM_MINI) * maxDist);

        const results: MiniResult[] = [];

        for (let i = 0; i < NUM_MINI; i++) {
            const dStart = boundaries[i];
            const dEnd = boundaries[i + 1];
            let bestNum: number | null = null;
            let bestTime = Infinity;
            const allTimes = new Map<number, number>();

            for (const dd of driverData) {
                if (dd.totalDist < dEnd * 0.9) continue;
                const tStart = timeAtDistance(dd.distances, dd.data, dStart);
                const tEnd = timeAtDistance(dd.distances, dd.data, dEnd);
                if (tStart != null && tEnd != null) {
                    const elapsed = tEnd - tStart;
                    if (elapsed > 0) {
                        allTimes.set(dd.num, elapsed);
                        if (elapsed < bestTime) {
                            bestTime = elapsed;
                            bestNum = dd.num;
                        }
                    }
                }
            }

            const driver = drivers.find((d) => d.driver_number === bestNum);
            results.push({
                idx: i,
                bestNum,
                bestTime: bestTime === Infinity ? null : bestTime,
                color: `#${driver?.team_colour ?? "888888"}`,
                name: driver?.name_acronym ?? "",
                allTimes,
            });
        }

        return { results, maxDist };
    }, [carDataMap, drivers, laps]);

    /* ── Comparison mode: which segments each focused driver wins ────── */

    /**
     * When focusDrivers has 2+ entries, recompute per-segment winner restricted
     * to those drivers. This drives track coloring + the comparison table.
     *
     * We also tag segments with `pinstripe: true` when the winning driver
     * shares a team colour with another focused driver — teammates need the
     * two-tone livery treatment so they're visually distinguishable on the map.
     */
    const comparisonData = useMemo(() => {
        if (!miniSectorData || focusDrivers.length < 2) return null;

        const focusSet = new Set(focusDrivers);

        // Build colour → driver-numbers map for focused drivers
        const colorToNums = new Map<string, number[]>();
        for (const num of focusDrivers) {
            const d = drivers.find((dr) => dr.driver_number === num);
            const col = `#${d?.team_colour ?? "888888"}`.toLowerCase();
            const existing = colorToNums.get(col) ?? [];
            existing.push(num);
            colorToNums.set(col, existing);
        }
        // Colours that are shared between 2+ focused drivers
        const sharedColors = new Set(
            [...colorToNums.entries()]
                .filter(([, nums]) => nums.length > 1)
                .map(([col]) => col),
        );

        // Among shared-colour teammates, the one that wins fewer overall
        // minisectors (globally, not just in comparison) gets the pinstripe.
        // This keeps the dominant driver plain and gives the secondary driver
        // the distinguishing mark.
        const globalWinCounts = new Map<number, number>();
        for (const r of miniSectorData.results) {
            if (r.bestNum != null)
                globalWinCounts.set(
                    r.bestNum,
                    (globalWinCounts.get(r.bestNum) ?? 0) + 1,
                );
        }
        // For each shared colour, find the driver with fewer global wins → pinstripe
        const pinstripeDrivers = new Set<number>();
        colorToNums.forEach((nums, col) => {
            if (!sharedColors.has(col)) return;
            // Sort ascending by win count; ties broken by higher driver number
            const sorted = [...nums].sort(
                (a, b) =>
                    (globalWinCounts.get(a) ?? 0) -
                        (globalWinCounts.get(b) ?? 0) || b - a,
            );
            // All but the top winner get the pinstripe
            sorted
                .slice(0, sorted.length - 1)
                .forEach((n) => pinstripeDrivers.add(n));
        });

        return miniSectorData.results.map((ms) => {
            let bestNum: number | null = null;
            let bestTime = Infinity;
            ms.allTimes.forEach((t, num) => {
                if (focusSet.has(num) && t < bestTime) {
                    bestTime = t;
                    bestNum = num;
                }
            });
            const driver = drivers.find((d) => d.driver_number === bestNum);
            return {
                idx: ms.idx,
                bestNum,
                bestTime: bestTime === Infinity ? null : bestTime,
                color: `#${driver?.team_colour ?? "888888"}`,
                name: driver?.name_acronym ?? "",
                allTimes: ms.allTimes,
                pinstripe: bestNum != null && pinstripeDrivers.has(bestNum),
            };
        });
    }, [miniSectorData, focusDrivers, drivers]);

    /* ── Active results: comparison subset OR global ─────────────────── */

    const activeResults = useMemo(
        () => comparisonData ?? miniSectorData?.results ?? [],
        [comparisonData, miniSectorData],
    );

    /* ── Driver dominance summary (in active view) ───────────────────── */

    const dominance = useMemo(() => {
        if (!activeResults.length) return [];
        const counts = new Map<
            number,
            { count: number; color: string; name: string; pinstripe: boolean }
        >();
        for (const r of activeResults) {
            if (r.bestNum == null) continue;
            const existing = counts.get(r.bestNum);
            if (existing) existing.count++;
            else
                counts.set(r.bestNum, {
                    count: 1,
                    color: r.color,
                    name: r.name,
                    pinstripe: r.pinstripe ?? false,
                });
        }
        return Array.from(counts.entries())
            .map(([num, v]) => ({ num, ...v }))
            .sort((a, b) => b.count - a.count);
    }, [activeResults]);

    /* ── Track outline split into minisector segments for SVG ────────── */

    const trackSegments = useMemo(() => {
        if (!trackData?.outline.length || !miniSectorData) return null;

        const outline = trimToOneLap(trackData.outline);
        const bounds = computeBounds(outline);
        const arcs = arcLengths(outline);
        const totalArc = arcs[arcs.length - 1];
        const canvasPts = outline.map((p: Pt) => toCanvas(p.x, p.y, bounds));

        // Closed path string for gray underlay
        const closedPath =
            canvasPts
                .map(
                    (p, idx) =>
                        `${idx === 0 ? "M" : "L"}${p.px.toFixed(1)},${p.py.toFixed(1)}`,
                )
                .join(" ") + " Z";

        function interpAtArc(targetArc: number): { px: number; py: number } {
            if (targetArc <= arcs[0]) return canvasPts[0];
            if (targetArc >= arcs[arcs.length - 1])
                return canvasPts[canvasPts.length - 1];
            for (let j = 1; j < arcs.length; j++) {
                if (arcs[j] >= targetArc) {
                    const frac =
                        (targetArc - arcs[j - 1]) /
                        (arcs[j] - arcs[j - 1] || 1);
                    return {
                        px:
                            canvasPts[j - 1].px +
                            (canvasPts[j].px - canvasPts[j - 1].px) * frac,
                        py:
                            canvasPts[j - 1].py +
                            (canvasPts[j].py - canvasPts[j - 1].py) * frac,
                    };
                }
            }
            return canvasPts[canvasPts.length - 1];
        }

        function tangentAtArc(targetArc: number): { dx: number; dy: number } {
            for (let j = 1; j < arcs.length; j++) {
                if (arcs[j] >= targetArc) {
                    const dx = canvasPts[j].px - canvasPts[j - 1].px;
                    const dy = canvasPts[j].py - canvasPts[j - 1].py;
                    const len = Math.sqrt(dx * dx + dy * dy) || 1;
                    return { dx: dx / len, dy: dy / len };
                }
            }
            const n = canvasPts.length;
            const dx = canvasPts[n - 1].px - canvasPts[n - 2].px;
            const dy = canvasPts[n - 1].py - canvasPts[n - 2].py;
            const len = Math.sqrt(dx * dx + dy * dy) || 1;
            return { dx: dx / len, dy: dy / len };
        }

        // Split outline into NUM_MINI coloured sub-path segments
        const segments: {
            points: { px: number; py: number }[];
            color: string;
            pinstripe: boolean;
        }[] = [];

        const boundaryPts: { px: number; py: number }[] = [];
        for (let i = 0; i <= NUM_MINI; i++) {
            boundaryPts.push(interpAtArc((i / NUM_MINI) * totalArc));
        }

        for (let i = 0; i < NUM_MINI; i++) {
            const arcStart = (i / NUM_MINI) * totalArc;
            const arcEnd = ((i + 1) / NUM_MINI) * totalArc;
            const baseColor = activeResults[i]?.color ?? "#333";
            const pinstripe = activeResults[i]?.pinstripe ?? false;
            const color = pinstripe ? teammateVariant(baseColor) : baseColor;

            const segPts: { px: number; py: number }[] = [boundaryPts[i]];
            for (let j = 0; j < outline.length; j++) {
                if (arcs[j] > arcStart && arcs[j] < arcEnd) {
                    segPts.push(canvasPts[j]);
                }
            }
            segPts.push(boundaryPts[i + 1]);

            segments.push({ points: segPts, color, pinstripe });
        }

        // S1/S2 boundary tick marks at 1/3 and 2/3 arc length
        const sectorBoundaries = [1, 2].map((s) => {
            const arc = (s / 3) * totalArc;
            return { pt: interpAtArc(arc), tan: tangentAtArc(arc) };
        });

        const sfPt = canvasPts[0];
        const sfTan = tangentAtArc(totalArc * 0.005);

        const arrowArc = totalArc * 0.12;
        const arrowPt = interpAtArc(arrowArc);
        const arrowTan = tangentAtArc(arrowArc);

        return {
            segments,
            bounds,
            closedPath,
            sectorBoundaries,
            sfPt,
            sfTan,
            arrowPt,
            arrowTan,
        };
    }, [trackData, miniSectorData, activeResults]);

    /* ── Convert client mouse coords → SVG viewBox coords ───────────── */

    function clientToSvgCoords(
        svgEl: SVGSVGElement,
        clientX: number,
        clientY: number,
    ): { x: number; y: number } {
        const rect = svgEl.getBoundingClientRect();
        return {
            x: ((clientX - rect.left) / rect.width) * W,
            y: ((clientY - rect.top) / rect.height) * H,
        };
    }

    /* ── All unique drivers for glow filter generation ──────────────── */

    const allDominanceDrivers = useMemo(() => {
        if (!miniSectorData) return [];
        const seen = new Map<number, { color: string; name: string }>();
        for (const r of miniSectorData.results) {
            if (r.bestNum != null && !seen.has(r.bestNum))
                seen.set(r.bestNum, { color: r.color, name: r.name });
        }
        return Array.from(seen.entries()).map(([num, v]) => ({ num, ...v }));
    }, [miniSectorData]);

    /* ── Focused driver info helpers ─────────────────────────────────── */

    const focusSet = new Set(focusDrivers);
    const isComparing = focusDrivers.length >= 2;

    function getDriverInfo(num: number) {
        const d = drivers.find((dr) => dr.driver_number === num);
        return {
            color: `#${d?.team_colour ?? "888888"}`,
            name: d?.name_acronym ?? String(num),
        };
    }

    function handleSegmentClick(bestNum: number | null) {
        if (bestNum == null) return;
        if (focusSet.has(bestNum)) {
            onFocusDrivers(focusDrivers.filter((n) => n !== bestNum));
        } else {
            onFocusDrivers([...focusDrivers, bestNum]);
        }
    }

    /* ── Render ──────────────────────────────────────────────────────── */

    if (!sectors.length)
        return <p className="text-f1-muted text-sm">No sector data.</p>;

    return (
        <div className="space-y-4">
            {/* Track map with minisector coloring */}
            {trackSegments && (
                <div className="flex justify-center">
                    <svg
                        ref={svgRef}
                        viewBox={`0 0 ${W} ${H}`}
                        style={{ width: "100%", maxWidth: 500 }}
                        preserveAspectRatio="xMidYMid meet"
                        onMouseLeave={() => {
                            setHoveredSegment(null);
                            setTooltip(null);
                        }}
                    >
                        <defs>
                            {/* Per-driver glow filters */}
                            {allDominanceDrivers.map((d) => (
                                <filter
                                    key={d.num}
                                    id={`glow-${d.num}`}
                                    x="-60%"
                                    y="-60%"
                                    width="220%"
                                    height="220%"
                                >
                                    <feGaussianBlur
                                        stdDeviation="4"
                                        result="blur"
                                    />
                                    <feFlood
                                        floodColor={d.color}
                                        floodOpacity="0.9"
                                        result="color"
                                    />
                                    <feComposite
                                        in="color"
                                        in2="blur"
                                        operator="in"
                                        result="glow"
                                    />
                                    <feMerge>
                                        <feMergeNode in="glow" />
                                        <feMergeNode in="SourceGraphic" />
                                    </feMerge>
                                </filter>
                            ))}
                        </defs>

                        {/* Dark track background + gray underlay */}
                        <>
                            <path
                                d={trackSegments.closedPath}
                                fill="none"
                                stroke="#1a1a2e"
                                strokeWidth={TRACK_STROKE + 4}
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            />
                            <path
                                d={trackSegments.closedPath}
                                fill="none"
                                stroke="#2d2d44"
                                strokeWidth={TRACK_STROKE}
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            />
                        </>

                        {/* Colored minisector segments — interactive */}
                        {trackSegments.segments.map((seg, i) => {
                            if (seg.points.length < 2) return null;

                            const d = seg.points
                                .map(
                                    (p, j) =>
                                        `${j === 0 ? "M" : "L"}${p.px.toFixed(1)},${p.py.toFixed(1)}`,
                                )
                                .join(" ");

                            const result = activeResults[i];
                            const isHovered = hoveredSegment === i;
                            const isFocused =
                                focusDrivers.length > 0 &&
                                focusSet.has(result?.bestNum ?? -1);
                            const isMuted =
                                focusDrivers.length > 0 && !isFocused;

                            const strokeW = isHovered
                                ? TRACK_STROKE + 3
                                : isFocused
                                  ? TRACK_STROKE + 2
                                  : TRACK_STROKE;

                            return (
                                <g
                                    key={i}
                                    opacity={isMuted ? 0.18 : 1}
                                    filter={
                                        (isFocused || isHovered) &&
                                        result?.bestNum != null
                                            ? `url(#glow-${result.bestNum})`
                                            : undefined
                                    }
                                    onMouseEnter={(e) => {
                                        setHoveredSegment(i);
                                        if (svgRef.current) {
                                            const { x, y } = clientToSvgCoords(
                                                svgRef.current,
                                                e.clientX,
                                                e.clientY,
                                            );
                                            let breakdown:
                                                | TooltipInfo["breakdown"]
                                                | undefined;
                                            if (isComparing && miniSectorData) {
                                                const ms =
                                                    miniSectorData.results[i];
                                                breakdown = focusDrivers
                                                    .map((num) => {
                                                        const info =
                                                            getDriverInfo(num);
                                                        return {
                                                            num,
                                                            color: info.color,
                                                            name: info.name,
                                                            time:
                                                                ms.allTimes.get(
                                                                    num,
                                                                ) ?? null,
                                                        };
                                                    })
                                                    .sort(
                                                        (a, b) =>
                                                            (a.time ??
                                                                Infinity) -
                                                            (b.time ??
                                                                Infinity),
                                                    );
                                            }
                                            setTooltip({
                                                segIdx: i,
                                                color: seg.color,
                                                name: result?.name ?? "–",
                                                time: result?.bestTime ?? null,
                                                svgX: x,
                                                svgY: y,
                                                breakdown,
                                            });
                                        }
                                    }}
                                    onMouseMove={(e) => {
                                        if (svgRef.current) {
                                            const { x, y } = clientToSvgCoords(
                                                svgRef.current,
                                                e.clientX,
                                                e.clientY,
                                            );
                                            setTooltip((prev) =>
                                                prev
                                                    ? {
                                                          ...prev,
                                                          svgX: x,
                                                          svgY: y,
                                                      }
                                                    : prev,
                                            );
                                        }
                                    }}
                                    onMouseLeave={() => {
                                        setHoveredSegment(null);
                                        setTooltip(null);
                                    }}
                                    onClick={() =>
                                        handleSegmentClick(
                                            result?.bestNum ?? null,
                                        )
                                    }
                                >
                                    <path
                                        d={d}
                                        fill="none"
                                        stroke={seg.color}
                                        strokeWidth={strokeW}
                                        strokeLinecap="butt"
                                        strokeLinejoin="round"
                                        style={{
                                            cursor: "pointer",
                                            transition:
                                                "stroke-width 0.1s, opacity 0.15s",
                                        }}
                                    />
                                </g>
                            );
                        })}

                        {/* Sector boundary tick lines at S1/S2 */}
                        {trackSegments.sectorBoundaries.map((b, idx) => {
                            const TICK = 10;
                            const nx = -b.tan.dy;
                            const ny = b.tan.dx;
                            return (
                                <g key={idx}>
                                    <line
                                        x1={b.pt.px - nx * TICK}
                                        y1={b.pt.py - ny * TICK}
                                        x2={b.pt.px + nx * TICK}
                                        y2={b.pt.py + ny * TICK}
                                        stroke="#ffffff"
                                        strokeWidth={2}
                                        strokeOpacity={0.55}
                                    />
                                    <text
                                        x={b.pt.px + nx * (TICK + 8)}
                                        y={b.pt.py + ny * (TICK + 8) + 4}
                                        fontSize={10}
                                        fill="#ffffff"
                                        fillOpacity={0.65}
                                        textAnchor="middle"
                                        fontWeight="bold"
                                    >
                                        S{idx + 2}
                                    </text>
                                </g>
                            );
                        })}

                        {/* Start/finish line */}
                        {(() => {
                            const SF = 13;
                            const { sfPt, sfTan } = trackSegments;
                            const nx = -sfTan.dy;
                            const ny = sfTan.dx;
                            return (
                                <g>
                                    <line
                                        x1={sfPt.px - nx * SF}
                                        y1={sfPt.py - ny * SF}
                                        x2={sfPt.px + nx * SF}
                                        y2={sfPt.py + ny * SF}
                                        stroke="#ffffff"
                                        strokeWidth={3}
                                        strokeOpacity={0.9}
                                    />
                                    <text
                                        x={sfPt.px + nx * (SF + 9)}
                                        y={sfPt.py + ny * (SF + 9) + 4}
                                        fontSize={9}
                                        fill="#ffffff"
                                        fillOpacity={0.8}
                                        textAnchor="middle"
                                        fontWeight="bold"
                                    >
                                        S/F
                                    </text>
                                </g>
                            );
                        })()}

                        {/* Direction arrow */}
                        {(() => {
                            const { arrowPt, arrowTan } = trackSegments;
                            const STEM = 10;
                            const HEAD = 6;
                            const tx = arrowPt.px + arrowTan.dx * STEM;
                            const ty = arrowPt.py + arrowTan.dy * STEM;
                            const nx = -arrowTan.dy;
                            const ny = arrowTan.dx;
                            return (
                                <polygon
                                    points={`
                                        ${tx.toFixed(1)},${ty.toFixed(1)}
                                        ${(tx - arrowTan.dx * HEAD + nx * HEAD * 0.55).toFixed(1)},${(ty - arrowTan.dy * HEAD + ny * HEAD * 0.55).toFixed(1)}
                                        ${(tx - arrowTan.dx * HEAD - nx * HEAD * 0.55).toFixed(1)},${(ty - arrowTan.dy * HEAD - ny * HEAD * 0.55).toFixed(1)}
                                    `}
                                    fill="#ffffff"
                                    fillOpacity={0.5}
                                />
                            );
                        })()}

                        {/* Floating tooltip (SVG-space) */}
                        {tooltip &&
                            (() => {
                                const PT = 8;
                                const hasBreakdown =
                                    tooltip.breakdown &&
                                    tooltip.breakdown.length >= 2;
                                const TW = hasBreakdown ? 140 : 72;
                                // Each breakdown row is ~18px; base height 44 + header
                                const TH = hasBreakdown
                                    ? 28 + tooltip.breakdown!.length * 20
                                    : 60;
                                const tx = Math.min(
                                    Math.max(tooltip.svgX + 14, PT),
                                    W - TW - PT,
                                );
                                const ty = Math.min(
                                    Math.max(tooltip.svgY - TH - 10, PT),
                                    H - TH - PT,
                                );

                                if (hasBreakdown) {
                                    // Comparison tooltip: ranked list of focused drivers
                                    const rows = tooltip.breakdown!;
                                    const fastestTime = rows[0]?.time ?? null;
                                    return (
                                        <g style={{ pointerEvents: "none" }}>
                                            <rect
                                                x={tx}
                                                y={ty}
                                                width={TW}
                                                height={TH}
                                                rx={5}
                                                fill="#0c0c1e"
                                                fillOpacity={0.95}
                                                stroke="#ffffff"
                                                strokeWidth={1}
                                                strokeOpacity={0.15}
                                            />
                                            <text
                                                x={tx + PT}
                                                y={ty + 14}
                                                fontSize={9}
                                                fill="#6b7280"
                                                fontWeight="bold"
                                                textAnchor="start"
                                            >
                                                MINI {tooltip.segIdx + 1} /{" "}
                                                {NUM_MINI}
                                            </text>
                                            {rows.map((r, ri) => {
                                                const rowY = ty + 26 + ri * 20;
                                                const delta =
                                                    r.time != null &&
                                                    fastestTime != null
                                                        ? r.time - fastestTime
                                                        : null;
                                                const isFirst = ri === 0;
                                                return (
                                                    <g key={r.num}>
                                                        <circle
                                                            cx={tx + PT + 4}
                                                            cy={rowY - 3}
                                                            r={4}
                                                            fill={r.color}
                                                        />
                                                        <text
                                                            x={tx + PT + 12}
                                                            y={rowY}
                                                            fontSize={11}
                                                            fill={r.color}
                                                            fontWeight="900"
                                                            textAnchor="start"
                                                        >
                                                            {r.name}
                                                        </text>
                                                        <text
                                                            x={tx + TW - PT}
                                                            y={rowY}
                                                            fontSize={10}
                                                            fill={
                                                                isFirst
                                                                    ? "#a78bfa"
                                                                    : "#f59e0b"
                                                            }
                                                            fontFamily="monospace"
                                                            textAnchor="end"
                                                        >
                                                            {r.time != null
                                                                ? isFirst
                                                                    ? `${(r.time / 1000).toFixed(3)}s`
                                                                    : `+${delta != null ? delta.toFixed(0) : "?"}ms`
                                                                : "–"}
                                                        </text>
                                                    </g>
                                                );
                                            })}
                                        </g>
                                    );
                                }

                                // Default single-driver tooltip
                                return (
                                    <g style={{ pointerEvents: "none" }}>
                                        <rect
                                            x={tx}
                                            y={ty}
                                            width={TW}
                                            height={TH}
                                            rx={5}
                                            fill="#0c0c1e"
                                            fillOpacity={0.93}
                                            stroke={tooltip.color}
                                            strokeWidth={1.5}
                                        />
                                        <text
                                            x={tx + PT}
                                            y={ty + 16}
                                            fontSize={9}
                                            fill="#6b7280"
                                            fontWeight="bold"
                                            textAnchor="start"
                                        >
                                            MINI {tooltip.segIdx + 1} /{" "}
                                            {NUM_MINI}
                                        </text>
                                        <text
                                            x={tx + PT}
                                            y={ty + 32}
                                            fontSize={14}
                                            fill={tooltip.color}
                                            fontWeight="900"
                                            textAnchor="start"
                                        >
                                            {tooltip.name}
                                        </text>
                                        <text
                                            x={tx + PT}
                                            y={ty + 49}
                                            fontSize={10}
                                            fill="#e5e7eb"
                                            fontFamily="monospace"
                                            textAnchor="start"
                                        >
                                            {tooltip.time != null
                                                ? `${(tooltip.time / 1000).toFixed(3)}s`
                                                : "–"}
                                        </text>
                                    </g>
                                );
                            })()}
                    </svg>
                </div>
            )}

            {/* Driver dominance pills */}
            {dominance.length > 0 && (
                <div className="flex flex-wrap gap-2 items-center">
                    <span className="text-[10px] text-f1-muted uppercase tracking-wider shrink-0 mr-1">
                        {isComparing ? "Head-to-head" : "Sectors won"}
                    </span>
                    {dominance.map((d) => {
                        const focused = focusSet.has(d.num);
                        const muted = focusDrivers.length > 0 && !focused;
                        return (
                            <button
                                key={d.num}
                                onClick={() => {
                                    if (focusSet.has(d.num)) {
                                        onFocusDrivers(
                                            focusDrivers.filter(
                                                (n) => n !== d.num,
                                            ),
                                        );
                                    } else {
                                        onFocusDrivers([
                                            ...focusDrivers,
                                            d.num,
                                        ]);
                                    }
                                }}
                                className={`flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-bold border transition-all ${
                                    focused
                                        ? "ring-1 ring-white/30"
                                        : muted
                                          ? "opacity-25"
                                          : "hover:brightness-125"
                                }`}
                                style={{
                                    borderColor: d.pinstripe
                                        ? teammateVariant(d.color)
                                        : d.color,
                                    color: d.pinstripe
                                        ? teammateVariant(d.color)
                                        : d.color,
                                    backgroundColor: d.pinstripe
                                        ? teammateVariant(d.color)
                                              .replace("hsl(", "hsla(")
                                              .replace(")", ", 0.1)")
                                        : `${d.color}1a`,
                                }}
                            >
                                {/* Single dot in the driver's actual rendered colour */}
                                <span
                                    className="w-2 h-2 rounded-full shrink-0"
                                    style={{
                                        backgroundColor: d.pinstripe
                                            ? teammateVariant(d.color)
                                            : d.color,
                                    }}
                                />
                                {d.name}
                                <span className="text-white/50 font-normal">
                                    {d.count}/{NUM_MINI}
                                </span>
                            </button>
                        );
                    })}
                    {focusDrivers.length > 0 && (
                        <button
                            onClick={() => onFocusDrivers([])}
                            className="text-[10px] text-white/30 hover:text-white/60 transition-colors ml-auto"
                        >
                            Clear
                        </button>
                    )}
                </div>
            )}

            {/* 3 main sector cards */}
            <div className="flex gap-3 flex-wrap">
                {sectors.map((s) => {
                    const focused = focusSet.has(s.driverNumber ?? -1);
                    const muted = focusDrivers.length > 0 && !focused;
                    return (
                        <button
                            key={s.label}
                            onClick={() => {
                                if (s.driverNumber == null) return;
                                if (focusSet.has(s.driverNumber)) {
                                    onFocusDrivers(
                                        focusDrivers.filter(
                                            (n) => n !== s.driverNumber,
                                        ),
                                    );
                                } else {
                                    onFocusDrivers([
                                        ...focusDrivers,
                                        s.driverNumber!,
                                    ]);
                                }
                            }}
                            className={`flex-1 min-w-[90px] rounded-lg border p-3 text-left transition-all ${muted ? "opacity-30" : ""} ${focused ? "ring-1 ring-white/30" : "hover:brightness-110"}`}
                            style={{ borderColor: s.color }}
                        >
                            <p className="text-[10px] text-f1-muted uppercase tracking-wider mb-1">
                                {s.label} Best
                            </p>
                            <p
                                className="text-base font-black"
                                style={{ color: s.color }}
                            >
                                {fmt(s.time)}
                            </p>
                            <p className="text-[10px] text-f1-muted mt-1">
                                #{s.driverNumber} {s.name}
                            </p>
                        </button>
                    );
                })}
            </div>

            {/* Minisector table */}
            {miniSectorData && (
                <div className="overflow-x-auto">
                    <table className="w-full text-[11px]">
                        <thead>
                            <tr className="border-b border-f1-border text-f1-muted uppercase tracking-wider">
                                <th className="py-1 text-left font-medium">
                                    Sector
                                </th>
                                {isComparing ? (
                                    // One column per focused driver
                                    focusDrivers.map((num) => {
                                        const info = getDriverInfo(num);
                                        return (
                                            <th
                                                key={num}
                                                className="py-1 text-right font-medium"
                                                style={{ color: info.color }}
                                            >
                                                {info.name}
                                            </th>
                                        );
                                    })
                                ) : (
                                    <>
                                        <th className="py-1 text-left font-medium">
                                            Driver
                                        </th>
                                        <th className="py-1 text-right font-medium">
                                            Time
                                        </th>
                                    </>
                                )}
                            </tr>
                        </thead>
                        <tbody>
                            {miniSectorData.results.map((ms) => {
                                const activeResult = activeResults[ms.idx];
                                const muted =
                                    !isComparing &&
                                    focusDrivers.length === 1 &&
                                    focusDrivers[0] !== ms.bestNum;
                                const isHovered = hoveredSegment === ms.idx;
                                if (isComparing) {
                                    // Per-driver time cells; fastest gets purple dot
                                    const times = focusDrivers.map(
                                        (num) => ms.allTimes.get(num) ?? null,
                                    );
                                    const validTimes = times.filter(
                                        (t): t is number => t != null,
                                    );
                                    const fastestTime = validTimes.length
                                        ? Math.min(...validTimes)
                                        : null;

                                    return (
                                        <tr
                                            key={ms.idx}
                                            className={`border-b border-f1-border/30 transition-all ${isHovered ? "bg-white/10" : "hover:bg-white/5"}`}
                                            onMouseEnter={() =>
                                                setHoveredSegment(ms.idx)
                                            }
                                            onMouseLeave={() =>
                                                setHoveredSegment(null)
                                            }
                                        >
                                            <td className="py-1">
                                                <span
                                                    className="inline-block w-3 h-2 rounded-sm mr-1.5"
                                                    style={{
                                                        backgroundColor:
                                                            activeResult?.color ??
                                                            "#555",
                                                    }}
                                                />
                                                {ms.idx + 1}
                                            </td>
                                            {focusDrivers.map((num, ci) => {
                                                const t = times[ci];
                                                const isFastest =
                                                    t != null &&
                                                    fastestTime != null &&
                                                    t === fastestTime;
                                                const deltaMs =
                                                    t != null &&
                                                    fastestTime != null
                                                        ? t - fastestTime
                                                        : null;
                                                const info = getDriverInfo(num);
                                                return (
                                                    <td
                                                        key={num}
                                                        className="py-1 text-right font-mono"
                                                    >
                                                        {t != null ? (
                                                            isFastest ? (
                                                                <span
                                                                    className="font-bold"
                                                                    style={{
                                                                        color: info.color,
                                                                    }}
                                                                >
                                                                    {(
                                                                        t / 1000
                                                                    ).toFixed(
                                                                        3,
                                                                    )}
                                                                    s
                                                                </span>
                                                            ) : (
                                                                <span className="text-amber-400">
                                                                    +
                                                                    {deltaMs !=
                                                                    null
                                                                        ? deltaMs.toFixed(
                                                                              0,
                                                                          )
                                                                        : "?"}
                                                                    ms
                                                                </span>
                                                            )
                                                        ) : (
                                                            <span className="text-f1-muted">
                                                                –
                                                            </span>
                                                        )}
                                                    </td>
                                                );
                                            })}
                                        </tr>
                                    );
                                }

                                // Default single-view row
                                return (
                                    <tr
                                        key={ms.idx}
                                        className={`border-b border-f1-border/30 cursor-pointer transition-all ${
                                            muted ? "opacity-25" : ""
                                        } ${isHovered ? "bg-white/10" : "hover:bg-white/5"}`}
                                        onMouseEnter={() =>
                                            setHoveredSegment(ms.idx)
                                        }
                                        onMouseLeave={() =>
                                            setHoveredSegment(null)
                                        }
                                        onClick={() =>
                                            handleSegmentClick(ms.bestNum)
                                        }
                                    >
                                        <td className="py-1">
                                            <span
                                                className="inline-block w-3 h-2 rounded-sm mr-1.5"
                                                style={{
                                                    backgroundColor: ms.color,
                                                }}
                                            />
                                            {ms.idx + 1}
                                        </td>
                                        <td
                                            className="py-1 font-bold"
                                            style={{ color: ms.color }}
                                        >
                                            {ms.name}
                                        </td>
                                        <td className="py-1 text-right font-mono">
                                            {ms.bestTime != null
                                                ? `${(ms.bestTime / 1000).toFixed(3)}s`
                                                : "–"}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}

            <p className="text-[10px] text-f1-muted">
                {isComparing
                    ? `Comparing ${focusDrivers.length} drivers — track colored by fastest among selected. Click table rows or track to compare.`
                    : `Track colored by fastest driver per minisector (${NUM_MINI} segments). Click a sector card, table row, or track segment to select drivers.`}
            </p>
        </div>
    );
}
