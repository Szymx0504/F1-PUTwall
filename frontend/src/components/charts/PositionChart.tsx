import { useMemo, useState, useCallback } from "react";
import {
    LineChart,
    Line,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
} from "recharts";
import type { Lap, Driver, Position } from "../../types";
import {
    type ChartTooltipProps,
    type TooltipPayloadItem,
    tooltipDataKeyToString,
    tooltipValueToNumber,
} from "./chartTooltip";

interface Props {
    laps: Lap[];
    positions: Position[];
    drivers: Driver[];
    highlightDriver: number | null; // kept for API compat, unused internally
    currentLap: number;
    maxLap: number;
    focusedDrivers?: Set<number>;
    onFocusedDriversChange?: (next: Set<number>) => void;
}

// ── Tooltip ───────────────────────────────────────────────────────────────────

const TooltipContent = ({
    active,
    payload,
    label,
    focusedAcronyms,
    hasFocus,
}: ChartTooltipProps) => {
    if (!active || !payload || !payload.length) return null;
    const items: TooltipPayloadItem[] = payload
        .filter((p) => p.value != null)
        .filter((p) => {
            if (!hasFocus) return true;
            const key = tooltipDataKeyToString(p.dataKey);
            return key ? !!focusedAcronyms?.has(key) : false;
        })
        .slice()
        .sort(
            (a, b) =>
                tooltipValueToNumber(a.value) - tooltipValueToNumber(b.value),
        )
        .slice(0, 20);
    if (!items.length) return null;
    return (
        <div
            className="rounded-lg border border-f1-border p-3 text-white shadow-2xl"
            style={{ backgroundColor: "#111214", minWidth: 160 }}
        >
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-f1-muted">
                Lap {label}
            </div>
            <div className="space-y-[3px]">
                {items.map((item) => {
                    const keyLabel = tooltipDataKeyToString(item.dataKey);
                    return (
                        <div
                            key={keyLabel}
                            className="flex items-center justify-between gap-4"
                        >
                            <div className="flex items-center gap-1.5">
                                <span
                                    className="inline-block h-2 w-2 rounded-full flex-shrink-0"
                                    style={{ backgroundColor: item.stroke }}
                                />
                                <span className="text-[11px] font-bold tracking-wide">
                                    {keyLabel}
                                </span>
                            </div>
                            <span
                                className="text-[11px] font-mono font-bold"
                                style={{ color: item.stroke }}
                            >
                                P{String(item.value ?? "")}
                            </span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

// ── Team-grouped legend ───────────────────────────────────────────────────────

interface TeamGroup {
    teamName: string;
    teamColour: string;
    drivers: Driver[];
}

function buildTeamGroups(sortedDrivers: Driver[]): TeamGroup[] {
    const map = new Map<string, TeamGroup>();
    for (const driver of sortedDrivers) {
        const key = driver.team_colour || "ffffff";
        if (!map.has(key)) {
            map.set(key, {
                teamName: driver.team_name ?? key,
                teamColour: key,
                drivers: [],
            });
        }
        map.get(key)!.drivers.push(driver);
    }
    return Array.from(map.values());
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CHART_HEIGHT = 320;
const MARGIN = { top: 8, right: 0, bottom: 5, left: 0 };
const DOMAIN_MIN = 1;
const DOMAIN_MAX = 20;
const LEFT_LABEL_W = 38; // px reserved for left acronym labels
const RIGHT_LABEL_W = 38; // px reserved for right acronym labels

// ── Utility: compute Y-pixel for a position value ─────────────────────────────

function posToY(
    pos: number,
    chartH: number,
    marginTop: number,
    marginBottom: number,
): number {
    const plotH = chartH - marginTop - marginBottom;
    // Y axis is reversed: pos=1 → top, pos=20 → bottom
    return marginTop + ((pos - DOMAIN_MIN) / (DOMAIN_MAX - DOMAIN_MIN)) * plotH;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function PositionChart({
    laps,
    positions,
    drivers,
    currentLap,
    maxLap,
    focusedDrivers: controlledFocus,
    onFocusedDriversChange,
}: Props) {
    void maxLap;

    // Multi-select focus state (controlled when prop provided)
    const [internalFocus, setInternalFocus] = useState<Set<number>>(new Set());
    const isControlled = controlledFocus !== undefined;
    const focusedDrivers = isControlled ? controlledFocus : internalFocus;
    const hasFocus = focusedDrivers.size > 0;

    const toggleDriver = useCallback(
        (driverNumber: number) => {
            const apply = (prev: Set<number>) => {
                const next = new Set(prev);
                if (next.has(driverNumber)) next.delete(driverNumber);
                else next.add(driverNumber);
                return next;
            };
            if (isControlled) {
                onFocusedDriversChange?.(apply(controlledFocus!));
            } else {
                setInternalFocus(apply);
            }
        },
        [isControlled, controlledFocus, onFocusedDriversChange],
    );

    const clearFocus = useCallback(() => {
        if (isControlled) onFocusedDriversChange?.(new Set());
        else setInternalFocus(new Set());
    }, [isControlled, onFocusedDriversChange]);

    // ── Build chart data ──────────────────────────────────────────────────────

    // Expensive: computed once when race data loads (all deps stable during replay)
    const fullChartData = useMemo(() => {
        const positionsByDriver = new Map<number, Position[]>();
        positions.forEach((pos) => {
            const list = positionsByDriver.get(pos.driver_number) ?? [];
            list.push(pos);
            positionsByDriver.set(pos.driver_number, list);
        });
        positionsByDriver.forEach((list) =>
            list.sort((a, b) => a.date.localeCompare(b.date)),
        );

        const lapNumbers = [...new Set(laps.map((l) => l.lap_number))].sort(
            (a, b) => a - b,
        );
        return lapNumbers.map((lapNum) => {
            const row: Record<string, number | null> = { lap: lapNum };
            laps.filter((l) => l.lap_number === lapNum).forEach((lap) => {
                const driver = drivers.find(
                    (d) => d.driver_number === lap.driver_number,
                );
                if (!driver) return;
                const driverPositions =
                    positionsByDriver.get(lap.driver_number) ?? [];
                const beforeList = driverPositions.filter(
                    (p) => p.date <= lap.date_start,
                );
                const before = beforeList.length
                    ? beforeList[beforeList.length - 1]
                    : null;
                const sample = before ?? driverPositions[0] ?? null;
                row[driver.name_acronym] = sample?.position ?? null;
            });
            return row;
        });
    }, [laps, positions, drivers]);

    // Cheap: only a filter per lap tick
    const chartData = useMemo(
        () => fullChartData.filter((row) => (row.lap as number) <= currentLap),
        [fullChartData, currentLap],
    );

    // ── Edge positions for side labels ────────────────────────────────────────

    const edgePositions = useMemo(() => {
        if (!chartData.length)
            return new Map<
                string,
                { leftPos: number | null; rightPos: number | null }
            >();
        const first = chartData[0];
        const lastLap = chartData[chartData.length - 1].lap as number;
        // A driver is considered a finisher if their last recorded lap is within
        // 3 laps of the final lap in the dataset (handles sparse data at race end).
        const DNF_THRESHOLD = 3;
        const map = new Map<
            string,
            { leftPos: number | null; rightPos: number | null }
        >();
        drivers.forEach((d) => {
            let rightPos: number | null = null;
            let rightLap: number | null = null;
            for (let i = chartData.length - 1; i >= 0; i--) {
                const val = chartData[i][d.name_acronym];
                if (val != null) {
                    rightPos = val as number;
                    rightLap = chartData[i].lap as number;
                    break;
                }
            }
            // Only show right label for drivers who finished (last lap close to race end)
            const finished =
                rightLap != null && lastLap - rightLap <= DNF_THRESHOLD;
            map.set(d.name_acronym, {
                leftPos: (first[d.name_acronym] as number) ?? null,
                rightPos: finished ? rightPos : null,
            });
        });
        return map;
    }, [chartData, drivers]);

    // ── Driver style helpers ──────────────────────────────────────────────────

    const getStyle = (driver: Driver) => {
        const focused = focusedDrivers.has(driver.driver_number);
        if (!hasFocus) return { opacity: 1, strokeWidth: 1.5 };
        return focused
            ? { opacity: 1, strokeWidth: 3 }
            : { opacity: 0.07, strokeWidth: 1 };
    };

    // Sort for legend: by starting position — determines team group order too
    const sortedDrivers = useMemo(() => {
        if (!chartData.length) return drivers;
        const first = chartData[0];
        return [...drivers].sort(
            (a, b) =>
                ((first[a.name_acronym] as number) ?? 99) -
                ((first[b.name_acronym] as number) ?? 99),
        );
    }, [drivers, chartData]);

    const teamGroups = useMemo(
        () => buildTeamGroups(sortedDrivers),
        [sortedDrivers],
    );

    return (
        <div className="bg-f1-card rounded-xl border border-f1-border p-4">
            {/* Header */}
            <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-f1-muted uppercase tracking-wide">
                    Position Changes
                </h3>
                {hasFocus && (
                    <button
                        onClick={clearFocus}
                        className="text-[10px] text-f1-muted hover:text-white transition-colors px-2 py-0.5 rounded border border-f1-border hover:border-f1-border/70"
                    >
                        Clear focus
                    </button>
                )}
            </div>

            {/* Chart area with absolute-positioned side labels */}
            <div
                className="relative"
                style={{ height: CHART_HEIGHT, zIndex: 1 }}
            >
                {/* LEFT labels */}
                <div
                    className="absolute top-0 left-0 bottom-[20px] pointer-events-none"
                    style={{ width: LEFT_LABEL_W }}
                >
                    {drivers.map((driver) => {
                        const edge = edgePositions.get(driver.name_acronym);
                        if (!edge?.leftPos) return null;
                        const y = posToY(
                            edge.leftPos,
                            CHART_HEIGHT - 20,
                            MARGIN.top,
                            MARGIN.bottom,
                        );
                        const style = getStyle(driver);
                        return (
                            <span
                                key={driver.driver_number}
                                className="absolute right-[2px] font-mono font-bold leading-none select-none"
                                style={{
                                    top: y,
                                    transform: "translateY(-50%)",
                                    fontSize: 11,
                                    color: `#${driver.team_colour || "ffffff"}`,
                                    opacity: style.opacity,
                                    transition: "opacity 0.2s",
                                    whiteSpace: "nowrap",
                                }}
                            >
                                {driver.name_acronym}
                            </span>
                        );
                    })}
                </div>

                {/* RIGHT labels */}
                <div
                    className="absolute top-0 right-0 bottom-[20px] pointer-events-none"
                    style={{ width: RIGHT_LABEL_W }}
                >
                    {drivers.map((driver) => {
                        const edge = edgePositions.get(driver.name_acronym);
                        if (!edge?.rightPos) return null;
                        const y = posToY(
                            edge.rightPos,
                            CHART_HEIGHT - 20,
                            MARGIN.top,
                            MARGIN.bottom,
                        );
                        const style = getStyle(driver);
                        return (
                            <span
                                key={driver.driver_number}
                                className="absolute left-[2px] font-mono font-bold leading-none select-none"
                                style={{
                                    top: y,
                                    transform: "translateY(-50%)",
                                    fontSize: 11,
                                    color: `#${driver.team_colour || "ffffff"}`,
                                    opacity: style.opacity,
                                    transition: "opacity 0.2s",
                                    whiteSpace: "nowrap",
                                }}
                            >
                                {driver.name_acronym}
                            </span>
                        );
                    })}
                </div>

                {/* Recharts — inset by label widths */}
                <div
                    className="absolute top-0 bottom-0"
                    style={{ left: LEFT_LABEL_W, right: RIGHT_LABEL_W }}
                >
                    <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={chartData} margin={MARGIN}>
                            <CartesianGrid
                                strokeDasharray="3 3"
                                stroke="#2d3748"
                            />
                            <XAxis
                                dataKey="lap"
                                stroke="#6b7280"
                                tick={{ fontSize: 11 }}
                            />
                            <YAxis
                                reversed
                                domain={[DOMAIN_MIN, DOMAIN_MAX]}
                                stroke="#6b7280"
                                tick={{ fontSize: 11 }}
                                width={22}
                            />
                            <Tooltip
                                content={(props) => (
                                    <TooltipContent
                                        {...props}
                                        focusedAcronyms={
                                            hasFocus
                                                ? new Set(
                                                      drivers
                                                          .filter((d) =>
                                                              focusedDrivers.has(
                                                                  d.driver_number,
                                                              ),
                                                          )
                                                          .map(
                                                              (d) =>
                                                                  d.name_acronym,
                                                          ),
                                                  )
                                                : null
                                        }
                                        hasFocus={hasFocus}
                                    />
                                )}
                                cursor={{
                                    stroke: "#6b7280",
                                    strokeDasharray: "5 5",
                                }}
                            />
                            {drivers.map((driver) => {
                                const color = `#${driver.team_colour || "ffffff"}`;
                                const style = getStyle(driver);
                                return (
                                    <Line
                                        key={driver.driver_number}
                                        type="monotone"
                                        dataKey={driver.name_acronym}
                                        stroke={color}
                                        strokeWidth={style.strokeWidth}
                                        strokeOpacity={style.opacity}
                                        dot={false}
                                        activeDot={
                                            !hasFocus ||
                                            focusedDrivers.has(
                                                driver.driver_number,
                                            )
                                                ? {
                                                      r: 4,
                                                      fill: color,
                                                      stroke: "#fff",
                                                      strokeWidth: 1.5,
                                                  }
                                                : false
                                        }
                                        connectNulls
                                        isAnimationActive={false}
                                    />
                                );
                            })}
                        </LineChart>
                    </ResponsiveContainer>
                </div>
            </div>

            {/* Team-grouped driver legend — one column per team */}
            <div
                className="mt-3 grid gap-x-4 gap-y-3"
                style={{
                    gridTemplateColumns: `repeat(${Math.ceil(teamGroups.length / 2)}, minmax(0, 1fr))`,
                }}
            >
                {teamGroups.map((group) => {
                    const teamColor = `#${group.teamColour}`;
                    return (
                        <div
                            key={group.teamColour}
                            className="flex flex-col gap-1"
                        >
                            {/* Team name */}
                            <span
                                className="text-[10px] font-semibold uppercase tracking-wide"
                                style={{ color: teamColor, opacity: 0.85 }}
                            >
                                {group.teamName}
                            </span>
                            {/* Driver buttons stacked vertically */}
                            {group.drivers.map((driver) => {
                                const color = `#${driver.team_colour || "ffffff"}`;
                                const focused = focusedDrivers.has(
                                    driver.driver_number,
                                );
                                const dimmed = hasFocus && !focused;
                                return (
                                    <button
                                        key={driver.driver_number}
                                        onClick={() =>
                                            toggleDriver(driver.driver_number)
                                        }
                                        className="flex items-center gap-1 px-2 py-0.5 rounded font-mono font-bold transition-all"
                                        style={{
                                            fontSize: 11,
                                            border: `1.5px solid ${focused ? color : "#2d3748"}`,
                                            backgroundColor: focused
                                                ? `${color}20`
                                                : "transparent",
                                            color: dimmed ? "#374151" : color,
                                            opacity: dimmed ? 0.5 : 1,
                                            transition: "all 0.15s ease",
                                            cursor: "pointer",
                                        }}
                                        title={`${focused ? "Unfocus" : "Focus"} ${(driver.full_name?.split(" ").slice(-1)[0] ?? driver.name_acronym).toUpperCase()}`}
                                    >
                                        <span
                                            className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
                                            style={{
                                                backgroundColor: dimmed
                                                    ? "#374151"
                                                    : color,
                                            }}
                                        />
                                        {(
                                            driver.full_name
                                                ?.split(" ")
                                                .slice(-1)[0] ??
                                            driver.name_acronym
                                        ).toUpperCase()}
                                    </button>
                                );
                            })}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
