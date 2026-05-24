// QualifyingAnalysis.tsx
import { useState, useEffect, useMemo, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { useApi } from "../hooks/useApi";
import { useBestLapsTelemetryStream } from "../hooks/useBestLapsTelemetryStream";
import type { Driver, Session } from "../types";
import type { QSession, QualLap, QualStint, QualCarData } from "../lib/api";
import QualifyingTable from "../components/charts/QualifyingTable";
import MiniSectorMap from "../components/charts/MiniSectorMap";
import SpeedChart from "../components/charts/SpeedChart";
import EngineChart from "../components/charts/EngineChart";
import PedalChart from "../components/charts/PedalChart";
import ErrorBoundary from "../components/ErrorBoundary";
import LoadingProgressBar from "../components/shared/LoadingProgressBar";

// One entry per race weekend — a single qualifying session_key covers all
// three Q segments (we split them via race_control "Started" events, not
// by matching separate session rows).
interface RaceGroup {
    raceKey: string;
    label: string;
    session: Session;
}

// Boundaries returned by /api/sessions/{key}/qualifying_segments
// Each segment's `end` is null for Q3 (no upper bound).
type QSegmentBounds = { start: string; end: string | null };
type QSegments = Partial<Record<QSession, QSegmentBounds>>;

function Card({
    title,
    children,
    className = "",
}: {
    title: string;
    children: React.ReactNode;
    className?: string;
}) {
    return (
        <div
            className={`bg-f1-card rounded-xl border border-f1-border p-4 ${className}`}
        >
            <h3 className="text-sm font-semibold text-f1-muted uppercase tracking-wide mb-4">
                {title}
            </h3>
            {children}
        </div>
    );
}

const AVAILABLE_YEARS = [2025, 2024, 2023];

export default function QualifyingAnalysis() {
    const [searchParams, setSearchParams] = useSearchParams();
    const year = Number(searchParams.get("year")) || AVAILABLE_YEARS[0];
    const setYear = useCallback(
        (y: number) => {
            setSearchParams(
                (prev) => {
                    const next = new URLSearchParams(prev);
                    next.set("year", String(y));
                    next.delete("session");
                    next.delete("circuit");
                    return next;
                },
                { replace: true },
            );
        },
        [setSearchParams],
    );

    const [selectedRaceKey, setSelectedRaceKey] = useState<string | null>(null);
    const [qSession, setQSession] = useState<QSession>("Q3");
    const [focusDrivers, setFocusDrivers] = useState<number[]>([]);

    // Q1/Q2/Q3 time boundaries from race_control "Started" events
    const [qualSegments, setQualSegments] = useState<QSegments>({});
    const [segmentsLoading, setSegmentsLoading] = useState(false);

    // ── All qualifying sessions for the year ──────────────────────────────
    const {
        data: qualSessions,
        loading: sessionsLoading,
        error: sessionsError,
    } = useApi<Session[]>(() => api.getSessions(year, "Qualifying"), [year]);

    // ── Race groups: ONE qualifying session per race weekend ──────────────
    //
    // Previously the code tried to find separate "Q1"/"Q2"/"Q3" session rows
    // and map them by name.  That approach breaks because:
    //   a) Older seasons / sprint weekends return one combined "Qualifying" row.
    //   b) Even when separate rows exist, laps and car_data are sometimes only
    //      stored under the parent session_key.
    //
    // New approach: find one session per weekend, then use race_control
    // "Started" messages to determine Q1/Q2/Q3 boundaries.
    const raceGroups = useMemo<RaceGroup[]>(() => {
        if (!qualSessions?.length) return [];

        const buckets = new Map<string, RaceGroup>();

        qualSessions.forEach((s) => {
            const raceKey = `${s.year}|${s.circuit_short_name}|${s.country_name}`;
            const existing = buckets.get(raceKey);

            // Keep the "Qualifying" session over "Sprint Qualifying"; on ties
            // keep the later (higher) session_key which is more complete.
            const preferThis =
                !existing ||
                (s.session_name.toLowerCase() === "qualifying" &&
                    existing.session.session_name.toLowerCase() !==
                        "qualifying") ||
                (s.session_name.toLowerCase() ===
                    existing.session.session_name.toLowerCase() &&
                    s.session_key > existing.session.session_key);

            if (preferThis) {
                buckets.set(raceKey, {
                    raceKey,
                    label: `${s.circuit_short_name} — ${s.country_name}`,
                    session: s,
                });
            }
        });

        return [...buckets.values()].sort((a, b) =>
            a.session.date_start.localeCompare(b.session.date_start),
        );
    }, [qualSessions]);

    // Auto-select: prefer circuit from URL params (cross-page sync), fall back to latest past race
    const circuitParam = searchParams.get("circuit");
    useEffect(() => {
        if (!raceGroups.length) return;
        // Try to match the circuit carried from another page
        if (circuitParam) {
            const match = raceGroups.find(
                (g) => g.session.circuit_short_name === circuitParam,
            );
            if (match) {
                setSelectedRaceKey(match.raceKey);
                setFocusDrivers([]);
                return;
            }
        }
        // Fall back to latest past race weekend
        const today = new Date().toISOString();
        const past = raceGroups.filter((g) => g.session.date_start <= today);
        const target = past.length ? past[past.length - 1] : raceGroups[0];
        setSelectedRaceKey(target.raceKey);
        setFocusDrivers([]);
    }, [raceGroups, circuitParam]);

    const currentRaceGroup =
        raceGroups.find((g) => g.raceKey === selectedRaceKey) ?? null;
    const selectedSession = currentRaceGroup?.session ?? null;
    const selectedSessionKey = selectedSession?.session_key ?? null;

    // ── Fetch Q segment boundaries whenever the session changes ───────────
    useEffect(() => {
        let cancelled = false;
        setQualSegments({});
        if (!selectedSessionKey) return;

        setSegmentsLoading(true);
        fetch(`/api/sessions/${selectedSessionKey}/qualifying_segments`)
            .then((r) => r.json())
            .then((data: QSegments) => {
                if (cancelled) return;
                setQualSegments(data ?? {});
                setSegmentsLoading(false);
            })
            .catch(() => {
                if (cancelled) return;
                // If the endpoint fails we still render — just without segment filtering.
                setQualSegments({});
                setSegmentsLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [selectedSessionKey]);

    const hasSegments = Object.keys(qualSegments).length > 0;

    // Effective Q session: the one the user asked for if it has data, otherwise
    // fall back to the highest available segment.
    const effectiveQSession = useMemo<QSession>(() => {
        if (!hasSegments) return qSession; // segments not yet loaded — stay on requested
        if (qualSegments[qSession]) return qSession;
        return (
            (["Q3", "Q2", "Q1"] as QSession[]).find((q) => qualSegments[q]) ??
            qSession
        );
    }, [qualSegments, qSession, hasSegments]);

    // Convenience: start/end ISO strings for the active segment (null when unknown)
    const currentSegment: QSegmentBounds | null =
        qualSegments[effectiveQSession] ?? null;
    const segStart = currentSegment?.start ?? null;
    const segEnd = currentSegment?.end ?? null;

    // ── Per-session data ──────────────────────────────────────────────────
    const { data: drivers } = useApi<Driver[]>(
        () =>
            selectedSessionKey
                ? api.getDrivers(selectedSessionKey)
                : Promise.resolve([]),
        [selectedSessionKey],
    );

    // Fetch ALL laps for the session — we filter client-side so switching
    // Q tabs is instant without an extra network round-trip.
    const {
        data: allLaps,
        loading: lapsLoading,
        error: lapsError,
    } = useApi<QualLap[]>(
        () =>
            selectedSessionKey
                ? api.getQualifyingLaps(selectedSessionKey)
                : Promise.resolve([]),
        [selectedSessionKey],
    );

    const { data: stints } = useApi<QualStint[]>(
        () =>
            selectedSessionKey
                ? api.getQualifyingStints(selectedSessionKey)
                : Promise.resolve([]),
        [selectedSessionKey],
    );

    // ── Filter laps to the active Q segment ──────────────────────────────
    const laps = useMemo<QualLap[]>(() => {
        if (!allLaps?.length) return [];
        if (!segStart) return allLaps; // no segment info → show everything

        const segLaps = allLaps.filter((l) => {
            const d = (l as QualLap & { date_start?: string }).date_start ?? "";
            if (!d) return false;
            return d >= segStart && (!segEnd || d < segEnd);
        });

        // Enforce F1 qualifying structure: Q3 has max 10 drivers, Q2 has 15.
        // This prevents boundary imprecision from leaking Q2 drivers into Q3.
        const maxDrivers: Record<QSession, number> = { Q1: 99, Q2: 15, Q3: 10 };
        const cap = maxDrivers[effectiveQSession];

        // Find top N drivers by best lap time within the segment
        const bestByDriver = new Map<number, number>();
        for (const lap of segLaps) {
            if (!lap.lap_duration || lap.is_pit_out_lap) continue;
            const prev = bestByDriver.get(lap.driver_number);
            if (prev === undefined || lap.lap_duration < prev) {
                bestByDriver.set(lap.driver_number, lap.lap_duration);
            }
        }

        if (bestByDriver.size <= cap) return segLaps;

        // Keep only laps from the top N drivers
        const topDrivers = new Set(
            [...bestByDriver.entries()]
                .sort((a, b) => a[1] - b[1])
                .slice(0, cap)
                .map(([dn]) => dn),
        );
        return segLaps.filter((l) => topDrivers.has(l.driver_number));
    }, [allLaps, segStart, segEnd, effectiveQSession]);

    // ── Car telemetry scoped to the active Q segment ──────────────────────
    const uniqueDrivers = useMemo(
        () =>
            (drivers ?? []).filter(
                (d, i, arr) =>
                    arr.findIndex(
                        (x) => x.driver_number === d.driver_number,
                    ) === i,
            ),
        [drivers],
    );

    // Stream telemetry incrementally so we can show real load progress.
    // segStart/segEnd change whenever effectiveQSession changes, so this
    // naturally re-streams on Q tab switch.
    const telemetry = useBestLapsTelemetryStream({
        sessionKey: selectedSessionKey,
        enabled: !!uniqueDrivers.length,
        dateAfter: segStart,
        dateBefore: segEnd,
    });
    const carDataMap = telemetry.carDataMap;
    const carDataLoading =
        telemetry.status === "idle" || telemetry.status === "loading";
    const carDataError =
        telemetry.status === "error"
            ? (telemetry.error ?? "Failed to load telemetry.")
            : telemetry.status === "done" && carDataMap.size === 0
              ? "No telemetry returned for any driver."
              : null;

    // Filter carDataMap to only include drivers present in the filtered laps.
    // This prevents telemetry from Q2-eliminated drivers leaking into the
    // MiniSectorMap / SpeedChart when segment boundaries are slightly imprecise.
    const filteredCarDataMap = useMemo(() => {
        if (!carDataMap.size || !laps.length) return carDataMap;
        const validDrivers = new Set(
            laps
                .filter((l) => l.lap_duration && !l.is_pit_out_lap)
                .map((l) => l.driver_number),
        );
        const filtered = new Map<number, QualCarData[]>();
        for (const [dn, pts] of carDataMap) {
            if (validDrivers.has(dn)) filtered.set(dn, pts);
        }
        return filtered;
    }, [carDataMap, laps]);

    // Adapter so telemetry charts (which use Set<number>) can share the
    // page-level focusDrivers selection with QualifyingTable & MiniSectorMap.
    const focusedDriversSet = useMemo(
        () => new Set(focusDrivers),
        [focusDrivers],
    );
    const handleFocusedDriversSet = useCallback(
        (next: Set<number>) => setFocusDrivers([...next]),
        [],
    );

    // focusDriverInfo removed — multi-driver focus handled in child components
    const cardTitle = hasSegments
        ? `${effectiveQSession} Results — ${currentRaceGroup?.label.split(" —")[0] ?? ""}`
        : `Qualifying Results — ${currentRaceGroup?.label.split(" —")[0] ?? ""}`;

    return (
        <div className="space-y-6">
            {/* ── Controls ── */}
            <div className="flex flex-wrap items-center gap-4">
                <h1 className="text-2xl font-bold">Qualifying Analysis</h1>

                {/* Year picker */}
                <select
                    value={year}
                    onChange={(e) => {
                        setYear(Number(e.target.value));
                        setSelectedRaceKey(null);
                        setFocusDrivers([]);
                    }}
                    className="bg-f1-card border border-f1-border rounded-lg px-3 py-2 text-sm"
                >
                    {AVAILABLE_YEARS.map((y) => (
                        <option key={y} value={y}>
                            {y}
                        </option>
                    ))}
                </select>

                {/* Race weekend picker */}
                <select
                    value={selectedRaceKey ?? ""}
                    onChange={(e) => {
                        const key = e.target.value || null;
                        setSelectedRaceKey(key);
                        setFocusDrivers([]);
                        // Sync circuit to URL for cross-page navigation
                        const group = raceGroups.find((g) => g.raceKey === key);
                        setSearchParams(
                            (prev) => {
                                const next = new URLSearchParams(prev);
                                if (group) {
                                    next.set(
                                        "circuit",
                                        group.session.circuit_short_name,
                                    );
                                } else {
                                    next.delete("circuit");
                                }
                                next.delete("session");
                                return next;
                            },
                            { replace: true },
                        );
                    }}
                    className="bg-f1-card border border-f1-border rounded-lg px-3 py-2 text-sm min-w-[220px]"
                    disabled={!raceGroups.length}
                >
                    <option value="">Select Race Weekend…</option>
                    {raceGroups.map((g) => (
                        <option key={g.raceKey} value={g.raceKey}>
                            {g.label}
                        </option>
                    ))}
                </select>

                {selectedSession && (
                    <span className="text-f1-muted text-sm">
                        {new Date(
                            selectedSession.date_start,
                        ).toLocaleDateString(undefined, {
                            year: "numeric",
                            month: "long",
                            day: "numeric",
                        })}
                    </span>
                )}

                {/* Q1 / Q2 / Q3 tabs
                    • Disabled while segments are loading.
                    • A segment tab is disabled when segments loaded but that
                      segment wasn't found (e.g. Q3 absent on sprint weekends).
                    • When no segment info is available at all (race_control
                      returned nothing), all three are enabled and act as a
                      visual-only label — laps are shown unfiltered. */}
                <div className="flex gap-1 ml-auto">
                    {(["Q1", "Q2", "Q3"] as QSession[]).map((q) => {
                        const available =
                            segmentsLoading ||
                            !hasSegments ||
                            !!qualSegments[q];
                        const active =
                            effectiveQSession === q && !segmentsLoading;
                        return (
                            <button
                                key={q}
                                onClick={() => {
                                    setQSession(q);
                                    setFocusDrivers([]);
                                }}
                                disabled={!available}
                                className={`px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors
                                    disabled:opacity-30 disabled:cursor-not-allowed
                                    ${
                                        active
                                            ? "bg-white text-black"
                                            : "bg-f1-card border border-f1-border text-f1-muted hover:text-white"
                                    }`}
                            >
                                {q}
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* ── Status messages ── */}
            {sessionsLoading && (
                <p className="text-f1-muted text-sm">Loading sessions…</p>
            )}
            {sessionsError && (
                <p className="text-red-400 text-sm">
                    Failed to load sessions: {String(sessionsError)}
                </p>
            )}
            {!sessionsLoading &&
                !sessionsError &&
                qualSessions?.length === 0 && (
                    <p className="text-yellow-400 text-sm">
                        No qualifying sessions found for {year}. Try a different
                        year.
                    </p>
                )}

            {/* Driver focus badges */}
            {focusDrivers.length > 0 && (
                <div className="flex items-center gap-2 text-sm flex-wrap">
                    <span className="text-f1-muted">Comparing:</span>
                    {(() => {
                        // Detect teammates: same team_colour among focused drivers
                        const colorToNums = new Map<string, number[]>();
                        for (const num of focusDrivers) {
                            const d = uniqueDrivers.find(
                                (dr) => dr.driver_number === num,
                            );
                            const col = (
                                d?.team_colour ?? "888888"
                            ).toLowerCase();
                            const arr = colorToNums.get(col) ?? [];
                            arr.push(num);
                            colorToNums.set(col, arr);
                        }
                        // Secondary driver (fewer wins is not computable here, so use
                        // higher driver number as tie-break) gets the pinstripe badge
                        const pinstripeSet = new Set<number>();
                        colorToNums.forEach((nums) => {
                            if (nums.length > 1) {
                                [...nums]
                                    .sort((a, b) => b - a)
                                    .slice(0, nums.length - 1)
                                    .forEach((n) => pinstripeSet.add(n));
                            }
                        });
                        return focusDrivers.map((num) => {
                            const info = uniqueDrivers.find(
                                (d) => d.driver_number === num,
                            );
                            const baseColor = `#${info?.team_colour ?? "fff"}`;
                            const isStripe = pinstripeSet.has(num);
                            const displayColor = isStripe
                                ? (() => {
                                      // HSL-based variant: same hue, nudge lightness + saturation
                                      const h = baseColor.replace("#", "");
                                      const r =
                                          parseInt(h.slice(0, 2), 16) / 255;
                                      const g =
                                          parseInt(h.slice(2, 4), 16) / 255;
                                      const b =
                                          parseInt(h.slice(4, 6), 16) / 255;
                                      const max = Math.max(r, g, b),
                                          min = Math.min(r, g, b);
                                      const l = (max + min) / 2;
                                      const d2 = max - min;
                                      const s =
                                          max === min
                                              ? 0
                                              : l > 0.5
                                                ? d2 / (2 - max - min)
                                                : d2 / (max + min);
                                      let hue = 0;
                                      if (max !== min) {
                                          if (max === r)
                                              hue =
                                                  ((g - b) / d2 +
                                                      (g < b ? 6 : 0)) /
                                                  6;
                                          else if (max === g)
                                              hue = ((b - r) / d2 + 2) / 6;
                                          else hue = ((r - g) / d2 + 4) / 6;
                                      }
                                      const lit = l * 100;
                                      const isDark = lit < 45;
                                      const newL = isDark
                                          ? Math.min(lit + 32, 92)
                                          : Math.max(lit - 28, 12);
                                      const newS = Math.min(
                                          s * 100 + (isDark ? 18 : 15),
                                          100,
                                      );
                                      return `hsl(${(hue * 360).toFixed(1)},${newS.toFixed(1)}%,${newL.toFixed(1)}%)`;
                                  })()
                                : baseColor;
                            return (
                                <span
                                    key={num}
                                    className="inline-flex items-center gap-1 font-bold"
                                    style={{ color: displayColor }}
                                >
                                    #{num} {info?.name_acronym}
                                </span>
                            );
                        });
                    })()}
                    <button
                        onClick={() => setFocusDrivers([])}
                        className="text-f1-muted hover:text-white transition-colors text-xs border border-f1-border rounded px-2 py-0.5"
                    >
                        Clear
                    </button>
                </div>
            )}

            {/* ── Main content ── */}
            {selectedSessionKey && (
                <div className="space-y-6">
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                        <Card title={cardTitle}>
                            {lapsLoading || segmentsLoading ? (
                                <p className="text-f1-muted text-sm">
                                    Loading laps…
                                </p>
                            ) : lapsError ? (
                                <p className="text-red-400 text-sm">
                                    Failed to load laps: {String(lapsError)}
                                </p>
                            ) : (
                                <ErrorBoundary label="Qualifying table">
                                    <QualifyingTable
                                        drivers={uniqueDrivers}
                                        laps={laps}
                                        stints={stints ?? []}
                                        qSession={effectiveQSession}
                                        focusDrivers={focusDrivers}
                                        onFocusDrivers={setFocusDrivers}
                                    />
                                </ErrorBoundary>
                            )}
                        </Card>

                        <Card title="Mini-Sector Fastest">
                            {carDataLoading ? (
                                <LoadingProgressBar
                                    label="Loading telemetry"
                                    loaded={telemetry.loaded}
                                    total={telemetry.total}
                                />
                            ) : carDataError ? (
                                <p className="text-f1-muted text-sm">
                                    {carDataError}
                                </p>
                            ) : (
                                <ErrorBoundary label="Mini-sector map">
                                    <MiniSectorMap
                                        drivers={uniqueDrivers}
                                        laps={laps}
                                        carDataMap={filteredCarDataMap}
                                        sessionKey={selectedSessionKey!}
                                        focusDrivers={focusDrivers}
                                        onFocusDrivers={setFocusDrivers}
                                    />
                                </ErrorBoundary>
                            )}
                        </Card>
                    </div>

                    <Card title="Speed vs Distance — Best Laps">
                        {carDataLoading ? (
                            <LoadingProgressBar
                                label="Loading telemetry"
                                loaded={telemetry.loaded}
                                total={telemetry.total}
                            />
                        ) : carDataError ? (
                            <p className="text-f1-muted text-sm">
                                {carDataError}
                            </p>
                        ) : (
                            <ErrorBoundary label="Speed chart">
                                <SpeedChart
                                    drivers={uniqueDrivers}
                                    laps={laps}
                                    carDataMap={filteredCarDataMap}
                                    focusedDrivers={focusedDriversSet}
                                    onFocusedDriversChange={
                                        handleFocusedDriversSet
                                    }
                                />
                            </ErrorBoundary>
                        )}
                    </Card>
                    <Card title="Engine — RPM (line) + Gear (stepped)">
                        {carDataLoading ? (
                            <LoadingProgressBar
                                label="Loading telemetry"
                                loaded={telemetry.loaded}
                                total={telemetry.total}
                            />
                        ) : carDataError ? (
                            <p className="text-f1-muted text-sm">
                                {carDataError}
                            </p>
                        ) : (
                            <ErrorBoundary label="Engine chart">
                                <EngineChart
                                    drivers={uniqueDrivers}
                                    laps={laps}
                                    carDataMap={filteredCarDataMap}
                                    focusedDrivers={focusedDriversSet}
                                    onFocusedDriversChange={
                                        handleFocusedDriversSet
                                    }
                                />
                            </ErrorBoundary>
                        )}
                    </Card>
                    <Card title="Pedal Trace — Throttle / Brake">
                        {carDataLoading ? (
                            <LoadingProgressBar
                                label="Loading telemetry"
                                loaded={telemetry.loaded}
                                total={telemetry.total}
                            />
                        ) : carDataError ? (
                            <p className="text-f1-muted text-sm">
                                {carDataError}
                            </p>
                        ) : (
                            <ErrorBoundary label="Pedal chart">
                                <PedalChart
                                    drivers={uniqueDrivers}
                                    laps={laps}
                                    carDataMap={filteredCarDataMap}
                                    focusedDrivers={focusedDriversSet}
                                    onFocusedDriversChange={
                                        handleFocusedDriversSet
                                    }
                                />
                            </ErrorBoundary>
                        )}
                    </Card>
                </div>
            )}
        </div>
    );
}
