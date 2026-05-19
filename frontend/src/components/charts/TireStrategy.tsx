import { useMemo } from "react";
import type { Stint, Driver, Lap, Position } from "../../types";

interface Props {
    stints: Stint[];
    drivers: Driver[];
    laps: Lap[]; // ALL laps (not filtered to currentLap) — needed to know max
    positions: Position[];
    maxLap: number;
    currentLap: number;
}

const COMPOUND_COLORS: Record<string, string> = {
    SOFT: "#ef4444",
    MEDIUM: "#eab308",
    HARD: "#e5e7eb",
    INTERMEDIATE: "#22c55e",
    WET: "#3b82f6",
    UNKNOWN: "#6b7280",
};

const COMPOUND_TEXT: Record<string, string> = {
    SOFT: "#fff",
    MEDIUM: "#111",
    HARD: "#111",
    INTERMEDIATE: "#fff",
    WET: "#fff",
    UNKNOWN: "#fff",
};

// ── Sanitise stints ──────────────────────────────────────────────────────────
//
// OpenF1's /stints endpoint has known bugs:
//   • Overlapping lap ranges between consecutive stints for the same driver
//   • lap_end of stint N == lap_start of stint N+1 (off-by-one overlap)
//   • Spurious extra stints with tiny lap counts (1-2 laps) that are artefacts
//   • "Ghost" pitstops where compound doesn't change between stints
//
// Strategy: for each driver, sort stints by stint_number, rebuild
// non-overlapping ranges, cap at driver's actual last lap (DNF fix),
// then merge consecutive same-compound stints (ghost pitstop fix).
//
const MIN_REAL_STINT_LAPS = 3;

interface CleanStint {
    compound: string;
    lapStart: number;
    lapEnd: number; // inclusive
    stintIndex: number;
}

