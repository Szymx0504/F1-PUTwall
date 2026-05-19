<p align="center">
  <img src="frontend/public/F1_PUTwall_black.PNG" alt="F1 PUTwall Logo" width="400"/>
</p>

# F1 PUTwall

[![Frontend](https://github.com/Szymx0504/F1-PUTwall/actions/workflows/frontend.yml/badge.svg)](https://github.com/Szymx0504/F1-PUTwall/actions/workflows/frontend.yml)
[![Backend](https://github.com/Szymx0504/F1-PUTwall/actions/workflows/backend.yml/badge.svg)](https://github.com/Szymx0504/F1-PUTwall/actions/workflows/backend.yml)

Interactive F1 race data dashboard — replay races lap-by-lap, analyze driver performance, and explore season stats.

Built with React + TypeScript + Vite + TailwindCSS (frontend) and FastAPI + OpenF1 API (backend).

## Prerequisites

- **Python** 3.10+
- **Node.js** 20+

## Setup & Run

### Backend

```bash
cd backend
pip install -r requirements.txt
python main.py
```

Runs on http://localhost:8000

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Runs on http://localhost:5173 (proxies API requests to backend)

## Features

### Race Replay Page

Replay races lap-by-lap with the following visualizations:

- **Position chart** — positions of each driver throughout the race
- **Race Event Feed** — all events that occurred during the race
- **Race Map** — live map with drivers moving around the circuit
- **Gap to leader chart** — gap to the leader for each driver in seconds
- **Lap times chart** — each driver's current lap time
- **Tire strategy chart** — each driver's current tire compound
- **Weather conditions** — live weather info during the race

### Season Overview Page

Explore season-level statistics:

- **Driver and Constructor championship table** — standings after the chosen race
- **Points** — points awarded for the chosen race
- **Points throughout the season** — cumulative points up to the chosen race
- **Season results grid** — finishing position of each driver in each race

### Qualifying Page

Analyze qualifying session data:

- **Q1/Q2/Q3 results table** — full qualifying results
- **Mini sector fastest map** — fastest mini sectors across the lap
- **Speed line chart** — driver speeds across the lap
- **RPM/Gear chart** — RPM and gear selection over the lap
- **Throttle/Brake chart** — throttle and brake percentages over the lap

### Additional Features

- **Live Data** — real-time race data via WebSocket streaming

## Data Source

[OpenF1 API](https://openf1.org) — free, open-source F1 data
