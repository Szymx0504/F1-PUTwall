export interface Session {
    session_key: number;
    session_name: string;
    session_type: string;
    date_start: string;
    date_end: string;
    gmt_offset: string;
    country_name: string;
    country_code: string;
    circuit_key: number;
    circuit_short_name: string;
    location: string;
    year: number;
    meeting_key: number;
    meeting_name: string;
    has_data?: boolean;
}

export interface Driver {
    driver_number: number;
    broadcast_name: string;
    full_name: string;
    name_acronym: string;
    team_name: string;
    team_colour: string;
    first_name: string;
    last_name: string;
    headshot_url: string;
    country_code: string;
    session_key: number;
}

export interface Lap {
    session_key: number;
    driver_number: number;
    lap_number: number;
    lap_duration: number | null;
    duration_sector_1: number | null;
    duration_sector_2: number | null;
    duration_sector_3: number | null;
    is_pit_out_lap: boolean;
    st_speed: number | null;
    date_start: string;
    segments_sector_1: number[];
    segments_sector_2: number[];
    segments_sector_3: number[];
}

export interface Position {
    session_key: number;
    driver_number: number;
    position: number;
    date: string;
}

export interface SessionResultRow {
    session_key: number;
    driver_number: number;
    position: number;
    dnf?: boolean;
    dns?: boolean;
    dsq?: boolean;
    duration?: number | number[];
    gap_to_leader?: number | string;
    number_of_laps?: number;
    meeting_key?: number;
}

export interface DriverChampionshipEntry {
    session_key: number;
    driver_number: number;
    points_current?: number | null;
    points_start?: number | null;
    position_current?: number | null;
    position_start?: number | null;
    team_name?: string;
    team_colour?: string;
    name?: string;
    full_name?: string;
    broadcast_name?: string;
    name_acronym?: string;
}

export interface ConstructorChampionshipEntry {
    session_key: number;
    team_name: string;
    points_current?: number | null;
    points_start?: number | null;
    position_current?: number | null;
    position_start?: number | null;
    team_colour?: string;
}

export interface CarData {
    session_key: number;
    driver_number: number;
    speed: number;
    throttle: number;
    brake: number;
    rpm: number;
    n_gear: number;
    drs: number;
    date: string;
}

export interface PitStop {
    session_key: number;
    driver_number: number;
    pit_duration: number;
    lap_number: number;
    date: string;
}

export interface Stint {
    session_key: number;
    driver_number: number;
    stint_number: number;
    compound: string;
    lap_start: number;
    lap_end: number;
    tyre_age_at_start: number;
}

export interface Interval {
    session_key: number;
    driver_number: number;
    gap_to_leader: number | null;
    interval: number | null;
    date: string;
}

export interface Weather {
    session_key: number;
    air_temperature: number;
    track_temperature: number;
    humidity: number;
    pressure: number;
    rainfall: number;
    wind_direction: number;
    wind_speed: number;
    date: string;
}

export interface RaceControlMessage {
    date: string;
    session_key: number;
    category: string;
    flag?: string;
    message: string;
    scope?: string;
    driver_number?: number;
    lap_number?: number;
}

export interface LocationPoint {
    session_key: number;
    driver_number: number;
    x: number;
    y: number;
    z: number;
    date: string;
}

export interface TrackMapData {
    outline: { x: number; y: number }[];
    drivers: Record<string, { x: number; y: number; date: string }[]>;
}

// Replay
export interface LapFrame {
    type: "lap_frame";
    lap_number: number;
    total_laps: number;
    laps: Lap[];
    positions: Position[];
    stints: Stint[];
    weather: Weather | null;
    intervals: Interval[];
}

export interface FullRaceData {
    type: "full_race_data";
    laps: Lap[];
    positions: Position[];
    stints: Stint[];
    weather: Weather[];
    intervals: Interval[];
    raceControl: RaceControlMessage[];
}

export interface SessionInfo {
    type: "session_info";
    total_laps: number;
    driver_count: number;
}

export type WSMessage =
    | LapFrame
    | FullRaceData
    | SessionInfo
    | { type: "replay_complete" }
    | { type: "error"; message: string }
    | { type: "pong" };