function sanitiseStints(
    rawStints: Stint[],
    driverNumber: number,
    raceTotalLaps: number,
    driverLastLap: number,
): CleanStint[] {
    const raw = rawStints
        .filter((s) => s.driver_number === driverNumber)
        .sort((a, b) => a.stint_number - b.stint_number);

    if (!raw.length) return [];

    // Cap at driver's actual last lap so DNF bars don't extend to end of race
    const driverMax = Math.min(driverLastLap, raceTotalLaps);

    const clean: CleanStint[] = [];
    let cursor = 1;

    for (let i = 0; i < raw.length; i++) {
        const s = raw[i];
        const isLast = i === raw.length - 1;

        const lapStart = Math.max(cursor, s.lap_start);
        const rawEnd = isLast ? Math.max(s.lap_end, driverMax) : s.lap_end;
        const nextStart = !isLast ? raw[i + 1].lap_start : Infinity;
        // Trim overlap with next stint AND cap at driver's last lap
        const lapEnd = Math.min(rawEnd, nextStart - 1, driverMax);

        const length = lapEnd - lapStart + 1;

        // Skip artefact stints that are too short (unless only or last stint)
        if (length < MIN_REAL_STINT_LAPS && !isLast && clean.length > 0) {
            clean[clean.length - 1].lapEnd = Math.min(lapEnd, driverMax);
            cursor = lapEnd + 1;
            continue;
        }

        if (lapStart <= lapEnd) {
            clean.push({
                compound: s.compound || "UNKNOWN",
                lapStart,
                lapEnd,
                stintIndex: clean.length,
            });
            cursor = lapEnd + 1;
        }
    }

    // Extend last stint to driver's last lap (not beyond it)
    if (clean.length > 0 && clean[clean.length - 1].lapEnd < driverMax) {
        clean[clean.length - 1].lapEnd = driverMax;
    }

    // ── Merge consecutive same-compound stints (ghost pitstop fix) ────────────
    // If two consecutive stints show the same compound, OpenF1 invented a
    // pitstop that never happened. Merge them into one continuous stint.
    const merged: CleanStint[] = [];
    for (const s of clean) {
        if (
            merged.length > 0 &&
            merged[merged.length - 1].compound === s.compound
        ) {
            merged[merged.length - 1].lapEnd = s.lapEnd;
        } else {
            merged.push({ ...s, stintIndex: merged.length });
        }
    }

    return merged;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function TireStrategy({
    stints,
    drivers,
    laps,
    positions,
    maxLap,
    currentLap,
}: Props) {
    // Compute each driver's race position as of `currentLap`. We find the
    // driver's lap row matching `currentLap` (or the closest earlier lap for
    // DNFs) and pick the most recent Position record at or before that lap's
    // start time. Drivers without data fall back to a large rank so they sort
    // last but remain in stable relative order.
    const positionMap = useMemo(() => {
        const map = new Map<number, number>();

        // Index positions by driver, sorted chronologically
        const positionsByDriver = new Map<number, Position[]>();
        positions.forEach((p) => {
            const list = positionsByDriver.get(p.driver_number) ?? [];
            list.push(p);
            positionsByDriver.set(p.driver_number, list);
        });
        positionsByDriver.forEach((list) =>
            list.sort((a, b) => a.date.localeCompare(b.date)),
        );

        // For each driver, find the lap <= currentLap with the highest lap_number
        const lapByDriver = new Map<number, Lap>();
        laps.forEach((l) => {
            if (l.lap_number > currentLap) return;
            const prev = lapByDriver.get(l.driver_number);
            if (!prev || l.lap_number > prev.lap_number) {
                lapByDriver.set(l.driver_number, l);
            }
        });

        drivers.forEach((d, idx) => {
            const lap = lapByDriver.get(d.driver_number);
            const driverPositions =
                positionsByDriver.get(d.driver_number) ?? [];
            let pos: number | null = null;
            if (lap && driverPositions.length) {
                const cutoff = lap.date_start;
                for (let i = driverPositions.length - 1; i >= 0; i--) {
                    if (driverPositions[i].date <= cutoff) {
                        pos = driverPositions[i].position;
                        break;
                    }
                }
                if (pos == null) pos = driverPositions[0].position;
            }
            map.set(d.driver_number, pos ?? 100 + idx);
        });
        return map;
    }, [drivers, positions, laps, currentLap]);

    // raceTotalLaps = absolute max lap in full dataset
    const raceTotalLaps = useMemo(
        () => Math.max(...laps.map((l) => l.lap_number ?? 0), maxLap, 1),
        [laps, maxLap],
    );

    // Per-driver last completed lap — caps the tire bar for DNF'd drivers
    const driverLastLapMap = useMemo(() => {
        const map = new Map<number, number>();
        laps.forEach((l) => {
            const curr = map.get(l.driver_number) ?? 0;
            if (l.lap_number > curr) map.set(l.driver_number, l.lap_number);
        });
        return map;
    }, [laps]);

    const chartData = useMemo(() => {
        return drivers
            .map((driver) => {
                const driverLastLap =
                    driverLastLapMap.get(driver.driver_number) ?? raceTotalLaps;
                const cleanStints = sanitiseStints(
                    stints,
                    driver.driver_number,
                    raceTotalLaps,
                    driverLastLap,
                );

                // Only show stints that have started by currentLap
                const visible = cleanStints
                    .filter((s) => s.lapStart <= currentLap)
                    .map((s) => ({
                        ...s,
                        lapEnd: Math.min(s.lapEnd, currentLap),
                    }))
                    .filter((s) => s.lapEnd >= s.lapStart);

                return {
                    driver: driver.name_acronym,
                    driverNumber: driver.driver_number,
                    teamColour: driver.team_colour,
                    position: positionMap.get(driver.driver_number) ?? 99,
                    stints: visible,
                };
            })
            .filter((d) => d.stints.length > 0)
            .sort((a, b) => a.position - b.position);
    }, [
        stints,
        drivers,
        currentLap,
        positionMap,
        raceTotalLaps,
        driverLastLapMap,
    ]);

    const lapPct = raceTotalLaps > 0 ? 100 / raceTotalLaps : 0;

    // X-axis tick positions
    const xTicks = useMemo(() => {
        const ticks: number[] = [];
        const step = raceTotalLaps <= 30 ? 5 : raceTotalLaps <= 60 ? 10 : 15;
        for (let l = step; l < raceTotalLaps; l += step) ticks.push(l);
        ticks.push(raceTotalLaps);
        return ticks;
    }, [raceTotalLaps]);

    return (
        <div className="bg-f1-card rounded-xl border border-f1-border p-4">
            <h3 className="text-sm font-semibold mb-3 text-f1-muted uppercase tracking-wide">
                Tire Strategy
            </h3>

            {/* Compound legend */}
            <div className="flex flex-wrap gap-3 mb-4">
                {Object.entries(COMPOUND_COLORS)
                    .filter(([k]) => k !== "UNKNOWN")
                    .map(([compound, color]) => (
                        <div
                            key={compound}
                            className="flex items-center gap-1 text-xs"
                        >
                            <div
                                className="w-3 h-3 rounded-sm border border-black/10"
                                style={{ backgroundColor: color }}
                            />
                            <span className="text-f1-muted">{compound}</span>
                        </div>
                    ))}
            </div>

            {/* Chart: driver rows + x-axis */}
            <div className="flex gap-2">
                {/* Driver name column */}
                <div className="flex flex-col gap-[3px] pt-0 shrink-0">
                    {chartData.map((row) => (
                        <div
                            key={row.driverNumber}
                            className="text-xs font-mono flex items-center"
                            style={{
                                height: 22,
                                color: row.teamColour
                                    ? `#${row.teamColour}`
                                    : "#9ca3af",
                            }}
                        >
                            {row.driver}
                        </div>
                    ))}
                    {/* spacer for x-axis */}
                    <div style={{ height: 18 }} />
                </div>

                {/* Bar area + x-axis */}
                <div className="flex-1 min-w-0">
                    {/* Rows */}
                    <div className="flex flex-col gap-[3px]">
                        {chartData.map((row) => (
                            <div
                                key={row.driverNumber}
                                className="relative rounded overflow-hidden bg-[#1a1f2e]"
                                style={{ height: 22 }}
                            >
                                {/* Vertical grid lines at tick positions — behind bars */}
                                {xTicks.map((lap) => (
                                    <div
                                        key={lap}
                                        className="absolute top-0 h-full pointer-events-none"
                                        style={{
                                            left: `${((lap - 1) / raceTotalLaps) * 100}%`,
                                            width: 1,
                                            backgroundColor:
                                                "rgba(255,255,255,0.10)",
                                            zIndex: 1,
                                        }}
                                    />
                                ))}

                                {row.stints.map((seg, i) => {
                                    const leftPct = (seg.lapStart - 1) * lapPct;
                                    const widthPct =
                                        (seg.lapEnd - seg.lapStart + 1) *
                                        lapPct;
                                    const bg =
                                        COMPOUND_COLORS[seg.compound] ||
                                        COMPOUND_COLORS.UNKNOWN;
                                    const textColor =
                                        COMPOUND_TEXT[seg.compound] || "#fff";
                                    const isPitStop = seg.stintIndex > 0;

                                    return (
                                        <div
                                            key={i}
                                            className="absolute top-0 h-full flex items-center justify-center overflow-hidden"
                                            style={{
                                                left: `${leftPct}%`,
                                                width: `${widthPct}%`,
                                                backgroundColor: bg,
                                                borderLeft: isPitStop
                                                    ? "2px solid #0a0e14"
                                                    : "none",
                                                transition:
                                                    "width 0.3s ease, left 0.3s ease",
                                                zIndex: 2,
                                            }}
                                            title={`${seg.compound}: Laps ${seg.lapStart}–${seg.lapEnd} (${seg.lapEnd - seg.lapStart + 1} laps)`}
                                        >
                                            {seg.lapEnd - seg.lapStart + 1 >
                                                4 && (
                                                <span
                                                    className="text-[9px] font-black leading-none select-none pointer-events-none"
                                                    style={{ color: textColor }}
                                                >
                                                    {seg.compound ===
                                                    "INTERMEDIATE"
                                                        ? "I"
                                                        : seg.compound[0]}
                                                </span>
                                            )}
                                        </div>
                                    );
                                })}

                                {/* Current-lap progress cursor */}
                                {currentLap < raceTotalLaps && (
                                    <div
                                        className="absolute top-0 h-full w-px bg-f1-text/20 pointer-events-none"
                                        style={{
                                            left: `${((currentLap - 1) / raceTotalLaps) * 100}%`,
                                            zIndex: 3,
                                        }}
                                    />
                                )}
                            </div>
                        ))}
                    </div>

                    {/* X-axis lap number ruler */}
                    <div className="relative mt-1" style={{ height: 16 }}>
                        {xTicks.map((lap) => (
                            <span
                                key={lap}
                                className="absolute text-[9px] text-f1-muted leading-none"
                                style={{
                                    left: `${((lap - 1) / raceTotalLaps) * 100}%`,
                                    transform:
                                        lap === raceTotalLaps
                                            ? "translateX(-100%)"
                                            : "translateX(-50%)",
                                }}
                            >
                                {lap}
                            </span>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
}
