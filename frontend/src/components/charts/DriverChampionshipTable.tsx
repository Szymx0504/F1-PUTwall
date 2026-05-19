import { useMemo } from "react";
import type { Driver, Position, DriverChampionshipEntry } from "../../types";

interface DriverChampionshipTableProps {
    allDrivers?: Driver[];
    allPositions?: Map<number, Position[]>;
    standings?: DriverChampionshipEntry[];
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

function positionPoints(pos: number): number {
    return POINTS_MAP[pos] ?? 0;
}

function getDriverLabel(
    driver: Driver | undefined,
    entry: DriverChampionshipEntry,
) {
    const byDriver =
        driver?.full_name || driver?.broadcast_name || driver?.name_acronym;
    // Backend now enriches entries with full_name / name_acronym / broadcast_name
    const fromEntry =
        entry.full_name ||
        entry.broadcast_name ||
        entry.name_acronym ||
        entry.name;
    return byDriver || fromEntry || null;
}

/**
 * Returns the surname portion of a full name, or null when no real name is
 * available so the caller can render just the number without duplication.
 */
function getSurname(label: string | null): string | null {
    if (!label) return null;
    const parts = label.trim().split(" ");
    return parts[parts.length - 1]?.toUpperCase() || null;
}

export default function DriverChampionshipTable({
    allDrivers = [],
    allPositions,
    standings,
}: DriverChampionshipTableProps) {
    const driverChampionship = useMemo(() => {
        if (standings?.length) {
            const driversMap = new Map(
                allDrivers.map((driver) => [driver.driver_number, driver]),
            );
            return standings
                .map((entry) => {
                    const driver = driversMap.get(Number(entry.driver_number));
                    const label = getDriverLabel(driver, entry);
                    const surname = getSurname(label);
                    return {
                        driverNumber: Number(entry.driver_number),
                        surname, // null → render number only, no duplication
                        // Backend enriches entries with team_name and team_colour;
                        // fall back to allDrivers lookup for backwards compatibility.
                        teamName: entry.team_name ?? driver?.team_name ?? "",
                        points: entry.points_current ?? entry.points_start ?? 0,
                        color: `#${
                            entry.team_colour ?? driver?.team_colour ?? "ffffff"
                        }`,
                    };
                })
                .sort((a, b) => b.points - a.points);
        }

        if (!allDrivers.length || !allPositions?.size) return [];
        const points = new Map<number, number>();
        allPositions.forEach((posList) => {
            const byDriver = new Map<number, Position>();
            posList.forEach((p) => {
                const ex = byDriver.get(p.driver_number);
                if (!ex || p.date > ex.date) byDriver.set(p.driver_number, p);
            });
            byDriver.forEach((pos, driverNum) => {
                if (pos.position >= 1 && pos.position <= 20) {
                    points.set(
                        driverNum,
                        (points.get(driverNum) ?? 0) +
                            positionPoints(pos.position),
                    );
                }
            });
        });
        return allDrivers
            .filter((d) => points.has(d.driver_number))
            .map((d) => ({
                driverNumber: d.driver_number,
                surname:
                    d.full_name?.split(" ").slice(-1)[0]?.toUpperCase() ??
                    d.name_acronym ??
                    null,
                teamName: d.team_name ?? "",
                points: points.get(d.driver_number) ?? 0,
                color: `#${d.team_colour || "ffffff"}`,
            }))
            .sort((a, b) => b.points - a.points);
    }, [allDrivers, allPositions, standings]);

    if (!driverChampionship.length) {
        return (
            <p className="text-f1-muted text-sm">
                No championship data available.
            </p>
        );
    }

    return (
        <div className="overflow-x-auto">
            <table className="w-full text-[11px] font-mono border-collapse">
                <thead>
                    <tr>
                        <th className="sticky left-0 z-10 bg-f1-card text-left py-2 pr-3 pl-1 text-[10px] font-semibold text-f1-muted uppercase tracking-wider w-[40px]">
                            #
                        </th>
                        <th className="sticky left-8 z-10 bg-f1-card text-left py-2 pr-4 text-[10px] font-semibold text-f1-muted uppercase tracking-wider min-w-[140px]">
                            Driver
                        </th>
                        <th className="py-2 px-3 text-left text-[10px] font-semibold text-f1-muted uppercase tracking-wider min-w-[160px]">
                            Team
                        </th>
                        <th className="py-2 px-3 text-right text-[10px] font-semibold text-white uppercase tracking-wider min-w-[56px]">
                            Pts
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {driverChampionship.map((driver, i) => (
                        <tr
                            key={driver.driverNumber}
                            className="border-t border-f1-border hover:bg-f1-border/20 transition-colors"
                        >
                            <td className="sticky left-0 z-10 bg-f1-card py-2 pr-3 pl-1 text-f1-muted">
                                {i + 1}
                            </td>
                            <td className="sticky left-8 z-10 bg-f1-card py-2 pr-4">
                                <span
                                    className="font-bold"
                                    style={{ color: driver.color }}
                                >
                                    #{driver.driverNumber}
                                    {driver.surname ? ` ${driver.surname}` : ""}
                                </span>
                            </td>
                            <td className="py-2 px-3 text-left text-f1-muted">
                                {driver.teamName}
                            </td>
                            <td className="py-2 px-3 text-right font-bold text-white">
                                {driver.points}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
