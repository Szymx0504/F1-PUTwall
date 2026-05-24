import { useEffect, useMemo, useReducer, useRef } from "react";
import type {
    FullRaceData,
    Lap,
    Position,
    Stint,
    Weather,
    Interval,
    RaceControlMessage,
} from "../types";
import { consumeNdjson } from "../lib/ndjson";

export type RaceReplayPart =
    | "laps"
    | "positions"
    | "stints"
    | "weather"
    | "intervals"
    | "raceControl";

export type RaceReplayStreamStatus = "idle" | "loading" | "done" | "error";

export interface RaceReplayStreamState {
    status: RaceReplayStreamStatus;
    /** Fully populated only once `status === "done"`. */
    data: FullRaceData | null;
    /** Number of parts received so far (≤ total). */
    loaded: number;
    /** Total parts expected (6 once the init line lands). */
    total: number;
    error?: string;
}

type Action =
    | { type: "start" }
    | { type: "init"; total: number }
    | { type: "part"; name: RaceReplayPart; data: unknown }
    | { type: "done" }
    | { type: "error"; message: string };

const initial: {
    laps: Lap[];
    positions: Position[];
    stints: Stint[];
    weather: Weather[];
    intervals: Interval[];
    raceControl: RaceControlMessage[];
} = {
    laps: [],
    positions: [],
    stints: [],
    weather: [],
    intervals: [],
    raceControl: [],
};

interface InternalState {
    status: RaceReplayStreamStatus;
    parts: typeof initial;
    loaded: number;
    total: number;
    error?: string;
}

const initialState: InternalState = {
    status: "idle",
    parts: initial,
    loaded: 0,
    total: 0,
};

function reducer(state: InternalState, action: Action): InternalState {
    switch (action.type) {
        case "start":
            return { ...initialState, status: "loading" };
        case "init":
            return { ...state, status: "loading", total: action.total };
        case "part":
            return {
                ...state,
                parts: { ...state.parts, [action.name]: action.data },
                loaded: state.loaded + 1,
            };
        case "done":
            return { ...state, status: "done" };
        case "error":
            return { ...state, status: "error", error: action.message };
        default:
            return state;
    }
}

/**
 * Streams `/api/sessions/{key}/race_replay_data/stream` and exposes incremental
 * progress so callers can render a real progress bar. The full `data` object
 * is only returned once every part has arrived.
 */
export function useRaceReplayStream(
    sessionKey: number | null,
    apiBase: string = "/api",
): RaceReplayStreamState {
    const [state, dispatch] = useReducer(reducer, initialState);
    const abortRef = useRef<AbortController | null>(null);

    useEffect(() => {
        if (!sessionKey) return;
        abortRef.current?.abort();
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        dispatch({ type: "start" });

        type Msg = {
            type: string;
            total?: number;
            name?: RaceReplayPart;
            data?: unknown;
        };

        (async () => {
            try {
                await consumeNdjson<Msg>(
                    `${apiBase}/sessions/${sessionKey}/race_replay_data/stream`,
                    (m) => {
                        switch (m.type) {
                            case "init":
                                dispatch({
                                    type: "init",
                                    total: m.total ?? 0,
                                });
                                break;
                            case "part":
                                if (m.name) {
                                    dispatch({
                                        type: "part",
                                        name: m.name,
                                        data: m.data ?? [],
                                    });
                                }
                                break;
                            case "done":
                                dispatch({ type: "done" });
                                break;
                        }
                    },
                    ctrl.signal,
                );
                dispatch({ type: "done" });
            } catch (err) {
                if ((err as { name?: string })?.name === "AbortError") return;
                dispatch({
                    type: "error",
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        })();

        return () => ctrl.abort();
    }, [sessionKey, apiBase]);

    const data: FullRaceData | null = useMemo(
        () =>
            state.status === "done"
                ? {
                      type: "full_race_data",
                      ...state.parts,
                  }
                : null,
        [state.status, state.parts],
    );

    return {
        status: state.status,
        data,
        loaded: state.loaded,
        total: state.total,
        error: state.error,
    };
}
