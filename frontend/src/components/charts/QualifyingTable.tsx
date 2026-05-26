import { useMemo } from "react";
import type { Driver } from "../../types";
import type { QualLap, QualStint, QSession } from "../../lib/api";
import { fmt, bestLapsByDriver, COMPOUND_COLOR } from "../../lib/api";
import { buildDriverColorResolver } from "../../lib/teamColors";

interface Props {
    drivers: Driver[];
    laps: QualLap[];
    stints: QualStint[];
    qSession: QSession;
    focusDrivers: number[];
    onFocusDrivers: (nums: number[]) => void;
}

function TireBadge({ compound }: { compound: string }) {
    const key = compound?.toUpperCase();
    const color = COMPOUND_COLOR[key] ?? COMPOUND_COLOR.UNKNOWN;
    const initial = compound?.[0]?.toUpperCase() ?? "?";
    const dark = key === "MEDIUM" || key === "HARD";
    return (
        <span
            className="inline-flex items-center justify-center w-5 h-5 rounded-full text-[9px] font-black"
            style={{ background: color, color: dark ? "#000" : "#fff" }}
        >
            {initial}
        </span>
    );
}

export default function QualifyingTable({
    drivers,
    laps,
    stints,
    qSession,
    focusDrivers = [],
    onFocusDrivers = () => {},
}: Props) {
    const rows = useMemo(() => {
        const bestByDriver = bestLapsByDriver(laps);

        const stintByDriver = new Map<number, string>();
        stints.forEach((s) => stintByDriver.set(s.driver_number, s.compound));

        const driverMap = new Map(drivers.map((d) => [d.driver_number, d]));

        const sorted = [...bestByDriver.entries()]
            .map(([num, lap]) => ({ num, lap, driver: driverMap.get(num) }))
            .sort(
                (a, b) =>
                    (a.lap.lap_duration ?? Infinity) -
                    (b.lap.lap_duration ?? Infinity),
            );

        const cutoffs: Record<QSession, number> = { Q1: 0, Q2: 15, Q3: 10 };
        const cutoff = cutoffs[qSession];

        const driverSet = new Set(bestByDriver.keys());
        const eliminated = drivers
            .filter((d) => !driverSet.has(d.driver_number))
            .map((d) => ({
                num: d.driver_number,
                lap: null as QualLap | null,
                driver: d,
            }));

        return [...sorted, ...eliminated].map((r, i) => ({
            pos: i + 1,
            driverNumber: r.num,
            driver: r.driver,
            bestLap: r.lap?.lap_duration ?? null,
            tire: stintByDriver.get(r.num) ?? "UNKNOWN",
            eliminated: !r.lap || (cutoff > 0 && i >= cutoff),
        }));
    }, [drivers, laps, stints, qSession]);

    function handleRowClick(driverNumber: number) {
        if (focusDrivers.includes(driverNumber)) {
            // Deselect this driver
            onFocusDrivers(focusDrivers.filter((n) => n !== driverNumber));
        } else {
            // Add to focus set
            onFocusDrivers([...focusDrivers, driverNumber]);
        }
    }

    const anyFocused = focusDrivers.length > 0;
    const colorOf = useMemo(
        () => buildDriverColorResolver(drivers, focusDrivers),
        [drivers, focusDrivers],
    );

    return (
        <div className="overflow-x-auto">
            {anyFocused && (
                <div className="flex items-center justify-between px-3 py-1.5 mb-1 text-[10px] text-f1-muted bg-f1-border/10 rounded">
                    <span>
                        {focusDrivers.length === 1
                            ? "1 driver selected — click another to compare"
                            : `${focusDrivers.length} drivers selected — comparing on map`}
                    </span>
                    <button
                        className="text-white/40 hover:text-white/80 transition-colors"
                        onClick={() => onFocusDrivers([])}
                    >
                        Clear
                    </button>
                </div>
            )}
            <table className="w-full text-[11px] font-mono border-collapse">
                <thead>
                    <tr>
                        {["Pos", "#", "Name", "Team", "Best Lap", "Tire"].map(
                            (h) => (
                                <th
                                    key={h}
                                    className="py-2 px-3 text-left text-[10px] font-semibold text-f1-muted uppercase tracking-wider whitespace-nowrap"
                                >
                                    {h}
                                </th>
                            ),
                        )}
                    </tr>
                </thead>
                <tbody>
                    {rows.map((r) => {
                        const color = colorOf(r.driverNumber);
                        const focused = focusDrivers.includes(r.driverNumber);
                        const muted = anyFocused && !focused;
                        return (
                            <tr
                                key={r.driverNumber}
                                className={`border-t border-f1-border cursor-pointer transition-colors ${
                                    focused
                                        ? "bg-f1-border/40"
                                        : "hover:bg-f1-border/20"
                                } ${r.eliminated ? "opacity-40" : ""} ${
                                    muted ? "opacity-30" : ""
                                }`}
                                onClick={() => handleRowClick(r.driverNumber)}
                            >
                                <td className="py-2 px-3 text-f1-muted">
                                    {r.pos}
                                </td>
                                <td
                                    className="py-2 px-3 font-bold"
                                    style={{ color }}
                                >
                                    {r.driverNumber}
                                </td>
                                <td
                                    className="py-2 px-3 font-bold"
                                    style={{ color }}
                                >
                                    {r.driver?.full_name
                                        ?.split(" ")
                                        .slice(-1)[0] ??
                                        r.driver?.name_acronym ??
                                        r.driverNumber}
                                </td>
                                <td className="py-2 px-3 text-f1-muted">
                                    {r.driver?.team_name ?? "—"}
                                </td>
                                <td className="py-2 px-3 text-white">
                                    {fmt(r.bestLap)}
                                </td>
                                <td className="py-2 px-3">
                                    <TireBadge compound={r.tire} />
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}
