# StudyBuddy (React + FastAPI + SQLite)

## Backend
    pip install -r requirements.txt
    export ANTHROPIC_API_KEY=your_key      # Windows: set ANTHROPIC_API_KEY=your_key
    uvicorn main:app --reload              # http://localhost:8000

## Frontend, development (hot reload; proxies /api to :8000)
    cd frontend && npm install && npm run dev      # http://localhost:5173

## Frontend, production (served by FastAPI at :8000)
    cd frontend && npm install && npm run build

Data lives in studybuddy.db (SQLite). Set DB_PATH to move it, MODEL to change the model.
