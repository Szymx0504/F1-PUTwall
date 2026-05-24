import type { Lap, RaceControlMessage } from "../types";

export type SafetyCarKind = "SC" | "VSC";

export interface SafetyCarPeriod {
    kind: SafetyCarKind;
    /** Inclusive lap number where the period starts. */
    startLap: number;
    /** Inclusive lap number where the period ends. */
    endLap: number;
    /** ISO date of the deploy message. */
    startDate: string;
    /** ISO date of the ending message (or the race end if never closed). */
    endDate: string;
}

/**
 * Resolve a race-control message to a lap number. Most OpenF1 messages already
 * carry `lap_number`; for those that don't we look up the lap whose
 * `date_start` is closest to (and ≤) the message timestamp.
 */
function resolveLap(msg: RaceControlMessage, laps: Lap[]): number {
    if (msg.lap_number != null && msg.lap_number > 0) return msg.lap_number;
    let bestLap = 1;
    let bestDate = "";
    for (const l of laps) {
        if (!l.date_start) continue;
        if (l.date_start <= msg.date && l.date_start > bestDate) {
            bestDate = l.date_start;
            bestLap = l.lap_number;
        }
    }
    return bestLap;
}

/**
 * Derive safety-car and virtual-safety-car periods from race control messages.
 * Each pair of deploy/end messages becomes one period. Dangling deploys (no
 * matching end before the chequered flag) are closed at the last lap.
 */
export function deriveSafetyCarPeriods(
    raceControl: RaceControlMessage[],
    laps: Lap[],
    maxLap: number,
): SafetyCarPeriod[] {
    const sorted = [...raceControl]
        .filter((rc) => rc.date)
        .sort((a, b) => a.date.localeCompare(b.date));

    const periods: SafetyCarPeriod[] = [];
    let openSC: SafetyCarPeriod | null = null;
    let openVSC: SafetyCarPeriod | null = null;

    const lastDate =
        sorted.length > 0 ? sorted[sorted.length - 1].date : new Date().toISOString();

    for (const rc of sorted) {
        const msg = (rc.message ?? "").toUpperCase();
        const flag = (rc.flag ?? "").toUpperCase();
        const isVSC =
            msg.includes("VIRTUAL SAFETY CAR") ||
            msg.includes("VSC") ||
            flag === "VSC";
        const isSC = !isVSC && msg.includes("SAFETY CAR");
        if (!isSC && !isVSC) continue;

        const isEnd =
            msg.includes("ENDING") ||
            msg.includes("IN THIS LAP") ||
            msg.includes(" CLEAR");
        const lap = resolveLap(rc, laps);

        if (isSC) {
            if (isEnd) {
                if (openSC) {
                    openSC.endLap = Math.max(openSC.startLap, lap);
                    openSC.endDate = rc.date;
                    periods.push(openSC);
                    openSC = null;
                }
            } else if (!openSC) {
                openSC = {
                    kind: "SC",
                    startLap: lap,
                    endLap: lap,
                    startDate: rc.date,
                    endDate: rc.date,
                };
            }
        } else {
            if (isEnd) {
                if (openVSC) {
                    openVSC.endLap = Math.max(openVSC.startLap, lap);
                    openVSC.endDate = rc.date;
                    periods.push(openVSC);
                    openVSC = null;
                }
            } else if (!openVSC) {
                openVSC = {
                    kind: "VSC",
                    startLap: lap,
                    endLap: lap,
                    startDate: rc.date,
                    endDate: rc.date,
                };
            }
        }
    }

    if (openSC) {
        openSC.endLap = maxLap || openSC.startLap;
        openSC.endDate = lastDate;
        periods.push(openSC);
    }
    if (openVSC) {
        openVSC.endLap = maxLap || openVSC.startLap;
        openVSC.endDate = lastDate;
        periods.push(openVSC);
    }

    return periods;
}

/** True if `timeMs` falls inside any safety-car period of the given kind. */
export function isSafetyCarActiveAt(
    periods: SafetyCarPeriod[],
    timeMs: number,
    kind: SafetyCarKind = "SC",
): boolean {
    for (const p of periods) {
        if (p.kind !== kind) continue;
        const s = new Date(p.startDate).getTime();
        const e = new Date(p.endDate).getTime();
        if (timeMs >= s && timeMs <= e) return true;
    }
    return false;
}
