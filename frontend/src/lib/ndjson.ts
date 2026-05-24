/**
 * Consume a `fetch()` response as newline-delimited JSON.
 * Calls `onMessage` once per non-empty line. Throws on non-OK responses or
 * missing streaming body. Aborts cleanly when `signal` fires.
 */
export async function consumeNdjson<T = unknown>(
    url: string,
    onMessage: (msg: T) => void,
    signal?: AbortSignal,
): Promise<void> {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!res.body) throw new Error("Streaming not supported");

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    const handleLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let parsed: T;
        try {
            parsed = JSON.parse(trimmed) as T;
        } catch {
            return;
        }
        onMessage(parsed);
    };

    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nlIdx: number;
        while ((nlIdx = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nlIdx);
            buffer = buffer.slice(nlIdx + 1);
            handleLine(line);
        }
    }
    if (buffer.length) handleLine(buffer);
}
