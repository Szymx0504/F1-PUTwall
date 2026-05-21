import { useState, useEffect, useRef } from "react";
import { NavLink, useSearchParams } from "react-router-dom";

interface YTPlayer {
    destroy: () => void;
}

declare global {
    interface Window {
        YT: {
            Player: new (
                container: HTMLDivElement,
                options: {
                    videoId: string;
                    playerVars?: Record<string, number>;
                    events?: {
                        onStateChange?: (event: { data: number }) => void;
                    };
                },
            ) => YTPlayer;
            PlayerState: { ENDED: number };
        };
        onYouTubeIframeAPIReady: () => void;
    }
}

const links = [
    { to: "/", label: "Race Replay" },
    { to: "/season", label: "Season Overview" },
    { to: "/qualifying", label: "Qualifying" },
    { to: "/about", label: "About" },
];

export default function Navbar() {
    const [searchParams] = useSearchParams();
    const [showVideo, setShowVideo] = useState(false);
    const [ytReady, setYtReady] = useState(false);
    const playerRef = useRef<YTPlayer | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    const carryParams = (basePath: string) => {
        const carried = new URLSearchParams();
        const year = searchParams.get("year");
        const session = searchParams.get("session");
        const circuit = searchParams.get("circuit");
        if (year) carried.set("year", year);
        if (session) carried.set("session", session);
        if (circuit) carried.set("circuit", circuit);
        const qs = carried.toString();
        return qs ? `${basePath}?${qs}` : basePath;
    };

    // Load the YT IFrame API script once on mount
    useEffect(() => {
        if (window.YT?.Player) {
            setYtReady(true);
            return;
        }
        window.onYouTubeIframeAPIReady = () => setYtReady(true);
        if (!document.getElementById("yt-api-script")) {
            const script = document.createElement("script");
            script.id = "yt-api-script";
            script.src = "https://www.youtube.com/iframe_api";
            document.body.appendChild(script);
        }
    }, []);

    // Once the modal is visible AND the API is ready, init the player
    useEffect(() => {
        if (!showVideo || !ytReady || !containerRef.current) return;

        playerRef.current = new window.YT.Player(containerRef.current, {
            videoId: "ZtiQk-vqmBA",
            playerVars: { autoplay: 1, controls: 1, rel: 0 },
            events: {
                onStateChange: (event: { data: number }) => {
                    if (event.data === 0) {
                        handleClose();
                    }
                },
            },
        });

        return () => {
            playerRef.current?.destroy();
            playerRef.current = null;
        };
    }, [showVideo, ytReady]);

    const handleClose = () => {
        playerRef.current?.destroy();
        playerRef.current = null;
        setShowVideo(false);
    };

    // ESC key to close
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") handleClose();
        };
        if (showVideo) window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [showVideo]);

    return (
        <>
            <nav className="navbar-f1 border-b border-f1-border px-6 py-4 flex items-center gap-10">
                <button
                    onClick={() => setShowVideo(true)}
                    className="navbar-brand flex items-center gap-3 bg-transparent border-none cursor-pointer p-0"
                >
                    <img
                        src="/images/F1_PUTwall.PNG"
                        alt="Formula 1 logo"
                        className="h-10 w-auto object-contain"
                    />
                </button>

                <div className="flex items-center gap-4">
                    {links.map(({ to, label }) => (
                        <NavLink
                            key={to}
                            to={carryParams(to)}
                            className={({ isActive }) =>
                                `navbar-link ${isActive ? "active" : "inactive"}`
                            }
                        >
                            {label}
                        </NavLink>
                    ))}
                </div>

                <div className="navbar-end ml-auto flex items-center gap-4 border-l border-f1-border pl-6">
                    <a href="https://put.poznan.pl/" target="_blank">
                        <img
                            src="/images/PP_logo.png"
                            alt="PP logo"
                            className="h-10 w-auto object-contain"
                        />
                    </a>
                </div>
            </nav>

            {showVideo && (
                <div
                    className="fixed inset-0 z-50 bg-black flex items-center justify-center"
                    onClick={handleClose}
                >
                    <div
                        className="relative w-[90vw] h-[90vh]"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <button
                            className="absolute -top-6 right-0 text-white text-2xl font-bold hover:text-gray-300 transition-colors"
                            onClick={handleClose}
                        >
                            ✕ ESC
                        </button>
                        <div ref={containerRef} className="w-full h-full" />
                    </div>
                </div>
            )}
        </>
    );
}
