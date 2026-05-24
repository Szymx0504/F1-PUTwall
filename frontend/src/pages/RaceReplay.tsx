import { useState, useEffect, useMemo, useCallback } from "react";
import { api } from "../lib/api";
import { useApi } from "../hooks/useApi";
import { useRaceSelector } from "../hooks/useRaceSelector";
import { useRaceReplayStream } from "../hooks/useRaceReplayStream";
import PositionChart from "../components/charts/PositionChart";
import LapTimesChart from "../components/charts/LapTimesChart";
import GapChart from "../components/charts/GapChart";
import TireStrategy from "../components/charts/TireStrategy";
import WeatherPanel from "../components/charts/WeatherPanel";
import RaceEventsFeed from "../components/charts/RaceEventsFeed";
import TrackMap from "../components/charts/TrackMap";
import ReplayControls from "../components/replay/ReplayControls";
import RaceSelector from "../components/shared/RaceSelector";
import LoadingProgressBar from "../components/shared/LoadingProgressBar";
import { deriveSafetyCarPeriods } from "../lib/safetyCar";

export default function RaceReplay() {
    const selector = useRaceSelector("Race");
    const { sessionKey } = selector;
    const selectedDriver: number | null = null;
    const [currentLap, setCurrentLap] = useState(1);
    const [isPlaying, setIsPlaying] = useState(false);
    const [speed, setSpeed] = useState(1);
    // Shared focused-driver selection across PositionChart, GapChart, LapTimesChart
    const [focusedDrivers, setFocusedDrivers] = useState<Set<number>>(
        new Set(),
    );

    // Reset focus whenever a new session is selected
    useEffect(() => {
        setFocusedDrivers(new Set());
    }, [sessionKey]);

    // Fetch drivers for selected session
    const { data: drivers } = useApi(
        () => (sessionKey ? api.getDrivers(sessionKey) : Promise.resolve([])),
        [sessionKey],
    );

    // Stream race replay data so we can render a real progress bar while it loads.
    const replay = useRaceReplayStream(sessionKey);
    const raceData = replay.data;
    const loadingData =
        !!sessionKey &&
        (replay.status === "idle" || replay.status === "loading");

    // Reset playback whenever a new race finishes streaming in.
    useEffect(() => {
        if (raceData) {
            setCurrentLap(1);
            setIsPlaying(false);
        }
    }, [raceData]);

    // Compute max lap
    const maxLap = useMemo(() => {
        if (!raceData) return 0;
        return Math.max(...raceData.laps.map((l) => l.lap_number ?? 0), 0);
    }, [raceData]);

    // Lap changes are driven by TrackMap animation via onLapChange callback
    const handleLapChange = useCallback((lap: number) => {
        setCurrentLap(lap);
    }, []);

    const handleFinish = useCallback(() => {
        setIsPlaying(false);
    }, []);

    // Filter data up to current lap for charts
    const currentWeather = useMemo(() => {
        if (!raceData?.weather.length) return null;
        return raceData.weather[
            Math.min(currentLap - 1, raceData.weather.length - 1)
        ];
    }, [raceData, currentLap]);

    // Safety car / VSC periods derived once from race control messages
    const safetyCarPeriods = useMemo(() => {
        if (!raceData) return [];
        return deriveSafetyCarPeriods(
            raceData.raceControl,
            raceData.laps,
            maxLap,
        );
    }, [raceData, maxLap]);

    // Unique driver list (deduplicated)
    const uniqueDrivers = useMemo(() => {
        if (!drivers) return [];
        const seen = new Set<number>();
        return drivers.filter((d) => {
            if (seen.has(d.driver_number)) return false;
            seen.add(d.driver_number);
            return true;
        });
    }, [drivers]);

    return (
        <div className="space-y-6">
            {/* Header controls */}
            <RaceSelector title="Race Replay" {...selector} />

            {/* Replay controls */}
            {raceData && (
                <ReplayControls
                    currentLap={currentLap}
                    maxLap={maxLap}
                    isPlaying={isPlaying}
                    speed={speed}
                    onPlayPause={() => setIsPlaying(!isPlaying)}
                    onLapChange={setCurrentLap}
                    onSpeedChange={setSpeed}
                    onReset={() => {
                        setCurrentLap(1);
                        setIsPlaying(false);
                    }}
                />
            )}

            {/* Charts grid */}
            {raceData ? (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    <PositionChart
                        laps={raceData.laps}
                        positions={raceData.positions}
                        drivers={uniqueDrivers}
                        highlightDriver={selectedDriver}
                        currentLap={currentLap}
                        maxLap={maxLap}
                        focusedDrivers={focusedDrivers}
                        onFocusedDriversChange={setFocusedDrivers}
                        safetyCarPeriods={safetyCarPeriods}
                    />
                    <RaceEventsFeed
                        laps={raceData.laps}
                        positions={raceData.positions}
                        stints={raceData.stints}
                        raceControl={raceData.raceControl}
                        weather={raceData.weather}
                        drivers={uniqueDrivers}
                        currentLap={currentLap}
                        maxLap={maxLap}
                        highlightDriver={selectedDriver}
                    />
                    <div className="lg:col-span-2">
                        <TrackMap
                            sessionKey={sessionKey!}
                            drivers={uniqueDrivers}
                            laps={raceData.laps}
                            positions={raceData.positions}
                            stints={raceData.stints}
                            intervals={raceData.intervals}
                            currentLap={currentLap}
                            maxLap={maxLap}
                            speed={speed}
                            isPlaying={isPlaying}
                            highlightDriver={selectedDriver}
                            safetyCarPeriods={safetyCarPeriods}
                            onLapChange={handleLapChange}
                            onFinish={handleFinish}
                        />
                    </div>
                    <GapChart
                        intervals={raceData.intervals}
                        laps={raceData.laps}
                        drivers={uniqueDrivers}
                        highlightDriver={selectedDriver}
                        currentLap={currentLap}
                        maxLap={maxLap}
                        focusedDrivers={focusedDrivers}
                        onFocusedDriversChange={setFocusedDrivers}
                        safetyCarPeriods={safetyCarPeriods}
                    />
                    <LapTimesChart
                        laps={raceData.laps}
                        drivers={uniqueDrivers}
                        highlightDriver={selectedDriver}
                        currentLap={currentLap}
                        maxLap={maxLap}
                        focusedDrivers={focusedDrivers}
                        onFocusedDriversChange={setFocusedDrivers}
                        safetyCarPeriods={safetyCarPeriods}
                    />
                    <TireStrategy
                        stints={raceData.stints}
                        drivers={uniqueDrivers}
                        laps={raceData.laps}
                        positions={raceData.positions}
                        maxLap={maxLap}
                        currentLap={currentLap}
                    />
                    <WeatherPanel
                        weather={currentWeather}
                        allWeather={raceData.weather}
                        currentLap={currentLap}
                        maxLap={maxLap}
                    />
                </div>
            ) : loadingData ? (
                <div className="bg-f1-card rounded-xl border border-f1-border p-6">
                    <LoadingProgressBar
                        label="Loading race data"
                        loaded={replay.loaded}
                        total={replay.total}
                    />
                    <p className="text-f1-muted text-xs mt-2">
                        Fetching laps, positions, tires, weather & intervals
                    </p>
                </div>
            ) : (
                <div className="text-center text-f1-muted py-20">
                    <p className="text-lg">
                        Select a year and race to begin replay
                    </p>
                </div>
            )}
        </div>
    );
}
