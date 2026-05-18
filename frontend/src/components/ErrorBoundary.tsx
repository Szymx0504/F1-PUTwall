import { Component, type ReactNode, type ErrorInfo } from "react";

interface Props {
    children: ReactNode;
    fallback?: (error: Error, reset: () => void) => ReactNode;
    /** Optional label shown in the default fallback */
    label?: string;
}

interface State {
    error: Error | null;
}

/**
 * Catches render-time errors in a subtree so a buggy chart doesn't blank
 * out the entire page. The fallback shows the message + a Reset button.
 */
export default class ErrorBoundary extends Component<Props, State> {
    state: State = { error: null };

    static getDerivedStateFromError(error: Error): State {
        return { error };
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        // Keep this in the console for debugging
        console.error(
            `[ErrorBoundary${this.props.label ? ` ${this.props.label}` : ""}]`,
            error,
            info,
        );
    }

    reset = () => this.setState({ error: null });

    render() {
        const { error } = this.state;
        if (error) {
            if (this.props.fallback) return this.props.fallback(error, this.reset);
            return (
                <div className="rounded-lg border border-red-500/40 bg-red-500/5 p-4 text-sm">
                    <p className="font-semibold text-red-400 mb-1">
                        {this.props.label
                            ? `${this.props.label} failed to render`
                            : "Something went wrong"}
                    </p>
                    <p className="text-f1-muted text-xs mb-3 font-mono break-all">
                        {error.message}
                    </p>
                    <button
                        onClick={this.reset}
                        className="text-xs px-2 py-1 rounded bg-red-500/20 hover:bg-red-500/30 text-red-200 transition-colors"
                    >
                        Retry
                    </button>
                </div>
            );
        }
        return this.props.children;
    }
}
