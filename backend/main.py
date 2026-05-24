# main.py
"""
F1 Analyzer — FastAPI Backend
Serves OpenF1 data via REST + WebSocket for race replay.
"""

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
import asyncio
import httpx
import json
import os
from pathlib import Path

from openf1_client import (
    get_sessions,
    get_qualifying_sessions,
    get_session,
    get_drivers,
    get_laps,
    get_position,
    get_session_result,
    get_driver_championship,
    get_constructor_championship,
    get_car_data,
    get_pit_stops,
    get_stints,
    get_intervals,
    get_race_control,
    get_weather,
    get_location,
    get_latest_session,
    get_driver_by_number,
)
from ws_manager import replay_manager
from db import queries as db

app = FastAPI(title="F1 Analyzer API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(httpx.HTTPStatusError)
async def openf1_http_error(request: Request, exc: httpx.HTTPStatusError):
    status_code = 502
    detail = "OpenF1 API request failed."
    if exc.response is not None:
        body = exc.response.text
        if exc.response.status_code == 401:
            detail = "OpenF1 API returned 401 Unauthorized. Check OPENF1_API_KEY and service availability."
        else:
            detail = f"OpenF1 API returned {exc.response.status_code}."
        return JSONResponse(status_code=status_code, content={"error": detail, "body": body})
    return JSONResponse(status_code=status_code, content={"error": detail})


# ─── Health ──────────────────────────────────────────────────────────

@app.get("/api/health")
async def health():
    return {"status": "ok"}


# ─── Sessions ────────────────────────────────────────────────────────

@app.get("/api/sessions")
async def sessions(year: int | None = None, session_type: str | None = None):
    if session_type and session_type.lower() == "qualifying":
        results = await get_qualifying_sessions(year) if year else await get_sessions(session_type=session_type)
    else:
        results = await get_sessions(year, session_type)

    # Tag each session with has_data so the frontend can grey out empty ones
    if year and await db.get_pool():
        keys_with_data = await db.get_sessions_with_data(year)
        for s in results:
            s["has_data"] = s["session_key"] in keys_with_data
    else:
        for s in results:
            s["has_data"] = True

    return results


@app.get("/api/sessions/latest")
async def latest_session():
    data = await get_latest_session()
    if not data:
        return {"error": "No session found"}
    return data


@app.get("/api/sessions/{session_key}")
async def session_detail(session_key: int):
    data = await get_session(session_key)
    if not data:
        return {"error": "Session not found"}
    return data


# ─── Qualifying segments ─────────────────────────────────────────────
#
# OpenF1 often returns one combined "Qualifying" session row instead of
# separate Q1/Q2/Q3 rows.  The correct way to split Q1/Q2/Q3 is to look
# at the race_control feed for "Started" messages:
#   • 1st "Started"  → Q1 begins
#   • 2nd "Started"  → Q2 begins (Q1 ends)
#   • 3rd "Started"  → Q3 begins (Q2 ends)
#   • Q3 ends at session close (no upper bound)
#
# Returns: { "Q1": {"start": ISO, "end": ISO|null},
#            "Q2": {"start": ISO, "end": ISO|null},
#            "Q3": {"start": ISO, "end": null} }
# Missing keys mean that segment didn't occur (e.g. sprint weekends).

@app.get("/api/sessions/{session_key}/qualifying_segments")
async def qualifying_segments(session_key: int):
    import re

    rc = await get_race_control(session_key)

    # ── Strategy: match messages that explicitly reference Q1/Q2/Q3 start ──
    # OpenF1 race_control messages may contain:
    #   "Q1 GREEN", "Q2 GREEN", "Q3 GREEN"   (older format)
    #   "Q1 STARTED", "Q2 STARTED", "Q3 STARTED"
    # We look for messages where the text matches "Q<n>" combined with a start
    # indicator.  If a session restarts after a red flag we take the LAST start
    # for that segment (drivers' final laps are what matters for results).

    q_pattern = re.compile(r"\bQ([1-3])\b", re.IGNORECASE)
    start_keywords = {"started", "green"}

    # Map: "Q1"/"Q2"/"Q3" → last matching event (chronologically)
    q_starts: dict[str, dict] = {}

    # Sort all RC messages chronologically
    rc_sorted = sorted(rc, key=lambda r: r.get("date", ""))

    for msg in rc_sorted:
        text = (msg.get("message") or "").lower()
        m = q_pattern.search(text)
        if not m:
            continue
        # Check that the message also contains a start indicator
        if not any(kw in text for kw in start_keywords):
            continue
        label = f"Q{m.group(1)}"
        # Use the LAST start for each segment (handles red-flag restarts)
        q_starts[label] = msg

    if not q_starts:
        # Fallback: try any message containing "started", assigned positionally
        started = [r for r in rc_sorted if "started" in (r.get("message") or "").lower()]
        if not started:
            print(f"[qualifying_segments] No Q start events found for session {session_key}. "
                  f"RC message sample: {[r.get('message') for r in rc[:10]]}")
            return {}
        # Assign positionally only as last resort
        labels = ["Q1", "Q2", "Q3"]
        for i, ev in enumerate(started[:3]):
            q_starts[labels[i]] = ev

    # Build segment boundaries: each segment starts at its own "started" event
    # and ends at the next segment's start (or None for the last segment).
    ordered_labels = [q for q in ["Q1", "Q2", "Q3"] if q in q_starts]

    segments: dict[str, dict] = {}
    for i, label in enumerate(ordered_labels):
        start_date = q_starts[label]["date"]
        # End is the start of the NEXT segment (not the next "started" msg)
        next_label = ordered_labels[i + 1] if i + 1 < len(ordered_labels) else None
        end_date = q_starts[next_label]["date"] if next_label else None
        segments[label] = {"start": start_date, "end": end_date}

    print(
        f"[qualifying_segments] session {session_key}: {list(segments.keys())}")
    return segments


# ─── Season Results (bulk) ───────────────────────────────────────────

@app.get("/api/season/{year}/results")
async def season_results(year: int):
    # OpenF1 stores Sprint races as session_type="Race" + session_name="Sprint"
    race_sessions = []
    try:
        result = await get_sessions(year=year, session_type="Race")
        race_sessions = result or []
    except Exception as e:
        print(
            f"[season_results] Failed to fetch Race sessions for {year}: {e}")

    all_sessions = sorted(
        race_sessions,
        key=lambda s: s.get("date_start", ""),
    )
    if not all_sessions:
        return {"sessions": [], "results": {}}

    async def fetch_result(s: dict) -> tuple[int, list[dict]]:
        try:
            data = await get_session_result(s["session_key"])
            return s["session_key"], data or []
        except Exception:
            return s["session_key"], []

    CHUNK = 3
    pairs: list[tuple[int, list[dict]]] = []
    for i in range(0, len(all_sessions), CHUNK):
        chunk = all_sessions[i: i + CHUNK]
        chunk_results = await asyncio.gather(*(fetch_result(s) for s in chunk))
        pairs.extend(chunk_results)
        if i + CHUNK < len(all_sessions):
            await asyncio.sleep(0.5)

    sessions_with_results = [s for s in all_sessions
                             if any(sk == s["session_key"] for sk, data in pairs if data)]
    driver_cache: dict[int, dict] = {}

    async def fetch_drivers_for_session(s: dict) -> list[dict]:
        try:
            return await get_drivers(s["session_key"])
        except Exception:
            return []

    for i in range(0, len(sessions_with_results), CHUNK):
        chunk = sessions_with_results[i: i + CHUNK]
        driver_lists = await asyncio.gather(*(fetch_drivers_for_session(s) for s in chunk))
        for drivers_list in driver_lists:
            for d in drivers_list:
                dn = d.get("driver_number")
                if dn and dn not in driver_cache:
                    driver_cache[dn] = d
        if i + CHUNK < len(sessions_with_results):
            await asyncio.sleep(0.3)

    enriched_results: dict[str, list[dict]] = {}
    for sk, rows in pairs:
        enriched_rows = []
        for row in rows:
            dn = row.get("driver_number")
            driver = driver_cache.get(dn, {})
            enriched_rows.append({
                **row,
                "full_name": row.get("full_name") or driver.get("full_name"),
                "name_acronym": row.get("name_acronym") or driver.get("name_acronym"),
                "broadcast_name": row.get("broadcast_name") or driver.get("broadcast_name"),
                "team_name": row.get("team_name") or driver.get("team_name"),
                "team_colour": row.get("team_colour") or driver.get("team_colour"),
            })
        enriched_results[str(sk)] = enriched_rows

    return {
        "sessions": [
            {
                "session_key": s["session_key"],
                "session_name": s.get("session_name", "Race"),
                "session_type": "Sprint" if s.get("session_name", "") == "Sprint" else s.get("session_type", "Race"),
                "country_name": s.get("country_name", ""),
                "circuit_short_name": s.get("circuit_short_name", ""),
                "date_start": s.get("date_start", ""),
                "year": s.get("year", year),
            }
            for s in all_sessions
        ],
        "results": enriched_results,
    }


# ─── Season Results (streaming NDJSON) ───────────────────────────────
#
# Same payload as /api/season/{year}/results but pushed incrementally so the
# frontend can render a real progress bar. Each line is a JSON object:
#
#   {"type": "sessions", "sessions": [...], "total": N}
#   {"type": "result", "session_key": K, "data": [...]}        (×N)
#   {"type": "done"}
#
# The client should split the response body on "\n" and parse each non-empty
# line. Progress = (#"result" events received) / total.

@app.get("/api/season/{year}/results/stream")
async def season_results_stream(year: int):
    async def gen():
        race_sessions: list[dict] = []
        try:
            result = await get_sessions(year=year, session_type="Race")
            race_sessions = result or []
        except Exception as e:
            print(
                f"[season_results_stream] Failed to fetch Race sessions for {year}: {e}")

        all_sessions = sorted(
            race_sessions,
            key=lambda s: s.get("date_start", ""),
        )

        sessions_payload = [
            {
                "session_key": s["session_key"],
                "session_name": s.get("session_name", "Race"),
                "session_type": "Sprint" if s.get("session_name", "") == "Sprint" else s.get("session_type", "Race"),
                "country_name": s.get("country_name", ""),
                "circuit_short_name": s.get("circuit_short_name", ""),
                "date_start": s.get("date_start", ""),
                "year": s.get("year", year),
            }
            for s in all_sessions
        ]

        yield json.dumps({
            "type": "sessions",
            "sessions": sessions_payload,
            "total": len(all_sessions),
        }) + "\n"

        if not all_sessions:
            yield json.dumps({"type": "done"}) + "\n"
            return

        driver_cache: dict[int, dict] = {}

        async def fetch_session(s: dict):
            try:
                result_data, drivers_data = await asyncio.gather(
                    get_session_result(s["session_key"]),
                    get_drivers(s["session_key"]),
                )
                return s["session_key"], result_data or [], drivers_data or []
            except Exception:
                return s["session_key"], [], []

        CHUNK = 3
        for i in range(0, len(all_sessions), CHUNK):
            chunk = all_sessions[i: i + CHUNK]
            chunk_results = await asyncio.gather(*(fetch_session(s) for s in chunk))
            for sk, rows, drivers_list in chunk_results:
                # Update cumulative driver metadata cache
                for d in drivers_list:
                    dn = d.get("driver_number")
                    if dn and dn not in driver_cache:
                        driver_cache[dn] = d
                # Enrich result rows with driver metadata
                enriched_rows = []
                for row in rows:
                    dn = row.get("driver_number")
                    driver = driver_cache.get(dn, {})
                    enriched_rows.append({
                        **row,
                        "full_name": row.get("full_name") or driver.get("full_name"),
                        "name_acronym": row.get("name_acronym") or driver.get("name_acronym"),
                        "broadcast_name": row.get("broadcast_name") or driver.get("broadcast_name"),
                        "team_name": row.get("team_name") or driver.get("team_name"),
                        "team_colour": row.get("team_colour") or driver.get("team_colour"),
                    })
                yield json.dumps({
                    "type": "result",
                    "session_key": sk,
                    "data": enriched_rows,
                }) + "\n"
            if i + CHUNK < len(all_sessions):
                await asyncio.sleep(0.5)

        yield json.dumps({"type": "done"}) + "\n"

    return StreamingResponse(
        gen(),
        media_type="application/x-ndjson",
        headers={
            # Disable proxy/CDN buffering so chunks reach the browser as emitted
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


# ─── Drivers ─────────────────────────────────────────────────────────

@app.get("/api/sessions/{session_key}/drivers")
async def drivers(session_key: int):
    return await get_drivers(session_key)


@app.get("/api/sessions/{session_key}/result")
async def session_result(session_key: int, max_position: int | None = None):
    return await get_session_result(session_key, max_position)


# ─── Championship ────────────────────────────────────────────────────

@app.get("/api/championship/drivers")
async def driver_championship(
    session_key: int,
    driver_number: int | None = None,
):
    # Get the session to determine the year
    session_info = await get_session(session_key)
    year = session_info.get("year") if session_info else None

    standings = await get_driver_championship(session_key, driver_number)

    # Fetch drivers from ALL sessions of the year so mid-season
    # departures (e.g. De Vries, Ricciardo) still get name/team info
    if year:
        all_year_drivers = await db.get_all_drivers_for_year(year)
    else:
        all_year_drivers = await get_drivers(session_key)

    # Build lookup — later sessions overwrite earlier (most recent team info wins)
    drivers_map: dict[int, dict] = {}
    for d in all_year_drivers:
        drivers_map[d["driver_number"]] = d

    for entry in standings:
        dn = entry.get("driver_number")
        if dn in drivers_map:
            entry.setdefault("team_colour", drivers_map[dn].get("team_colour"))
            entry.setdefault("team_name", drivers_map[dn].get("team_name"))
            entry.setdefault(
                "name_acronym", drivers_map[dn].get("name_acronym"))
            entry.setdefault("full_name", drivers_map[dn].get("full_name"))
    return standings


@app.get("/api/championship/teams")
async def constructor_championship(
    session_key: int,
    team_name: str | None = None,
):
    standings, drivers_list = await asyncio.gather(
        get_constructor_championship(session_key, team_name),
        get_drivers(session_key),
    )
    team_colours = {
        d["team_name"]: d["team_colour"]
        for d in drivers_list
        if d.get("team_name") and d.get("team_colour")
    }
    for entry in standings:
        if entry.get("team_name") in team_colours:
            entry["team_colour"] = team_colours[entry["team_name"]]
    return standings


@app.get("/api/championship/drivers/by-year")
async def driver_championship_by_year(year: int, after_session_key: int | None = None):
    all_sessions = await get_sessions(year=year, session_type="Race")
    if not all_sessions:
        return []

    # Exclude Sprint races — championship standings are only updated after GPs
    gp_sessions = [s for s in all_sessions if s.get(
        "session_name", "") != "Sprint"]

    today = __import__("datetime").datetime.utcnow().isoformat()
    past = [s for s in gp_sessions if s.get("date_start", "") <= today]
    if not past:
        return []

    if after_session_key:
        target_date = next(
            (s["date_start"]
             for s in all_sessions if s["session_key"] == after_session_key),
            None,
        )
        if target_date:
            candidates = [s for s in past if s.get(
                "date_start", "") <= target_date]
            target_session = candidates[-1] if candidates else past[-1]
        else:
            target_session = past[-1]
    else:
        target_session = past[-1]

    return await driver_championship(target_session["session_key"])


@app.get("/api/championship/teams/by-year")
async def constructor_championship_by_year(year: int, after_session_key: int | None = None):
    all_sessions = await get_sessions(year=year, session_type="Race")
    if not all_sessions:
        return []

    gp_sessions = [s for s in all_sessions if s.get(
        "session_name", "") != "Sprint"]

    today = __import__("datetime").datetime.utcnow().isoformat()
    past = [s for s in gp_sessions if s.get("date_start", "") <= today]
    if not past:
        return []

    if after_session_key:
        target_date = next(
            (s["date_start"]
             for s in all_sessions if s["session_key"] == after_session_key),
            None,
        )
        if target_date:
            candidates = [s for s in past if s.get(
                "date_start", "") <= target_date]
            target_session = candidates[-1] if candidates else past[-1]
        else:
            target_session = past[-1]
    else:
        target_session = past[-1]

    return await constructor_championship(target_session["session_key"])

# ─── Laps ────────────────────────────────────────────────────────────


@app.get("/api/sessions/{session_key}/laps")
async def laps(
    session_key: int,
    driver_number: int | None = None,
    date_after: str | None = Query(
        None, description="ISO datetime — return laps with date_start >= this value"),
    date_before: str | None = Query(
        None, description="ISO datetime — return laps with date_start <= this value"),
):
    """
    Return laps for a session, optionally filtered to a Q segment window.
    date_after / date_before correspond to the start/end of a Q1|Q2|Q3
    segment as returned by /qualifying_segments.
    """
    data = await get_laps(session_key, driver_number)
    if date_after:
        data = [l for l in data if (l.get("date_start") or "") >= date_after]
    if date_before:
        data = [l for l in data if (l.get("date_start") or "") < date_before]
    return data


# ─── Position ────────────────────────────────────────────────────────

@app.get("/api/sessions/{session_key}/position")
async def position(session_key: int, driver_number: int | None = None, fresh: bool = False):
    return await get_position(session_key, driver_number, fresh)


# ─── Car Data (telemetry) ────────────────────────────────────────────

# NOTE: The batch endpoint with the literal path segment "best_laps" MUST be
# registered before the parameterised {driver_number} routes, otherwise
# FastAPI tries to parse "best_laps" as an int and returns 422.

@app.get("/api/sessions/{session_key}/car_data/best_laps")
async def car_data_best_laps_batch(
    session_key: int,
    date_after: str | None = Query(None, description="Q segment start (ISO)"),
    date_before: str | None = Query(None, description="Q segment end (ISO)"),
):
    """
    Batch-fetch best-lap telemetry for ALL drivers in a session.

    Returns { "<driver_number>": [ {car_data_point}, … ], … }

    This replaces 20 parallel /best_lap requests with a single call that:
      • Reuses the cached all-laps payload (1 OpenF1 call instead of 20).
      • Paces car_data fetches in small batches to avoid 429 rate limits.
    """
    drivers_list, all_laps = await asyncio.gather(
        get_drivers(session_key),
        get_laps(session_key),          # cached from qualifying table load
    )
    if not drivers_list or not all_laps:
        return {}

    driver_numbers = list({d["driver_number"] for d in drivers_list})

    # Only fetch telemetry for drivers that actually have valid laps in the
    # segment window — no point hitting the API for drivers not on track.
    drivers_with_laps: list[int] = []
    for dn in driver_numbers:
        dn_laps = [l for l in all_laps if l.get("driver_number") == dn]
        if date_after or date_before:
            dn_laps = [
                l for l in dn_laps
                if (not date_after or (l.get("date_start") or "") >= date_after)
                and (not date_before or (l.get("date_start") or "") < date_before)
            ]
        if any(l.get("lap_duration") and not l.get("is_pit_out_lap") for l in dn_laps):
            drivers_with_laps.append(dn)

    print(f"[best_laps_batch] session {session_key}: "
          f"{len(drivers_with_laps)}/{len(driver_numbers)} drivers have valid laps")

    result: dict[str, list[dict]] = {}
    BATCH = 3

    for i in range(0, len(drivers_with_laps), BATCH):
        batch = drivers_with_laps[i: i + BATCH]

        async def _fetch_one(dn: int) -> tuple[int, list[dict]]:
            try:
                return dn, await _best_lap_telemetry(
                    session_key, dn, date_after, date_before, all_laps
                )
            except Exception as exc:
                print(f"[best_laps_batch] driver {dn} failed: {exc}")
                return dn, []

        batch_results = await asyncio.gather(*(_fetch_one(dn) for dn in batch))
        for dn, data in batch_results:
            if data:
                result[str(dn)] = data

        # Brief pause between batches to stay below OpenF1 rate limits
        if i + BATCH < len(drivers_with_laps):
            await asyncio.sleep(0.5)

    print(f"[best_laps_batch] returning telemetry for {len(result)} drivers")
    return result


# ─── Car Data best-lap telemetry (streaming NDJSON) ──────────────────
#
# Stream variant of /car_data/best_laps used by the qualifying page to drive a
# real progress bar. Lines:
#   {"type": "init", "drivers": [dn, ...], "total": N}
#   {"type": "result", "driver_number": dn, "data": [points...]}    (×N)
#   {"type": "done"}

@app.get("/api/sessions/{session_key}/car_data/best_laps/stream")
async def car_data_best_laps_stream(
    session_key: int,
    date_after: str | None = Query(None, description="Q segment start (ISO)"),
    date_before: str | None = Query(None, description="Q segment end (ISO)"),
):
    async def gen():
        drivers_list, all_laps = await asyncio.gather(
            get_drivers(session_key),
            get_laps(session_key),
        )
        if not drivers_list or not all_laps:
            yield json.dumps({"type": "init", "drivers": [], "total": 0}) + "\n"
            yield json.dumps({"type": "done"}) + "\n"
            return

        driver_numbers = list({d["driver_number"] for d in drivers_list})

        drivers_with_laps: list[int] = []
        for dn in driver_numbers:
            dn_laps = [l for l in all_laps if l.get("driver_number") == dn]
            if date_after or date_before:
                dn_laps = [
                    l for l in dn_laps
                    if (not date_after or (l.get("date_start") or "") >= date_after)
                    and (not date_before or (l.get("date_start") or "") < date_before)
                ]
            if any(l.get("lap_duration") and not l.get("is_pit_out_lap") for l in dn_laps):
                drivers_with_laps.append(dn)

        yield json.dumps({
            "type": "init",
            "drivers": drivers_with_laps,
            "total": len(drivers_with_laps),
        }) + "\n"

        BATCH = 3
        for i in range(0, len(drivers_with_laps), BATCH):
            batch = drivers_with_laps[i: i + BATCH]

            async def _fetch_one(dn: int) -> tuple[int, list[dict]]:
                try:
                    return dn, await _best_lap_telemetry(
                        session_key, dn, date_after, date_before, all_laps
                    )
                except Exception as exc:
                    print(
                        f"[best_laps_stream] driver {dn} failed: {exc}")
                    return dn, []

            batch_results = await asyncio.gather(*(_fetch_one(dn) for dn in batch))
            for dn, data in batch_results:
                yield json.dumps({
                    "type": "result",
                    "driver_number": dn,
                    "data": data or [],
                }) + "\n"

            if i + BATCH < len(drivers_with_laps):
                await asyncio.sleep(0.5)

        yield json.dumps({"type": "done"}) + "\n"

    return StreamingResponse(
        gen(),
        media_type="application/x-ndjson",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


async def _best_lap_telemetry(
    session_key: int,
    driver_number: int,
    date_after: str | None = None,
    date_before: str | None = None,
    preloaded_laps: list[dict] | None = None,
) -> list[dict]:
    """
    Core logic shared by the single-driver and batch endpoints.

    When *preloaded_laps* is provided (batch mode) no extra /laps API call
    is made — the caller already fetched them once for the whole session.
    """
    from datetime import datetime, timedelta

    if preloaded_laps is not None:
        all_laps = [l for l in preloaded_laps if l.get(
            "driver_number") == driver_number]
    else:
        # Single-driver call — fetch all laps for session (likely cached)
        # and filter locally, instead of per-driver API call.
        session_laps = await get_laps(session_key)
        all_laps = [l for l in session_laps if l.get(
            "driver_number") == driver_number]

    if not all_laps:
        return []

    # ── Step 1: restrict to the Q segment window if provided ─────────
    candidate_laps = all_laps
    if date_after or date_before:
        seg_laps = [
            l for l in all_laps
            if (not date_after or (l.get("date_start") or "") >= date_after)
            and (not date_before or (l.get("date_start") or "") < date_before)
        ]
        if seg_laps:
            candidate_laps = seg_laps

    # ── Step 2: find fastest valid lap ───────────────────────────────
    valid_laps = [
        l for l in candidate_laps
        if l.get("lap_duration") and not l.get("is_pit_out_lap")
    ]
    if not valid_laps:
        return []

    best_lap = min(valid_laps, key=lambda l: l["lap_duration"])
    lap_num = best_lap.get("lap_number")
    t0_str = best_lap.get("date_start", "")
    if not t0_str:
        return []

    # ── Step 3: determine the end of the lap window ───────────────────
    next_lap = next(
        (l for l in all_laps if l.get("lap_number")
         == lap_num + 1 and l.get("date_start")),
        None,
    )
    if next_lap:
        t1_str = next_lap["date_start"]
    else:
        try:
            t0_dt = datetime.fromisoformat(t0_str)
            t1_dt = t0_dt + \
                timedelta(seconds=float(best_lap["lap_duration"]) + 2)
            t1_str = t1_dt.isoformat()
        except Exception:
            t1_str = ""

    # ── Step 4: fetch ONLY the narrow telemetry window ────────────────
    sliced = await get_car_data(
        session_key,
        driver_number,
        date_gte=t0_str,
        date_lte=t1_str if t1_str else None,
    )

    return sliced


@app.get("/api/sessions/{session_key}/car_data/{driver_number}/best_lap")
async def car_data_best_lap(
    session_key: int,
    driver_number: int,
    date_after: str | None = Query(None, description="Q segment start (ISO)"),
    date_before: str | None = Query(None, description="Q segment end (ISO)"),
):
    """Single-driver best-lap telemetry (kept for backwards compat)."""
    return await _best_lap_telemetry(session_key, driver_number, date_after, date_before)


@app.get("/api/sessions/{session_key}/car_data/{driver_number}")
async def car_data(session_key: int, driver_number: int):
    return await get_car_data(session_key, driver_number)


# ─── Pit Stops ───────────────────────────────────────────────────────

@app.get("/api/sessions/{session_key}/pit_stops")
async def pit_stops(session_key: int, driver_number: int | None = None):
    return await get_pit_stops(session_key, driver_number)


# ─── Stints (tires) ─────────────────────────────────────────────────

@app.get("/api/sessions/{session_key}/stints")
async def stints(session_key: int, driver_number: int | None = None):
    return await get_stints(session_key, driver_number)


# ─── Intervals (gap to leader) ──────────────────────────────────────

@app.get("/api/sessions/{session_key}/intervals")
async def intervals(session_key: int, driver_number: int | None = None):
    return await get_intervals(session_key, driver_number)


# ─── Race Control (flags, SC, VSC) ──────────────────────────────────

@app.get("/api/sessions/{session_key}/race_control")
async def race_control(session_key: int):
    return await get_race_control(session_key)


# ─── Weather ─────────────────────────────────────────────────────────

@app.get("/api/sessions/{session_key}/weather")
async def weather(session_key: int):
    return await get_weather(session_key)


# ─── Location (car positions on track) ──────────────────────────────

@app.get("/api/sessions/{session_key}/location")
async def location(session_key: int, driver_number: int | None = None):
    return await get_location(session_key, driver_number)


# ─── Track Map (streaming NDJSON) ────────────────────────────────────
#
# Same data as /track_map but split into chunks (outline + one chunk per
# driver) so the frontend can render a real progress bar instead of a
# rotating spinner. Lines:
#   {"type": "init", "total": N}                       (N = 1 + driver count)
#   {"type": "outline", "outline": [...], "_version": V}
#   {"type": "driver", "driver_number": dn, "data": [...]}  (× drivers)
#   {"type": "done"}

@app.get("/api/sessions/{session_key}/track_map/stream")
async def track_map_stream(
    session_key: int,
    refresh: bool = Query(
        False, description="Force re-compute ignoring cache"),
):
    from openf1_client import get_processed_track_map, TRACK_MAP_VERSION

    async def gen():
        # ── Source the payload (cache hit or fresh compute) ──────────
        data: dict | None = None
        if not refresh:
            try:
                cached = await db.get_track_map(session_key)
                if cached and cached.get("_version", 0) >= TRACK_MAP_VERSION:
                    data = cached
            except Exception as e:
                print(f"[track_map_stream] cache lookup failed: {e}")

        if data is None:
            try:
                data = await get_processed_track_map(session_key)
            except Exception as e:
                print(
                    f"[track_map_stream] compute failed for {session_key}: {e}")
                data = {"outline": [], "drivers": {}, "_version": TRACK_MAP_VERSION}

            # Persist freshly-computed payload (best-effort).
            try:
                await db.insert_track_map(session_key, data)
            except Exception as e:
                print(f"[track_map_stream] cache write failed: {e}")

        outline = data.get("outline") or []
        drivers = data.get("drivers") or {}
        version = data.get("_version", TRACK_MAP_VERSION)
        driver_items = list(drivers.items())

        # ── Stream chunks ────────────────────────────────────────────
        # total = 1 outline chunk + 1 per driver
        yield json.dumps({
            "type": "init",
            "total": 1 + len(driver_items),
        }) + "\n"

        yield json.dumps({
            "type": "outline",
            "outline": outline,
            "_version": version,
        }) + "\n"

        for dn, pts in driver_items:
            yield json.dumps({
                "type": "driver",
                "driver_number": int(dn) if str(dn).lstrip("-").isdigit() else dn,
                "data": pts,
            }) + "\n"
            # Yield control between chunks so the browser sees each as it lands.
            await asyncio.sleep(0)

        yield json.dumps({"type": "done"}) + "\n"

    return StreamingResponse(
        gen(),
        media_type="application/x-ndjson",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/api/sessions/{session_key}/track_map")
async def track_map(
    session_key: int,
    refresh: bool = Query(False, description="Force re-compute ignoring cache"),
):
    """Return downsampled location data for every driver."""
    from openf1_client import get_processed_track_map, TRACK_MAP_VERSION

    # Check DB cache first (skip if refresh requested)
    if not refresh:
        cached_data = await db.get_track_map(session_key)
        if cached_data:
            cached_version = cached_data.get("_version", 0)
            if cached_version >= TRACK_MAP_VERSION:
                print(f"[track_map] Cache hit (v{cached_version}) for session {session_key}")
                return cached_data
            print(f"[track_map] Cache stale (v{cached_version} < v{TRACK_MAP_VERSION}) "
                  f"for session {session_key}, regenerating...")

    print(f"[track_map] {'Refresh' if refresh else 'Computing'} for session {session_key}...")

    try:
        result_data = await get_processed_track_map(session_key)
    except Exception as e:
        print(f"[track_map] Failed to compute track map for session {session_key}: {e}")
        return {"outline": [], "drivers": {}, "_version": TRACK_MAP_VERSION}

    # Store in DB cache
    try:
        await db.insert_track_map(session_key, result_data)
        print(f"[track_map] Cached result for session {session_key}")
    except Exception as e:
        print(
            f"[track_map] Failed to cache result for session {session_key}: {e}")

    return result_data


@app.get("/api/sessions/{session_key}/race_replay_data")
async def race_replay_data(session_key: int):
    """
    Batch-fetch all race replay data in parallel.
    Avoids 6 sequential client-to-server requests.
    """
    laps, positions, stints, weather, intervals, race_control_msgs = await asyncio.gather(
        get_laps(session_key),
        get_position(session_key),
        get_stints(session_key),
        get_weather(session_key),
        get_intervals(session_key),
        get_race_control(session_key),
    )
    return {
        "type": "full_race_data",
        "laps": laps or [],
        "positions": positions or [],
        "stints": stints or [],
        "weather": weather or [],
        "intervals": intervals or [],
        "raceControl": race_control_msgs or [],
    }


# ─── Race Replay (streaming NDJSON) ──────────────────────────────────
#
# Same payload as /race_replay_data but emits each chunk as soon as the
# underlying OpenF1 fetch resolves so the frontend can render a real progress
# bar. Lines:
#   {"type": "init", "parts": ["laps", ...], "total": 6}
#   {"type": "part", "name": "laps", "data": [...]}                   (×6)
#   {"type": "done"}

@app.get("/api/sessions/{session_key}/race_replay_data/stream")
async def race_replay_data_stream(session_key: int):
    PARTS = [
        ("laps", get_laps),
        ("positions", get_position),
        ("stints", get_stints),
        ("weather", get_weather),
        ("intervals", get_intervals),
        ("raceControl", get_race_control),
    ]

    async def gen():
        yield json.dumps({
            "type": "init",
            "parts": [name for name, _ in PARTS],
            "total": len(PARTS),
        }) + "\n"

        async def fetch_part(name: str, fn) -> tuple[str, list]:
            try:
                data = await fn(session_key)
                return name, (data or [])
            except Exception as exc:
                print(f"[race_replay_stream] {name} failed: {exc}")
                return name, []

        # Kick off all fetches concurrently, emit each as it resolves.
        tasks = [asyncio.create_task(fetch_part(name, fn))
                 for name, fn in PARTS]
        for coro in asyncio.as_completed(tasks):
            name, data = await coro
            yield json.dumps({
                "type": "part",
                "name": name,
                "data": data,
            }) + "\n"

        yield json.dumps({"type": "done"}) + "\n"

    return StreamingResponse(
        gen(),
        media_type="application/x-ndjson",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


# ─── WebSocket: Race Replay ─────────────────────────────────────────

@app.websocket("/ws/replay/{session_key}")
async def ws_replay(websocket: WebSocket, session_key: int):
    await replay_manager.connect(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)
            cmd = msg.get("command")

            if cmd == "start":
                speed = msg.get("speed", 1.0)
                await replay_manager.start_replay(websocket, session_key, speed)
            elif cmd == "load_full":
                await replay_manager.send_full_race_data(websocket, session_key)
            elif cmd == "ping":
                await websocket.send_json({"type": "pong"})

    except WebSocketDisconnect:
        replay_manager.disconnect(websocket)
    except Exception as e:
        print(f"[ws_replay] Unexpected error: {e}")
        replay_manager.disconnect(websocket)


# ─── Serve frontend static build (production) ────────────────────────
FRONTEND_DIR = Path(__file__).parent / ".." / "frontend" / "dist"
if FRONTEND_DIR.exists():
    # Serve static assets (JS, CSS, images)
    app.mount(
        "/assets", StaticFiles(directory=str(FRONTEND_DIR / "assets")), name="assets")

    # SPA fallback: any non-API route returns index.html
    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        file_path = FRONTEND_DIR / full_path
        if file_path.exists() and file_path.is_file():
            return FileResponse(str(file_path))
        return FileResponse(str(FRONTEND_DIR / "index.html"))


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
