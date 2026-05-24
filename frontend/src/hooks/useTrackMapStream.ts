import { useEffect, useReducer, useRef } from "react";
import type { TrackMapData } from "../types";
import { consumeNdjson } from "../lib/ndjson";

export type TrackMapStreamStatus = "idle" | "loading" | "done" | "error";

export interface TrackMapStreamState {
    status: TrackMapStreamStatus;
    /** Fully populated only once `status === "done"`. */
    data: TrackMapData | null;
    loaded: number;
    total: number;
    error?: string;
}

type DriverPoint = { x: number; y: number; date: string };
type OutlinePoint = { x: number; y: number };

type Action =
    | { type: "start" }
    | { type: "init"; total: number }
    | { type: "outline"; outline: OutlinePoint[] }
    | { type: "driver"; driverNumber: number | string; data: DriverPoint[] }
    | { type: "done" }
    | { type: "error"; message: string };

interface InternalState {
    status: TrackMapStreamStatus;
    outline: OutlinePoint[];
    drivers: Record<string, DriverPoint[]>;
    loaded: number;
    total: number;
    error?: string;
}

const initialState: InternalState = {
    status: "idle",
    outline: [],
    drivers: {},
    loaded: 0,
    total: 0,
};

function reducer(state: InternalState, action: Action): InternalState {
    switch (action.type) {
        case "start":
            return { ...initialState, status: "loading" };
        case "init":
            return { ...state, status: "loading", total: action.total };
        case "outline":
            return {
                ...state,
                outline: action.outline,
                loaded: state.loaded + 1,
            };
        case "driver":
            return {
                ...state,
                drivers: {
                    ...state.drivers,
                    [String(action.driverNumber)]: action.data,
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

/**
 * Streams the track-map payload (outline + per-driver location samples) so
 * the canvas component can render a real progress bar while it loads.
 *
 * The combined `data` is exposed only once `status === "done"` to avoid
 * partial renders mid-stream.
 */
export function useTrackMapStream(
    sessionKey: number | null,
    apiBase: string = "/api",
): TrackMapStreamState {
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
            outline?: OutlinePoint[];
            driver_number?: number | string;
            data?: DriverPoint[];
        };

        (async () => {
            try {
                await consumeNdjson<Msg>(
                    `${apiBase}/sessions/${sessionKey}/track_map/stream`,
                    (m) => {
                        switch (m.type) {
                            case "init":
                                dispatch({
                                    type: "init",
                                    total: m.total ?? 0,
                                });
                                break;
                            case "outline":
                                dispatch({
                                    type: "outline",
                                    outline: m.outline ?? [],
                                });
                                break;
                            case "driver":
                                if (m.driver_number !== undefined) {
                                    dispatch({
                                        type: "driver",
                                        driverNumber: m.driver_number,
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

    const data: TrackMapData | null =
        state.status === "done"
            ? { outline: state.outline, drivers: state.drivers }
            : null;

    return {
        status: state.status,
        data,
        loaded: state.loaded,
        total: state.total,
        error: state.error,
    };
}
