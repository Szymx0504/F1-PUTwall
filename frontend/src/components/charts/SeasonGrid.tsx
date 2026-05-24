import { useMemo, useRef, useState } from "react";
import { useSeasonResultsStream } from "../../hooks/useSeasonResultsStream";
import LoadingProgressBar from "../shared/LoadingProgressBar";

interface Session {
    session_key: number;
    session_name?: string;
    session_type: string; // "Race" | "Sprint"
    country_name: string;
    circuit_short_name: string;
    date_start: string;
    year: number;
}

interface RaceResult {
    driver_number: number;
    position: number;
    classified_position?: string | number; // "1"–"20", "DNF", "DNS", "DSQ", "NC", "EX", etc.
    dnf?: boolean;
    dns?: boolean;
    dsq?: boolean;
    full_name?: string;
    name_acronym?: string;
    team_name?: string;
    team_colour?: string;
}

// null  → driver didn't participate at all that weekend (blank cell)
// "DNF" | "DNS" | "DSQ" | "NC" → participated but didn't finish / was excluded
// number → classified finishing position
type RaceSlot = number | "DNF" | "DNS" | "DSQ" | "NC" | null;

interface GridEntry {
    driverNumber: number;
    surname: string;
    acronym: string;
    teamName: string;
    color: string;
    slots: RaceSlot[];
    totalPoints: number;
}

interface SeasonGridProps {
    year: number;
    selectedSessionKey: number;
    apiBase?: string;
    /** driver_number → championship points (from driver championship endpoint).
     *  If provided these replace the locally-calculated points totals. */
    championshipPoints?: Record<number, number>;
}

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
const pts = (slot: RaceSlot, isSprint = false): number => {
    if (typeof slot !== "number") return 0;
    const map = isSprint ? SPRINT_POINTS_MAP : POINTS_MAP;
    return map[slot] ?? 0;
};

const MEDAL: Record<number, string> = {
    1: "#ffd700",
    2: "#c0c0c0",
    3: "#cd7f32",
};

/** Parse API data into a typed RaceSlot. */
function parseSlot(r: RaceResult): RaceSlot {
    // Prefer classified_position when present
    if (
        r.classified_position !== undefined &&
        r.classified_position !== null &&
        r.classified_position !== ""
    ) {
        const cpStr = String(r.classified_position).toUpperCase().trim();
        const num = Number(cpStr);
        if (!isNaN(num) && num >= 1 && num <= 20) return num;
        // Normalise known retirement codes
        if (cpStr === "DNF" || cpStr === "RET" || cpStr === "RETIRED")
            return "DNF";
        if (cpStr === "DNS" || cpStr === "WD") return "DNS";
        if (cpStr === "DSQ" || cpStr === "DQ" || cpStr === "EX") return "DSQ";
        if (cpStr === "NC") return "NC";
    }
    // Fall back to numeric position field
    if (r.position >= 1 && r.position <= 20) return r.position;
    // Fall back to boolean flags (same priority order as RaceResultTable: DSQ > DNS > DNF)
    if (r.dsq === true) return "DSQ";
    if (r.dns === true) return "DNS";
    if (r.dnf === true) return "DNF";
    // Driver is in the results list but couldn't be classified → DNF
    return "DNF";
}

function cellBg(slot: RaceSlot): string {
    if (slot === null) return "transparent";
    if (typeof slot === "number") {
        if (slot === 1) return "rgba(255,215,0,0.15)";
        if (slot === 2) return "rgba(192,192,192,0.12)";
        if (slot === 3) return "rgba(205,127,50,0.12)";
        if (slot <= 10) return "rgba(34,197,94,0.08)";
        return "rgba(255,255,255,0.03)";
    }
    // Status codes — match RaceResultTable: DNF=red, DNS=gray, DSQ=purple, NC=gray
    if (slot === "DNF") return "rgba(248,113,113,0.12)";
    if (slot === "DNS") return "rgba(156,163,175,0.10)";
    if (slot === "DSQ") return "rgba(192,132,252,0.12)";
    return "rgba(156,163,175,0.08)"; // NC
}

function cellColor(slot: RaceSlot): string {
    if (slot === null) return "transparent";
    if (typeof slot === "number") {
        if (slot <= 3) return MEDAL[slot];
        if (slot <= 10) return "#86efac";
        return "#6b7280";
    }
    // Match RaceResultTable status colors exactly
    if (slot === "DNF") return "#f87171"; // text-red-400
    if (slot === "DNS") return "#9ca3af"; // text-gray-400
    if (slot === "DSQ") return "#c084fc"; // text-purple-400
    return "#9ca3af"; // NC → gray
}

function cellLabel(slot: RaceSlot): string {
    if (slot === null) return "";
    if (typeof slot === "number") return String(slot);
    return slot; // "DNF", "DNS", "DSQ", "NC"
}

function getSurname(fullName?: string): string | null {
    if (!fullName) return null;
    const parts = fullName.trim().split(" ");
    return parts[parts.length - 1]?.toUpperCase() || null;
}

