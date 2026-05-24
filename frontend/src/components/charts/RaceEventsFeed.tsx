import { memo, useMemo } from "react";
import type {
    Driver,
    Lap,
    Position,
    Stint,
    RaceControlMessage,
    Weather,
} from "../../types";

interface Props {
    laps: Lap[];
    positions: Position[];
    stints: Stint[];
    raceControl: RaceControlMessage[];
    weather: Weather[];
    drivers: Driver[];
    currentLap: number;
    maxLap: number;
    highlightDriver: number | null;
}

type EventType =
    | "retirement"
    | "yellow_flag"
    | "red_flag"
    | "safety_car"
    | "vsc"
    | "black_flag"
    | "penalty"
    | "rain"
    | "chequered";

interface RaceEvent {
    lap: number;
    type: EventType;
    driverNumber: number | null;
    description: string;
    detail?: string;
}

const EVENT_ICONS: Record<EventType, string> = {
    retirement: "⛔",
    yellow_flag: "🟡",
    red_flag: "🔴",
    safety_car: "🚗",
    vsc: "🚙",
    black_flag: "⚫",
    penalty: "⚠️",
    rain: "🌧️",
    chequered: "🏁",
};

const EVENT_COLORS: Record<EventType, string> = {
    retirement: "#ef4444",
    yellow_flag: "#eab308",
    red_flag: "#ef4444",
    safety_car: "#f97316",
    vsc: "#f59e0b",
    black_flag: "#6b7280",
    penalty: "#f97316",
    rain: "#60a5fa",
    chequered: "#f5f5f5",
};

