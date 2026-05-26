# F1 PUTwall — Dashboard Description

## Application Domain & Dataset

**Domain:** Motorsport analytics — Formula 1 race data visualization.

**Dataset:** [OpenF1 API](https://openf1.org) — a free, open-source REST API providing real-time and historical F1 telemetry data from the 2023–2025 seasons. Data includes:

- Session metadata (races, qualifying, sprints)
- Lap times and sector splits
- Car telemetry (speed, RPM, gear, throttle, brake)
- Driver positions and intervals
- Tyre stints and pit stops
- Race control messages (flags, safety car, VSC)
- Weather conditions
- Car location coordinates (x, y on track)

Data is cached in a PostgreSQL database to minimize API calls and ensure fast load times.

---

## Tasks

Users of F1 PUTwall can accomplish the following tasks:

1. **Replay a race lap-by-lap** — watch drivers move around the track in real time with current standings, gaps, and tyre info.
2. **Analyze championship standings** — explore how the Driver and Constructor championships evolved across a season.
3. **Compare qualifying performance** — examine Q1/Q2/Q3 lap times, mini-sector speeds, and telemetry overlays between drivers.
4. **Track tyre strategy** — see which compound each driver was on at any point in a race, and when they pitted.
5. **Monitor race events** — follow safety cars, flags, and pit stops as they happened during a race.
6. **Inspect weather conditions** — view temperature, humidity, and rainfall trends throughout a session.
7. **Review season results** — see a full grid of finishing positions for every driver across every race in a season.

---

## Visualization Components

### Race Replay Page

| Component           | Type                         | Interaction                            |
| ------------------- | ---------------------------- | -------------------------------------- |
| Track Map           | Animated SVG map             | Lap slider controls car positions      |
| Position Chart      | Line chart                   | Updates with current lap               |
| Gap to Leader Chart | Line chart                   | Updates with current lap               |
| Lap Times Chart     | Bar/line chart               | Updates with current lap               |
| Tyre Strategy Chart | Gantt-style chart            | Updates with current lap               |
| Race Event Feed     | Filterable table (datatable) | Lap slider filters events              |
| Weather Panel       | Composed chart               | Updates progressively with current lap |

### Season Overview Page

| Component                      | Type         | Interaction                                                   |
| ------------------------------ | ------------ | ------------------------------------------------------------- |
| Driver Championship Table      | Datatable    | Selecting a row highlights driver in Points Progression chart |
| Constructor Championship Table | Datatable    | Year/race selector filters data                               |
| Points Progression Chart       | Line chart   | Reacts to driver selection from championship table            |
| Season Results Grid            | Heatmap grid | Year/race selector filters data                               |

### Qualifying Analysis Page

| Component              | Type                 | Interaction                              |
| ---------------------- | -------------------- | ---------------------------------------- |
| Q1/Q2/Q3 Results Table | Datatable            | Selecting a driver loads their telemetry |
| Mini Sector Map        | Color-mapped SVG     | Reacts to driver selection               |
| Speed Chart            | Line chart           | Reacts to driver selection               |
| RPM/Gear Chart         | Dual-axis line chart | Reacts to driver selection               |
| Throttle/Brake Chart   | Area chart           | Reacts to driver selection               |

---

## Key Interactive Features

- **Cross-component selection:** Clicking a driver in the Qualifying results table updates all 4 telemetry charts simultaneously.
- **Lap slider:** Scrubbing the lap slider on Race Replay updates the track map, standings tower, all charts, and weather panel.
- **Year/session dropdowns:** Present on every page — switching session reloads all data for that race.
- **Live mode:** WebSocket connection streams real-time data for ongoing sessions.
- **Sprint labels:** Sprint sessions are clearly labeled in dropdowns.
- **No-data guard:** Sessions without available data are greyed out and disabled in selectors.

---

## Technical Stack

| Layer       | Technology                      |
| ----------- | ------------------------------- |
| Frontend    | React 18 + TypeScript + Vite    |
| Styling     | TailwindCSS + custom dark theme |
| Charts      | Recharts                        |
| Backend     | FastAPI (Python 3.11)           |
| Database    | PostgreSQL (asyncpg)            |
| Data source | OpenF1 REST API                 |
| Deployment  | Render.com (single service)     |
| Real-time   | WebSocket (FastAPI)             |

---

## Live Demo

🔗 [https://f1-putwall.onrender.com](https://f1-putwall.onrender.com)

## GitHub

🔗 [https://github.com/Szymx0504/F1-analyzer](https://github.com/Szymx0504/F1-analyzer)
