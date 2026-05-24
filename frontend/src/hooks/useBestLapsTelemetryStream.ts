import { useEffect, useReducer, useRef } from "react";
import type { QualCarData } from "../lib/api";
import { consumeNdjson } from "../lib/ndjson";

export type BestLapsTelemetryStatus = "idle" | "loading" | "done" | "error";

export interface BestLapsTelemetryState {
    status: BestLapsTelemetryStatus;
    /** driver_number → telemetry points; populated incrementally. */
    carDataMap: Map<number, QualCarData[]>;
    loaded: number;
    total: number;
    error?: string;
}

type Action =
    | { type: "start" }
    | { type: "init"; drivers: number[]; total: number }
    | { type: "result"; driverNumber: number; data: QualCarData[] }
    | { type: "done" }
    | { type: "error"; message: string };

const initialState: BestLapsTelemetryState = {
    status: "idle",
    carDataMap: new Map(),
    loaded: 0,
    total: 0,
};

function reducer(
    state: BestLapsTelemetryState,
    action: Action,
): BestLapsTelemetryState {
    switch (action.type) {
        case "start":
            return {
                status: "loading",
                carDataMap: new Map(),
                loaded: 0,
                total: 0,
            };
        case "init":
            return { ...state, status: "loading", total: action.total };
        case "result": {
            // Replace the Map so React detects the state change.
            const next = new Map(state.carDataMap);
            if (action.data.length) next.set(action.driverNumber, action.data);
            return { ...state, carDataMap: next, loaded: state.loaded + 1 };
        }
        case "done":
            return { ...state, status: "done" };
        case "error":
            return { ...state, status: "error", error: action.message };
        default:
            return state;
    }
}

interface UseBestLapsTelemetryStreamArgs {
    sessionKey: number | null;
    /** When falsy the hook stays idle (e.g. no drivers loaded yet). */
    enabled: boolean;
    /** Q segment start (ISO) — passed through as date_after. */
    dateAfter?: string | null;
    /** Q segment end (ISO) — passed through as date_before. */
    dateBefore?: string | null;
    apiBase?: string;
}

/**
 * Streams `/api/sessions/{key}/car_data/best_laps/stream` and exposes
 * incremental per-driver telemetry plus a `loaded / total` progress counter.
 */
export function useBestLapsTelemetryStream({
    sessionKey,
    enabled,
    dateAfter,
    dateBefore,
    apiBase = "/api",
}: UseBestLapsTelemetryStreamArgs): BestLapsTelemetryState {
    const [state, dispatch] = useReducer(reducer, initialState);
    const abortRef = useRef<AbortController | null>(null);

    useEffect(() => {
        if (!sessionKey || !enabled) return;
        abortRef.current?.abort();
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        dispatch({ type: "start" });

        const params = new URLSearchParams();
        if (dateAfter) params.set("date_after", dateAfter);
        if (dateBefore) params.set("date_before", dateBefore);
        const qs = params.toString() ? `?${params}` : "";

        type Msg = {
            type: string;
            drivers?: number[];
            total?: number;
            driver_number?: number;
            data?: QualCarData[];
        };

        (async () => {
            try {
                await consumeNdjson<Msg>(
                    `${apiBase}/sessions/${sessionKey}/car_data/best_laps/stream${qs}`,
                    (m) => {
                        switch (m.type) {
                            case "init":
                                dispatch({
                                    type: "init",
                                    drivers: m.drivers ?? [],
                                    total: m.total ?? 0,
                                });
                                break;
                            case "result":
                                if (typeof m.driver_number === "number") {
                                    dispatch({
                                        type: "result",
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
    }, [sessionKey, enabled, dateAfter, dateBefore, apiBase]);

    return state;
}
