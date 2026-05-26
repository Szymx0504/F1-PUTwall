/**
 * Shared team-colour helpers used across qualifying charts.
 *
 * Goal: keep all charts on the Qualifying page consistent with `MiniSectorMap`.
 * When two focused drivers share a team colour, the secondary teammate is
 * rendered with a perceptually distinct but team-authentic variant of the
 * same hue (lighter for dark base colours, darker for light base colours).
 */

/** Convert hex (#rrggbb or rrggbb) to HSL components h:0–360, s/l:0–100. */
export function hexToHsl(hex: string): [number, number, number] {
    const h = hex.replace("#", "");
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b),
        min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l * 100];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let hue = 0;
    if (max === r) hue = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) hue = ((b - r) / d + 2) / 6;
    else hue = ((r - g) / d + 4) / 6;
    return [hue * 360, s * 100, l * 100];
}

/**
 * Derive a perceptually distinct but team-authentic variant of a team colour
 * for the secondary teammate. Same hue, clearly related, distinguishable on
 * a dark background.
 */
export function teammateVariant(hex: string): string {
    const [hue, sat, lit] = hexToHsl(hex);
    const isDark = lit < 45;
    const newL = isDark ? Math.min(lit + 32, 92) : Math.max(lit - 28, 12);
    const newS = Math.min(sat + (isDark ? 18 : 15), 100);
    return `hsl(${hue.toFixed(1)},${newS.toFixed(1)}%,${newL.toFixed(1)}%)`;
}

interface DriverLike {
    driver_number: number;
    team_colour?: string | null;
}

/**
 * Build a per-driver colour resolver that mirrors `MiniSectorMap`'s logic:
 * - Returns the raw team colour for everyone by default.
 * - When 2+ drivers in `focusedNums` share a team colour, secondary teammates
 *   (sorted ascending by driver_number; the lowest stays "primary") get the
 *   `teammateVariant` so the focused lines/labels are visually distinguishable.
 *
 * The variant is only applied while focus is active and contains shared-colour
 * teammates, matching the MiniSectorMap pinstripe behaviour.
 */
export function buildDriverColorResolver(
    drivers: DriverLike[],
    focusedNums: Iterable<number>,
): (num: number) => string {
    const baseColor = (num: number) => {
        const d = drivers.find((x) => x.driver_number === num);
        return `#${d?.team_colour ?? "888888"}`;
    };

    const focusArr = [...focusedNums];
    if (focusArr.length < 2) return baseColor;

    const colorToFocused = new Map<string, number[]>();
    for (const n of focusArr) {
        const c = baseColor(n).toLowerCase();
        const arr = colorToFocused.get(c) ?? [];
        arr.push(n);
        colorToFocused.set(c, arr);
    }

    const variantSet = new Set<number>();
    colorToFocused.forEach((nums) => {
        if (nums.length < 2) return;
        const sorted = [...nums].sort((a, b) => a - b);
        sorted.slice(1).forEach((n) => variantSet.add(n));
    });

    if (variantSet.size === 0) return baseColor;

    return (num) => {
        const base = baseColor(num);
        return variantSet.has(num) ? teammateVariant(base) : base;
    };
}
