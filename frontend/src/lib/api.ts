import type {
    Session,
    Driver,
    Lap,
    Position,
    SessionResultRow,
    CarData,
    PitStop,
    Stint,
    Interval,
    Weather,
    LocationPoint,
    TrackMapData,
    RaceControlMessage,
    DriverChampionshipEntry,
    ConstructorChampionshipEntry,
    FullRaceData,
} from "../types";

const BASE = "/api";

async function fetchJson<T>(url: string): Promise<T> {
    const res = await fetch(`${BASE}${url}`);
    if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
    return res.json();
}

// ─── Qualifying types (merged from qualifying.types.ts) ───────────────────────

export type QSession = "Q1" | "Q2" | "Q3";

export interface QualLap {
    driver_number: number;
    lap_number: number;
    lap_duration: number | null;
    duration_sector_1: number | null;
    duration_sector_2: number | null;
    duration_sector_3: number | null;
    i1_speed: number | null;
    i2_speed: number | null;
    st_speed: number | null;
    date_start: string;
    is_pit_out_lap: boolean;
}

export interface QualStint {
    driver_number: number;
    lap_start: number;
    lap_end: number;
    compound: string;
    tyre_age_at_start: number;
}

export interface QualCarData {
    driver_number: number;
    date: string;
    rpm: number;
    speed: number;
    n_gear: number;
    throttle: number;
    brake: number;
    drs: number;
}

export const COMPOUND_COLOR: Record<string, string> = {
    SOFT: "#e8002d",
    MEDIUM: "#ffd600",
    HARD: "#f0f0ec",
    INTER: "#39b54a",
    WET: "#0067ff",
    UNKNOWN: "#888",
};

export function fmt(t: number | null): string {
    if (t == null) return "—";
    const m = Math.floor(t / 60);
    const s = (t % 60).toFixed(3).padStart(6, "0");
    return m > 0 ? `${m}:${s}` : `${s}`;
}

export function fmtGap(gap: number | null): string {
    if (gap == null || gap === 0) return "—";
    return `+${gap.toFixed(3)}`;
}

export function bestLapsByDriver(laps: QualLap[]): Map<number, QualLap> {
    const map = new Map<number, QualLap>();
    laps.forEach((lap) => {
        if (!lap.lap_duration || lap.is_pit_out_lap) return;
        const ex = map.get(lap.driver_number);
        if (!ex || lap.lap_duration < ex.lap_duration!)
            map.set(lap.driver_number, lap);
    });
    return map;
}

// ─── API client ───────────────────────────────────────────────────────────────

export const api = {
    getSessions: (year?: number, sessionType?: string) => {
        const params = new URLSearchParams();
        if (year) params.set("year", String(year));
        if (sessionType) params.set("session_type", sessionType);
        const qs = params.toString();
        return fetchJson<Session[]>(`/sessions${qs ? `?${qs}` : ""}`);
    },

    getSession: (sessionKey: number) =>
        fetchJson<Session>(`/sessions/${sessionKey}`),

    getDrivers: (sessionKey: number) =>
        fetchJson<Driver[]>(`/sessions/${sessionKey}/drivers`),

    getSessionResult: (sessionKey: number) =>
        fetchJson<SessionResultRow[]>(`/sessions/${sessionKey}/result`),

    getLaps: (sessionKey: number, driverNumber?: number) => {
        const qs = driverNumber ? `?driver_number=${driverNumber}` : "";
        return fetchJson<Lap[]>(`/sessions/${sessionKey}/laps${qs}`);
    },

    /** Qualifying-specific lap fetch — returns the richer QualLap shape. */
    getQualifyingLaps: (sessionKey: number) =>
        fetchJson<QualLap[]>(`/sessions/${sessionKey}/laps`),

    /** Qualifying-specific stints fetch — returns the richer QualStint shape. */
    getQualifyingStints: (sessionKey: number) =>
        fetchJson<QualStint[]>(`/sessions/${sessionKey}/stints`),

    getPosition: (sessionKey: number, driverNumber?: number) => {
        const qs = driverNumber ? `?driver_number=${driverNumber}` : "";
        return fetchJson<Position[]>(`/sessions/${sessionKey}/position${qs}`);
    },

    getCarData: (sessionKey: number, driverNumber: number) =>
        fetchJson<CarData[]>(
            `/sessions/${sessionKey}/car_data/${driverNumber}`,
        ),

    getPitStops: (sessionKey: number, driverNumber?: number) => {
        const qs = driverNumber ? `?driver_number=${driverNumber}` : "";
        return fetchJson<PitStop[]>(`/sessions/${sessionKey}/pit_stops${qs}`);
    },

    getStints: (sessionKey: number, driverNumber?: number) => {
        const qs = driverNumber ? `?driver_number=${driverNumber}` : "";
        return fetchJson<Stint[]>(`/sessions/${sessionKey}/stints${qs}`);
    },

    getIntervals: (sessionKey: number, driverNumber?: number) => {
        const qs = driverNumber ? `?driver_number=${driverNumber}` : "";
        return fetchJson<Interval[]>(`/sessions/${sessionKey}/intervals${qs}`);
    },

    getWeather: (sessionKey: number) =>
        fetchJson<Weather[]>(`/sessions/${sessionKey}/weather`),

    getLocation: (sessionKey: number, driverNumber?: number) => {
        const qs = driverNumber ? `?driver_number=${driverNumber}` : "";
        return fetchJson<LocationPoint[]>(
            `/sessions/${sessionKey}/location${qs}`,
        );
    },

    getRaceControl: (sessionKey: number) =>
        fetchJson<RaceControlMessage[]>(`/sessions/${sessionKey}/race_control`),

    getRaceReplayData: (sessionKey: number) =>
        fetchJson<FullRaceData>(`/sessions/${sessionKey}/race_replay_data`),

    getTrackMap: (sessionKey: number) =>
        fetchJson<TrackMapData>(`/sessions/${sessionKey}/track_map`),

    getDriverChampionship: (sessionKey: number) =>
        fetchJson<DriverChampionshipEntry[]>(
            `/championship/drivers?session_key=${sessionKey}`,
        ),

    getConstructorChampionship: (sessionKey: number) =>
        fetchJson<ConstructorChampionshipEntry[]>(
            `/championship/teams?session_key=${sessionKey}`,
        ),

    getDriverChampionshipByYear: (year: number, afterSessionKey?: number) => {
        const params = new URLSearchParams({ year: String(year) });
        if (afterSessionKey)
            params.set("after_session_key", String(afterSessionKey));
        return fetchJson<DriverChampionshipEntry[]>(
            `/championship/drivers/by-year?${params}`,
        );
    },

    getConstructorChampionshipByYear: (
        year: number,
        afterSessionKey?: number,
    ) => {
        const params = new URLSearchParams({ year: String(year) });
        if (afterSessionKey)
            params.set("after_session_key", String(afterSessionKey));
        return fetchJson<ConstructorChampionshipEntry[]>(
            `/championship/teams/by-year?${params}`,
        );
    },

    getCarDataAll: async (
        sessionKey: number,
        driverNumbers: number[],
    ): Promise<Map<number, CarData[]>> => {
        const map = new Map<number, CarData[]>();
        await Promise.all(
            driverNumbers.map(async (num) => {
                try {
                    const data = await fetchJson<CarData[]>(
                        `/sessions/${sessionKey}/car_data/${num}`,
                    );
                    if (data?.length) map.set(num, data);
                } catch {
                    // ignore per-driver fetch failures
                }
            }),
        );
        return map;
    },
};
