import { useEffect, useReducer, useRef } from "react";
import { consumeNdjson } from "../lib/ndjson";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StreamSession {
    session_key: number;
    session_name?: string;
    session_type: string; // "Race" | "Sprint"
    country_name: string;
    circuit_short_name: string;
    date_start: string;
    year: number;
}

export interface StreamRaceResult {
    driver_number: number;
    position: number;
    classified_position?: string | number;
    dnf?: boolean;
    dns?: boolean;
    dsq?: boolean;
    full_name?: string;
    name_acronym?: string;
    broadcast_name?: string;
    team_name?: string;
    team_colour?: string;
}

export type SeasonResultsStreamStatus = "idle" | "loading" | "done" | "error";

export interface SeasonResultsStreamState {
    status: SeasonResultsStreamStatus;
    sessions: StreamSession[];
    results: Record<string, StreamRaceResult[]>;
    /** Number of session results received so far (≤ total). */
    loaded: number;
    /** Total session count (0 until first stream event arrives). */
    total: number;
    error?: string;
}

// ── Reducer ───────────────────────────────────────────────────────────────────

type Action =
    | { type: "start" }
    | { type: "sessions"; sessions: StreamSession[]; total: number }
    | { type: "result"; sessionKey: number; data: StreamRaceResult[] }
    | { type: "done" }
    | { type: "error"; message: string };

const initialState: SeasonResultsStreamState = {
    status: "idle",
    sessions: [],
    results: {},
    loaded: 0,
    total: 0,
};

function reducer(
    state: SeasonResultsStreamState,
    action: Action,
): SeasonResultsStreamState {
    switch (action.type) {
        case "start":
            return { ...initialState, status: "loading" };
        case "sessions":
            return {
                ...state,
                status: "loading",
                sessions: action.sessions,
                total: action.total,
            };
        case "result":
            return {
                ...state,
                results: {
                    ...state.results,
                    [String(action.sessionKey)]: action.data,
                },
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

// ── Hook ──────────────────────────────────────────────────────────────────────

/**
 * Streams season results from the backend NDJSON endpoint and exposes incremental
 * progress (`loaded` / `total`) so callers can render a real progress bar.
 */
export function useSeasonResultsStream(
    year: number | undefined,
    apiBase: string = "/api",
): SeasonResultsStreamState {
    const [state, dispatch] = useReducer(reducer, initialState);
    const abortRef = useRef<AbortController | null>(null);

    useEffect(() => {
        if (!year) return;
        abortRef.current?.abort();
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        dispatch({ type: "start" });

        type Msg = {
            type: string;
            sessions?: StreamSession[];
            total?: number;
            session_key?: number;
            data?: StreamRaceResult[];
        };

        (async () => {
            try {
                await consumeNdjson<Msg>(
                    `${apiBase}/season/${year}/results/stream`,
                    (m) => {
                        switch (m.type) {
                            case "sessions":
                                dispatch({
                                    type: "sessions",
                                    sessions: m.sessions ?? [],
                                    total: m.total ?? 0,
                                });
                                break;
                            case "result":
                                if (typeof m.session_key === "number") {
                                    dispatch({
                                        type: "result",
                                        sessionKey: m.session_key,
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
                // Safety: if backend never emitted "done", still mark complete.
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
    }, [year, apiBase]);

    return state;
}
