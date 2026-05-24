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
import { useSeasonResultsStream } from "../../hooks/useSeasonResultsStream";
import LoadingProgressBar from "../shared/LoadingProgressBar";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Session {
    session_key: number;
    session_type: string; // "Race" | "Sprint"
    country_name: string;
    circuit_short_name: string;
    date_start: string;
    year: number;
}

interface RaceResult {
    driver_number: number;
    position: number;
    classified_position?: string | number;
    full_name?: string;
    name_acronym?: string;
    team_name?: string;
    team_colour?: string;
}

interface DriverMeta {
    driverNumber: number;
    acronym: string;
    surname: string;
    teamName: string;
    colour: string;
    /** true = lower driver number within team → solid line */
    isPrimary: boolean;
}

interface TeamGroup {
    teamName: string;
    teamColour: string;
    drivers: DriverMeta[];
}

interface PointsProgressionChartProps {
    year: number;
    selectedSessionKey: number;
    selectedSession?: { circuit_short_name?: string } | null;
    apiBase?: string;
}

// ── Points helpers ────────────────────────────────────────────────────────────

const POINTS_MAP: Record<number, number> = {
    1: 25,
    2: 18,
    3: 15,
    4: 12,
    5: 10,
    6: 8,
    7: 6,
    8: 4,
    9: 2,
    10: 1,
};

const SPRINT_POINTS_MAP: Record<number, number> = {
    1: 8,
    2: 7,
    3: 6,
    4: 5,
    5: 4,
    6: 3,
    7: 2,
    8: 1,
};

function sessionPoints(r: RaceResult, sessionType: string): number {
    const map = sessionType === "Sprint" ? SPRINT_POINTS_MAP : POINTS_MAP;
    if (r.classified_position !== undefined && r.classified_position !== null) {
        const n = Number(String(r.classified_position).trim());
        if (!isNaN(n) && n >= 1) return map[n] ?? 0;
        return 0; // DNF / DNS / DSQ
    }
    return map[r.position] ?? 0;
}

function getSurname(fullName?: string): string {
    if (!fullName) return "";
    const parts = fullName.trim().split(" ");
    return (parts[parts.length - 1] || fullName).toUpperCase();
}

// ── Tooltip ───────────────────────────────────────────────────────────────────

interface TooltipPayloadItem {
    value: number | null;
    dataKey: string;
    stroke: string;
}

interface TooltipContentProps {
    active?: boolean;
    payload?: TooltipPayloadItem[];
    label?: string;
    focusedAcronyms?: Set<string>;
    hasFocus?: boolean;
    driverMeta?: Map<string, DriverMeta>;
}

