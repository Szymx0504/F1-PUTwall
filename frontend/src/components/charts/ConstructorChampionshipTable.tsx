import { useMemo } from "react";
import type {
    Driver,
    Position,
    ConstructorChampionshipEntry,
} from "../../types";

interface ConstructorChampionshipTableProps {
    allDrivers?: Driver[];
    allPositions?: Map<number, Position[]>;
    standings?: ConstructorChampionshipEntry[];
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

export default function ConstructorChampionshipTable({
    allDrivers = [],
    allPositions,
    standings,
}: ConstructorChampionshipTableProps) {
    const constructorChampionship = useMemo(() => {
        if (standings?.length) {
            // Build a team→color lookup from allDrivers
            const teamColors = new Map<string, string>();
            allDrivers.forEach((driver) => {
                if (driver.team_name && driver.team_colour) {
                    teamColors.set(driver.team_name, `#${driver.team_colour}`);
                }
            });
            return standings
                .map((entry) => {
                    // Prefer color sent directly by the enriched backend response;
                    // fall back to allDrivers lookup for backwards compatibility.
                    const color = entry.team_colour
                        ? `#${entry.team_colour}`
                        : (teamColors.get(entry.team_name) ?? "#ffffff");
                    return {
                        name: entry.team_name,
                        points: entry.points_current ?? entry.points_start ?? 0,
                        color,
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

        const teamPoints = new Map<string, { points: number; color: string }>();
        allDrivers.forEach((d) => {
            const driverPoints = points.get(d.driver_number) ?? 0;
            const teamName = d.team_name ?? "";
            const existing = teamPoints.get(teamName);
            if (existing) {
                existing.points += driverPoints;
            } else {
                teamPoints.set(teamName, {
                    points: driverPoints,
                    color: `#${d.team_colour || "ffffff"}`,
                });
            }
        });

        return Array.from(teamPoints.entries())
            .map(([name, v]) => ({ name, ...v }))
            .sort((a, b) => b.points - a.points);
    }, [allDrivers, allPositions, standings]);

    if (!constructorChampionship.length) {
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
                        <th className="sticky left-8 z-10 bg-f1-card text-left py-2 pr-4 text-[10px] font-semibold text-f1-muted uppercase tracking-wider min-w-[160px]">
                            Team
                        </th>
                        <th className="py-2 px-3 text-right text-[10px] font-semibold text-white uppercase tracking-wider min-w-[56px]">
                            Pts
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {constructorChampionship.map((team, i) => (
                        <tr
                            key={team.name}
                            className="border-t border-f1-border hover:bg-f1-border/20 transition-colors"
                        >
                            <td className="sticky left-0 z-10 bg-f1-card py-2 pr-3 pl-1 text-f1-muted">
                                {i + 1}
                            </td>
                            <td className="sticky left-8 z-10 bg-f1-card py-2 pr-4">
                                <span
                                    className="font-bold"
                                    style={{ color: team.color }}
                                >
                                    {team.name}
                                </span>
                            </td>
                            <td className="py-2 px-3 text-right font-bold text-white">
                                {team.points}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
