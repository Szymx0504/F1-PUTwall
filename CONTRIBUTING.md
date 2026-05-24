# Contributing to F1 PUTwall

This project is proprietary software released under an All Rights Reserved license. While the repository is publicly visible for reference, **any modification, redistribution, or incorporation into other works requires prior written permission from the copyright holders**.

We do accept contributions from invited collaborators. If you are interested in contributing, please open an issue to request permission before proceeding.

## How to Contribute

### Reporting Bugs & Suggesting Features

Anyone may open an issue to report a bug or suggest a feature:

- Check the [existing issues](https://github.com/Szymx0504/F1-PUTwall/issues) first to avoid duplicates
- Provide a clear, descriptive title
- Include steps to reproduce (for bugs) or a detailed explanation (for features)
- Note your environment when relevant

### Code Contributions

**Do not open a pull request without prior written permission.** Unauthorized forks, modifications, or pull requests may be closed without review.

If you have been granted permission to contribute:

1. Create your branch from `main`
2. Make your changes in accordance with this guide
3. Ensure your code follows the project's style guidelines
4. Update documentation if needed
5. Open a pull request with a clear description of the changes

## Development Setup

### Prerequisites

- [Node.js](https://nodejs.org/) (see `frontend/package.json` for version requirements)
- [Python](https://www.python.org/) 3.11+
- [PostgreSQL](https://www.postgresql.org/)

### Frontend

```bash
cd frontend
npm install
npm run dev
```

The development server will start (typically on `http://localhost:5173`).

### Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

Create a `.env` file based on `.env.example` and configure your database credentials.

Run the backend:

```bash
uvicorn main:app --reload
```

The API will be available at `http://localhost:8000`.

## Code Style

### Frontend

- Follow the existing TypeScript/React patterns
- Use functional components and hooks
- Run the linter before committing: `npm run lint`

### Backend

- Follow [PEP 8](https://peps.python.org/pep-0008/) style guidelines
- Use type hints where appropriate
- Keep functions focused and modular

## Commit Messages

Use clear, descriptive commit messages:

- Use the present tense (e.g., "Add feature" not "Added feature")
- Use the imperative mood (e.g., "Move cursor to..." not "Moves cursor to...")
- Reference issues when applicable (e.g., "Fix #123: resolve null pointer exception")

## Questions?

If you have questions about contributing or would like to request permission to contribute, please open an issue.