// ── Cell Tooltip ──────────────────────────────────────────────────────────────

interface TooltipState {
    visible: boolean;
    x: number;
    y: number;
    content: React.ReactNode;
}

function cellTooltipContent(
    slot: RaceSlot,
    driverName: string,
    circuitName: string,
    isSprint: boolean,
    teamName: string,
    teamColor: string,
): React.ReactNode {
    const statusLabels: Record<string, string> = {
        DNF: "Did Not Finish",
        DNS: "Did Not Start",
        DSQ: "Disqualified",
        NC: "Not Classified",
    };

    return (
        <div style={{ minWidth: 150 }}>
            <div
                style={{
                    marginBottom: 6,
                    fontSize: 10,
                    fontWeight: 600,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    color: "#6b7280",
                }}
            >
                {circuitName}
            </div>
            <div
                style={{
                    display: "flex",
                    alignItems: "baseline",
                    justifyContent: "space-between",
                    gap: 6,
                    marginBottom: 6,
                }}
            >
                <span
                    style={{
                        fontSize: 11,
                        fontWeight: 700,
                        color: teamColor,
                    }}
                >
                    {driverName}
                </span>
                <span
                    style={{
                        fontSize: 10,
                        fontWeight: 600,
                        color: teamColor,
                        opacity: 0.7,
                    }}
                >
                    {teamName}
                </span>
            </div>
            {slot === null ? (
                <div style={{ fontSize: 11, color: "#6b7280" }}>
                    Did not participate
                </div>
            ) : typeof slot === "number" ? (
                <div
                    style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 12,
                    }}
                >
                    <span style={{ fontSize: 11, color: cellColor(slot) }}>
                        P{slot}
                    </span>
                    <span
                        style={{
                            fontSize: 11,
                            fontFamily: "monospace",
                            fontWeight: 700,
                            color: cellColor(slot),
                        }}
                    >
                        {pts(slot, isSprint)} pts
                    </span>
                </div>
            ) : (
                <div style={{ fontSize: 11, color: cellColor(slot) }}>
                    {statusLabels[slot] ?? slot} · 0 pts
                </div>
            )}
        </div>
    );
}