const TooltipContent = ({
    active,
    payload,
    label,
    focusedAcronyms,
    hasFocus,
    driverMeta,
}: TooltipContentProps) => {
    if (!active || !payload?.length) return null;
    const items = payload
        .filter((p) => p.value != null)
        .filter((p) => !hasFocus || focusedAcronyms?.has(p.dataKey))
        .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
        .slice(0, 20);
    if (!items.length) return null;

    return (
        <div
            className="rounded-lg border border-f1-border p-3 text-white shadow-2xl"
            style={{ backgroundColor: "#111214", minWidth: 170 }}
        >
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-f1-muted">
                {label}
            </div>
            <div className="space-y-[3px]">
                {items.map((item) => {
                    const meta: DriverMeta | undefined = driverMeta?.get(
                        item.dataKey,
                    );
                    return (
                        <div
                            key={item.dataKey}
                            className="flex items-center justify-between gap-4"
                        >
                            <div className="flex items-center gap-1.5">
                                {/* Solid/dashed indicator */}
                                <svg
                                    width="16"
                                    height="8"
                                    className="flex-shrink-0"
                                >
                                    <line
                                        x1="0"
                                        y1="4"
                                        x2="16"
                                        y2="4"
                                        stroke={item.stroke}
                                        strokeWidth="2"
                                        strokeDasharray={
                                            meta?.isPrimary ? "none" : "3 2"
                                        }
                                    />
                                </svg>
                                <span className="text-[11px] font-bold tracking-wide">
                                    {item.dataKey}
                                </span>
                            </div>
                            <span
                                className="text-[11px] font-mono font-bold"
                                style={{ color: item.stroke }}
                            >
                                {item.value} pts
                            </span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

// ── Team group builder ────────────────────────────────────────────────────────

function buildTeamGroups(drivers: DriverMeta[]): TeamGroup[] {
    const map = new Map<string, TeamGroup>();
    for (const d of drivers) {
        const key = d.colour;
        if (!map.has(key)) {
            map.set(key, {
                teamName: d.teamName,
                teamColour: d.colour,
                drivers: [],
            });
        }
        map.get(key)!.drivers.push(d);
    }
    // Sort each team: primary (lower number) first
    map.forEach((g) => g.drivers.sort((a, _b) => (a.isPrimary ? -1 : 1)));
    return Array.from(map.values());
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MARGIN = { top: 8, right: 24, bottom: 20, left: 12 };

// ── Main component ────────────────────────────────────────────────────────────

export default function PointsProgressionChart({
    year,
    selectedSessionKey,
    selectedSession,
    apiBase = "/api",
}: PointsProgressionChartProps) {
    const fetchState = useSeasonResultsStream(year, apiBase);

    // Multi-select focus (same pattern as PositionChart)
    const [focusedDrivers, setFocusedDrivers] = useState<Set<number>>(
        new Set(),
    );
    const hasFocus = focusedDrivers.size > 0;

    const toggleDriver = useCallback((num: number) => {
        setFocusedDrivers((prev) => {
            const next = new Set(prev);
            if (next.has(num)) next.delete(num);
            else next.add(num);
            return next;
        });
    }, []);
    const clearFocus = useCallback(() => setFocusedDrivers(new Set()), []);

    // ── Visible sessions (up to selected) ─────────────────────────────────────

    const visibleSessions = useMemo<Session[]>(() => {
        if (!fetchState.sessions.length) return [];
        const idx = fetchState.sessions.findIndex(
            (s) => s.session_key === selectedSessionKey,
        );
        return idx >= 0
            ? fetchState.sessions.slice(0, idx + 1)
            : fetchState.sessions;
    }, [fetchState.sessions, selectedSessionKey]);

    // ── Driver metadata (determine primary/secondary per team) ────────────────

    const driverMetaMap = useMemo((): Map<string, DriverMeta> => {
        if (!visibleSessions.length) return new Map();

        // Collect all unique drivers from all visible races
        const byNumber = new Map<number, RaceResult & { _latest: boolean }>();
        visibleSessions.forEach((session) => {
            const results: RaceResult[] =
                fetchState.results[String(session.session_key)] ?? [];
            results.forEach((r) => {
                byNumber.set(r.driver_number, { ...r, _latest: true });
            });
        });

        // Group by team colour to determine primary/secondary
        const byTeam = new Map<string, number[]>(); // colour → [driverNumbers]
        byNumber.forEach((r, num) => {
            const key = r.team_colour || "ffffff";
            const list = byTeam.get(key) ?? [];
            list.push(num);
            byTeam.set(key, list);
        });

        const metaMap = new Map<string, DriverMeta>();
        byNumber.forEach((r, num) => {
            const teamKey = r.team_colour || "ffffff";
            const teammates = (byTeam.get(teamKey) ?? []).sort((a, b) => a - b);
            const isPrimary = teammates[0] === num; // lower driver number = primary = solid
            const acronym = r.name_acronym ?? String(num);
            metaMap.set(acronym, {
                driverNumber: num,
                acronym,
                surname: getSurname(r.full_name) || acronym,
                teamName: r.team_name ?? "",
                colour: `#${r.team_colour || "ffffff"}`,
                isPrimary,
            });
        });
        return metaMap;
    }, [fetchState.results, visibleSessions]);

    // ── Build cumulative points chart data ────────────────────────────────────

    const chartData = useMemo(() => {
        if (!visibleSessions.length) return [];

        // running totals per driver number
        const running = new Map<number, number>();

        return visibleSessions.map((session) => {
            const results: RaceResult[] =
                fetchState.results[String(session.session_key)] ?? [];
            const isSprint = session.session_type === "Sprint";
            // Unique label: append " SPR" for sprints so hover doesn't collide
            const label = isSprint
                ? `${session.circuit_short_name} Sprint`
                : session.circuit_short_name;
            const row: Record<string, number | string> = { race: label };

            results.forEach((r) => {
                const prev = running.get(r.driver_number) ?? 0;
                const earned = sessionPoints(r, session.session_type);
                running.set(r.driver_number, prev + earned);
            });

            // Emit current cumulative total for every known driver
            driverMetaMap.forEach((meta, acronym) => {
                const total = running.get(meta.driverNumber);
                if (total !== undefined) row[acronym] = total;
            });

            return row;
        });
    }, [fetchState.results, visibleSessions, driverMetaMap]);

    // ── Max points (Y domain) ─────────────────────────────────────────────────

    const maxPoints = useMemo(() => {
        let max = 0;
        chartData.forEach((row) => {
            Object.entries(row).forEach(([k, v]) => {
                if (k !== "race" && typeof v === "number" && v > max) max = v;
            });
        });
        return Math.ceil((max * 1.05) / 25) * 25 || 25; // round up to nearest 25
    }, [chartData]);

    // ── Driver style helper ───────────────────────────────────────────────────

    const getStyle = useCallback(
        (meta: DriverMeta) => {
            const focused = focusedDrivers.has(meta.driverNumber);
            if (!hasFocus) return { opacity: 1, strokeWidth: 1.5 };
            return focused
                ? { opacity: 1, strokeWidth: 3 }
                : { opacity: 0.07, strokeWidth: 1 };
        },
        [focusedDrivers, hasFocus],
    );

    // ── Team groups for legend ────────────────────────────────────────────────

    const teamGroups = useMemo(() => {
        const drivers = Array.from(driverMetaMap.values());
        // Sort groups by total points descending for legend ordering
        const lastRow = chartData[chartData.length - 1];
        drivers.sort((a, b) => {
            const pa = lastRow ? ((lastRow[a.acronym] as number) ?? 0) : 0;
            const pb = lastRow ? ((lastRow[b.acronym] as number) ?? 0) : 0;
            return pb - pa;
        });
        return buildTeamGroups(drivers);
    }, [driverMetaMap, chartData]);

    // ── Shared card shell ─────────────────────────────────────────────────────

    const title = `Points Progression — ${year}${selectedSession?.circuit_short_name ? ` (after ${selectedSession.circuit_short_name})` : ""}`;

    const cardShell = (content: React.ReactNode) => (
        <div className="bg-f1-card rounded-xl border border-f1-border p-4 flex flex-col">
            <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-f1-muted uppercase tracking-wide">
                    {title}
                </h3>
            </div>
            {content}
        </div>
    );

    if (fetchState.status === "error") {
        return cardShell(
            <p className="text-red-400 text-sm py-4">
                Failed to load data: {fetchState.error}
            </p>,
        );
    }

    if (
        fetchState.status === "idle" ||
        fetchState.status === "loading" ||
        !chartData.length ||
        !driverMetaMap.size
    ) {
        return cardShell(
            <LoadingProgressBar
                label="Loading points progression"
                loaded={fetchState.loaded}
                total={fetchState.total}
            />,
        );
    }

    const allDrivers = Array.from(driverMetaMap.values());

    return (
        <div className="bg-f1-card rounded-xl border border-f1-border p-4 flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-f1-muted uppercase tracking-wide">
                    {title}
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

            {/* Chart — grows to fill remaining card space */}
            <div
                className="relative flex-1 min-h-[320px]"
                style={{ zIndex: 1 }}
            >
                <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData} margin={MARGIN}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#2d3748" />
                        <XAxis
                            dataKey="race"
                            stroke="#6b7280"
                            tick={{ fontSize: 10, fontFamily: "monospace" }}
                            interval={0}
                            angle={-35}
                            textAnchor="end"
                            height={70}
                        />
                        <YAxis
                            domain={[0, maxPoints]}
                            stroke="#6b7280"
                            tick={{ fontSize: 11 }}
                            width={38}
                            tickFormatter={(v) => String(v)}
                        />
                        <Tooltip
                            content={(props) => (
                                <TooltipContent
                                    active={props.active}
                                    label={props.label as string | undefined}
                                    payload={
                                        props.payload as unknown as
                                            | TooltipPayloadItem[]
                                            | undefined
                                    }
                                    focusedAcronyms={
                                        hasFocus
                                            ? new Set(
                                                  allDrivers
                                                      .filter((d) =>
                                                          focusedDrivers.has(
                                                              d.driverNumber,
                                                          ),
                                                      )
                                                      .map((d) => d.acronym),
                                              )
                                            : undefined
                                    }
                                    hasFocus={hasFocus}
                                    driverMeta={driverMetaMap}
                                />
                            )}
                            cursor={{
                                stroke: "#6b7280",
                                strokeDasharray: "5 5",
                            }}
                        />
                        {allDrivers.map((meta) => {
                            const style = getStyle(meta);
                            return (
                                <Line
                                    key={meta.driverNumber}
                                    type="monotone"
                                    dataKey={meta.acronym}
                                    stroke={meta.colour}
                                    strokeWidth={style.strokeWidth}
                                    strokeOpacity={style.opacity}
                                    strokeDasharray={
                                        meta.isPrimary ? undefined : "5 3"
                                    }
                                    dot={false}
                                    activeDot={
                                        !hasFocus ||
                                        focusedDrivers.has(meta.driverNumber)
                                            ? {
                                                  r: 4,
                                                  fill: meta.colour,
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

            {/* Team-grouped legend — mirrors PositionChart exactly */}
            <div
                className="mt-3 grid gap-x-4 gap-y-3"
                style={{
                    gridTemplateColumns: `repeat(${Math.ceil(teamGroups.length / 2)}, minmax(0, 1fr))`,
                }}
            >
                {teamGroups.map((group) => {
                    const teamColor = group.teamColour;
                    return (
                        <div
                            key={group.teamColour}
                            className="flex flex-col gap-1"
                        >
                            {/* Team label */}
                            <span
                                className="text-[10px] font-semibold uppercase tracking-wide"
                                style={{ color: teamColor, opacity: 0.85 }}
                            >
                                {group.teamName}
                            </span>
                            {/* Driver buttons */}
                            {group.drivers.map((meta) => {
                                const focused = focusedDrivers.has(
                                    meta.driverNumber,
                                );
                                const dimmed = hasFocus && !focused;
                                return (
                                    <button
                                        key={meta.driverNumber}
                                        onClick={() =>
                                            toggleDriver(meta.driverNumber)
                                        }
                                        className="flex items-center gap-1.5 px-2 py-0.5 rounded font-mono font-bold transition-all"
                                        style={{
                                            fontSize: 11,
                                            border: `1.5px solid ${focused ? meta.colour : "#2d3748"}`,
                                            backgroundColor: focused
                                                ? `${meta.colour}20`
                                                : "transparent",
                                            color: dimmed
                                                ? "#374151"
                                                : meta.colour,
                                            opacity: dimmed ? 0.5 : 1,
                                            transition: "all 0.15s ease",
                                            cursor: "pointer",
                                        }}
                                        title={`${focused ? "Unfocus" : "Focus"} ${meta.surname}`}
                                    >
                                        {/* Solid / dashed line indicator */}
                                        <svg
                                            width="16"
                                            height="8"
                                            className="flex-shrink-0"
                                        >
                                            <line
                                                x1="0"
                                                y1="4"
                                                x2="16"
                                                y2="4"
                                                stroke={
                                                    dimmed
                                                        ? "#374151"
                                                        : meta.colour
                                                }
                                                strokeWidth="2"
                                                strokeDasharray={
                                                    meta.isPrimary
                                                        ? "none"
                                                        : "3 2"
                                                }
                                            />
                                        </svg>
                                        {meta.surname}
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
