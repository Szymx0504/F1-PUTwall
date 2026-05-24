interface LoadingProgressBarProps {
    label: string;
    /** Number of items received so far. */
    loaded: number;
    /** Total items expected. 0 means "still discovering total" → indeterminate. */
    total: number;
}

/**
 * Determinate progress bar for streamed data loads. When `total` is 0 it
 * renders an indeterminate shimmer; otherwise the fill width reflects
 * `loaded / total` and the numeric counter updates as chunks arrive.
 */
export default function LoadingProgressBar({
    label,
    loaded,
    total,
}: LoadingProgressBarProps) {
    const indeterminate = total <= 0;
    const pct = indeterminate
        ? 0
        : Math.max(0, Math.min(100, (loaded / total) * 100));

    return (
        <div className="py-3">
            <div className="flex items-center justify-between mb-2 text-[11px] font-mono uppercase tracking-wider text-f1-muted">
                <span>{label}</span>
                {indeterminate ? (
                    <span>preparing…</span>
                ) : (
                    <span>
                        {loaded} / {total} ({Math.round(pct)}%)
                    </span>
                )}
            </div>
            <div
                className="relative h-1.5 w-full overflow-hidden rounded-full bg-f1-border/60"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={total || undefined}
                aria-valuenow={indeterminate ? undefined : loaded}
            >
                {indeterminate ? (
                    <div className="progress-indeterminate absolute inset-y-0 left-0 w-1/3 bg-red-500/80" />
                ) : (
                    <div
                        className="h-full bg-red-500 transition-[width] duration-300 ease-out"
                        style={{ width: `${pct}%` }}
                    />
                )}
            </div>
        </div>
    );
}
