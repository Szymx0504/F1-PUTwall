import { useMemo, useState, useCallback, useRef } from "react";
import type { Driver } from "../../types";
import type { QualLap, QualCarData } from "../../lib/api";
import { bestLapsByDriver } from "../../lib/api";

interface Props {
    drivers: Driver[];
    laps: QualLap[];
    carDataMap: Map<number, QualCarData[]>;
    focusedDrivers?: Set<number>;
    onFocusedDriversChange?: (next: Set<number>) => void;
}

/* ── Shared helpers ─────────────────────────────────────────────────── */

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

interface TeamGroup {
    teamName: string;
    teamColour: string;
    items: { num: number; name: string; color: string }[];
}

function buildTeamGroups(
    series: { num: number; name: string; color: string }[],
    allDrivers: Driver[],
): TeamGroup[] {
    const map = new Map<string, TeamGroup>();
    for (const s of series) {
        const driver = allDrivers.find((d) => d.driver_number === s.num);
        const key = driver?.team_colour || "888888";
        if (!map.has(key))
            map.set(key, {
                teamName: driver?.team_name ?? key,
                teamColour: key,
                items: [],
            });
        map.get(key)!.items.push({ num: s.num, name: s.name, color: s.color });
    }
    return Array.from(map.values());
}

function distLabel(m: number): string {
    return m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${Math.round(m)}m`;
}

function findNearestIndex(distances: number[], target: number): number {
    if (!distances.length) return 0;
    let lo = 0,
        hi = distances.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (distances[mid] < target) lo = mid + 1;
        else hi = mid;
    }
    if (
        lo > 0 &&
        Math.abs(distances[lo - 1] - target) < Math.abs(distances[lo] - target)
    ) {
        return lo - 1;
    }
    return lo;
}

/* ── Constants ──────────────────────────────────────────────────────── */

const W = 600,
    H = 210,
    PAD = { t: 12, r: 44, b: 32, l: 46 };

/* ── Component ──────────────────────────────────────────────────────── */

export default function EngineChart({
    drivers,
    laps,
    carDataMap,
    focusedDrivers: controlledFocus,
    onFocusedDriversChange,
}: Props) {
    // Multi-select focus (same pattern as PositionChart)
    const [internalFocus, setInternalFocus] = useState<Set<number>>(new Set());
    const isControlled = controlledFocus !== undefined;
    const focusedDrivers = isControlled ? controlledFocus : internalFocus;
    const hasFocus = focusedDrivers.size > 0;
    const toggleDriver = useCallback(
        (num: number) => {
            const apply = (prev: Set<number>) => {
                const n = new Set(prev);
                if (n.has(num)) n.delete(num);
                else n.add(num);
                return n;
            };
            if (isControlled) onFocusedDriversChange?.(apply(controlledFocus!));
            else setInternalFocus(apply);
        },
        [isControlled, controlledFocus, onFocusedDriversChange],
    );
    const clearFocus = useCallback(() => {
        if (isControlled) onFocusedDriversChange?.(new Set());
        else setInternalFocus(new Set());
    }, [isControlled, onFocusedDriversChange]);

    const svgRef = useRef<SVGSVGElement>(null);
    const [hoverDist, setHoverDist] = useState<number | null>(null);
    const [zoom, setZoom] = useState(1);

    const series = useMemo(() => {
        const best = bestLapsByDriver(laps);
        return [...best.keys()]
            .map((num) => {
                const data = carDataMap.get(num) ?? [];
                const driver = drivers.find((d) => d.driver_number === num);
                return {
                    num,
                    color: `#${driver?.team_colour ?? "888888"}`,
                    name: driver?.name_acronym ?? String(num),
                    data,
                    distances: computeDistances(data),
                };
            })
            .filter((s) => s.data.length > 1);
    }, [laps, carDataMap, drivers]);

    const teamGroups = useMemo(
        () => buildTeamGroups(series, drivers),
        [series, drivers],
    );

    const gearRpmRanges = useMemo(() => {
        const ranges = new Map<number, { min: number; max: number }>();
        for (const s of series) {
            for (const d of s.data) {
                const existing = ranges.get(d.n_gear);
                if (!existing) {
                    ranges.set(d.n_gear, { min: d.rpm, max: d.rpm });
                } else {
                    if (d.rpm < existing.min) existing.min = d.rpm;
                    if (d.rpm > existing.max) existing.max = d.rpm;
                }
            }
        }
        return ranges;
    }, [series]);

    if (!series.length)
        return (
            <p className="text-f1-muted text-sm">
                No engine telemetry available.
            </p>
        );

    const maxDist = Math.max(
        ...series.map((s) => s.distances[s.distances.length - 1] || 0),
        100,
    );
    const maxRpm = Math.max(
        ...series.flatMap((s) => s.data.map((d) => d.rpm)),
        15000,
    );
    const maxGear = 8;

    const effectiveW = W * zoom;
    const scaleX = (d: number) =>
        PAD.l + (d / maxDist) * (effectiveW - PAD.l - PAD.r);
    const scaleRpm = (v: number) =>
        PAD.t + (1 - v / maxRpm) * (H - PAD.t - PAD.b);
    const scaleGear = (v: number) =>
        PAD.t + (1 - v / maxGear) * (H - PAD.t - PAD.b);

    const baseTickInt =
        maxDist > 5000
            ? 1000
            : maxDist > 2000
              ? 500
              : maxDist > 800
                ? 200
                : 100;
    const tickInt = baseTickInt / Math.min(zoom, 4);
    const xTicks: number[] = [];
    for (let d = 0; d <= maxDist; d += tickInt) xTicks.push(d);

    const getStyle = (num: number) => {
        if (!hasFocus) return { opacity: 1, swRpm: 1.4, swGear: 0.8 };
        return focusedDrivers.has(num)
            ? { opacity: 1, swRpm: 2.2, swGear: 1.2 }
            : { opacity: 0.08, swRpm: 0.5, swGear: 0.3 };
    };

    const getGearColor = (rpm: number, gear: number): string => {
        const range = gearRpmRanges.get(gear);
        if (!range || range.max === range.min) return "#ffffff";
        const t = Math.max(
            0,
            Math.min(1, (rpm - range.min) / (range.max - range.min)),
        );
        const lerp = (a: number, b: number, f: number) =>
            Math.round(a + (b - a) * f);
        if (t <= 0.5) {
            const f = t / 0.5;
            return `rgb(${lerp(96, 255, f)},${lerp(165, 255, f)},${lerp(250, 255, f)})`;
        }
        const f = (t - 0.5) / 0.5;
        return `rgb(${lerp(255, 220, f)},${lerp(255, 50, f)},${lerp(255, 120, f)})`;
    };

    const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
        const svg = svgRef.current;
        if (!svg) return;
        const rect = svg.getBoundingClientRect();
        const mouseX = ((e.clientX - rect.left) / rect.width) * effectiveW;
        const dist =
            ((mouseX - PAD.l) / (effectiveW - PAD.l - PAD.r)) * maxDist;
        if (dist >= 0 && dist <= maxDist) setHoverDist(dist);
        else setHoverDist(null);
    };
    const handleMouseLeave = () => setHoverDist(null);

    const hoverX = hoverDist !== null ? scaleX(hoverDist) : null;
    const hoverPoints =
        hoverDist !== null
            ? series
                  .filter((s) => !hasFocus || focusedDrivers.has(s.num))
                  .map((s) => {
                      const idx = findNearestIndex(s.distances, hoverDist);
                      return {
                          name: s.name,
                          color: s.color,
                          rpm: s.data[idx].rpm,
                          gear: s.data[idx].n_gear,
                          gearColor: getGearColor(
                              s.data[idx].rpm,
                              s.data[idx].n_gear,
                          ),
                          x: scaleX(s.distances[idx]),
                          y: scaleRpm(s.data[idx].rpm),
                      };
                  })
                  .sort((a, b) => b.rpm - a.rpm)
            : [];
    const tooltipLeftPct = hoverX !== null ? (hoverX / effectiveW) * 100 : 0;
    const tooltipFlip = tooltipLeftPct > 70;

    return (
        <div>
            <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-1">
                    <span className="text-[10px] text-f1-muted mr-1">Zoom</span>
                    {[1, 2, 4, 8].map((z) => (
                        <button
                            key={z}
                            onClick={() => setZoom(z)}
                            className="text-[10px] px-1.5 py-0.5 rounded border transition-colors"
                            style={{
                                borderColor: zoom === z ? "#6b7280" : "#2d3748",
                                color: zoom === z ? "#fff" : "#6b7280",
                                backgroundColor:
                                    zoom === z ? "#374151" : "transparent",
                            }}
                        >
                            {z}x
                        </button>
                    ))}
                </div>
                {hasFocus && (
                    <button
                        onClick={clearFocus}
                        className="text-[10px] text-f1-muted hover:text-white transition-colors px-2 py-0.5 rounded border border-f1-border hover:border-f1-border/70"
                    >
                        Clear focus
                    </button>
                )}
            </div>

            <div className="overflow-x-auto">
                <div
                    className="relative"
                    style={{
                        display: "inline-flex",
                        width: `${zoom * 100}%`,
                        minWidth: "100%",
                    }}
                >
                    {zoom > 1 && (
                        <div
                            style={{
                                position: "sticky",
                                left: 0,
                                flexShrink: 0,
                                width: `${(PAD.l / effectiveW) * 100}%`,
                                marginRight: `-${(PAD.l / effectiveW) * 100}%`,
                                zIndex: 10,
                                pointerEvents: "none",
                            }}
                        >
                            <svg
                                viewBox={`0 0 ${PAD.l} ${H}`}
                                style={{
                                    width: "100%",
                                    height: "100%",
                                    display: "block",
                                }}
                                preserveAspectRatio="none"
                            >
                                <rect width={PAD.l} height={H} fill="#111214" />
                                {[0, 5000, 10000, 15000]
                                    .filter((v) => v <= maxRpm)
                                    .map((v) => (
                                        <g key={v}>
                                            <line
                                                x1={PAD.l - 1}
                                                x2={PAD.l}
                                                y1={scaleRpm(v)}
                                                y2={scaleRpm(v)}
                                                stroke="#2d3748"
                                                strokeWidth={0.5}
                                            />
                                            <text
                                                x={PAD.l - 4}
                                                y={scaleRpm(v) + 3}
                                                fontSize={8}
                                                fill="#6b7280"
                                                textAnchor="end"
                                            >
                                                {v / 1000}k
                                            </text>
                                        </g>
                                    ))}
                                <text
                                    x={PAD.l - 38}
                                    y={(PAD.t + H - PAD.b) / 2}
                                    fontSize={9}
                                    fill="#6b7280"
                                    textAnchor="middle"
                                    transform={`rotate(-90,${PAD.l - 38},${(PAD.t + H - PAD.b) / 2})`}
                                >
                                    RPM
                                </text>
                            </svg>
                        </div>
                    )}
                    <svg
                        ref={svgRef}
                        viewBox={`0 0 ${effectiveW} ${H}`}
                        style={{ width: "100%" }}
                        preserveAspectRatio="xMidYMid meet"
                        onMouseMove={handleMouseMove}
                        onMouseLeave={handleMouseLeave}
                    >
                        {/* RPM Y grid (left) */}
                        {[0, 5000, 10000, 15000]
                            .filter((v) => v <= maxRpm)
                            .map((v) => (
                                <g key={v}>
                                    <line
                                        x1={PAD.l}
                                        x2={effectiveW - PAD.r}
                                        y1={scaleRpm(v)}
                                        y2={scaleRpm(v)}
                                        stroke="#2d3748"
                                        strokeWidth={0.5}
                                    />
                                    <text
                                        x={PAD.l - 4}
                                        y={scaleRpm(v) + 3}
                                        fontSize={8}
                                        fill="#6b7280"
                                        textAnchor="end"
                                    >
                                        {v / 1000}k
                                    </text>
                                </g>
                            ))}
                        {/* Gear Y labels (right) */}
                        {[1, 2, 3, 4, 5, 6, 7, 8].map((g) => (
                            <text
                                key={g}
                                x={effectiveW - PAD.r + 4}
                                y={scaleGear(g) + 3}
                                fontSize={8}
                                fill="#6b7280"
                                textAnchor="start"
                            >
                                {g}
                            </text>
                        ))}
                        {/* X grid + distance labels */}
                        {xTicks.map((d) => (
                            <g key={d}>
                                <line
                                    x1={scaleX(d)}
                                    x2={scaleX(d)}
                                    y1={PAD.t}
                                    y2={H - PAD.b}
                                    stroke="#2d3748"
                                    strokeWidth={0.5}
                                />
                                <text
                                    x={scaleX(d)}
                                    y={H - PAD.b + 12}
                                    fontSize={8}
                                    fill="#6b7280"
                                    textAnchor="middle"
                                >
                                    {distLabel(d)}
                                </text>
                            </g>
                        ))}
                        {/* Axis labels */}
                        <text
                            x={PAD.l - 38}
                            y={(PAD.t + H - PAD.b) / 2}
                            fontSize={9}
                            fill="#6b7280"
                            textAnchor="middle"
                            transform={`rotate(-90,${PAD.l - 38},${(PAD.t + H - PAD.b) / 2})`}
                        >
                            RPM
                        </text>
                        <text
                            x={effectiveW - PAD.r + 36}
                            y={(PAD.t + H - PAD.b) / 2}
                            fontSize={9}
                            fill="#6b7280"
                            textAnchor="middle"
                            transform={`rotate(90,${effectiveW - PAD.r + 36},${(PAD.t + H - PAD.b) / 2})`}
                        >
                            Gear
                        </text>
                        <text
                            x={(PAD.l + effectiveW - PAD.r) / 2}
                            y={H - 2}
                            fontSize={9}
                            fill="#6b7280"
                            textAnchor="middle"
                        >
                            Lap Distance
                        </text>
                        {/* Data paths */}
                        {series.map((s) => {
                            const st = getStyle(s.num);
                            const rpmPath = s.data
                                .map(
                                    (d, i) =>
                                        `${i === 0 ? "M" : "L"}${scaleX(s.distances[i]).toFixed(1)},${scaleRpm(d.rpm).toFixed(1)}`,
                                )
                                .join(" ");
                            const gearPath = s.data
                                .map((d, i) => {
                                    const x = scaleX(s.distances[i]).toFixed(1);
                                    const y = scaleGear(d.n_gear).toFixed(1);
                                    if (i === 0) return `M${x},${y}`;
                                    const prevY = scaleGear(
                                        s.data[i - 1].n_gear,
                                    ).toFixed(1);
                                    return `L${x},${prevY}L${x},${y}`;
                                })
                                .join(" ");
                            return (
                                <g
                                    key={s.num}
                                    opacity={st.opacity}
                                    style={{
                                        cursor: "pointer",
                                        transition: "opacity 0.15s",
                                    }}
                                    onClick={() => toggleDriver(s.num)}
                                >
                                    <path
                                        d={rpmPath}
                                        fill="none"
                                        stroke={s.color}
                                        strokeWidth={st.swRpm}
                                        strokeLinejoin="round"
                                    />
                                    <path
                                        d={gearPath}
                                        fill="none"
                                        stroke={s.color}
                                        strokeWidth={st.swGear}
                                        strokeDasharray="3,2"
                                        opacity={0.5}
                                    />
                                </g>
                            );
                        })}
                        {/* Hover cursor line */}
                        {hoverX !== null && (
                            <line
                                x1={hoverX}
                                x2={hoverX}
                                y1={PAD.t}
                                y2={H - PAD.b}
                                stroke="#6b7280"
                                strokeWidth={0.5}
                                strokeDasharray="5 5"
                                pointerEvents="none"
                            />
                        )}
                        {hoverPoints.map((pt) => (
                            <circle
                                key={pt.name}
                                cx={pt.x}
                                cy={pt.y}
                                r={3}
                                fill={pt.color}
                                stroke="#fff"
                                strokeWidth={1}
                                pointerEvents="none"
                            />
                        ))}
                    </svg>
                    {hoverDist !== null && hoverPoints.length > 0 && (
                        <div
                            className="absolute top-0 pointer-events-none"
                            style={{
                                left: tooltipFlip
                                    ? undefined
                                    : `${tooltipLeftPct}%`,
                                right: tooltipFlip
                                    ? `${100 - tooltipLeftPct}%`
                                    : undefined,
                                transform: tooltipFlip
                                    ? "translateX(-8px)"
                                    : "translateX(8px)",
                                zIndex: 10,
                            }}
                        >
                            <div
                                className="rounded-lg border border-f1-border p-3 text-white shadow-2xl"
                                style={{
                                    backgroundColor: "#111214",
                                    minWidth: 200,
                                }}
                            >
                                <div className="flex items-center justify-between mb-1">
                                    <span className="text-[11px] font-semibold uppercase tracking-widest text-f1-muted">
                                        {distLabel(hoverDist)}
                                    </span>
                                    <div className="flex gap-3">
                                        <span className="text-[9px] font-semibold uppercase tracking-widest text-f1-muted w-20 text-center">
                                            RPM
                                        </span>
                                        <span className="text-[9px] font-semibold uppercase tracking-widest text-f1-muted w-10 text-center">
                                            Gear
                                        </span>
                                    </div>
                                </div>
                                <div className="space-y-[3px]">
                                    {hoverPoints.map((pt) => (
                                        <div
                                            key={pt.name}
                                            className="flex items-center justify-between gap-4"
                                        >
                                            <div className="flex items-center gap-1.5">
                                                <span
                                                    className="inline-block h-2 w-2 rounded-full flex-shrink-0"
                                                    style={{
                                                        backgroundColor:
                                                            pt.color,
                                                    }}
                                                />
                                                <span className="text-[11px] font-bold tracking-wide">
                                                    {pt.name}
                                                </span>
                                            </div>
                                            <span className="text-[11px] font-mono font-bold flex gap-3">
                                                <span
                                                    className="w-20 text-center"
                                                    style={{ color: pt.color }}
                                                >
                                                    {pt.rpm
                                                        .toLocaleString("de-DE")
                                                        .replace(".", "\u202f")}
                                                </span>
                                                <span
                                                    className="w-10 text-center"
                                                    style={{
                                                        color: pt.gearColor,
                                                    }}
                                                >
                                                    G{pt.gear}
                                                </span>
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>
                    )}
                    {zoom > 1 && (
                        <div
                            style={{
                                position: "sticky",
                                right: 0,
                                flexShrink: 0,
                                width: `${(PAD.r / effectiveW) * 100}%`,
                                marginLeft: `-${(PAD.r / effectiveW) * 100}%`,
                                zIndex: 10,
                                pointerEvents: "none",
                            }}
                        >
                            <svg
                                viewBox={`0 0 ${PAD.r} ${H}`}
                                style={{
                                    width: "100%",
                                    height: "100%",
                                    display: "block",
                                }}
                                preserveAspectRatio="none"
                            >
                                <rect width={PAD.r} height={H} fill="#111214" />
                                {[1, 2, 3, 4, 5, 6, 7, 8].map((g) => (
                                    <g key={g}>
                                        <line
                                            x1={0}
                                            x2={1}
                                            y1={scaleGear(g)}
                                            y2={scaleGear(g)}
                                            stroke="#2d3748"
                                            strokeWidth={0.5}
                                        />
                                        <text
                                            x={4}
                                            y={scaleGear(g) + 3}
                                            fontSize={8}
                                            fill="#6b7280"
                                            textAnchor="start"
                                        >
                                            {g}
                                        </text>
                                    </g>
                                ))}
                                <text
                                    x={36}
                                    y={(PAD.t + H - PAD.b) / 2}
                                    fontSize={9}
                                    fill="#6b7280"
                                    textAnchor="middle"
                                    transform={`rotate(90,36,${(PAD.t + H - PAD.b) / 2})`}
                                >
                                    Gear
                                </text>
                            </svg>
                        </div>
                    )}
                </div>
            </div>

            {/* Team-grouped legend (matches PositionChart) */}
            <div
                className="mt-3 grid gap-x-4 gap-y-3"
                style={{
                    gridTemplateColumns: `repeat(${Math.ceil(teamGroups.length / 2)}, minmax(0, 1fr))`,
                }}
            >
                {teamGroups.map((group) => {
                    const tc = `#${group.teamColour}`;
                    return (
                        <div
                            key={group.teamColour}
                            className="flex flex-col gap-1"
                        >
                            <span
                                className="text-[10px] font-semibold uppercase tracking-wide"
                                style={{ color: tc, opacity: 0.85 }}
                            >
                                {group.teamName}
                            </span>
                            {group.items.map((item) => {
                                const focused = focusedDrivers.has(item.num);
                                const dimmed = hasFocus && !focused;
                                return (
                                    <button
                                        key={item.num}
                                        onClick={() => toggleDriver(item.num)}
                                        className="flex items-center gap-1 px-2 py-0.5 rounded font-mono font-bold transition-all"
                                        style={{
                                            fontSize: 11,
                                            border: `1.5px solid ${focused ? item.color : "#2d3748"}`,
                                            backgroundColor: focused
                                                ? `${item.color}20`
                                                : "transparent",
                                            color: dimmed
                                                ? "#374151"
                                                : item.color,
                                            opacity: dimmed ? 0.5 : 1,
                                            cursor: "pointer",
                                        }}
                                        title={`${focused ? "Unfocus" : "Focus"} ${item.name}`}
                                    >
                                        <span
                                            className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
                                            style={{
                                                backgroundColor: dimmed
                                                    ? "#374151"
                                                    : item.color,
                                            }}
                                        />
                                        {item.name}
                                    </button>
                                );
                            })}
                        </div>
                    );
                })}
                {/* Gear legend entry */}
                <div className="flex flex-col gap-1">
                    <span
                        className="text-[10px] font-semibold uppercase tracking-wide"
                        style={{ color: "#6b7280", opacity: 0.85 }}
                    >
                        Legend
                    </span>
                    <span className="flex items-center gap-1.5 text-[10px] text-f1-muted px-2 py-0.5">
                        <span
                            className="w-3 h-0 inline-block border-t border-dashed"
                            style={{ borderColor: "#6b7280" }}
                        />
                        Gear (dashed, team color)
                    </span>
                </div>
            </div>
        </div>
    );
}
