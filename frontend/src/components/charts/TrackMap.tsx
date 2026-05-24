import { memo, useEffect, useRef, useMemo } from "react";
import type { Driver, Interval, Lap, Position, Stint } from "../../types";
import { useTrackMapStream } from "../../hooks/useTrackMapStream";
import LoadingProgressBar from "../shared/LoadingProgressBar";

interface Props {
    sessionKey: number;
    drivers: Driver[];
    laps: Lap[];
    positions: Position[];
    stints: Stint[];
    intervals: Interval[];
    currentLap: number;
    maxLap: number;
    speed: number;
    isPlaying: boolean;
    highlightDriver: number | null;
    onLapChange: (lap: number) => void;
    onFinish: () => void;
}

// ── Types & constants ────────────────────────────────────────────────────────

interface Sample {
    x: number;
    y: number;
    time: number;
}
interface ArcSample {
    d: number;
    time: number;
}
interface TrackSeg {
    x: number;
    y: number;
    d: number;
}
type Bounds = { minX: number; maxX: number; minY: number; maxY: number };
type Pt = { x: number; y: number };

const W = 600;
const H = 500;
const PAD = 30;

// ── Helpers ──────────────────────────────────────────────────────────────────

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

function toCanvas(x: number, y: number, b: Bounds) {
    const rx = b.maxX - b.minX || 1;
    const ry = b.maxY - b.minY || 1;
    const scale = Math.min((W - PAD * 2) / rx, (H - PAD * 2) / ry);
    return {
        px: W / 2 + (x - (b.minX + b.maxX) / 2) * scale,
        py: H / 2 - (y - (b.minY + b.maxY) / 2) * scale,
    };
}

/** Binary-search + linear interpolation between two surrounding samples */
function interpolate(samples: Sample[], time: number): Pt | null {
    const n = samples.length;
    if (!n) return null;
    if (time <= samples[0].time) return samples[0];
    if (time >= samples[n - 1].time) return samples[n - 1];
    let lo = 0,
        hi = n - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (samples[mid].time <= time) lo = mid;
        else hi = mid;
    }
    const a = samples[lo],
        b = samples[hi];
    const t = (time - a.time) / (b.time - a.time || 1);
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/**
 * Curvature-aware polyline simplification (Ramer-Douglas-Peucker).
 * Keeps points whose perpendicular distance to the line between their
 * neighbours exceeds `eps`. Straights collapse to their endpoints; tight
 * corners retain all their points. This replaces uniform downsampling
 * which dropped corner detail and made cars cut apexes (Monaco T1).
 */
function douglasPeucker(pts: Pt[], eps: number): Pt[] {
    const n = pts.length;
    if (n < 3) return pts.slice();
    const eps2 = eps * eps;
    const keep = new Uint8Array(n);
    keep[0] = 1;
    keep[n - 1] = 1;
    const stack: Array<[number, number]> = [[0, n - 1]];
    while (stack.length) {
        const [lo, hi] = stack.pop()!;
        if (hi - lo < 2) continue;
        const a = pts[lo],
            b = pts[hi];
        const abx = b.x - a.x,
            aby = b.y - a.y;
        const len2 = abx * abx + aby * aby || 1;
        let maxD2 = 0,
            maxIdx = -1;
        for (let i = lo + 1; i < hi; i++) {
            const dx = pts[i].x - a.x,
                dy = pts[i].y - a.y;
            const cross = dx * aby - dy * abx;
            const d2 = (cross * cross) / len2;
            if (d2 > maxD2) {
                maxD2 = d2;
                maxIdx = i;
            }
        }
        if (maxIdx >= 0 && maxD2 > eps2) {
            keep[maxIdx] = 1;
            stack.push([lo, maxIdx]);
            stack.push([maxIdx, hi]);
        }
    }
    const out: Pt[] = [];
    for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
    return out;
}

