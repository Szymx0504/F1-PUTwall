// Shared tooltip payload types for recharts-based charts.
// Recharts' own TooltipProps has wide value/dataKey types; we mirror them
// just enough to satisfy structural compatibility while avoiding `any`.

export interface TooltipPayloadItem {
    value?: number | string | readonly (number | string)[];
    dataKey?: string | number | ((obj: unknown) => unknown);
    stroke?: string;
}

export interface ChartTooltipProps {
    active?: boolean;
    payload?: readonly TooltipPayloadItem[];
    label?: string | number;
    focusedAcronyms?: Set<string> | null;
    hasFocus?: boolean;
}

export function tooltipValueToNumber(
    v: TooltipPayloadItem["value"],
): number {
    if (typeof v === "number") return v;
    if (typeof v === "string") {
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
    }
    return 0;
}

export function tooltipDataKeyToString(
    key: TooltipPayloadItem["dataKey"],
): string {
    if (typeof key === "string") return key;
    if (typeof key === "number") return String(key);
    return "";
}
