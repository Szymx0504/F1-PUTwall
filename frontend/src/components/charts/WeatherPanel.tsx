import { useMemo } from "react";
import { Thermometer, Droplets, Wind, CloudRain } from "lucide-react";
import {
    Line,
    XAxis,
    YAxis,
    Tooltip,
    ResponsiveContainer,
    Area,
    ComposedChart,
} from "recharts";
import type { Weather } from "../../types";

interface Props {
    weather: Weather | null;
    allWeather: Weather[];
    currentLap: number;
    maxLap: number;
}

// Custom tooltip for the weather chart
interface WeatherTooltipEntry {
    dataKey: string;
    name?: string;
    value?: number;
    color?: string;
    payload: { idx: number };
}

function WeatherTooltip({
    active,
    payload,
}: {
    active?: boolean;
    payload?: WeatherTooltipEntry[];
}) {
    if (!active || !payload?.length) return null;
    const data = payload[0].payload;
    return (
        <div className="bg-[#111214] border border-[#2d2f33] rounded-lg px-3 py-2 text-xs">
            <p className="text-f1-muted mb-1">Sample {data.idx}</p>
            {payload.map((entry) => (
                <p key={entry.dataKey} style={{ color: entry.color }}>
                    {entry.name}: {entry.value?.toFixed(1)}
                    {entry.dataKey === "humidity"
                        ? "%"
                        : entry.dataKey === "rainfall"
                          ? " mm"
                          : "°C"}
                </p>
            ))}
        </div>
    );
}

export default function WeatherPanel({
    weather,
    allWeather,
    currentLap,
    maxLap,
}: Props) {
    // Progressive data: only show up to the current lap proportion
    const tempData = useMemo(() => {
        if (!allWeather.length || !maxLap)
            return allWeather.map((w, i) => ({
                idx: i + 1,
                air: w.air_temperature,
                track: w.track_temperature,
                humidity: w.humidity,
                rainfall: w.rainfall ?? 0,
            }));

        const progress = currentLap / maxLap;
        const sliceEnd = Math.max(1, Math.ceil(allWeather.length * progress));
        return allWeather.slice(0, sliceEnd).map((w, i) => ({
            idx: i + 1,
            air: w.air_temperature,
            track: w.track_temperature,
            humidity: w.humidity,
            rainfall: w.rainfall ?? 0,
        }));
    }, [allWeather, currentLap, maxLap]);

    return (
        <div className="bg-f1-card rounded-xl border border-f1-border p-4">
            <h3 className="text-sm font-semibold mb-3 text-f1-muted uppercase tracking-wide">
                Weather Conditions
            </h3>

            {weather ? (
                <>
                    {/* Current stats */}
                    <div className="grid grid-cols-2 gap-3 mb-4">
                        <div className="flex items-center gap-2">
                            <Thermometer size={16} className="text-f1-accent" />
                            <div>
                                <p className="text-xs text-f1-muted">
                                    Air Temp
                                </p>
                                <p className="text-sm font-semibold">
                                    {weather.air_temperature}°C
                                </p>
                            </div>
                        </div>
                        <div className="flex items-center gap-2">
                            <Thermometer size={16} className="text-f1-red" />
                            <div>
                                <p className="text-xs text-f1-muted">
                                    Track Temp
                                </p>
                                <p className="text-sm font-semibold">
                                    {weather.track_temperature}°C
                                </p>
                            </div>
                        </div>
                        <div className="flex items-center gap-2">
                            <Droplets size={16} className="text-f1-muted" />
                            <div>
                                <p className="text-xs text-f1-muted">
                                    Humidity
                                </p>
                                <p className="text-sm font-semibold">
                                    {weather.humidity}%
                                </p>
                            </div>
                        </div>
                        <div className="flex items-center gap-2">
                            <Wind size={16} className="text-f1-muted" />
                            <div>
                                <p className="text-xs text-f1-muted">Wind</p>
                                <p className="text-sm font-semibold">
                                    {weather.wind_speed} km/h
                                </p>
                            </div>
                        </div>
                        <div className="flex items-center gap-2">
                            <CloudRain size={16} className="text-f1-muted" />
                            <div>
                                <p className="text-xs text-f1-muted">
                                    Rainfall
                                </p>
                                <p className="text-sm font-semibold">
                                    {weather.rainfall
                                        ? `${weather.rainfall} mm`
                                        : "None"}
                                </p>
                            </div>
                        </div>
                    </div>

                    {/* Temperature + rainfall chart */}
                    {tempData.length > 1 && (
                        <ResponsiveContainer width="100%" height={140}>
                            <ComposedChart data={tempData}>
                                <XAxis dataKey="idx" hide />
                                <YAxis
                                    yAxisId="temp"
                                    stroke="#9ca3af"
                                    tick={{ fontSize: 10 }}
                                    width={30}
                                    domain={["auto", "auto"]}
                                />
                                <YAxis
                                    yAxisId="rain"
                                    orientation="right"
                                    stroke="#3b82f6"
                                    tick={{ fontSize: 10 }}
                                    width={30}
                                    domain={[0, "auto"]}
                                    hide={!tempData.some((d) => d.rainfall > 0)}
                                />
                                <Tooltip content={<WeatherTooltip />} />
                                <Line
                                    yAxisId="temp"
                                    type="monotone"
                                    dataKey="air"
                                    stroke="#fb923c"
                                    strokeWidth={1.5}
                                    dot={false}
                                    name="Air"
                                    isAnimationActive={false}
                                />
                                <Line
                                    yAxisId="temp"
                                    type="monotone"
                                    dataKey="track"
                                    stroke="#ef4444"
                                    strokeWidth={1.5}
                                    dot={false}
                                    name="Track"
                                    isAnimationActive={false}
                                />
                                <Area
                                    yAxisId="rain"
                                    type="stepAfter"
                                    dataKey="rainfall"
                                    stroke="#3b82f6"
                                    fill="#3b82f680"
                                    strokeWidth={1}
                                    name="Rainfall"
                                    isAnimationActive={false}
                                />
                            </ComposedChart>
                        </ResponsiveContainer>
                    )}
                </>
            ) : (
                <p className="text-f1-muted text-sm">
                    No weather data available
                </p>
            )}
        </div>
    );
}