/**
 * Build a track path with cumulative arc-length at each vertex.
 *
 * The outline data starts at the S/F crossing and ends ~1 GPS interval
 * before the next S/F crossing, leaving a small gap (several metres)
 * between outline[N-1] and outline[0]. We append a synthetic closure
 * segment from outline[N-1] back to outline[0] so that arc-length
 * mapping (`arcToPos`) wraps smoothly across S/F instead of jumping.
 * Projection (`projectToArc`) deliberately ignores this closure segment
 * via `openCount` so drivers near S/F never snap onto the chord across
 * track-empty space.
 */
function buildTrackPath(pts: Pt[]): {
    segs: TrackSeg[];
    totalLen: number;
    openCount: number;
} {
    const segs: TrackSeg[] = [{ x: pts[0].x, y: pts[0].y, d: 0 }];
    for (let i = 1; i < pts.length; i++) {
        const dx = pts[i].x - pts[i - 1].x,
            dy = pts[i].y - pts[i - 1].y;
        segs.push({
            x: pts[i].x,
            y: pts[i].y,
            d: segs[i - 1].d + Math.sqrt(dx * dx + dy * dy),
        });
    }
    const openCount = segs.length;
    // Virtual closure vertex: duplicate of pts[0] at d = openLen + closure chord
    const last = segs[openCount - 1];
    const cdx = pts[0].x - last.x,
        cdy = pts[0].y - last.y;
    const closureLen = Math.sqrt(cdx * cdx + cdy * cdy);
    segs.push({ x: pts[0].x, y: pts[0].y, d: last.d + closureLen });
    return { segs, totalLen: last.d + closureLen, openCount };
}

/**
 * Project a point onto the track and return its arc-length parameter.
 * Iterates only over real outline segments (`openCount - 1` of them) and
 * never onto the synthetic closure chord, so drivers at S/F always snap
 * to actual track geometry.
 */
function projectToArc(pt: Pt, segs: TrackSeg[], openCount: number): number {
    let bestD2 = Infinity,
        bestArc = 0;
    for (let i = 0; i < openCount - 1; i++) {
        const a = segs[i];
        const b = segs[i + 1];
        const abx = b.x - a.x,
            aby = b.y - a.y;
        const len2 = abx * abx + aby * aby;
        if (len2 < 1) continue;
        const t = Math.max(
            0,
            Math.min(1, ((pt.x - a.x) * abx + (pt.y - a.y) * aby) / len2),
        );
        const px = a.x + t * abx,
            py = a.y + t * aby;
        const dx = pt.x - px,
            dy = pt.y - py;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) {
            bestD2 = d2;
            bestArc = a.d + t * (b.d - a.d);
        }
    }
    return bestArc;
}

/**
 * Map an arc-length back to (x,y) on the track.
 * Uses modulo `totalLen` for lap wraparound, but never interpolates onto a
 * synthetic closure segment: arc values land on real outline segments only.
 * Out-of-range values clamp to the polyline endpoints.
 */
function arcToPos(d: number, segs: TrackSeg[], totalLen: number): Pt {
    d = ((d % totalLen) + totalLen) % totalLen;
    const last = segs.length - 1;
    if (d <= 0) return { x: segs[0].x, y: segs[0].y };
    if (d >= segs[last].d) return { x: segs[last].x, y: segs[last].y };
    let lo = 0,
        hi = last;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (segs[mid].d <= d) lo = mid;
        else hi = mid;
    }
    const a = segs[lo];
    const b = segs[lo + 1];
    const segLen = b.d - a.d;
    const t = segLen > 0 ? (d - a.d) / segLen : 0;
    return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
}

/** Convert driver samples to unwrapped arc-length samples */
function toArcSamples(
    samples: Sample[],
    segs: TrackSeg[],
    totalLen: number,
    openCount: number,
): ArcSample[] {
    if (!samples.length || !segs.length) return [];
    const result: ArcSample[] = [];
    let offset = 0,
        prevRaw = -1;
    for (const s of samples) {
        const raw = projectToArc(s, segs, openCount);
        if (prevRaw >= 0) {
            const diff = raw - prevRaw;
            if (diff < -totalLen * 0.3) offset += totalLen;
            else if (diff > totalLen * 0.7) offset -= totalLen;
        }
        result.push({ d: raw + offset, time: s.time });
        prevRaw = raw;
    }
    return result;
}