export default function SeasonGrid({
    year,
    selectedSessionKey,
    apiBase = "/api",
    championshipPoints,
}: SeasonGridProps) {
    const state = useSeasonResultsStream(year, apiBase);
    const [tooltip, setTooltip] = useState<TooltipState>({
        visible: false,
        x: 0,
        y: 0,
        content: null,
    });
    const containerRef = useRef<HTMLDivElement | null>(null);

    const visibleSessions = useMemo<Session[]>(() => {
        if (!state.sessions.length) return [];
        const idx = state.sessions.findIndex(
            (s) => s.session_key === selectedSessionKey,
        );
        return idx >= 0 ? state.sessions.slice(0, idx + 1) : state.sessions;
    }, [state.sessions, selectedSessionKey]);

    const driverGrid = useMemo((): GridEntry[] => {
        if (!visibleSessions.length) return [];

        const driverMap = new Map<number, GridEntry>();

        visibleSessions.forEach((session, raceIdx) => {
            const results: RaceResult[] =
                state.results[String(session.session_key)] ?? [];
            results.forEach((r) => {
                if (!driverMap.has(r.driver_number)) {
                    driverMap.set(r.driver_number, {
                        driverNumber: r.driver_number,
                        surname:
                            getSurname(r.full_name) ??
                            r.name_acronym ??
                            String(r.driver_number),
                        acronym: r.name_acronym ?? String(r.driver_number),
                        teamName: r.team_name ?? "",
                        color: `#${r.team_colour || "ffffff"}`,
                        // All slots start as null (= didn't participate / blank)
                        slots: Array(visibleSessions.length).fill(null),
                        totalPoints: 0,
                    });
                }
                const entry = driverMap.get(r.driver_number)!;
                const slot = parseSlot(r);
                entry.slots[raceIdx] = slot;
                const isSprint = session.session_type === "Sprint";
                entry.totalPoints += pts(slot, isSprint);
                if (r.team_colour) entry.color = `#${r.team_colour}`;
                if (r.team_name) entry.teamName = r.team_name;
                if (r.full_name)
                    entry.surname = getSurname(r.full_name) ?? entry.surname;
                if (r.name_acronym) entry.acronym = r.name_acronym;
            });
        });

        const drivers = Array.from(driverMap.values()).filter((d) =>
            d.slots.some((s) => s !== null),
        );

        // Apply official championship points when provided by the parent,
        // otherwise keep the locally-calculated totals (position points only).
        if (championshipPoints) {
            drivers.forEach((d) => {
                d.totalPoints =
                    championshipPoints[d.driverNumber] ?? d.totalPoints;
            });
        }

        return drivers.sort((a, b) => b.totalPoints - a.totalPoints);
    }, [state.results, visibleSessions, championshipPoints]);

    if (state.status === "error") {
        return (
            <p className="text-red-400 text-sm py-4">
                Failed to load season grid: {state.error}
            </p>
        );
    }

    if (
        state.status === "idle" ||
        state.status === "loading" ||
        !visibleSessions.length ||
        !driverGrid.length
    ) {
        return (
            <LoadingProgressBar
                label="Loading season results"
                loaded={state.loaded}
                total={state.total}
            />
        );
    }

    return (
        <div className="overflow-x-auto relative" ref={containerRef}>
            {/* Custom tooltip */}
            {tooltip.visible && (
                <div
                    style={{
                        position: "fixed",
                        left: tooltip.x + 12,
                        top: tooltip.y - 8,
                        zIndex: 9999,
                        backgroundColor: "#111214",
                        border: "1px solid #2d3748",
                        borderRadius: 8,
                        padding: "10px 12px",
                        color: "#ffffff",
                        boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
                        pointerEvents: "none",
                    }}
                >
                    {tooltip.content}
                </div>
            )}
            <table
                className="w-full text-[11px] font-mono border-collapse"
                style={{ minWidth: visibleSessions.length * 36 + 240 }}
            >
                <thead>
                    <tr>
                        <th className="sticky left-0 z-10 bg-f1-card text-left py-2 pr-3 pl-1 text-[10px] font-semibold text-f1-muted uppercase tracking-wider w-[32px]">
                            #
                        </th>
                        <th className="sticky left-8 z-10 bg-f1-card text-left py-2 pr-6 text-[10px] font-semibold text-f1-muted uppercase tracking-wider min-w-[220px]">
                            Driver
                        </th>
                        {visibleSessions.map((r) => (
                            <th
                                key={r.session_key}
                                className="py-2 px-0 text-[10px] font-semibold text-f1-muted uppercase tracking-wider w-[36px]"
                                style={{
                                    paddingTop: 12,
                                    paddingBottom: 8,
                                    verticalAlign: "bottom",
                                }}
                            >
                                <span
                                    className="block mx-auto"
                                    style={{
                                        writingMode: "vertical-rl",
                                        transform: "rotate(180deg)",
                                        whiteSpace: "nowrap",
                                        maxHeight: 150,
                                        overflow: "hidden",
                                        textAlign: "left",
                                    }}
                                >
                                    {r.session_type === "Sprint"
                                        ? `${r.circuit_short_name} Sprint`
                                        : r.circuit_short_name}
                                </span>
                            </th>
                        ))}
                        <th className="py-2 px-3 text-right text-[10px] font-semibold text-white uppercase tracking-wider min-w-[56px]">
                            Pts
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {driverGrid.map((driver, i) => (
                        <tr
                            key={driver.driverNumber}
                            className="border-t border-f1-border hover:bg-f1-border/20 transition-colors"
                        >
                            <td className="sticky left-0 z-10 bg-f1-card py-2 pr-3 pl-1 text-f1-muted">
                                {i + 1}
                            </td>
                            <td className="sticky left-8 z-10 bg-f1-card py-2 pr-6">
                                <span className="font-bold text-f1-muted">
                                    #{driver.driverNumber}{" "}
                                </span>
                                <span
                                    className="font-bold"
                                    style={{ color: driver.color }}
                                >
                                    {driver.surname}
                                </span>
                                <span
                                    className="ml-2 font-normal text-[9px] uppercase tracking-wider opacity-60"
                                    style={{ color: driver.color }}
                                >
                                    {driver.teamName}
                                </span>
                            </td>
                            {driver.slots.map((slot, raceIdx) => {
                                const session = visibleSessions[raceIdx];
                                const isSprint =
                                    session?.session_type === "Sprint";
                                return (
                                    <td
                                        key={raceIdx}
                                        className="py-1 px-0 text-center"
                                        onMouseEnter={(e) =>
                                            setTooltip({
                                                visible: true,
                                                x: e.clientX,
                                                y: e.clientY,
                                                content: cellTooltipContent(
                                                    slot,
                                                    driver.surname,
                                                    session
                                                        ? isSprint
                                                            ? `${session.circuit_short_name} Sprint`
                                                            : session.circuit_short_name
                                                        : "",
                                                    isSprint,
                                                    driver.teamName,
                                                    driver.color,
                                                ),
                                            })
                                        }
                                        onMouseMove={(e) =>
                                            setTooltip((prev) => ({
                                                ...prev,
                                                x: e.clientX,
                                                y: e.clientY,
                                            }))
                                        }
                                        onMouseLeave={() =>
                                            setTooltip((prev) => ({
                                                ...prev,
                                                visible: false,
                                            }))
                                        }
                                    >
                                        <span
                                            className="inline-flex items-center justify-center w-7 h-6 rounded font-bold"
                                            style={{
                                                backgroundColor: cellBg(slot),
                                                color: cellColor(slot),
                                                // Status codes need smaller text to fit
                                                fontSize:
                                                    typeof slot === "string"
                                                        ? "8px"
                                                        : "10px",
                                            }}
                                        >
                                            {cellLabel(slot)}
                                        </span>
                                    </td>
                                );
                            })}
                            <td className="py-2 px-3 text-right font-bold text-white">
                                {driver.totalPoints}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
