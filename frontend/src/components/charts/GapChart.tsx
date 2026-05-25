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
import type { Interval, Lap, Driver } from "../../types";
import { buildDriverColorResolver } from "../../lib/teamColors";
import {
    type ChartTooltipProps,
    type TooltipPayloadItem,
    tooltipDataKeyToString,
    tooltipValueToNumber,
} from "./chartTooltip";

interface Props {
    intervals: Interval[];
    laps: Lap[];
    drivers: Driver[];
    highlightDriver: number | null;
    currentLap: number;
    maxLap: number;
    focusedDrivers?: Set<number>;
    onFocusedDriversChange?: (next: Set<number>) => void;
}

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
                    const isLeader =
                        typeof item.value === "number" && item.value < 0.001;
                    const keyLabel =
                        typeof item.dataKey === "string" ||
                        typeof item.dataKey === "number"
                            ? item.dataKey
                            : "";
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
                                {isLeader
                                    ? "Interval"
                                    : `+${Number(item.value).toFixed(3)}s`}
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
    // Group by team_colour (stable key available on all Driver objects)
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

export default function GapChart({
    intervals,
    laps,
    drivers,
    currentLap,
    maxLap,
    focusedDrivers: controlledFocus,
    onFocusedDriversChange,
}: Props) {
    void maxLap;

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

    const getStyle = (driver: Driver) => {
        const focused = focusedDrivers.has(driver.driver_number);
        if (!hasFocus) return { opacity: 1, strokeWidth: 1.5 };
        return focused
            ? { opacity: 1, strokeWidth: 3 }
            : { opacity: 0.07, strokeWidth: 1 };
    };

    // Pre-index intervals by driver with pre-parsed timestamps (computed once)
    const intervalsByDriver = useMemo(() => {
        const map = new Map<number, { interval: Interval; time: number }[]>();
        intervals.forEach((i) => {
            const list = map.get(i.driver_number) ?? [];
            list.push({ interval: i, time: new Date(i.date).getTime() });
            map.set(i.driver_number, list);
        });
        return map;
    }, [intervals]);

    // Expensive: computed once when race data loads (all deps stable during replay)
    const fullChartData = useMemo(() => {
        if (!intervals.length || !laps.length) return [];

        const lapNumbers = [...new Set(laps.map((l) => l.lap_number))].sort(
            (a, b) => a - b,
        );

        return lapNumbers.map((lapNum) => {
            const row: Record<string, number | string> = { lap: lapNum };
            const lapEntries = laps.filter((l) => l.lap_number === lapNum);

            drivers.forEach((driver) => {
                const lapEntry = lapEntries.find(
                    (l) => l.driver_number === driver.driver_number,
                );
                if (!lapEntry?.date_start) return;

                const driverIntervals =
                    intervalsByDriver.get(driver.driver_number) ?? [];
                const lapTime = new Date(lapEntry.date_start).getTime();
                let closest: Interval | null = null;
                let bestDiff = Infinity;
                for (const entry of driverIntervals) {
                    const diff = Math.abs(entry.time - lapTime);
                    if (diff < bestDiff) {
                        bestDiff = diff;
                        closest = entry.interval;
                    }
                }

                if (
                    closest?.gap_to_leader != null &&
                    typeof closest.gap_to_leader === "number"
                ) {
                    row[driver.name_acronym] =
                        Math.round(closest.gap_to_leader * 1000) / 1000;
                }
            });

            return row;
        });
    }, [intervals, laps, drivers, intervalsByDriver]);

    // Cheap slice per tick
    const chartData = useMemo(
        () => fullChartData.filter((row) => (row.lap as number) <= currentLap),
        [fullChartData, currentLap],
    );

    // Sort legend by current gap (ascending) — this also determines team group order
    const sortedDrivers = useMemo(() => {
        if (!chartData.length) return drivers;
        const last = chartData[chartData.length - 1];
        return [...drivers].sort(
            (a, b) =>
                ((last[a.name_acronym] as number) ?? 999) -
                ((last[b.name_acronym] as number) ?? 999),
        );
    }, [drivers, chartData]);

    const teamGroups = useMemo(
        () => buildTeamGroups(sortedDrivers),
        [sortedDrivers],
    );

    const colorOf = useMemo(
        () => buildDriverColorResolver(drivers, focusedDrivers),
        [drivers, focusedDrivers],
    );

    return (
        <div className="bg-f1-card rounded-xl border border-f1-border p-4">
            <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-f1-muted uppercase tracking-wide">
                    Gap to Leader
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

            <div style={{ position: "relative", zIndex: 1 }}>
                <ResponsiveContainer width="100%" height={300}>
                    <LineChart
                        data={chartData}
                        margin={{ top: 5, right: 20, bottom: 5, left: 0 }}
                    >
                        <CartesianGrid strokeDasharray="3 3" stroke="#2d3748" />
                        <XAxis
                            dataKey="lap"
                            stroke="#6b7280"
                            tick={{ fontSize: 11 }}
                        />
                        <YAxis
                            stroke="#6b7280"
                            tick={{ fontSize: 11 }}
                            tickFormatter={(v) => `${v}s`}
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
                                                          (d) => d.name_acronym,
                                                      ),
                                              )
                                            : null
                                    }
                                    hasFocus={hasFocus}
                                />
                            )}
                            wrapperStyle={{ zIndex: 50, opacity: 1 }}
                            cursor={{
                                stroke: "#6b7280",
                                strokeDasharray: "5 5",
                            }}
                        />
                        {drivers.map((driver) => {
                            const color = colorOf(driver.driver_number);
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
                                        focusedDrivers.has(driver.driver_number)
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
                                const color = colorOf(driver.driver_number);
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
                                    >
                                        <span
                                            className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
                                            style={{
                                                backgroundColor: dimmed
                                                    ? "#374151"
                                                    : color,
                                            }}
                                        />
                                        {driver.full_name
                                            ?.split(" ")
                                            .slice(-1)[0] ??
                                            driver.name_acronym}
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