function RaceEventsFeed({
    laps,
    positions: _positions,
    stints: _stints,
    raceControl,
    weather,
    drivers,
    currentLap,
    maxLap: _maxLap,
    highlightDriver,
}: Props) {
    const driverMap = useMemo(() => {
        const m = new Map<number, Driver>();
        for (const d of drivers) m.set(d.driver_number, d);
        return m;
    }, [drivers]);

    const events = useMemo(() => {
        const result: RaceEvent[] = [];

        const lapsByDriver = new Map<number, Lap[]>();
        for (const l of laps) {
            const list = lapsByDriver.get(l.driver_number) ?? [];
            list.push(l);
            lapsByDriver.set(l.driver_number, list);
        }

        // ── Detect retirements ──
        const maxLapInData = Math.max(...laps.map((l) => l.lap_number), 0);
        for (const [dn, driverLaps] of lapsByDriver) {
            const lastLap = Math.max(...driverLaps.map((l) => l.lap_number));
            if (lastLap < maxLapInData - 2 && lastLap > 1) {
                const drv = driverMap.get(dn);
                result.push({
                    lap: lastLap,
                    type: "retirement",
                    driverNumber: dn,
                    description: `${drv?.name_acronym ?? dn} retired`,
                    detail: `Last seen lap ${lastLap}`,
                });
            }
        }

        // ── Rain detection from weather data (one event per lap, debounced) ──
        // Some races (Miami, Spa) have laps with null date_start — filter & guard
        // before sorting so localeCompare doesn't crash on null.
        const sortedLaps = [...laps]
            .filter((l) => l.date_start)
            .sort((a, b) =>
                (a.date_start ?? "").localeCompare(b.date_start ?? ""),
            );
        const lapDates = new Map<number, string>();
        for (const l of sortedLaps) {
            if (l.date_start && !lapDates.has(l.lap_number))
                lapDates.set(l.lap_number, l.date_start);
        }
        const sortedWeather = [...weather]
            .filter((w) => w.date)
            .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
        // Determine rain state per lap (majority vote)
        const rainByLap = new Map<number, { rain: number; dry: number }>();
        for (const w of sortedWeather) {
            let closestLap = 1;
            for (const [lapNum, date] of lapDates) {
                if (date <= w.date) closestLap = lapNum;
            }
            const entry = rainByLap.get(closestLap) ?? { rain: 0, dry: 0 };
            if (w.rainfall > 0) entry.rain++;
            else entry.dry++;
            rainByLap.set(closestLap, entry);
        }
        let wasRaining = false;
        const lapNums = [...lapDates.keys()].sort((a, b) => a - b);
        for (const lapNum of lapNums) {
            const counts = rainByLap.get(lapNum);
            if (!counts) continue;
            const raining = counts.rain > counts.dry;
            if (raining !== wasRaining) {
                result.push({
                    lap: lapNum,
                    type: "rain",
                    driverNumber: null,
                    description: raining ? "Rain starts" : "Rain stops",
                    detail: `Lap ${lapNum}`,
                });
                wasRaining = raining;
            }
        }

        // ── Race control messages ──
        for (const rc of raceControl) {
            const lap = rc.lap_number ?? 0;
            const msg = (rc.message ?? "").toUpperCase();
            const flag = (rc.flag ?? "").toUpperCase();

            let type: EventType | null = null;
            let description = rc.message;

            if (flag === "RED" || msg.includes("RED FLAG")) {
                type = "red_flag";
                description = "Red Flag";
            } else if (msg.includes("CHEQUERED")) {
                type = "chequered";
                description = "Chequered Flag";
            } else if (
                msg.includes("SAFETY CAR") &&
                !msg.includes("VIRTUAL") &&
                !msg.includes("VSC")
            ) {
                type = "safety_car";
                description =
                    msg.includes("IN THIS LAP") || msg.includes("ENDING")
                        ? "Safety Car ending"
                        : "Safety Car deployed";
            } else if (
                msg.includes("VIRTUAL SAFETY CAR") ||
                msg.includes("VSC") ||
                flag === "VSC"
            ) {
                type = "vsc";
                description = msg.includes("ENDING")
                    ? "VSC ending"
                    : "Virtual Safety Car";
            } else if (
                (flag === "YELLOW" || msg.includes("YELLOW")) &&
                !msg.includes("SECTOR") &&
                !msg.includes("TRACK SECTOR")
            ) {
                type = "yellow_flag";
                description = rc.message;
            } else if (flag === "BLACK AND WHITE" || flag === "BLACK") {
                type = "black_flag";
                const drv = rc.driver_number
                    ? driverMap.get(rc.driver_number)
                    : null;
                description = drv
                    ? `Black & white flag: ${drv.name_acronym}`
                    : rc.message;
            } else if (
                msg.includes("TIME PENALTY") ||
                msg.includes("SECOND PENALTY") ||
                msg.includes("SEC PENALTY")
            ) {
                type = "penalty";
                const drv = rc.driver_number
                    ? driverMap.get(rc.driver_number)
                    : null;
                description = drv
                    ? `${drv.name_acronym}: ${rc.message}`
                    : rc.message;
            } else if (msg.includes("TRACK LIMITS") && rc.driver_number) {
                type = "penalty";
                const drv = driverMap.get(rc.driver_number);
                description = drv
                    ? `${drv.name_acronym}: Track limits warning`
                    : rc.message;
            }

            if (type) {
                result.push({
                    lap,
                    type,
                    driverNumber: rc.driver_number ?? null,
                    description,
                    detail: lap ? `Lap ${lap}` : undefined,
                });
            }
        }

        result.sort((a, b) => b.lap - a.lap || a.type.localeCompare(b.type));

        // Deduplicate: keep only one event per (lap, type, description) combo
        const seen = new Set<string>();
        const deduped = result.filter((ev) => {
            const key = `${ev.lap}_${ev.type}_${ev.description}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        return deduped;
    }, [laps, weather, raceControl, driverMap]);

    // Filter to events at or before current lap
    const visibleEvents = useMemo(
        () => events.filter((e) => e.lap <= currentLap),
        [events, currentLap],
    );

    return (
        <div className="bg-f1-card rounded-xl border border-f1-border p-4 flex flex-col">
            <h3 className="text-sm font-semibold mb-3 text-f1-muted uppercase tracking-wide">
                Race Events
            </h3>
            <div
                className="overflow-y-auto space-y-0.5 pr-1"
                style={{ height: 500 }}
            >
                {visibleEvents.length === 0 ? (
                    <p className="text-f1-muted text-sm text-center py-8">
                        No events yet — start the replay
                    </p>
                ) : (
                    visibleEvents.map((ev, i) => {
                        const drv =
                            ev.driverNumber != null
                                ? driverMap.get(ev.driverNumber)
                                : null;
                        const col = drv
                            ? `#${drv.team_colour || "fff"}`
                            : EVENT_COLORS[ev.type];
                        const isHl =
                            ev.driverNumber != null &&
                            highlightDriver === ev.driverNumber;
                        const isDim =
                            highlightDriver != null &&
                            ev.driverNumber != null &&
                            !isHl;

                        return (
                            <div
                                key={`${ev.lap}-${ev.type}-${ev.driverNumber}-${i}`}
                                className="flex items-center gap-2 px-2 py-1.5 rounded-md transition-opacity"
                                style={{
                                    opacity: isDim ? 0.25 : 1,
                                    background: "rgba(255,255,255,0.05)",
                                }}
                            >
                                {/* Lap badge */}
                                <span className="text-[10px] font-mono text-white/40 w-6 text-right shrink-0">
                                    L{ev.lap}
                                </span>

                                {/* Event icon */}
                                <span
                                    className="text-sm w-5 text-center shrink-0"
                                    style={{ color: EVENT_COLORS[ev.type] }}
                                >
                                    {EVENT_ICONS[ev.type]}
                                </span>

                                {/* Team color bar */}
                                <span
                                    className="w-[3px] h-4 rounded-sm shrink-0"
                                    style={{ background: col }}
                                />

                                {/* Description */}
                                <span className="text-xs text-white/90 truncate flex-1">
                                    {ev.description}
                                </span>

                                {/* Detail */}
                                {ev.detail && (
                                    <span className="text-[10px] text-white/40 font-mono shrink-0">
                                        {ev.detail}
                                    </span>
                                )}
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
}

export default memo(RaceEventsFeed);