/** Binary-search + lerp in arc-length domain */
function interpolateArc(samples: ArcSample[], time: number): number | null {
    const n = samples.length;
    if (!n) return null;
    if (time <= samples[0].time) return samples[0].d;
    if (time >= samples[n - 1].time) return samples[n - 1].d;
    let lo = 0,
        hi = n - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (samples[mid].time <= time) lo = mid;
        else hi = mid;
    }
    const a = samples[lo],
        b = samples[hi];
    const t = (time - a.time) / (b.time - a.time || 1);
    return a.d + (b.d - a.d) * t;
}

// ── Component ────────────────────────────────────────────────────────────────

function TrackMap({
    sessionKey,
    drivers,
    laps,
    positions,
    stints,
    intervals,
    currentLap,
    speed,
    isPlaying,
    highlightDriver,
    maxLap: _maxLap,
    onLapChange,
    onFinish,
}: Props) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const stream = useTrackMapStream(sessionKey ?? null);
    const trackData = stream.data;
    const loading =
        !!sessionKey &&
        (stream.status === "idle" || stream.status === "loading");
    const error = stream.status === "error" ? (stream.error ?? null) : null;
    const rafRef = useRef(0);

    // Accumulation-based timing
    const raceTimeRef = useRef(0);
    const lastTickRef = useRef(0);
    const rateRef = useRef(0); // race-ms per wall-ms
    const prevLapRef = useRef(0);
    const lapRef = useRef(currentLap);
    const lapRangesRef = useRef<Map<number, { start: number; end: number }>>(
        new Map(),
    );
    const speedRef = useRef(speed);
    const onLapChangeRef = useRef(onLapChange);
    const onFinishRef = useRef(onFinish);
    lapRef.current = currentLap;
    speedRef.current = speed;
    onLapChangeRef.current = onLapChange;
    onFinishRef.current = onFinish;

    // ── Memos ─────────────────────────────────────────────────────────────────

    const parsed = useMemo(() => {
        if (!trackData) return new Map<number, Sample[]>();
        const m = new Map<number, Sample[]>();
        for (const [dn, pts] of Object.entries(trackData.drivers))
            m.set(
                Number(dn),
                pts.map((p) => ({
                    x: p.x,
                    y: p.y,
                    time: new Date(p.date).getTime(),
                })),
            );
        return m;
    }, [trackData]);

    const bounds = useMemo(() => {
        const allPts: Pt[] = [];
        if (trackData?.outline.length) allPts.push(...trackData.outline);
        // Include a few driver samples so bounds work even without outline
        for (const samples of parsed.values()) {
            if (samples.length) {
                allPts.push(
                    samples[0],
                    samples[Math.floor(samples.length / 2)],
                    samples[samples.length - 1],
                );
            }
        }
        if (!allPts.length) return null;
        return computeBounds(allPts);
    }, [trackData, parsed]);

    const outlinePath = useMemo(() => {
        if (!trackData?.outline.length || !bounds) return null;
        const path = new Path2D();
        let first = true;
        for (const pt of trackData.outline) {
            const { px, py } = toCanvas(pt.x, pt.y, bounds);
            if (first) {
                path.moveTo(px, py);
                first = false;
            } else path.lineTo(px, py);
        }
        path.closePath();
        return path;
    }, [trackData, bounds]);

    // Curvature-aware simplified outline for the snap path. Epsilon is set
    // to ~0.05% of the track's X-range, which is small enough to preserve
    // tight corner detail (apexes survive) but large enough to remove
    // redundant points along straights. Output size is similar to the
    // previous uniform downsample (~150-250 pts) but with corners intact.
    const snapOutline = useMemo(() => {
        if (!trackData?.outline.length) return [];
        let minX = Infinity,
            maxX = -Infinity;
        for (const p of trackData.outline) {
            if (p.x < minX) minX = p.x;
            if (p.x > maxX) maxX = p.x;
        }
        const eps = (maxX - minX) * 0.0005;
        return douglasPeucker(trackData.outline, eps);
    }, [trackData]);

    // Arc-length parameterised track path
    const trackPath = useMemo(() => {
        if (snapOutline.length < 3) return null;
        return buildTrackPath(snapOutline);
    }, [snapOutline]);

    // Pre-project every driver's samples to arc-length (done once, O(drivers×samples×outlinePts))
    const arcSamples = useMemo(() => {
        if (!trackPath) return new Map<number, ArcSample[]>();
        const m = new Map<number, ArcSample[]>();
        for (const [dn, samples] of parsed)
            m.set(
                dn,
                toArcSamples(
                    samples,
                    trackPath.segs,
                    trackPath.totalLen,
                    trackPath.openCount,
                ),
            );
        return m;
    }, [parsed, trackPath]);

    const lapRanges = useMemo(() => {
        // Bucket valid date_start timestamps per lap. OpenF1 frequently
        // omits date_start for lap 1 (the standing-start lap is timed
        // differently) — those rows produce NaN/0 and would poison the
        // animation, so we drop them and back-fill below using each
        // lap's `lap_duration` so lap 1 starts at lights-out (not in
        // the formation lap).
        const starts = new Map<number, number[]>();
        const durations = new Map<number, number>(); // lap_number -> min duration (ms)
        for (const l of laps) {
            if (l.date_start) {
                const t = new Date(l.date_start).getTime();
                if (Number.isFinite(t)) {
                    starts.set(l.lap_number, [
                        ...(starts.get(l.lap_number) ?? []),
                        t,
                    ]);
                }
            }
            if (l.lap_duration && l.lap_duration > 0) {
                const ms = l.lap_duration * 1000;
                const cur = durations.get(l.lap_number);
                if (cur == null || ms < cur) durations.set(l.lap_number, ms);
            }
        }
        if (!starts.size)
            return new Map<number, { start: number; end: number }>();

        // Average lap duration from known starts (used to back-fill gaps).
        const known = [...starts.keys()].sort((a, b) => a - b);
        const knownStarts = known.map((n) => Math.min(...starts.get(n)!));
        let avg = 90_000;
        if (knownStarts.length > 1) {
            let sum = 0,
                count = 0;
            for (let i = 1; i < knownStarts.length; i++) {
                const d =
                    (knownStarts[i] - knownStarts[i - 1]) /
                    (known[i] - known[i - 1]);
                if (Number.isFinite(d) && d > 0) {
                    sum += d;
                    count++;
                }
            }
            if (count) avg = sum / count;
        }

        // Cover the full lap range, walking backwards from the last
        // known lap so each missing entry can subtract its own duration
        // from the next lap's start.
        const minLap = Math.min(known[0], 1);
        const maxLap = known[known.length - 1];
        const ranges = new Map<number, { start: number; end: number }>();
        for (let n = maxLap; n >= minLap; n--) {
            if (starts.has(n)) {
                ranges.set(n, {
                    start: Math.min(...starts.get(n)!),
                    end: 0,
                });
                continue;
            }
            // Back-fill: prefer lap n's own recorded lap_duration
            // (covers lap 1's longer standing-start duration); fall
            // back to the average racing lap duration.
            const next = ranges.get(n + 1);
            if (!next) continue;
            const dur = durations.get(n) ?? avg;
            ranges.set(n, { start: next.start - dur, end: 0 });
        }
        // Compute end as next lap's start (or +avg for the final lap)
        for (let n = minLap; n <= maxLap; n++) {
            const cur = ranges.get(n);
            if (!cur) continue;
            const nxt = ranges.get(n + 1);
            cur.end = nxt ? nxt.start : cur.start + avg;
        }
        return ranges;
    }, [laps]);
    lapRangesRef.current = lapRanges;

    // Average lap duration (for speed → race-time conversion)
    const avgLapDur = useMemo(() => {
        if (!lapRanges.size) return 90_000;
        let sum = 0;
        for (const r of lapRanges.values()) sum += r.end - r.start;
        return sum / lapRanges.size;
    }, [lapRanges]);

    // Determine max lap each driver completed
    const driverMaxLap = useMemo(() => {
        const m = new Map<number, number>();
        for (const l of laps) {
            const cur = m.get(l.driver_number) ?? 0;
            if (l.lap_number > cur) m.set(l.driver_number, l.lap_number);
        }
        return m;
    }, [laps]);

    // Find the overall race max lap (to distinguish finishers from retirees)
    const raceMaxLap = useMemo(() => {
        let mx = 0;
        for (const v of driverMaxLap.values()) if (v > mx) mx = v;
        return mx;
    }, [driverMaxLap]);

    const retiredAt = useMemo(() => {
        const map = new Map<number, number>();
        for (const [dn, samples] of parsed) {
            if (samples.length < 10) continue;
            // Skip drivers who completed the race (finished within 2 laps of leader)
            const maxLap = driverMaxLap.get(dn) ?? 0;
            if (maxLap >= raceMaxLap - 1) continue;

            let lastMovingIdx = 0;
            for (let i = 1; i < samples.length; i++) {
                const dx = samples[i].x - samples[i - 1].x;
                const dy = samples[i].y - samples[i - 1].y;
                if (dx * dx + dy * dy > 2500) lastMovingIdx = i;
            }
            if (samples.length - lastMovingIdx > 10) {
                const staticMs =
                    samples[samples.length - 1].time -
                    samples[lastMovingIdx].time;
                if (staticMs > 180_000)
                    map.set(dn, samples[lastMovingIdx].time + 5_000);
            }
        }
        return map;
    }, [parsed, driverMaxLap, raceMaxLap]);

    // ── Position tower data ────────────────────────────────────────────────

    interface Standing {
        driver: Driver;
        position: number;
        status: string;
        gap: string;
        interval: string;
        tyre: string;
        tyreAge: number;
        pits: number;
        hasFastestLap: boolean;
    }

    const standings = useMemo((): Standing[] => {
        // Resolve a usable timestamp for the current lap. lapRanges
        // back-fills missing date_start values (e.g. lap 1) so this is
        // always finite when we have any lap data.
        const range = lapRanges.get(currentLap);
        const lapTime = range ? range.start : NaN;
        const haveLapTime = Number.isFinite(lapTime);

        // Positions: latest per driver at/before current lap time
        const driverPos = new Map<number, number>();
        if (haveLapTime) {
            const latestPerDriver = new Map<number, Position>();
            for (const p of positions) {
                const pTime = new Date(p.date).getTime();
                if (pTime <= lapTime + 120_000) {
                    const prev = latestPerDriver.get(p.driver_number);
                    if (!prev || new Date(prev.date).getTime() < pTime)
                        latestPerDriver.set(p.driver_number, p);
                }
            }
            for (const [dn, p] of latestPerDriver)
                driverPos.set(dn, p.position);
        } else {
            for (const p of positions)
                driverPos.set(p.driver_number, p.position);
        }

        // Intervals: latest gap_to_leader and interval per driver at current lap
        const driverGap = new Map<number, number | null>();
        const driverInt = new Map<number, number | null>();
        if (haveLapTime) {
            for (const iv of intervals) {
                const iTime = new Date(iv.date).getTime();
                if (iTime <= lapTime + 120_000) {
                    driverGap.set(iv.driver_number, iv.gap_to_leader);
                    driverInt.set(iv.driver_number, iv.interval);
                }
            }
        }

        // Tyre compound + age from stints
        const driverTyre = new Map<number, { compound: string; age: number }>();
        for (const st of stints) {
            if (currentLap >= st.lap_start && currentLap <= st.lap_end) {
                driverTyre.set(st.driver_number, {
                    compound: st.compound,
                    age: st.tyre_age_at_start + (currentLap - st.lap_start),
                });
            }
        }

        // Pit stop count
        const driverPits = new Map<number, number>();
        for (const st of stints) {
            if (st.stint_number > 1 && st.lap_start <= currentLap) {
                driverPits.set(
                    st.driver_number,
                    (driverPits.get(st.driver_number) ?? 0) + 1,
                );
            }
        }

        // Pit-out detection
        const pitOut = new Set<number>();
        for (const l of laps) {
            if (l.lap_number === currentLap && l.is_pit_out_lap)
                pitOut.add(l.driver_number);
        }

        // Fastest lap: find the driver with the best lap time up to currentLap
        let fastestDriver: number | null = null;
        let fastestTime = Infinity;
        for (const l of laps) {
            if (
                l.lap_number <= currentLap &&
                l.lap_duration &&
                l.lap_duration > 0
            ) {
                if (l.lap_duration < fastestTime) {
                    fastestTime = l.lap_duration;
                    fastestDriver = l.driver_number;
                }
            }
        }

        // Current lap start time (used to check retirement timing)
        const currentLapTime = haveLapTime ? lapTime : 0;

        // Build
        const result: Standing[] = [];
        for (const drv of drivers) {
            const pos = driverPos.get(drv.driver_number) ?? 99;
            const retireTime = retiredAt.get(drv.driver_number);
            const retired = retireTime != null && currentLapTime >= retireTime;
            const gap = driverGap.get(drv.driver_number);
            const intv = driverInt.get(drv.driver_number);
            const tyre = driverTyre.get(drv.driver_number);

            let status = "ON TRACK";
            if (retired) status = "OUT";
            else if (pitOut.has(drv.driver_number)) status = "PIT";

            const fmtGap = gap != null ? `+${Number(gap).toFixed(1)}s` : "";
            const fmtInt = intv != null ? `+${Number(intv).toFixed(1)}s` : "";

            result.push({
                driver: drv,
                position: pos,
                status,
                gap: pos === 1 ? "LEADER" : fmtGap,
                interval: pos === 1 ? "" : fmtInt,
                tyre: tyre?.compound ?? "",
                tyreAge: tyre?.age ?? 0,
                pits: driverPits.get(drv.driver_number) ?? 0,
                hasFastestLap: drv.driver_number === fastestDriver,
            });
        }
        result.sort((a, b) => a.position - b.position);
        return result;
    }, [
        positions,
        laps,
        stints,
        intervals,
        drivers,
        currentLap,
        retiredAt,
        lapRanges,
    ]);

    // ── Sync: rate + scrub only (animation drives lap changes, not the other way) ──

    useEffect(() => {
        const range = lapRanges.get(currentLap);
        if (!range) return;

        const lapDur = range.end - range.start || avgLapDur;
        rateRef.current = isPlaying ? (lapDur * speed) / 5000 : 0;
    }, [speed, isPlaying, currentLap, lapRanges, avgLapDur]);

    // Snap on slider scrub or first load
    useEffect(() => {
        const range = lapRanges.get(currentLap);
        if (!range) return;

        const isFirstLoad = prevLapRef.current === 0;
        const isNormalAdvance = currentLap === prevLapRef.current + 1;
        prevLapRef.current = currentLap;

        if (isFirstLoad || !isNormalAdvance) {
            raceTimeRef.current = range.start;
            lastTickRef.current = 0;
        }
    }, [currentLap, lapRanges]);

    // ── Persistent rAF loop ──────────────────────────────────────────────────

    useEffect(() => {
        if (!bounds || !parsed.size) return;

        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const dpr = window.devicePixelRatio || 1;
        canvas.width = W * dpr;
        canvas.height = H * dpr;
        canvas.style.width = `${W}px`;
        canvas.style.height = `${H}px`;

        const tp = trackPath;
        const arcS = arcSamples;
        let running = true;

        function tick(now: number) {
            if (!running) return;

            const raw = lastTickRef.current ? now - lastTickRef.current : 16;
            lastTickRef.current = now;
            // If frame was delayed (React re-render stall), freeze instead of jumping
            if (raw <= 50) raceTimeRef.current += raw * rateRef.current;
            const raceTime = raceTimeRef.current;

            // Detect lap boundary crossing — animation drives lap changes
            const curLap = lapRef.current;
            const curRange = lapRangesRef.current.get(curLap);
            if (curRange && raceTime >= curRange.end) {
                const nextRange = lapRangesRef.current.get(curLap + 1);
                if (nextRange) {
                    // Update rate for next lap
                    const lapDur = nextRange.end - nextRange.start || 90_000;
                    rateRef.current = (lapDur * speedRef.current) / 5000;
                    onLapChangeRef.current(curLap + 1);
                } else {
                    // Race finished
                    rateRef.current = 0;
                    onFinishRef.current();
                }
            }

            ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx!.clearRect(0, 0, W, H);

            // Track outline (if available)
            if (outlinePath) {
                ctx!.strokeStyle = "#374151";
                ctx!.lineWidth = 6;
                ctx!.lineCap = "round";
                ctx!.lineJoin = "round";
                ctx!.stroke(outlinePath);
                ctx!.strokeStyle = "#4b5563";
                ctx!.lineWidth = 2;
                ctx!.stroke(outlinePath);
            }

            // Drivers
            for (const drv of drivers) {
                const samples = parsed.get(drv.driver_number);
                if (!samples?.length) continue;

                const retire = retiredAt.get(drv.driver_number);
                if (retire && raceTime > retire) continue;

                // Arc-length interpolation (follows track curves) with fallback
                let pos: Pt | null = null;
                const arc = arcS.get(drv.driver_number);
                if (arc?.length && tp) {
                    const d = interpolateArc(arc, raceTime);
                    if (d !== null) pos = arcToPos(d, tp.segs, tp.totalLen);
                }
                if (!pos) {
                    pos = interpolate(samples, raceTime);
                    if (!pos) continue;
                }

                const { px, py } = toCanvas(pos.x, pos.y, bounds!);
                const col = `#${drv.team_colour || "fff"}`;
                const hl = highlightDriver === drv.driver_number;
                const dim = highlightDriver != null && !hl;
                const r = hl ? 7 : 5;

                ctx!.globalAlpha = dim ? 0.15 : 1;
                ctx!.beginPath();
                ctx!.arc(px, py, r, 0, Math.PI * 2);
                ctx!.fillStyle = col;
                ctx!.fill();

                if (hl) {
                    ctx!.strokeStyle = "#fff";
                    ctx!.lineWidth = 2;
                    ctx!.stroke();
                }
                if (!dim) {
                    ctx!.font = "bold 9px monospace";
                    ctx!.fillStyle = col;
                    ctx!.textAlign = "center";
                    ctx!.fillText(drv.name_acronym, px, py - r - 3);
                }
                ctx!.globalAlpha = 1;
            }

            rafRef.current = requestAnimationFrame(tick);
        }

        rafRef.current = requestAnimationFrame(tick);
        return () => {
            running = false;
            cancelAnimationFrame(rafRef.current);
        };
    }, [
        bounds,
        outlinePath,
        drivers,
        parsed,
        highlightDriver,
        retiredAt,
        trackPath,
        arcSamples,
    ]);

    // ── Render ───────────────────────────────────────────────────────────────

    return (
        <div className="bg-f1-card rounded-xl border border-f1-border p-4">
            <h3 className="text-sm font-semibold mb-3 text-f1-muted uppercase tracking-wide">
                Track Map
            </h3>
            {loading ? (
                <div
                    className="flex flex-col justify-center text-f1-muted"
                    style={{ height: H }}
                >
                    <LoadingProgressBar
                        label="Loading track data"
                        loaded={stream.loaded}
                        total={stream.total}
                    />
                </div>
            ) : error ? (
                <div
                    className="flex items-center justify-center text-f1-muted"
                    style={{ height: H }}
                >
                    <p className="text-sm text-red-400">{error}</p>
                </div>
            ) : !trackData ? (
                <div
                    className="flex items-center justify-center text-f1-muted"
                    style={{ height: H }}
                >
                    <p className="text-sm">No track data available</p>
                </div>
            ) : (
                <div className="flex gap-3">
                    {/* Position Tower */}
                    <div
                        className="shrink-0 rounded-lg overflow-hidden text-xs bg-black/40"
                        style={{ width: 200, height: H, overflowY: "auto" }}
                    >
                        <div className="bg-black/70 px-2 py-1.5 font-bold text-[10px] text-white/70 uppercase tracking-wider border-b border-white/10 flex items-center justify-between">
                            <span>Lap {currentLap}</span>
                            <span className="text-white/40 normal-case">
                                Gap / Int
                            </span>
                        </div>
                        {standings.map((s) => {
                            const col = `#${s.driver.team_colour || "fff"}`;
                            const isHl =
                                highlightDriver === s.driver.driver_number;
                            const isDim = highlightDriver != null && !isHl;
                            const tyreColor: Record<string, string> = {
                                SOFT: "#ef4444",
                                MEDIUM: "#eab308",
                                HARD: "#f5f5f5",
                                INTERMEDIATE: "#22c55e",
                                WET: "#3b82f6",
                            };
                            return (
                                <div
                                    key={s.driver.driver_number}
                                    className="flex items-center gap-1 px-1.5 py-[3px] border-b border-white/5"
                                    style={{
                                        background: isHl
                                            ? "rgba(255,255,255,0.1)"
                                            : "transparent",
                                        opacity: isDim ? 0.3 : 1,
                                    }}
                                >
                                    {/* Position */}
                                    <span className="w-4 text-right font-mono text-white/50 text-[10px] shrink-0">
                                        {s.position}
                                    </span>
                                    {/* Team color */}
                                    <span
                                        className="w-[3px] h-3.5 rounded-sm shrink-0"
                                        style={{ background: col }}
                                    />
                                    {/* Name */}
                                    <span className="font-bold text-white text-[11px] tracking-wide w-8 shrink-0">
                                        {s.driver.name_acronym}
                                    </span>
                                    {/* Fastest lap indicator */}
                                    {s.hasFastestLap && (
                                        <span
                                            className="text-[9px] shrink-0"
                                            style={{ color: "#a855f7" }}
                                            title="Fastest Lap"
                                        >
                                            ⏱
                                        </span>
                                    )}
                                    {/* Status badge */}
                                    {s.status !== "ON TRACK" && (
                                        <span
                                            className="text-[8px] font-bold px-1 rounded shrink-0"
                                            style={{
                                                background:
                                                    s.status === "PIT"
                                                        ? "#eab308"
                                                        : "#ef4444",
                                                color:
                                                    s.status === "PIT"
                                                        ? "#000"
                                                        : "#fff",
                                            }}
                                        >
                                            {s.status}
                                        </span>
                                    )}
                                    {/* Tyre */}
                                    {s.tyre && (
                                        <span
                                            className="text-[9px] font-bold shrink-0 w-3 text-center"
                                            style={{
                                                color:
                                                    tyreColor[s.tyre] ??
                                                    "#9ca3af",
                                            }}
                                            title={`${s.tyre} (${s.tyreAge} laps)`}
                                        >
                                            {s.tyre[0]}
                                        </span>
                                    )}
                                    {/* Pit count */}
                                    {s.pits > 0 && (
                                        <span className="text-[8px] text-white/30 shrink-0">
                                            {s.pits}×
                                        </span>
                                    )}
                                    {/* Gap / Interval */}
                                    <span
                                        className="ml-auto text-right text-[9px] font-mono shrink-0"
                                        style={{
                                            color:
                                                s.gap === "LEADER"
                                                    ? "#f5f5f5"
                                                    : "#9ca3af",
                                            minWidth: 42,
                                        }}
                                    >
                                        {s.gap === "LEADER" ? (
                                            <span className="text-[8px] font-bold text-emerald-400">
                                                LEADER
                                            </span>
                                        ) : (
                                            <span title={`Int: ${s.interval}`}>
                                                {s.gap}
                                            </span>
                                        )}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                    {/* Track canvas */}
                    <div className="flex-1 flex justify-center">
                        <canvas
                            ref={canvasRef}
                            style={{ width: W, height: H }}
                            className="rounded-lg"
                        />
                    </div>
                </div>
            )}
        </div>
    );
}

export default memo(TrackMap);
